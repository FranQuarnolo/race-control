// Panel de quien vende el servicio: quién tiene liga, quién está al día y quién hay que cortar.
//
// Igual que el resto del portal: JS vanilla, y todo texto que venga de una persona se inserta con
// textContent. Acá entran emails y nombres de liga que escribió alguien más.

const ETIQUETAS_ESTADO = {
  running: "en marcha",
  starting: "arrancando",
  stopped: "detenida",
  failed: "con problemas",
};

const ETIQUETAS_CUOTA = {
  "sin-cuota": "sin cargar",
  "al-dia": "al día",
  "por-vencer": "por vencer",
  vencida: "vencida",
};

let admins = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `2026-11-30` → `30/11/2026`. Sin `Date`: parsear una fecha sin hora la corre por zona horaria. */
function fecha(iso) {
  if (!iso) return "—";
  const partes = String(iso).slice(0, 10).split("-");
  return partes.length === 3 ? partes[2] + "/" + partes[1] + "/" + partes[0] : iso;
}

/** Fecha y hora de un ISO completo, en la zona de quien mira. */
function fechaHora(iso) {
  if (!iso) return "nunca";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function textoCuota(sub) {
  if (sub.state === "sin-cuota") return "sin cargar";
  if (sub.state === "vencida") {
    const dias = Math.abs(sub.daysLeft);
    return fecha(sub.paidUntil) + " · hace " + dias + (dias === 1 ? " día" : " días");
  }
  return fecha(sub.paidUntil) + " · en " + sub.daysLeft + (sub.daysLeft === 1 ? " día" : " días");
}

// --------------------------------------------------------------------------------- la tabla

function pintar() {
  const cuerpo = $("filas");
  cuerpo.textContent = "";
  $("sin-admins").hidden = admins.length > 0;
  $("tabla").hidden = admins.length === 0;

  for (const admin of admins) {
    const tr = el("tr", admin.active ? "" : "inactiva");

    // --- quién
    const tdQuien = el("td");
    tdQuien.appendChild(el("div", "principal", admin.email));
    tdQuien.appendChild(el("div", "muted", "alta " + fecha(admin.createdAt)));
    if (admin.note) {
      const nota = el("div", "nota", admin.note);
      tdQuien.appendChild(nota);
    }
    tr.appendChild(tdQuien);

    // --- la liga
    const tdLiga = el("td");
    if (!admin.leagues.length) {
      tdLiga.appendChild(el("span", "muted", "—"));
    } else {
      for (const liga of admin.leagues) {
        const enlace = el("a", "principal", liga.name);
        enlace.href = "/l/" + liga.slug + "/";
        tdLiga.appendChild(enlace);
        // Sin RC_PUBLIC_IP no hay Send Address que darle a nadie, y conviene que se vea acá:
        // es tu problema para resolver, no del admin, y él no tiene cómo enterarse.
        const dir = el("div", "muted mono", liga.sendAddress || "sin IP pública configurada");
        dir.title = liga.sendAddress
          ? "Send Address de esta liga"
          : "Falta RC_PUBLIC_IP: el admin no tiene qué pegar en su hosting";
        tdLiga.appendChild(dir);
      }
    }
    tr.appendChild(tdLiga);

    // --- el motor
    const tdMotor = el("td");
    for (const liga of admin.leagues) {
      const pastilla = el("span", "estado " + liga.status, ETIQUETAS_ESTADO[liga.status] || liga.status);
      if (liga.lastError) pastilla.title = liga.lastError;
      tdMotor.appendChild(pastilla);
    }
    if (!admin.leagues.length) tdMotor.appendChild(el("span", "muted", "—"));
    tr.appendChild(tdMotor);

    // --- la cuota
    const tdCuota = el("td");
    const cuota = el("span", "pastilla cuota-" + admin.subscription.state, textoCuota(admin.subscription));
    cuota.title = ETIQUETAS_CUOTA[admin.subscription.state];
    tdCuota.appendChild(cuota);
    tr.appendChild(tdCuota);

    tr.appendChild(el("td", "muted", fechaHora(admin.lastLoginAt)));

    // --- acciones
    const tdAcciones = el("td", "acciones");
    tdAcciones.appendChild(boton("Editar", "secundario", () => abrirEdicion(admin)));
    tdAcciones.appendChild(boton("Cobré", "secundario", () => cobrar(admin)));
    tdAcciones.appendChild(
      boton(admin.active ? "Desactivar" : "Reactivar", admin.active ? "peligro" : "secundario", () =>
        alternar(admin)
      )
    );
    tdAcciones.appendChild(boton("Clave nueva", "secundario", () => nuevaClave(admin)));
    tr.appendChild(tdAcciones);

    cuerpo.appendChild(tr);
  }
}

function boton(texto, clase, onClick) {
  const b = el("button", "compacto " + clase, texto);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function pintarResumen(udpLibres) {
  const vencidas = admins.filter((a) => a.active && a.subscription.state === "vencida").length;
  const porVencer = admins.filter((a) => a.active && a.subscription.state === "por-vencer").length;
  const activas = admins.filter((a) => a.active).length;

  const caja = $("resumen");
  caja.textContent = "";
  caja.appendChild(dato(String(activas), activas === 1 ? "liga activa" : "ligas activas"));
  caja.appendChild(dato(String(vencidas), "con la cuota vencida", vencidas > 0 ? "malo" : ""));
  caja.appendChild(dato(String(porVencer), "por vencer esta semana", porVencer > 0 ? "aviso" : ""));
  // El cupo no es un detalle: cada liga ocupa un puerto UDP de un rango declarado a mano en
  // fly.toml, y cuando se agota el alta falla. Mejor verlo venir que descubrirlo vendiendo.
  caja.appendChild(dato(String(udpLibres), udpLibres === 1 ? "lugar libre" : "lugares libres", udpLibres === 0 ? "malo" : ""));
}

function dato(valor, etiqueta, tono) {
  const caja = el("div", "dato " + (tono || ""));
  caja.appendChild(el("div", "valor", valor));
  caja.appendChild(el("div", "etiqueta", etiqueta));
  return caja;
}

// ------------------------------------------------------------------------------------ acciones

async function recargar() {
  const data = await api("/api/operador/admins");
  admins = data.admins;
  pintarResumen(data.udpLibres);
  pintar();
}

/** Un mes más desde donde estaba, o desde hoy si venía vencida o sin cargar. */
async function cobrar(admin) {
  const hoy = new Date();
  const base = admin.subscription.state === "al-dia" || admin.subscription.state === "por-vencer"
    ? new Date(admin.subscription.paidUntil + "T12:00:00")
    : hoy;
  base.setMonth(base.getMonth() + 1);
  const nueva = base.toISOString().slice(0, 10);

  if (!confirm("Marcar " + admin.email + " como paga hasta el " + fecha(nueva) + "?")) return;
  await api("/api/operador/admins/" + admin.id, { paidUntil: nueva });
  await recargar();
}

async function alternar(admin) {
  const texto = admin.active
    ? "Desactivar " + admin.email + "?\n\nSe apaga el motor de su liga y deja de entrar al panel.\n" +
      "Los datos (configuración, sanciones, registros) quedan intactos."
    : "Reactivar " + admin.email + "? Su liga vuelve a arrancar.";
  if (!confirm(texto)) return;
  await api("/api/operador/admins/" + admin.id, { active: !admin.active });
  await recargar();
}

async function nuevaClave(admin) {
  if (!confirm("Generar una contraseña nueva para " + admin.email + "?\n\nLa anterior deja de valer y se cierran sus sesiones.")) return;
  const res = await api("/api/operador/admins/" + admin.id + "/clave", {});
  mostrarCredenciales({ email: admin.email, password: res.password });
  await recargar();
}

// ------------------------------------------------------------------------------------- edición

/** Lo que había cuando se abrió el formulario, para mandar solo lo que de verdad cambió. */
let editando = null;

function abrirEdicion(admin) {
  // Una cuenta tiene una liga. El modelo admite varias y por eso esto toma la primera en vez de
  // asumir que existe: sin liga, la mitad de arriba del formulario no tiene qué editar.
  const liga = admin.leagues[0] || null;
  editando = { admin, liga };

  $("editar-quien").textContent = liga ? liga.name : admin.email;
  $("ed-leagueName").value = liga ? liga.name : "";
  $("ed-slug").value = liga ? liga.slug : "";
  $("ed-email").value = admin.email;
  $("ed-password").value = "";
  $("ed-leagueName").disabled = !liga;
  $("ed-slug").disabled = !liga;
  $("ed-aviso-nombre").hidden = true;
  $("ed-aviso-slug").hidden = true;
  $("error-editar").hidden = true;

  $("form-alta").hidden = true;
  $("form-editar").hidden = false;
  $("form-editar").scrollIntoView({ block: "center" });
  ($("ed-leagueName").disabled ? $("ed-email") : $("ed-leagueName")).focus();
}

function cerrarEdicion() {
  $("form-editar").hidden = true;
  editando = null;
}

/**
 * Guarda los tres pedazos por separado, porque son tres endpoints distintos.
 *
 * El orden importa para el peor caso: si algo falla a mitad de camino, lo que ya se guardó queda
 * guardado y el error dice cuál fue. Por eso la contraseña va última — es lo único que se muestra
 * una sola vez, y no conviene generarla para después fallar en algo y tener que repetir todo.
 */
async function guardarEdicion() {
  const { admin, liga } = editando;
  const nombre = $("ed-leagueName").value.trim();
  const slug = $("ed-slug").value.trim();
  const email = $("ed-email").value.trim();
  const clave = $("ed-password").value;

  if (liga && !nombre) throw new Error("La liga necesita un nombre.");
  if (!email) throw new Error("La cuenta necesita un email.");
  if (clave && clave.length < 8) throw new Error("La contraseña tiene que tener al menos 8 caracteres.");

  if (liga && (nombre !== liga.name || slug !== liga.slug)) {
    const cambio = {};
    if (nombre !== liga.name) cambio.name = nombre;
    if (slug !== liga.slug) cambio.slug = slug;
    await api("/api/operador/ligas/" + liga.id, cambio);
  }

  if (email.toLowerCase() !== admin.email.toLowerCase()) {
    await api("/api/operador/admins/" + admin.id, { email });
  }

  let password = "";
  if (clave) {
    const res = await api("/api/operador/admins/" + admin.id + "/clave", { password: clave });
    password = res.password;
  }

  cerrarEdicion();
  await recargar();
  // Si cambió algo de lo que el admin necesita para entrar, se le muestra junto para pasárselo.
  if (password || email.toLowerCase() !== admin.email.toLowerCase()) {
    mostrarCredenciales({ email, password: password || "la misma de antes" });
  }
}

// -------------------------------------------------------------------------------- credenciales

function mostrarCredenciales(creds) {
  $("cred-url").textContent = creds.loginUrl || window.location.origin + "/login";
  $("cred-user").textContent = creds.email;
  $("cred-pass").textContent = creds.password;
  $("credenciales").hidden = false;
  $("credenciales").scrollIntoView({ block: "center" });
}

function textoParaPegar() {
  return [
    "Race Control — acceso a tu liga",
    "",
    "Dirección:  " + $("cred-url").textContent,
    "Usuario:    " + $("cred-user").textContent,
    "Contraseña: " + $("cred-pass").textContent,
  ].join("\n");
}

// ------------------------------------------------------------------------------------- arranque

async function iniciar() {
  const me = await api("/api/portal/me");
  $("version").textContent = me.version || "";
  if (!me.authenticated) {
    window.location.href = "/login?volver=%2Foperador";
    return;
  }
  if (me.role !== "operador") {
    window.location.href = "/mis-ligas";
    return;
  }

  await recargar();

  $("btn-nueva").addEventListener("click", () => {
    cerrarEdicion();
    $("form-alta").hidden = !$("form-alta").hidden;
    if (!$("form-alta").hidden) $("leagueName").focus();
  });
  $("btn-cancelar-alta").addEventListener("click", () => {
    $("form-alta").hidden = true;
  });
  $("btn-cancelar-editar").addEventListener("click", cerrarEdicion);

  // Los dos avisos aparecen solo si el campo de verdad cambió: una advertencia que está siempre
  // en pantalla deja de leerse, y estos dos cambios sí tienen consecuencias que conviene ver.
  $("ed-leagueName").addEventListener("input", () => {
    $("ed-aviso-nombre").hidden = !editando?.liga || $("ed-leagueName").value.trim() === editando.liga.name;
  });
  $("ed-slug").addEventListener("input", () => {
    $("ed-aviso-slug").hidden = !editando?.liga || $("ed-slug").value.trim() === editando.liga.slug;
  });

  const formEditar = $("form-editar");
  formEditar.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("error-editar").hidden = true;
    const boton = formEditar.querySelector('button[type="submit"]');
    boton.disabled = true;
    try {
      await guardarEdicion();
    } catch (err) {
      const aviso = $("error-editar");
      aviso.textContent = err.message;
      aviso.hidden = false;
    } finally {
      boton.disabled = false;
    }
  });
  $("btn-cerrar-cred").addEventListener("click", () => {
    $("credenciales").hidden = true;
  });

  $("btn-copiar-cred").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(textoParaPegar());
      $("btn-copiar-cred").textContent = "Copiado";
      setTimeout(() => ($("btn-copiar-cred").textContent = "Copiar todo"), 1500);
    } catch (_) {
      // Sin permiso de portapapeles (o sin HTTPS): el texto está en pantalla para seleccionarlo.
      mostrarError("No pude copiar solo. Seleccioná el texto y copialo a mano.");
    }
  });

  $("btn-logout").addEventListener("click", async () => {
    await api("/api/portal/logout", {});
    window.location.href = "/";
  });

  const formAlta = $("form-alta");
  formAlta.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("error-alta").hidden = true;
    const boton = formAlta.querySelector('button[type="submit"]');
    boton.disabled = true;
    try {
      const res = await api("/api/operador/admins", {
        leagueName: $("leagueName").value,
        email: $("email").value,
        slug: $("slug").value,
        paidUntil: $("paidUntil").value,
      });
      formAlta.reset();
      formAlta.hidden = true;
      mostrarCredenciales({ email: res.admin.email, password: res.password, loginUrl: res.loginUrl });
      await recargar();
    } catch (err) {
      const aviso = $("error-alta");
      aviso.textContent = err.message;
      aviso.hidden = false;
    } finally {
      boton.disabled = false;
    }
  });
}

iniciar().catch((err) => mostrarError(err.message));
