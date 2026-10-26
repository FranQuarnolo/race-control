import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";

/**
 * Los SVG que se sirven tienen que parsear.
 *
 * Existe por un bug real que estuvo dos deploys en producción sin que nadie lo viera venir: el
 * ícono de la app llevaba, dentro de un comentario, los nombres de dos variables CSS escritos con
 * su prefijo de dos guiones. Un comentario XML **no puede contener dos guiones seguidos**, así que
 * el archivo dejó de ser XML bien formado y el navegador dibujó el ícono de imagen rota.
 *
 * Lo que lo hace peligroso es que todo lo demás funciona: el archivo existe, el servidor contesta
 * 200 con el `content-type` correcto y el contenido se ve perfecto al abrirlo en un editor. El
 * único síntoma es un dibujito roto, indistinguible de un 404, y el diagnóstico intuitivo —"será
 * contraste", "será la ruta"— lleva para cualquier lado menos al verdadero.
 *
 * Se valida lo que se sirve (`dist/`) y no lo que se escribe (`src/`), que es lo que de verdad le
 * llega al navegador. Incluye los ~130 logos de marca: ahí el mismo error sería todavía más
 * invisible, porque un logo roto en una tabla de pilotos no se lo reporta nadie.
 */

const DIST = path.join(__dirname, "..");

function svgsEn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const salida: string[] = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const completa = path.join(dir, entrada.name);
    if (entrada.isDirectory()) salida.push(...svgsEn(completa));
    else if (entrada.name.endsWith(".svg")) salida.push(completa);
  }
  return salida;
}

const archivos = svgsEn(DIST);

test("hay SVG para revisar (si no, el build no corrió y el resto no prueba nada)", () => {
  assert.ok(archivos.length > 0, `No encontré ningún .svg bajo ${DIST}. ¿Corriste npm run build?`);
});

test("ningún comentario de un SVG contiene dos guiones seguidos", () => {
  const rotos: string[] = [];
  for (const archivo of archivos) {
    const texto = fs.readFileSync(archivo, "utf-8");
    // El contenido de cada comentario, sin los delimitadores. `[\s\S]` y no `.` porque los
    // comentarios de estos archivos son de varias líneas.
    for (const [, cuerpo] of texto.matchAll(/<!--([\s\S]*?)-->/g)) {
      if (cuerpo.includes("--")) rotos.push(path.relative(DIST, archivo));
    }
  }
  assert.deepEqual(
    rotos,
    [],
    `Estos SVG tienen "--" adentro de un comentario y el navegador los va a rechazar enteros: ${rotos.join(", ")}`
  );
});

test("los comentarios de cada SVG abren y cierran parejo", () => {
  for (const archivo of archivos) {
    const texto = fs.readFileSync(archivo, "utf-8");
    const abiertos = texto.split("<!--").length - 1;
    const cerrados = texto.split("-->").length - 1;
    assert.equal(abiertos, cerrados, `${path.relative(DIST, archivo)}: ${abiertos} <!-- y ${cerrados} -->`);
  }
});

test("cada SVG tiene su elemento raíz", () => {
  for (const archivo of archivos) {
    const texto = fs.readFileSync(archivo, "utf-8");
    const nombre = path.relative(DIST, archivo);
    assert.match(texto, /<svg[\s>]/, `${nombre}: no encuentro el <svg> de apertura`);
    assert.match(texto.trimEnd(), /<\/svg>$/, `${nombre}: no termina en </svg>`);
  }
});
