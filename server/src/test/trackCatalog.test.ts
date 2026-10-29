import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";

/**
 * El catálogo de trazados, validado sobre lo que se sirve y no sobre lo que se escribe.
 *
 * `dist/` y no `src/` a propósito, igual que `assets.test.ts`. Los JSON del catálogo no son
 * TypeScript, así que `tsc` no los emite: llegan a `dist/` solo porque `scripts/copy-assets.js`
 * los copia. Si esa línea se cae en una refactorización, en desarrollo no pasa nada visible y en
 * producción el mapa vuelve al aprendizaje por telemetría —tarda una tarde en dibujar algo y lo
 * que dibuja es peor— sin un solo error en ningún log. Es exactamente la clase de falla silenciosa
 * que este proyecto ya pagó varias veces.
 */

const CATALOGO = path.join(__dirname, "..", "track", "catalog");

/** El mismo número de tramos que usa TrackLearner. Un JSON con otro largo no es de este formato. */
const SLOTS = 600;

function archivos(): string[] {
  if (!fs.existsSync(CATALOGO)) return [];
  return fs
    .readdirSync(CATALOGO)
    .filter((n) => n.endsWith(".json"))
    .map((n) => path.join(CATALOGO, n));
}

test("el catálogo llegó a dist (si no, copy-assets.js dejó de copiarlo)", () => {
  assert.ok(
    archivos().length > 50,
    `Encontré ${archivos().length} trazados en ${CATALOGO}. El mapa necesita el catálogo ahí: ` +
      `revisá que scripts/copy-assets.js siga copiando src/track/catalog.`
  );
});

test("todo trazado del catálogo es dibujable", () => {
  for (const archivo of archivos()) {
    const nombre = path.basename(archivo);
    const raw = JSON.parse(fs.readFileSync(archivo, "utf-8"));

    assert.equal(raw.points?.length, SLOTS, `${nombre}: ${raw.points?.length} puntos, se esperaban ${SLOTS}`);
    assert.equal(raw.coverage, 1, `${nombre}: el catálogo siempre está completo`);

    const b = raw.bounds;
    assert.ok(b, `${nombre}: sin bounds el canvas no puede escalar y dibuja todo en un píxel`);
    assert.ok(b.maxX > b.minX && b.maxZ > b.minZ, `${nombre}: bounding box degenerado`);

    for (const p of raw.points) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), `${nombre}: una coordenada no es un número`);
      assert.ok(p.s >= 0 && p.s < 1, `${nombre}: s=${p.s} fuera de 0..1`);
      assert.ok(
        p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ,
        `${nombre}: hay un punto fuera del bounding box — el auto se dibujaría afuera del mapa`
      );
    }
  }
});

/**
 * Casi todas las pistas son circuitos, pero no todas.
 *
 * Una subida de montaña (Trento-Bondone) o una ruta punto a punto terminan a kilómetros de donde
 * arrancaron. El panel no puede unir el último punto con el primero en esos casos: dibujaría una
 * recta cruzando el mapa entero, y nada en la pantalla diría que esa recta no es pista.
 */
test("el campo `closed` distingue los circuitos de las pistas punto a punto", () => {
  let cerrados = 0;
  let abiertos = 0;
  for (const archivo of archivos()) {
    const raw = JSON.parse(fs.readFileSync(archivo, "utf-8"));
    assert.equal(typeof raw.closed, "boolean", `${path.basename(archivo)}: falta el campo closed`);
    if (raw.closed) cerrados += 1;
    else abiertos += 1;
  }
  assert.ok(cerrados > abiertos * 5, `${abiertos} pistas abiertas contra ${cerrados} cerradas: el umbral de cierre quedó mal`);
});

/**
 * Acá vivía "el panel no cierra el dibujo de una pista punto a punto", que exigía
 * `closed !== false` antes de `closePath()` en app.js. Dependía del dibujo del mapa, que la rama
 * `feature/panel-simplificado-fsl` saca entero de la pantalla fusionada para
 * fslmanager.vercel.app — sin mapa no hay `closePath()` que cuidar. El panel completo de la rama
 * main sigue dibujando el mapa y este test sigue vivo ahí.
 */
