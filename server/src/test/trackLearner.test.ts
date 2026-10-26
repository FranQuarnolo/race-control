import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import { TrackLearner } from "../track/trackLearner";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-track-"));
}

/**
 * Los tests del aprendizaje corren con el catálogo vacío, a propósito.
 *
 * El catálogo real trae `monza` y `spa` —son nombres de carpeta de Assetto Corsa, no inventos del
 * test— y con el catálogo puesto el aprendizaje ni siquiera se ejecuta. Sin esto, el día que se
 * genere el catálogo estos tests empezarían a pasar por el camino equivocado, probando nada.
 */
const SIN_CATALOGO = path.join(os.tmpdir(), "rc-catalogo-que-no-existe");

/** Un trazado de catálogo mínimo pero completo, con la forma que escribe `build-track-catalog.js`. */
function escribirCatalogo(dir: string, clave: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const points = [];
  for (let i = 0; i < 600; i++) {
    const angle = (i / 600) * Math.PI * 2;
    points.push({ s: i / 600, x: Math.cos(angle) * 1000, z: Math.sin(angle) * 1000 });
  }
  const outline = { track: clave, points, bounds: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 }, coverage: 1 };
  fs.writeFileSync(path.join(dir, clave + ".json"), JSON.stringify(outline), "utf-8");
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
  const learner = new TrackLearner(tmpDir(), SIN_CATALOGO);
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
  const learner = new TrackLearner(tmpDir(), SIN_CATALOGO);
  learner.setTrack("spa");
  for (let s = 0; s < 0.2; s += 0.001) {
    learner.onCarUpdate({ posX: s * 100, posZ: 0, normalizedSplinePosition: s });
  }
  assert.equal(learner.getOutline(), null, "un quinto de pista se vería como puntos sueltos");
  assert.ok(learner.getCoverage() > 0.15, "pero el progreso sí se reporta, para poder mostrarlo");
});

test("lo aprendido sobrevive al reinicio", () => {
  const dir = tmpDir();
  const first = new TrackLearner(dir, SIN_CATALOGO);
  first.setTrack("monza");
  driveLaps(first, 1, 1 / 800);
  first.flush();

  const second = new TrackLearner(dir, SIN_CATALOGO);
  second.setTrack("monza");
  assert.ok(second.getOutline(), "al volver al mismo circuito el trazado ya tiene que estar");
  assert.ok(second.getCoverage() > 0.95);
});

test("cambiar de circuito no mezcla trazados", () => {
  const dir = tmpDir();
  const learner = new TrackLearner(dir, SIN_CATALOGO);
  learner.setTrack("monza");
  driveLaps(learner, 1, 1 / 800);

  learner.setTrack("imola");
  assert.equal(learner.getOutline(), null, "el circuito nuevo arranca sin aprender");

  learner.setTrack("monza");
  assert.ok(learner.getOutline(), "y al volver, el anterior sigue estando");
});

test("el nombre de pista con barras no rompe el guardado", () => {
  const dir = tmpDir();
  const learner = new TrackLearner(dir, SIN_CATALOGO);
  learner.setTrack("ks_nordschleife/touristenfahrten");
  driveLaps(learner, 1, 1 / 800);
  assert.doesNotThrow(() => learner.flush());
  assert.equal(fs.readdirSync(dir).length, 1);
});

/* ------------------------------------------------------------------ catálogo */

test("un circuito del catálogo se dibuja entero sin que nadie dé una vuelta", () => {
  const catalogo = tmpDir();
  escribirCatalogo(catalogo, "ks_monza");
  const learner = new TrackLearner(tmpDir(), catalogo);
  learner.setTrack("ks_monza");

  const outline = learner.getOutline();
  assert.ok(outline, "el trazado tiene que estar desde el primer segundo");
  assert.equal(outline!.points.length, 600);
  assert.equal(learner.getCoverage(), 1);
  assert.equal(learner.isCatalogued(), true);
});

test("con catálogo no se aprende ni se pisa el dibujo con la telemetría", () => {
  const catalogo = tmpDir();
  escribirCatalogo(catalogo, "ks_monza");
  const learner = new TrackLearner(tmpDir(), catalogo);
  learner.setTrack("ks_monza");
  // El óvalo de `driveLaps` mide 500x300; el del catálogo, 1000x1000. Si el aprendizaje se colara,
  // el bounding box encogería y el mapa se dibujaría con la forma equivocada.
  driveLaps(learner, 1, 1 / 800);
  assert.equal(learner.getOutline()!.bounds.maxX, 1000);
});

test("con catálogo no se escribe nada en la carpeta de la liga", () => {
  const catalogo = tmpDir();
  const datos = tmpDir();
  escribirCatalogo(catalogo, "ks_monza");
  const learner = new TrackLearner(datos, catalogo);
  learner.setTrack("ks_monza");
  driveLaps(learner, 1, 1 / 800);
  learner.flush();
  assert.equal(fs.readdirSync(datos).length, 0, "una copia por liga le ganaría a un catálogo corregido");
});

test("la variante del circuito elige el trazado, no la pista sola", () => {
  const catalogo = tmpDir();
  escribirCatalogo(catalogo, "ks_nordschleife__endurance");
  const learner = new TrackLearner(tmpDir(), catalogo);

  learner.setTrack("ks_nordschleife", "endurance");
  assert.equal(learner.isCatalogued(), true);

  // La otra variante no está en el catálogo de este test: cae al trazado de la pista base, que
  // tampoco está, así que se aprende. Lo importante es que NO se quedó con el de endurance.
  learner.setTrack("ks_nordschleife", "touristenfahrten");
  assert.equal(learner.isCatalogued(), false);
  assert.equal(learner.getOutline(), null);
});

test("una variante que no está en el catálogo cae al trazado de la pista", () => {
  const catalogo = tmpDir();
  escribirCatalogo(catalogo, "ks_monza");
  const learner = new TrackLearner(tmpDir(), catalogo);
  learner.setTrack("ks_monza", "layout_junior");
  assert.equal(learner.isCatalogued(), true, "mejor el trazado principal que ningún trazado");
});

test("una pista punto a punto conserva que no cierra", () => {
  const catalogo = tmpDir();
  escribirCatalogo(catalogo, "trento-bondone");
  // Se reescribe con closed:false, que es lo que marca el generador para una subida de montaña.
  const archivo = path.join(catalogo, "trento-bondone.json");
  const raw = JSON.parse(fs.readFileSync(archivo, "utf-8"));
  fs.writeFileSync(archivo, JSON.stringify({ ...raw, closed: false }), "utf-8");

  const learner = new TrackLearner(tmpDir(), catalogo);
  learner.setTrack("trento-bondone");
  assert.equal(learner.getOutline()!.closed, false, "si se pierde, el mapa dibuja una recta de punta a punta");
});

test("un trazado sin el campo `closed` se asume cerrado", () => {
  const catalogo = tmpDir();
  escribirCatalogo(catalogo, "ks_monza");
  const learner = new TrackLearner(tmpDir(), catalogo);
  learner.setTrack("ks_monza");
  assert.equal(learner.getOutline()!.closed, true, "es lo que vale para todo lo aprendido y para casi toda pista");
});

/**
 * Es el camino para agregar un circuito sin esperar a una versión nueva: se genera el JSON con
 * `build-track-catalog.js` y se deja en la carpeta de datos de la liga. Vale la pena un test
 * porque el formato de lo aprendido y el del catálogo son el mismo **a propósito**, y eso es
 * fácil de romper sin darse cuenta.
 */
test("un trazado dejado a mano en la carpeta de la liga se usa tal cual", () => {
  const datos = tmpDir();
  escribirCatalogo(datos, "mod_que_no_esta_en_el_catalogo");
  const archivo = path.join(datos, "mod_que_no_esta_en_el_catalogo.json");
  const raw = JSON.parse(fs.readFileSync(archivo, "utf-8"));
  fs.writeFileSync(archivo, JSON.stringify({ ...raw, closed: false }), "utf-8");

  const learner = new TrackLearner(datos, SIN_CATALOGO);
  learner.setTrack("mod_que_no_esta_en_el_catalogo");

  const outline = learner.getOutline();
  assert.ok(outline, "no hay que dar ninguna vuelta para que el mapa aparezca");
  assert.equal(outline!.bounds.maxX, 1000);
  assert.equal(outline!.closed, false, "el campo tiene que sobrevivir al camino de lo aprendido");
  assert.equal(learner.isCatalogued(), false, "no vino del catálogo, aunque se comporte igual");
});

test("una pista que no está en el catálogo vuelve a aprenderse", () => {
  const learner = new TrackLearner(tmpDir(), tmpDir());
  learner.setTrack("mod_inventado_por_alguien");
  assert.equal(learner.isCatalogued(), false);
  assert.equal(learner.getOutline(), null);
  driveLaps(learner, 1, 1 / 800);
  assert.ok(learner.getOutline(), "el aprendizaje sigue siendo la red para las pistas mod");
});

test("un JSON de catálogo corrupto no tumba nada: se aprende como siempre", () => {
  const catalogo = tmpDir();
  fs.writeFileSync(path.join(catalogo, "ks_monza.json"), "{ esto no es json", "utf-8");
  const learner = new TrackLearner(tmpDir(), catalogo);
  assert.doesNotThrow(() => learner.setTrack("ks_monza"));
  assert.equal(learner.isCatalogued(), false);
});

test("un JSON de catálogo sin bounds se descarta en vez de dibujar cualquier cosa", () => {
  const catalogo = tmpDir();
  // Sin bounding box el canvas no puede escalar: dibujaría el circuito apelotonado en un píxel.
  fs.writeFileSync(path.join(catalogo, "ks_monza.json"), JSON.stringify({ points: [{ s: 0, x: 1, z: 1 }] }), "utf-8");
  const learner = new TrackLearner(tmpDir(), catalogo);
  learner.setTrack("ks_monza");
  assert.equal(learner.isCatalogued(), false);
});

test("las posiciones en (0,0) se descartan", () => {
  const learner = new TrackLearner(tmpDir(), SIN_CATALOGO);
  learner.setTrack("spa");
  // Es lo que llega antes del primer sample real; tomarlo deforma el bounding box y el circuito
  // se dibuja comprimido en una esquina del canvas.
  for (let s = 0; s < 1; s += 0.001) learner.onCarUpdate({ posX: 0, posZ: 0, normalizedSplinePosition: s });
  assert.equal(learner.getCoverage(), 0);
});
