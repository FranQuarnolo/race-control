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
const CAMPOS_DERIVADOS = [
  "position",
  "brand",
  "brandLogo",
  "telemetryStale",
  "pingMs",
  "telemetry",
  "gapAheadMs",
  "gapLeaderMs",
  "cuts",
  "inPit",
];

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
const CAMPOS_DE_ESTADO = ["lapsDown", "pitZone", "catalogued"];

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

/**
 * Clases que el HTML nombra y que ninguna regla de la hoja alcanza.
 *
 * Es el `$("id")` que devuelve `null`, pero del lado del estilo: el navegador acepta cualquier
 * `class` que le pongas, no existe el concepto de clase inválida, y el resultado es contenido sin
 * formato en medio de una pantalla formateada. Pasó al mudar el switch de modo al cajón de Conexión:
 * el manual nuevo salió con `<ol class="pasos">` y `<p class="muted sub">` antes de que esas reglas
 * existieran, y la única forma de enterarse era abrir esa pantalla con los ojos puestos ahí.
 *
 * Se perdonan dos familias, porque en las dos la clase no está para pintar nada. Las de estado, que
 * el JS prende y apaga (`classList.toggle`), y las que son puro gancho de selección
 * (`querySelectorAll(".wizard-step")`): esa existe para que el JS encuentre los pasos del asistente,
 * y que no tenga una sola declaración de estilo es lo correcto, no un olvido.
 */
test("toda clase del panel tiene al menos una regla que la alcance", () => {
  const html = leer(PANEL, "index.html");
  const css = sinComentarios(leer(PANEL, "styles.css"));
  const js = leer(PANEL, "app.js");

  const enHtml = new Set<string>();
  for (const [, lista] of html.matchAll(/\bclass="([^"]+)"/g)) {
    for (const clase of lista.trim().split(/\s+/)) enHtml.add(clase);
  }

  const conRegla = new Set<string>();
  for (const [, clase] of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) conRegla.add(clase);
  // Las que el JS pone y saca viven en el mismo saco: si el JS la nombra, alguien la pensó.
  for (const [, clase] of js.matchAll(/classList\.(?:toggle|add|remove)\(\s*"([\w-]+)"/g)) conRegla.add(clase);
  // Y las que son gancho de selección y no formato.
  for (const [, clase] of js.matchAll(/querySelectorAll?\(\s*"\.([\w-]+)"/g)) conRegla.add(clase);

  const huerfanas = [...enHtml].filter((c) => !conRegla.has(c)).sort();
  assert.deepEqual(
    huerfanas,
    [],
    `index.html usa clases que no tienen una sola regla en styles.css. No hay error ni consola: ` +
      `eso se ve como contenido sin formato y nada más: ${huerfanas.join(", ")}`
  );
});

/**
 * Lo mismo, pero para las clases que arma el JS.
 *
 * El test de arriba solo ve `index.html`, y la torre de tiempos no está en el HTML: cada fila la
 * construye `createCarRow` en vivo. Ahí viven el menú de tres puntitos, el "PIT" de la columna de
 * velocidad y los badges, todos con clases escritas a mano en un string. Una errata en ese string
 * no rompe nada: el elemento se dibuja igual, sin formato, en medio de una tabla formateada.
 */
test("toda clase que el panel arma en JS tiene al menos una regla", () => {
  const js = leer(PANEL, "app.js");
  const css = sinComentarios(leer(PANEL, "styles.css"));

  const conRegla = new Set<string>();
  for (const [, clase] of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) conRegla.add(clase);

  const asignadas = new Set<string>();
  for (const [, lista] of js.matchAll(/\.className\s*=\s*"([^"]*)"/g)) {
    for (const clase of lista.trim().split(/\s+/)) if (clase) asignadas.add(clase);
  }

  const huerfanas = [...asignadas].filter((c) => !conRegla.has(c)).sort();
  assert.deepEqual(
    huerfanas,
    [],
    `app.js le pone estas clases a elementos que crea, y la hoja no tiene ninguna regla que las ` +
      `alcance. El elemento se dibuja igual, sin estilo y sin un solo error: ${huerfanas.join(", ")}`
  );

  assert.ok(asignadas.size > 10, `Solo encontré ${asignadas.size} clases en JS: el regex quedó viejo`);
});

/**
 * Acá vivía "el modo sombra sigue siendo visible fuera del cajón de conexión", que exigía un cartel
 * en la barra mientras el motor estuviera en sombra. El cartel se sacó por pedido explícito —el
 * modo vive entero adentro del cajón de Conexión—, así que el test se fue con él.
 *
 * El riesgo que cubría no desapareció: se puede correr una carrera entera en sombra sin notarlo,
 * con las sanciones anotándose y nadie cobrándolas, y el panel viéndose idéntico a uno que sanciona
 * de verdad. Si eso pasa en una fecha real, lo que hay que reponer es un aviso en el encabezado de
 * la torre de tiempos —junto a `chip-sin-app`— y este test detrás.
 */

/**
 * Todo elemento de la barra que arranca escondido y se muestra por condición tiene que poder
 * esconderse de verdad.
 *
 * `[hidden]` es `display: none` por hoja del navegador, y cualquier `display` propio en una regla
 * de clase le gana. Este archivo ya pagó ese bug entero: un `display: flex` incondicional dejó el
 * modal de primer arranque visible para siempre. El botón de Salir es el caso vivo —es `flex` y
 * arranca `hidden`—: sin el seguro promete una sesión que en modo local no existe.
 */
test("lo que arranca escondido en la barra se puede esconder", () => {
  const css = sinComentarios(leer(PANEL, "styles.css"));

  assert.ok(
    /\.btn-salir\[hidden\]\s*{[^}]*display:\s*none/.test(css),
    "falta el seguro `.btn-salir[hidden] { display: none }`: el `display: flex` de la clase le gana al atributo"
  );
});

/**
 * Control de carrera y Sanciones son secciones, no acciones.
 *
 * Antes se dibujaban con el mismo `#20242e` que usan los botones de la barra en hover, así que la
 * pestaña activa y un botón cualquiera eran indistinguibles: tres cosas que abren un cajón y dos
 * que cambian la pantalla entera, todas iguales. El grupo tiene que tener forma propia —el marco
 * del control segmentado— y la pestaña activa tiene que distinguirse de la inactiva.
 */
test("las pestañas de sección se dibujan distinto de los botones de acción", () => {
  const css = sinComentarios(leer(PANEL, "styles.css"));

  const contenedor = /nav\.views\s*{([^}]*)}/.exec(css);
  assert.ok(contenedor, "no hay regla para `nav.views`");
  assert.ok(
    /background\s*:/.test(contenedor![1]) && /border\s*:/.test(contenedor![1]),
    "`nav.views` no tiene marco propio: sin fondo y borde el grupo no se lee como un control aparte"
  );

  assert.ok(
    /nav\.views\s+a\[aria-current="page"\]\s*{[^}]*background\s*:/.test(css),
    "la pestaña activa no se distingue de la inactiva"
  );
});

/**
 * Cada tipo de incidente del motor tiene que estar clasificado en el panel.
 *
 * La bandeja agrupa por piloto y lleva dos cuentas, "Cuts" y "Choques". Esa división no está en el
 * backend: vive en dos arreglos de `app.js` que listan tipos a mano. Entonces el día que alguien
 * agregue un `IncidentKind` nuevo —que es exactamente lo que va a pasar, el union ya creció tres
 * veces— el panel lo va a mandar a "Otros" y le va a poner de título la palabra "incidente",
 * sin romperse y sin avisar. Un tipo nuevo de infracción grave contándose como "otro" es un
 * comisario mirando la cifra equivocada.
 *
 * Por eso el test lee el union de TypeScript del motor, que es la única lista verdadera, y exige
 * que cada miembro aparezca o en una de las dos cuentas o en la tabla de títulos. Es la misma idea
 * que los otros tests de este archivo: ir a buscar lo que no falla ruidosamente.
 */
test("el panel clasifica todos los tipos de incidente del motor", () => {
  const motor = leer(DIST, "..", "src", "incident", "incidentEngine.ts");
  const union = /export type IncidentKind =([\s\S]*?);/.exec(motor);
  assert.ok(union, "no se encontró el union `IncidentKind` en incidentEngine.ts");
  const tipos = (union![1].match(/"([^"]+)"/g) || []).map((t) => t.slice(1, -1));
  assert.ok(tipos.length >= 7, `se leyeron ${tipos.length} tipos del motor, algo falló al parsear`);

  const app = leer(PANEL, "app.js");
  const listado = (nombre: string): string[] => {
    const bloque = new RegExp("const " + nombre + "\\s*=\\s*\\[([^\\]]*)\\]").exec(app);
    assert.ok(bloque, "falta la constante `" + nombre + "` en app.js");
    return (bloque![1].match(/"([^"]+)"/g) || []).map((t) => t.slice(1, -1));
  };
  const etiquetas = /const INCIDENT_KIND_LABELS\s*=\s*{([\s\S]*?)};/.exec(app);
  assert.ok(etiquetas, "falta `INCIDENT_KIND_LABELS` en app.js");

  const cuts = listado("CUT_KINDS");
  const choques = listado("CHOQUE_KINDS");

  for (const tipo of tipos) {
    const contado = cuts.indexOf(tipo) !== -1 || choques.indexOf(tipo) !== -1;
    const titulado =
      tipo === "car-contact" || new RegExp('(^|[{,\\s])"?' + tipo + '"?\\s*:').test(etiquetas![1]);
    assert.ok(
      contado || titulado,
      "`" + tipo + "` no está ni en las cuentas ni en los títulos: la bandeja lo va a mostrar como " +
        "\"incidente\" dentro de \"Otros\""
    );
    assert.ok(
      titulado,
      "`" + tipo + "` se cuenta pero no tiene título propio en `INCIDENT_KIND_LABELS`"
    );
  }

  for (const tipo of cuts.concat(choques)) {
    assert.ok(
      tipos.indexOf(tipo) !== -1,
      "`" + tipo + "` está clasificado en el panel pero el motor ya no lo emite"
    );
  }

  const cruce = cuts.filter((t) => choques.indexOf(t) !== -1);
  assert.equal(cruce.length, 0, "estos tipos suman en las dos cuentas: " + cruce.join(", "));
});
