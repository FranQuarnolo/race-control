import { EventEmitter } from "events";

export type PenaltyType = "DT" | "SG" | "BALLAST";
export type EscalationType = "DQ" | "TIME_PENALTY";
export type PenaltyStatus = "servingWindow" | "served" | "escalated";

export interface PenaltyRules {
  speedThresholdKmh: number;
  toleranceSeconds: number;
  /** Vueltas de gracia para cumplir el DT/SG antes de escalar (estilo Real Penalty). */
  graceLaps: number;
  penaltyType: PenaltyType;
  escalation: EscalationType;
  /** Solo si escalation === "TIME_PENALTY". */
  timePenaltySeconds?: number;
  /** Solo si penaltyType === "BALLAST". */
  ballastKg?: number;
}

export interface Penalty {
  id: string;
  carId: number;
  reason: string;
  type: PenaltyType;
  status: PenaltyStatus;
  graceLapsRemaining: number;
  createdAt: number;
  servedAt?: number;
  escalatedAt?: number;
  escalatedTo?: EscalationType;
}

let nextId = 1;

/**
 * Máquina de estados de sanción compartida por instancia 1 (largada) e instancia 2 (penalizaciones en carrera):
 * servingWindow -> served | escalated (DQ o penalización de tiempo) si se agotan las vueltas de gracia.
 */
export class PenaltyEngine extends EventEmitter {
  private penalties = new Map<string, Penalty>();

  constructor(private rules: PenaltyRules) {
    super();
  }

  updateRules(rules: Partial<PenaltyRules>): void {
    this.rules = { ...this.rules, ...rules };
  }

  getRules(): PenaltyRules {
    return this.rules;
  }

  issuePenalty(carId: number, reason: string, type: PenaltyType = this.rules.penaltyType): Penalty {
    const penalty: Penalty = {
      id: `P${nextId++}`,
      carId,
      reason,
      type,
      status: "servingWindow",
      graceLapsRemaining: type === "BALLAST" ? 0 : this.rules.graceLaps,
      createdAt: Date.now(),
    };
    this.penalties.set(penalty.id, penalty);
    this.emit("penalty-issued", penalty);

    if (type === "BALLAST") {
      // El ballast se aplica una sola vez, de inmediato — no hay "cumplimiento" que esperar.
      penalty.status = "served";
      penalty.servedAt = Date.now();
      this.emit("penalty-served", penalty);
    }
    return penalty;
  }

  /** Lo llama la detección de cumplimiento (instancia 2: cruce de pit lane a velocidad legal, o parada de N segundos). */
  markServed(penaltyId: string): void {
    const penalty = this.penalties.get(penaltyId);
    if (!penalty || penalty.status !== "servingWindow") return;
    penalty.status = "served";
    penalty.servedAt = Date.now();
    this.emit("penalty-served", penalty);
  }

  /** Se llama en cada ACSP_LAP_COMPLETED del auto correspondiente; descuenta las vueltas de gracia pendientes. */
  onLapCompleted(carId: number): void {
    for (const penalty of this.penalties.values()) {
      if (penalty.carId !== carId || penalty.status !== "servingWindow") continue;
      penalty.graceLapsRemaining -= 1;
      if (penalty.graceLapsRemaining <= 0) {
        penalty.status = "escalated";
        penalty.escalatedAt = Date.now();
        penalty.escalatedTo = this.rules.escalation;
        this.emit("penalty-escalated", penalty);
      }
    }
  }

  getPending(carId: number): Penalty[] {
    return Array.from(this.penalties.values()).filter((p) => p.carId === carId && p.status === "servingWindow");
  }

  getAll(): Penalty[] {
    return Array.from(this.penalties.values()).sort((a, b) => b.createdAt - a.createdAt);
  }
}
