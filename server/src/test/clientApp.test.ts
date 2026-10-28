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
 * Los sonidos que el código nombra tienen que estar en disco.
 *
 * `playWav` hace `os.path.exists` y, si no está, loguea y sigue. Es la decisión correcta en pista
 * —mejor una app muda que una app caída— y es también la que hace que un `.wav` faltante no se
 * note nunca desde acá: el `.zip` se arma igual, se reparte igual, y el único síntoma es que a
 * veinticuatro personas no les suena la largada.
 */
test("los .wav que la app reproduce existen en la carpeta que se empaqueta", () => {
  const re = /os\.path\.join\(os\.path\.dirname\(__file__\), "sounds", "([^"]+)"\)/g;
  const nombrados: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(ejecutable)) !== null) nombrados.push(m[1]);

  assert.ok(nombrados.length >= 2, `se esperaban al menos 2 sonidos y se encontraron ${nombrados.length}`);
  for (const archivo of nombrados) {
    const ruta = path.join(CLIENT, "sounds", archivo);
    assert.ok(fs.existsSync(ruta), `falta ${ruta}, que RaceControlClient.py reproduce`);
    // Un .wav de menos de 1 KB es un archivo roto o un placeholder vacío, no un sonido.
    assert.ok(fs.statSync(ruta).size > 1024, `${archivo} pesa casi nada: no es un .wav usable`);
  }
});

/**
 * El contador de cortes se muestra sin esperar al servidor.
 *
 * Toda la gracia del cambio es la inmediatez: el dato autoritativo del servidor sale del
 * `LAP_COMPLETED`, que no llega hasta que el piloto cruza meta —hasta un minuto y medio después
 * del corte—, así que si la app no adelanta la cuenta el piloto se entera de que iba por el
 * tercero cuando ya está sancionado. Es un cableado de tres puntas (el flanco, el contador local,
 * la corrección del poll) y cortar cualquiera lo deja funcionando "bien" pero tarde, que es
 * justamente el bug que esto viene a arreglar.
 */
test("el contador de cortes está cableado por los dos lados: el flanco local y la corrección del poll", () => {
  // El flanco de `checkLapInvalidated` suma localmente y hace sonar la chicharra.
  const flanco = /def checkLapInvalidated\(\)[\s\S]*?(?=\ndef |\n[A-Za-z_]+ =|$)/.exec(ejecutable);
  assert.ok(flanco, "no se encontró checkLapInvalidated");
  assert.ok(/countCutLocally\(\)/.test(flanco![0]), "el flanco del corte ya no incrementa el contador local");
  assert.ok(/playCutWarning\(\)/.test(flanco![0]), "el flanco del corte ya no hace sonar la chicharra");

  // El poll aplica el estado que manda el servidor, que es lo único que sabe cuándo se reinicia.
  assert.ok(/applyServerStatus\(data\.get\("status"/.test(ejecutable), "el poll dejó de leer `status`");
  assert.ok(
    /cuts_local_extra = 0/.test(ejecutable),
    "al llegar una cuenta nueva del servidor hay que resetear el extra local, o los cortes se suman dos veces"
  );

  // Y los dos renglones fijos existen y no viven dentro de la cola de avisos.
  for (const etiqueta of ["label_cuts", "label_pending"]) {
    assert.ok(new RegExp("ac\\.setText\\(" + etiqueta + ",").test(ejecutable), `nadie escribe en ${etiqueta}`);
  }
  assert.ok(
    /"CUTS: \{0\}\/\{1\}"/.test(ejecutable),
    "cambió el formato del contador: el piloto tiene que ver cuántos lleva y cuántos lo sancionan"
  );
});

/**
 * La ventana de banderas no vuelve a estar verde todo el tiempo.
 *
 * Hasta la 1.2 `graphics.flag == 0` —el valor del 95% de una carrera— pintaba verde fijo, con lo
 * cual el piloto salía detrás del pace car con un cuadro verde al lado. Es un bug que no falla:
 * la app anda, dibuja, y lo que dibuja es exactamente lo contrario de lo que pasa. Volver a poner
 * un color por defecto en el camino del 0 lo reintroduce sin que nada se rompa.
 */
test("la bandera no se dibuja sola: sin bandera y sin largada, la ventana queda vacía", () => {
  const render = /def renderFlag\(deltaT\)[\s\S]*?(?=\ndef )/.exec(ejecutable);
  assert.ok(render, "no se encontró renderFlag");

  assert.ok(
    /if flag == 0 and not enVerdeDeLargada\(\):\s*\n\s*return/.test(render![0]),
    "renderFlag ya no corta en seco con la bandera 0: vuelve el cuadro verde durante toda la carrera"
  );
  // El verde sale del semáforo del poll, no de la Shared Memory: el juego no tiene ninguna
  // bandera para "arrancó la carrera", así que si esta ventana solo mirara `graphics.flag` el
  // verde de la largada no existiría.
  assert.ok(/def enVerdeDeLargada\(\)/.test(ejecutable), "se borró el puente entre la bandera y el semáforo");
  assert.ok(
    /light_state != "green"/.test(ejecutable),
    "enVerdeDeLargada dejó de mirar el estado del semáforo que trae el poll"
  );
  // Y la amarilla parpadea, que es lo único que la distingue de un cuadro que ya estaba.
  assert.ok(/flag == FLAG_YELLOW and int\(time\.time\(\) \/ FLAG_BLINK_SECONDS\)/.test(render![0]),
    "la bandera amarilla dejó de parpadear");
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
