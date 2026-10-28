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
 * Las cuatro acciones que antes eran botones sueltos (Editar, Cobré, Desactivar/Reactivar, Clave
 * nueva) tienen que seguir estando, ahora adentro del menú — perder una en la migración al kebab
 * no se nota en pantalla hasta que alguien la busca y no está.
 */
test("el menú kebab de la tabla de admins conserva las cuatro acciones y suma el historial", () => {
  const js = leer(PORTAL, "operador.js");

  assert.ok(/toggleRowMenu\(/.test(js), "falta `toggleRowMenu`: la tabla de admins quedó con los botones sueltos");
  for (const accion of ["abrirEdicion(admin)", "cobrar(admin)", "alternar(admin)", "nuevaClave(admin)", "abrirHistorial(admin)"]) {
    assert.ok(js.includes(accion), `el menú de la fila no llama a \`${accion}\``);
  }
});

/**
 * El historial se lee y se borra contra `/api/operador/ligas/:id/eventos`, y el borrado pide
 * confirmación de dos clicks — igual criterio que el kick del panel: una sesión borrada no se
 * recupera, así que no puede salir de un click fallido en una tabla que puede repintarse sola.
 */
test("el historial habla con /api/operador/ligas/:id/eventos y el borrado pide dos clicks", () => {
  const js = leer(PORTAL, "operador.js");
  const server = leer(DIST, "portal", "server.js");

  assert.ok(server.includes("/ligas/:id/eventos"), "el portal no expone la ruta del historial");
  assert.ok(js.includes("/eventos"), "operador.js nunca pega contra la ruta del historial");
  assert.ok(/"DELETE"/.test(js), "el borrado de un evento no manda método DELETE");

  // Primer click arma, segundo ejecuta: sin la ventana de armado, el primer click ya borraría.
  assert.ok(/armedDelete/.test(js), "no hay estado de armado para el borrado: falta la doble confirmación");
  assert.ok(/4000/.test(js), "el armado del borrado no se desarma solo a los 4 segundos, como el kick del panel");
});

test("el modal de detalle existe y se abre desde el botón Ver de cada fila", () => {
  const js = leer(PORTAL, "operador.js");
  const html = leer(PORTAL, "operador.html");

  assert.ok(html.includes('<dialog id="modal-evento">'), "falta el <dialog> de detalle en operador.html");
  assert.ok(/verDetalle\(/.test(js), "falta `verDetalle`: el botón Ver de la fila no abre nada");
  assert.ok(/showModal\(\)/.test(js), "nadie llama a `showModal()`: el <dialog> nunca se muestra");
});
