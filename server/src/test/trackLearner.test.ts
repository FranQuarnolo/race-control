import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import { TrackLearner } from "../track/trackLearner";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-track-"));
}

/** Simula un auto dando `laps` vueltas a un óvalo, muestreando cada `stepS` de spline. */
function driveLaps(learner: TrackLearner, laps: number, stepS: number): void {
  for (let lap = 0; lap < laps; lap++) {
    for (let s = 0; s < 1; s += stepS) {
      const angle = s * Math.PI * 2;
      learner.onCarUpdate({ posX: Math.cos(angle) * 500, posZ: Math.sin(angle) * 300, normalizedSplinePosition: s });
    }
  }
}

test("el trazado se completa a medida que se corre y queda ordenado por posición de vuelta", () => {
  const learner = new TrackLearner(tmpDir());
  learner.setTrack("spa");
  driveLaps(learner, 1, 1 / 800);

  const outline = learner.getOutline();
  assert.ok(outline, "una vuelta completa debería alcanzar para dibujar");
  assert.ok(outline!.coverage > 0.95);
  // Ordenado por spline: es lo que permite unir los puntos sin que el dibujo se cruce solo.
  for (let i = 1; i < outline!.points.length; i++) {
    assert.ok(outline!.points[i].s > outline!.points[i - 1].s);
  }
  // El bounding box reproduce el óvalo, que es lo que usa el canvas para escalar.
  assert.ok(Math.abs(outline!.bounds.maxX - 500) < 10);
  assert.ok(Math.abs(outline!.bounds.minZ + 300) < 10);
});

test("con poca pista recorrida no se devuelve un trazado a medias", () => {
  const learner = new TrackLearner(tmpDir());
  learner.setTrack("spa");
  for (let s = 0; s < 0.2; s += 0.001) {
    learner.onCarUpdate({ posX: s * 100, posZ: 0, normalizedSplinePosition: s });
  }
  assert.equal(learner.getOutline(), null, "un quinto de pista se vería como puntos sueltos");
  assert.ok(learner.getCoverage() > 0.15, "pero el progreso sí se reporta, para poder mostrarlo");
});

test("lo aprendido sobrevive al reinicio", () => {
  const dir = tmpDir();
  const first = new TrackLearner(dir);
  first.setTrack("monza");
  driveLaps(first, 1, 1 / 800);
  first.flush();

  const second = new TrackLearner(dir);
  second.setTrack("monza");
  assert.ok(second.getOutline(), "al volver al mismo circuito el trazado ya tiene que estar");
  assert.ok(second.getCoverage() > 0.95);
});

test("cambiar de circuito no mezcla trazados", () => {
  const dir = tmpDir();
  const learner = new TrackLearner(dir);
  learner.setTrack("monza");
  driveLaps(learner, 1, 1 / 800);

  learner.setTrack("imola");
  assert.equal(learner.getOutline(), null, "el circuito nuevo arranca sin aprender");

  learner.setTrack("monza");
  assert.ok(learner.getOutline(), "y al volver, el anterior sigue estando");
});

test("el nombre de pista con barras no rompe el guardado", () => {
  const dir = tmpDir();
  const learner = new TrackLearner(dir);
  learner.setTrack("ks_nordschleife/touristenfahrten");
  driveLaps(learner, 1, 1 / 800);
  assert.doesNotThrow(() => learner.flush());
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("las posiciones en (0,0) se descartan", () => {
  const learner = new TrackLearner(tmpDir());
  learner.setTrack("spa");
  // Es lo que llega antes del primer sample real; tomarlo deforma el bounding box y el circuito
  // se dibuja comprimido en una esquina del canvas.
  for (let s = 0; s < 1; s += 0.001) learner.onCarUpdate({ posX: 0, posZ: 0, normalizedSplinePosition: s });
  assert.equal(learner.getCoverage(), 0);
});
