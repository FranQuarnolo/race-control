import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";

/**
 * Invariantes del embed externo (`src/api/public/embed/`), mismo espíritu que `panel.test.ts` y
 * `assets.test.ts`: acá viven los bugs que no tiran ningún error, simplemente no se ven. Es un
 * bundle nuevo, chico y sin framework, con la misma receta de problema que ya tuvo el panel
 * completo — una clase que `embed.js` arma y `embed.css` no cubre se dibuja sin estilo y sin un
 * solo error en consola.
 *
 * Se valida `dist/`, que es lo que se le sirve a la página de un tercero, y no `src/`.
 */

const DIST = path.join(__dirname, "..");
const EMBED = path.join(DIST, "api", "public", "embed");

function leer(...tramos: string[]): string {
  return fs.readFileSync(path.join(...tramos), "utf-8");
}

function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

test("el build copia embed.js y embed.css a dist/", () => {
  assert.ok(
    fs.existsSync(path.join(EMBED, "embed.js")),
    `Falta ${path.join(EMBED, "embed.js")}. ¿Corriste npm run build? Si copy-assets.js dejó de ` +
      `arrastrar esta carpeta, el snippet que el admin pega en su página da 404 en silencio.`
  );
  assert.ok(fs.existsSync(path.join(EMBED, "embed.css")), `Falta ${path.join(EMBED, "embed.css")}.`);
});

/**
 * Toda clase que `embed.js` le pone a un elemento tiene que tener una regla en `embed.css`.
 *
 * Las clases literales (`el("div", "rc-embed__banner")`, `algo.className = "rc-embed__tabla"`) se
 * leen solas del código. Las de sufijo dinámico (`"rc-embed__badge rc-embed__badge--" + p.status`)
 * no: el valor sale de un estado con un conjunto cerrado y conocido de valores, no texto libre, así
 * que se listan a mano. Si el día de mañana se agrega un estado nuevo a alguna de estas familias
 * (un `PenaltyStatus` nuevo, una fase nueva del semáforo), hay que sumarlo ACÁ y en `embed.css` a
 * propósito — es la misma exigencia que ya hace `panel.test.ts` para `app.js`/`styles.css`.
 *
 * `rc-embed__fila` queda afuera a propósito: es el ancla sobre la que se concatena el sufijo
 * `--desconectado`, no pinta nada por sí sola (el formato de la fila sale de `.rc-embed__tabla td`)
 * — el mismo tipo de excepción que `panel.test.ts` hace para las clases que son puro gancho.
 */
test("toda clase que embed.js arma tiene al menos una regla en embed.css", () => {
  const js = leer(EMBED, "embed.js");
  const css = sinComentarios(leer(EMBED, "embed.css"));

  const conRegla = new Set<string>();
  for (const [, clase] of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) conRegla.add(clase);

  const SIN_REGLA_A_PROPOSITO = new Set(["rc-embed__fila"]);

  const usadas = new Set<string>();

  // el("tag", "una-sola-clase-literal")
  for (const [, clase] of js.matchAll(/\bel\(\s*"[^"]+"\s*,\s*"([\w-]+)"\s*\)/g)) usadas.add(clase);

  // Asignación directa: `algo.className = "literal literal2"`. Los tokens que terminan en "--" son
  // el prefijo de una familia de sufijo dinámico (ver más abajo) y no una clase en sí misma.
  for (const [, lista] of js.matchAll(/\.className\s*=\s*"([^"]*)"/g)) {
    for (const clase of lista.trim().split(/\s+/)) {
      if (!clase || clase.endsWith("--")) continue;
      usadas.add(clase);
    }
  }

  const FAMILIAS_CON_SUFIJO_DINAMICO: Record<string, string[]> = {
    "rc-embed__btn": ["secondary", "arming", "peligro", "expandir", "pendiente", "kebab", "armando"],
    "rc-embed__semaforo": ["formation", "green"],
    "rc-embed__fila": ["desconectado"],
    "rc-embed__badge": ["servingWindow", "served", "escalated", "revoked", "dismissed", "warned", "penalized"],
    "rc-embed__dot": ["ok", "bad"],
    "rc-embed__incidente": ["resuelto"],
  };
  for (const [prefijo, sufijos] of Object.entries(FAMILIAS_CON_SUFIJO_DINAMICO)) {
    assert.ok(
      js.includes(prefijo + "--"),
      `No encontré "${prefijo}--" en embed.js. ¿Cambió el nombre de la clase? Hay que actualizar este test.`
    );
    usadas.add(prefijo);
    for (const sufijo of sufijos) usadas.add(prefijo + "--" + sufijo);
  }

  const huerfanas = [...usadas]
    .filter((c) => !SIN_REGLA_A_PROPOSITO.has(c))
    .filter((c) => !conRegla.has(c))
    .sort();
  assert.deepEqual(
    huerfanas,
    [],
    `embed.js arma estas clases y embed.css no tiene ninguna regla que las alcance. Se dibujan sin ` +
      `estilo, sin un solo error: ${huerfanas.join(", ")}`
  );

  assert.ok(usadas.size > 15, `Solo encontré ${usadas.size} clases: el regex quedó viejo`);
});

test("toda variable CSS que embed.css usa está definida adentro de .rc-embed", () => {
  const css = sinComentarios(leer(EMBED, "embed.css"));
  const definidas = new Set<string>();
  for (const [, v] of css.matchAll(/(--[\w-]+)(?=\s*:)/g)) definidas.add(v);

  const faltantes = new Set<string>();
  for (const [, v, coma] of css.matchAll(/var\(\s*(--[\w-]+)\s*(,?)/g)) {
    if (coma === ",") continue;
    if (!definidas.has(v)) faltantes.add(v);
  }
  assert.deepEqual([...faltantes], [], `embed.css usa variables que no define: ${[...faltantes].join(", ")}`);
});
