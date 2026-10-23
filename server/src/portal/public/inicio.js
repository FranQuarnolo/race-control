// Pantalla de inicio: landing para quien no entró, lista de ligas para quien sí.
//
// Es una sola URL (`/`) y no dos porque para el admin "entrar a Race Control" es un solo lugar:
// si está logueado ve sus ligas, si no ve qué es esto. Mandarlo a /login y después redirigirlo
// agrega un rebote visible sin resolver nada.

const ETIQUETAS_ESTADO = {
  running: "en marcha",
  starting: "arrancando",
  stopped: "detenida",
  failed: "con problemas",
};

async function iniciar() {
  const me = await api("/api/portal/me");
  document.getElementById("version").textContent = me.version || "";

  if (!me.authenticated) {
    $("landing").hidden = false;
    $("btn-login").addEventListener("click", () => {
      window.location.href = "/login";
    });
    return;
  }

  $("mis-ligas").hidden = false;
  const lista = $("lista");
  if (!me.leagues.length) $("sin-ligas").hidden = false;

  for (const liga of me.leagues) {
    const a = document.createElement("a");
    a.className = "liga";
    a.href = "/l/" + liga.slug + "/";

    const nombre = document.createElement("span");
    nombre.className = "nombre";
    nombre.textContent = liga.name;

    const estado = document.createElement("span");
    estado.className = "estado " + liga.status;
    estado.textContent = ETIQUETAS_ESTADO[liga.status] || liga.status;
    // El motivo de la caída es lo único útil cuando una liga no arranca: sin esto el admin ve
    // "con problemas" y no tiene a dónde ir.
    if (liga.lastError) estado.title = liga.lastError;

    a.appendChild(nombre);
    a.appendChild(estado);
    lista.appendChild(a);
  }

  $("btn-logout").addEventListener("click", async () => {
    await api("/api/portal/logout", {});
    window.location.reload();
  });
}

iniciar().catch((err) => mostrarError(err.message));
