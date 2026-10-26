// Paso 2 del alta: pegar un renglón y esperar.
//
// La pantalla no tiene botón de "probar" y no muestra un diagnóstico de cuatro ítems. Eso sigue
// existiendo —adentro del panel, en Conexión— pero no es lo primero que ve alguien que nunca usó
// el producto: ahí lo único que importa es si ya está llegando o todavía no.

const SLUG = window.location.pathname.split("/").pop();
const INTERVALO_MS = 2000;

function marcarConectado() {
  const estado = $("estado");
  estado.textContent = "¡Llegó! Tu servidor ya está hablando con Race Control.";
  estado.style.color = "var(--green)";
  // Un rato para leer el mensaje, y después al panel. Sin la espera, la pantalla "se va sola"
  // justo cuando el admin estaba leyendo si había funcionado.
  // Con la barra final: sin ella el portal tiene que redirigir, y el panel resolvería sus
  // archivos relativos contra `/l/` hasta que esa redirección llegue.
  setTimeout(() => {
    window.location.href = "/l/" + SLUG + "/";
  }, 1800);
}

/**
 * Sin dirección no hay nada que pegar, y mostrar media —`:30000`— sería peor que no mostrar nada:
 * se ve como un dato bueno, el admin lo copia, reinicia su servidor y no llega nunca un paquete,
 * sin un solo síntoma que apunte a la causa. Es algo que tiene que arreglar quien opera el
 * servicio, así que el único mensaje honesto es decirlo y no mandarlo a probar cosas.
 */
function sinDireccion(contacto) {
  $("send-address").textContent = "Todavía no hay dirección";
  $("btn-copiar").hidden = true;
  const estado = $("estado");
  // La dirección va escrita adentro de la frase y no como link: el mensaje se inserta con
  // textContent, que es la regla del proyecto para todo lo que no sea nuestro.
  const comoAvisar = contacto
    ? "escribinos a " + String(contacto).replace(/^mailto:/, "")
    : "avisale a quien te dio el acceso";
  estado.textContent =
    "Esta liga todavía no tiene una dirección pública asignada. Es algo de nuestro lado, no tuyo: " +
    comoAvisar + " y lo resolvemos. Mientras tanto no hay nada que configurar en tu hosting.";
  estado.style.color = "var(--yellow)";
}

async function revisar() {
  const liga = await api("/api/portal/liga/" + encodeURIComponent(SLUG));
  $("link-panel").href = "/l/" + liga.slug + "/";
  document.title = liga.name + " — Race Control";

  if (!liga.sendAddress) {
    sinDireccion(liga.contact);
    return;
  }
  $("send-address").textContent = liga.sendAddress;

  if (liga.receiving) {
    marcarConectado();
    return;
  }
  setTimeout(() => revisar().catch((err) => mostrarError(err.message)), INTERVALO_MS);
}

$("btn-copiar").addEventListener("click", async () => {
  const texto = $("send-address").textContent;
  try {
    await navigator.clipboard.writeText(texto);
    $("btn-copiar").textContent = "Copiado";
  } catch (_) {
    // Sin permiso de portapapeles (pasa en HTTP plano): seleccionarlo ya es la mitad del trabajo.
    const rango = document.createRange();
    rango.selectNodeContents($("send-address"));
    const seleccion = window.getSelection();
    seleccion.removeAllRanges();
    seleccion.addRange(rango);
    $("btn-copiar").textContent = "Copialo con Ctrl+C";
  }
});

revisar().catch((err) => mostrarError(err.message));
