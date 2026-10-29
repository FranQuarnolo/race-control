import express, { Express, Response } from "express";
import * as path from "path";
import { AppConfig, applyConfigPatch, applyProfile, deleteProfile, isFirstRun, saveProfile } from "../config";
import { ACTION_LABELS, AUTO_PENALTY_ALLOWED } from "../incident/catalog";
import { FormationStart } from "../instances/formationStart";
import { PenaltyEngine, PenaltyType } from "../penalty/penaltyEngine";
import { PresenceWatchdog } from "../presence/presenceWatchdog";
import { CarState, StateTracker } from "../state/stateTracker";
import { PitZone } from "../instances/pitSpeeding";
import { PitZoneSample } from "../track/pitZoneLearner";
import { ConnectivityManager } from "../net/connectivity";
import { runDiagnostics, summarize } from "../net/diagnostics";
import { AcUdpClient } from "../udp/client";
import { Incident, IncidentEngine } from "../incident/incidentEngine";
import { SessionTracker } from "../session/sessionInfo";
import { TrackLearner } from "../track/trackLearner";
import { TrackLimitsTracker } from "../track/trackLimits";
import { DriverTelemetry, DriverTelemetryStore } from "../telemetry/driverTelemetry";
import { brandOf, brandSlug } from "../cars/carBadges";
import { computeGaps, computeStandings } from "../state/standings";
import { buildReport, reportFileName, toCsv } from "../report/raceReport";

export interface AdminApiDeps {
  config: AppConfig;
  stateTracker: StateTracker;
  formationStart: FormationStart;
  formationPenaltyEngine: PenaltyEngine;
  pitPenaltyEngine: PenaltyEngine;
  stewardPenaltyEngine: PenaltyEngine;
  presenceWatchdog: PresenceWatchdog;
  connectivity: ConnectivityManager;
  udpClient: AcUdpClient;
  incidentEngine: IncidentEngine;
  trackLearner: TrackLearner;
  trackLimits: TrackLimitsTracker;
  sessionTracker: SessionTracker;
  telemetryStore: DriverTelemetryStore;
  /** Tipo de sesión actual del servidor de AC (3 = carrera). Decide si la torre de tiempos se
   * ordena por progreso o por mejor vuelta. */
  getSessionType: () => number;
  /** Fase interna de la carrera (`idle`/`formation`/`race`/`finished`) — la bandera animada de la
   * barra superior ondea solo en `race`. */
  getPhase: () => string;
  /** La zona de pit lane que la calibración automática aprendió para el circuito actual, o `null`
   * sin ninguna muestra todavía. Ver `track/pitZoneLearner.ts`. */
  getPitZoneSuggestion: () => PitZoneSample | null;
  /** Kick manual pedido por el admin desde la tabla de pilotos. Se inyecta en vez de llamar a
   * `udpClient.kick` directo para que index.ts lo registre en el journal como manual. */
  manualKick: (carId: number) => void;
  /** El "Send Address": lo único que el admin tiene que copiar al panel de su hosting. */
  buildSendAddress: () => string;
  /** Puertos realmente en uso. Los asigna el portal al arrancar la liga; el panel los muestra
   * pero no los puede cambiar. */
  getActivePorts: () => { adminPort: number; clientPort: number };
  /** A dónde escribe el admin cuando el problema es de nuestro lado. Lo configura el despliegue en
   * `RC_CONTACT` y lo hereda el worker; vacío deja los textos en "avisale a quien te dio el acceso". */
  contact?: string;
  /** Registro de quién hizo qué. Ver el middleware de auditoría más abajo. */
  audit?: (entry: { user: string; method: string; path: string }) => void;
}

const TELEMETRY_STALE_MS = 2000;

/** Versión de producto. Las versiones son de dos números (0.3, 0.4, … 1.0); el tercero aparece
 * solo en un parche sobre una versión ya publicada. `package.json` queda siempre en semver de
 * tres partes porque npm lo exige, pero ese valor es interno: el admin ve este. Sin esto no
 * había forma de saber qué build está corriendo quien reporta un problema. */
export const APP_VERSION = "1.12";

/**
 * Si el auto está en el pit lane. Dos fuentes, en este orden:
 *
 * 1. **La app del piloto**, cuando la tiene. `inPitLane` sale de la Shared Memory del juego, así
 *    que es el dato exacto: lo sabe el juego, no lo deducimos nosotros.
 * 2. **La zona de pit configurada**, cuando no. Es el mismo rango de `normalizedSplinePosition`
 *    que ya usan `PitSpeedMonitor` y `PitComplianceTracker`, y usar el mismo criterio es a
 *    propósito: si el panel dijera PIT con una definición propia, el admin vería a alguien "en
 *    boxes" al que el motor no le mide la velocidad de pit, y calibraría la zona a ciegas.
 *
 * Por qué no se deduce de "velocidad 0 por mucho tiempo", que sería lo intuitivo: un auto
 * detenido en la grava después de un despiste también tiene velocidad 0 por mucho tiempo, y es
 * justo el caso en el que el admin necesita ver que NO está en boxes.
 */
export function estaEnPit(car: CarState, telemetry: DriverTelemetry | null, zone: PitZone): boolean {
  if (telemetry) return telemetry.inPitLane;
  // Zona inválida (fin <= inicio): no inventar. El panel ya avisa aparte que está mal definida.
  if (!(zone.splineEnd > zone.splineStart)) return false;
  return car.normalizedSplinePosition >= zone.splineStart && car.normalizedSplinePosition <= zone.splineEnd;
}

/**
 * Panel y API de administración — se levanta SIEMPRE en 127.0.0.1 (ver index.ts), nunca expuesto
 * a internet. Los endpoints que sí necesitan ser alcanzables desde afuera (cliente Python) viven
 * en clientApi.ts, en un puerto/listener separado.
 */
export function createAdminApi(deps: AdminApiDeps): Express {
  const app = express();
  app.use(express.json({ limit: "50kb" }));

  /**
   * Auditoría: toda acción que cambia algo queda registrada con quién la hizo.
   *
   * En una PC de escritorio sobraba —el único que podía apretar el botón era el dueño de la
   * máquina—. En una liga con varios comisarios, "alguien kickeó al piloto 7 en la vuelta 12" no
   * sirve para nada. El nombre lo pone el portal en `X-RC-User` (ver proxy.ts): no puede venir
   * del navegador, justamente para que nadie firme con el nombre de otro.
   */
  app.use((req, _res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      deps.audit?.({ user: String(req.headers["x-rc-user"] || "local"), method: req.method, path: req.path });
    }
    next();
  });

  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/state", (_req, res) => {
    deps.connectivity.refreshTelemetryFlag();
    const now = Date.now();
    // La torre muestra la jornada entera, no solo a los que están conectados ahora mismo; la
    // clasificación y los intervalos, en cambio, se calculan solo entre los que están en pista.
    // Un desconectado no tiene posición ni intervalo: su fila va al fondo con `--`, que es lo
    // único honesto que se puede poner ahí.
    const roster = deps.stateTracker.getRoster();
    const connected = roster.filter((c) => c.connected);
    const sessionType = deps.getSessionType();
    const standings = computeStandings(connected, sessionType);
    const gaps = computeGaps(connected, sessionType);
    res.json({
      version: APP_VERSION,
      firstRun: isFirstRun(deps.config),
      leagueName: deps.config.leagueName,
      shadowMode: deps.config.shadowMode,
      lightState: deps.formationStart.getLightState(),
      phase: deps.getPhase(),
      cars: roster.map((car) => {
        const telemetry = deps.telemetryStore.get(car.driverGuid);
        return {
          ...car,
          position: standings.get(car.carId) ?? null,
          /** Marca deducida del nombre del modelo, y el archivo de logo que le corresponde en la
           * biblioteca empaquetada. `brandLogo: null` = no hay logo para esa marca y el panel
           * dibuja el escudo con monograma, sin pedir una imagen que va a dar 404. */
          brand: brandOf(car.carModel),
          brandLogo: brandSlug(brandOf(car.carModel)),
          telemetryStale: car.lastUpdate === 0 || now - car.lastUpdate > TELEMETRY_STALE_MS,
          /** Intervalo con el de adelante y con el líder, en ms. `null` donde no hay nada que medir
           * —el líder, o nadie con una vuelta cerrada todavía— y `lapsDown > 0` cuando está doblado,
           * que es cuando los milisegundos dejan de significar algo. Ver `computeGaps`. */
          gapAheadMs: gaps.get(car.carId)?.aheadMs ?? null,
          gapLeaderMs: gaps.get(car.carId)?.leaderMs ?? null,
          lapsDown: gaps.get(car.carId)?.lapsDown ?? 0,
          /** Round-trip de la app del piloto contra el backend. `null` = no tiene la app reportando. */
          pingMs: deps.presenceWatchdog.getPing(car.driverGuid),
          /** Sectores, compuesto, combustible y paradas. `null` sin la app del piloto: el UDP de AC
           * no transporta ninguno de estos datos, solo la Shared Memory del juego los tiene. */
          telemetry,
          /** Vueltas que el servidor le invalidó por irse de pista, en esta sesión. A diferencia de
           * casi todo lo demás de esta fila, llega **siempre**: sale del `LAP_COMPLETED` del
           * servidor dedicado y no depende de que el piloto tenga la app. */
          cuts: deps.trackLimits.getCuts(car.driverGuid),
          /** Si el auto está en el pit lane. Ver `estaEnPit`. */
          inPit: estaEnPit(car, telemetry, deps.config.pit.zone),
        };
      }),
      formationPenalties: deps.formationPenaltyEngine.getAll(),
      pitPenalties: deps.pitPenaltyEngine.getAll(),
      stewardPenalties: deps.stewardPenaltyEngine.getAll(),
      incidents: deps.incidentEngine.getAll(),
      /** Contador aparte para el badge de la barra: la pantalla principal no muestra la bandeja,
       * así que sin esto un incidente nuevo pasaría desapercibido hasta entrar a /sanciones. */
      pendingIncidents: deps.incidentEngine.getPending().length,
      /** Solo el progreso, no el trazado: son ~600 puntos y esto se pide una vez por segundo. El
       * dibujo se baja aparte de /api/track, que el panel vuelve a pedir cuando esto cambia. */
      track: { coverage: deps.trackLearner.getCoverage(), catalogued: deps.trackLearner.isCatalogued() },
      /** La zona de pit configurada, para pintarla sobre el mapa.
       *
       * Viaja en `/api/state` y no se lee del formulario de Reglas porque el mapa tiene que
       * mostrarla aunque el cajón nunca se haya abierto —que es el caso normal— y porque un
       * cambio recién guardado tiene que verse en el dibujo en el poll siguiente. Son dos números:
       * no pesa nada al lado de los autos. */
      pitZone: { splineStart: deps.config.pit.zone.splineStart, splineEnd: deps.config.pit.zone.splineEnd },
      /** Lo que la calibración automática (telemetría de los pilotos con app, ver
       * `track/pitZoneLearner.ts`) aprendió para el circuito actual. `null` sin ninguna muestra
       * todavía — un circuito recién visitado, o sin nadie con la app pasando por boxes. El panel
       * la ofrece como sugerencia; no pisa la zona activa sola. */
      pitZoneSuggestion: deps.getPitZoneSuggestion(),
      /** Condiciones de la sesión en curso: circuito, clima, temperaturas, grip y cuánto falta.
       * `null` hasta que llegue el primer SESSION_INFO del servidor. */
      session: deps.sessionTracker.get(),
      network: {
        ...deps.connectivity.getStatus(),
        ...deps.getActivePorts(),
        sendAddress: deps.buildSendAddress(),
        /** A dónde salen los comandos (chat, kick, ballast). Si queda en loopback con telemetría
         * entrando, es la señal de que el servidor de AC todavía no se identificó. */
        acServer: deps.udpClient.getRemoteTarget(),
        /** Separado de `receivingTelemetry` a propósito: el servidor puede estar mandando
         * telemetría perfecta mientras ningún piloto logra alcanzar el puerto de clientes. */
        driversReporting: deps.presenceWatchdog.getReportingCount(),
      },
    });
  });

  /** Trazado aprendido del circuito. Devuelve 204 mientras no haya suficiente como para dibujar. */
  app.get("/api/track", (_req, res) => {
    const outline = deps.trackLearner.getOutline();
    if (!outline) {
      res.status(204).end();
      return;
    }
    res.json(outline);
  });

  app.get("/api/config", (_req, res) => res.json(deps.config));

  /**
   * "¿Algo anda mal?": los chequeos, cada uno con qué hacer si falló.
   *
   * Todos leen contadores vivos, así que el botón es un refresco y no una reconfiguración. La
   * dirección pública ya no se detecta acá: la fija el portal al arrancar la liga.
   */
  app.post("/api/network/test", async (_req, res) => {
    deps.connectivity.refreshTelemetryFlag();
    const ports = deps.getActivePorts();
    const presence = deps.presenceWatchdog.getReportingCount();
    const checks = runDiagnostics({
      network: deps.connectivity.getStatus(),
      udp: deps.udpClient.getStats(),
      remoteHost: deps.config.acUdp.remoteHost,
      udpLocalPort: deps.config.acUdp.localPort,
      udpRemotePort: deps.config.acUdp.remotePort,
      udpRemotePortSource: deps.config.acUdp.remotePortSource,
      udpRemotePortUnstable: deps.udpClient.hasUnstableRemotePort(),
      clientPort: ports.clientPort,
      driversConnected: presence.connected,
      driversReporting: presence.reporting,
      contact: deps.contact,
    });
    res.json({ checks, summary: summarize(checks) });
  });

  /**
   * Catálogo para armar el panel: qué infracciones hay y qué acciones admite cada una.
   *
   * Lo manda el backend en vez de duplicarlo en el JavaScript del panel porque la regla de qué
   * tipos aceptan sanción automática es una decisión de producto, no de presentación: si vive en
   * dos lados, tarde o temprano el panel ofrece una opción que el servidor va a rechazar.
   *
   * Acá también viajaban los tres presets de torneo, que ya no existen: ver el comentario que los
   * reemplazó en `incident/catalog.ts`.
   */
  app.get("/api/catalog", (_req, res) => {
    res.json({
      actions: ACTION_LABELS,
      autoPenaltyAllowed: [...AUTO_PENALTY_ALLOWED],
    });
  });

  /**
   * Perfiles de carrera: el reglamento completo guardado con un nombre.
   *
   * Las dos validaciones —nombre repetido y contenido repetido— viven en `config.ts` y devuelven
   * 409, que es el código del conflicto con el estado actual del recurso. No son 400: el pedido
   * está bien formado, lo que pasa es que ese perfil ya está.
   */
  app.get("/api/profiles", (_req, res) => {
    res.json({ profiles: deps.config.ruleProfiles, activeProfileId: deps.config.activeProfileId });
  });

  app.post("/api/profiles", (req, res) => {
    const result = saveProfile(deps.config, String((req.body ?? {}).name ?? ""));
    if ("error" in result) {
      res.status(409).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, profile: result, config: deps.config });
  });

  app.post("/api/profiles/:id/apply", (req, res) => {
    const result = applyProfile(deps.config, req.params.id);
    if ("error" in result) {
      res.status(404).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, profile: result, config: deps.config });
  });

  app.delete("/api/profiles/:id", (req, res) => {
    const result = deleteProfile(deps.config, req.params.id);
    if ("error" in result) {
      res.status(404).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, config: deps.config });
  });

  /**
   * Campos que el panel de una liga NO puede tocar.
   *
   * Los puertos y la dirección pública se los asigna el supervisor: si el panel pudiera
   * cambiarlos, una liga podría mudarse al puerto UDP de otra (y quedarse con su telemetría) o
   * dejar al portal haciendo proxy a un puerto donde no hay nadie.
   *
   * El nombre de la liga está por un motivo distinto: lo edita el operador en su tabla y el worker
   * lo toma del portal al arrancar. Si el panel también pudiera cambiarlo, el cambio del admin
   * duraría hasta el próximo reinicio y después volvería solo, sin que nadie entienda por qué.
   */
  function stripManagedFields(patch: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...patch };
    delete copy.leagueName;
    for (const key of ["http", "acUdp"] as const) {
      const section = copy[key];
      if (section && typeof section === "object" && !Array.isArray(section)) {
        const kept = { ...(section as Record<string, unknown>) };
        for (const managed of ["adminPort", "clientPort", "publicHost", "localPort", "remoteHost", "remotePort"]) {
          delete kept[managed];
        }
        if (Object.keys(kept).length === 0) delete copy[key];
        else copy[key] = kept;
      } else {
        delete copy[key];
      }
    }
    return copy;
  }

  app.post("/api/config", (req, res) => {
    if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
      res.status(400).json({ ok: false, error: "Body inválido" });
      return;
    }
    try {
      const patch = stripManagedFields(req.body);
      applyConfigPatch(deps.config, patch);
      res.json(deps.config);
    } catch (err) {
      // No dejar que un error de escritura (ej. permisos) tumbe el request en silencio — el
      // panel necesita un JSON para poder avisarle al usuario que algo falló.
      console.error("[admin-api] No se pudo guardar la configuración:", err);
      res.status(500).json({ ok: false, error: "No se pudo guardar la configuración: " + String(err) });
    }
  });

  /**
   * El tipo de sesión que el protocolo de AC llama "carrera". La largada en movimiento no tiene
   * sentido en ninguna otra: en práctica y clasificación los autos salen de boxes cuando quieren,
   * no hay parrilla que formar y no hay nadie a quien sancionar por adelantarse.
   *
   * El panel ya deshabilita los botones, pero el chequeo vive también acá por la razón de siempre:
   * un panel abierto desde ayer tiene el estado de ayer, y "el servidor ignora en silencio lo que
   * no corresponde" es exactamente el modo de falla que este producto persigue. Mejor un 409 con
   * una frase que explique por qué.
   */
  const RACE_SESSION_TYPE = 3;

  function soloEnCarrera(res: Response): boolean {
    if (deps.getSessionType() === RACE_SESSION_TYPE) return true;
    res.status(409).json({
      ok: false,
      error: "La largada solo se puede dar en una sesión de carrera. Ahora el servidor está en otra sesión.",
    });
    return false;
  }

  app.post("/api/formation/begin", (_req, res) => {
    if (!soloEnCarrera(res)) return;
    deps.formationStart.beginFormation();
    res.json({ ok: true, lightState: deps.formationStart.getLightState() });
  });

  app.post("/api/formation/green", (_req, res) => {
    if (!soloEnCarrera(res)) return;
    deps.formationStart.triggerGreen();
    res.json({ ok: true, lightState: deps.formationStart.getLightState() });
  });

  app.post("/api/formation/reset", (_req, res) => {
    deps.formationStart.reset();
    res.json({ ok: true, lightState: deps.formationStart.getLightState() });
  });

  /** Las que el comisario puede aplicar a mano. `TIME` es la más habitual en una liga: se suma al
   * resultado final sin interrumpir la carrera. */
  const MANUAL_TYPES: PenaltyType[] = ["TIME", "DT", "SG", "BALLAST"];

  /**
   * Resolución de un incidente de la bandeja.
   *
   * Con `status: "penalized"` además de marcar el incidente se **emite una sanción de verdad**:
   * le llega al piloto por chat y aparece en la tabla de sanciones aplicadas. Antes el botón
   * "Sancionar" solo tachaba el incidente y no pasaba nada más, que es lo contrario de lo que el
   * nombre promete.
   */
  app.post("/api/incidents/:id/resolve", (req, res) => {
    const body = req.body ?? {};
    const status = body.status;
    if (status !== "dismissed" && status !== "warned" && status !== "penalized") {
      res.status(400).json({ ok: false, error: "Estado inválido" });
      return;
    }
    const resolution = typeof body.resolution === "string" ? body.resolution : undefined;

    // Validar ANTES de resolver: `resolve` es irreversible, y un tipo de sanción inválido dejaría
    // el incidente marcado como sancionado sin ninguna sanción detrás.
    let penaltyType: PenaltyType = "TIME";
    let seconds = 5;
    let target: { carId: number; driverGuid: string; driverName?: string } | null = null;
    if (status === "penalized") {
      penaltyType = MANUAL_TYPES.indexOf(body.penaltyType) >= 0 ? body.penaltyType : "TIME";
      seconds = Number.isFinite(body.seconds) ? Math.min(600, Math.max(1, Math.round(body.seconds))) : 5;
      const pending = deps.incidentEngine.getAll().find((i) => i.id === req.params.id);
      // Un toque tiene dos partes y el servidor no sabe de quién fue la culpa: el comisario elige
      // a quién sanciona. Si no eligió, se toma la primera, que es quien reportó el evento.
      const parties = pending?.parties || [];
      target = parties.find((p) => p.carId === body.carId) || parties[0] || null;
      if (!target) {
        res.status(404).json({ ok: false, error: "El incidente no existe o no tiene pilotos asociados" });
        return;
      }
    }

    const incident = deps.incidentEngine.resolve(req.params.id, status, resolution);
    if (!incident) {
      res.status(404).json({ ok: false, error: "El incidente no existe o ya fue resuelto" });
      return;
    }

    let penalty = null;
    if (status === "penalized" && target) {
      const reason = `Comisario: ${describeIncident(incident)}`;
      penalty = deps.stewardPenaltyEngine.issuePenalty(target.carId, target.driverGuid, reason, penaltyType, {
        timePenaltySeconds: seconds,
        incidentId: incident.id,
      });
    }
    res.json({ ok: true, incident, penalty });
  });

  /**
   * Anular una sanción.
   *
   * Hasta la 0.5 no había ninguna forma de deshacer esto: un click en "Sancionar" con el piloto
   * equivocado seleccionado —y el desplegable viene con uno preseleccionado— quedaba firme para
   * siempre, le llegaba al piloto por chat y salía impreso en el informe de la carrera. El panel
   * tenía un botón de kick con doble confirmación y uno de sanción sin ninguna, que es el orden
   * inverso al de la gravedad: de un kick el piloto vuelve a entrar.
   *
   * La ruta no recibe el motor: los ids son únicos entre los tres (el contador es de módulo) y
   * pedirle al panel que sepa de qué motor salió cada sanción es pedirle que repita una
   * clasificación que ya hizo el servidor.
   */
  app.post("/api/penalties/:id/revoke", (req, res) => {
    const id = String(req.params.id);
    for (const engine of [deps.formationPenaltyEngine, deps.pitPenaltyEngine, deps.stewardPenaltyEngine]) {
      const revoked = engine.revoke(id);
      if (revoked) {
        res.json({ ok: true, penalty: revoked });
        return;
      }
    }
    // Un 404 acá es casi siempre un doble click sobre el mismo botón, así que el mensaje tiene que
    // contemplar las dos causas y no mandar a investigar un id que existe y ya está anulado.
    res.status(404).json({ ok: false, error: "Esa sanción no existe o ya estaba anulada" });
  });

  /**
   * Kick manual desde la tabla de pilotos.
   *
   * Se ejecuta SIEMPRE, incluso con el modo sombra activo. El modo sombra existe para que el
   * motor automático no sancione sin supervisión — no para bloquear una orden explícita del
   * admin, que por definición ya está supervisada. Queda en el journal como `kick.manual`,
   * distinguible del automático.
   */
  app.post("/api/cars/:carId/kick", (req, res) => {
    const carId = Number(req.params.carId);
    if (!Number.isInteger(carId) || carId < 0) {
      res.status(400).json({ ok: false, error: "Auto inválido" });
      return;
    }
    const car = deps.stateTracker.get(carId);
    if (!car || !car.connected) {
      res.status(404).json({ ok: false, error: "Ese auto no está conectado" });
      return;
    }
    deps.manualKick(carId);
    res.json({ ok: true, carId, driverName: car.driverName });
  });

  /**
   * Informe de carrera, descargable.
   *
   * Es un CSV y no un PDF ni una página: lo que el admin hace con esto es pegarlo en la planilla
   * del campeonato, no leerlo lindo. El mismo contenido está en `/api/report` como JSON, para
   * quien quiera automatizarlo.
   */
  app.get("/api/report.csv", (_req, res) => {
    const report = currentReport();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${reportFileName(report)}"`);
    res.send(toCsv(report));
  });

  app.get("/api/report", (_req, res) => res.json(currentReport()));

  function currentReport() {
    return buildReport({
      leagueName: deps.config.leagueName,
      version: APP_VERSION,
      // `getRoster` y no `getConnected`: quien abandonó en la vuelta 3 también va en el informe,
      // con las sanciones que se haya llevado. Y es el roster y no `getAll` porque el roster está
      // indexado por piloto: quien se reconectó y cambió de slot aparecía dos veces en la tabla
      // de posiciones, una con sus vueltas y otra con las que hizo después.
      cars: deps.stateTracker.getRoster(),
      sessionType: deps.getSessionType(),
      session: deps.sessionTracker.get(),
      penaltiesByEngine: [
        ["formation", deps.formationPenaltyEngine.getAll()],
        ["pit", deps.pitPenaltyEngine.getAll()],
        ["steward", deps.stewardPenaltyEngine.getAll()],
      ],
      incidents: deps.incidentEngine.getAll(),
      now: Date.now(),
    });
  }

  /**
   * El panel usa rutas del lado del cliente (`/sanciones`). Sin esto, recargar esa URL o abrirla
   * de un marcador devuelve 404: Express solo conoce `/index.html`. Va al final, después de los
   * estáticos y de toda la API, para no tapar una ruta real.
   */
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  // Red de seguridad: cualquier excepción no prevista en una ruta devuelve JSON, no la página de
  // error HTML por defecto de Express — el panel siempre espera poder parsear la respuesta.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[admin-api] Error no manejado:", err);
    res.status(500).json({ ok: false, error: String(err) });
  });

  return app;
}

/** Los mismos nombres que muestra la bandeja, para que el motivo de la sanción que le llega al
 * piloto por chat sea reconocible contra lo que el comisario estaba mirando. */
const INCIDENT_LABELS: Record<string, string> = {
  "car-contact": "toque entre autos",
  "env-collision": "choque en solitario",
  "track-limits": "límites de pista",
  "cut-lap": "vuelta invalidada por irse de pista",
  "telemetry-mismatch": "telemetría inconsistente",
  "wrong-way": "en contramano",
  disconnect: "desconexión en carrera",
};

function describeIncident(incident: Incident): string {
  const what = INCIDENT_LABELS[incident.kind] || "incidente";
  const bits = [`${what} en la vuelta ${incident.lap}`];
  if (typeof incident.impactSpeedKmh === "number") bits.push(`impacto a ${Math.round(incident.impactSpeedKmh)} km/h`);
  if (incident.detail) bits.push(incident.detail);
  return bits.join(", ");
}

