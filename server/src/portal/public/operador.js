// Panel de quien vende el servicio: quién tiene liga, quién está al día y quién hay que cortar.
//
// Igual que el resto del portal: JS vanilla, y todo texto que venga de una persona se inserta con
// textContent. Acá entran emails, nombres de liga y nombres de servidor que escribió alguien más.

const ETIQUETAS_ESTADO = {
  running: "Conectado",
  starting: "arrancando",
  stopped: "detenida",
  failed: "con problemas",
};

/**
 * Qué pastilla mostrar para un servidor: su `status` dice si el PROCESO está vivo, no si del otro
 * lado hay un servidor de Assetto Corsa mandando algo.
 *
 * Decían "Conectado" dos cosas muy distintas: una liga andando y una recién creada a la que nadie
 * le configuró todavía el UDP Plugin Address en el hosting. La segunda se ve igual de verde y no
 * recibe un solo paquete, así que el operador daba por lista una puesta en marcha a medio hacer.
 */
function pastillaDeEstado(estado) {
  if (estado.status === "running" && !estado.conectado) {
    return { clase: "starting", texto: "Esperando conexión", titulo: "El proceso está arriba, pero todavía no llegó un solo paquete UDP desde el servidor de Assetto Corsa. Falta configurar el UDP Plugin Address en el hosting." };
  }
  return { clase: estado.status, texto: ETIQUETAS_ESTADO[estado.status] || estado.status, titulo: "" };
}

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

// El servidor que se está editando/mirando en el modal de Servidores, y el estado de cada pestaña
// (su `<tbody>` y su "sin eventos" propios, para no tener que reconstruir las otras al repintar
// una). El borrado de un evento pide dos clicks, igual criterio que el kick del panel.
let servidoresAdmin = null;
let tabsState = {};
let armedDelete = null;

// El modal de confirmación es genérico: `confirmar()` lo arma y devuelve una Promise que se
// resuelve cuando el operador elige. Reemplaza los `confirm()` nativos.
let confirmResolve = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function openModal(id) {
  $(id).hidden = false;
}

function closeModal(id) {
  $(id).hidden = true;
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
      tdQuien.appendChild(el("div", "nota", admin.note));
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
      }
    }
    tr.appendChild(tdLiga);

    // --- servidores: cuántos tiene y en qué estado, con acceso al detalle de cada uno en un modal
    const tdServidores = el("td");
    const primeraLiga = admin.leagues[0];
    if (!primeraLiga || !primeraLiga.servidores.length) {
      tdServidores.appendChild(el("span", "muted", "—"));
    } else {
      const lista = el("div", "servidores-lista");
      for (const servidor of primeraLiga.servidores) {
        const pastilla = el("span", "estado " + servidor.status, servidor.nombre);
        if (servidor.lastError) pastilla.title = servidor.lastError;
        lista.appendChild(pastilla);
      }
      tdServidores.appendChild(lista);
    }
    if (primeraLiga) {
      tdServidores.appendChild(boton("Ver / agregar", "", () => abrirServidores(admin)));
    }
    tr.appendChild(tdServidores);

    tr.appendChild(el("td", "muted", fechaHora(admin.lastLoginAt)));

    // --- el motor
    const tdMotor = el("td");
    for (const liga of admin.leagues) {
      const estado = pastillaDeEstado(liga);
      const pastilla = el("span", "estado " + estado.clase, estado.texto);
      if (liga.lastError) pastilla.title = liga.lastError;
      else if (estado.titulo) pastilla.title = estado.titulo;
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

    // --- acciones: menú kebab, igual que el panel de carrera.
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

  const item = (texto, clase, onClick) => {
    const b = el("button", "menu-item" + (clase ? " " + clase : ""), texto);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => {
      closeRowMenu();
      onClick();
    });
    menu.appendChild(b);
  };

  // Orden por frecuencia de uso real: lo rutinario (cobrar) arriba, editar en el medio, y lo
  // destructivo (Desactivar) siempre al final — mismo criterio por el que ya tiene su propia clase
  // "peligro". Ver historial, clave nueva y agregar servidor se mudaron adentro del modal de
  // Servidores y del modal de Editar: ya no son acciones sueltas del menú.
  item("Cobré", "", () => cobrar(admin));
  item("Editar", "", () => abrirEdicion(admin));
  item(admin.active ? "Desactivar" : "Reactivar", admin.active ? "peligro" : "", () => alternar(admin));

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
  // El cupo no es un detalle: cada servidor ocupa un puerto UDP de un rango declarado a mano en
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

  const ok = await confirmar("Marcar como pago", admin.email + " queda al día hasta el " + fecha(nueva) + ".", {
    labelOk: "Marcar pago",
  });
  if (!ok) return;
  await api("/api/operador/admins/" + admin.id, { paidUntil: nueva });
  await recargar();
}

async function alternar(admin) {
  const titulo = admin.active ? "Desactivar cuenta" : "Reactivar cuenta";
  const mensaje = admin.active
    ? "Se apaga el motor de todos los servidores de " + admin.email + " y deja de entrar al panel. " +
      "Los datos (configuración, sanciones, registros) quedan intactos."
    : admin.email + " vuelve a entrar al panel y sus servidores arrancan de nuevo.";
  const ok = await confirmar(titulo, mensaje, {
    labelOk: admin.active ? "Desactivar" : "Reactivar",
    peligro: admin.active,
  });
  if (!ok) return;
  await api("/api/operador/admins/" + admin.id, { active: !admin.active });
  await recargar();
}

// ----------------------------------------------------------------------- confirmación genérica

function confirmar(titulo, mensaje, opts) {
  opts = opts || {};
  $("confirmar-titulo").textContent = titulo;
  $("confirmar-mensaje").textContent = mensaje;
  const ok = $("btn-confirmar-ok");
  ok.textContent = opts.labelOk || "Confirmar";
  ok.className = opts.peligro ? "peligro" : "";
  openModal("modal-confirmar");
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function resolverConfirmar(valor) {
  closeModal("modal-confirmar");
  if (confirmResolve) confirmResolve(valor);
  confirmResolve = null;
}

// ------------------------------------------------------------------------------------- edición

/** Lo que había cuando se abrió el modal, para mandar solo lo que de verdad cambió. */
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
  $("ed-leagueName").disabled = !liga;
  $("ed-slug").disabled = !liga;
  $("ed-aviso-nombre").hidden = true;
  $("ed-aviso-slug").hidden = true;
  $("error-editar").hidden = true;

  // La contraseña nunca se puede mostrar (solo se guarda su hash) — el campo de "actual" es un
  // placeholder fijo, no un dato real. Cambiarla exige escribirla dos veces, acá abajo.
  $("ed-clave-nueva").hidden = true;
  $("ed-password-1").value = "";
  $("ed-password-2").value = "";
  $("btn-toggle-clave").textContent = "Cambiar contraseña";

  openModal("modal-editar");
  ($("ed-leagueName").disabled ? $("ed-email") : $("ed-leagueName")).focus();
}

function cerrarEdicion() {
  closeModal("modal-editar");
  editando = null;
}

/**
 * Guarda los pedazos por separado, porque son endpoints distintos.
 *
 * El orden importa para el peor caso: si algo falla a mitad de camino, lo que ya se guardó queda
 * guardado y el error dice cuál fue. Por eso la contraseña va última.
 */
async function guardarEdicion() {
  const { admin, liga } = editando;
  const nombre = $("ed-leagueName").value.trim();
  const slug = $("ed-slug").value.trim();
  const email = $("ed-email").value.trim();
  const cambiarClave = !$("ed-clave-nueva").hidden;
  const clave1 = $("ed-password-1").value;
  const clave2 = $("ed-password-2").value;

  if (liga && !nombre) throw new Error("La liga necesita un nombre.");
  if (!email) throw new Error("La cuenta necesita un email.");
  if (cambiarClave) {
    if (clave1.length < 8) throw new Error("La contraseña tiene que tener al menos 8 caracteres.");
    if (clave1 !== clave2) throw new Error("Las dos contraseñas no coinciden.");
  }

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
  if (cambiarClave) {
    const res = await api("/api/operador/admins/" + admin.id + "/clave", { password: clave1 });
    password = res.password;
  }

  cerrarEdicion();
  await recargar();
  // Si cambió algo de lo que el admin necesita para entrar, se le muestra junto para pasárselo.
  if (password || email.toLowerCase() !== admin.email.toLowerCase()) {
    mostrarCredenciales({ email, password: password || "la misma de antes" });
  }
}

// ----------------------------------------------------------------------------- modal: servidores

function abrirServidores(admin) {
  const liga = admin.leagues[0];
  if (!liga) return;
  servidoresAdmin = { admin, liga };
  $("srv-liga-nombre").textContent = liga.name;
  pintarTabsServidores(liga);
  prepararFormularioNuevoServidor();
  const primero = liga.servidores[0];
  seleccionarTabServidor(primero ? primero.id : "nuevo");
  openModal("modal-servidores");
}

function cerrarServidores() {
  closeModal("modal-servidores");
  servidoresAdmin = null;
  tabsState = {};
}

/** Reconstruye las pestañas de servidores de la liga, conservando la pestaña fija "+ Nuevo". */
function pintarTabsServidores(liga) {
  const tabNuevo = $("tab-nuevo");
  const panelNuevo = $("srv-panel-nuevo");
  for (const btn of [...document.querySelectorAll("#srv-tabs .tab")]) {
    if (btn !== tabNuevo) btn.remove();
  }
  for (const panel of [...document.querySelectorAll("#srv-panels .tab-panel")]) {
    if (panel !== panelNuevo) panel.remove();
  }
  tabsState = {};

  for (const servidor of liga.servidores) {
    const tabBtn = el("button", "tab", servidor.nombre);
    tabBtn.type = "button";
    tabBtn.setAttribute("role", "tab");
    tabBtn.setAttribute("aria-selected", "false");
    tabBtn.dataset.tab = servidor.id;
    $("srv-tabs").insertBefore(tabBtn, tabNuevo);
    $("srv-panels").insertBefore(panelServidor(servidor), panelNuevo);
  }
}

function panelServidor(servidor) {
  const panel = el("div", "tab-panel");
  panel.dataset.panel = servidor.id;
  panel.hidden = true;

  const datos = el("section");
  datos.appendChild(el("h3", "", "Datos"));

  // El nombre se elegía una sola vez, al crear el servidor: un error de tipeo quedaba para siempre
  // y la única salida era borrarlo y rehacerlo, cosa que le cambia el id —y con él el link de
  // conexión que el admin ya tenía guardado— por un problema puramente cosmético.
  const filaNombre = el("div", "row-stack");
  filaNombre.appendChild(el("label", "", "Nombre del servidor"));
  const inputNombre = document.createElement("input");
  inputNombre.type = "text";
  inputNombre.autocomplete = "off";
  inputNombre.placeholder = "México F3";
  inputNombre.value = servidor.nombre;
  filaNombre.appendChild(inputNombre);
  const errorNombre = el("p", "error");
  errorNombre.hidden = true;
  const btnNombre = boton("Guardar nombre", "secundario accion-del-campo", () =>
    renombrarServidor(servidor, inputNombre, errorNombre, btnNombre)
  );
  filaNombre.appendChild(btnNombre);
  filaNombre.appendChild(errorNombre);
  datos.appendChild(filaNombre);

  const filaEstado = el("div", "row");
  filaEstado.appendChild(el("label", "", "Estado"));
  const spanEstado = el("span");
  const estadoServidor = pastillaDeEstado(servidor);
  const pastillaEstado = el("span", "estado " + estadoServidor.clase, estadoServidor.texto);
  if (servidor.lastError) pastillaEstado.title = servidor.lastError;
  else if (estadoServidor.titulo) pastillaEstado.title = estadoServidor.titulo;
  spanEstado.appendChild(pastillaEstado);
  filaEstado.appendChild(spanEstado);
  datos.appendChild(filaEstado);

  const filaCreado = el("div", "row");
  filaCreado.appendChild(el("label", "", "Creado"));
  filaCreado.appendChild(el("span", "", fecha(servidor.createdAt)));
  datos.appendChild(filaCreado);

  const filaDireccion = el("div", "row-stack");
  filaDireccion.appendChild(el("label", "", "Send Address (UDP Plugin Address en el hosting)"));
  filaDireccion.appendChild(el("div", "send-address", servidor.sendAddress || "sin IP pública configurada"));
  datos.appendChild(filaDireccion);

  const filaLink = el("div", "row-stack");
  filaLink.appendChild(el("label", "", "Link para que el admin conecte este servidor"));
  const inputLink = document.createElement("input");
  inputLink.type = "text";
  inputLink.readOnly = true;
  inputLink.value = servidor.conectarUrl;
  filaLink.appendChild(inputLink);
  datos.appendChild(filaLink);

  const filaBorrar = el("div", "row");
  filaBorrar.appendChild(el("label", "", "Borrar"));
  const contBorrar = el("span");
  contBorrar.appendChild(boton("Borrar servidor", "peligro", () => borrarServidor(servidor)));
  filaBorrar.appendChild(contBorrar);
  datos.appendChild(filaBorrar);

  panel.appendChild(datos);

  const historial = el("section");
  historial.appendChild(el("h3", "", "Historial"));
  historial.appendChild(el("p", "muted", "Una fila por sesión del servidor: práctica, clasificación o carrera."));

  const tabla = el("table", "tabla");
  const thead = el("thead");
  const trh = el("tr");
  for (const titulo of ["Fecha", "Circuito", "Sesión", "Estado", "Acciones"]) trh.appendChild(el("th", "", titulo));
  thead.appendChild(trh);
  tabla.appendChild(thead);
  const tbody = el("tbody");
  tabla.appendChild(tbody);
  historial.appendChild(tabla);

  const sinEventos = el("p", "muted", "Todavía no hay ninguna sesión registrada.");
  sinEventos.hidden = true;
  historial.appendChild(sinEventos);

  panel.appendChild(historial);

  tabsState[servidor.id] = { tbody, sinEventos, tabla, eventos: [] };
  return panel;
}

function seleccionarTabServidor(tabId) {
  for (const btn of document.querySelectorAll("#srv-tabs .tab")) {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === tabId));
  }
  for (const panel of document.querySelectorAll("#srv-panels .tab-panel")) {
    panel.hidden = panel.dataset.panel !== tabId;
  }
  if (tabId !== "nuevo") cargarHistorialServidor(tabId);
}

async function cargarHistorialServidor(servidorId) {
  if (!servidoresAdmin || !tabsState[servidorId]) return;
  const liga = servidoresAdmin.liga;
  const data = await api("/api/operador/ligas/" + liga.id + "/servidores/" + servidorId + "/eventos");
  pintarHistorialServidor(servidorId, data.eventos);
}

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

function pintarHistorialServidor(servidorId, eventos) {
  const refs = tabsState[servidorId];
  if (!refs) return;
  refs.eventos = eventos;
  refs.tbody.textContent = "";
  refs.sinEventos.hidden = eventos.length > 0;
  refs.tabla.hidden = eventos.length === 0;

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
    tdAcciones.appendChild(boton("Ver", "", () => verDetalle(ev)));
    const borrarBoton = el("button", "compacto peligro", "Borrar");
    borrarBoton.type = "button";
    if (enCurso) {
      borrarBoton.disabled = true;
      borrarBoton.title = "Todavía está en curso";
    } else {
      borrarBoton.title = "Borrar";
      borrarBoton.addEventListener("click", () => clickBorrar(servidorId, ev, borrarBoton));
    }
    tdAcciones.appendChild(borrarBoton);
    tr.appendChild(tdAcciones);

    refs.tbody.appendChild(tr);
  }
}

/**
 * Primer click arma, segundo ejecuta. Se desarma solo a los 4 segundos.
 *
 * Igual motivo que el kick del panel: borrar un evento no se puede deshacer, y esta pantalla puede
 * tener otra pestaña del operador mirando la misma liga al mismo tiempo.
 */
function clickBorrar(servidorId, ev, btn) {
  if (armedDelete && armedDelete.servidorId === servidorId && armedDelete.id === ev.id) {
    desarmarBorrado();
    ejecutarBorrado(servidorId, ev);
    return;
  }
  desarmarBorrado();
  const timer = setTimeout(desarmarBorrado, 4000);
  armedDelete = { servidorId, id: ev.id, btn, timer };
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

async function ejecutarBorrado(servidorId, ev) {
  const liga = servidoresAdmin.liga;
  await api("/api/operador/ligas/" + liga.id + "/servidores/" + servidorId + "/eventos/" + ev.id, undefined, "DELETE");
  const refs = tabsState[servidorId];
  if (refs) pintarHistorialServidor(servidorId, refs.eventos.filter((e) => e.id !== ev.id));
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

  openModal("modal-evento");
}

// ------------------------------------------------------------------ agregar servidor (pestaña +)

function prepararFormularioNuevoServidor() {
  $("srv-nuevo-nombre").value = "";
  $("error-servidor-nuevo").hidden = true;
  $("srv-nuevo-resultado").hidden = true;
}

async function crearServidor() {
  const nombre = $("srv-nuevo-nombre").value.trim();
  $("error-servidor-nuevo").hidden = true;
  if (!nombre) {
    $("error-servidor-nuevo").textContent = "El servidor necesita un nombre.";
    $("error-servidor-nuevo").hidden = false;
    return;
  }
  const liga = servidoresAdmin.liga;
  const btn = $("btn-crear-servidor");
  btn.disabled = true;
  try {
    const res = await api("/api/operador/ligas/" + liga.id + "/servidores", { nombre });
    $("srv-nuevo-resultado-nombre").textContent = res.servidor.nombre;
    $("srv-nuevo-mensaje").value = mensajeSoporte(res.servidor.sendAddress || "");
    $("srv-nuevo-link").value = res.conectarUrl;
    $("srv-nuevo-resultado").hidden = false;
    $("srv-nuevo-nombre").value = "";

    await recargar();
    const actualizado = admins.find((a) => a.id === servidoresAdmin.admin.id);
    const ligaActualizada = actualizado && actualizado.leagues.find((l) => l.id === liga.id);
    if (actualizado && ligaActualizada) {
      servidoresAdmin = { admin: actualizado, liga: ligaActualizada };
      pintarTabsServidores(ligaActualizada);
    }
  } catch (err) {
    $("error-servidor-nuevo").textContent = err.message;
    $("error-servidor-nuevo").hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/**
 * Cambia el nombre de un servidor ya creado. No pide confirmación ni reinicia nada: el nombre es
 * un rótulo del panel, el worker no lo conoce (ver la ruta PATCH en `portal/server.ts`), así que
 * equivocarse acá no rompe nada y se arregla escribiendo de nuevo.
 */
async function renombrarServidor(servidor, input, errorEl, btn) {
  const nombre = input.value.trim();
  errorEl.hidden = true;
  if (!nombre) {
    errorEl.textContent = "El servidor necesita un nombre.";
    errorEl.hidden = false;
    return;
  }
  if (nombre === servidor.nombre) return;

  const liga = servidoresAdmin.liga;
  btn.disabled = true;
  try {
    await api("/api/operador/ligas/" + liga.id + "/servidores/" + servidor.id, { nombre }, "PATCH");

    await recargar();
    const actualizado = admins.find((a) => a.id === servidoresAdmin.admin.id);
    const ligaActualizada = actualizado && actualizado.leagues.find((l) => l.id === liga.id);
    if (actualizado && ligaActualizada) {
      servidoresAdmin = { admin: actualizado, liga: ligaActualizada };
      pintarTabsServidores(ligaActualizada);
      // Reabre la misma pestaña: el panel se vuelve a armar desde cero y así el input y el título
      // de la pestaña quedan con el nombre nuevo sin tener que tocarlos a mano por separado.
      seleccionarTabServidor(servidor.id);
    }
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/**
 * Borra un servidor entero de la liga (no una entrada del historial). A diferencia del borrado de
 * eventos de la tabla de historial, que pide doble click porque son muchas filas repetidas, esto
 * aparece una sola vez por pestaña — el modal de confirmación genérico (mismo que usa `alternar`
 * para desactivar una cuenta) alcanza y es más visible para algo que corta la conexión del
 * hosting.
 */
async function borrarServidor(servidor) {
  const liga = servidoresAdmin.liga;
  const ok = await confirmar(
    "Borrar servidor",
    "Se borra \"" + servidor.nombre + "\" y se corta la conexión con el hosting. " +
      "El historial que ya tenga guardado en disco no se toca.",
    { labelOk: "Borrar servidor", peligro: true }
  );
  if (!ok) return;

  await api("/api/operador/ligas/" + liga.id + "/servidores/" + servidor.id, undefined, "DELETE");

  await recargar();
  const actualizado = admins.find((a) => a.id === servidoresAdmin.admin.id);
  const ligaActualizada = actualizado && actualizado.leagues.find((l) => l.id === liga.id);
  if (actualizado && ligaActualizada) {
    servidoresAdmin = { admin: actualizado, liga: ligaActualizada };
    pintarTabsServidores(ligaActualizada);
    const primero = ligaActualizada.servidores[0];
    seleccionarTabServidor(primero ? primero.id : "nuevo");
  }
}

/**
 * El ticket de soporte, ya armado y con la dirección de este servidor adentro.
 *
 * Mismo texto (y mismo motivo para que vaya en inglés) que `supportMessage` en `app.js`: el
 * soporte de los hostings de Assetto Corsa (EmperorServers, Pingperfect, GTXGaming, Nitrado)
 * contesta en inglés, y ese campo casi nunca es self-service — lo normal es que lo carguen ellos
 * desde un ticket, no el dueño de la cuenta.
 */
function mensajeSoporte(address) {
  return [
    "Subject: Please enable and configure the UDP plugin on my Assetto Corsa server",
    "",
    "Hello,",
    "",
    "I use an external race control tool with my Assetto Corsa server. It needs the",
    "server's UDP plugin enabled and pointed at it. I cannot find the \"Send Address\"",
    "field in my control panel, so I assume UDP plugins are disabled on my server.",
    "",
    "Could you please configure the UDP plugin with this destination?",
    "",
    "    Send Address (UDP_PLUGIN_ADDRESS): " + address,
    "",
    "Any free port on your side is fine as the Listen Address",
    "(UDP_PLUGIN_LOCAL_PORT) — I do not need a specific one.",
    "",
    "One important detail: if the plugin has an IP allowlist, please also allow",
    "    " + address.split(":")[0],
    "to SEND commands to the plugin, not only to receive telemetry. The tool has to",
    "send chat messages and penalties back to the server. If that address is not",
    "allowed, everything looks fine on my side while every command is silently",
    "dropped.",
    "",
    "Please restart the server once it is configured and let me know.",
    "",
    "Thank you!",
  ].join("\n");
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

  // --- modal: editar
  $("btn-cerrar-editar").addEventListener("click", cerrarEdicion);
  $("btn-cancelar-editar").addEventListener("click", cerrarEdicion);
  $("modal-editar").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) cerrarEdicion();
  });
  $("btn-toggle-clave").addEventListener("click", () => {
    const abriendo = $("ed-clave-nueva").hidden;
    $("ed-clave-nueva").hidden = !abriendo;
    $("btn-toggle-clave").textContent = abriendo ? "No cambiarla" : "Cambiar contraseña";
    if (!abriendo) {
      $("ed-password-1").value = "";
      $("ed-password-2").value = "";
    }
  });
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

  // --- modal: servidores
  $("btn-cerrar-servidores").addEventListener("click", cerrarServidores);
  $("modal-servidores").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) cerrarServidores();
  });
  $("srv-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) seleccionarTabServidor(tab.dataset.tab);
  });
  $("btn-crear-servidor").addEventListener("click", crearServidor);
  $("btn-copiar-mensaje-soporte").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("srv-nuevo-mensaje").value);
      const b = $("btn-copiar-mensaje-soporte");
      b.textContent = "Copiado";
      setTimeout(() => (b.textContent = "Copiar mensaje"), 1500);
    } catch (_) {
      mostrarError("No pude copiar solo. Seleccioná el texto y copialo a mano.");
    }
  });

  // --- modal: detalle de evento
  $("btn-cerrar-modal-evento").addEventListener("click", () => closeModal("modal-evento"));
  $("modal-evento").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal("modal-evento");
  });

  // --- modal: confirmación genérica
  $("btn-confirmar-ok").addEventListener("click", () => resolverConfirmar(true));
  $("btn-confirmar-cancelar").addEventListener("click", () => resolverConfirmar(false));
  $("modal-confirmar").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) resolverConfirmar(false);
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
    if (e.key !== "Escape") return;
    if (openMenu) {
      closeRowMenu();
      return;
    }
    if (!$("modal-confirmar").hidden) {
      resolverConfirmar(false);
      return;
    }
    if (!$("modal-evento").hidden) {
      closeModal("modal-evento");
      return;
    }
    if (!$("modal-servidores").hidden) {
      cerrarServidores();
      return;
    }
    if (!$("modal-editar").hidden) {
      cerrarEdicion();
    }
  });
  // El menú está en `position: fixed`: sin esto quedaría flotando apuntando a una fila que ya no
  // está ahí si la tabla scrollea por abajo.
  document.addEventListener("scroll", closeRowMenu, true);
  window.addEventListener("resize", closeRowMenu);

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
