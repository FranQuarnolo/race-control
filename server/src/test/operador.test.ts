import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";

/**
 * Invariantes del panel del operador, mismo espíritu que `panel.test.ts`: cosas que no fallan,
 * simplemente no pasan. La tabla de historial (1.4) y el menú kebab de la tabla de admins viven en
 * HTML/JS/CSS a mano, sin build que los conecte, así que un id mal escrito o una clase sin regla
 * no los denuncia nadie hasta que alguien abre esa pantalla con los ojos puestos ahí.
 *
 * Se valida `dist/`, que es lo que se le sirve al navegador, y no `src/`.
 */

const DIST = path.join(__dirname, "..");
const PORTAL = path.join(DIST, "portal", "public");

function leer(...tramos: string[]): string {
  return fs.readFileSync(path.join(...tramos), "utf-8");
}

function sinComentarios(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Para buscar llamadas reales a `confirm()`/`alert()`/`prompt()`: sin esto, un comentario que
 * solo los MENCIONA (como el que explica por qué ya no se usan) los hace aparecer igual. */
function sinComentariosJs(js: string): string {
  return js.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

test("todo id que operador.js busca con $() existe en operador.html", () => {
  const js = leer(PORTAL, "operador.js");
  const html = leer(PORTAL, "operador.html");

  const buscados = new Set<string>();
  for (const [, id] of js.matchAll(/\$\(\s*"([\w-]+)"\s*\)/g)) buscados.add(id);

  const existentes = new Set<string>();
  for (const [, id] of html.matchAll(/\bid="([\w-]+)"/g)) existentes.add(id);

  const faltantes = [...buscados].filter((id) => !existentes.has(id)).sort();
  assert.deepEqual(
    faltantes,
    [],
    `operador.js le pide al DOM ids que operador.html no tiene. $() devuelve null y la pantalla ` +
      `se rompe entera al abrirse: ${faltantes.join(", ")}`
  );

  assert.ok(buscados.size > 15, `Solo encontré ${buscados.size} llamadas a $(): el regex quedó viejo`);
});

/**
 * El menú de tres puntitos y las acciones de la fila del historial se dibujan en JS, con clases
 * escritas a mano (`btn-kebab`, `menu-fila`, `menu-item`, `pastilla`). Una errata en alguna de esas
 * no rompe nada: el elemento se dibuja igual, sin formato, en medio de una tabla formateada — el
 * mismo riesgo que `panel.test.ts` ya cubre del lado del panel de carrera.
 */
test("las clases que arma operador.js para el kebab y el historial tienen regla en portal.css", () => {
  const css = sinComentarios(leer(PORTAL, "portal.css"));
  const conRegla = new Set<string>();
  for (const [, clase] of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) conRegla.add(clase);

  const esperadas = [
    "btn-kebab",
    "menu-fila",
    "menu-item",
    "peligro",
    "compacto",
    "arming",
    "pastilla",
    "en-progreso",
    "terminado",
  ];
  const sinRegla = esperadas.filter((c) => !conRegla.has(c));
  assert.deepEqual(
    sinRegla,
    [],
    `portal.css no tiene ninguna regla para estas clases que operador.js arma en vivo: ${sinRegla.join(", ")}`
  );
});

/**
 * Las tres acciones destructivas o repetidas del día a día (Cobré, Editar, Desactivar/Reactivar)
 * tienen que seguir en el menú. "Ver historial" y "Clave nueva" se mudaron: la primera adentro del
 * modal de Servidores (una pestaña por servidor), la segunda adentro del modal de Editar. Que
 * desaparezcan del menú es intencional — perder a `abrirServidores` de la columna "Servidores" NO
 * lo es, y es lo que este test cubre del otro lado.
 */
test("el menú kebab conserva Cobré/Editar/Desactivar, y la columna Servidores abre su modal", () => {
  const js = leer(PORTAL, "operador.js");

  assert.ok(/toggleRowMenu\(/.test(js), "falta `toggleRowMenu`: la tabla de admins quedó con los botones sueltos");
  for (const accion of ["abrirEdicion(admin)", "cobrar(admin)", "alternar(admin)"]) {
    assert.ok(js.includes(accion), `el menú de la fila no llama a \`${accion}\``);
  }
  for (const mudada of ["nuevaClave(admin)", "abrirHistorial(admin)", "agregarServidor(admin)"]) {
    assert.ok(!js.includes(mudada), `\`${mudada}\` ya no debería llamarse desde la fila: se mudó a un modal`);
  }
  assert.ok(js.includes("abrirServidores(admin)"), "la columna Servidores no abre el modal de servidores");
});

/**
 * El historial es por servidor, no por liga, desde que una liga puede tener varios (`fsl` con
 * Spa/México/Interlagos a la vez) — ver `filaDeAdmin` en `server.ts`. El borrado pide confirmación
 * de dos clicks, igual criterio que el kick del panel: una sesión borrada no se recupera.
 */
test("el historial habla con /ligas/:id/servidores/:servidorId/eventos y el borrado pide dos clicks", () => {
  const js = leer(PORTAL, "operador.js");
  const server = leer(DIST, "portal", "server.js");

  assert.ok(
    server.includes("/ligas/:id/servidores/:servidorId/eventos"),
    "el portal no expone la ruta del historial por servidor"
  );
  assert.ok(/\/servidores\/.*\/eventos/.test(js), "operador.js nunca pega contra la ruta de historial por servidor");
  assert.ok(/"DELETE"/.test(js), "el borrado de un evento no manda método DELETE");

  // Primer click arma, segundo ejecuta: sin la ventana de armado, el primer click ya borraría.
  assert.ok(/armedDelete/.test(js), "no hay estado de armado para el borrado: falta la doble confirmación");
  assert.ok(/4000/.test(js), "el armado del borrado no se desarma solo a los 4 segundos, como el kick del panel");
});

/**
 * Borrar un servidor entero (no una fila de historial) corta de verdad la conexión con el hosting
 * y para el worker — a diferencia del borrado de un evento, acá un doble click por fila no tiene
 * sentido porque el botón aparece una sola vez por pestaña, así que usa el modal de confirmación
 * genérico (mismo que `alternar` para desactivar una cuenta) en vez del armado por timeout.
 */
test("borrar un servidor pasa por el modal de confirmación y pega DELETE a /ligas/:id/servidores/:servidorId", () => {
  const js = leer(PORTAL, "operador.js");
  const server = leer(DIST, "portal", "server.js");

  assert.ok(/operadorApi\.delete\(\s*"\/ligas\/:id\/servidores\/:servidorId"/.test(server), "el portal no expone la ruta de borrado de un servidor");
  assert.ok(js.includes("function borrarServidor("), "falta `borrarServidor` en operador.js");
  assert.ok(/borrarServidor\([^)]*\)\s*\{[\s\S]*?confirmar\(/.test(js), "borrarServidor no pasa por el modal de confirmación genérico");
  assert.ok(
    /borrarServidor\([^)]*\)\s*\{[\s\S]*?"\/api\/operador\/ligas\/"[\s\S]*?\/servidores\/"[\s\S]*?"DELETE"/.test(js),
    "borrarServidor no manda DELETE a /ligas/:id/servidores/:servidorId"
  );
});

test("renombrar un servidor pega PATCH a /ligas/:id/servidores/:servidorId y no reinicia el worker", () => {
  const js = leer(PORTAL, "operador.js");
  const server = leer(DIST, "portal", "server.js");

  assert.ok(
    /operadorApi\.patch\(\s*"\/ligas\/:id\/servidores\/:servidorId"/.test(server),
    "el portal no expone la ruta de renombre de un servidor"
  );
  assert.ok(js.includes("function renombrarServidor("), "falta `renombrarServidor` en operador.js");
  assert.ok(
    /renombrarServidor\([^)]*\)\s*\{[\s\S]*?"\/api\/operador\/ligas\/"[\s\S]*?\/servidores\/"[\s\S]*?"PATCH"/.test(js),
    "renombrarServidor no manda PATCH a /ligas/:id/servidores/:servidorId"
  );
  // El nombre no viaja en `StartMessage`: si alguien agrega un restart acá, es trabajo de más que
  // además le corta la carrera en curso al admin por cambiar un rótulo.
  const handler = server.slice(server.indexOf('operadorApi.patch("/ligas/:id/servidores/:servidorId"'));
  const cuerpo = handler.slice(0, handler.indexOf("});"));
  assert.ok(!/supervisor\.(restart|stop|start)\(/.test(cuerpo), "renombrar un servidor no tiene por qué tocar el worker");
});

/**
 * El modal de Servidores reemplazó al `prompt()`/`alert()` de "+ agregar servidor" y al `<dialog>`
 * nativo de detalle de evento: todos los modales de este panel son `.modal-backdrop`/`.modal`, el
 * mismo sistema que ya usa el panel de carrera (`api/public/styles.css`).
 */
test("los modales de operador.html son .modal-backdrop, no <dialog> ni alert/confirm/prompt nativos", () => {
  const js = sinComentariosJs(leer(PORTAL, "operador.js"));
  const html = leer(PORTAL, "operador.html");

  assert.ok(!/<dialog/.test(html), "quedó un <dialog> nativo en operador.html");
  assert.ok(!/\bconfirm\(/.test(js), "operador.js todavía usa el confirm() nativo del navegador");
  assert.ok(!/\bprompt\(/.test(js), "operador.js todavía usa el prompt() nativo del navegador");
  assert.ok(!/\balert\(/.test(js), "operador.js todavía usa el alert() nativo del navegador");

  for (const id of ["modal-editar", "modal-servidores", "modal-evento", "modal-confirmar"]) {
    assert.ok(html.includes(`id="${id}"`), `falta el modal #${id} en operador.html`);
  }
  assert.ok(/verDetalle\(/.test(js), "falta `verDetalle`: el botón Ver de la fila no abre nada");
  assert.ok(/function confirmar\(/.test(js), "falta el modal de confirmación genérico que reemplaza a confirm()");
});
