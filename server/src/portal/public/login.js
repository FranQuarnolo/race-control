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

alEnviar($("form"), async () => {
  const res = await api("/api/portal/login", {
    email: $("email").value,
    password: $("password").value,
  });
  window.location.href = volverPedido() || res.destino || "/mis-ligas";
});
