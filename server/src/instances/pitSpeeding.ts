import { EventEmitter } from "events";
import { PenaltyEngine, Penalty } from "../penalty/penaltyEngine";
import { CarState, StateTracker } from "../state/stateTracker";
import { SpeedViolation, SpeedWatcher } from "../state/speedWatcher";
import { Clock, systemClock } from "../util/clock";

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

  constructor(stateTracker: StateTracker, zone: PitZone, private penaltyEngine: PenaltyEngine) {
    super();
    // Las reglas se pasan por referencia (penaltyEngine.getRules()): si el admin cambia el
    // límite de velocidad de pit desde el panel, el watcher lo ve en la próxima muestra.
    this.watcher = new SpeedWatcher(stateTracker, this.penaltyEngine.getRules(), (car) => inZone(car, zone));
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
      violation.car.driverGuid,
      `Pit lane: superó ${rules.speedThresholdKmh} km/h por más de ${rules.toleranceSeconds}s (máx ${violation.maxSpeedKmh.toFixed(1)} km/h)`
    );
    this.emit("violation", { violation, penalty });
  }
}

/**
 * Instancia 2 (parte 2): detección de cumplimiento del DT/SG, estilo Real Penalty.
 *
 * Simplificación v1 (aceptada con el usuario): no tenemos la geometría exacta del box propio de
 * cada auto por circuito, solo la zona general de pit lane. Por eso no distingue "paró en su
 * propio box" de "paró en pit lane" — cualquier parada dentro de la zona cumple el Stop-and-Go.
 * Se puede sumar esa geometría por pista más adelante (ver shared/tracks).
 */
export class PitComplianceTracker {
  private sawInZone = new Set<number>();
  private maxSpeedInPass = new Map<number, number>();
  private stoppedSinceMs = new Map<number, number>();

  /**
   * Recibe TODOS los motores de sanción, no solo el de pit.
   *
   * Antes solo se le pasaba el motor de pit, así que `markServed()` nunca se llamaba para una
   * sanción de largada: con el default `penaltyType: "DT"`, un piloto sancionado en la formación
   * cumplía el Drive-Through correctamente y escalaba a DQ igual al agotar las vueltas de gracia.
   * El mensaje que recibía ("Tenés N vuelta(s) para cumplirla") era literalmente falso.
   *
   * El pit lane es físicamente uno solo: una sanción se cumple pasando por ahí, sin importar qué
   * motor la emitió.
   */
  constructor(
    private stateTracker: StateTracker,
    private penaltyEngines: PenaltyEngine[],
    private zone: PitZone,
    /** stopGoSeconds vive en config.pit (no en PenaltyRules) — se lee en vivo por función. */
    private getStopGoSeconds: () => number,
    /** Velocidad legal de pit lane. Se toma del motor de pit (única fuente de verdad), no del
     * motor que emitió la sanción: el límite del pit lane no cambia según por qué te sancionaron. */
    private getLegalPitSpeedKmh: () => number,
    private clock: Clock = systemClock
  ) {
    this.stateTracker.on("update", (car: CarState) => this.handleUpdate(car));
  }

  private get legalPitSpeedKmh(): number {
    return this.getLegalPitSpeedKmh();
  }

  /** Sanciones pendientes de este auto en cualquiera de los motores. */
  private pendingFor(carId: number): Array<{ penalty: Penalty; engine: PenaltyEngine }> {
    return this.penaltyEngines.flatMap((engine) =>
      engine.getPending(carId).map((penalty) => ({ penalty, engine }))
    );
  }

  private get stopGoMs(): number {
    return this.getStopGoSeconds() * 1000;
  }

  private handleUpdate(car: CarState): void {
    const pending = this.pendingFor(car.carId);
    if (pending.length === 0) return;

    const currentlyInZone = inZone(car, this.zone);

    if (currentlyInZone) {
      this.sawInZone.add(car.carId);
      const prevMax = this.maxSpeedInPass.get(car.carId) ?? 0;
      this.maxSpeedInPass.set(car.carId, Math.max(prevMax, car.speedKmh));

      for (const { penalty, engine } of pending) {
        if (penalty.type === "SG") {
          this.checkStopAndGo(car, penalty, engine);
        }
      }
    } else if (this.sawInZone.has(car.carId)) {
      // Acaba de salir de pit lane: evaluar si el pasaje cumplió el Drive-Through.
      const maxSpeed = this.maxSpeedInPass.get(car.carId) ?? 0;
      for (const { penalty, engine } of pending) {
        if (penalty.type === "DT" && maxSpeed > 0 && maxSpeed <= this.legalPitSpeedKmh) {
          engine.markServed(penalty.id);
        }
      }
      this.sawInZone.delete(car.carId);
      this.maxSpeedInPass.delete(car.carId);
      this.stoppedSinceMs.delete(car.carId);
    }
  }

  private checkStopAndGo(car: CarState, penalty: Penalty, engine: PenaltyEngine): void {
    const stopped = car.speedKmh <= 2;
    if (!stopped) {
      this.stoppedSinceMs.delete(car.carId);
      return;
    }
    const now = this.clock.now();
    if (!this.stoppedSinceMs.has(car.carId)) {
      this.stoppedSinceMs.set(car.carId, now);
    }
    const since = this.stoppedSinceMs.get(car.carId)!;
    if (now - since >= this.stopGoMs) {
      engine.markServed(penalty.id);
    }
  }
}
