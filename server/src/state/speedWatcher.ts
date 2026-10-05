import { EventEmitter } from "events";
import { CarState, StateTracker } from "./stateTracker";

export interface SpeedWatcherConfig {
  /** Velocidad límite en km/h (la de pits, o la que fije el admin). */
  thresholdKmh: number;
  /** Segundos continuos por encima del umbral para que cuente como violación. */
  toleranceSeconds: number;
  /** Si se define, solo vigila mientras el auto está dentro de esta zona (ej. pit lane). Por defecto siempre activo. */
  isInZone?: (car: CarState) => boolean;
}

export interface SpeedViolation {
  carId: number;
  car: CarState;
  exceededSinceMs: number;
  maxSpeedKmh: number;
}

/**
 * Detecta violaciones de "más de X km/h durante más de N segundos seguidos".
 * Reutilizable tanto para la ventana de formación (instancia 1) como para pit lane en carrera (instancia 2).
 */
export class SpeedWatcher extends EventEmitter {
  private armed = false;
  private exceededSince = new Map<number, number>();
  private maxSpeedDuringViolation = new Map<number, number>();
  private alreadyFlagged = new Set<number>();
  private unsubscribe: (() => void) | null = null;

  constructor(private stateTracker: StateTracker, private config: SpeedWatcherConfig) {
    super();
  }

  arm(): void {
    this.armed = true;
    this.exceededSince.clear();
    this.maxSpeedDuringViolation.clear();
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
    if (this.config.isInZone && !this.config.isInZone(car)) {
      this.exceededSince.delete(car.carId);
      this.maxSpeedDuringViolation.delete(car.carId);
      this.alreadyFlagged.delete(car.carId);
      return;
    }
    const now = Date.now();

    if (car.speedKmh > this.config.thresholdKmh) {
      if (!this.exceededSince.has(car.carId)) {
        this.exceededSince.set(car.carId, now);
        this.maxSpeedDuringViolation.set(car.carId, car.speedKmh);
      } else {
        const prevMax = this.maxSpeedDuringViolation.get(car.carId) ?? 0;
        this.maxSpeedDuringViolation.set(car.carId, Math.max(prevMax, car.speedKmh));
      }

      const since = this.exceededSince.get(car.carId)!;
      const elapsedSeconds = (now - since) / 1000;
      if (elapsedSeconds >= this.config.toleranceSeconds && !this.alreadyFlagged.has(car.carId)) {
        this.alreadyFlagged.add(car.carId);
        const violation: SpeedViolation = {
          carId: car.carId,
          car,
          exceededSinceMs: since,
          maxSpeedKmh: this.maxSpeedDuringViolation.get(car.carId) ?? car.speedKmh,
        };
        this.emit("violation", violation);
      }
    } else {
      this.exceededSince.delete(car.carId);
      this.maxSpeedDuringViolation.delete(car.carId);
      this.alreadyFlagged.delete(car.carId);
    }
  }
}
