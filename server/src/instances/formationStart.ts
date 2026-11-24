import { EventEmitter } from "events";
import { AcUdpClient } from "../udp/client";
import { PenaltyEngine } from "../penalty/penaltyEngine";
import { SpeedWatcher, SpeedViolation } from "../state/speedWatcher";

export type LightState = "idle" | "formation" | "green" | "vsc" | "vscEnding";

/**
 * Lo que necesita el Virtual Safety Car (1.48). Opcional en el constructor para que los tests y
 * el simulador que solo arman la largada no tengan que conocerlo: sin esto, `deployVsc` no hace
 * nada.
 */
export interface VscDeps {
  speedWatcher: SpeedWatcher;
  penaltyEngine: PenaltyEngine;
  /** Cuánto dura el "VSC ENDING" antes del verde automático. Función y no número: el admin lo
   * puede cambiar en la pestaña VSC con la carrera andando. */
  getEndingSeconds: () => number;
}

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
  private vscTimer: NodeJS.Timeout | null = null;
  private vscEndsAt: number | null = null;

  constructor(
    private udpClient: AcUdpClient,
    private speedWatcher: SpeedWatcher,
    private penaltyEngine: PenaltyEngine,
    private vsc?: VscDeps
  ) {
    super();
    this.speedWatcher.on("violation", (v: SpeedViolation) => this.handleViolation(v));
    this.vsc?.speedWatcher.on("violation", (v: SpeedViolation) => this.handleVscViolation(v));
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
    this.darVerde();
  }

  /**
   * El verde, venga de la largada o del final del VSC. Es UNO solo a propósito: el chat, el
   * `green` del semáforo y por lo tanto el "green green green" de la app del piloto son los
   * mismos, así que un VSC que termina suena y se ve exactamente como una largada.
   */
  private darVerde(): void {
    this.lightState = "green";
    this.udpClient.broadcastChat(">>> VERDE VERDE VERDE <<<");
    this.emit("stateChanged", this.lightState);
    this.emit("green");
  }

  /**
   * Virtual Safety Car. Solo con la carrera en curso (`green`): en la formación ya hay límite de
   * velocidad, y antes de la largada no hay nada que neutralizar.
   *
   * No toca la fase de la carrera: sigue siendo `race`, así que el pit lane sigue controlado y
   * las sanciones pendientes siguen corriendo — un VSC no es una carrera nueva.
   */
  deployVsc(): boolean {
    if (!this.vsc || this.lightState !== "green") return false;
    this.lightState = "vsc";
    this.vsc.speedWatcher.arm();
    this.udpClient.broadcastChat(
      `>>> VIRTUAL SAFETY CAR - LIMITE ${this.vsc.penaltyEngine.getRules().speedThresholdKmh} KM/H <<<`
    );
    this.emit("stateChanged", this.lightState);
    return true;
  }

  /**
   * Fin del VSC: "VSC ENDING" durante `endingSeconds` y después el verde, solo. El control de
   * velocidad se corta ACÁ y no con el verde: el VSC ENDING existe justamente para que los pilotos
   * se preparen a acelerar, y sancionar a quien lo hace un segundo antes del verde sería castigar
   * lo que el aviso invita a hacer.
   */
  endVsc(): boolean {
    if (!this.vsc || this.lightState !== "vsc") return false;
    this.vsc.speedWatcher.disarm();
    const segundos = this.vsc.getEndingSeconds();
    this.lightState = "vscEnding";
    this.vscEndsAt = Date.now() + segundos * 1000;
    this.udpClient.broadcastChat(`>>> VSC ENDING - VERDE EN ${segundos} SEGUNDOS <<<`);
    this.emit("stateChanged", this.lightState);
    this.vscTimer = setTimeout(() => {
      this.vscTimer = null;
      this.vscEndsAt = null;
      if (this.lightState === "vscEnding") this.darVerde();
    }, segundos * 1000);
    this.vscTimer.unref?.();
    return true;
  }

  /** El botón del panel es uno solo: despliega o termina según el estado. */
  toggleVsc(): boolean {
    if (this.lightState === "green") return this.deployVsc();
    if (this.lightState === "vsc") return this.endVsc();
    return false;
  }

  /** Segundos que faltan para el verde durante el VSC ENDING; `null` fuera de él. */
  getVscSecondsLeft(): number | null {
    if (this.lightState !== "vscEnding" || this.vscEndsAt === null) return null;
    return Math.max(0, Math.ceil((this.vscEndsAt - Date.now()) / 1000));
  }

  private cancelarVsc(): void {
    if (this.vscTimer) clearTimeout(this.vscTimer);
    this.vscTimer = null;
    this.vscEndsAt = null;
    this.vsc?.speedWatcher.disarm();
  }

  reset(): void {
    this.speedWatcher.disarm();
    this.cancelarVsc();
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

  private handleVscViolation(violation: SpeedViolation): void {
    if (!this.vsc) return;
    const rules = this.vsc.penaltyEngine.getRules();
    const penalty = this.vsc.penaltyEngine.issuePenalty(
      violation.carId,
      violation.car.driverGuid,
      `VSC: superó ${rules.speedThresholdKmh} km/h por más de ${rules.toleranceSeconds}s (máx ${violation.maxSpeedKmh.toFixed(1)} km/h)`
    );
    this.emit("vscViolation", { violation, penalty });
  }
}
