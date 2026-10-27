import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";

/**
 * Invariantes de la app del piloto, que es el único código del producto que no corre acá.
 *
 * `RaceControlClient.py` vive dentro del intérprete Python embebido de Assetto Corsa. No lo
 * compila nadie, no lo importa ningún test, y la primera vez que se ejecuta es en la PC de un
 * piloto a punto de largar. Si tiene un error de sintaxis, el juego no avisa: la app
 * simplemente **no aparece** en el menú. El síntoma que llega es "no me anda", sin línea, sin
 * excepción y sin forma de reproducirlo desde acá.
 *
 * El riesgo concreto no es hipotético, es la versión de Python: AC trae **3.3**. Todo lo que uno
 * escribe por reflejo en 2026 —un f-string, un walrus, un `async`— es sintaxis que ese intérprete
 * no conoce, y el editor no lo marca porque el archivo es Python válido en cualquier versión
 * moderna. Es exactamente el patrón que persigue el resto de esta carpeta: lo que no falla
 * ruidosamente hay que ir a buscarlo.
 *
 * Lo que estos tests NO hacen es verificar que la app se vea bien: eso se mira en pista. Lo que
 * hacen es garantizar que llegue a ejecutarse y que ninguna ventana nueva nazca con el chrome
 * puesto.
 */

const CLIENT = path.join(__dirname, "..", "..", "..", "client-app", "apps", "python", "RaceControlClient");
const FUENTE = path.join(CLIENT, "RaceControlClient.py");

const codigo = fs.readFileSync(FUENTE, "utf-8");

/** El código sin comentarios ni docstrings: lo que el intérprete tiene que poder parsear. */
const ejecutable = codigo
  .replace(/"""[\s\S]*?"""/g, '""')
  .replace(/^\s*#.*$/gm, "")
  .replace(/\s#.*$/gm, "");

test("la app del piloto existe donde el empaquetador la busca", () => {
  assert.ok(fs.existsSync(FUENTE), `no está ${FUENTE}: el .zip de los pilotos saldría vacío`);
  assert.ok(codigo.length > 1000, "el archivo está sospechosamente corto");
});

/**
 * Sintaxis que Python 3.3 no entiende.
 *
 * Cada entrada es un error que **no se ve** hasta que la app no abre en la PC de otro. El
 * f-string es el caso que de verdad va a pasar —es el idioma por defecto desde 3.6 y el archivo
 * está lleno de `.format()` justamente para evitarlo—, pero el resto entra por el mismo camino.
 */
const PROHIBIDO: Array<{ patron: RegExp; que: string; desde: string }> = [
  { patron: /\bf"""/, que: "f-string triple", desde: "3.6" },
  { patron: /\bf"/, que: 'f-string con comilla doble', desde: "3.6" },
  { patron: /\bf'/, que: "f-string con comilla simple", desde: "3.6" },
  { patron: /:=/, que: "operador morsa `:=`", desde: "3.8" },
  { patron: /\basync\s+def\b/, que: "`async def`", desde: "3.5" },
  { patron: /\bawait\s+/, que: "`await`", desde: "3.5" },
  { patron: /\bmatch\s+[^\s(]+\s*:\s*$/m, que: "`match`", desde: "3.10" },
  { patron: /\bnonlocal\b.*\bglobal\b/, que: "mezcla de nonlocal y global", desde: "nunca" },
];

for (const { patron, que, desde } of PROHIBIDO) {
  test(`la app del piloto no usa ${que} (Python ${desde}, y AC trae 3.3)`, () => {
    const hallazgo = patron.exec(ejecutable);
    assert.equal(
      hallazgo,
      null,
      `hay un ${que} en RaceControlClient.py ("${hallazgo?.[0]}"): el intérprete de Assetto Corsa ` +
        `es Python 3.3 y eso es un SyntaxError al cargar, con lo cual la app no aparece en el menú ` +
        `del juego y el piloto no recibe ningún error. Usá .format() o %.`
    );
  });
}

/**
 * Solo stdlib, y stdlib que exista en 3.3.
 *
 * El intérprete de AC no tiene pip ni site-packages propios: un `import requests` no es un error
 * de estilo, es la app que no arranca. `importlib`/`enum`/`pathlib` tampoco sirven acá —son de
 * 3.4— y son justo los que uno importaría sin pensarlo.
 */
const PERMITIDOS = [
  "ac",
  "acsys",
  "ctypes",
  "json",
  "math",
  "mmap",
  "os",
  "sys",
  "threading",
  "time",
  "urllib",
  "urllib.request",
  "winsound",
];

test("la app del piloto solo importa stdlib disponible en el Python de AC", () => {
  const importados: string[] = [];
  const re = /^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ejecutable)) !== null) importados.push(m[1]);

  assert.ok(importados.length > 0, "no se encontró ningún import, el parseo falló");
  for (const modulo of importados) {
    assert.ok(
      PERMITIDOS.indexOf(modulo) !== -1,
      `\`${modulo}\` no está en la lista de módulos disponibles en el Python 3.3 embebido de AC. ` +
        `Si de verdad existe ahí, agregalo a PERMITIDOS; si no, la app no va a cargar.`
    );
  }
});

/**
 * Toda ventana nace sin chrome.
 *
 * Hasta la 1.0 las tres ventanas eran recuadros negros con título tapando el parabrisas, y el
 * veredicto en pista fue que así es peor que no tener nada. `ocultarChrome` lo arregla, pero es
 * una llamada que hay que acordarse de hacer: una ventana nueva agregada dentro de seis meses
 * aparece con el fondo negro puesto, se ve "normal" para quien la programó, y vuelve el problema
 * para los veinticuatro que corren la fecha.
 */
test("todas las ventanas de la app del piloto se crean sin fondo ni título", () => {
  const ventanas = (ejecutable.match(/ac\.newApp\(/g) || []).length;
  assert.ok(ventanas >= 3, `se esperaban al menos 3 ventanas y se encontraron ${ventanas}`);

  const ocultadas = (ejecutable.match(/ocultarChrome\(/g) || []).length - 1; // -1: la definición
  assert.equal(
    ocultadas,
    ventanas,
    `hay ${ventanas} ventanas y ${ocultadas} llamadas a ocultarChrome: la que falta va a salir ` +
      `como un recuadro negro con título encima de la pista`
  );

  for (const pieza of ["setBackgroundOpacity", "drawBorder", "setTitle", "setIconPosition"]) {
    assert.ok(
      new RegExp("ac\\." + pieza + "\\(").test(ejecutable),
      `ocultarChrome ya no llama a ac.${pieza}: el chrome son cuatro cosas separadas y sin esta ` +
        `queda la parte visible que corresponda`
    );
  }
});

/**
 * El `ui.json` y el código tienen que nombrar las mismas apps.
 *
 * Es lo que lee Content Manager para listar la app. No rompe nada si se desincroniza —de ahí que
 * valga un test—: la descripción simplemente miente sobre qué ventanas va a encontrar el piloto.
 */
test("el ui.json de la app del piloto declara la versión y las tres ventanas", () => {
  const ui = JSON.parse(fs.readFileSync(path.join(CLIENT, "ui.json"), "utf-8"));
  assert.ok(/^\d+\.\d+$/.test(ui.version), `versión rara en ui.json: ${ui.version}`);

  const nombres = (ejecutable.match(/ac\.newApp\("([^"]+)"\)/g) || []).map((l) =>
    /"([^"]+)"/.exec(l)![1]
  );
  for (const nombre of nombres) {
    assert.ok(
      ui.description.indexOf(nombre) !== -1,
      `la ventana "${nombre}" no figura en la descripción del ui.json`
    );
  }
});
