import { EventEmitter } from "events";
import { PenaltyRules } from "../penalty/penaltyEngine";
import { CarState, StateTracker } from "./stateTracker";
import { Clock, systemClock } from "../util/clock";

export interface SpeedViolation {
  carId: number;
  car: CarState;
  exceededSinceMs: number;
  maxSpeedKmh: number;
}

/** Tiempo que la velocidad tiene que quedar por debajo del umbral, de forma continua, para
 * considerar cortada la racha de violación. Evita que un único paquete con un valor bajo
 * (ruido/jitter justo en el borde del umbral) resetee el cronómetro de 5s. */
const DROP_BELOW_DEBOUNCE_MS = 500;

/** Si entre dos muestras pasó más que esto, no se cuenta ese hueco como tiempo "en infracción" —
 * un paquete UDP perdido no debe sumar tiempo que no se pudo observar. */
const MAX_SAMPLE_GAP_MS = 1500;

interface Tracking {
  accumulatedMs: number;
  lastSampleAtMs: number;
  belowSinceMs: number | null;
  maxSpeedKmh: number;
}

/**
 * Detecta violaciones de "más de X km/h durante más de N segundos seguidos" usando tiempo
 * acumulado entre muestras consecutivas (no reloj de pared desde el inicio) — así un hueco de
 * telemetría no infla artificialmente la duración, y un dropout corto por debajo del umbral no
 * corta la racha de inmediato (debounce).
 *
 * Reutilizable tanto para la ventana de formación (instancia 1) como para pit lane en carrera
 * (instancia 2). `rules` se recibe por REFERENCIA (el mismo objeto que vive en AppConfig) para
 * que los cambios del panel admin se apliquen en vivo sin tener que reconstruir el watcher.
 */
export class SpeedWatcher extends EventEmitter {
  private armed = false;
  private tracking = new Map<number, Tracking>();
  private alreadyFlagged = new Set<number>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private stateTracker: StateTracker,
    private rules: PenaltyRules,
    private isInZone?: (car: CarState) => boolean,
    private clock: Clock = systemClock
  ) {
    super();
  }

  arm(): void {
    this.armed = true;
    this.tracking.clear();
    this.alreadyFlagged.clear();
    const handler = (car: CarState) => this.handleUpdate(car);
    this.stateTracker.on("update", handler);
    this.unsubscribe = () => this.stateTracker.off("update", handler);
  }

  disarm(): void {
    this.armed = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handleUpdate(car: CarState): void {
    if (!this.armed) return;
    if (this.isInZone && !this.isInZone(car)) {
      this.tracking.delete(car.carId);
      this.alreadyFlagged.delete(car.carId);
      return;
    }

    const now = this.clock.now();
    const threshold = this.rules.speedThresholdKmh;
    const toleranceMs = this.rules.toleranceSeconds * 1000;
    let state = this.tracking.get(car.carId);

    if (car.speedKmh > threshold) {
      if (!state) {
        state = { accumulatedMs: 0, lastSampleAtMs: now, belowSinceMs: null, maxSpeedKmh: car.speedKmh };
        this.tracking.set(car.carId, state);
      } else {
        const gap = now - state.lastSampleAtMs;
        if (gap <= MAX_SAMPLE_GAP_MS) state.accumulatedMs += gap;
        state.lastSampleAtMs = now;
        state.belowSinceMs = null;
        state.maxSpeedKmh = Math.max(state.maxSpeedKmh, car.speedKmh);
      }

      if (state.accumulatedMs >= toleranceMs && !this.alreadyFlagged.has(car.carId)) {
        this.alreadyFlagged.add(car.carId);
        const violation: SpeedViolation = {
          carId: car.carId,
          car,
          exceededSinceMs: Date.now() - state.accumulatedMs,
          maxSpeedKmh: state.maxSpeedKmh,
        };
        this.emit("violation", violation);
      }
    } else if (state) {
      if (state.belowSinceMs === null) {
        state.belowSinceMs = now;
      } else if (now - state.belowSinceMs >= DROP_BELOW_DEBOUNCE_MS) {
        this.tracking.delete(car.carId);
        this.alreadyFlagged.delete(car.carId);
      }
      // Todavía no pasó el debounce: se mantiene el estado tal cual, sin sumar ni cortar.
    }
  }
}
