// Login.
//
// El destino lo decide el servidor —operador a su panel, admin de una sola liga directo adentro—
// salvo que haya un `?volver=`, que lo pone el portal cuando alguien entra directo a la URL de su
// liga sin sesión: ahí aterriza donde quería ir y no en una lista intermedia.
//
// Solo se aceptan rutas propias: un `volver` con host adentro convierte el login en un redirector
// abierto, que es la forma clásica de armar un phishing con un dominio legítimo.

function volverPedido() {
  const volver = new URLSearchParams(window.location.search).get("volver");
  return volver && /^\/[^/\\]/.test(volver) ? volver : null;
}

// La dirección de contacto del pie. Se pide aparte del submit porque hace falta ANTES de que
// alguien intente entrar: quien perdió la contraseña necesita el link, no el formulario. Si el
// pedido falla no se avisa nada — un error acá no le impide a nadie loguearse, y un cartel rojo en
// la pantalla de ingreso por un renglón del pie asusta más de lo que informa.
api("/api/portal/me")
  .then((me) => pintarContacto(me.contact))
  .catch(() => {});

// Ver la contraseña mientras se escribe. El foco vuelve al campo para no interrumpir a quien está
// tipeando, y el botón queda al final del tab order del formulario, antes de "Entrar".
$("ver-password").addEventListener("click", () => {
  const campo = $("password");
  const boton = $("ver-password");
  const mostrando = campo.type === "text";
  campo.type = mostrando ? "password" : "text";
  boton.textContent = mostrando ? "Ver" : "Ocultar";
  boton.setAttribute("aria-pressed", String(!mostrando));
  boton.setAttribute("aria-label", mostrando ? "Mostrar la contraseña" : "Ocultar la contraseña");
  boton.title = boton.getAttribute("aria-label");
  campo.focus();
});

alEnviar($("form"), async () => {
  const res = await api("/api/portal/login", {
    email: $("email").value,
    password: $("password").value,
  });
  window.location.href = volverPedido() || res.destino || "/mis-ligas";
});
