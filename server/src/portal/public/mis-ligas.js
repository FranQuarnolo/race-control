// Elegir liga. Solo se llega acá teniendo más de una: con una sola, el login manda directo
// adentro, porque una lista de un elemento es una pantalla cuyo único propósito es un click más.

const ETIQUETAS_ESTADO = {
  running: "en marcha",
  starting: "arrancando",
  stopped: "detenida",
  failed: "con problemas",
};

/** El aviso de cuota: lo decide el servidor y acá solo se redacta. */
function textoDeCuota(sub) {
  if (!sub || sub.state === "al-dia" || sub.state === "sin-cuota") return null;
  if (sub.state === "vencida") {
    const dias = Math.abs(sub.daysLeft);
    return "Tu cuota venció hace " + dias + (dias === 1 ? " día" : " días") +
      ". Regularizala para que tu liga siga activa.";
  }
  if (sub.daysLeft <= 0) return "Tu cuota vence hoy.";
  return "Tu cuota vence en " + sub.daysLeft + (sub.daysLeft === 1 ? " día" : " días") + ".";
}

async function iniciar() {
  const me = await api("/api/portal/me");
  $("version").textContent = me.version || "";
  pintarContacto(me.contact);

  if (!me.authenticated) {
    window.location.href = "/login?volver=%2Fmis-ligas";
    return;
  }
  if (me.role === "operador") {
    window.location.href = "/operador";
    return;
  }

  const aviso = textoDeCuota(me.subscription);
  if (aviso) {
    const el = $("aviso-cuota");
    el.textContent = aviso;
    el.classList.add(me.subscription.state === "vencida" ? "grave" : "leve");
    el.hidden = false;
  }

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
    window.location.href = "/";
  });
}

iniciar().catch((err) => mostrarError(err.message));
