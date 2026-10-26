import { EventEmitter } from "events";
import { StateTracker } from "../state/stateTracker";
import { TrackLimitsRule } from "../incident/catalog";

/**
 * Límites de pista: salidas con ruedas afuera, y validación cruzada contra el servidor.
 *
 * Por qué esto vive acá y no en el motor de incidentes: el UDP de AC **no expone** si un auto
 * tiene ruedas afuera. Solo entrega `cuts` al cerrar la vuelta (`LAP_COMPLETED`), que llega tarde
 * y no dice dónde ni cuánto. La detección fina la hace la app del piloto leyendo
 * `numberOfTyresOut` de la Shared Memory, y lo que llega acá son **transiciones** ya cerradas
 * (entró en infracción → salió), nunca un stream continuo.
 *
 * El cliente es un `.py` en texto plano en la PC del piloto: es editable. La defensa no es
 * cifrarlo sino **contrastarlo** — ver `onLapCompleted`.
 *
 * ---
 *
 * **Quién manda (cambió en la 0.8).** Hay dos fuentes y hacen cosas distintas:
 *
 * | | De dónde sale | Llega siempre | Qué hace |
 * |---|---|---|---|
 * | **Corte** | `cuts` del `LAP_COMPLETED` del servidor | sí | cuenta en la torre, abre la entrada en la bandeja y dispara la sanción por reincidencia |
 * | **Salida** | `numberOfTyresOut` de la app del piloto | solo con la app | aporta el detalle (ruedas, duración, dónde), la revisión por ganancia de tiempo y la validación cruzada |
 *
 * Hasta la 0.6 mandaba la salida, y eso tenía dos filtros encima —tener la app instalada y superar
 * el umbral de ruedas del admin, 4 por defecto—. El resultado era que alguien podía irse de pista,
 * ver cómo el juego le tachaba la vuelta, y que en Race Control no apareciera nada. Un piloto sin
 * la app no se llevaba jamás una sanción por irse de pista y uno con la app sí, que es la misma
 * infracción costando distinto según lo que cada uno tenga instalado.
 */

/** Una salida ya cerrada, tal como la reporta el cliente. Llega de afuera: se sanea entera. */
export interface Excursion {
  maxTyresOut: number;
  durationMs: number;
  /** Punto de la vuelta donde empezó (0..1), para ubicarla en el mapa. */
  splinePosition: number;
  lap: number;
  sector: number;
}

export interface TrackLimitsIncident {
  kind: "track-limits" | "telemetry-mismatch" | "cut-lap";
  carId: number;
  driverGuid: string;
  driverName: string;
  lap: number;
  splinePosition: number;
  detail: string;
}

/**
 * Diferencia tolerada entre los cortes que reporta el servidor y las salidas que reporta el
 * cliente antes de considerarlo sospechoso.
 *
 * No es cero por una razón honesta: el heartbeat viaja cada 2 s, así que una salida justo antes
 * de la línea de meta puede llegar después del `LAP_COMPLETED` y quedar contada en la vuelta
 * siguiente. Ese desfasaje produce diferencias de 1 todo el tiempo y no significa nada. Lo que un
 * desfasaje NO puede producir es una diferencia que crece y no se cierra nunca — por eso la
 * comparación es acumulada sobre la sesión y no vuelta a vuelta.
 */
const MISMATCH_GAP = 3;

/** Una vuelta más corta que esto no es una vuelta (reinicio de sesión, teletransporte a boxes). */
const MIN_PLAUSIBLE_LAP_MS = 15_000;

/** Tope de salidas por reporte. El cliente acumula mientras el backend no esté disponible; esto
 * evita que un cliente roto (o manipulado) mande un array de 100k entradas. */
const MAX_EXCURSIONS_PER_REPORT = 50;

interface DriverLimits {
  /** Salidas que superaron el umbral configurado, en la sesión. */
  count: number;
  /** Cuántas salidas tenía la última vez que se abrió un incidente por reincidencia. */
  reportedAt: number;
  /** Salidas acumuladas en la vuelta en curso (las que superaron el umbral). */
  currentLap: Excursion[];
  /** Total de salidas reportadas, de cualquier cantidad de ruedas. Base de la validación cruzada:
   * AC invalida la vuelta por salirse, sin importar el umbral que haya elegido el admin. */
  excursionsSeen: number;
  /** Total de `cuts` que reportó el servidor en la sesión. Autoritativo. */
  cutsSeen: number;
  /** Cuántos cortes tenía la última vez que se aplicó una sanción automática por reincidencia. */
  cutsPenalizedAt: number;
  /** Diferencia con la que se avisó por última vez, para no repetir el mismo aviso cada vuelta. */
  mismatchReportedAt: number;
  /** Mejor vuelta limpia del piloto: sin salidas reportadas y sin cortes según el servidor. */
  bestCleanLapMs: number | null;
}

function emptyLimits(): DriverLimits {
  return {
    count: 0,
    reportedAt: 0,
    currentLap: [],
    excursionsSeen: 0,
    cutsSeen: 0,
    cutsPenalizedAt: 0,
    mismatchReportedAt: 0,
    bestCleanLapMs: null,
  };
}

export class TrackLimitsTracker extends EventEmitter {
  private byGuid = new Map<string, DriverLimits>();

  constructor(
    private stateTracker: StateTracker,
    private rules: TrackLimitsRule,
    /** Si el piloto tiene la app reportando. Sin app no hay con qué contrastar los cortes, así
     * que no se le puede reclamar incoherencia: simplemente no hay dato. */
    private hasClient: (driverGuid: string) => boolean
  ) {
    super();
  }

  /** Salidas en la sesión, para mostrarlas en el panel. */
  getCount(driverGuid: string): number {
    return this.byGuid.get(driverGuid)?.count ?? 0;
  }

  /**
   * Cortes que contó el servidor en la sesión: las veces que Assetto Corsa invalidó una vuelta por
   * irse de pista. Es el número que el panel muestra en la torre.
   *
   * Es distinto de `getCount()` y los dos tienen que estar: éste llega siempre —no necesita que el
   * piloto tenga la app— y es el criterio del propio juego, el mismo que le tachó la vuelta. El
   * otro es el de la app, filtrado por el umbral de ruedas que eligió el admin.
   */
  getCuts(driverGuid: string): number {
    return this.byGuid.get(driverGuid)?.cutsSeen ?? 0;
  }

  /** Procesa las salidas que vinieron en un heartbeat. `raw` llega del cliente sin validar. */
  report(driverGuid: string, raw: unknown): void {
    if (this.rules.action === "ignore" || !driverGuid || !Array.isArray(raw)) return;

    const limits = this.getOrCreate(driverGuid);
    for (const item of raw.slice(0, MAX_EXCURSIONS_PER_REPORT)) {
      const excursion = sanitizeExcursion(item);
      if (!excursion) continue;

      // Cuenta para la validación cruzada aunque no llegue al umbral del admin: el servidor
      // invalida la vuelta por cualquier salida, no por las de cuatro ruedas.
      limits.excursionsSeen += 1;

      if (excursion.maxTyresOut < this.rules.minTyresOut) continue;
      if (excursion.durationMs < this.rules.minDurationMs) continue;

      limits.count += 1;
      limits.currentLap.push(excursion);
      this.emit("excursion", { driverGuid, excursion, total: limits.count });

      if (limits.count - limits.reportedAt >= this.rules.excursionsForIncident) {
        limits.reportedAt = limits.count;
        const detail = `${limits.count} salidas de pista con ${this.rules.minTyresOut} ruedas o más`;
        this.raise(driverGuid, { kind: "track-limits", lap: excursion.lap, splinePosition: excursion.splinePosition, detail });
        // Acá NO se emite la sanción automática, aunque hasta la 0.7 se emitía. Se mudó al cierre
        // de vuelta, que cuenta los cortes del servidor. El motivo: este camino depende de que el
        // piloto tenga la app instalada y de un umbral de ruedas elegido a mano, así que un piloto
        // sin app no se llevaba jamás una sanción por irse de pista, y uno con app sí. La misma
        // infracción no puede costar distinto según lo que cada uno tenga instalado.
        //
        // Esto sigue yendo a la bandeja porque dice algo que el corte no dice: cuántas ruedas y
        // cuánto tiempo estuvo afuera.
      }
    }
  }

  /**
   * Cierre de vuelta. Hace las dos cosas que solo se pueden hacer con el dato autoritativo
   * del servidor en la mano:
   *
   * 1. **Ganancia de tiempo.** Una salida es un error; una salida en la vuelta más rápida del
   *    piloto es otra cosa. Se compara contra su mejor vuelta *limpia* —no contra la mejor a
   *    secas— para que una vuelta rápida sucia no suba el listón y tape a la siguiente.
   * 2. **Telemetría inconsistente.** `cuts` viene del servidor y no se puede falsificar desde la
   *    PC del piloto. Si el servidor viene contando cortes que el cliente nunca informó, eso
   *    mismo es un incidente para la bandeja. Convierte la debilidad del cliente editable en una
   *    señal de detección.
   */
  onLapCompleted(carId: number, lapTimeMs: number, cuts: number): void {
    if (this.rules.action === "ignore") return;
    const car = this.stateTracker.get(carId);
    if (!car?.driverGuid) return;

    const limits = this.getOrCreate(car.driverGuid);
    const lapExcursions = limits.currentLap;
    limits.currentLap = [];
    limits.cutsSeen += Math.max(0, cuts);

    const plausible = Number.isFinite(lapTimeMs) && lapTimeMs >= MIN_PLAUSIBLE_LAP_MS;
    const clean = lapExcursions.length === 0 && cuts === 0;

    if (cuts > 0) this.onCutLap(car.driverGuid, limits, car.lapCount, cuts, lapExcursions);

    if (plausible && clean && (limits.bestCleanLapMs === null || lapTimeMs < limits.bestCleanLapMs)) {
      limits.bestCleanLapMs = lapTimeMs;
    }

    if (
      this.rules.reviewTimeGain &&
      plausible &&
      lapExcursions.length > 0 &&
      limits.bestCleanLapMs !== null &&
      lapTimeMs < limits.bestCleanLapMs
    ) {
      const last = lapExcursions[lapExcursions.length - 1];
      this.raise(car.driverGuid, {
        kind: "track-limits",
        lap: car.lapCount,
        splinePosition: last.splinePosition,
        detail: `Salida de pista en su vuelta más rápida (${formatLap(lapTimeMs)}, mejor limpia ${formatLap(
          limits.bestCleanLapMs
        )})`,
      });
    }

    this.checkMismatch(car.driverGuid, limits, car.lapCount);
  }

  /**
   * Una vuelta que el servidor invalidó por irse de pista.
   *
   * Es el camino que faltaba, y faltaba el que más importa. Hasta la 0.7, irse de pista solo se
   * registraba si el piloto tenía la app instalada **y** la salida superaba el umbral de ruedas
   * que eligió el admin —4 por defecto—. Con esos dos filtros encima, alguien podía irse de pista,
   * ver cómo el juego le tachaba la vuelta, y que en Race Control no apareciera absolutamente
   * nada. Eso fue exactamente lo que pasó en la primera prueba real.
   *
   * `cuts` viene en el `LAP_COMPLETED` del servidor dedicado. Es el mismo número con el que el
   * juego decidió invalidar la vuelta, llega para todos los pilotos tengan o no la app, y no se
   * puede falsificar desde la PC del piloto. Por eso **es el que manda**: cuenta para la torre, abre
   * la entrada en la bandeja y es el que dispara la sanción automática por reincidencia.
   *
   * Una entrada por vuelta invalidada, no una por corte: si alguien se fue tres veces en la misma
   * vuelta, eso es una vuelta tachada y una línea en la bandeja que dice tres. Así la bandeja de
   * una carrera de 20 autos sigue siendo leíble por un humano.
   */
  private onCutLap(
    driverGuid: string,
    limits: DriverLimits,
    lap: number,
    cuts: number,
    lapExcursions: Excursion[]
  ): void {
    // Si la app reportó la salida, se usa su punto de la vuelta para ubicarla en el mapa. El
    // servidor manda cuántos cortes hubo, nunca dónde.
    const last = lapExcursions.length > 0 ? lapExcursions[lapExcursions.length - 1] : null;
    const veces = cuts === 1 ? "una vez" : `${cuts} veces`;
    this.raise(driverGuid, {
      kind: "cut-lap",
      lap,
      splinePosition: last ? last.splinePosition : 0,
      detail: `Se fue de pista ${veces}: el servidor invalidó la vuelta ${lap}`,
    });

    if (limits.cutsSeen - limits.cutsPenalizedAt < this.rules.excursionsForIncident) return;
    limits.cutsPenalizedAt = limits.cutsSeen;
    if (this.rules.action !== "penalty") return;
    this.emit("penalty", {
      driverGuid,
      reason: `${limits.cutsSeen} vueltas invalidadas por salirse de pista`,
    });
  }

  private checkMismatch(driverGuid: string, limits: DriverLimits, lap: number): void {
    if (!this.hasClient(driverGuid)) return;
    const gap = limits.cutsSeen - limits.excursionsSeen;
    if (gap - limits.mismatchReportedAt < MISMATCH_GAP) return;
    limits.mismatchReportedAt = gap;
    this.raise(driverGuid, {
      kind: "telemetry-mismatch",
      lap,
      splinePosition: 0,
      detail: `El servidor contó ${limits.cutsSeen} cortes y la app del piloto reportó ${limits.excursionsSeen} salidas`,
    });
  }

  private raise(driverGuid: string, args: Omit<TrackLimitsIncident, "carId" | "driverGuid" | "driverName">): void {
    const carId = this.stateTracker.findCarIdByGuid(driverGuid);
    const car = carId === undefined ? undefined : this.stateTracker.get(carId);
    this.emit("incident", {
      ...args,
      carId: carId ?? -1,
      driverGuid,
      driverName: car?.driverName || "Piloto desconocido",
    } satisfies TrackLimitsIncident);
  }

  /**
   * Los contadores son por sesión: las salidas de la clasificación no se arrastran a la carrera.
   *
   * Y solo por sesión — una desconexión NO los borra. Están indexados por `driverGuid` y no por
   * `carId` para eso mismo: si se limpiaran al desconectarse, salir y volver a entrar sería una
   * forma de borrar el contador de límites de pista.
   */
  resetSession(): void {
    this.byGuid.clear();
  }

  private getOrCreate(driverGuid: string): DriverLimits {
    let limits = this.byGuid.get(driverGuid);
    if (!limits) {
      limits = emptyLimits();
      this.byGuid.set(driverGuid, limits);
    }
    return limits;
  }
}

function sanitizeExcursion(raw: unknown): Excursion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const maxTyresOut = intIn(body.maxTyresOut, 1, 4);
  const durationMs = intIn(body.durationMs, 0, 600_000);
  if (maxTyresOut === null || durationMs === null) return null;
  return {
    maxTyresOut,
    durationMs,
    splinePosition: numberIn(body.splinePosition, 0, 1) ?? 0,
    lap: intIn(body.lap, 0, 9999) ?? 0,
    sector: intIn(body.sector, 0, 9) ?? 0,
  };
}

function numberIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

function intIn(value: unknown, min: number, max: number): number | null {
  const n = numberIn(value, min, max);
  return n === null ? null : Math.round(n);
}

function formatLap(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds - minutes * 60).toFixed(3).padStart(6, "0");
  return `${minutes}:${seconds}`;
}
