import * as path from "path";
import { exec } from "child_process";
import { performance } from "perf_hooks";
import { loadConfig, getConfigDir, AppConfig } from "./config";
import { createAdminApi } from "./api/adminApi";
import { createClientApi } from "./api/clientApi";
import { FormationStart } from "./instances/formationStart";
import { PitComplianceTracker, PitSpeedMonitor } from "./instances/pitSpeeding";
import { PenaltyEngine, Penalty } from "./penalty/penaltyEngine";
import { PresenceWatchdog } from "./presence/presenceWatchdog";
import { SpeedWatcher } from "./state/speedWatcher";
import { StateTracker } from "./state/stateTracker";
import { AcUdpClient } from "./udp/client";
import { BackendAnnouncer } from "./udp/announcer";
import { CarUpdate, ConnectionClosed, ErrorMessage, LapCompleted, NewConnection, SessionInfo } from "./udp/protocol";
import { ConnectivityManager, buildEmperorServersSnippet } from "./net/connectivity";
import { SessionPhaseTracker } from "./session/phase";
import { Journal, RawCapture } from "./log/journal";
import { LightEventTracker } from "./instances/lightEventTracker";

export interface RaceControl {
  config: AppConfig;
  stateTracker: StateTracker;
  udpClient: AcUdpClient;
  formationStart: FormationStart;
  formationPenaltyEngine: PenaltyEngine;
  pitPenaltyEngine: PenaltyEngine;
  presenceWatchdog: PresenceWatchdog;
  phaseTracker: SessionPhaseTracker;
  connectivity: ConnectivityManager;
  journal: Journal;
  rawCapture: RawCapture;
  adminApp: ReturnType<typeof createAdminApi>;
  clientApp: ReturnType<typeof createClientApi>;
}

/** Arma todo el backend (sin levantar los listeners HTTP todavía) — separado de `main()` para
 * poder reusarlo desde el empaquetado (.exe) y, a futuro, desde tests/simulación. */
export async function createRaceControl(config: AppConfig): Promise<RaceControl> {
  const logDir = path.join(getConfigDir(), "logs");
  const journal = new Journal(logDir);

  const stateTracker = new StateTracker();
  const udpClient = new AcUdpClient(config.acUdp);
  udpClient.on("error", (err) => {
    console.error("[race-control] Error de socket UDP:", err);
    journal.log("udp.error", { message: String(err) });
  });
  udpClient.on("sendError", (err) => journal.log("udp.sendError", { message: String(err) }));

  const rawCapture = new RawCapture(logDir, () => performance.now());
  udpClient.on("rawPacket", (buf: Buffer) => rawCapture.record(buf));

  const connectivity = new ConnectivityManager(udpClient, {
    udpLocalPort: config.acUdp.localPort,
    tcpClientPort: config.http.clientPort,
  });
  const announcer = new BackendAnnouncer(
    udpClient,
    () => `${connectivity.getStatus().publicIp ?? "127.0.0.1"}:${config.http.clientPort}`
  );

  udpClient.on("CAR_UPDATE", (data: CarUpdate) => stateTracker.onCarUpdate(data));
  udpClient.on("NEW_CONNECTION", (data: NewConnection) => {
    stateTracker.onNewConnection(data);
    journal.log("car.connected", { carId: data.carId, driverGuid: data.driverGuid, driverName: data.driverName });
    announcer.onNewConnection(data);
  });
  udpClient.on("CONNECTION_CLOSED", (data: ConnectionClosed) => {
    stateTracker.onConnectionClosed(data);
    journal.log("car.disconnected", { carId: data.carId, driverGuid: data.driverGuid });
  });
  udpClient.on("ERROR", (data: ErrorMessage) => {
    console.error("[race-control] El servidor de AC reportó un error:", data.message);
    journal.log("ac.error", { message: data.message });
  });
  // El servidor manda NEW_SESSION al arrancar/cambiar de sesión sin que se lo pidamos — es el
  // punto en el que el ejemplo oficial de Kunos re-habilita el streaming de posiciones, así que
  // hacemos lo mismo acá (además del intento inicial en el arranque, por si ese primer intento
  // se pierde o la sesión cambia después).
  udpClient.on("NEW_SESSION", (data: SessionInfo) => {
    journal.log("ac.newSession", { track: data.track, sessionType: data.sessionType, name: data.name });
    udpClient.setRealtimePosInterval(200);
  });

  const phaseTracker = new SessionPhaseTracker();
  phaseTracker.on("phaseChanged", (phase) => journal.log("phase.changed", { phase }));

  // Instancia 1: largada en movimiento.
  const formationPenaltyEngine = new PenaltyEngine(config.formation.penalty);
  const formationSpeedWatcher = new SpeedWatcher(stateTracker, config.formation.penalty);
  const formationStart = new FormationStart(udpClient, formationSpeedWatcher, formationPenaltyEngine);
  formationStart.on("stateChanged", (type: "idle" | "formation" | "green") => {
    if (type === "formation") phaseTracker.set("formation");
    if (type === "green") phaseTracker.set("race");
    if (type === "idle") phaseTracker.set("idle");
  });

  // Instancia 2: pit lane speeding + cumplimiento de DT/SG durante la carrera.
  const pitPenaltyEngine = new PenaltyEngine(config.pit.penalty);
  const pitSpeedMonitor = new PitSpeedMonitor(stateTracker, config.pit.zone, pitPenaltyEngine);
  new PitComplianceTracker(stateTracker, pitPenaltyEngine, config.pit.zone, () => config.pit.stopGoSeconds);

  // El monitor de pit lane solo se arma durante la carrera — no antes (formación/idle).
  phaseTracker.on("phaseChanged", (phase) => {
    if (phase === "race") pitSpeedMonitor.start();
    else pitSpeedMonitor.stop();
  });

  // ACSP_LAP_COMPLETED alimenta las vueltas de gracia de ambos motores de sanción.
  udpClient.on("LAP_COMPLETED", (data: LapCompleted) => {
    stateTracker.onLapCompleted(data);
    formationPenaltyEngine.onLapCompleted(data.carId);
    pitPenaltyEngine.onLapCompleted(data.carId);
  });

  /** Resuelve el carId vigente de una sanción por driverGuid — por si el piloto se reconectó y
   * el servidor de AC le asignó otro slot desde que se emitió la sanción. */
  const resolveCurrentCarId = (p: Penalty): number => stateTracker.findCarIdByGuid(p.driverGuid) ?? p.carId;

  const dispatchOrSuppress = (action: () => void, logType: string, data: Record<string, unknown>) => {
    if (config.shadowMode) {
      journal.log(`shadow.${logType}`, data);
      return;
    }
    journal.log(logType, data);
    action();
  };

  const handlePenaltyIssued = (engineLabel: string) => (p: Penalty) => {
    const carId = resolveCurrentCarId(p);
    if (p.type === "BALLAST") {
      dispatchOrSuppress(
        () => udpClient.sendAdminCommand(`/ballast ${carId} ${config.formation.penalty.ballastKg ?? 50}`),
        "penalty.ballast",
        { engine: engineLabel, carId, driverGuid: p.driverGuid, reason: p.reason }
      );
    } else {
      dispatchOrSuppress(
        () => udpClient.sendChatToCar(carId, `PENALIDAD: ${p.reason}. Tenés ${p.graceLapsRemaining} vuelta(s) para cumplirla.`),
        "penalty.issued",
        { engine: engineLabel, carId, driverGuid: p.driverGuid, reason: p.reason, type: p.type }
      );
    }
  };
  formationPenaltyEngine.on("penalty-issued", handlePenaltyIssued("formation"));
  pitPenaltyEngine.on("penalty-issued", handlePenaltyIssued("pit"));

  const handleEscalation = (engineLabel: string) => (p: Penalty) => {
    const carId = resolveCurrentCarId(p);
    if (p.escalatedTo === "DQ") {
      dispatchOrSuppress(() => udpClient.kick(carId), "penalty.escalated.kick", {
        engine: engineLabel,
        carId,
        driverGuid: p.driverGuid,
      });
    } else {
      // TIME_PENALTY: no hay sistema de resultados — queda registrado para que el admin lo
      // vuelque a mano en la planilla de resultados de la liga.
      journal.log("penalty.escalated.timePenalty", { engine: engineLabel, carId, driverGuid: p.driverGuid });
    }
  };
  formationPenaltyEngine.on("penalty-escalated", handleEscalation("formation"));
  pitPenaltyEngine.on("penalty-escalated", handleEscalation("pit"));

  const presenceWatchdog = new PresenceWatchdog(stateTracker, udpClient);
  presenceWatchdog.start();

  await udpClient.start();
  udpClient.setRealtimePosInterval(200);
  await connectivity.start();

  const lightEventTracker = new LightEventTracker(formationStart);

  const adminApp = createAdminApi({
    config,
    stateTracker,
    formationStart,
    formationPenaltyEngine,
    pitPenaltyEngine,
    presenceWatchdog,
    connectivity,
    buildEmperorServersSnippet: () =>
      buildEmperorServersSnippet(connectivity.getStatus().publicIp, config.acUdp.localPort, config.acUdp.remotePort),
  });

  const clientApp = createClientApi({
    lightEventTracker,
    presenceWatchdog,
    onHeartbeat: (guid: string) => announcer.onHeartbeatReceived(guid),
  });

  return {
    config,
    stateTracker,
    udpClient,
    formationStart,
    formationPenaltyEngine,
    pitPenaltyEngine,
    presenceWatchdog,
    phaseTracker,
    connectivity,
    journal,
    rawCapture,
    adminApp,
    clientApp,
  };
}

async function main() {
  const config = loadConfig();
  const rc = await createRaceControl(config);

  // Puerto A: panel y API de administración — SIEMPRE loopback-only, nunca expuesto a internet.
  rc.adminApp.listen(config.http.adminPort, "127.0.0.1", () => {
    console.log(`Panel admin: http://localhost:${config.http.adminPort}`);
    openBrowser(`http://localhost:${config.http.adminPort}`);
  });

  // Puerto B: lo que reporta el cliente Python (poll/heartbeat) — este es el que se expone/forwardea.
  rc.clientApp.listen(config.http.clientPort, "0.0.0.0", () => {
    console.log(`Endpoints de cliente: puerto ${config.http.clientPort} (0.0.0.0)`);
  });

  console.log(`UDP: escuchando en :${config.acUdp.localPort}, enviando a ${config.acUdp.remoteHost}:${config.acUdp.remotePort}`);
  if (config.shadowMode) {
    console.log("MODO SOMBRA activo: el motor detecta y registra, pero no aplica sanciones/kicks reales.");
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nCerrando race-control (${signal})...`);
    rc.connectivity.stop();
    rc.presenceWatchdog.stop();
    rc.udpClient.stop();
    rc.journal.close();
    rc.rawCapture.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Un error no controlado puede dejar el estado de sanciones a medio camino — mejor cortar y
  // que el admin lo reinicie (el journal queda como evidencia de qué pasó) que seguir corriendo
  // con un estado potencialmente corrupto.
  process.on("uncaughtException", (err) => {
    console.error("[race-control] Error no controlado, cerrando:", err);
    rc.journal.log("fatal.uncaughtException", { message: String(err), stack: err.stack });
    rc.journal.close();
    rc.rawCapture.close();
    process.exit(1);
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err: Error | null) => {
    if (err) console.error("[race-control] No se pudo abrir el navegador automáticamente:", err.message);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
