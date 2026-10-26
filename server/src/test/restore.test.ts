import { strict as assert } from "assert";
import { test } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { restoreState } from "../log/restore";
import { PenaltyEngine } from "../penalty/penaltyEngine";
import { IncidentEngine } from "../incident/incidentEngine";
import { defaultInfractions } from "../incident/catalog";
import { StateTracker } from "../state/stateTracker";
import { parseConfig } from "../config";

/** Reglas por defecto, frescas en cada test: los motores guardan la referencia y la mutan. */
const defaultPenaltyRules = () => parseConfig({}).pit.penalty;

/** Cada test se lleva su propia carpeta: el restaurador lee el directorio entero y un journal de
 * otro test lo contaminaría. */
function tempLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-restore-"));
}

function penaltyLine(id: string, engine: string, over: Record<string, unknown> = {}, tWall = "2026-10-22T18:00:00.000Z") {
  return JSON.stringify({
    type: "penalty.state",
    tWall,
    engine,
    penalty: {
      id,
      carId: 3,
      driverGuid: "76561198000000001",
      reason: "Pit lane: superó 80 km/h",
      type: "DT",
      status: "servingWindow",
      graceLapsRemaining: 2,
      createdAt: 1000,
      ...over,
    },
  });
}

function incidentLine(id: string, over: Record<string, unknown> = {}, tWall = "2026-10-22T18:00:00.000Z") {
  return JSON.stringify({
    type: "incident.state",
    tWall,
    incident: {
      id,
      kind: "carContact",
      classification: "rear-end",
      parties: [{ carId: 1, driverGuid: "a", driverName: "Fulano" }],
      impactKmh: 95,
      status: "pending",
      createdAt: 2000,
      lap: 3,
      ...over,
    },
  });
}

function writeJournal(dir: string, name: string, lines: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

test("sin journal previo no hay nada que restaurar", () => {
  assert.equal(restoreState(tempLogDir()), null);
});

test("una carpeta de logs que no existe no tumba el arranque", () => {
  assert.equal(restoreState(path.join(os.tmpdir(), "rc-no-existe-" + Date.now())), null);
});

test("restaura sanciones e incidentes separados por motor", () => {
  const dir = tempLogDir();
  writeJournal(dir, "events-2026-10-22T17-00-00.jsonl", [
    penaltyLine("p1", "formation"),
    penaltyLine("p2", "pit"),
    incidentLine("i1"),
  ]);

  const restored = restoreState(dir, { now: Date.parse("2026-10-22T18:05:00.000Z") });
  assert.ok(restored);
  assert.equal(restored.penalties.get("formation")?.length, 1);
  assert.equal(restored.penalties.get("pit")?.length, 1);
  assert.equal(restored.incidents.length, 1);
  assert.equal(restored.incidents[0].id, "i1");
});

test("de cada objeto queda la última versión escrita, no la primera", () => {
  const dir = tempLogDir();
  writeJournal(dir, "events-2026-10-22T17-00-00.jsonl", [
    penaltyLine("p1", "pit", { graceLapsRemaining: 2 }),
    penaltyLine("p1", "pit", { graceLapsRemaining: 1 }),
    penaltyLine("p1", "pit", { status: "served", graceLapsRemaining: 0 }),
  ]);

  const restored = restoreState(dir, { now: Date.parse("2026-10-22T18:05:00.000Z") });
  const list = restored?.penalties.get("pit") || [];
  assert.equal(list.length, 1, "una sanción reescrita tres veces sigue siendo una sanción");
  assert.equal(list[0].status, "served");
});

/**
 * Una anulación tiene que sobrevivir a un reinicio.
 *
 * Es el modo de falla más desagradable de los que podía tener esta función: si `isPenalty` no
 * aceptara `revoked`, la línea de la anulación se descartaría y la última válida sería la de antes
 * de anularla. El worker reinicia, la sanción resucita, y al piloto le vuelven a descontar vueltas
 * de gracia por algo que el comisario ya le había sacado — sin ningún error en ningún lado.
 */
test("una sanción anulada se restaura anulada y no resucita", () => {
  const dir = tempLogDir();
  writeJournal(dir, "events-2026-10-22T17-00-00.jsonl", [
    penaltyLine("p1", "steward", { graceLapsRemaining: 2 }),
    penaltyLine("p1", "steward", { status: "revoked", revokedFrom: "servingWindow", graceLapsRemaining: 0 }),
  ]);

  const list = restoreState(dir, { now: Date.parse("2026-10-22T18:05:00.000Z") })?.penalties.get("steward") || [];
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "revoked");

  // Y una vez en el motor, sigue sin contar como pendiente.
  const engine = new PenaltyEngine(defaultPenaltyRules());
  engine.restore(list);
  assert.equal(engine.getPending(3).length, 0);
  assert.equal(engine.getAll().length, 1, "sigue visible para el informe");
});

test("un cambio de sesión borra todo lo anterior", () => {
  const dir = tempLogDir();
  writeJournal(dir, "events-2026-10-22T17-00-00.jsonl", [
    penaltyLine("p1", "formation"),
    incidentLine("i1"),
    JSON.stringify({ type: "ac.newSession", tWall: "2026-10-22T18:00:01.000Z", name: "Carrera" }),
    penaltyLine("p9", "pit"),
  ]);

  const restored = restoreState(dir, { now: Date.parse("2026-10-22T18:05:00.000Z") });
  assert.ok(restored);
  assert.equal(restored.incidents.length, 0, "las sanciones de la quali no se arrastran a la carrera");
  assert.equal(restored.penalties.get("formation"), undefined);
  assert.equal(restored.penalties.get("pit")?.[0].id, "p9");
});

test("una carrera de ayer no se restaura", () => {
  const dir = tempLogDir();
  writeJournal(dir, "events-2026-10-21T17-00-00.jsonl", [penaltyLine("p1", "pit", {}, "2026-10-21T18:00:00.000Z")]);

  assert.equal(restoreState(dir, { now: Date.parse("2026-10-22T18:00:00.000Z") }), null);
});

test("una línea cortada a la mitad no invalida el resto", () => {
  const dir = tempLogDir();
  const file = path.join(dir, "events-2026-10-22T17-00-00.jsonl");
  // Exactamente lo que deja un cierre abrupto: la última línea queda sin terminar.
  fs.writeFileSync(file, penaltyLine("p1", "pit") + '\n{"type":"penalty.sta', "utf-8");

  const restored = restoreState(dir, { now: Date.parse("2026-10-22T18:05:00.000Z") });
  assert.equal(restored?.penalties.get("pit")?.length, 1);
});

test("un objeto sin id o con estado inventado se descarta", () => {
  const dir = tempLogDir();
  writeJournal(dir, "events-2026-10-22T17-00-00.jsonl", [
    JSON.stringify({ type: "penalty.state", tWall: "2026-10-22T18:00:00.000Z", engine: "pit", penalty: { carId: 1 } }),
    penaltyLine("p-ok", "pit", { status: "inventado" }),
    penaltyLine("p-bien", "pit"),
  ]);

  const restored = restoreState(dir, { now: Date.parse("2026-10-22T18:05:00.000Z") });
  assert.equal(restored?.penalties.get("pit")?.length, 1);
  assert.equal(restored?.penalties.get("pit")?.[0].id, "p-bien");
});

test("se lee el journal anterior, no el que acaba de abrir este arranque", () => {
  const dir = tempLogDir();
  writeJournal(dir, "events-2026-10-22T17-00-00.jsonl", [penaltyLine("p-viejo", "pit")]);
  const actual = writeJournal(dir, "events-2026-10-22T18-10-00.jsonl", []);

  const restored = restoreState(dir, { excludeFile: actual, now: Date.parse("2026-10-22T18:11:00.000Z") });
  assert.equal(restored?.penalties.get("pit")?.[0].id, "p-viejo");
  assert.equal(restored?.sourceFile, path.join(dir, "events-2026-10-22T17-00-00.jsonl"));
});

test("las líneas de auditoría viejas, sin estado, no alcanzan para restaurar", () => {
  const dir = tempLogDir();
  writeJournal(dir, "events-2026-10-22T17-00-00.jsonl", [
    JSON.stringify({ type: "penalty.issued", tWall: "2026-10-22T18:00:00.000Z", carId: 3, reason: "Pit lane" }),
  ]);

  assert.equal(restoreState(dir, { now: Date.parse("2026-10-22T18:05:00.000Z") }), null);
});

test("restaurar en el motor no vuelve a emitir eventos", () => {
  // Esto es lo que evita que el piloto reciba el mensaje de chat dos veces y que un BALLAST se
  // aplique por duplicado al reiniciar el backend.
  const engine = new PenaltyEngine(defaultPenaltyRules());
  let emitted = 0;
  engine.on("penalty-issued", () => emitted++);
  engine.on("penalty-escalated", () => emitted++);
  engine.on("penalty-served", () => emitted++);

  engine.restore([
    {
      id: "p1",
      carId: 3,
      driverGuid: "76561198000000001",
      reason: "Pit lane",
      type: "DT",
      status: "servingWindow",
      graceLapsRemaining: 2,
      createdAt: 1000,
    },
  ]);

  assert.equal(emitted, 0);
  assert.equal(engine.getAll().length, 1);
});

test("una sanción restaurada sigue escalando desde donde quedó", () => {
  const engine = new PenaltyEngine({ ...defaultPenaltyRules(), graceLaps: 3, escalation: "DQ" });
  engine.restore([
    {
      id: "p1",
      carId: 3,
      driverGuid: "76561198000000001",
      reason: "Pit lane",
      type: "DT",
      status: "servingWindow",
      graceLapsRemaining: 1,
      createdAt: 1000,
    },
  ]);

  const escalated: unknown[] = [];
  engine.on("penalty-escalated", (p) => escalated.push(p));
  engine.onLapCompleted(3);

  assert.equal(escalated.length, 1, "le quedaba una vuelta: la siguiente tiene que escalar");
  assert.equal(engine.getAll()[0].status, "escalated");
});

test("los ids nuevos no chocan con los restaurados", () => {
  const engine = new PenaltyEngine(defaultPenaltyRules());
  engine.restore([
    {
      id: "p-500",
      carId: 3,
      driverGuid: "g",
      reason: "r",
      type: "DT",
      status: "servingWindow",
      graceLapsRemaining: 2,
      createdAt: 1000,
    },
  ]);

  const fresh = engine.issuePenalty(4, "otro", "Pit lane");
  assert.notEqual(fresh.id, "p-500");
  assert.equal(engine.getAll().filter((p) => p.id === fresh.id).length, 1);
});

test("los incidentes restaurados conservan el orden de llegada", () => {
  const engine = new IncidentEngine(new StateTracker(), defaultInfractions(), () => "race");
  engine.restore([
    { id: "i2", kind: "carContact", parties: [], status: "pending", createdAt: 2000 } as never,
    { id: "i1", kind: "carContact", parties: [], status: "pending", createdAt: 1000 } as never,
  ]);

  // getAll() devuelve el más nuevo primero: si el orden interno fuera el del arreglo recibido,
  // i1 (más viejo) quedaría arriba.
  const ids = engine.getAll().map((i) => i.id);
  assert.deepEqual(ids, ["i2", "i1"]);
});
