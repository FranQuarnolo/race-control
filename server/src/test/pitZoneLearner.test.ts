import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import { PitZoneLearner } from "../track/pitZoneLearner";

function carpetaTemporal(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-pitzone-"));
}

test("sin ninguna muestra, no hay sugerencia", () => {
  const learner = new PitZoneLearner(carpetaTemporal());
  assert.equal(learner.suggestionFor("spa"), null);
});

test("aprende el rango observado, con margen a los dos lados", () => {
  const learner = new PitZoneLearner(carpetaTemporal());
  for (const s of [0.97, 0.975, 0.98, 0.972]) learner.observe("spa", s);

  const sugerencia = learner.suggestionFor("spa");
  assert.ok(sugerencia);
  assert.ok(sugerencia!.splineStart < 0.97, "el margen tiene que dejar el inicio antes de lo observado");
  assert.ok(sugerencia!.splineEnd > 0.98, "el margen tiene que dejar el final después de lo observado");
});

test("un circuito no afecta la sugerencia de otro", () => {
  const learner = new PitZoneLearner(carpetaTemporal());
  learner.observe("spa", 0.97);
  learner.observe("monza", 0.5);
  assert.equal(learner.suggestionFor("imola"), null);
  assert.notDeepEqual(learner.suggestionFor("spa"), learner.suggestionFor("monza"));
});

test("un pit lane que cruza la línea de meta se descarta, no se sugiere a medias", () => {
  const learner = new PitZoneLearner(carpetaTemporal());
  // Entrada cerca del final de la vuelta, salida cerca del principio: un wraparound real.
  learner.observe("nordschleife", 0.98);
  learner.observe("nordschleife", 0.02);
  assert.equal(learner.suggestionFor("nordschleife"), null, "un rango de más de la mitad de la vuelta no es un pit lane");
});

test("lo aprendido sobrevive a una instancia nueva (persiste por liga)", () => {
  const dir = carpetaTemporal();
  const primera = new PitZoneLearner(dir);
  primera.observe("spa", 0.97);
  primera.observe("spa", 0.99);

  const segunda = new PitZoneLearner(dir);
  const sugerencia = segunda.suggestionFor("spa");
  assert.ok(sugerencia);
  assert.ok(sugerencia!.splineStart < 0.97 && sugerencia!.splineEnd > 0.99);
});

test("una muestra fuera de 0..1 se ignora en vez de ensuciar el aprendizaje", () => {
  const learner = new PitZoneLearner(carpetaTemporal());
  learner.observe("spa", 0.97);
  learner.observe("spa", 1.4); // telemetría rota de un cliente viejo
  const sugerencia = learner.suggestionFor("spa");
  assert.ok(sugerencia!.splineEnd < 1.4);
});
