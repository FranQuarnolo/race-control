import { EventEmitter } from "events";
import { ClientEvent, ClientEventType } from "../udp/protocol";
import { CarState, StateTracker } from "../state/stateTracker";
import { Clock, systemClock } from "../util/clock";
import { InfractionAction, InfractionCatalog, InfractionType } from "./catalog";

/**
 * Los dos primeros nacen de un `CLIENT_EVENT` del servidor; el resto se deduce cruzando
 * telemetría, posiciones y el dato autoritativo del servidor. Comparten bandeja a propósito: para
 * el comisario son todos "algo que revisar", y partirlos en varias listas lo obligaría a mirar en
 * varios lados durante la carrera.
 */
export type IncidentKind =
  | "car-contact"
  | "env-collision"
  | "track-limits"
  | "cut-lap"
  | "telemetry-mismatch"
  | "wrong-way"
  | "disconnect"
  | "pit-speeding"
  | "formation-speeding";

/** Los que no nacen de una colisión: los reportan los watchers y el tracker de límites. */
export type ObservedKind = Exclude<IncidentKind, "car-contact" | "env-collision">;

/** Tipo de sesión del protocolo de AC. Ver `RACE_SESSION_TYPE` en adminApi.ts. */
const PRACTICE_SESSION_TYPE = 1;

/**
 * Qué entrada del catálogo gobierna cada tipo.
 *
 * `telemetry-mismatch` no tiene entrada propia y es correcto que no la tenga: no es una
 * infracción del piloto sino una alerta de integridad del sistema. Vive y muere con el control de
 * límites de pista, que es lo que la produce.
 *
 * `cut-lap` sí es una infracción y comparte la entrada de `trackLimits`: son la misma regla vista
 * por dos ojos distintos —el del servidor, que tacha la vuelta, y el de la app del piloto, que
 * cuenta ruedas—. Apagar "límites de pista" en Reglas tiene que apagar las dos.
 *
 * Los dos excesos de velocidad tienen entrada propia desde la 1.3, y lo que esa entrada decide es
 * **solo si el hecho entra a la bandeja**: la sanción ya la emitió el monitor que lo detectó, con
 * el umbral que vive en Largada o en Pit. Poner el tipo en "No controlar" deja de mostrarlo acá;
 * no deja de sancionarlo.
 */
const TYPE_OF_KIND: Record<IncidentKind, InfractionType | null> = {
  "car-contact": "carContact",
  "env-collision": "envCollision",
  "track-limits": "trackLimits",
  "cut-lap": "trackLimits",
  "wrong-way": "wrongWay",
  disconnect: "disconnectDuringRace",
  "pit-speeding": "pitSpeeding",
  "formation-speeding": "formationSpeeding",
  "telemetry-mismatch": null,
};

/**
 * Geometría del toque, deducida de dónde golpeó cada auto en su propio chasis.
 *
 * NO es un veredicto de culpa — es un dato que la acompaña. Un `rear-end` puede ser culpa del de
 * adelante por frenar en seco, y un `side-by-side` puede ser cualquier cosa. Por eso los
 * incidentes van a una bandeja para que decida un comisario, en vez de auto-sancionarse.
 */
export type ContactGeometry = "rear-end" | "side-by-side" | "head-on" | "unknown";

export interface IncidentParty {
  carId: number;
  driverGuid: string;
  driverName: string;
  speedKmh: number;
  /** Dónde golpeó en SU chasis: la cara del auto que recibió/dio el impacto. */
  contactPoint?: "front" | "rear" | "left" | "right";
}

export interface Incident {
  id: string;
  kind: IncidentKind;
  createdAt: number;
  /** Quién reportó primero. En un toque entre autos, `parties` tiene a los dos. */
  parties: IncidentParty[];
  geometry: ContactGeometry;
  /** La más alta observada si el incidente agrupó varios impactos seguidos. Ausente en los tipos
   * que no son una colisión: una salida de pista no tiene velocidad de impacto, y poner `0` sería
   * afirmar un dato que nadie midió. */
  impactSpeedKmh?: number;
  /** Cuántos impactos se agruparon en este incidente (un trompo genera decenas). */
  impactCount: number;
  lap: number;
  /** Punto de la vuelta donde ocurrió (0..1), para ubicarlo en el mapa. */
  splinePosition: number;
  worldPosition?: { x: number; y: number; z: number };
  /** Contexto propio de los tipos que no son colisión (ej. "4 salidas de pista"). En una colisión
   * el contexto ya lo dan la geometría y la velocidad de impacto. */
  detail?: string;
  phase: string;
  status: "pending" | "dismissed" | "warned" | "penalized";
  resolvedAt?: number;
  resolution?: string;
}

/** Ventana para juntar los dos paquetes que el servidor manda por un mismo toque. */
const PAIRING_WINDOW_MS = 500;

/** Ventana de agrupación: impactos del mismo auto dentro de esto son UN incidente. */
const GROUPING_WINDOW_MS = 3000;

let nextId = 1;

/**
 * Un reporte a la espera de su contraparte.
 *
 * Guarda un `snapshot` del estado del auto en vez de la referencia del `StateTracker`: el tracker
 * MUTA el mismo objeto `CarState` con cada CAR_UPDATE (cada 200 ms), así que para cuando se emite
 * el incidente —hasta medio segundo después— la velocidad y la posición guardadas ya serían las
 * de después del impacto, no las del momento del toque.
 */
interface PendingReport {
  event: ClientEvent;
  snapshot: CarSnapshot;
}

type CarSnapshot = Pick<CarState, "driverGuid" | "driverName" | "speedKmh" | "lapCount" | "normalizedSplinePosition">;

function snapshotOf(car: CarState | undefined, carId: number): CarSnapshot {
  return {
    driverGuid: car?.driverGuid ?? "",
    driverName: car?.driverName || `Auto ${carId}`,
    speedKmh: car?.speedKmh ?? 0,
    lapCount: car?.lapCount ?? 0,
    normalizedSplinePosition: car?.normalizedSplinePosition ?? 0,
  };
}

/**
 * Convierte eventos de colisión crudos en incidentes con contexto, listos para que un comisario
 * los revise.
 *
 * Tres problemas que resuelve, y que son la razón de que esto no sea un simple `map()`:
 *
 * 1. **Doble reporte.** El servidor emite un CLIENT_EVENT por CADA auto involucrado en un toque.
 *    Sin correlacionarlos, la bandeja muestra cada toque dos veces y señala a los dos pilotos.
 * 2. **Flood.** Un trompo contra el muro genera decenas de eventos en dos segundos. Sin agrupar,
 *    la bandeja es inusable antes de la primera vuelta.
 * 3. **Falta de contexto.** El paquete trae posiciones pero no dice quién es quién, en qué vuelta
 *    va ni a qué velocidad iban — eso sale de cruzarlo con el StateTracker en el momento exacto.
 */
export class IncidentEngine extends EventEmitter {
  private incidents: Incident[] = [];
  /** Reportes esperando que llegue la perspectiva del otro auto. Clave: carId del que reportó. */
  private awaitingPair = new Map<number, PendingReport>();
  /**
   * Incidentes abiertos para agrupar impactos seguidos.
   *
   * La clave identifica a los *involucrados*, no a un auto: `env:7` para los choques en solitario
   * del auto 7, y `contact:3,9` (ordenado) para los toques entre el 3 y el 9. Agrupar por auto a
   * secas metería en el mismo incidente un toque del 3 contra el 9 y otro del 3 contra el 5 un
   * segundo después, listando mal a las partes. Así el antiflood solo junta lo que de verdad es
   * el mismo evento repetido.
   */
  private openIncident = new Map<string, { incident: Incident; lastAt: number }>();

  constructor(
    private stateTracker: StateTracker,
    private rules: InfractionCatalog,
    private getPhase: () => string,
    private getSessionType: () => number,
    private clock: Clock = systemClock
  ) {
    super();
  }

  /**
   * Decide qué hacer con un incidente según lo que el admin configuró para ese tipo.
   *
   * `log` emite el hecho para el journal pero NO lo mete en la bandeja: queda registrado para el
   * informe de la carrera sin obligar al comisario a resolverlo uno por uno. Es la diferencia
   * entre "quiero que quede constancia" y "quiero decidir qué hago con esto".
   *
   * En práctica no hay nada que sancionar: los autos salen de boxes cuando quieren, se cruzan de
   * cualquier forma y un toque no significa nada. Antes se registraba igual que en carrera, y la
   * bandeja de un piloto arrancaba la clasificación con incidentes de una sesión que no corrió.
   */
  private route(incident: Incident): InfractionAction {
    if (this.getSessionType() === PRACTICE_SESSION_TYPE) return "ignore";
    const type = TYPE_OF_KIND[incident.kind];
    const action = type === null ? "review" : this.rules[type].action;
    if (action === "ignore") return action;
    if (action === "log") {
      this.emit("incident-logged", incident);
      return action;
    }
    // "review" y "penalty" entran igual a la bandeja. La sanción automática la aplica quien
    // detectó el hecho (ver TrackLimitsTracker); el comisario igual tiene que ver que ocurrió,
    // aunque sea para revertirla.
    this.incidents.push(incident);
    this.emit("incident", incident);
    return action;
  }

  /** Más reciente primero. Se invierte el orden de inserción en vez de ordenar por `createdAt`:
   * dos incidentes del mismo milisegundo —normal en una carambola— quedarían al revés. */
  getAll(): Incident[] {
    return [...this.incidents].reverse();
  }

  getPending(): Incident[] {
    return this.getAll().filter((i) => i.status === "pending");
  }

  /**
   * Repone la bandeja tras un reinicio del backend a mitad de carrera.
   *
   * Se cargan en orden de creación porque `getAll()` invierte el orden de inserción, no ordena por
   * fecha. No se emite `incident` por cada uno: el comisario ya los vio, y volver a emitirlos los
   * duplicaría en el journal de la carrera.
   */
  restore(incidents: Incident[]): void {
    for (const incident of [...incidents].sort((a, b) => a.createdAt - b.createdAt)) {
      this.incidents.push(incident);
      const n = Number(incident.id.replace(/^I/, ""));
      if (Number.isInteger(n) && n >= nextId) nextId = n + 1;
    }
  }

  resolve(id: string, status: "dismissed" | "warned" | "penalized", resolution?: string): Incident | undefined {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident || incident.status !== "pending") return undefined;
    incident.status = status;
    incident.resolvedAt = Date.now();
    incident.resolution = resolution;
    this.emit("incident-resolved", incident);
    return incident;
  }

  /**
   * Registra un hecho observado que no es una colisión: salidas de pista reincidentes, ganancia
   * de tiempo, telemetría inconsistente.
   *
   * No pasa por la correlación ni por el antiflood de los toques, y es correcto que no lo haga:
   * estos incidentes ya vienen regulados en origen (uno cada N salidas, uno por cada salto de
   * diferencia con el servidor), así que agruparlos de nuevo acá los taparía en vez de ordenarlos.
   */
  reportObserved(args: {
    kind: ObservedKind;
    carId: number;
    driverGuid: string;
    driverName: string;
    lap: number;
    splinePosition: number;
    detail: string;
    /**
     * Velocidad que queda escrita en el incidente, si la que importa no es la de ahora.
     *
     * Para un exceso de velocidad es la **máxima del pasaje**, que es el dato por el que se
     * sancionó. La actual ya no sirve: el monitor avisa después de los segundos de tolerancia y
     * el auto, para entonces, suele venir frenando — el incidente diría "48 km/h" al lado de una
     * sanción por haber ido a 90.
     */
    speedKmh?: number;
  }): Incident | null {
    const car = this.stateTracker.get(args.carId);
    const incident: Incident = {
      id: `I${nextId++}`,
      kind: args.kind,
      createdAt: Date.now(),
      parties: [
        {
          carId: args.carId,
          driverGuid: args.driverGuid,
          driverName: args.driverName,
          speedKmh: args.speedKmh ?? car?.speedKmh ?? 0,
        },
      ],
      geometry: "unknown",
      impactCount: 1,
      lap: args.lap,
      splinePosition: args.splinePosition,
      detail: args.detail,
      phase: this.getPhase(),
      status: "pending",
    };
    const action = this.route(incident);
    return action === "review" || action === "penalty" ? incident : null;
  }

  onClientEvent(event: ClientEvent): void {
    if (event.eventType === ClientEventType.COLLISION_WITH_ENV) {
      this.handleEnvCollision(event);
      return;
    }
    if (event.eventType === ClientEventType.COLLISION_WITH_CAR) {
      this.handleCarContact(event);
    }
    // Otros subtipos de CLIENT_EVENT no están documentados por Kunos — se ignoran en silencio
    // en vez de inventarles un significado.
  }

  private handleEnvCollision(event: ClientEvent): void {
    if (this.rules.envCollision.action === "ignore") return;
    if (event.impactSpeed < this.rules.envCollision.minImpactKmh) return;

    if (this.tryGroupInto(envKey(event.carId), event)) return;

    const snapshot = snapshotOf(this.stateTracker.get(event.carId), event.carId);
    this.open({
      key: envKey(event.carId),
      kind: "env-collision",
      parties: [toParty(event.carId, snapshot, event)],
      geometry: "unknown",
      event,
      context: snapshot,
    });
  }

  private handleCarContact(event: ClientEvent): void {
    if (this.rules.carContact.action === "ignore") return;
    const otherCarId = event.otherCarId;
    if (otherCarId === undefined) return;

    const report: PendingReport = { event, snapshot: snapshotOf(this.stateTracker.get(event.carId), event.carId) };

    // ¿El otro auto ya reportó este mismo toque desde su lado? Si sí, los unimos.
    const counterpart = this.awaitingPair.get(otherCarId);
    if (counterpart && counterpart.event.otherCarId === event.carId) {
      this.awaitingPair.delete(otherCarId);
      this.emitContact(counterpart, report);
      return;
    }

    // Todavía no llegó el otro lado: lo guardamos un instante por si llega.
    this.awaitingPair.set(event.carId, report);
    const timer = setTimeout(() => {
      if (this.awaitingPair.get(event.carId) !== report) return;
      this.awaitingPair.delete(event.carId);
      // El otro lado nunca llegó (paquete perdido, o el otro auto se desconectó en el impacto).
      // Se emite igual con una sola perspectiva: perder el incidente sería peor que registrarlo
      // incompleto, porque es justo el caso de un choque que saca a alguien de la carrera.
      this.emitContact(report, null);
    }, PAIRING_WINDOW_MS);
    // Un toque pendiente de correlacionar no debe impedir que el proceso cierre.
    timer.unref?.();
  }

  private emitContact(primary: PendingReport, secondary: PendingReport | null): void {
    const otherId = primary.event.otherCarId;
    if (otherId === undefined) return;

    const impactSpeed = Math.max(primary.event.impactSpeed, secondary?.event.impactSpeed ?? 0);
    if (impactSpeed < this.rules.carContact.minImpactKmh) return;

    const key = contactKey(primary.event.carId, otherId);
    if (this.tryGroupInto(key, primary.event)) return;

    // Si el otro lado nunca reportó, su contexto se lee ahora: es lo mejor disponible, y el
    // desfasaje de medio segundo es irrelevante al lado de no tener el dato.
    const otherSnapshot = secondary?.snapshot ?? snapshotOf(this.stateTracker.get(otherId), otherId);

    this.open({
      key,
      kind: "car-contact",
      parties: [
        toParty(primary.event.carId, primary.snapshot, primary.event),
        toParty(otherId, otherSnapshot, secondary?.event),
      ],
      geometry: classifyContact(primary.event, secondary?.event ?? null),
      event: primary.event,
      context: primary.snapshot,
      impactSpeedOverride: impactSpeed,
    });
  }

  /** Si ya hay un incidente abierto hace poco entre los mismos involucrados, suma el impacto ahí
   * en vez de crear uno nuevo. Es lo que evita que un trompo genere 40 entradas en la bandeja. */
  private tryGroupInto(key: string, event: ClientEvent): boolean {
    const open = this.openIncident.get(key);
    if (!open) return false;
    const now = this.clock.now();
    if (now - open.lastAt > GROUPING_WINDOW_MS) {
      this.openIncident.delete(key);
      return false;
    }
    open.lastAt = now;
    open.incident.impactCount += 1;
    open.incident.impactSpeedKmh = Math.max(open.incident.impactSpeedKmh ?? 0, event.impactSpeed);
    this.emit("incident-updated", open.incident);
    return true;
  }

  private open(args: {
    key: string;
    kind: IncidentKind;
    parties: IncidentParty[];
    geometry: ContactGeometry;
    event: ClientEvent;
    /** De quién se toman vuelta y posición: siempre el auto que reportó primero. */
    context: CarSnapshot;
    impactSpeedOverride?: number;
  }): void {
    const incident: Incident = {
      id: `I${nextId++}`,
      kind: args.kind,
      createdAt: Date.now(),
      parties: args.parties,
      geometry: args.geometry,
      impactSpeedKmh: args.impactSpeedOverride ?? args.event.impactSpeed,
      impactCount: 1,
      lap: args.context.lapCount,
      splinePosition: args.context.normalizedSplinePosition,
      worldPosition: args.event.worldPosition,
      phase: this.getPhase(),
      status: "pending",
    };
    if (this.route(incident) === "ignore") return;
    // El antiflood se arma incluso cuando el tipo está en "solo registrar": si no, un trompo
    // contra el muro escribiría cuarenta líneas en el journal en vez de una con su contador.
    this.openIncident.set(args.key, { incident, lastAt: this.clock.now() });
  }

  /** Limpia el estado de correlación entre sesiones. El historial de incidentes NO se borra: un
   * comisario puede estar revisando la carrera anterior mientras ya arrancó la siguiente. */
  resetSessionState(): void {
    this.awaitingPair.clear();
    this.openIncident.clear();
  }
}

function toParty(carId: number, snapshot: CarSnapshot, event?: ClientEvent): IncidentParty {
  return {
    carId,
    driverGuid: snapshot.driverGuid,
    driverName: snapshot.driverName,
    speedKmh: snapshot.speedKmh,
    contactPoint: event ? contactPointOf(event.relPosition) : undefined,
  };
}

function envKey(carId: number): string {
  return `env:${carId}`;
}

/** Ordenado para que el toque A→B y el B→A caigan en la misma clave. */
function contactKey(a: number, b: number): string {
  return a < b ? `contact:${a},${b}` : `contact:${b},${a}`;
}

/**
 * Qué cara del auto recibió el golpe, según la posición relativa del impacto sobre su chasis.
 *
 * Convención de ejes de AC: Z es el eje longitudinal (adelante/atrás) y X el transversal. Se
 * compara cuál domina en magnitud para no clasificar como "trasero" un roce lateral que apenas
 * cae detrás del centro del auto.
 */
function contactPointOf(rel: { x: number; y: number; z: number }): "front" | "rear" | "left" | "right" {
  if (Math.abs(rel.z) >= Math.abs(rel.x)) return rel.z >= 0 ? "front" : "rear";
  return rel.x >= 0 ? "right" : "left";
}

/**
 * Deduce el tipo de toque cruzando las dos perspectivas.
 *
 * Con una sola perspectiva no se puede distinguir un rear-end de un head-on: saber que A golpeó
 * con su trompa no dice si B recibió en la cola (lo embistió) o en la trompa (frontal). Por eso
 * un evento sin su par devuelve "unknown" en vez de adivinar.
 */
export function classifyContact(primary: ClientEvent, secondary: ClientEvent | null): ContactGeometry {
  if (!secondary) return "unknown";
  const a = contactPointOf(primary.relPosition);
  const b = contactPointOf(secondary.relPosition);

  const isSide = (p: string) => p === "left" || p === "right";
  if (isSide(a) && isSide(b)) return "side-by-side";
  if (a === "front" && b === "rear") return "rear-end";
  if (a === "rear" && b === "front") return "rear-end";
  if (a === "front" && b === "front") return "head-on";
  return "unknown";
}

/** Texto para el panel. Deliberadamente descriptivo y no acusatorio: describe el impacto, no
 * reparte culpas — eso lo decide el comisario. */
export function describeGeometry(geometry: ContactGeometry): string {
  switch (geometry) {
    case "rear-end":
      return "Toque trompa contra cola";
    case "side-by-side":
      return "Toque rueda a rueda";
    case "head-on":
      return "Impacto frontal";
    default:
      return "Sin determinar";
  }
}
