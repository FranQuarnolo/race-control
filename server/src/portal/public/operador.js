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

// Menú de tres puntitos de la tabla de admins. Mismo patrón que el panel de carrera (`app.js`,
// `.btn-kebab`): un solo menú vivo para toda la tabla, colgado del `<body>` y no de la celda.
let openMenu = null;

// Historial de eventos de la liga que se esté mirando, y el borrado de a dos clicks: igual
// criterio que el kick del panel, porque borrar un evento tampoco se puede deshacer.
let historialAdmin = null;
let eventos = [];
let armedDelete = null;

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
  // La tabla se reconstruye entera: un menú abierto apuntaría a un botón que ya no existe.
  closeRowMenu();
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

    // --- acciones: antes eran cuatro botones sueltos en la fila; con "Ver historial" sumado iban
    // a ser cinco, y una acción destructiva (Desactivar) suelta ahí es un click perdido esperando
    // a pasar. Mismo menú kebab que ya usa el panel de carrera para el mismo motivo.
    const tdAcciones = el("td", "acciones");
    const kebab = el("button", "btn-kebab", "⋮");
    kebab.type = "button";
    kebab.setAttribute("aria-haspopup", "true");
    kebab.setAttribute("aria-expanded", "false");
    kebab.title = "Acciones";
    kebab.addEventListener("click", () => toggleRowMenu(admin, kebab));
    tdAcciones.appendChild(kebab);
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

function toggleRowMenu(admin, anchor) {
  const yaEstaba = openMenu !== null && openMenu.adminId === admin.id;
  closeRowMenu();
  if (yaEstaba) return;

  const menu = el("div", "menu-fila");
  menu.setAttribute("role", "menu");

  const item = (texto, clase, onClick, deshabilitado) => {
    const b = el("button", "menu-item" + (clase ? " " + clase : ""), texto);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    if (deshabilitado) {
      b.disabled = true;
    } else {
      b.addEventListener("click", () => {
        closeRowMenu();
        onClick();
      });
    }
    menu.appendChild(b);
  };

  item("Editar", "", () => abrirEdicion(admin));
  item("Cobré", "", () => cobrar(admin));
  item(admin.active ? "Desactivar" : "Reactivar", admin.active ? "peligro" : "", () => alternar(admin));
  item("Clave nueva", "", () => nuevaClave(admin));
  item("Ver historial", "", () => abrirHistorial(admin), admin.leagues.length === 0);

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  // Alineado a la derecha del botón y debajo, salvo que no entre: ahí sube por encima.
  const abajo = r.bottom + 4;
  const arriba = r.top - menu.offsetHeight - 4;
  menu.style.top = (abajo + menu.offsetHeight <= window.innerHeight - 8 || arriba < 8 ? abajo : arriba) + "px";
  menu.style.left = Math.max(8, r.right - menu.offsetWidth) + "px";

  anchor.setAttribute("aria-expanded", "true");
  openMenu = { adminId: admin.id, el: menu, anchor };
}

function closeRowMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  openMenu.anchor.setAttribute("aria-expanded", "false");
  openMenu = null;
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
  cerrarHistorial();
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

// --------------------------------------------------------------------------------- historial

const PREFIJOS_PISTA = /^(ks_|acu_|rt_|at_|pm_|tcl_|vrc_)/i;

/** `ks_barcelona` + `layout_gp` → `Barcelona · GP`. Mismo criterio que `prettyTrack`/`prettyLayout`
 * en `report/raceReport.ts`: no hay un paquete compartido entre servidor y portal, así que se
 * repite acá la versión mínima que necesita esta tabla. */
function prettyPista(ev) {
  const base = ev.track.replace(PREFIJOS_PISTA, "").replace(/[_-]+/g, " ").trim();
  const nombre = base ? base.charAt(0).toUpperCase() + base.slice(1) : ev.track;
  if (!ev.trackConfig) return nombre;
  const layout = ev.trackConfig.replace(/^layout_/i, "").replace(/[_-]+/g, " ").trim();
  if (!layout) return nombre;
  const capa = layout.length <= 4 ? layout.toUpperCase() : layout.charAt(0).toUpperCase() + layout.slice(1);
  return nombre + " · " + capa;
}

function etiquetaSesion(ev) {
  if (ev.sessionName && ev.sessionName !== ev.sessionTypeLabel) return ev.sessionTypeLabel + " · " + ev.sessionName;
  return ev.sessionTypeLabel;
}

/** mm:ss.mmm, igual que `formatLap` en `report/raceReport.ts`. */
function formatLap(ms) {
  if (ms === null || ms === undefined || ms <= 0) return "—";
  const minutos = Math.floor(ms / 60000);
  const segundos = Math.floor((ms % 60000) / 1000);
  const milis = ms % 1000;
  return minutos + ":" + String(segundos).padStart(2, "0") + "." + String(milis).padStart(3, "0");
}

async function abrirHistorial(admin) {
  const liga = admin.leagues[0];
  if (!liga) return;
  cerrarEdicion();
  $("form-alta").hidden = true;
  historialAdmin = { admin, liga };
  $("historial-liga").textContent = liga.name;
  $("historial").hidden = false;
  $("historial").scrollIntoView({ block: "center" });
  const data = await api("/api/operador/ligas/" + liga.id + "/eventos");
  eventos = data.eventos;
  pintarHistorial();
}

function cerrarHistorial() {
  $("historial").hidden = true;
  historialAdmin = null;
  eventos = [];
  desarmarBorrado();
}

function pintarHistorial() {
  const cuerpo = $("filas-historial");
  cuerpo.textContent = "";
  $("sin-eventos").hidden = eventos.length > 0;
  $("tabla-historial").hidden = eventos.length === 0;

  for (const ev of eventos) {
    const tr = el("tr");
    tr.appendChild(el("td", "muted", fechaHora(ev.startedAt)));
    tr.appendChild(el("td", "", prettyPista(ev)));
    tr.appendChild(el("td", "", etiquetaSesion(ev)));

    const tdEstado = el("td");
    const enCurso = ev.status === "en-progreso";
    tdEstado.appendChild(el("span", "pastilla " + (enCurso ? "en-progreso" : "terminado"), enCurso ? "en curso" : "terminado"));
    tr.appendChild(tdEstado);

    const tdAcciones = el("td", "acciones");
    const verBoton = el("button", "compacto", "Ver");
    verBoton.type = "button";
    verBoton.title = "Ver el detalle";
    verBoton.addEventListener("click", () => verDetalle(ev));
    tdAcciones.appendChild(verBoton);

    const borrarBoton = el("button", "compacto peligro", "Borrar");
    borrarBoton.type = "button";
    if (enCurso) {
      borrarBoton.disabled = true;
      borrarBoton.title = "Todavía está en curso";
    } else {
      borrarBoton.title = "Borrar";
      borrarBoton.addEventListener("click", () => clickBorrar(ev, borrarBoton));
    }
    tdAcciones.appendChild(borrarBoton);
    tr.appendChild(tdAcciones);

    cuerpo.appendChild(tr);
  }
}

/**
 * Primer click arma, segundo ejecuta. Se desarma solo a los 4 segundos.
 *
 * Igual motivo que el kick del panel: borrar un evento no se puede deshacer, y un `confirm()`
 * nativo bloquearía el hilo justo en una pantalla que puede tener otra pestaña del operador
 * mirando la misma liga.
 */
function clickBorrar(ev, btn) {
  if (armedDelete && armedDelete.id === ev.id) {
    desarmarBorrado();
    ejecutarBorrado(ev);
    return;
  }
  desarmarBorrado();
  const timer = setTimeout(desarmarBorrado, 4000);
  armedDelete = { id: ev.id, btn, timer };
  btn.classList.add("arming");
  btn.title = "¿Seguro? Confirmá para borrar";
}

function desarmarBorrado() {
  if (!armedDelete) return;
  clearTimeout(armedDelete.timer);
  armedDelete.btn.classList.remove("arming");
  armedDelete.btn.title = "Borrar";
  armedDelete = null;
}

async function ejecutarBorrado(ev) {
  await api("/api/operador/ligas/" + historialAdmin.liga.id + "/eventos/" + ev.id, undefined, "DELETE");
  eventos = eventos.filter((e) => e.id !== ev.id);
  pintarHistorial();
}

function verDetalle(ev) {
  const report = ev.report;
  $("evento-titulo").textContent = prettyPista(ev);
  $("evento-subtitulo").textContent = report
    ? [report.sessionType, fechaHora(ev.startedAt)].filter(Boolean).join(" · ")
    : "Todavía en curso: el informe se arma al terminar la sesión.";

  const clasificacion = report ? report.classification : [];
  $("evento-sin-clasificacion").hidden = clasificacion.length > 0;
  $("tabla-evento-clasificacion").hidden = clasificacion.length === 0;
  const filasClasificacion = $("filas-evento-clasificacion");
  filasClasificacion.textContent = "";
  for (const r of clasificacion) {
    const tr = el("tr");
    tr.appendChild(el("td", "", r.position !== null ? String(r.position) : "—"));
    tr.appendChild(el("td", "", r.driverName));
    tr.appendChild(el("td", "", r.carModel));
    tr.appendChild(el("td", "", String(r.laps)));
    tr.appendChild(el("td", "", formatLap(r.bestLapMs)));
    tr.appendChild(el("td", "", r.timePenaltySeconds ? r.timePenaltySeconds + " s" : "—"));
    tr.appendChild(el("td", "", r.disqualified ? "Descalificado" : r.finished ? "" : "Abandonó"));
    filasClasificacion.appendChild(tr);
  }

  const sanciones = report ? report.penalties : [];
  $("evento-sin-sanciones").hidden = sanciones.length > 0;
  $("tabla-evento-sanciones").hidden = sanciones.length === 0;
  const filasSanciones = $("filas-evento-sanciones");
  filasSanciones.textContent = "";
  for (const p of sanciones) {
    const tr = el("tr");
    tr.appendChild(el("td", "", p.driverName));
    tr.appendChild(el("td", "", p.engine));
    tr.appendChild(el("td", "", p.type + (p.timePenaltySeconds ? " (" + p.timePenaltySeconds + " s)" : "")));
    tr.appendChild(el("td", "", p.status));
    tr.appendChild(el("td", "", p.reason));
    filasSanciones.appendChild(tr);
  }

  const incidentes = report ? report.incidents : [];
  $("evento-sin-incidentes").hidden = incidentes.length > 0;
  $("tabla-evento-incidentes").hidden = incidentes.length === 0;
  const filasIncidentes = $("filas-evento-incidentes");
  filasIncidentes.textContent = "";
  for (const i of incidentes) {
    const tr = el("tr");
    tr.appendChild(el("td", "", i.kind));
    tr.appendChild(el("td", "", i.drivers));
    tr.appendChild(el("td", "", String(i.lap)));
    tr.appendChild(el("td", "", i.detail));
    tr.appendChild(el("td", "", i.resolution));
    filasIncidentes.appendChild(tr);
  }

  $("modal-evento").showModal();
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
    cerrarHistorial();
    $("form-alta").hidden = !$("form-alta").hidden;
    if (!$("form-alta").hidden) $("leagueName").focus();
  });
  $("btn-cancelar-alta").addEventListener("click", () => {
    $("form-alta").hidden = true;
  });
  $("btn-cancelar-editar").addEventListener("click", cerrarEdicion);
  $("btn-cerrar-historial").addEventListener("click", cerrarHistorial);

  $("btn-cerrar-modal-evento").addEventListener("click", () => $("modal-evento").close());
  // Click en el fondo oscuro del modal nativo: con padding, un click afuera del contenido cae en
  // el propio <dialog>, no en lo de adentro.
  $("modal-evento").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) $("modal-evento").close();
  });

  // Cierre del menú de tres puntitos: mismo criterio que el panel de carrera. Va en fase de
  // captura para correr antes que el click del propio kebab, así un click en otro botón cierra
  // el menú viejo y abre el nuevo en vez de que el segundo click quede comido.
  document.addEventListener(
    "click",
    (e) => {
      if (!openMenu) return;
      if (openMenu.el.contains(e.target) || openMenu.anchor.contains(e.target)) return;
      closeRowMenu();
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openMenu) closeRowMenu();
  });
  // El menú está en `position: fixed`: sin esto quedaría flotando apuntando a una fila que ya no
  // está ahí si la tabla scrollea por abajo.
  document.addEventListener("scroll", closeRowMenu, true);
  window.addEventListener("resize", closeRowMenu);

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
