// Pantallas del portal. JS vanilla, igual que el panel: sin build ni framework.
//
// Regla transversal, la misma del panel: todo texto que no sea nuestro se inserta con
// textContent, nunca con innerHTML. Acá entra el nombre de una liga, que lo escribe una persona.

function $(id) {
  return document.getElementById(id);
}

/**
 * Toda request del portal lleva `X-RC-Request: 1`.
 *
 * Es la mitad de la defensa contra CSRF: un `<form>` de otro sitio apuntado a este servidor no
 * puede agregar headers propios, así que sin esta marca el pedido se rechaza. La otra mitad es
 * la cookie `SameSite=Strict` y el chequeo de `Origin` del lado del servidor.
 */
async function api(path, body) {
  const options = { headers: { "X-RC-Request": "1" } };
  if (body !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    // respuesta sin JSON: nos quedamos con el código
  }
  if (!res.ok) throw new Error((data && data.error) || "Algo falló (HTTP " + res.status + ")");
  return data;
}

function mostrarError(mensaje) {
  const el = $("error");
  el.textContent = mensaje;
  el.hidden = false;
}

function limpiarError() {
  $("error").hidden = true;
}

/** Envuelve un submit: desactiva el botón mientras dura y muestra el error si lo hay. */
function alEnviar(form, handler) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    limpiarError();
    const boton = form.querySelector("button");
    boton.disabled = true;
    try {
      await handler();
    } catch (err) {
      mostrarError(err.message);
      boton.disabled = false;
    }
  });
}
