import * as path from "path";
import { performance } from "perf_hooks";
import { saveConfig, AppConfig } from "../config";
import { createAdminApi, APP_VERSION } from "../api/adminApi";
import { createClientApi } from "../api/clientApi";
import { FormationStart } from "../instances/formationStart";
import { PitComplianceTracker, PitSpeedMonitor } from "../instances/pitSpeeding";
import { PenaltyEngine, Penalty } from "../penalty/penaltyEngine";
import { PresenceWatchdog } from "../presence/presenceWatchdog";
import { SpeedViolation, SpeedWatcher } from "../state/speedWatcher";
import { StateTracker } from "../state/stateTracker";
import { AcUdpClient } from "../udp/client";
import { BackendAnnouncer } from "../udp/announcer";
import { CarInfo, CarUpdate, ClientEvent, ConnectionClosed, ErrorMessage, LapCompleted, NewConnection, SessionInfo } from "../udp/protocol";
import { Incident, IncidentEngine } from "../incident/incidentEngine";
import { ObservedFact, WrongWayWatcher } from "../incident/raceWatchers";
import { ConnectivityManager, buildSendAddress } from "../net/connectivity";
import { findFreePort } from "../net/ports";
import { SessionPhaseTracker } from "../session/phase";
import { SessionTracker, labelForSessionType } from "../session/sessionInfo";
import { Journal, RawCapture, pruneOldLogs } from "../log/journal";
import { restoreState } from "../log/restore";
import { LightEventTracker } from "../instances/lightEventTracker";
import { PilotMessageBoard } from "../instances/pilotMessages";
import { TrackLearner } from "../track/trackLearner";
import { PitZoneLearner } from "../track/pitZoneLearner";
import { TrackLimitsIncident, TrackLimitsTracker } from "../track/trackLimits";
import { DriverTelemetryStore } from "../telemetry/driverTelemetry";
import { PilotTokenIssuer } from "../security/pilotToken";
import { EmbedTokenIssuer } from "../security/embedToken";
import { LeagueEventsStore } from "../history/leagueEvents";
import { buildReport } from "../report/raceReport";

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
  telemetryStore: DriverTelemetryStore;
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
  ports: { adminPort: number; clientPort: number };
  /**
   * Suelta todo lo que quedó corriendo: timers, socket UDP y archivos abiertos.
   *
   * No existía mientras el backend era uno solo por proceso y el proceso moría con él. Con el
   * portal hay un worker por liga que se puede parar y volver a arrancar en caliente, y sin esto
   * cada ciclo dejaría cuatro intervalos vivos, un socket bindeado (EADDRINUSE al reintentar) y
   * el trazado del circuito aprendido en esa carrera sin escribir a disco.
   */
  stop(): void;
}

export interface RaceControlOptions {
  config: AppConfig;
  /** Carpeta de datos de ESTA instancia: `logs/` y `tracks/` cuelgan de acá. */
  dataDir: string;
  /**
   * Puertos HTTP de esta liga, asignados por el supervisor.
   *
   * No se negocian ni se corren solos: si un worker se mudara de puerto por su cuenta, el portal
   * quedaría haciendo proxy a un puerto donde ya no hay nadie. Los tests son los únicos que lo
   * omiten, y ahí se busca el primero libre.
   */
  ports?: { adminPort: number; clientPort: number };
  /** Interfaz a la que se bindea el socket UDP. Ver `AcUdpConfig["bindAddress"]`. */
  udpBindAddress?: string;
  /**
   * Qué dirección se le anuncia por chat a la app del piloto. Devuelve `null` mientras no se
   * sepa. El cliente le antepone `http://` y le pega `/api/client/...`, así que lo que va acá es
   * un `host/prefijo`: todas las ligas comparten el puerto 80 y se distinguen por la ruta
   * `/l/<slug>`.
   *
   * Es un dato distinto del "Send Address" que se pega en el hosting: ese apunta al puerto UDP
   * y tiene que ser una IP, porque lo consume el servidor de AC y no un navegador.
   */
  clientBase?: () => string | null;
}

/**
 * Una sanción pendiente, en el renglón más corto que se puede leer a 200 km/h.
 *
 * No se reusa el texto del chat ("PENALIDAD: <motivo largo>. Tenés 3 vuelta(s)...") porque ese es
 * un aviso que pasa una vez y puede darse el lujo de explicarse. Este se queda fijo en pantalla
 * toda la carrera hasta que se cumpla, y lo único que el piloto necesita mirar ahí es QUÉ debe y
 * CUÁNTO le queda. El motivo ya lo leyó cuando llegó el aviso.
 */
function textoDeSancionPendiente(p: Penalty): string {
  const que = p.type === "SG" ? "STOP & GO" : p.type === "DT" ? "DRIVE THROUGH" : "SANCION";
  if (p.graceLapsRemaining <= 0) return que;
  const vueltas = p.graceLapsRemaining === 1 ? "1 vuelta" : `${p.graceLapsRemaining} vueltas`;
  return `${que} - te quedan ${vueltas}`;
}

/** Arma el motor de una liga (sin levantar los listeners HTTP todavía) — separado del worker para
 * poder armarlo igual desde los tests, sin forkear un proceso. */
export async function createRaceControl(options: RaceControlOptions): Promise<RaceControl> {
  const { config, dataDir } = options;
  const logDir = path.join(dataDir, "logs");

  // Retención de datos personales, antes de abrir el journal para no borrar el propio.
  const retencion = { eventsDays: 90, rawDays: 7 };
  pruneOldLogs(logDir, retencion);

  const journal = new Journal(logDir);

  // Historial de eventos para el panel del operador: vive en su propio archivo, a nivel de disco,
  // para seguir legible aunque la liga esté desactivada o el worker se haya caído.
  const leagueEvents = new LeagueEventsStore(dataDir);
  leagueEvents.recoverStaleInProgress();

  const stateTracker = new StateTracker();
  const udpClient = new AcUdpClient(config.acUdp, options.udpBindAddress);
  udpClient.on("error", (err) => {
    console.error("[race-control] Error de socket UDP:", err);
    journal.log("udp.error", { message: String(err) });
  });
  udpClient.on("sendError", (err) => journal.log("udp.sendError", { message: String(err) }));
  // El host del servidor de AC se descubre del primer paquete que llega (ver adoptRemoteHostIfNeeded).
  // Se persiste para que el próximo arranque ya salga configurado, sin esperar al primer datagrama.
  const persistDetectedTarget = (event: string, info: Record<string, unknown>) => {
    journal.log(event, info);
    try {
      saveConfig(config);
    } catch (err) {
      journal.log("udp.remoteTargetPersistError", { message: String(err) });
    }
  };
  udpClient.on("remoteHostDetected", (info: Record<string, unknown>) => {
    console.log(`[race-control] Servidor de AC detectado en ${info.detected} — comandos salientes redirigidos.`);
    persistDetectedTarget("udp.remoteHostDetected", info);
  });
  // El puerto de comandos también se descubre solo (ver adoptRemotePortIfNeeded). Es el número
  // que el admin tendría que ir a buscar al panel de su hosting, y el que arruina la carrera en
  // silencio si se equivoca.
  udpClient.on("remotePortDetected", (info: Record<string, unknown>) => {
    console.log(`[race-control] El servidor de AC escucha órdenes en el puerto ${info.detected} — ya apuntamos ahí.`);
    persistDetectedTarget("udp.remotePortDetected", info);
  });
  udpClient.on("remotePortUnstable", (info: Record<string, unknown>) => {
    console.warn(
      `[race-control] El servidor nos habló desde ${info.adopted} y también desde ${info.alsoSeen}: ` +
        'no se puede deducir a qué puerto mandarle las órdenes. El hosting tiene que declarar un "Listen Address" fijo.'
    );
    journal.log("udp.remotePortUnstable", info);
  });

  const rawCapture = new RawCapture(logDir, () => performance.now());
  udpClient.on("rawPacket", (buf: Buffer) => rawCapture.record(buf));

  // Los puertos vienen asignados por el supervisor y son fijos. La rama que busca uno libre existe
  // solo para los tests, que arman un motor suelto sin portal alrededor.
  const activePorts = options.ports
    ? { ...options.ports }
    : await (async () => {
        const adminPort = await findFreePort(config.http.adminPort, "127.0.0.1");
        return { adminPort, clientPort: await findFreePort(config.http.clientPort, "0.0.0.0", [adminPort]) };
      })();

  const connectivity = new ConnectivityManager(udpClient, () => config.http.publicHost);
  // Si no se pudo averiguar la dirección propia, NO se anuncia loopback: un piloto que recibe
  // `127.0.0.1` intenta conectarse a su propia PC y falla en silencio, que es exactamente lo que
  // hacía antes. Sin dirección no se anuncia nada, y el panel dice por qué.
  // La clave de esta liga. Se crea sola en el primer arranque y no sale nunca del servidor: lo
  // que viaja es un token firmado con ella, por piloto y con vencimiento.
  const pilotTokens = new PilotTokenIssuer(dataDir);
  const embedTokens = new EmbedTokenIssuer(dataDir);

  const announcer = new BackendAnnouncer(
    udpClient,
    options.clientBase ??
      (() => {
        const host = connectivity.getStatus().publicIp;
        return host ? `${host}:${activePorts.clientPort}` : null;
      }),
    (driverGuid) => pilotTokens.issue(driverGuid)
  );

  // Telemetría fina (sectores, compuesto, combustible, paradas) que reporta la app del piloto:
  // nada de esto viaja por el UDP de AC, solo existe en la Shared Memory del juego.
  const telemetryStore = new DriverTelemetryStore();

  // El tipo de sesión decide cómo se ordena la torre de tiempos: por progreso en carrera, por
  // mejor vuelta en práctica/clasificación. Arranca en carrera porque es el caso de uso del
  // producto — si el servidor manda NEW_SESSION, el valor real lo pisa enseguida.
  let sessionType = 3;

  // El trazado del circuito se aprende de las propias posiciones de los autos — ver trackLearner.
  const trackLearner = new TrackLearner(path.join(dataDir, "tracks"));
  const pitZoneLearner = new PitZoneLearner(path.join(dataDir, "tracks"));
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
    // El único mensaje que un piloto veía al entrar era el técnico de autodescubrimiento
    // (`RACECONTROL_BACKEND:dirección|token`, por chat porque es el único canal que AC ofrece para
    // hablarle a un auto y no a toda la parrilla) — ese NO se puede tocar ni ocultar: el cliente
    // Python lo necesita tal cual para autoconfigurarse, y a veces se repite porque reintenta hasta
    // el primer latido. Esto suma, aparte, un saludo corto y legible para cualquiera que entre,
    // tenga la app o no.
    udpClient.sendChatToCar(data.carId, "Race Control ENCENDIDO");
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
  udpClient.on("SESSION_INFO", (data: SessionInfo) => {
    sessionTracker.onSessionInfo(data);
    // El circuito también se toma de acá, y no solo del `NEW_SESSION` de más abajo.
    //
    // `NEW_SESSION` llega cuando la sesión ARRANCA. El caso normal del producto es el contrario:
    // el admin conecta Race Control a un servidor que ya viene corriendo hace rato. Ahí ese evento
    // no llega nunca, y hasta la 1.0 eso dejaba al `trackLearner` sin circuito para siempre —con
    // dos efectos que parecían bugs distintos y eran el mismo—: el catálogo no se cargaba, así que
    // el mapa salía vacío; y `onCarUpdate` arranca con `if (!this.track) return`, así que tampoco
    // se aprendía nada de la telemetría. El panel quedaba sin trazado y sin autos, sin un error.
    //
    // `SESSION_INFO` es la respuesta a nuestro `GET_SESSION_INFO`, que el latido de
    // `ConnectivityManager` manda cada 5 segundos, y trae los mismos campos. Así el mapa aparece a
    // los 5 segundos de conectar, venga o no un `NEW_SESSION`. `setTrack` compara la clave y sale
    // enseguida si no cambió, así que llamarlo doce veces por minuto no cuesta nada.
    trackLearner.setTrack(data.track, data.trackConfig);
  });
  // Acá vivía un `setInterval` propio que pedía `SESSION_INFO` cada 30 segundos, porque el
  // servidor no reenvía las condiciones solo y el tiempo corrido se desfasa si no se pregunta.
  // Eso ahora lo hace el latido de `ConnectivityManager`, cada 5 segundos y en el mismo tick que
  // el `setRealtimePosInterval`. Son el mismo pedido con dos motivos distintos —refrescar el
  // reloj de la sesión y probar que el servidor sigue ahí— y tenerlo dos veces a dos cadencias
  // distintas era la clase de duplicación que termina en que alguien cambia una sola.
  /**
   * Fin de sesión: la bandera a cuadros.
   *
   * `END_SESSION` llega cuando el servidor cierra la sesión y escribe el archivo de resultados.
   * Hasta la 1.1 se parseaba y se tiraba, así que la fase `finished` —que existe en el tipo desde
   * siempre— no la alcanzaba nadie nunca. Eso dejaba al panel sin forma de distinguir una carrera
   * terminada de una en curso, que es justo cuando el admin necesita la tabla de posiciones
   * finales.
   *
   * Solo cierra la carrera: el fin de una práctica no es una bandera a cuadros, y poner en
   * `finished` una fase que nunca fue `race` ofrecería un informe de una carrera que no se corrió.
   */
  udpClient.on("END_SESSION", () => {
    // El historial se cierra pase lo que pase con la fase: una práctica o una clasificación
    // también son una entrada del historial, aunque nunca lleguen a `finished` (eso es solo de la
    // carrera, ver el comentario de abajo).
    cerrarEventoActual();
    if (phaseTracker.get() !== "race") return;
    journal.log("ac.endSession", {});
    phaseTracker.set("finished");
  });

  udpClient.on("NEW_SESSION", (data: SessionInfo) => {
    journal.log("ac.newSession", { track: data.track, sessionType: data.sessionType, name: data.name });
    // Una sesión nueva después de una carrera terminada devuelve el panel al principio.
    if (phaseTracker.get() === "finished") phaseTracker.set("idle");
    // El semáforo también tiene que apagarse con la sesión. Hasta la 1.5 esto no pasaba: después de
    // dar verde y terminar la carrera, `formationStart` seguía en "green" en la práctica siguiente,
    // y el panel mostraba "Carrera en curso" y la bandera ondeando sin que hubiera ninguna. Se
    // resetea siempre, no solo si venía de `finished`: tampoco tiene sentido arrastrar una formación
    // armada de una sesión a otra si el `END_SESSION` nunca llegó (no todos los hostings lo mandan).
    formationStart.reset();
    sessionTracker.onSessionInfo(data);
    udpClient.setRealtimePosInterval(200);
    sessionType = data.sessionType;
    // Si el `END_SESSION` de la sesión anterior nunca llegó (pasa: no todos los hostings lo mandan
    // para practica/clasificación), se la cierra acá, ANTES de los resets de abajo — que es lo
    // último que todavía tiene las sanciones y los incidentes de esa sesión a mano.
    cerrarEventoActual();
    leagueEvents.startSession({
      track: data.track,
      trackConfig: data.trackConfig,
      sessionType: data.sessionType,
      sessionTypeLabel: labelForSessionType(data.sessionType),
      sessionName: data.name,
    });
    incidentEngine.resetSessionState();
    // Las sanciones tampoco se arrastran entre sesiones: un DT pendiente de la clasificación
    // escalaba a DQ en la carrera, por vueltas de gracia que el piloto nunca supo que corrían.
    formationPenaltyEngine.resetSession();
    pitPenaltyEngine.resetSession();
    stewardPenaltyEngine.resetSession();
    // Las salidas de pista de la clasificación no se arrastran a la carrera.
    trackLimits.resetSession();
    // Ni los avisos: que la app del piloto siga mostrando una sanción de la qualy en la vuelta 1
    // de la carrera es peor que no mostrar nada.
    messageBoard.resetSession();
    wrongWay.reset();
    // Los tiempos de la sesión anterior no valen en la nueva: sin esto, la mejor vuelta de la
    // clasificación quedaría liderando la torre durante toda la carrera.
    stateTracker.onNewSession();
    // La variante va aparte del nombre de pista y hay que pasarla: Spa con chicane y sin chicane
    // son la misma carpeta y dos dibujos distintos.
    trackLearner.setTrack(data.track, data.trackConfig);
  });

  const phaseTracker = new SessionPhaseTracker();
  phaseTracker.on("phaseChanged", (phase) => journal.log("phase.changed", { phase }));

  // Pizarra de avisos hacia la app del piloto. No reemplaza al chat del servidor —ese le llega a
  // todos, con app o sin ella— sino que le agrega lo que el chat no puede: que el aviso quede en
  // pantalla en vez de pasar volando. Ver instances/pilotMessages.ts.
  const messageBoard = new PilotMessageBoard();

  // Bandeja de incidentes: toques entre autos y choques contra el circuito. NO sanciona — el
  // servidor sabe que hubo contacto, no quién tuvo la culpa, así que esto va a revisión humana.
  // Por lo mismo no pasa por `dispatchOrSuppress`: registrar un hecho observado no es aplicar
  // una sanción, y el modo sombra no tiene por qué cegar al comisario.
  const incidentEngine = new IncidentEngine(stateTracker, config.infractions, () => phaseTracker.get(), () => sessionType);
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
  trackLimits.on("incident", (data: TrackLimitsIncident) => {
    incidentEngine.reportObserved(data);
    // Acá vivía el aviso "Vuelta N invalidada" que se le empujaba al piloto por la pizarra. Se
    // sacó en la 1.1 y no porque sobrara, sino porque llegaba tarde: esto se dispara con el
    // `LAP_COMPLETED` del servidor, o sea al cruzar meta, cuando el piloto ya manejó la vuelta
    // entera apretando sin saber que no valía. Ahora lo avisa la app en el instante del corte,
    // leyendo `LapInvalidated` del propio juego (ver `checkLapInvalidated` en
    // RaceControlClient.py). Mandar los dos dejaría el mismo aviso dos veces, el segundo a
    // destiempo.
    //
    // El incidente sí se sigue registrando acá arriba: para el comisario la unidad de juicio es
    // la vuelta cerrada, y eso no cambió.
    //
    // El desfasaje de telemetría nunca se avisó y sigue sin avisarse: es una sospecha sobre la
    // app del propio piloto y es asunto del comisario. Decírselo al sospechoso solo le avisaría
    // que lo están mirando.
  });
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
   * El exceso de velocidad también es un hecho de la bandeja, no solo una sanción.
   *
   * Hasta la 1.2 los dos monitores emitían `violation` y **no lo escuchaba nadie**: el piloto
   * recibía su Drive-Through y para el comisario no había pasado nada. El resumen de un piloto
   * podía decir "0 incidentes" con tres excesos en pit lane encima, que es exactamente el patrón
   * que se quiere ver agrupado —uno es un descuido, tres seguidos es otra conversación—.
   *
   * Se cablea acá y no adentro de los monitores a propósito: el que detecta el exceso no tiene
   * por qué saber que existe una bandeja, y meterle el `IncidentEngine` por el constructor lo
   * ataría a él solo para esto. Acá ya viven todos los cables.
   *
   * La velocidad que se guarda es la **máxima del pasaje**, que es por la que se sancionó. La
   * actual no sirve: el aviso llega después de los segundos de tolerancia, cuando el auto ya
   * viene frenando.
   */
  const reportarExceso = (kind: "pit-speeding" | "formation-speeding", contexto: string) => (data: {
    violation: SpeedViolation;
  }) => {
    const { violation } = data;
    const car = violation.car;
    incidentEngine.reportObserved({
      kind,
      carId: violation.carId,
      driverGuid: car.driverGuid,
      driverName: car.driverName || `Auto ${violation.carId}`,
      lap: car.lapCount,
      splinePosition: car.normalizedSplinePosition,
      speedKmh: violation.maxSpeedKmh,
      detail: `${contexto}: llegó a ${violation.maxSpeedKmh.toFixed(1)} km/h con el límite en ${
        kind === "pit-speeding" ? config.pit.penalty.speedThresholdKmh : config.formation.penalty.speedThresholdKmh
      } km/h`,
    });
  };
  pitSpeedMonitor.on("violation", reportarExceso("pit-speeding", "Exceso en pit lane"));
  formationStart.on("violation", reportarExceso("formation-speeding", "Exceso en la vuelta de formación"));

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

  /**
   * Cierra la entrada del historial en curso, con el mismo informe que arma la descarga de
   * posiciones finales (`GET /api/report`) — así el detalle que ve el operador no inventa un
   * segundo formato para las mismas sanciones e incidentes.
   *
   * Los incidentes se filtran por fecha porque el `IncidentEngine` NO se resetea entre sesiones
   * (ver su comentario de `resetSessionState`): sin el filtro, la segunda sesión del día arrastraría
   * los incidentes de la primera en su propio informe.
   */
  const cerrarEventoActual = (): void => {
    const startedAt = leagueEvents.currentStartedAt();
    if (startedAt === null) return;
    const report = buildReport({
      leagueName: config.leagueName,
      version: APP_VERSION,
      cars: stateTracker.getRoster(),
      sessionType,
      session: sessionTracker.get(),
      penaltiesByEngine: [
        ["formation", formationPenaltyEngine.getAll()],
        ["pit", pitPenaltyEngine.getAll()],
        ["steward", stewardPenaltyEngine.getAll()],
      ],
      incidents: incidentEngine.getAll().filter((i) => i.createdAt >= startedAt),
      now: Date.now(),
    });
    leagueEvents.closeCurrent(report);
  };

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

  /**
   * Todo aviso al piloto sale por dos canales a la vez: el chat del servidor y la pizarra de la app.
   *
   * Los dos y no uno: el chat le llega a cualquiera, tenga la app o no, y es la garantía de que el
   * sancionado se entere; la pizarra deja el aviso fijo en pantalla en vez de que se pierda entre
   * las líneas de "fulano se conectó". Van juntos adentro de la misma acción para que el modo
   * sombra los calle a los dos — avisarle al piloto por la app lo que el chat no le dijo sería,
   * justamente, dejar de ser modo sombra.
   */
  const avisar = (carId: number, driverGuid: string, kind: "penalty" | "info", texto: string) => {
    udpClient.sendChatToCar(carId, texto);
    messageBoard.push(driverGuid, kind, texto);
  };

  /**
   * El aviso al piloto se manda siempre, con o sin modo sombra: a diferencia de `dispatchOrSuppress`,
   * que frena el EFECTO real de una sanción (el lastre, el kick), acá lo que se frena es que el
   * admin no tenga forma de probar que la detección y el mensaje funcionan sin sancionar a nadie de
   * verdad. Antes el modo sombra —que es el default de un servidor recién conectado— también se
   * comía el aviso, así que la ventana de mensajes de la app del piloto se veía vacía durante toda
   * la prueba, aunque el motor sí estuviera detectando todo.
   */
  const avisarSiempre = (accionAviso: () => void, logType: string, data: Record<string, unknown>) => {
    accionAviso();
    journal.log(config.shadowMode ? `shadow.${logType}` : logType, data);
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
      avisarSiempre(
        () => avisar(carId, p.driverGuid, "penalty", `PENALIDAD: +${p.timePenaltySeconds}s al resultado final. ${p.reason}`),
        "penalty.time",
        { engine: engineLabel, carId, driverGuid: p.driverGuid, reason: p.reason, seconds: p.timePenaltySeconds }
      );
    } else {
      avisarSiempre(
        () =>
          avisar(
            carId,
            p.driverGuid,
            "penalty",
            `PENALIDAD: ${p.reason}. Tenés ${p.graceLapsRemaining} vuelta(s) para cumplirla.`
          ),
        "penalty.issued",
        { engine: engineLabel, carId, driverGuid: p.driverGuid, reason: p.reason, type: p.type }
      );
    }
  };
  formationPenaltyEngine.on("penalty-issued", handlePenaltyIssued("formation"));
  pitPenaltyEngine.on("penalty-issued", handlePenaltyIssued("pit"));
  stewardPenaltyEngine.on("penalty-issued", handlePenaltyIssued("steward"));

  /**
   * Sanción anulada por el comisario.
   *
   * Avisarle al piloto no es un detalle de cortesía: la sanción le llegó por chat y es por chat
   * como se entera de todo lo que pasa en una carrera. Si la anulación no viaja por el mismo
   * canal, el piloto entra a boxes a cumplir un Drive-Through que ya no debe.
   *
   * El lastre es el único caso en que hay algo físico que deshacer, y se deshace con el mismo
   * comando que lo puso. Si no se mandara el `/ballast ... 0`, "anulada" sería mentira justo en la
   * sanción que más se nota al manejar.
   */
  const handlePenaltyRevoked = (engineLabel: string) => (p: Penalty) => {
    const carId = resolveCurrentCarId(p);
    const data = { engine: engineLabel, carId, driverGuid: p.driverGuid, reason: p.reason, from: p.revokedFrom };
    if (p.type === "BALLAST") {
      dispatchOrSuppress(() => udpClient.sendAdminCommand(`/ballast ${carId} 0`), "penalty.revoked.ballast", data);
      avisarSiempre(
        () => avisar(carId, p.driverGuid, "info", `SANCIÓN ANULADA por el comisario: te sacamos el lastre. ${p.reason}`),
        "penalty.revoked",
        data
      );
      return;
    }
    avisarSiempre(
      () => avisar(carId, p.driverGuid, "info", `SANCIÓN ANULADA por el comisario: ${p.reason}`),
      "penalty.revoked",
      data
    );
  };
  formationPenaltyEngine.on("penalty-revoked", handlePenaltyRevoked("formation"));
  pitPenaltyEngine.on("penalty-revoked", handlePenaltyRevoked("pit"));
  stewardPenaltyEngine.on("penalty-revoked", handlePenaltyRevoked("steward"));

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
    // Sin esta línea, una anulación sobrevive hasta el primer reinicio y después la sanción vuelve
    // a estar viva: `restoreState` lee la última `penalty.state` de cada id.
    engine.on("penalty-revoked", persist);
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
    // Reescribe lo recuperado en ESTE journal (el nuevo, no el que se acaba de leer). Si no se
    // hace, dos reinicios seguidos sin que cambie nada en el medio pierden el estado: el primero
    // restaura bien, pero como `restore()` no emite eventos (ver el comentario de arriba), este
    // journal queda sin ninguna línea `penalty.state`/`incident.state`, y el SEGUNDO reinicio no
    // encuentra nada que restaurar en él. Se escribe directo al journal y no con `persist`/
    // `persistIncident` (que están enganchados a los eventos del motor) a propósito: pasar por ahí
    // dispararía de nuevo el mensaje de chat al piloto por una sanción que ya le habían avisado.
    for (const [engineLabel, list] of restored.penalties) {
      for (const penalty of list) journal.log("penalty.state", { engine: engineLabel, penalty });
    }
    for (const incident of restored.incidents) journal.log("incident.state", { incident });
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
    /**
     * El aviso pasa por el mismo dispatcher que el kick, y tiene que ser así.
     *
     * En modo sombra no se echa a nadie: anunciar por chat "te desconectamos en 45 segundos" y
     * después no hacerlo es peor que no avisar nada — el piloto se va a los boxes a instalar la
     * app en medio de una sesión por una amenaza que no existía.
     */
    warnMissingApp: (carId, driverGuid, driverName, secondsLeft) =>
      dispatchOrSuppress(
        () =>
          udpClient.sendChatToCar(
            carId,
            `RACE CONTROL: no detectamos la app del piloto. Instalala y volvé a entrar, o te vamos a ` +
              `desconectar en ${secondsLeft} segundos.`
          ),
        "presence.warning",
        { carId, driverGuid, driverName, secondsLeft }
      ),
  });
  presenceWatchdog.start();

  // El trazado se guarda cada tanto y no solo al cerrar: si el proceso muere de golpe (o el admin
  // cierra la ventana), lo aprendido en esa carrera se perdería y habría que volver a aprenderlo.
  const trackFlushTimer = setInterval(() => trackLearner.flush(), 60_000);
  trackFlushTimer.unref();

  // Una liga que corre meses sin reiniciarse no pasaría nunca por la poda del arranque.
  const retentionTimer = retencion ? setInterval(() => pruneOldLogs(logDir, retencion), 24 * 60 * 60 * 1000) : null;
  retentionTimer?.unref();

  await udpClient.start();
  udpClient.setRealtimePosInterval(200);
  await connectivity.start();

  const lightEventTracker = new LightEventTracker(formationStart);

  const adminApp = createAdminApi({
    config,
    embedTokens,
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
    trackLimits,
    sessionTracker,
    telemetryStore,
    getSessionType: () => sessionType,
    getPhase: () => phaseTracker.get(),
    getPitZoneSuggestion: () => pitZoneLearner.suggestionFor(trackLearner.getTrackKey()),
    manualKick: (carId: number) => {
      const car = stateTracker.get(carId);
      journal.log("kick.manual", { carId, driverGuid: car?.driverGuid, driverName: car?.driverName });
      udpClient.kick(carId);
    },
    buildSendAddress: () => buildSendAddress(connectivity.getStatus().publicIp, config.acUdp.localPort),
    getActivePorts: () => ({ ...activePorts }),
    // Del entorno y no del mensaje de arranque: el worker hereda `process.env` del portal (ver
    // Supervisor.start), así que la misma variable sirve para los dos sin tener que propagarla a
    // mano por el IPC. En modo local no está definida y los textos se caen al genérico.
    contact: (process.env.RC_CONTACT || "").trim(),
    audit: (entry) => journal.log("audit.action", entry),
  });

  const clientApp = createClientApi({
    lightEventTracker,
    messageBoard,
    presenceWatchdog,
    telemetryStore,
    onExcursions: (guid: string, excursions: unknown) => trackLimits.report(guid, excursions),
    onHeartbeat: (guid: string) => announcer.onHeartbeatReceived(guid),
    onSurfaceGrip: (grip: number) => sessionTracker.onSurfaceGrip(grip),
    // La muestra para la calibración automática del pit lane: en qué punto de la vuelta está el
    // piloto justo cuando SU PROPIA Shared Memory dice que está en el pit lane. El carId se busca
    // recién acá y no se guarda: es el mismo motivo que `resolveCurrentCarId`, puede cambiar entre
    // un poll y el siguiente si el piloto se reconectó.
    onPitLaneSample: (guid: string) => {
      const trackKey = trackLearner.getTrackKey();
      if (!trackKey) return;
      const carId = stateTracker.findCarIdByGuid(guid);
      const car = carId === undefined ? undefined : stateTracker.get(carId);
      if (car) pitZoneLearner.observe(trackKey, car.normalizedSplinePosition);
    },
    getFormationSpeedLimitKmh: () => config.formation.penalty.speedThresholdKmh,
    verifyToken: (token) => pilotTokens.verify(token),
    /**
     * El estado permanente del piloto: su cuenta de cortes y lo que debe.
     *
     * Se calcula en cada poll en vez de guardarse. Hay un solo dato de verdad para cada cosa —el
     * contador vive en `TrackLimitsTracker`, las sanciones en sus motores— y copiarlo a un tablero
     * aparte abriría la puerta a que la app muestre un número que ya no es.
     *
     * Las sanciones se buscan por `driverGuid` y no por `carId`: el motor indexa por slot, y un
     * piloto que se reconectó después de que lo sancionaran tiene otro. Sin esto, la app le diría
     * que no debe nada justo al que más le importa saberlo.
     */
    getPilotStatus: (driverGuid: string) => {
      const progreso = trackLimits.getCutProgress(driverGuid);
      const pendiente = [formationPenaltyEngine, pitPenaltyEngine, stewardPenaltyEngine]
        .flatMap((engine) => engine.getAll())
        .find((p) => p.driverGuid === driverGuid && p.status === "servingWindow");
      return {
        cuts: progreso.count,
        cutsLimit: progreso.limit,
        penalty: pendiente ? textoDeSancionPendiente(pendiente) : null,
      };
    },
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
    telemetryStore,
    incidentEngine,
    trackLearner,
    trackLimits,
    phaseTracker,
    connectivity,
    journal,
    rawCapture,
    adminApp,
    clientApp,
    ports: { ...activePorts },
    stop() {
      clearInterval(trackFlushTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      pitSpeedMonitor.stop();
      connectivity.stop();
      presenceWatchdog.stop();
      // El flush va ANTES de cerrar: lo aprendido del circuito desde el último guardado
      // automático solo existe en memoria.
      trackLearner.flush();
      udpClient.stop();
      journal.close();
      rawCapture.close();
    },
  };
}
