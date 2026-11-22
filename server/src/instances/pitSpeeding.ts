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
  private dtStoppedSince = new Map<number, number>();
  private stoppedInPass = new Set<number>();

  /** Tiempo detenido (≤ 2 km/h) a partir del cual un pasaje por boxes deja de ser un
   * Drive-Through y pasa a ser una parada. Corto a propósito: un auto que se frena un instante
   * por tráfico en la calle no debería perder el DT, uno que se queda en el box sí. */
  private static readonly DT_STOP_MS = 3000;

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
    private clock: Clock = systemClock,
    /**
     * Si el piloto está en el pit lane según SU juego (`inPitLane` de la telemetría de la app), o
     * `null` si no hay dato fresco. Con dato, manda sobre la zona de spline.
     *
     * Hasta la 1.44 el cumplimiento se medía solo con la zona de spline (`config.pit.zone`), que
     * por defecto es una sola para todas las pistas (0.97–0.995). Si no coincide con el pit lane
     * real —y casi nunca coincide sin calibrar— el piloto pasaba por boxes, el auto nunca figuraba
     * "dentro de la zona" y el Drive-Through quedaba pendiente para siempre, aparte de seguir
     * figurando en "RC mensajes". Lo sabe el juego; no hay por qué deducirlo.
     */
    private getInPitLane: (driverGuid: string) => boolean | null = () => null
  ) {
    this.stateTracker.on("update", (car: CarState) => this.handleUpdate(car));
  }

  /** Margen sobre el límite: el CAR_UPDATE llega a pocos Hz y el auto todavía viene frenando al
   * cruzar la línea de entrada, así que la muestra más alta puede ser de antes del limitador. */
  private static readonly SPEED_MARGIN_KMH = 5;

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

    const fromGame = car.driverGuid ? this.getInPitLane(car.driverGuid) : null;
    const currentlyInZone = fromGame ?? inZone(car, this.zone);

    if (currentlyInZone) {
      this.sawInZone.add(car.carId);
      const prevMax = this.maxSpeedInPass.get(car.carId) ?? 0;
      this.maxSpeedInPass.set(car.carId, Math.max(prevMax, car.speedKmh));

      this.trackStopInPass(car);

      for (const { penalty, engine } of pending) {
        if (penalty.type === "SG") {
          this.checkStopAndGo(car, penalty, engine);
        }
      }
    } else if (this.sawInZone.has(car.carId)) {
      // Acaba de salir de pit lane: evaluar si el pasaje cumplió el Drive-Through.
      // Un Drive-Through es pasar SIN detenerse: si el auto se quedó parado más de
      // DT_STOP_MS fue una parada en boxes (el piloto entró a lo suyo) y no cumple nada.
      const maxSpeed = this.maxSpeedInPass.get(car.carId) ?? 0;
      const seDetuvo = this.stoppedInPass.has(car.carId);
      for (const { penalty, engine } of pending) {
        if (
          penalty.type === "DT" &&
          !seDetuvo &&
          maxSpeed > 0 &&
          maxSpeed <= this.legalPitSpeedKmh + PitComplianceTracker.SPEED_MARGIN_KMH
        ) {
          engine.markServed(penalty.id);
        }
      }
      this.sawInZone.delete(car.carId);
      this.maxSpeedInPass.delete(car.carId);
      this.stoppedSinceMs.delete(car.carId);
      this.dtStoppedSince.delete(car.carId);
      this.stoppedInPass.delete(car.carId);
    }
  }

  /** Marca el pasaje como "con parada" si el auto estuvo detenido DT_STOP_MS seguidos. */
  private trackStopInPass(car: CarState): void {
    if (car.speedKmh > 2) {
      this.dtStoppedSince.delete(car.carId);
      return;
    }
    const now = this.clock.now();
    const since = this.dtStoppedSince.get(car.carId) ?? now;
    this.dtStoppedSince.set(car.carId, since);
    if (now - since >= PitComplianceTracker.DT_STOP_MS) this.stoppedInPass.add(car.carId);
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
