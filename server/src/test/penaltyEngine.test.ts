import { strict as assert } from "assert";
import { test } from "node:test";
import { Penalty, PenaltyEngine, PenaltyRules } from "../penalty/penaltyEngine";

/**
 * El motor de sanciones, y sobre todo lo que hasta la 0.5 no existía: anular.
 *
 * El panel tenía un botón de kick con doble confirmación y uno de "Sancionar" sin ninguna, al lado
 * de un desplegable que viene con un piloto ya elegido. Un click de más sancionaba a quien no era,
 * le avisaba por chat y lo dejaba escrito en el informe de la carrera, sin ninguna forma de
 * deshacerlo. Esto cubre el camino de vuelta.
 */

function motor(over: Partial<PenaltyRules> = {}): PenaltyEngine {
  return new PenaltyEngine({
    speedThresholdKmh: 80,
    toleranceSeconds: 2,
    graceLaps: 3,
    penaltyType: "DT",
    escalation: "DQ",
    timePenaltySeconds: 5,
    ...over,
  });
}

test("anular saca la sanción de las pendientes del piloto", () => {
  const engine = motor();
  const p = engine.issuePenalty(7, "guid-7", "Adelantamiento bajo bandera amarilla");
  assert.equal(engine.getPending(7).length, 1);

  const anulada = engine.revoke(p.id);
  assert.equal(anulada?.status, "revoked");
  assert.equal(engine.getPending(7).length, 0);
});

/**
 * La sanción de tiempo nace `served` en el mismo instante en que se emite —no hay nada que cumplir
 * en pista— y es la que más aplica un comisario. Si anular solo valiera para las pendientes,
 * justamente la que hace falta corregir sería la única que no se podría.
 */
test("una sanción de tiempo, que nace cumplida, también se puede anular", () => {
  const engine = motor();
  const p = engine.issuePenalty(3, "guid-3", "Toque en la curva 1", "TIME", { timePenaltySeconds: 10 });
  assert.equal(p.status, "served");

  assert.equal(engine.revoke(p.id)?.status, "revoked");
  assert.equal(engine.revoke(p.id), null, "el segundo click no vuelve a anular");
});

test("anular no borra: la sanción sigue en la tabla con de dónde venía", () => {
  // Una anulación es un comisario corrigiéndose en público. Si la fila desapareciera, el piloto
  // sancionado por error no tendría cómo comprobar que la corrección existió.
  const engine = motor();
  const p = engine.issuePenalty(4, "guid-4", "Motivo cualquiera");
  engine.revoke(p.id);

  const todas = engine.getAll();
  assert.equal(todas.length, 1);
  assert.equal(todas[0].status, "revoked");
  assert.equal(todas[0].revokedFrom, "servingWindow");
  assert.ok(typeof todas[0].revokedAt === "number");
});

test("anular avisa, para que el aviso le llegue al piloto por el mismo canal que la sanción", () => {
  const engine = motor();
  const avisos: Penalty[] = [];
  engine.on("penalty-revoked", (p: Penalty) => avisos.push(p));

  const p = engine.issuePenalty(5, "guid-5", "Velocidad en pit lane");
  engine.revoke(p.id);

  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].id, p.id);
});

test("un id que no existe no se anula ni rompe", () => {
  assert.equal(motor().revoke("P999"), null);
});

/**
 * El caso que justifica todo el estado terminal aparte.
 *
 * Sin `revoked`, lo más barato hubiera sido marcarla `served` y listo. Pero una DT anulada que
 * queda "cumplida" sigue descontando vueltas de gracia si alguien vuelve a tocarla, y además le
 * miente al informe: dice que el piloto entró a boxes cuando nunca entró.
 */
test("una sanción anulada deja de descontar vueltas de gracia y no escala nunca", () => {
  const engine = motor({ graceLaps: 2 });
  const escaladas: Penalty[] = [];
  engine.on("penalty-escalated", (p: Penalty) => escaladas.push(p));

  const p = engine.issuePenalty(9, "guid-9", "Drive-Through pendiente");
  engine.revoke(p.id);

  engine.onLapCompleted(9);
  engine.onLapCompleted(9);
  engine.onLapCompleted(9);

  assert.equal(escaladas.length, 0);
  assert.equal(engine.getAll()[0].status, "revoked");
});

test("anular una escalada deja constancia de que llegó a escalar", () => {
  // El kick ya se ejecutó: el piloto está afuera del servidor y eso no se deshace. Lo que sí se
  // puede es corregir el registro, y el informe tiene que poder decir qué pasó antes.
  const engine = motor({ graceLaps: 1 });
  const p = engine.issuePenalty(2, "guid-2", "Largada adelantada");
  engine.onLapCompleted(2);
  assert.equal(engine.getAll()[0].status, "escalated");

  const anulada = engine.revoke(p.id);
  assert.equal(anulada?.status, "revoked");
  assert.equal(anulada?.revokedFrom, "escalated");
  assert.equal(anulada?.escalatedTo, "DQ", "lo que llegó a pasar no se borra");
});
