// Login.
//
// El destino sale de `?volver=`, que lo pone el portal cuando alguien entra directo a la URL de
// su liga sin sesión: después de entrar aterriza donde quería ir y no en una lista intermedia.
// Solo se aceptan rutas propias — un `volver` con host adentro convierte el login en un redirector
// abierto, que es la forma clásica de armar un phishing con un dominio legítimo.

function destino() {
  const volver = new URLSearchParams(window.location.search).get("volver");
  if (volver && /^\/[^/\\]/.test(volver)) return volver;
  return "/";
}

alEnviar($("form"), async () => {
  await api("/api/portal/login", {
    email: $("email").value,
    password: $("password").value,
  });
  window.location.href = destino();
});
