import { EventEmitter } from "events";
import { AcUdpClient } from "../udp/client";
import { PenaltyEngine } from "../penalty/penaltyEngine";
import { SpeedWatcher, SpeedViolation } from "../state/speedWatcher";

export type LightState = "idle" | "formation" | "green";

/**
 * Instancia 1: largada en movimiento.
 *
 * El timing exacto de "cuántos segundos dura la secuencia de semáforo" lo maneja el propio
 * juego (ROLLING_START/FORMATION_LAP nativos) — este backend no lo controla ni lo puede leer
 * con certeza desde el protocolo UDP. Por eso el flujo es de 2 botones desde el panel admin:
 * "Iniciar formación" (arma el monitoreo de velocidad) y "Verde" (lo apreta el admin en el
 * instante en que ve apagarse el semáforo en el juego — dispara el audio y corta el monitoreo).
 */
export class FormationStart extends EventEmitter {
  private lightState: LightState = "idle";

  constructor(private udpClient: AcUdpClient, private speedWatcher: SpeedWatcher, private penaltyEngine: PenaltyEngine) {
    super();
    this.speedWatcher.on("violation", (v: SpeedViolation) => this.handleViolation(v));
  }

  getLightState(): LightState {
    return this.lightState;
  }

  beginFormation(): void {
    if (this.lightState !== "idle") return;
    this.lightState = "formation";
    this.speedWatcher.arm();
    this.udpClient.broadcastChat(">>> FORMATION LAP - RESPETEN EL LIMITE DE VELOCIDAD <<<");
    this.emit("stateChanged", this.lightState);
  }

  triggerGreen(): void {
    if (this.lightState !== "formation") return;
    this.speedWatcher.disarm();
    this.lightState = "green";
    this.udpClient.broadcastChat(">>> VERDE VERDE VERDE <<<");
    this.emit("stateChanged", this.lightState);
    this.emit("green");
  }

  reset(): void {
    this.speedWatcher.disarm();
    this.lightState = "idle";
    this.emit("stateChanged", this.lightState);
  }

  private handleViolation(violation: SpeedViolation): void {
    const rules = this.penaltyEngine.getRules();
    const penalty = this.penaltyEngine.issuePenalty(
      violation.carId,
      violation.car.driverGuid,
      `Largada: superó ${rules.speedThresholdKmh} km/h por más de ${rules.toleranceSeconds}s en la formación (máx ${violation.maxSpeedKmh.toFixed(1)} km/h)`
    );
    this.emit("violation", { violation, penalty });
  }
}
