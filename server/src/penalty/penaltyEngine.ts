import { EventEmitter } from "events";

/**
 * `TIME` no es una sanción que el piloto pueda cumplir en pista: se suma a su tiempo final. Por eso
 * no se ofrece como sanción automática de largada ni de pit lane —ahí el piloto tiene que poder
 * hacer algo al respecto— y solo la emite el comisario desde la bandeja de incidentes.
 */
export type PenaltyType = "DT" | "SG" | "BALLAST" | "TIME";
export type EscalationType = "DQ" | "TIME_PENALTY";
/**
 * `revoked` es un estado terminal aparte y no un borrado.
 *
 * Una sanción anulada tiene que seguir en la tabla y en el informe: lo que hace un comisario al
 * anular es corregirse en público, y si la fila desaparece el piloto sancionado por error no tiene
 * cómo comprobar que la corrección existió. Es, además, lo que distingue "me equivoqué" de "nunca
 * pasó nada".
 */
export type PenaltyStatus = "servingWindow" | "served" | "escalated" | "revoked";

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
  /** Identidad estable del piloto — una sanción sigue al piloto aunque se reconecte y le toque
   * otro carId (ver StateTracker.findCarIdByGuid). */
  driverGuid: string;
  reason: string;
  type: PenaltyType;
  status: PenaltyStatus;
  graceLapsRemaining: number;
  createdAt: number;
  servedAt?: number;
  escalatedAt?: number;
  escalatedTo?: EscalationType;
  /** Cuándo la anuló el comisario, y desde qué estado venía. El estado previo se guarda porque
   * anular una escalada a DQ no deshace el kick que ya se ejecutó: el informe tiene que poder
   * decir qué llegó a pasar antes de la corrección. */
  revokedAt?: number;
  revokedFrom?: PenaltyStatus;
  /** Solo en las de tipo `TIME`: los segundos que se le suman al resultado final. */
  timePenaltySeconds?: number;
  /** Solo en las que aplica el comisario a mano: de qué incidente de la bandeja salieron. */
  incidentId?: string;
}

let nextId = 1;

/**
 * Máquina de estados de sanción compartida por instancia 1 (largada) e instancia 2 (penalizaciones en carrera):
 * servingWindow -> served | escalated (DQ o penalización de tiempo) si se agotan las vueltas de gracia.
 *
 * `rules` se recibe por referencia (el mismo objeto anidado de AppConfig) para que los cambios
 * de configuración desde el panel se apliquen a las próximas sanciones sin reconstruir el motor.
 */
export class PenaltyEngine extends EventEmitter {
  private penalties = new Map<string, Penalty>();

  constructor(private rules: PenaltyRules) {
    super();
  }

  /** Actualiza las reglas EN EL MISMO objeto (no reemplaza la referencia) — necesario para que
   * quien ya tiene `rules` capturado (ej. un SpeedWatcher) vea el cambio sin reconstruirse. */
  updateRules(patch: Partial<PenaltyRules>): void {
    Object.assign(this.rules, patch);
  }

  getRules(): PenaltyRules {
    return this.rules;
  }

  issuePenalty(
    carId: number,
    driverGuid: string,
    reason: string,
    type: PenaltyType = this.rules.penaltyType,
    extra: { timePenaltySeconds?: number; incidentId?: string } = {}
  ): Penalty {
    // El lastre y la penalización de tiempo no tienen nada que cumplir en pista: uno se aplica al
    // auto de inmediato, la otra se suma al resultado final. Darles vueltas de gracia haría que
    // escalaran a DQ solas a las pocas vueltas.
    const immediate = type === "BALLAST" || type === "TIME";
    const penalty: Penalty = {
      id: `P${nextId++}`,
      carId,
      driverGuid,
      reason,
      type,
      status: "servingWindow",
      graceLapsRemaining: immediate ? 0 : this.rules.graceLaps,
      createdAt: Date.now(),
    };
    if (type === "TIME") {
      penalty.timePenaltySeconds = extra.timePenaltySeconds ?? this.rules.timePenaltySeconds ?? 5;
    }
    if (extra.incidentId) penalty.incidentId = extra.incidentId;
    this.penalties.set(penalty.id, penalty);
    this.emit("penalty-issued", penalty);

    if (immediate) {
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

  /**
   * Anula una sanción.
   *
   * Es la única operación del motor que existe porque un humano se equivocó, y por eso acepta
   * cualquier estado menos `revoked`: la sanción que más se aplica mal es la de tiempo, que nace
   * `served` en el mismo instante en que se emite. Si solo se pudieran anular las que están
   * pendientes de cumplirse, justo la que hace falta corregir sería la única que no se puede.
   *
   * Lo que anular **no** hace es deshacer lo que ya ocurrió en pista. Un DQ ya ejecutado es un
   * piloto que ya está afuera del servidor; el lastre sí se saca, porque el que lo saca es el
   * mismo comando que lo puso (ver `handlePenaltyRevoked` en `raceControl`). Devuelve `null` si el
   * id no existe o si ya estaba anulada, para que la API pueda distinguir el 404 del doble click.
   */
  revoke(penaltyId: string): Penalty | null {
    const penalty = this.penalties.get(penaltyId);
    if (!penalty || penalty.status === "revoked") return null;
    penalty.revokedFrom = penalty.status;
    penalty.status = "revoked";
    penalty.revokedAt = Date.now();
    // Sin esto, una sanción anulada con vueltas de gracia a medio descontar reaparecería como
    // "escalada" si alguna vez se la volviera a poner en `servingWindow`. Es barato y cierra la
    // puerta.
    penalty.graceLapsRemaining = 0;
    this.emit("penalty-revoked", penalty);
    return penalty;
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

  /**
   * Vuelve a cargar las sanciones de una carrera que se interrumpió por un reinicio del backend.
   *
   * No emite ningún evento, y esa es la decisión importante: reponer el estado no es volver a
   * sancionar. El piloto ya recibió su aviso por chat antes del reinicio, y re-emitir
   * `penalty-issued` le mandaría el mismo mensaje de nuevo —o peor, con BALLAST, le aplicaría el
   * lastre dos veces.
   */
  restore(penalties: Penalty[]): void {
    for (const penalty of penalties) {
      this.penalties.set(penalty.id, penalty);
      // El contador de ids es de módulo y lo comparten los dos motores: si no se adelanta, la
      // primera sanción nueva reusaría un id ya restaurado y pisaría la vieja.
      const n = Number(penalty.id.replace(/^P/, ""));
      if (Number.isInteger(n) && n >= nextId) nextId = n + 1;
    }
  }

  /**
   * Una sesión nueva borra las sanciones de la anterior.
   *
   * Sin esto, una sanción de la clasificación seguía viva en la carrera: el piloto arrancaba
   * debiendo un Drive-Through que nadie le había dado en esa carrera, y las vueltas de gracia se
   * descontaban hasta escalar a DQ. Es la misma regla que ya aplican el motor de incidentes y el
   * contador de límites de pista al recibir NEW_SESSION.
   */
  resetSession(): void {
    this.penalties.clear();
  }
}
