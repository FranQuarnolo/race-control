import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";

/**
 * Invariantes del panel que ningún test de lógica puede ver.
 *
 * Los tres bugs que originaron este archivo tenían la misma forma, que es la peor que puede tener
 * un bug en este producto: **todo funciona y algo simplemente no pasa**. No hay excepción, no hay
 * error en consola, no hay test en rojo. Una variable CSS que no existe vuelve inválida la
 * propiedad entera y el navegador la descarta sin decir nada; un `$("id")` que no está en el HTML
 * devuelve `null` y revienta recién cuando alguien abre esa pantalla; un campo que el backend
 * calcula y manda en cada `/api/state` puede no leerlo nadie durante meses.
 *
 * Es el mismo patrón del `--` adentro del comentario del SVG (ver assets.test.ts), y la lección
 * también: lo que no falla ruidosamente hay que ir a buscarlo.
 *
 * Se valida `dist/`, que es lo que se le sirve al navegador, y no `src/`.
 */

const DIST = path.join(__dirname, "..");
const PANEL = path.join(DIST, "api", "public");
const PORTAL = path.join(DIST, "portal", "public");

function leer(...tramos: string[]): string {
  return fs.readFileSync(path.join(...tramos), "utf-8");
}

/**
 * Saca los comentarios de una hoja de estilo antes de analizarla.
 *
 * Hace falta por una razón que este mismo archivo descubrió a los cinco minutos de existir: el
 * comentario que documenta el bug de `--warn` cita el `var(--warn)` original, y sin esto el test
 * se denunciaba a sí mismo. Es el mismo enredo que el `--` dentro del comentario del SVG: lo que
 * explica el problema termina pareciéndose al problema.
 */
function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Las hojas de estilo que se sirven, cada una con el JS que puede definirle variables en vivo. */
const HOJAS = [
  { css: path.join(PANEL, "styles.css"), js: [path.join(PANEL, "app.js")] },
  { css: path.join(PORTAL, "portal.css"), js: [] as string[] },
  { css: path.join(PORTAL, "landing.css"), js: [] as string[] },
];

test("toda variable CSS que se usa está definida en alguna parte", () => {
  for (const hoja of HOJAS) {
    if (!fs.existsSync(hoja.css)) continue;
    const css = sinComentarios(leer(hoja.css));
    const nombre = path.relative(DIST, hoja.css);

    // Definidas en la hoja: `--x: valor`. El `(?=\s*:)` evita confundir una definición con un uso
    // dentro de `var(--x)`, que nunca va seguido de dos puntos.
    const definidas = new Set<string>();
    for (const [, v] of css.matchAll(/(--[\w-]+)(?=\s*:)/g)) definidas.add(v);

    // Definidas desde JS con `style.setProperty("--x", ...)`: el escudo de marca arma su color en
    // vivo, así que esas variables no están —ni pueden estar— en la hoja.
    for (const archivo of hoja.js) {
      if (!fs.existsSync(archivo)) continue;
      for (const [, v] of leer(archivo).matchAll(/setProperty\(\s*"(--[\w-]+)"/g)) definidas.add(v);
    }

    const faltantes = new Set<string>();
    for (const [, v, coma] of css.matchAll(/var\(\s*(--[\w-]+)\s*(,?)/g)) {
      // `var(--x, fallback)` se banca que `--x` no exista: para eso está el segundo argumento.
      if (coma === "," ) continue;
      if (!definidas.has(v)) faltantes.add(v);
    }

    assert.deepEqual(
      [...faltantes],
      [],
      `${nombre}: estas variables se usan y no las define nadie, así que la propiedad que las ` +
        `contiene no se aplica y el navegador no avisa: ${[...faltantes].join(", ")}`
    );
  }
});

test("todo id que el panel busca con $() existe en su HTML", () => {
  const js = leer(PANEL, "app.js");
  const html = leer(PANEL, "index.html");

  // Solo los literales: `$(view.main)` y `$(fieldId(tipo, clave))` se arman en tiempo de ejecución
  // y sus destinos los crea el propio panel.
  const buscados = new Set<string>();
  for (const [, id] of js.matchAll(/\$\(\s*"([\w-]+)"\s*\)/g)) buscados.add(id);

  const existentes = new Set<string>();
  for (const [, id] of html.matchAll(/\bid="([\w-]+)"/g)) existentes.add(id);

  const faltantes = [...buscados].filter((id) => !existentes.has(id)).sort();
  assert.deepEqual(
    faltantes,
    [],
    `app.js le pide al DOM ids que index.html no tiene. $() devuelve null y la pantalla que lo use ` +
      `se rompe entera al abrirse: ${faltantes.join(", ")}`
  );

  assert.ok(buscados.size > 20, `Solo encontré ${buscados.size} llamadas a $(): el regex quedó viejo`);
});

/**
 * Campos que el backend calcula **solo para el panel** y agrega a cada auto en `/api/state`.
 *
 * Son los que no vienen de `CarState`: existen porque alguien decidió que el panel los necesitaba.
 * Si el panel no los lee, el trabajo de calcularlos se tira, y —peor— el dato que debían comunicar
 * no llega. `telemetryStale` estuvo así: el backend marcaba cada auto cuya telemetría se había
 * congelado y el panel lo ignoraba, así que un piloto desconectado se veía igual que uno en pista.
 */
const CAMPOS_DERIVADOS = ["position", "brand", "brandLogo", "telemetryStale", "pingMs", "telemetry", "gapAheadMs", "gapLeaderMs"];

test("el panel usa todos los campos que /api/state calcula para él", () => {
  const js = leer(PANEL, "app.js");
  const sinUsar = CAMPOS_DERIVADOS.filter((campo) => !js.includes(campo));
  assert.deepEqual(
    sinUsar,
    [],
    `El backend calcula estos campos por auto y el panel no los menciona nunca. O se dibujan, o se ` +
      `dejan de mandar — mandarlos y no leerlos es un dato que el admin cree tener: ${sinUsar.join(", ")}`
  );
});

test("la lista de campos derivados no quedó vieja contra el backend", () => {
  // Contracara del test de arriba: si alguien renombra un campo en adminApi.ts, la lista de acá
  // dejaría de proteger nada y el test seguiría pasando en verde.
  const api = leer(DIST, "api", "adminApi.js");
  const ausentes = CAMPOS_DERIVADOS.filter((campo) => !api.includes(campo));
  assert.deepEqual(
    ausentes,
    [],
    `CAMPOS_DERIVADOS nombra campos que adminApi ya no manda: ${ausentes.join(", ")}`
  );
});

/**
 * Campos de `/api/state` que no son por auto pero existen igual solo para el panel.
 *
 * Mismo riesgo que `CAMPOS_DERIVADOS` y mismo remedio: un campo que el backend arma y nadie lee es
 * trabajo tirado, y lo que debía comunicar no llega. `lapsDown` y `pitZone` nacieron en la 0.6 y
 * los dos se pintan en un solo lugar cada uno, así que son fáciles de perder en una refactorización.
 */
const CAMPOS_DE_ESTADO = ["lapsDown", "pitZone"];

test("el panel usa los campos de estado que el backend agrega para él", () => {
  const js = leer(PANEL, "app.js");
  const api = leer(DIST, "api", "adminApi.js");
  for (const campo of CAMPOS_DE_ESTADO) {
    assert.ok(api.includes(campo), `adminApi ya no manda ${campo}: la lista de este test quedó vieja`);
    assert.ok(js.includes(campo), `El backend manda ${campo} y el panel no lo menciona nunca`);
  }
});

/**
 * El mapa y el motor tienen que estar de acuerdo sobre qué es el pit lane.
 *
 * `isInPitZone` compara `s >= inicio && s <= fin` sin dar la vuelta al cruzar la meta. Si el dibujo
 * fuera más generoso —envolviendo cuando el inicio es mayor que el fin— el mapa pintaría en ámbar
 * un tramo donde el motor no sanciona a nadie, y alguien calibraría la zona mirando un dibujo que
 * miente. Es un acuerdo entre dos archivos que no se importan entre sí, así que no hay tipo ni
 * compilador que lo sostenga.
 */
test("el mapa pinta la zona de pit con el mismo criterio que la sanciona el motor", () => {
  const js = leer(PANEL, "app.js");
  const motor = leer(DIST, "instances", "pitSpeeding.js");

  assert.ok(js.includes("drawPitZone"), "nadie dibuja la zona de pit sobre el mapa");
  // Las dos partes miran los mismos dos extremos. Si alguien renombra uno, este test lo nota antes
  // de que el dibujo y la sanción dejen de coincidir en silencio.
  for (const extremo of ["splineStart", "splineEnd"]) {
    assert.ok(motor.includes(extremo), `pitSpeeding ya no usa ${extremo}`);
    assert.ok(js.includes(extremo), `el panel no usa ${extremo} para dibujar la zona`);
  }
  // Y ninguno de los dos envuelve: un `+ 1` o un `%` acá sería el primer paso hacia que difieran.
  assert.ok(!/splineEnd\s*[+%]/.test(motor), "el motor empezó a envolver la zona y el mapa no");
});

test("el panel avisa cuando se queda sin contacto con el motor", () => {
  const js = leer(PANEL, "app.js");
  const html = leer(PANEL, "index.html");

  // El bug original: `setInterval(() => refresh().catch(() => {}), POLL_MS)`. Con el backend caído
  // el panel se quedaba congelado mostrando el último estado bueno, sin una sola señal en
  // pantalla. Lo grave no era perder la conexión —eso pasa— sino que un panel congelado y uno sano
  // se vieran idénticos durante una carrera.
  //
  // El test no persigue la forma del `catch`: eso se puede reescribir de diez maneras. Persigue
  // las tres piezas sin las cuales no hay aviso posible.
  assert.ok(js.includes("lastPollError"), "El error del poll no se guarda en ningún lado");
  assert.ok(js.includes("renderLinkState"), "Nadie dibuja el estado del contacto con el motor");
  assert.ok(html.includes('id="link-down"'), "app.js dibuja la banda de contacto perdido pero index.html no la tiene");
});
