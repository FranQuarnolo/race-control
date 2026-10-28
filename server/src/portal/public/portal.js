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
async function api(path, body, method) {
  const options = { headers: { "X-RC-Request": "1" } };
  if (body !== undefined) {
    options.method = method || "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  } else if (method) {
    options.method = method;
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

/**
 * Convierte en link los "escribinos" de la página.
 *
 * El producto mandaba a escribir en seis pantallas distintas sin que existiera una dirección en
 * ningún lado. Tres marcas, y cada página elige las que necesita:
 *
 * - `data-contacto` — la palabra que se vuelve link ("Escribinos").
 * - `data-si-contacto` — se muestra solo si hay dirección configurada.
 * - `data-sin-contacto` — se muestra solo si NO la hay, para que la pantalla diga algo verdadero
 *   en vez de mandar a escribir a ningún lado.
 *
 * El href se usa tal cual viene de la configuración —un `mailto:`, un Discord, un formulario— y se
 * rechaza cualquier cosa que no sea uno de esos tres esquemas: el valor lo pone quien despliega,
 * pero un `javascript:` ahí adentro ejecutaría en la pantalla de ingreso de todos.
 */
const CONTACT_SCHEMES = ["mailto:", "https://", "http://"];

function pintarContacto(contacto) {
  const valido = typeof contacto === "string" && CONTACT_SCHEMES.some((p) => contacto.startsWith(p));

  for (const si of document.querySelectorAll("[data-si-contacto]")) si.hidden = !valido;
  for (const no of document.querySelectorAll("[data-sin-contacto]")) no.hidden = valido;

  if (!valido) return;
  for (const marca of document.querySelectorAll("[data-contacto]")) {
    const link = document.createElement("a");
    link.href = contacto;
    link.textContent = marca.textContent;
    if (contacto.startsWith("http")) {
      link.target = "_blank";
      link.rel = "noopener";
    }
    marca.replaceWith(link);
  }
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
