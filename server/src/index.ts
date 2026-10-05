import { loadConfig } from "./config";
import { createAdminApi } from "./api/adminApi";
import { FormationStart } from "./instances/formationStart";
import { PitComplianceTracker, PitSpeedMonitor } from "./instances/pitSpeeding";
import { PenaltyEngine } from "./penalty/penaltyEngine";
import { PresenceWatchdog } from "./presence/presenceWatchdog";
import { SpeedWatcher } from "./state/speedWatcher";
import { StateTracker } from "./state/stateTracker";
import { AcUdpClient } from "./udp/client";
import { CarUpdate, ConnectionClosed, LapCompleted, NewConnection } from "./udp/protocol";

async function main() {
  const config = loadConfig();

  const stateTracker = new StateTracker();
  const udpClient = new AcUdpClient(config.acUdp);

  udpClient.on("CAR_UPDATE", (data: CarUpdate) => stateTracker.onCarUpdate(data));
  udpClient.on("NEW_CONNECTION", (data: NewConnection) => stateTracker.onNewConnection(data));
  udpClient.on("CONNECTION_CLOSED", (data: ConnectionClosed) => stateTracker.onConnectionClosed(data));

  // Instancia 1: largada en movimiento.
  const formationPenaltyEngine = new PenaltyEngine(config.formation.penalty);
  const formationSpeedWatcher = new SpeedWatcher(stateTracker, {
    thresholdKmh: config.formation.speedThresholdKmh,
    toleranceSeconds: config.formation.toleranceSeconds,
  });
  const formationStart = new FormationStart(udpClient, formationSpeedWatcher, formationPenaltyEngine);

  // Instancia 2: pit lane speeding + cumplimiento de DT/SG durante la carrera.
  const pitPenaltyEngine = new PenaltyEngine(config.pit.penalty);
  const pitSpeedMonitor = new PitSpeedMonitor(
    stateTracker,
    config.pit.legalPitSpeedKmh,
    5,
    config.pit.zone,
    pitPenaltyEngine
  );
  new PitComplianceTracker(stateTracker, pitPenaltyEngine, config.pit.zone, config.pit.legalPitSpeedKmh, config.pit.stopGoSeconds);
  pitSpeedMonitor.start();

  // ACSP_LAP_COMPLETED alimenta las vueltas de gracia de ambos motores de sanción.
  udpClient.on("LAP_COMPLETED", (data: LapCompleted) => {
    stateTracker.onLapCompleted(data);
    formationPenaltyEngine.onLapCompleted(data.carId);
    pitPenaltyEngine.onLapCompleted(data.carId);
  });

  formationPenaltyEngine.on("penalty-issued", (p) => {
    if (p.type === "BALLAST") {
      udpClient.sendAdminCommand(`/ballast ${p.carId} ${config.formation.penalty.ballastKg ?? 50}`);
    } else {
      udpClient.sendChatToCar(p.carId, `PENALIDAD: ${p.reason}. Tenés ${p.graceLapsRemaining} vuelta(s) para cumplirla.`);
    }
  });
  pitPenaltyEngine.on("penalty-issued", (p) => {
    if (p.type === "BALLAST") {
      udpClient.sendAdminCommand(`/ballast ${p.carId} ${config.pit.penalty.ballastKg ?? 50}`);
    } else {
      udpClient.sendChatToCar(p.carId, `PENALIDAD: ${p.reason}. Tenés ${p.graceLapsRemaining} vuelta(s) para cumplirla.`);
    }
  });
  const handleEscalation = (p: { carId: number; escalatedTo?: string }) => {
    if (p.escalatedTo === "DQ") {
      udpClient.kick(p.carId);
    }
    // TIME_PENALTY: queda registrado en el panel para que el admin lo vuelque a los resultados.
  };
  formationPenaltyEngine.on("penalty-escalated", handleEscalation);
  pitPenaltyEngine.on("penalty-escalated", handleEscalation);

  const presenceWatchdog = new PresenceWatchdog(stateTracker, udpClient);
  presenceWatchdog.start();

  await udpClient.start();
  udpClient.setRealtimePosInterval(200);

  const app = createAdminApi({
    config,
    stateTracker,
    formationStart,
    formationPenaltyEngine,
    pitPenaltyEngine,
    presenceWatchdog,
  });
  app.listen(config.http.port, () => {
    console.log(`Race Control escuchando en http://localhost:${config.http.port}`);
    console.log(`UDP: escuchando en :${config.acUdp.localPort}, enviando a ${config.acUdp.remoteHost}:${config.acUdp.remotePort}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
