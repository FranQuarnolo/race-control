import * as path from "path";
import { exec } from "child_process";
import { performance } from "perf_hooks";
import { loadConfig, saveConfig, getConfigDir, AppConfig } from "./config";
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
import { CarInfo, CarUpdate, ClientEvent, ConnectionClosed, ErrorMessage, LapCompleted, NewConnection, SessionInfo } from "./udp/protocol";
import { Incident, IncidentEngine } from "./incident/incidentEngine";
import { ObservedFact, WrongWayWatcher } from "./incident/raceWatchers";
import { ConnectivityManager, buildServerSnippet } from "./net/connectivity";
import { findFreePort } from "./net/ports";
import { SessionPhaseTracker } from "./session/phase";
import { SessionTracker } from "./session/sessionInfo";
import { Journal, RawCapture } from "./log/journal";
import { restoreState } from "./log/restore";
import { LightEventTracker } from "./instances/lightEventTracker";
import { TrackLearner } from "./track/trackLearner";
import { TrackLimitsIncident, TrackLimitsTracker } from "./track/trackLimits";
import { DriverTelemetryStore } from "./telemetry/driverTelemetry";

export interface RaceControl {
  config: AppConfig;
  stateTracker: StateTracker;
  udpClient: AcUdpClient;
  formationStart: FormationStart;
  formationPenaltyEngine: PenaltyEngine;
  pitPenaltyEngine: PenaltyEngine;
  /** Las que aplica el comisario a mano desde la bandeja de incidentes. */
  stewardPenaltyEngine: PenaltyEngine;
  presenceWatchdog: PresenceWatchdog;
  incidentEngine: IncidentEngine;
  trackLearner: TrackLearner;
  trackLimits: TrackLimitsTracker;
  phaseTracker: SessionPhaseTracker;
  connectivity: ConnectivityManager;
  journal: Journal;
  rawCapture: RawCapture;
  adminApp: ReturnType<typeof createAdminApi>;
  clientApp: ReturnType<typeof createClientApi>;
  /** Los puertos que de verdad quedaron libres. No siempre coinciden con los de la config. */
  ports: { adminPort: number; clientPort: number; portsMoved: boolean };
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
  // El host del servidor de AC se descubre del primer paquete que llega (ver adoptRemoteHostIfNeeded).
  // Se persiste para que el próximo arranque ya salga configurado, sin esperar al primer datagrama.
  udpClient.on("remoteHostDetected", (info: Record<string, unknown>) => {
    console.log(`[race-control] Servidor de AC detectado en ${info.detected} — comandos salientes redirigidos.`);
    journal.log("udp.remoteHostDetected", info);
    try {
      saveConfig(config);
    } catch (err) {
      journal.log("udp.remoteHostPersistError", { message: String(err) });
    }
  });

  const rawCapture = new RawCapture(logDir, () => performance.now());
  udpClient.on("rawPacket", (buf: Buffer) => rawCapture.record(buf));

  // Los puertos se resuelven ANTES de armar nada que dependa de ellos: si el preferido está
  // ocupado por otra aplicación, lo que antes pasaba era un EADDRINUSE impreso en una consola
  // que en el .exe se cierra sola. Ahora nos corremos al siguiente libre y el panel lo avisa.
  const adminPort = await findFreePort(config.http.adminPort, "127.0.0.1");
  const activePorts = {
    adminPort,
    clientPort: await findFreePort(config.http.clientPort, "0.0.0.0", [adminPort]),
  };
  const portsMoved = activePorts.adminPort !== config.http.adminPort || activePorts.clientPort !== config.http.clientPort;
  if (portsMoved) {
    console.log(
      `[race-control] Puertos ocupados: uso ${activePorts.adminPort} (panel) y ${activePorts.clientPort} (pilotos).`
    );
    journal.log("net.portsMoved", { configured: config.http, active: activePorts });
  }

  const connectivity = new ConnectivityManager(
    udpClient,
    { udpLocalPort: config.acUdp.localPort, tcpClientPort: activePorts.clientPort },
    () => config.http.publicHost
  );
  // Si no se pudo averiguar la dirección propia, NO se anuncia loopback: un piloto que recibe
  // `127.0.0.1` intenta conectarse a su propia PC y falla en silencio, que es exactamente lo que
  // hacía antes. Sin dirección no se anuncia nada, y el panel dice por qué.
  const announcer = new BackendAnnouncer(udpClient, () => {
    const host = connectivity.getStatus().publicIp;
    return host ? `${host}:${activePorts.clientPort}` : null;
  });

  // Telemetría fina (sectores, compuesto, combustible, paradas) que reporta la app del piloto:
  // nada de esto viaja por el UDP de AC, solo existe en la Shared Memory del juego.
  const telemetryStore = new DriverTelemetryStore();

  // El tipo de sesión decide cómo se ordena la torre de tiempos: por progreso en carrera, por
  // mejor vuelta en práctica/clasificación. Arranca en carrera porque es el caso de uso del
  // producto — si el servidor manda NEW_SESSION, el valor real lo pisa enseguida.
  let sessionType = 3;

  // El trazado del circuito se aprende de las propias posiciones de los autos — ver trackLearner.
  const trackLearner = new TrackLearner(path.join(getConfigDir(), "tracks"));
  udpClient.on("CAR_UPDATE", (data: CarUpdate) => {
    stateTracker.onCarUpdate(data);
    trackLearner.onCarUpdate(data);
    const car = stateTracker.get(data.carId);
    if (car && phaseTracker.get() === "race") wrongWay.onCarUpdate(car);
  });
  udpClient.on("NEW_CONNECTION", (data: NewConnection) => {
    stateTracker.onNewConnection(data);
    journal.log("car.connected", { carId: data.carId, driverGuid: data.driverGuid, driverName: data.driverName });
    announcer.onNewConnection(data);
  });
  // Barrido de la parrilla, una sola vez por arranque.
  //
  // Al arrancar, el backend no tiene forma de saber quién está en pista: `NEW_CONNECTION` ya pasó
  // para todos los que se conectaron antes y no se vuelve a emitir. Hasta ahora eso dejaba la
  // torre llena de autos sin nombre —y las sanciones restauradas sin a quién asociarse— cada vez
  // que Race Control se abría con la carrera ya empezada, que es justo el caso de un reinicio a
  // mitad de carrera. Se dispara con el primer paquete recibido, que es el momento en que ya
  // sabemos a qué dirección preguntarle.
  const GRID_SLOTS = 64; // máximo de slots de un servidor de AC
  let gridSwept = false;
  udpClient.on("rawPacket", () => {
    if (gridSwept) return;
    gridSwept = true;
    for (let carId = 0; carId < GRID_SLOTS; carId++) udpClient.requestCarInfo(carId);
    // Mismo motivo: las condiciones de la sesión en curso tampoco se reenvían solas.
    udpClient.requestSessionInfo();
    journal.log("grid.swept", { slots: GRID_SLOTS });
  });
  udpClient.on("CAR_INFO", (data: CarInfo) => {
    const known = stateTracker.get(data.carId);
    stateTracker.onCarInfo(data);
    if (data.isConnected && !known?.connected) {
      journal.log("car.rediscovered", { carId: data.carId, driverGuid: data.driverGuid, driverName: data.driverName });
      announcer.onNewConnection(data);
    }
  });
  udpClient.on("CONNECTION_CLOSED", (data: ConnectionClosed) => {
    stateTracker.onConnectionClosed(data);
    // La telemetría en vivo del piloto se descarta al desconectarse, pero sus salidas de pista
    // NO: se indexan por driverGuid justamente para que sobrevivan a una reconexión. Borrarlas
    // acá convertiría el Alt+F4 en una forma de limpiar el contador de límites de pista.
    telemetryStore.forget(data.driverGuid);
    journal.log("car.disconnected", { carId: data.carId, driverGuid: data.driverGuid });
    // Abandonar en plena carrera es relevante para una liga (puntos, parrilla invertida, baja
    // deportiva), y el servidor no deja ninguna otra constancia de que pasó.
    if (phaseTracker.get() === "race") {
      incidentEngine.reportObserved({
        kind: "disconnect",
        carId: data.carId,
        driverGuid: data.driverGuid,
        driverName: data.driverName || `Auto ${data.carId}`,
        lap: stateTracker.get(data.carId)?.lapCount ?? 0,
        splinePosition: stateTracker.get(data.carId)?.normalizedSplinePosition ?? 0,
        detail: "Se desconectó con la carrera en curso",
      });
    }
  });
  udpClient.on("ERROR", (data: ErrorMessage) => {
    console.error("[race-control] El servidor de AC reportó un error:", data.message);
    journal.log("ac.error", { message: data.message });
  });
  // El servidor manda NEW_SESSION al arrancar/cambiar de sesión sin que se lo pidamos — es el
  // punto en el que el ejemplo oficial de Kunos re-habilita el streaming de posiciones, así que
  // hacemos lo mismo acá (además del intento inicial en el arranque, por si ese primer intento
  // se pierde o la sesión cambia después).
  // Las condiciones de la sesión que muestra el mapa: circuito, clima, temperaturas y cuánto
  // falta. `SESSION_INFO` es la respuesta a una consulta nuestra; `NEW_SESSION` llega solo.
  const sessionTracker = new SessionTracker();
  udpClient.on("SESSION_INFO", (data: SessionInfo) => sessionTracker.onSessionInfo(data));
  // El servidor no reenvía las condiciones por su cuenta: sin preguntar cada tanto, el tiempo
  // corrido se extrapola contra el reloj local y se va desfasando durante toda la carrera.
  const sessionPoll = setInterval(() => udpClient.requestSessionInfo(), 30_000);
  sessionPoll.unref();
  udpClient.on("NEW_SESSION", (data: SessionInfo) => {
    journal.log("ac.newSession", { track: data.track, sessionType: data.sessionType, name: data.name });
    sessionTracker.onSessionInfo(data);
    udpClient.setRealtimePosInterval(200);
    sessionType = data.sessionType;
    incidentEngine.resetSessionState();
    // Las sanciones tampoco se arrastran entre sesiones: un DT pendiente de la clasificación
    // escalaba a DQ en la carrera, por vueltas de gracia que el piloto nunca supo que corrían.
    formationPenaltyEngine.resetSession();
    pitPenaltyEngine.resetSession();
    stewardPenaltyEngine.resetSession();
    // Las salidas de pista de la clasificación no se arrastran a la carrera.
    trackLimits.resetSession();
    wrongWay.reset();
    // Los tiempos de la sesión anterior no valen en la nueva: sin esto, la mejor vuelta de la
    // clasificación quedaría liderando la torre durante toda la carrera.
    stateTracker.onNewSession();
    trackLearner.setTrack(data.track);
  });

  const phaseTracker = new SessionPhaseTracker();
  phaseTracker.on("phaseChanged", (phase) => journal.log("phase.changed", { phase }));

  // Bandeja de incidentes: toques entre autos y choques contra el circuito. NO sanciona — el
  // servidor sabe que hubo contacto, no quién tuvo la culpa, así que esto va a revisión humana.
  // Por lo mismo no pasa por `dispatchOrSuppress`: registrar un hecho observado no es aplicar
  // una sanción, y el modo sombra no tiene por qué cegar al comisario.
  const incidentEngine = new IncidentEngine(stateTracker, config.infractions, () => phaseTracker.get());
  udpClient.on("CLIENT_EVENT", (data: ClientEvent) => incidentEngine.onClientEvent(data));
  // "Solo registrar": queda en el journal para el informe de la carrera, sin entrar a la bandeja
  // ni obligar al comisario a resolverlo uno por uno.
  incidentEngine.on("incident-logged", (incident: Incident) =>
    journal.log("incident.logged", {
      kind: incident.kind,
      detail: incident.detail,
      lap: incident.lap,
      parties: incident.parties.map((p) => ({ carId: p.carId, driverGuid: p.driverGuid, driverName: p.driverName })),
    })
  );
  incidentEngine.on("incident", (incident: Incident) =>
    journal.log("incident.detected", {
      id: incident.id,
      kind: incident.kind,
      geometry: incident.geometry,
      // Los incidentes que no son colisión no tienen velocidad de impacto: `Math.round(undefined)`
      // escribiría `null` en el journal como si se hubiera medido cero.
      impactSpeedKmh: incident.impactSpeedKmh === undefined ? undefined : Math.round(incident.impactSpeedKmh),
      detail: incident.detail,
      lap: incident.lap,
      phase: incident.phase,
      parties: incident.parties.map((p) => ({ carId: p.carId, driverGuid: p.driverGuid, driverName: p.driverName })),
    })
  );
  incidentEngine.on("incident-resolved", (incident: Incident) =>
    journal.log("incident.resolved", { id: incident.id, status: incident.status, resolution: incident.resolution })
  );
  // Línea de ESTADO, no de auditoría: lleva el objeto entero para poder rearmar la bandeja si el
  // backend se reinicia a mitad de carrera. Las de arriba siguen existiendo porque son las que un
  // admin lee para entender qué pasó; esta es la que lee la máquina. Ver log/restore.ts.
  const persistIncident = (incident: Incident) => journal.log("incident.state", { incident });
  incidentEngine.on("incident", persistIncident);
  incidentEngine.on("incident-resolved", persistIncident);

  // Límites de pista. La detección fina la hace la app del piloto (el UDP de AC no dice si un
  // auto tiene ruedas afuera), y el servidor la contrasta contra los cortes que él mismo cuenta.
  // Como todo lo demás de la bandeja: reporta, no sanciona.
  const trackLimits = new TrackLimitsTracker(
    stateTracker,
    config.infractions.trackLimits,
    (guid) => telemetryStore.get(guid) !== null
  );
  // El journal no se escribe acá: `incidentEngine` ya registra todo incidente que entra a la
  // bandeja, incluido el `detail`. Duplicarlo solo haría que el admin los cuente dos veces.
  trackLimits.on("incident", (data: TrackLimitsIncident) => incidentEngine.reportObserved(data));
  // Única infracción con sanción automática habilitable: contar ruedas afuera es objetivo. Reusa
  // el motor de pit porque la sanción se cumple igual, pasando por el pit lane.
  trackLimits.on("penalty", (data: { driverGuid: string; reason: string }) => {
    const carId = stateTracker.findCarIdByGuid(data.driverGuid);
    if (carId === undefined) return;
    pitPenaltyEngine.issuePenalty(carId, data.driverGuid, data.reason);
  });

  // Contramano: nadie manda un paquete avisándolo, se deduce del CAR_UPDATE que ya llega. Solo
  // se mira con la carrera largada — en práctica libre, dar media vuelta en la recta es normal.
  const wrongWay = new WrongWayWatcher(config.infractions.wrongWay);
  const reportFact = (kind: "wrong-way") => (fact: ObservedFact) =>
    incidentEngine.reportObserved({ ...fact, kind });
  wrongWay.on("fact", reportFact("wrong-way"));

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
  /**
   * Instancia 3: las sanciones que aplica el comisario a mano desde la bandeja de incidentes.
   *
   * Antes, resolver un incidente como "sancionado" solo cambiaba el estado del incidente: no
   * generaba ninguna sanción, no le avisaba al piloto y no aparecía en la tabla de sanciones
   * aplicadas. El admin apretaba "Sancionar" y no pasaba nada.
   *
   * Es un motor propio y no uno de los dos existentes porque las reglas son distintas: las vueltas
   * de gracia y el escalado de la largada o del pit lane no tienen nada que ver con la decisión de
   * un comisario, y mezclarlas haría que cambiar el umbral de pit lane moviera las sanciones
   * manuales. La copia de `config.pit.penalty` es deliberadamente una copia, no la referencia viva.
   */
  const stewardPenaltyEngine = new PenaltyEngine({
    ...config.pit.penalty,
    // Un DT que da el comisario se cumple con el mismo margen que cualquier otro, pero si no se
    // cumple no expulsa a nadie: un DQ lo decide el comisario, no un contador de vueltas.
    escalation: "TIME_PENALTY",
  });

  // Los tres motores: una sanción de largada o del comisario también se cumple pasando por el pit.
  new PitComplianceTracker(
    stateTracker,
    [formationPenaltyEngine, pitPenaltyEngine, stewardPenaltyEngine],
    config.pit.zone,
    () => config.pit.stopGoSeconds,
    () => config.pit.penalty.speedThresholdKmh
  );

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
    stewardPenaltyEngine.onLapCompleted(data.carId);
    // `cuts` es el dato autoritativo contra el que se contrasta lo que reporta la app del piloto.
    trackLimits.onLapCompleted(data.carId, data.lapTimeMs, data.cuts);
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
    } else if (p.type === "TIME") {
      // No hay nada que cumplir en pista: se le avisa al piloto y queda anotada para el informe
      // de fin de carrera, que es donde el admin la vuelca al resultado.
      dispatchOrSuppress(
        () => udpClient.sendChatToCar(carId, `PENALIDAD: +${p.timePenaltySeconds}s al resultado final. ${p.reason}`),
        "penalty.time",
        { engine: engineLabel, carId, driverGuid: p.driverGuid, reason: p.reason, seconds: p.timePenaltySeconds }
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
  stewardPenaltyEngine.on("penalty-issued", handlePenaltyIssued("steward"));

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
  stewardPenaltyEngine.on("penalty-escalated", handleEscalation("steward"));

  // Estado completo de cada sanción, cada vez que cambia. Igual que con los incidentes: es la
  // línea que permite restaurar, aparte de las de auditoría que ya se escriben arriba.
  for (const [engineLabel, engine] of [
    ["formation", formationPenaltyEngine],
    ["pit", pitPenaltyEngine],
    ["steward", stewardPenaltyEngine],
  ] as const) {
    const persist = (penalty: Penalty) => journal.log("penalty.state", { engine: engineLabel, penalty });
    engine.on("penalty-issued", persist);
    engine.on("penalty-served", persist);
    engine.on("penalty-escalated", persist);
  }

  // Lo que quedó de una carrera interrumpida. Se hace DESPUÉS de enganchar los listeners de
  // persistencia y con `restore()`, que no emite eventos: si se emitieran, cada sanción
  // restaurada volvería a mandarle el mensaje de chat al piloto y a reescribirse en el journal.
  const restored = restoreState(logDir, { excludeFile: journal.filePath });
  if (restored) {
    formationPenaltyEngine.restore(restored.penalties.get("formation") || []);
    pitPenaltyEngine.restore(restored.penalties.get("pit") || []);
    stewardPenaltyEngine.restore(restored.penalties.get("steward") || []);
    incidentEngine.restore(restored.incidents);
    const count =
      (restored.penalties.get("formation")?.length || 0) +
      (restored.penalties.get("pit")?.length || 0) +
      (restored.penalties.get("steward")?.length || 0);
    console.log(
      `[race-control] Carrera interrumpida: recuperadas ${count} sanción(es) y ${restored.incidents.length} incidente(s).`
    );
    journal.log("session.restored", {
      from: restored.sourceFile,
      interruptedAt: new Date(restored.interruptedAt).toISOString(),
      penalties: count,
      incidents: restored.incidents.length,
    });
  }

  const presenceWatchdog = new PresenceWatchdog(stateTracker, {
    getGraceMs: () => config.presence.graceSeconds * 1000,
    isEnforced: () => config.presence.enforce,
    dispatchKick: (carId, driverGuid, driverName) =>
      dispatchOrSuppress(() => udpClient.kick(carId), "presence.kick", { carId, driverGuid, driverName }),
  });
  presenceWatchdog.start();

  // El trazado se guarda cada tanto y no solo al cerrar: si el proceso muere de golpe (o el admin
  // cierra la ventana), lo aprendido en esa carrera se perdería y habría que volver a aprenderlo.
  setInterval(() => trackLearner.flush(), 60_000).unref();

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
    stewardPenaltyEngine,
    presenceWatchdog,
    connectivity,
    udpClient,
    incidentEngine,
    trackLearner,
    sessionTracker,
    telemetryStore,
    getSessionType: () => sessionType,
    getPhase: () => phaseTracker.get(),
    manualKick: (carId: number) => {
      const car = stateTracker.get(carId);
      journal.log("kick.manual", { carId, driverGuid: car?.driverGuid, driverName: car?.driverName });
      udpClient.kick(carId);
    },
    buildServerSnippet: () =>
      buildServerSnippet(connectivity.getStatus().publicIp, config.acUdp.localPort, config.acUdp.remotePort),
    getActivePorts: () => ({ ...activePorts, portsMoved }),
  });

  const clientApp = createClientApi({
    lightEventTracker,
    presenceWatchdog,
    telemetryStore,
    onExcursions: (guid: string, excursions: unknown) => trackLimits.report(guid, excursions),
    onHeartbeat: (guid: string) => announcer.onHeartbeatReceived(guid),
    onSurfaceGrip: (grip: number) => sessionTracker.onSurfaceGrip(grip),
  });

  return {
    config,
    stateTracker,
    udpClient,
    formationStart,
    formationPenaltyEngine,
    pitPenaltyEngine,
    stewardPenaltyEngine,
    presenceWatchdog,
    incidentEngine,
    trackLearner,
    trackLimits,
    phaseTracker,
    connectivity,
    journal,
    rawCapture,
    adminApp,
    clientApp,
    ports: { ...activePorts, portsMoved },
  };
}

async function main() {
  const config = loadConfig();
  const rc = await createRaceControl(config);

  // Puerto A: panel y API de administración — SIEMPRE loopback-only, nunca expuesto a internet.
  rc.adminApp.listen(rc.ports.adminPort, "127.0.0.1", () => {
    console.log(`Panel admin: http://localhost:${rc.ports.adminPort}`);
    openBrowser(`http://localhost:${rc.ports.adminPort}`);
  });

  // Puerto B: lo que reporta el cliente Python (poll/heartbeat) — este es el que se expone/forwardea.
  rc.clientApp.listen(rc.ports.clientPort, "0.0.0.0", () => {
    console.log(`Endpoints de cliente: puerto ${rc.ports.clientPort} (0.0.0.0)`);
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
    rc.trackLearner.flush();
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
    rc.trackLearner.flush();
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

