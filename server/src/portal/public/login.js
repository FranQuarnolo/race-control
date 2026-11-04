// Login.
//
// El destino lo decide **el servidor**, siempre: operador a su panel, admin de una sola liga
// directo adentro, y el `?volver=` solo si el que entró tiene acceso a lo que ese `volver` pide.
// Acá no se evalúa nada — el `volver` se manda tal cual y se obedece la respuesta.
//
// Antes esta pantalla resolvía el destino sola y le daba prioridad al `volver` sobre lo que
// contestaba el servidor. El `volver` lo escribe el portal cuando alguien cae sin sesión en la URL
// de su liga, pero queda pegado en la URL del login y sobrevive a quién entra después: con otro
// usuario te mandaba a la liga del anterior y te recibía un "No tenés acceso a esta liga." con la
// sesión recién creada y perfectamente buena. Parecía que el login no andaba. El navegador no
// puede decidir esto: no sabe a qué ligas tiene acceso nadie. Ver `destinoDeLogin` en
// `portal/server.ts`.

function volverPedido() {
  return new URLSearchParams(window.location.search).get("volver") || "";
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
    volver: volverPedido(),
  });
  window.location.href = res.destino || "/mis-ligas";
});
