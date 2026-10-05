import { EventEmitter } from "events";
import { PenaltyEngine, Penalty } from "../penalty/penaltyEngine";
import { CarState, StateTracker } from "../state/stateTracker";
import { SpeedViolation, SpeedWatcher } from "../state/speedWatcher";

export interface PitZone {
  /** normalizedSplinePosition (0..1) donde arranca y termina pit lane en esta pista. */
  splineStart: number;
  splineEnd: number;
}

function inZone(car: CarState, zone: PitZone): boolean {
  return car.normalizedSplinePosition >= zone.splineStart && car.normalizedSplinePosition <= zone.splineEnd;
}

/**
 * Instancia 2 (parte 1): exceso de velocidad en pit lane durante la carrera.
 * Reusa el mismo SpeedWatcher que la largada, pero continuo durante toda la sesión
 * y acotado a la zona de pit lane en vez de a la ventana de formación.
 */
export class PitSpeedMonitor extends EventEmitter {
  private watcher: SpeedWatcher;

  constructor(stateTracker: StateTracker, thresholdKmh: number, toleranceSeconds: number, zone: PitZone, private penaltyEngine: PenaltyEngine) {
    super();
    this.watcher = new SpeedWatcher(stateTracker, {
      thresholdKmh,
      toleranceSeconds,
      isInZone: (car) => inZone(car, zone),
    });
    this.watcher.on("violation", (v: SpeedViolation) => this.handleViolation(v));
  }

  start(): void {
    this.watcher.arm();
  }

  stop(): void {
    this.watcher.disarm();
  }

  private handleViolation(violation: SpeedViolation): void {
    const rules = this.penaltyEngine.getRules();
    const penalty = this.penaltyEngine.issuePenalty(
      violation.carId,
      `Pit lane: superó ${rules.speedThresholdKmh} km/h por más de ${rules.toleranceSeconds}s (máx ${violation.maxSpeedKmh.toFixed(1)} km/h)`
    );
    this.emit("violation", { violation, penalty });
  }
}

/**
 * Instancia 2 (parte 2): detección de cumplimiento del DT/SG, estilo Real Penalty.
 *
 * Simplificación v1: no tenemos la geometría exacta del box propio de cada auto por circuito,
 * solo la zona general de pit lane. Por eso no distingue "paró en su propio box" de "paró en
 * pit lane" — una vez validado el resto, conviene sumar esa geometría por pista (ver shared/tracks).
 */
export class PitComplianceTracker {
  private sawInZone = new Set<number>();
  private maxSpeedInPass = new Map<number, number>();
  private stoppedSinceMs = new Map<number, number>();

  constructor(
    private stateTracker: StateTracker,
    private penaltyEngine: PenaltyEngine,
    private zone: PitZone,
    private legalPitSpeedKmh: number,
    private stopGoSeconds: number
  ) {
    this.stateTracker.on("update", (car: CarState) => this.handleUpdate(car));
  }

  private handleUpdate(car: CarState): void {
    const pending = this.penaltyEngine.getPending(car.carId);
    if (pending.length === 0) return;

    const currentlyInZone = inZone(car, this.zone);

    if (currentlyInZone) {
      this.sawInZone.add(car.carId);
      const prevMax = this.maxSpeedInPass.get(car.carId) ?? 0;
      this.maxSpeedInPass.set(car.carId, Math.max(prevMax, car.speedKmh));

      for (const penalty of pending) {
        if (penalty.type === "SG") {
          this.checkStopAndGo(car, penalty);
        }
      }
    } else if (this.sawInZone.has(car.carId)) {
      // Acaba de salir de pit lane: evaluar si el pasaje cumplió el Drive-Through.
      const maxSpeed = this.maxSpeedInPass.get(car.carId) ?? 0;
      for (const penalty of pending) {
        if (penalty.type === "DT" && maxSpeed > 0 && maxSpeed <= this.legalPitSpeedKmh) {
          this.penaltyEngine.markServed(penalty.id);
        }
      }
      this.sawInZone.delete(car.carId);
      this.maxSpeedInPass.delete(car.carId);
      this.stoppedSinceMs.delete(car.carId);
    }
  }

  private checkStopAndGo(car: CarState, penalty: Penalty): void {
    const stopped = car.speedKmh <= 2;
    if (!stopped) {
      this.stoppedSinceMs.delete(car.carId);
      return;
    }
    const now = Date.now();
    if (!this.stoppedSinceMs.has(car.carId)) {
      this.stoppedSinceMs.set(car.carId, now);
    }
    const since = this.stoppedSinceMs.get(car.carId)!;
    if ((now - since) / 1000 >= this.stopGoSeconds) {
      this.penaltyEngine.markServed(penalty.id);
    }
  }
}
