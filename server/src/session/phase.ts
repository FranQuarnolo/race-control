import { EventEmitter } from "events";

export type SessionPhase = "idle" | "formation" | "race" | "finished";

/**
 * Fase explícita de la sesión. Existe para que el pit-speed monitor (instancia 2) solo se arme
 * durante la carrera — antes no debe sancionar a nadie por pasar por pit lane en la previa.
 */
export class SessionPhaseTracker extends EventEmitter {
  private phase: SessionPhase = "idle";

  get(): SessionPhase {
    return this.phase;
  }

  set(phase: SessionPhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.emit("phaseChanged", phase);
  }
}
