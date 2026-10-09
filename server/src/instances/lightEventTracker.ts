import { FormationStart, LightState } from "./formationStart";

export interface LightEvent {
  seq: number;
  type: LightState;
}

/** Traduce los cambios de estado del semáforo en una secuencia incremental — así el cliente
 * Python (que hace polling) puede notar "esto ya lo vi" vs. "esto es nuevo" sin guardar estado. */
export class LightEventTracker {
  private seq = 0;
  private last: LightEvent = { seq: 0, type: "idle" };

  constructor(formationStart: FormationStart) {
    formationStart.on("stateChanged", (type: LightState) => {
      this.seq += 1;
      this.last = { seq: this.seq, type };
    });
  }

  get(): LightEvent {
    return this.last;
  }
}
