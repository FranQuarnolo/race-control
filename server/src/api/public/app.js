// Panel admin — JS vanilla, sin build ni framework.
//
// Regla transversal: todo texto que viene del juego (nombre de piloto, motivo de sanción) se
// inserta con textContent, nunca con innerHTML. Un nombre de piloto armado a propósito con
// HTML/JS no debe poder ejecutarse en el panel del admin (XSS).

const POLL_MS = 1000;

/**
 * Prefijo bajo el que está servido el panel: `/l/<slug>`.
 *
 * Todas las ligas comparten un dominio y se distinguen por la ruta. Se deduce de la propia URL en
 * vez de inyectarlo desde el servidor: así el archivo es el mismo byte a byte para todas las ligas
 * y no hay un paso de plantilla que pueda quedar sin aplicar. Queda `""` cuando se abre el panel
 * directo contra el puerto del worker, que es como se toman las capturas de la landing.
 */
const BASE = (function () {
  const m = window.location.pathname.match(/^\/l\/[a-z0-9-]+/);
  return m ? m[0] : "";
})();

function $(id) {
  return document.getElementById(id);
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function toast(message, durationMs) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove("show"), durationMs || 2500);
}

async function api(path, options) {
  let res;
  const opts = Object.assign({}, options);
  // `X-RC-Request` va en TODA request, no solo en los POST: es la marca que el portal exige para
  // aceptar algo que modifica estado. Un formulario de otro sitio no puede agregar headers, así
  // que sin esto un CSRF pasaría.
  opts.headers = Object.assign({ "X-RC-Request": "1" }, options && options.headers);
  try {
    res = await fetch(BASE + path, opts);
  } catch (err) {
    throw new Error("Se cortó la conexión con Race Control. Probá recargar la página.");
  }
  // 401 solo puede venir del portal: la sesión venció mientras el panel seguía haciendo polling.
  // Recargar lo manda al login con `volver`, así vuelve a donde estaba.
  if (res.status === 401 && BASE) {
    window.location.reload();
    throw new Error("Sesión vencida");
  }
  if (!res.ok) {
    let detail = "HTTP " + res.status;
    try {
      const body = await res.json();
      if (body && body.error) detail = body.error;
    } catch (_) {
      // la respuesta no era JSON, nos quedamos con el código HTTP
    }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

function del(path) {
  return api(path, { method: "DELETE" });
}

// ===================================================================== estado compartido

/** Auto seleccionado. Es UNA sola variable para los dos sentidos de la selección: click en la
 * tabla y click en el mapa escriben acá, y los dos renders leen de acá. Sincronizarlos de a
 * pares (tabla→mapa y mapa→tabla por separado) es la forma segura de que se desincronicen. */
let selectedCarId = null;

let lastState = null;
let trackOutline = null;
let lastTrackCoverage = -1;

/** La zona de pit configurada, tal como la usa el motor. Llega en cada `/api/state` para que el
 * mapa la pueda pintar sin depender de que alguien haya abierto el cajón de Reglas. */
let pitZone = null;

/** Qué muestra la columna de intervalo: `"ahead"` el hueco con el auto de adelante, `"leader"` el
 * acumulado contra el líder. Son las dos preguntas distintas que se hacen mirando una torre —"¿lo
 * alcanzo?" y "¿en qué carrera estoy?"— y no entran en una sola columna sin que una de las dos
 * quede mal. En memoria y nada más: es una preferencia de un rato, no de una cuenta. */
let gapMode = "ahead";

/** Cuándo llegó el último `/api/state` bueno, y qué dijo el error del último fallido. Los mira la
 * banda de contacto perdido: ver `renderLinkState`. */
let lastGoodPollAt = Date.now();
let lastPollError = "";

/** Cuánto se tolera sin datos antes de avisar. Tres segundos son tres polls: un fallo suelto
 * —el worker reiniciando, un hipo de red— no tiene por qué pintar la pantalla de rojo, pero tres
 * seguidos ya no son un hipo. */
const LINK_DOWN_AFTER_MS = 3000;

/** Si el backend no encontró Assetto Corsa, no tiene sentido pedir un logo por auto para cobrar
 * 24 respuestas 404: se va directo a la marca en texto. */

// ===================================================================== router

const VIEWS = {
  "/": { main: "view-live", nav: "nav-live" },
  "/sanciones": { main: "view-sanciones", nav: "nav-sanciones" },
};

/** Alias histórico del plan. Apunta a la misma vista para que un link viejo no caiga en blanco. */
const PATH_ALIASES = { "/historialSanciones": "/sanciones" };

function currentPath() {
  // La ruta del router es siempre la de adentro del panel: en el portal hay que sacarle el
  // `/l/<slug>` de adelante, que es del portal y no una vista.
  const sinBase = window.location.pathname.slice(BASE.length) || "/";
  const path = PATH_ALIASES[sinBase] || sinBase;
  return VIEWS[path] ? path : "/";
}

function renderRoute() {
  const path = currentPath();
  for (const [p, view] of Object.entries(VIEWS)) {
    const active = p === path;
    $(view.main).hidden = !active;
    const nav = $(view.nav);
    if (active) nav.setAttribute("aria-current", "page");
    else nav.removeAttribute("aria-current");
  }
  // El canvas estuvo oculto hasta recién y midió 0×0: hay que volver a dimensionarlo.
  if (path === "/") resizeCanvas();
}

function navigate(path) {
  const destino = BASE + path;
  if (window.location.pathname === destino) return;
  history.pushState({}, "", destino);
  renderRoute();
}

function wireRouter() {
  for (const view of Object.values(VIEWS)) {
    const nav = $(view.nav);
    // Los href del HTML son absolutos desde la raíz del panel; bajo el portal hay que
    // prefijarlos para que un click con el botón del medio (abrir en otra pestaña) también caiga
    // en la liga correcta y no en la raíz del portal.
    if (BASE) nav.setAttribute("href", BASE + nav.getAttribute("href"));
    nav.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(e.currentTarget.getAttribute("href").slice(BASE.length) || "/");
    });
  }
  window.addEventListener("popstate", renderRoute);
}

// ===================================================================== cajones laterales

/** Qué cajón abre cada `#ancla`. Los cajones no son vistas del router —se abren encima de lo que
 * haya— pero sí tienen que ser enlazables: así el aviso de "revisá la conexión" puede mandar
 * directo al lugar donde se revisa, en vez de describir dónde está el botón. */
const DRAWER_HASHES = { "#conexion": "drawer-network", "#reglas": "drawer-rules" };

function openDrawer(id) {
  $(id).hidden = false;
}

function closeDrawers() {
  $("drawer-network").hidden = true;
  $("drawer-rules").hidden = true;
  // Sin esto, cerrar y volver a tocar el mismo botón no haría nada: el hash seguiría puesto y el
  // navegador no dispara `hashchange` si no cambió.
  if (window.location.hash) history.replaceState({}, "", window.location.pathname);
}

function applyDrawerHash() {
  const id = DRAWER_HASHES[window.location.hash];
  if (id) openDrawer(id);
}

function wireDrawers() {
  $("btn-network").addEventListener("click", () => openDrawer("drawer-network"));
  $("btn-rules").addEventListener("click", () => openDrawer("drawer-rules"));
  window.addEventListener("hashchange", applyDrawerHash);
  applyDrawerHash();
  for (const btn of document.querySelectorAll("[data-close-drawer]")) {
    btn.addEventListener("click", closeDrawers);
  }
  // Click en el fondo oscuro, no dentro del cajón.
  for (const id of ["drawer-network", "drawer-rules"]) {
    $(id).addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeDrawers();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // El menú de fila primero: si hay uno abierto, Escape lo cierra a él y no el cajón de atrás.
    if (openMenu) {
      closeRowMenu();
      return;
    }
    closeDrawers();
  });

  // Cierre del menú de tres puntitos. Va en fase de captura para correr antes que el handler del
  // propio botón: así un click en otro kebab cierra el menú viejo y abre el nuevo, en vez de que
  // el segundo click quede comido.
  document.addEventListener(
    "click",
    (e) => {
      if (!openMenu) return;
      if (openMenu.el.contains(e.target) || openMenu.anchor.contains(e.target)) return;
      closeRowMenu();
    },
    true
  );
  // El menú está en `position: fixed` y la tabla scrollea debajo: sin esto quedaría flotando
  // apuntando a una fila que ya no está ahí.
  document.addEventListener("scroll", closeRowMenu, true);
  window.addEventListener("resize", closeRowMenu);
}

// ===================================================================== formularios con estado

/**
 * Botones de guardar que se apagan cuando no hay nada que guardar.
 *
 * Se compara el valor actual de los campos contra el último estado guardado, NO contra un flag
 * de "tocado": así, si el admin cambia un número y lo vuelve a dejar como estaba, el botón se
 * apaga solo en vez de ofrecer guardar algo idéntico a lo que ya está en disco.
 */
const forms = {};

function registerForm(name, buttonId, fieldIds, buildPayload, onSaved) {
  const form = { button: $(buttonId), fieldIds, buildPayload, onSaved, saved: null };
  forms[name] = form;
  for (const id of fieldIds) {
    const el = $(id);
    el.addEventListener("input", () => refreshFormButton(name));
    el.addEventListener("change", () => refreshFormButton(name));
  }
  form.button.addEventListener("click", () => saveForm(name));
}

function formSignature(form) {
  return JSON.stringify(
    form.fieldIds.map((id) => {
      const el = $(id);
      return el.type === "checkbox" ? el.checked : el.value;
    })
  );
}

function markFormSaved(name) {
  const form = forms[name];
  form.saved = formSignature(form);
  refreshFormButton(name);
}

function refreshFormButton(name) {
  const form = forms[name];
  const clean = form.saved !== null && form.saved === formSignature(form);
  form.button.disabled = clean;
  form.button.classList.toggle("saved", clean);
  form.button.textContent = clean ? "Guardado" : "Guardar";
}

async function saveForm(name) {
  const form = forms[name];
  try {
    await post("/api/config", form.buildPayload());
    markFormSaved(name);
    if (form.onSaved) form.onSaved();
    toast("Guardado");
  } catch (err) {
    toast("No se pudo guardar: " + err.message, 5000);
  }
}

function num(id) {
  return Number($(id).value);
}

function setupForms() {
  registerForm(
    "formation",
    "btn-save-formation",
    ["f-threshold", "f-tolerance", "f-grace", "f-penalty-type", "f-escalation"],
    () => ({
      formation: {
        penalty: {
          speedThresholdKmh: num("f-threshold"),
          toleranceSeconds: num("f-tolerance"),
          graceLaps: num("f-grace"),
          penaltyType: $("f-penalty-type").value,
          escalation: $("f-escalation").value,
        },
      },
    })
  );

  registerForm(
    "pit",
    "btn-save-pit",
    ["p-zone-start", "p-zone-end", "p-threshold", "p-tolerance", "p-grace", "p-stopgo", "p-penalty-type", "p-escalation"],
    () => ({
      pit: {
        zone: { splineStart: num("p-zone-start"), splineEnd: num("p-zone-end") },
        stopGoSeconds: num("p-stopgo"),
        penalty: {
          speedThresholdKmh: num("p-threshold"),
          toleranceSeconds: num("p-tolerance"),
          graceLaps: num("p-grace"),
          penaltyType: $("p-penalty-type").value,
          escalation: $("p-escalation").value,
        },
      },
    })
  );

  registerForm(
    "presence",
    "btn-save-presence",
    ["pr-enforce", "pr-grace"],
    () => ({ presence: { enforce: $("pr-enforce").checked, graceSeconds: num("pr-grace") } })
  );

  // El nombre de la liga no se registra como formulario: lo administra el portal y acá solo se
  // muestra. Ver la nota del campo en index.html.
}

// ===================================================================== catálogo de infracciones

/**
 * Cómo se presenta cada tipo de infracción.
 *
 * El backend decide QUÉ se puede configurar (`/api/catalog`) y esto decide CÓMO se explica. La
 * lista de acciones y de qué tipos aceptan sanción automática NO se duplica acá a propósito:
 * viene del servidor, que es el que después valida. Si viviera en los dos lados, el panel
 * terminaría ofreciendo una opción que el backend rechaza en silencio.
 */
const INFRACTION_UI = {
  // El umbral de velocidad de impacto de estos dos no se configura desde el panel: queda en su
  // valor por defecto (30 km/h para los toques, 60 para los choques en solitario), que es lo que
  // filtra los roces de parrilla y los pianos. Lo que el admin sí decide es la acción.
  carContact: {
    title: "Toques entre autos",
    help:
      "Un toque no dice de quién fue la culpa, así que nunca se sanciona solo: va a la bandeja " +
      "para que lo mires. Los roces suaves de parrilla no se registran.",
    fields: [],
  },
  envCollision: {
    title: "Choques en solitario",
    help: "Contra el muro, un piano o cualquier parte del circuito, sin nadie más involucrado.",
    fields: [],
  },
  trackLimits: {
    title: "Salidas de pista",
    help:
      "Las detecta la app del piloto: el servidor de Assetto Corsa solo informa cuántos cortes " +
      "hizo al terminar la vuelta, sin decir dónde. Un piloto sin la app no suma salidas.",
    fields: [
      {
        key: "minTyresOut",
        label: "Ruedas afuera que cuentan",
        options: [
          ["2", "2 ruedas (estricto)"],
          ["4", "4 ruedas (estándar)"],
        ],
      },
      { key: "excursionsForIncident", label: "Salidas antes de avisar", min: 1, max: 99 },
      { key: "minDurationMs", label: "Ignorar salidas más cortas que (ms)", min: 0, max: 10000 },
    ],
  },
  wrongWay: {
    title: "Circular en contramano",
    help:
      "Volver atrás despacio después de un trompo es normal y no cuenta. Lo que se mira es " +
      "retroceder rápido y sostenido.",
    fields: [
      { key: "minSeconds", label: "Segundos seguidos en contramano", min: 1, max: 60 },
      { key: "minSpeedKmh", label: "Desde esta velocidad (km/h)", min: 1, max: 300 },
    ],
  },
  disconnectDuringRace: {
    title: "Desconectarse en carrera",
    help: "Irse a mitad de carrera. Queda anotado para el informe; no hay nada que sancionar en vivo.",
    fields: [],
  },
};

/** Catálogo que mandó el backend. Null hasta que responde. */
let catalog = null;

function fieldId(type, key) {
  return "inf-" + type + "-" + key;
}

function infractionFieldIds() {
  const ids = [];
  for (const type of Object.keys(INFRACTION_UI)) {
    ids.push(fieldId(type, "action"));
    for (const field of INFRACTION_UI[type].fields) ids.push(fieldId(type, field.key));
  }
  return ids;
}

function buildInfractionsPayload() {
  const infractions = {};
  for (const type of Object.keys(INFRACTION_UI)) {
    const rule = { action: $(fieldId(type, "action")).value };
    for (const field of INFRACTION_UI[type].fields) {
      const el = $(fieldId(type, field.key));
      rule[field.key] = field.type === "checkbox" ? el.checked : Number(el.value);
    }
    infractions[type] = rule;
  }
  return { infractions: infractions };
}

function makeRow(labelText, control) {
  const row = document.createElement("div");
  row.className = "row";
  const label = document.createElement("label");
  label.setAttribute("for", control.id);
  label.textContent = labelText;
  row.appendChild(label);
  row.appendChild(control);
  return row;
}

function makeActionSelect(type) {
  const select = document.createElement("select");
  select.id = fieldId(type, "action");
  for (const action of Object.keys(catalog.actions)) {
    // "Sancionar solo" solo aparece donde el hecho es objetivo y medible. Mostrarlo en los demás
    // sería ofrecer un juicio que el dato no respalda, y el backend lo degradaría igual.
    if (action === "penalty" && catalog.autoPenaltyAllowed.indexOf(type) === -1) continue;
    const option = document.createElement("option");
    option.value = action;
    option.textContent = catalog.actions[action];
    select.appendChild(option);
  }
  return select;
}

function makeFieldControl(type, field) {
  let control;
  if (field.options) {
    control = document.createElement("select");
    for (const pair of field.options) {
      const option = document.createElement("option");
      option.value = pair[0];
      option.textContent = pair[1];
      control.appendChild(option);
    }
  } else {
    control = document.createElement("input");
    control.type = field.type === "checkbox" ? "checkbox" : "number";
    if (field.min !== undefined) control.min = String(field.min);
    if (field.max !== undefined) control.max = String(field.max);
  }
  control.id = fieldId(type, field.key);
  return control;
}

function buildInfractionsUI() {
  const list = $("infractions-list");
  clearChildren(list);

  for (const type of Object.keys(INFRACTION_UI)) {
    const spec = INFRACTION_UI[type];
    const box = document.createElement("div");
    box.className = "infraction";
    box.dataset.type = type;

    const title = document.createElement("h4");
    title.textContent = spec.title;
    box.appendChild(title);

    const help = document.createElement("p");
    help.textContent = spec.help;
    box.appendChild(help);

    const action = makeActionSelect(type);
    action.addEventListener("change", () => refreshInfractionState(box));
    box.appendChild(makeRow("Qué hacer", action));

    for (const field of spec.fields) box.appendChild(makeRow(field.label, makeFieldControl(type, field)));
    list.appendChild(box);
  }

  registerForm("infractions", "btn-save-infractions", infractionFieldIds(), buildInfractionsPayload);
}

/** Apaga los umbrales de un tipo que no se está controlando: siguen a la vista para que se
 * entienda qué se estaría mirando, pero dejan de pedir una decisión que no se va a usar. */
function refreshInfractionState(box) {
  box.classList.toggle("off", $(fieldId(box.dataset.type, "action")).value === "ignore");
}

// ===================================================================== perfiles de carrera

/**
 * Perfiles de carrera: el reglamento completo, guardado con un nombre.
 *
 * Reemplazan a los tres tipos de torneo de fábrica. Acá había tres botones que aplicaban un
 * paquete de valores; el problema no era el paquete sino que no había vuelta: tocabas dos
 * umbrales para la fecha de resistencia y la configuración de la fecha normal se perdía.
 *
 * Las validaciones —nombre repetido, reglas repetidas— las hace el servidor y devuelve 409 con el
 * texto ya escrito. El panel no las duplica a propósito: una regla de unicidad que vive en el
 * navegador no es una regla, y acá el mismo backend lo sirve por internet a través del portal.
 */
function renderProfiles(config) {
  const select = $("profile-select");
  const perfiles = config.ruleProfiles || [];
  clearChildren(select);
  for (const perfil of perfiles) {
    const option = document.createElement("option");
    option.value = perfil.id;
    // `textContent` y no innerHTML: el nombre lo escribe el admin.
    option.textContent = perfil.name;
    select.appendChild(option);
  }
  if (config.activeProfileId) select.value = config.activeProfileId;

  const vacio = perfiles.length === 0;
  select.disabled = vacio;
  $("btn-apply-profile").disabled = vacio;
  $("btn-delete-profile").disabled = vacio;
  $("profile-empty").hidden = !vacio;
}

function wireProfiles() {
  $("btn-save-profile").addEventListener("click", async () => {
    const input = $("profile-name");
    const name = input.value.trim();
    if (!name) {
      toast("Ponele un nombre al perfil");
      input.focus();
      return;
    }
    try {
      const res = await post("/api/profiles", { name });
      input.value = "";
      fillConfigForm(res.config);
      toast('Guardado el perfil "' + res.profile.name + '"');
    } catch (err) {
      // El 409 llega acá con el mensaje del servidor, que ya nombra al perfil que choca. Dura más
      // que un toast normal: hay que leer un nombre, no solo registrar que algo falló.
      toast(err.message, 6000);
    }
  });

  $("btn-apply-profile").addEventListener("click", async () => {
    const select = $("profile-select");
    if (!select.value) return;
    try {
      const res = await post("/api/profiles/" + encodeURIComponent(select.value) + "/apply");
      // Un perfil toca el catálogo, las dos sanciones, la zona de pit y la app del piloto: se
      // repinta el cajón entero y no solo esta sección, si no quedarían campos con lo anterior.
      fillConfigForm(res.config);
      toast('Reglas de "' + res.profile.name + '" cargadas');
    } catch (err) {
      toast("No se pudo cargar: " + err.message, 5000);
    }
  });

  $("btn-delete-profile").addEventListener("click", async () => {
    const select = $("profile-select");
    if (!select.value) return;
    const nombre = select.options[select.selectedIndex].textContent;
    if (!window.confirm('¿Borrar el perfil "' + nombre + '"?\n\nLas reglas que están puestas ahora no cambian: lo que se pierde es poder volver a cargarlas de una.')) {
      return;
    }
    try {
      const res = await del("/api/profiles/" + encodeURIComponent(select.value));
      fillConfigForm(res.config);
      toast('Perfil "' + nombre + '" borrado');
    } catch (err) {
      toast("No se pudo borrar: " + err.message, 5000);
    }
  });
}

async function loadConfigForm() {
  // El catálogo primero: la sección de infracciones se arma con lo que el backend dice que se
  // puede configurar, así que sin eso no hay campos donde volcar los valores.
  catalog = await api("/api/catalog");
  buildInfractionsUI();
  fillConfigForm(await api("/api/config"));
}

function fillConfigForm(config) {
  $("f-threshold").value = config.formation.penalty.speedThresholdKmh;
  $("f-tolerance").value = config.formation.penalty.toleranceSeconds;
  $("f-grace").value = config.formation.penalty.graceLaps;
  $("f-penalty-type").value = config.formation.penalty.penaltyType;
  $("f-escalation").value = config.formation.penalty.escalation;

  $("p-zone-start").value = config.pit.zone.splineStart;
  $("p-zone-end").value = config.pit.zone.splineEnd;
  $("p-threshold").value = config.pit.penalty.speedThresholdKmh;
  $("p-tolerance").value = config.pit.penalty.toleranceSeconds;
  $("p-grace").value = config.pit.penalty.graceLaps;
  $("p-stopgo").value = config.pit.stopGoSeconds;
  $("p-penalty-type").value = config.pit.penalty.penaltyType;
  $("p-escalation").value = config.pit.penalty.escalation;

  for (const type of Object.keys(INFRACTION_UI)) {
    const rule = config.infractions[type];
    $(fieldId(type, "action")).value = rule.action;
    for (const field of INFRACTION_UI[type].fields) {
      const el = $(fieldId(type, field.key));
      if (field.type === "checkbox") el.checked = rule[field.key];
      else el.value = String(rule[field.key]);
    }
    refreshInfractionState($("infractions-list").querySelector('[data-type="' + type + '"]'));
  }
  renderProfiles(config);

  $("pr-enforce").checked = config.presence.enforce;
  $("pr-grace").value = config.presence.graceSeconds;

  $("league-input").value = config.leagueName;

  for (const name of Object.keys(forms)) markFormSaved(name);
}

// ===================================================================== torre de tiempos

/** Filas vivas por carId. Se reutilizan en vez de recrear la tabla entera cada segundo: si no,
 * se pierde el hover, la selección parpadea y el botón de kick armado se desarma solo. */
const carRows = new Map();

/** Kick a medio confirmar: { carId, timer }. Sobrevive a los re-renders por estar acá afuera. */
let armedKick = null;

const KICK_ARM_MS = 4000;

/** Qué columnas vienen de la app del piloto y no del servidor. El protocolo UDP de Assetto Corsa
 * no transporta nada de esto —solo la Shared Memory del juego lo tiene— así que sin la app del
 * piloto quedan en guiones. No hay forma de completarlas desde el servidor. */
const NO_APP_TITLE = "Este dato solo existe en la Shared Memory del juego: hace falta que el piloto tenga la app de Race Control.";

function renderTiming(cars) {
  const body = $("cars-body");
  $("cars-empty").hidden = cars.length > 0;

  // El contador cuenta a los que están en pista, no las filas: desde la 1.2 la torre también
  // muestra a los que se desconectaron, y "26 en pista" con veinte autos girando sería mentira.
  const enPista = cars.filter((c) => c.connected !== false).length;
  const afuera = cars.length - enPista;
  $("cars-count").textContent =
    cars.length === 0 ? "" : enPista + " en pista" + (afuera > 0 ? " · " + afuera + " fuera" : "");

  // Orden de la torre: lo decide el servidor (progreso en carrera, mejor vuelta en práctica y
  // clasificación) y acá solo se respeta. Quien todavía no tiene posición va al fondo, y los
  // desconectados más al fondo todavía: siguen en la tabla para no perder sus tiempos, pero no
  // compiten contra nadie y mezclarlos entre los que giran haría perder la lectura de la torre.
  const ordered = cars.slice().sort((a, b) => {
    const fueraA = a.connected === false ? 1 : 0;
    const fueraB = b.connected === false ? 1 : 0;
    if (fueraA !== fueraB) return fueraA - fueraB;
    return (a.position || 999) - (b.position || 999);
  });

  // Mejor vuelta absoluta de la sesión, para pintarla distinto. Se calcula sobre el conjunto, así
  // que tiene que salir de acá y no de la fila.
  const sessionBest = ordered.reduce(
    (best, car) => (car.bestLapMs !== null && (best === null || car.bestLapMs < best) ? car.bestLapMs : best),
    null
  );

  const seen = new Set();
  for (const car of ordered) {
    seen.add(car.carId);
    let row = carRows.get(car.carId);
    if (!row) {
      row = createCarRow(car.carId);
      carRows.set(car.carId, row);
    }
    updateCarRow(row, car, sessionBest);
    body.appendChild(row.tr); // appendChild reordena si ya estaba: mantiene el orden de la torre
  }

  for (const [carId, row] of carRows) {
    if (seen.has(carId)) continue;
    row.tr.remove();
    carRows.delete(carId);
    if (selectedCarId === carId) selectedCarId = null;
    if (armedKick && armedKick.carId === carId) disarmKick();
    if (openMenu && openMenu.carId === carId) closeRowMenu();
  }

  // La columna de Ping desaparece entera cuando nadie la puede llenar.
  //
  // El ping no viene del servidor de Assetto Corsa: el protocolo UDP no lo transporta. Es el
  // round-trip de la app del piloto contra Race Control, así que sin la app no hay dato posible.
  // Mostrar veinte "sin app" en rojo en una columna propia no informaba nada que el panel no
  // diga mejor en "La app de los pilotos", y hacía parecer roto algo que simplemente no aplica.
  $("timing-table").classList.toggle("sin-ping", !cars.some(tienePing));
}

function tienePing(car) {
  return car.pingMs !== null && car.pingMs !== undefined;
}

function createCarRow(carId) {
  const tr = document.createElement("tr");
  tr.className = "selectable";
  tr.addEventListener("click", (e) => {
    if (e.target.closest("button")) return; // el kick no debe además seleccionar
    selectedCarId = selectedCarId === carId ? null : carId;
    applySelectionToRows();
  });

  const cells = {
    pos: cell("c-pos"),
    car: cell("c-car"),
    name: cell("c-driver"),
    gap: cell("num c-gap"),
    speed: cell("num"),
    laps: cell("num"),
    // Acá estaban "Fuera" (las vueltas invalidadas) y "Sectores". Las dos se sacaron en la 1.1:
    // los sectores porque no funcionaban —solo los tiene la app del piloto y no llegaban—, y
    // "Fuera" porque ese número ahora vive donde se usa, en el resumen por piloto de la bandeja
    // de incidentes ("Cuts: 10"). El `cuts` del backend sigue viajando en `/api/state`.
    last: cell("num lap-time"),
    best: cell("num lap-time"),
    pits: cell("num"),
    tyre: cell(""),
    fuel: cell("num"),
    ping: cell("num c-ping"),
    actions: cell("actions"),
  };

  for (const key of ["pits", "tyre", "fuel"]) cells[key].title = NO_APP_TITLE;

  // Las acciones destructivas viven detrás de los tres puntitos, no sueltas en la fila. Un botón
  // "Kick" visible en veinte filas de una tabla que se reordena sola es un accidente esperando
  // que alguien mueva el mouse en el momento equivocado.
  const kebab = document.createElement("button");
  kebab.className = "btn-kebab";
  kebab.textContent = "⋮";
  kebab.title = "Más acciones";
  kebab.setAttribute("aria-label", "Más acciones");
  kebab.setAttribute("aria-haspopup", "menu");
  kebab.setAttribute("aria-expanded", "false");
  kebab.addEventListener("click", () => toggleRowMenu(carId, kebab));
  cells.actions.appendChild(kebab);

  for (const key of Object.keys(cells)) tr.appendChild(cells[key]);
  return Object.assign({ tr, kebab }, cells);
}

function cell(className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  return td;
}

function updateCarRow(row, car, sessionBest) {
  const telemetry = car.telemetry || null;

  row.pos.textContent = car.position === null || car.position === undefined ? "--" : String(car.position);

  const label = car.driverName || "Auto " + car.carId;
  if (row.name.textContent !== label) row.name.textContent = label;
  row.name.title = label;

  renderCarBadge(row.car, car);

  renderGap(row.gap, car);

  // Velocidad, o el aviso de que no hay dato nuevo. Un auto congelado seguía mostrando su última
  // velocidad como si todavía estuviera girando a esa velocidad — que es lo contrario de lo que
  // pasa: está quieto, desconectándose o con el juego cerrado.
  if (car.connected === false) {
    // La fila se queda, pero tiene que decir por qué está apagada. Sin esto, un desconectado se
    // ve igual que alguien detenido en pista con la señal cortada, que es otra cosa.
    clearChildren(row.speed);
    const aviso = document.createElement("span");
    aviso.className = "sin-conexion";
    aviso.textContent = "desconectado";
    aviso.title = "Salió del servidor. La fila queda con sus tiempos de la sesión: si vuelve a entrar, la recupera.";
    row.speed.appendChild(aviso);
  } else if (car.telemetryStale) {
    clearChildren(row.speed);
    const aviso = document.createElement("span");
    aviso.className = "sin-senal";
    aviso.textContent = "sin señal";
    aviso.title = "Hace más de dos segundos que no llega telemetría de este auto. Los datos de esta fila son los últimos que recibimos.";
    row.speed.appendChild(aviso);
  } else if (car.inPit) {
    // En boxes la velocidad no dice nada —va a 40 o a 0— y lo que el admin necesita saber de un
    // vistazo es por qué ese auto se descolgó de la clasificación. El backend lo resuelve con la
    // app del piloto si la hay y con la zona de pit configurada si no; ver `estaEnPit`.
    clearChildren(row.speed);
    const pit = document.createElement("span");
    pit.className = "en-pit";
    pit.textContent = "PIT";
    pit.title = "En el pit lane";
    row.speed.appendChild(pit);
  } else {
    row.speed.textContent = Math.round(car.speedKmh) + " km/h";
  }
  // "L" adelante: en una columna de números sueltos entre tiempos y velocidades, un "4" pelado no
  // se lee como vueltas hasta que uno mira el encabezado.
  row.laps.textContent = "L" + car.lapCount;

  setText(row.last, formatLapTime(car.lastLapMs));
  setText(row.best, formatLapTime(car.bestLapMs));
  // Morado la mejor de todos, verde la mejor propia: es el código de color de cualquier torre de
  // tiempos de sim racing, así que no hay que explicarlo.
  row.best.classList.toggle("session-best", car.bestLapMs !== null && car.bestLapMs === sessionBest);
  row.best.classList.toggle("personal-best", car.bestLapMs !== null && car.bestLapMs !== sessionBest);
  row.last.classList.toggle("personal-best", car.lastLapMs !== null && car.lastLapMs === car.bestLapMs);

  renderPits(row.pits, telemetry);
  setText(row.tyre, telemetry ? tyreLabel(telemetry.tyreCompound) : null, NO_APP_TITLE);
  // El nombre completo no se pierde: va al tooltip, por si alguna vez hace falta el compuesto
  // exacto y no solo el código.
  row.tyre.title = telemetry && telemetry.tyreCompound ? telemetry.tyreCompound : NO_APP_TITLE;
  setText(row.fuel, telemetry && telemetry.fuelLiters !== null ? telemetry.fuelLiters.toFixed(1) + " L" : null, NO_APP_TITLE);

  clearChildren(row.ping);
  row.ping.appendChild(pingBadge(car));

  const fuera = car.connected === false;
  row.tr.classList.toggle("desconectado", fuera);
  row.tr.classList.toggle("in-pit", !fuera && Boolean(car.inPit));
  // Un desconectado tiene la telemetría vencida por definición: marcarlo además como "stale"
  // apilaría dos grises distintos sobre la misma fila y ninguno de los dos se leería.
  row.tr.classList.toggle("stale", !fuera && Boolean(car.telemetryStale));
  row.tr.classList.toggle("selected", selectedCarId === car.carId);
  // Nada que hacerle a alguien que ya no está en el servidor: ni kickearlo ni sancionarlo en
  // vivo. El menú se deshabilita en vez de esconderse, para que la columna no baile.
  row.kebab.disabled = fuera;
  row.kebab.title = fuera ? "El piloto no está conectado" : "Más acciones";
  // El kick vive dentro del menú de tres puntitos, que puede estar cerrado: el punto rojo en los
  // puntitos es lo único que queda a la vista de que hay un kick a medio confirmar.
  row.kebab.classList.toggle("arming", armedKick !== null && armedKick.carId === car.carId);
}

/** Un valor ausente nunca se dibuja como vacío: un hueco se lee como "cero" o como un bug, y acá
 * significa algo concreto —falta la app del piloto— que el tooltip explica. */
function setText(td, value, missingTitle) {
  if (value === null || value === undefined || value === "") {
    if (td.firstChild && td.firstChild.className === "nodata") return;
    clearChildren(td);
    const span = document.createElement("span");
    span.className = "nodata";
    span.textContent = "--";
    if (missingTitle) span.title = missingTitle;
    td.appendChild(span);
    return;
  }
  if (td.textContent !== value) td.textContent = value;
}

/**
 * La celda de intervalo.
 *
 * Tiene cuatro estados y los cuatro significan cosas distintas, así que ninguno puede quedar como
 * una celda vacía: "líder" (no hay nadie adelante), "+N vta" (doblado, y ahí las décimas no
 * significan nada), un número, o `--` cuando todavía no hay con qué calcularlo —la primera curva
 * de la largada, antes de que alguien cierre una vuelta—.
 */
function renderGap(td, car) {
  const lapsDown = car.lapsDown || 0;
  const ms = gapMode === "leader" ? car.gapLeaderMs : car.gapAheadMs;

  clearChildren(td);
  td.classList.toggle("lider", car.position === 1);
  td.classList.toggle("doblado", lapsDown >= 1);

  if (car.position === 1) {
    td.textContent = "líder";
    td.title = "Va primero: no hay nadie adelante.";
    return;
  }
  if (lapsDown >= 1) {
    td.textContent = "+" + lapsDown + (lapsDown === 1 ? " vta" : " vtas");
    td.title = "Está a " + lapsDown + (lapsDown === 1 ? " vuelta" : " vueltas") + " del líder.";
    return;
  }
  if (ms === null || ms === undefined) {
    const span = document.createElement("span");
    span.className = "nodata";
    span.textContent = "--";
    span.title = "Todavía no hay una vuelta de referencia con la que estimar el intervalo.";
    td.appendChild(span);
    return;
  }
  td.textContent = formatGap(ms);
  td.title =
    gapMode === "leader"
      ? "Diferencia estimada con el líder."
      : "Diferencia estimada con el auto de adelante.";
}

/** El encabezado dice cuál de las dos cuentas está mostrando. Sin esto la columna es ambigua: los
 * dos modos se ven igual —un número con un `+` adelante— y un intervalo mal leído manda a un
 * director de carrera a tomar una decisión equivocada. */
function renderGapHeader() {
  const th = $("th-gap");
  const btn = $("btn-gap-mode");
  if (gapMode === "leader") {
    btn.textContent = "Líder";
    th.title = "Diferencia con el líder. Clickeá para ver el intervalo con el auto de adelante.";
  } else {
    btn.textContent = "Int.";
    th.title = "Intervalo con el auto de adelante. Clickeá para ver la diferencia con el líder.";
  }
  btn.setAttribute("aria-label", th.title);
}

/** ms → `+1.423`, y `+1:02.4` cuando pasa del minuto. El signo va siempre: un intervalo es una
 * distancia hacia atrás, nunca un tiempo absoluto, y sin el `+` se confunde con una vuelta. */
function formatGap(ms) {
  if (ms < 60000) return "+" + (ms / 1000).toFixed(3);
  const minutes = Math.floor(ms / 60000);
  const seconds = (ms % 60000) / 1000;
  return "+" + minutes + ":" + (seconds < 10 ? "0" : "") + seconds.toFixed(1);
}

/** ms → `m:ss.mmm`, la notación de cualquier torre de tiempos. */
function formatLapTime(ms) {
  if (ms === null || ms === undefined) return null;
  const minutes = Math.floor(ms / 60000);
  const seconds = (ms % 60000) / 1000;
  return minutes + ":" + (seconds < 10 ? "0" : "") + seconds.toFixed(3);
}

// Acá vivía `renderSectors`. La columna de sectores se sacó de la torre en la 1.1 porque en pista
// nunca mostró un número: los tiempos por sector solo existen en la Shared Memory del juego y los
// reporta la app del piloto, así que eran veinte guiones permanentes. El backend los sigue
// mandando en `telemetry.sectors` —no se tocó nada del lado del servidor—, de modo que reponer la
// columna el día que el reporte funcione es volver a escribir esta función y el `<th>`.

function renderPits(td, telemetry) {
  if (!telemetry || telemetry.pitStops === null) {
    setText(td, null, NO_APP_TITLE);
    return;
  }
  // "PIT" y no "en box": la columna de velocidad ya dice PIT para lo mismo, y dos palabras
  // distintas para un solo estado hacen dudar de si son dos estados.
  const label = telemetry.inPitLane ? telemetry.pitStops + " · PIT" : String(telemetry.pitStops);
  if (td.textContent !== label) td.textContent = label;
}

/**
 * El compuesto, corto.
 *
 * El juego manda el nombre comercial completo —"Michelin S8M"— y en una columna de tabla eso entra
 * cortado o estira la fila. Lo único que el comisario mira es el código, que es justo lo que los
 * mods ponen entre paréntesis: "Michelin S8M (S8M)" → "S8M". Sin paréntesis se deja tal cual, que
 * es el caso de los autos de fábrica ("Street", "Semislick"), donde el nombre YA es corto.
 */
function tyreLabel(compound) {
  if (!compound) return null;
  const m = /\(([^)]+)\)/.exec(compound);
  return m ? m[1].trim() : compound;
}

/**
 * Logo de marca del auto, de la biblioteca de logos que viene empaquetada con la app.
 *
 * El backend ya resolvió qué archivo corresponde (`brandLogo`) y manda `null` si esa marca no
 * está en la biblioteca: así la celda dibuja el escudo con monograma de una, sin pedir una imagen
 * que va a dar 404 —que se veía como un parpadeo en cada fila de auto mod.
 */
function renderCarBadge(td, car) {
  if (td.dataset.model === car.carModel) return;
  td.dataset.model = car.carModel;
  clearChildren(td);

  if (!car.brandLogo) {
    td.appendChild(brandShield(car));
    return;
  }

  const img = document.createElement("img");
  img.className = "car-badge";
  img.alt = car.brand || car.carModel;
  img.title = car.brand || car.carModel;
  // `BASE` y no una ruta absoluta: en producción el panel vive en `/l/<liga>/`, así que
  // `/brands/x.svg` no le pega al worker sino a la raíz del portal, que no tiene esa carpeta. El
  // resultado era un 404 por cada auto y el escudo de iniciales en TODAS las filas, para siempre.
  // El resto del panel ya usa rutas relativas; esta era la única absoluta y por eso se escapó.
  img.src = BASE + "/brands/" + encodeURIComponent(car.brandLogo) + ".svg";
  img.addEventListener("error", () => {
    // Si el archivo no está (biblioteca incompleta en un build a medias), la fila no queda vacía.
    if (td.dataset.model !== car.carModel) return;
    clearChildren(td);
    td.appendChild(brandShield(car));
  });
  td.appendChild(img);
}

/**
 * Escudo con monograma: el reemplazo del logo cuando Assetto Corsa no está instalado en la PC del
 * admin o el auto es un mod sin `badge.png`.
 *
 * Por qué un escudo y no el nombre de la marca en texto: la columna de auto se lee de reojo a
 * media carrera, y una palabra obliga a leerla. Una forma de color constante por marca se
 * reconoce sin leer, que es exactamente lo que hace el logo real. No se empaquetan archivos de
 * logos de terceros en el repo —son marcas registradas—; esto se dibuja con CSS.
 */
function brandShield(car) {
  const brand = car.brand || car.carModel || "";
  const wrap = document.createElement("span");
  wrap.className = "brand-shield";
  wrap.title = car.carModel || brand;
  if (!brand) {
    wrap.classList.add("empty");
    wrap.textContent = "--";
    return wrap;
  }
  const color = brandColor(brand);
  wrap.style.setProperty("--shield", color);
  wrap.style.setProperty("--shield-ink", inkFor(color));
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", brand);
  const text = document.createElement("span");
  text.textContent = monogramOf(brand);
  wrap.appendChild(text);
  return wrap;
}

/**
 * Colores de marca. **Una sola paleta** para el escudo de la torre y el punto del mapa: si fueran
 * dos, el mismo auto tendría un color en cada lado y el color dejaría de servir para cruzar una
 * cosa con la otra, que es justamente para lo que está.
 *
 * El criterio es "el color con el que esa marca se reconoce", no el Pantone oficial: sobre un
 * asfalto gris oscuro y en un punto de 6 px, el rojo Ferrari de catálogo y el rojo Toyota de
 * catálogo son el mismo punto. Por eso la parrilla GT3 —que es la que corre— se reparte el círculo
 * cromático a propósito y las marcas que no aparecen en GT3 se quedan con su color real aunque
 * choquen entre ellas.
 *
 * El resto no se mantiene a mano: se deriva un tono estable del propio nombre, así un auto mod
 * también tiene su color y siempre el mismo.
 */
const BRAND_COLORS = {
  // La parrilla GT3, que es la que se ve en el mapa un domingo.
  "Ferrari": "#e10600",
  "BMW": "#0d6ec9",
  "Porsche": "#53c7f0",
  "Mercedes-Benz": "#a8b0bd",
  "Aston Martin": "#118a63",
  "Lexus": "#9b5cf6",
  "McLaren": "#ff8000",
  "Chevrolet Corvette": "#ffd500",
  "Chevrolet": "#ffd500",
  "Audi": "#e0218a",
  "Lamborghini": "#b5e61d",
  "Honda": "#f0e6d2",
  "Acura": "#d9c48f",
  "Nissan": "#ff5e9c",
  "Alpine": "#3f6fe0",
  "Bentley": "#16a39a",
  "Ford": "#8b5a2b",
  "Cadillac": "#7d1128",
  "Ginetta": "#1f9ad6",
  // Fuera de GT3: acá sí manda el color real de la marca.
  "Abarth": "#b01c21",
  "Alfa Romeo": "#9b1b30",
  "Jaguar": "#1d4a3f",
  "Lancia": "#1b4f9c",
  "Lotus": "#6aa84f",
  "Maserati": "#15284b",
  "Mazda": "#7b1d2b",
  "Pagani": "#2d4a6b",
  "Renault": "#d6c01d",
  "Subaru": "#0b3d91",
  "Toyota": "#c8102e",
  "Volkswagen": "#0a3d7a",
};

/** Color del punto del auto en el mapa. Sin marca reconocida vuelve al dorado del acento, que es
 * como se dibujaba toda la parrilla antes de la 1.2. */
function carMapColor(car) {
  const brand = car && (car.brand || car.carModel);
  return brand ? brandColor(brand) : "#f0b429";
}

function brandColor(brand) {
  if (BRAND_COLORS[brand]) return BRAND_COLORS[brand];
  // Hash determinístico del nombre a un tono. Lo importante no es acertarle al color real de la
  // marca —imposible para 200 mods— sino que sea siempre el mismo para la misma marca.
  let hash = 0;
  for (let i = 0; i < brand.length; i++) hash = (hash * 31 + brand.charCodeAt(i)) % 360;
  return "hsl(" + hash + ", 52%, 40%)";
}

/** Blanco salvo que el fondo sea claro; si no, el amarillo de Lamborghini deja el monograma
 * ilegible. La luminancia se calcula, no se adivina marca por marca. */
function inkFor(color) {
  if (color.charAt(0) !== "#") return "#ffffff";
  const n = parseInt(color.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#101217" : "#ffffff";
}

/** "Ferrari" → FER, "BMW" → BMW, "Mercedes-Benz" → MB, "Race Sim Studio" → RSS. */
function monogramOf(brand) {
  const words = brand.split(/[\s\-]+/).filter(Boolean);
  if (words.length > 1) {
    return words
      .map((w) => w.charAt(0))
      .join("")
      .slice(0, 3)
      .toUpperCase();
  }
  return brand.slice(0, 3).toUpperCase();
}

/**
 * Qué mide realmente esta columna: el round-trip de la app del piloto contra Race Control. El
 * protocolo UDP de AC no expone el ping del piloto al servidor de carrera, así que esto NO es
 * eso. Sirve igual para lo que el admin quiere saber: quién tiene conexión inestable.
 */
function pingBadge(car) {
  const span = document.createElement("span");
  if (car.pingMs === null || car.pingMs === undefined) {
    span.className = "badge bad";
    span.textContent = "sin app";
    span.title = "Este piloto no tiene la app de Race Control reportando.";
    return span;
  }
  span.className = "badge " + (car.pingMs < 120 ? "ok" : car.pingMs < 300 ? "warn" : "bad");
  span.textContent = car.pingMs + " ms";
  return span;
}

function applySelectionToRows() {
  for (const [carId, row] of carRows) {
    row.tr.classList.toggle("selected", selectedCarId === carId);
  }
}

// --------------------------------------------------------------- menú de fila (tres puntitos)

/**
 * El menú vive en `document.body`, no adentro de la celda.
 *
 * La tabla está dentro de un contenedor con `overflow: auto` en los dos ejes, así que un popup
 * posicionado dentro de la fila quedaría recortado por el scroll —visible a medias o directamente
 * invisible en la última fila, que es donde más se usa—. Con `position: fixed` y las coordenadas
 * tomadas del botón no hay recorte posible. El precio es que no se mueve con el scroll: por eso
 * se cierra al scrollear.
 *
 * Es uno solo para toda la tabla: nunca hay dos abiertos y no quedan veinte menús ocultos en el
 * DOM reconstruyéndose en cada poll.
 */
let openMenu = null;

function toggleRowMenu(carId, anchor) {
  const yaEstaba = openMenu !== null && openMenu.carId === carId;
  closeRowMenu();
  if (yaEstaba) return;

  const menu = document.createElement("div");
  menu.className = "menu-fila";
  menu.setAttribute("role", "menu");

  const kick = document.createElement("button");
  kick.className = "menu-item peligro";
  kick.setAttribute("role", "menuitem");
  kick.textContent = "Expulsar del servidor";
  kick.addEventListener("click", () => onKickClick(carId));
  menu.appendChild(kick);

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  // Alineado a la derecha del botón y debajo, salvo que no entre: ahí sube por encima.
  const abajo = r.bottom + 4;
  const arriba = r.top - menu.offsetHeight - 4;
  menu.style.top = (abajo + menu.offsetHeight <= window.innerHeight - 8 || arriba < 8 ? abajo : arriba) + "px";
  menu.style.left = Math.max(8, r.right - menu.offsetWidth) + "px";

  anchor.setAttribute("aria-expanded", "true");
  openMenu = { carId, el: menu, anchor, kick };
  syncMenuKick();
}

function closeRowMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  openMenu.anchor.setAttribute("aria-expanded", "false");
  openMenu = null;
}

/** El texto del kick refleja si está armado, tanto al abrir el menú como cuando se desarma solo. */
function syncMenuKick() {
  if (!openMenu) return;
  const armed = armedKick !== null && armedKick.carId === openMenu.carId;
  openMenu.kick.textContent = armed ? "¿Seguro? Confirmá para expulsar" : "Expulsar del servidor";
  openMenu.kick.classList.toggle("arming", armed);
}

// --------------------------------------------------------------- kick con doble confirmación

function disarmKick() {
  if (!armedKick) return;
  clearTimeout(armedKick.timer);
  const row = carRows.get(armedKick.carId);
  armedKick = null;
  if (row) row.kebab.classList.remove("arming");
  syncMenuKick();
}

/**
 * Primer click arma, segundo ejecuta. Se desarma solo a los 4 segundos.
 *
 * Expulsar a alguien a mitad de carrera no se deshace, así que no puede salir de un click
 * fallido en una tabla que se actualiza sola. Un `confirm()` nativo tampoco servía: bloquea el
 * hilo y congela el mapa y el polling mientras está abierto.
 */
function onKickClick(carId) {
  if (armedKick && armedKick.carId === carId) {
    disarmKick();
    closeRowMenu();
    executeKick(carId);
    return;
  }
  disarmKick();
  armedKick = { carId, timer: setTimeout(disarmKick, KICK_ARM_MS) };
  const row = carRows.get(carId);
  if (row) row.kebab.classList.add("arming");
  syncMenuKick();
}

async function executeKick(carId) {
  try {
    const res = await post("/api/cars/" + carId + "/kick");
    toast("Expulsado: " + (res.driverName || "auto " + carId));
  } catch (err) {
    toast("No se pudo expulsar: " + err.message, 5000);
  }
}

// ===================================================================== mapa del circuito

const canvas = $("map-canvas");
const ctx = canvas.getContext("2d");

/** Posición dibujada de cada auto, interpolada. El poll llega 1 vez por segundo: sin interpolar,
 * los autos avanzarían a saltos de un segundo. Clave: carId. */
const carAnim = new Map();

/** Auto bajo el cursor. Separado de `selectedCarId`: hover es efímero, selección es deliberada. */
let hoveredCarId = null;
let mousePos = null;

function resizeCanvas() {
  const host = $("map-host");
  const ratio = window.devicePixelRatio || 1;
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

/** Proyección mundo → canvas. Conserva la proporción: un circuito largo y angosto no debe salir
 * estirado hasta llenar el cuadro. El eje Z se invierte para que el dibujo no quede espejado. */
function projector() {
  if (!trackOutline) return null;
  const b = trackOutline.bounds;
  const pad = 22;
  const w = $("map-host").clientWidth;
  const h = $("map-host").clientHeight;
  const spanX = Math.max(1, b.maxX - b.minX);
  const spanZ = Math.max(1, b.maxZ - b.minZ);
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ);
  const offsetX = (w - spanX * scale) / 2;
  const offsetY = (h - spanZ * scale) / 2;
  return (x, z) => ({
    x: offsetX + (x - b.minX) * scale,
    y: offsetY + (b.maxZ - z) * scale,
  });
}

function updateCarTargets(cars) {
  const now = performance.now();
  const alive = new Set();
  for (const car of cars) {
    alive.add(car.carId);
    const prev = carAnim.get(car.carId);
    if (!prev) {
      carAnim.set(car.carId, { fromX: car.posX, fromZ: car.posZ, toX: car.posX, toZ: car.posZ, at: now, car });
      continue;
    }
    const current = interpolate(prev, now);
    // Un salto grande es un teletransporte real (reset a boxes, cambio de sesión): interpolar
    // eso dibujaría el auto cruzando el circuito en línea recta por el medio del dibujo.
    const jumped = Math.hypot(car.posX - current.x, car.posZ - current.z) > 150;
    carAnim.set(car.carId, {
      fromX: jumped ? car.posX : current.x,
      fromZ: jumped ? car.posZ : current.z,
      toX: car.posX,
      toZ: car.posZ,
      at: now,
      car,
    });
  }
  for (const carId of carAnim.keys()) {
    if (!alive.has(carId)) carAnim.delete(carId);
  }
}

function interpolate(anim, now) {
  const t = Math.min(1, (now - anim.at) / POLL_MS);
  return { x: anim.fromX + (anim.toX - anim.fromX) * t, z: anim.fromZ + (anim.toZ - anim.fromZ) * t };
}

function drawMap() {
  const project = projector();
  if (!project) return;

  const w = $("map-host").clientWidth;
  const h = $("map-host").clientHeight;
  ctx.clearRect(0, 0, w, h);

  // Trazado.
  ctx.beginPath();
  const pts = trackOutline.points;
  for (let i = 0; i < pts.length; i++) {
    const p = project(pts[i].x, pts[i].z);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  // Solo se cierra el circuito si el trazado está completo; con huecos, cerrarlo dibuja una
  // recta falsa de punta a punta que parece parte de la pista.
  //
  // `closed === false` es el otro caso donde no hay que cerrar, y no tiene nada que ver con estar
  // incompleto: hay pistas que no son un circuito. Una subida de montaña (Trento-Bondone) o una
  // ruta punto a punto terminan a kilómetros de donde arrancaron, y cerrarlas dibujaría una recta
  // cruzando el mapa entero. El campo lo pone el catálogo; lo aprendido no lo trae y asume cerrado,
  // que es lo que era hasta ahora.
  if (trackOutline.closed !== false && trackOutline.coverage > 0.95) ctx.closePath();
  ctx.strokeStyle = "#2f3545";
  ctx.lineWidth = 13;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.strokeStyle = "#1b1f28";
  ctx.lineWidth = 9;
  ctx.stroke();

  // La zona de pit, encima del asfalto y debajo de los autos.
  drawPitZone(project);

  // Autos.
  const now = performance.now();
  let closest = null;
  for (const [carId, anim] of carAnim) {
    const pos = interpolate(anim, now);
    const p = project(pos.x, pos.z);
    const selected = carId === selectedCarId;
    const hovered = carId === hoveredCarId;

    if (mousePos) {
      const d = Math.hypot(p.x - mousePos.x, p.y - mousePos.y);
      if (d < 16 && (!closest || d < closest.d)) closest = { d, carId, p, car: anim.car };
    }

    // Un auto sin telemetría fresca se dibuja hueco: el punto queda como un anillo gris en el
    // último lugar donde se lo vio, en vez de como un auto más girando. Sin esto, el punto de
    // alguien que crasheó el juego se quedaba clavado en el mapa, del mismo dorado que el resto,
    // indistinguible de un auto detenido en pista — que es una situación muy distinta.
    const stale = Boolean(anim.car && anim.car.telemetryStale);
    ctx.beginPath();
    ctx.arc(p.x, p.y, selected || hovered ? 8 : 6, 0, Math.PI * 2);
    if (stale) {
      ctx.strokeStyle = "#5a6273";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      // Cada auto del color de su marca (1.2). Antes la parrilla entera era dorada y la única
      // forma de saber quién era cada punto era pasarle el mouse por encima, uno por uno: con
      // veinticuatro autos eso no se hace en carrera.
      //
      // El blanco del seleccionado le gana al color de marca, y el gris hueco del que perdió
      // telemetría también: los dos dicen algo que el color de marca no dice, y el color de marca
      // se puede deducir igual de la torre. El hover ya no cambia el relleno —cambiaría el color
      // de la marca, que es el dato— sino que se marca con el borde blanco y el radio más grande.
      ctx.fillStyle = selected ? "#ffffff" : carMapColor(anim.car);
      ctx.fill();
      // Borde oscuro fino: sin esto un gris Mercedes o un azul Alpine se pierden contra el
      // asfalto, que es del mismo rango de tono.
      ctx.strokeStyle = hovered ? "#ffffff" : "rgba(9, 11, 15, 0.85)";
      ctx.lineWidth = hovered ? 2 : 1.5;
      ctx.stroke();
    }
    if (selected) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  hoveredCarId = closest ? closest.carId : null;
  updateTooltip(closest);
  renderMapReadout();
}

/**
 * El tramo de vuelta que el motor considera pit lane.
 *
 * Es la única regla del producto que se configura con dos números abstractos —0.97 y 0.995— y
 * hasta la 0.5 no había ninguna forma de ver a qué pedazo de pista correspondían. El texto de
 * Reglas mandaba a "mirar el mapa mientras alguien maneja por boxes", y el mapa no mostraba ni la
 * zona ni el punto de la vuelta de nadie: era pedirle a alguien que calibre a ciegas.
 *
 * Se dibuja con exactamente el mismo criterio que `isInPitZone` (`s >= inicio && s <= fin`,
 * sin dar la vuelta al cruzar la meta). Si el dibujo fuera más piadoso que el motor —por ejemplo,
 * envolviendo cuando el inicio es mayor que el fin— el mapa mostraría una zona que no sanciona a
 * nadie, que es la peor forma posible de equivocarse acá.
 */
function drawPitZone(project) {
  if (!pitZone || !trackOutline) return;
  const { splineStart, splineEnd } = pitZone;
  if (!(splineEnd > splineStart)) return; // zona vacía: el motor tampoco marcaría a nadie

  const tramo = trackOutline.points.filter((p) => p.s >= splineStart && p.s <= splineEnd);
  if (tramo.length < 2) return; // el trazado todavía no tiene puntos aprendidos ahí

  ctx.beginPath();
  for (let i = 0; i < tramo.length; i++) {
    const p = project(tramo[i].x, tramo[i].z);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  // El mismo ámbar del tinte de "está en boxes" en la torre de tiempos: es la misma cosa dicha en
  // dos lugares, y usar dos colores distintos obligaría a aprender dos códigos.
  ctx.strokeStyle = "rgba(240, 180, 41, 0.75)";
  ctx.lineWidth = 7;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

/**
 * El punto de la vuelta del auto seleccionado, que es el número que hay que escribir en Reglas.
 *
 * Con tres decimales porque esa es la precisión de los campos del formulario: mostrar más dígitos
 * sería sugerir una exactitud que el campo no acepta.
 */
function renderMapReadout() {
  const box = $("map-readout");
  const car = lastState && selectedCarId !== null ? lastState.cars.find((c) => c.carId === selectedCarId) : null;
  if (!car) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const s = car.normalizedSplinePosition;
  $("map-spline").textContent = typeof s === "number" ? s.toFixed(3) : "--";

  const hint = $("map-zone-hint");
  if (!pitZone || !(pitZone.splineEnd > pitZone.splineStart)) {
    // Un inicio mayor que el fin no sanciona a nadie, y el panel no lo decía en ningún lado.
    hint.textContent = pitZone ? "La zona de pit está mal definida: el inicio tiene que ser menor que el fin." : "";
    return;
  }
  const dentro = s >= pitZone.splineStart && s <= pitZone.splineEnd;
  hint.textContent = dentro
    ? "dentro de la zona de pit (" + pitZone.splineStart + " – " + pitZone.splineEnd + ")"
    : "fuera de la zona de pit (" + pitZone.splineStart + " – " + pitZone.splineEnd + ")";
}

function updateTooltip(closest) {
  const tip = $("map-tooltip");
  if (!closest) {
    tip.hidden = true;
    return;
  }
  clearChildren(tip);
  const name = document.createElement("span");
  name.textContent = closest.car.driverName || "Auto " + closest.carId;
  const number = document.createElement("span");
  number.className = "car-number";
  number.textContent = " #" + closest.carId;
  tip.appendChild(name);
  tip.appendChild(number);
  tip.style.left = closest.p.x + "px";
  tip.style.top = closest.p.y + "px";
  tip.hidden = false;
}

function animate() {
  if (trackOutline && !$("view-live").hidden) drawMap();
  requestAnimationFrame(animate);
}

function wireMap() {
  const host = $("map-host");
  host.addEventListener("mousemove", (e) => {
    const rect = host.getBoundingClientRect();
    mousePos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  });
  host.addEventListener("mouseleave", () => {
    mousePos = null;
    hoveredCarId = null;
    $("map-tooltip").hidden = true;
  });
  host.addEventListener("click", () => {
    // Click en un auto lo selecciona (y lo resalta también en la tabla); click al vacío limpia.
    selectedCarId = hoveredCarId !== null && hoveredCarId !== selectedCarId ? hoveredCarId : null;
    applySelectionToRows();
  });

  if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe(host);
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  requestAnimationFrame(animate);
}

/**
 * Baja el trazado del circuito cuando creció la cobertura.
 *
 * Son ~600 puntos y el poll corre una vez por segundo, así que no se vuelve a pedir mientras el
 * circuito ya aprendido no cambie. Lo delicado es CUÁNDO se da por bajada una cobertura.
 *
 * Acá `lastTrackCoverage` se marcaba antes del `await`, y eso dejaba el reintento muerto: bastaba
 * un fallo —o un 204, el backend todavía sin trazado suficiente— para que el próximo poll trajera
 * la misma cobertura, entrara por el `return` de la primera línea y no volviera a pedir nunca más.
 * El comentario que había prometía justo lo contrario de lo que hacía el código.
 *
 * Y el caso que lo disparaba era el normal, no uno raro: una liga que ya aprendió su circuito
 * arranca con cobertura 1.0 y no crece más en toda la carrera. Un solo error transitorio al
 * arrancar —el worker todavía levantándose— y la tarjeta del mapa se quedaba en "esperando
 * telemetría" hasta que alguien recargara la página.
 *
 * Ahora la cobertura se marca recién con el trazado en la mano, que es lo único que de verdad
 * significa "esta cobertura ya la tengo".
 */
async function refreshTrack(coverage) {
  if (coverage <= lastTrackCoverage) return;
  try {
    const outline = await api("/api/track");
    // 204: hay telemetría pero todavía no alcanza para dibujar. No es un error, pero tampoco es un
    // trazado — darlo por bajado congelaría el pedido para siempre.
    if (!outline) return;
    trackOutline = outline;
    lastTrackCoverage = coverage;
  } catch (_) {
    // `lastTrackCoverage` quedó como estaba, así que el próximo poll vuelve a intentar de verdad.
  }
}

/**
 * El cartel de "todavía no hay mapa", que dice dos cosas distintas según de dónde salga el trazado.
 *
 * Con catálogo no hay nada que esperar: el dibujo está completo antes de que arranque nadie, y lo
 * único que falta es que el servidor diga en qué circuito está. Prometer ahí un aprendizaje que no
 * va a pasar deja al admin esperando una barra que nunca se mueve.
 *
 * Sin catálogo —una pista mod que no está en el paquete— sigue valiendo el texto viejo, porque
 * sigue valiendo el mecanismo viejo.
 */
function renderMapStatus(state) {
  const coverage = state.track ? state.track.coverage : 0;
  const catalogued = state.track ? state.track.catalogued : false;
  const ready = trackOutline !== null;
  $("map-empty").hidden = ready;
  $("map-hint").textContent =
    ready && !catalogued && coverage < 0.95 ? "aprendiendo: " + Math.round(coverage * 100) + "%" : "";
  $("map-progress").hidden = catalogued;
  $("map-progress").firstElementChild.style.width = Math.round(coverage * 100) + "%";

  if (catalogued) {
    $("map-empty-text").textContent = "Cargando el trazado del circuito.";
    $("map-empty-sub").textContent = "El dibujo ya viene con Race Control: aparece apenas se conecta el servidor.";
    return;
  }
  // Conectados, no filas: el circuito lo aprenden los que están girando, y la torre ahora también
  // lista a los que se fueron.
  $("map-empty-text").textContent =
    state.cars.filter((c) => c.connected !== false).length === 0
      ? "Esperando que alguien salga a pista para aprender el circuito."
      : "Aprendiendo el circuito: " + Math.round(coverage * 100) + "%";
  $("map-empty-sub").textContent =
    "Este circuito no está en el catálogo, así que el trazado se dibuja solo a medida que los autos dan vueltas. Se aprende una vez y queda guardado.";
}

/**
 * Condiciones de la sesión y reloj de carrera, arriba y abajo del trazado.
 *
 * Viento y hora del juego no están porque **Assetto Corsa no los expone**: son campos de ACC.
 * Ni el UDP ni la Shared Memory de AC los tienen. Una columna que dijera "--" para siempre sería
 * peor que no tenerla. Ver server/src/session/sessionInfo.ts.
 */
function renderSession(session) {
  const bar = $("session-bar");
  const clock = $("session-clock");
  if (!session) {
    bar.hidden = true;
    clock.hidden = true;
    return;
  }
  bar.hidden = false;

  const layout = prettyLayout(session.trackConfig);
  $("ses-track").textContent = prettyTrackName(session.track) + (layout ? " · " + layout : "");
  $("ses-track").title = session.serverName || "";
  $("ses-weather").textContent = session.weatherLabel || "";

  // El nombre que el admin le puso a la sesión en el server_cfg manda sobre el tipo: "Quali 20'"
  // dice más que "Clasificación". El tipo queda de respaldo si no la nombró.
  const name = session.name && session.name.trim().length > 0 ? session.name : session.typeLabel;
  const length =
    session.durationMinutes > 0
      ? session.durationMinutes + " min"
      : session.laps > 0
        ? session.laps + " vueltas"
        : "";
  $("ses-type").textContent = length ? name + " · " + length : name;
  $("ses-temps").textContent =
    "Aire " + Math.round(session.ambientTemp) + "° · Pista " + Math.round(session.roadTemp) + "°";

  // El agarre lo reporta la app del piloto, no el servidor. Sin nadie con la app no hay dato, y
  // se deja el renglón vacío en vez de mostrar un 0 que se leería como pista helada.
  $("ses-grip").textContent =
    session.surfaceGrip === null ? "" : "Agarre de pista " + Math.round(session.surfaceGrip * 100) + "%";

  renderSessionChip(session);

  // El renglón del reloj ya no se esconde entero cuando no hay cronómetro: la chapa del tipo de
  // sesión vive adentro y siempre tiene algo que decir. Lo que se esconde es el par label/valor.
  clock.hidden = false;
  const label = $("ses-clock-label");
  const value = $("ses-clock-value");

  if (session.remainingMs === null) {
    // Sesión por vueltas: no hay cronómetro, hay un número de vueltas.
    const sinDato = session.laps <= 0;
    label.hidden = sinDato;
    value.hidden = sinDato;
    clock.classList.remove("ending");
    label.textContent = "Vueltas";
    value.textContent = String(session.laps);
    return;
  }
  label.hidden = false;
  value.hidden = false;
  label.textContent = "Restan";
  value.textContent = formatClock(session.remainingMs);
  clock.classList.toggle("ending", session.remainingMs <= 60000);
}

/**
 * La letra del tipo de sesión: P, Q o R.
 *
 * Son los códigos que usa todo el automovilismo y que un director de carrera lee sin traducir. El
 * color no es decorativo: dice cuánto pesa lo que se está mirando. En práctica no cuenta nada, en
 * clasificación se define la parrilla y en carrera se reparten los puntos — y es el único de los
 * tres donde los botones de largada hacen algo.
 *
 * Sale de `sessionType`, que es un número del protocolo, y no del nombre que el admin le puso a la
 * sesión: ese nombre es texto libre y puede decir "Tanda 3" o "Domingo".
 */
const SESSION_CHIPS = {
  0: { code: "B", kind: "practica", label: "Reserva" },
  1: { code: "P", kind: "practica", label: "Práctica" },
  2: { code: "Q", kind: "qualy", label: "Clasificación" },
  3: { code: "R", kind: "carrera", label: "Carrera" },
  4: { code: "H", kind: "qualy", label: "Hotlap" },
  5: { code: "TA", kind: "qualy", label: "Time attack" },
  6: { code: "D", kind: "practica", label: "Deriva" },
  7: { code: "RP", kind: "practica", label: "Repetición" },
};

function renderSessionChip(session) {
  const chip = $("ses-chip");
  const spec = SESSION_CHIPS[session.sessionType];
  if (!spec) {
    // Un tipo que el protocolo no define: antes que inventar una letra, no se muestra ninguna.
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.textContent = spec.code;
  chip.className = "chapa-sesion " + spec.kind;
  // El título lleva la palabra entera: la letra se entiende de reojo, pero quien nunca vio una
  // planilla de tiempos no tiene por qué saber que Q es clasificación.
  chip.title = spec.label + (session.typeLabel && session.typeLabel !== spec.label ? " · " + session.typeLabel : "");
}

/** ms → `mm:ss`, o `h:mm:ss` en una carrera de resistencia. */
function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? hours + ":" + pad(minutes) + ":" + pad(seconds) : pad(minutes) + ":" + pad(seconds);
}

/** Los nombres de pista de AC son nombres de carpeta (`ks_barcelona`). El prefijo es del paquete
 * de contenido, no del circuito, y no le dice nada a nadie. */
function prettyTrackName(raw) {
  if (!raw) return "Circuito desconocido";
  const cleaned = raw
    .replace(/^(ks|acu|rt|at|pm|tcl|vrc)_/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!cleaned) return raw;
  return cleaned.replace(/(^|\s)([a-záéíóúñ])/g, (m, pre, ch) => pre + ch.toUpperCase());
}

/** `layout_gp` → "GP". La variante se muestra como la nombra el circuito, en mayúsculas: casi
 * siempre son siglas ("GP", "GP24", "Moto"). */
function prettyLayout(raw) {
  if (!raw) return "";
  const cleaned = raw.replace(/^layout[_-]?/i, "").replace(/[_-]+/g, " ").trim();
  return cleaned.length <= 4 ? cleaned.toUpperCase() : cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// ===================================================================== sanciones e incidentes

const PENALTY_STATUS = {
  servingWindow: ["warn", "pendiente"],
  served: ["ok", "cumplida"],
  escalated: ["bad", "escalada"],
  // Gris y no verde: una anulada no es una sanción que salió bien, es una que no debió existir.
  revoked: ["neutral", "anulada"],
};

const ENGINE_LABELS = { formation: "Largada", pit: "Pit lane", steward: "Comisario" };

/** Cómo se lee cada tipo de sanción. Se muestra junto al motivo porque "+10s" y "Drive-Through"
 * son cosas muy distintas y hasta ahora la tabla no las distinguía. */
const PENALTY_TYPE_LABELS = { DT: "Drive-Through", SG: "Stop & Go", BALLAST: "Lastre", TIME: "Tiempo" };

function renderPenalties(formationPenalties, pitPenalties, stewardPenalties) {
  const body = $("penalties-body");
  clearChildren(body);

  const all = formationPenalties
    .map((p) => ({ ...p, engine: "formation" }))
    .concat(pitPenalties.map((p) => ({ ...p, engine: "pit" })))
    // Las que aplica el comisario a mano desde la bandeja. Sin esto, apretar "Sancionar" no se
    // reflejaba en ningún lado.
    .concat((stewardPenalties || []).map((p) => ({ ...p, engine: "steward" })))
    .sort((a, b) => b.createdAt - a.createdAt);

  $("penalties-empty").hidden = all.length > 0;

  for (const p of all) {
    const tr = document.createElement("tr");
    appendCell(tr, ENGINE_LABELS[p.engine] || p.engine);
    appendCell(tr, driverLabel(p.driverGuid, p.carId));
    const typeLabel = p.type === "TIME" ? "+" + p.timePenaltySeconds + "s" : PENALTY_TYPE_LABELS[p.type] || p.type;
    appendCell(tr, typeLabel + " — " + p.reason);

    const status = document.createElement("td");
    const [cls, label] = PENALTY_STATUS[p.status] || ["neutral", p.status];
    const badge = document.createElement("span");
    badge.className = "badge " + cls;
    badge.textContent = label;
    status.appendChild(badge);
    tr.appendChild(status);

    appendCell(tr, p.status === "servingWindow" ? String(p.graceLapsRemaining) : "--", "num");

    const actions = document.createElement("td");
    actions.className = "actions";
    if (p.status !== "revoked") actions.appendChild(revokeButton(p));
    tr.appendChild(actions);

    body.appendChild(tr);
  }
}

/** Sanción a medio anular: `{ id, timer }`. Vive afuera de la tabla porque la tabla se redibuja
 * entera en cada poll y se llevaría puesto el estado armado. */
let armedRevoke = null;

/**
 * Anular con doble click, igual que el kick.
 *
 * El primer click arma y el segundo ejecuta; a los 4 segundos se desarma solo. Es el mismo patrón
 * que el kick y por el mismo motivo: esta tabla se repinta sola cada segundo, así que un click
 * puede caer en una fila que se acaba de mover. Pero acá hay una diferencia que vale decir — una
 * anulación se puede rehacer sancionando de nuevo, un kick no. Lleva doble confirmación igual
 * porque el aviso le llega al piloto por chat en el acto y no hay forma de desmentirlo.
 */
function revokeButton(penalty) {
  const btn = document.createElement("button");
  btn.className = "btn-mini secondary";
  const armed = armedRevoke !== null && armedRevoke.id === penalty.id;
  btn.textContent = armed ? "¿Seguro?" : "Anular";
  btn.title = "Anular esta sanción. Al piloto le llega el aviso por chat y deja de contar en el informe.";
  if (armed) btn.classList.add("arming");

  btn.addEventListener("click", async () => {
    if (armedRevoke && armedRevoke.id === penalty.id) {
      clearTimeout(armedRevoke.timer);
      armedRevoke = null;
      btn.disabled = true;
      try {
        await post("/api/penalties/" + penalty.id + "/revoke");
        toast("Sanción anulada: " + driverLabel(penalty.driverGuid, penalty.carId) + " ya no la debe");
        refresh().catch(() => {});
      } catch (err) {
        btn.disabled = false;
        toast("No se pudo anular: " + err.message, 5000);
      }
      return;
    }
    if (armedRevoke) clearTimeout(armedRevoke.timer);
    armedRevoke = { id: penalty.id, timer: setTimeout(desarmarAnulacion, KICK_ARM_MS) };
    btn.textContent = "¿Seguro?";
    btn.classList.add("arming");
  });
  return btn;
}

/** Al vencer los 4 segundos alcanza con repintar: el botón se reconstruye desarmado porque
 * `armedRevoke` ya es null cuando `renderPenalties` lo vuelve a crear. */
function desarmarAnulacion() {
  armedRevoke = null;
  if (lastState) renderPenalties(lastState.formationPenalties, lastState.pitPenalties, lastState.stewardPenalties);
}

function appendCell(tr, text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  tr.appendChild(td);
}

/** Las sanciones guardan el guid, no el nombre. Lo resolvemos contra la torre para no mostrarle
 * "Auto 7" a quien quiere saber a quién sancionó. Desde la 1.2 la torre lista también a los
 * desconectados, así que el nombre del que se fue en la vuelta 3 ya no se pierde. */
function driverLabel(driverGuid, carId) {
  const cars = lastState ? lastState.cars : [];
  const car = cars.find((c) => c.driverGuid === driverGuid);
  return (car && car.driverName) || "Auto " + carId;
}

const GEOMETRY_LABELS = {
  "rear-end": "Toque trompa contra cola",
  "side-by-side": "Toque rueda a rueda",
  "head-on": "Impacto frontal",
  unknown: "Geometría sin determinar",
};

/** Título de los incidentes de un solo piloto. Los toques entre autos no están acá: su título es
 * "Toque con Fulano", que se arma aparte porque necesita saber desde qué lado se está mirando. */
const INCIDENT_KIND_LABELS = {
  "env-collision": "choque en solitario",
  "track-limits": "límites de pista",
  "cut-lap": "se fue de pista",
  "telemetry-mismatch": "telemetría inconsistente",
  "wrong-way": "contramano",
  disconnect: "se desconectó en carrera",
};

/**
 * Las dos cuentas que el comisario lleva de cada piloto.
 *
 * **Cuts** es irse de pista; **choques** es pegarle a algo, solo o contra otro. Son dos cosas
 * distintas y se juzgan distinto: diez cuts es alguien que está usando de más el pianito, diez
 * choques es alguien peligroso. Antes la bandeja no las separaba —ni las sumaba—, así que un
 * trompo solo en una práctica llenaba la pantalla de diecinueve tarjetas sueltas y había que
 * contarlas a ojo para saber cuál de las dos cosas había pasado.
 *
 * Lo que no cae en ninguna de las dos (contramano, desconexión, telemetría inconsistente) se
 * cuenta aparte en vez de forzarlo a una de estas: meter una desconexión adentro de "choques"
 * sería inventar un dato.
 */
const CUT_KINDS = ["track-limits", "cut-lap"];
const CHOQUE_KINDS = ["car-contact", "env-collision"];

const INCIDENT_STATUS = {
  dismissed: ["neutral", "descartado"],
  warned: ["warn", "advertido"],
  penalized: ["bad", "sancionado"],
};

/** Firma de lo renderizado, para no reconstruir la lista entera una vez por segundo mientras el
 * admin está leyendo un incidente. */
let incidentsSignature = "";

/**
 * Qué grupos dejó abiertos el admin, por piloto.
 *
 * La lista se repinta sola cuando llega un incidente nuevo, y sin esto cada repintado cerraría el
 * grupo que estaba leyendo — justo en el momento en que más incidentes están entrando.
 */
const gruposAbiertos = new Set();

function renderIncidents(incidents) {
  const signature = incidents.map((i) => i.id + i.status + i.impactCount).join("|");
  if (signature === incidentsSignature) return;
  incidentsSignature = signature;

  const list = $("incidents-list");
  clearChildren(list);

  if (incidents.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Sin incidentes. Los toques, choques y salidas de pista aparecen acá apenas ocurren.";
    list.appendChild(empty);
    return;
  }

  for (const grupo of agruparPorPiloto(incidents)) list.appendChild(grupoCard(grupo));
}

/**
 * Un grupo por piloto, no una tarjeta por hecho.
 *
 * **Un toque entre dos autos entra en los dos grupos**, a propósito. Es un solo incidente con un
 * solo id —resolverlo de un lado lo resuelve del otro, porque es el mismo— pero cuenta para los
 * dos pilotos: si el de Fulano no lo contara, su resumen diría que no tuvo ningún choque. Desde
 * cada grupo la tarjeta se titula "Toque con <el otro>", que es como se lee desde ese lado.
 */
function agruparPorPiloto(incidents) {
  const porPiloto = new Map();

  for (const incident of incidents) {
    for (const party of incident.parties) {
      // El guid es la identidad real; el carId es el respaldo para un auto que entró sin guid.
      const clave = party.driverGuid || "car-" + party.carId;
      let grupo = porPiloto.get(clave);
      if (!grupo) {
        grupo = { clave, nombre: party.driverName, cuts: 0, choques: 0, otros: 0, pendientes: 0, ultimo: 0, filas: [] };
        porPiloto.set(clave, grupo);
      }
      if (party.driverName) grupo.nombre = party.driverName;
      grupo.filas.push({ incident, propio: party });
      if (CUT_KINDS.indexOf(incident.kind) !== -1) grupo.cuts++;
      else if (CHOQUE_KINDS.indexOf(incident.kind) !== -1) grupo.choques++;
      else grupo.otros++;
      if (incident.status === "pending") grupo.pendientes++;
      if (incident.createdAt > grupo.ultimo) grupo.ultimo = incident.createdAt;
    }
  }

  // Lo que pasó hace un minuto arriba. En una carrera el comisario revisa hacia atrás desde lo
  // último, no busca un nombre en una lista alfabética.
  return Array.from(porPiloto.values()).sort((a, b) => b.ultimo - a.ultimo);
}

/** El grupo de un piloto: el resumen siempre a la vista, el detalle a un click. */
function grupoCard(grupo) {
  const det = document.createElement("details");
  det.className = "grupo-incidentes";
  det.open = gruposAbiertos.has(grupo.clave);
  det.addEventListener("toggle", () => {
    if (det.open) gruposAbiertos.add(grupo.clave);
    else gruposAbiertos.delete(grupo.clave);
  });

  const sum = document.createElement("summary");

  const nombre = document.createElement("span");
  nombre.className = "piloto";
  nombre.textContent = grupo.nombre;
  sum.appendChild(nombre);

  // Las dos cuentas que importan, cada una con su color. Un cero no se dibuja: en una fila de
  // chapas, "Choques: 0" ocupa tanto como "Choques: 9" y no dice nada.
  if (grupo.cuts > 0) sum.appendChild(cuentaChip("Cuts", grupo.cuts, "cuts"));
  if (grupo.choques > 0) sum.appendChild(cuentaChip("Incidentes", grupo.choques, "choques"));
  if (grupo.otros > 0) sum.appendChild(cuentaChip("Otros", grupo.otros, "otros"));

  if (grupo.pendientes > 0) {
    const pend = document.createElement("span");
    pend.className = "chip-cuenta pendiente";
    pend.textContent = grupo.pendientes + " sin revisar";
    sum.appendChild(pend);
  }

  det.appendChild(sum);
  for (const fila of grupo.filas) det.appendChild(incidentCard(fila.incident, fila.propio));
  return det;
}

function cuentaChip(etiqueta, n, clase) {
  const span = document.createElement("span");
  span.className = "chip-cuenta " + clase;
  span.textContent = etiqueta + ": " + n;
  return span;
}

/**
 * Una tarjeta de incidente.
 *
 * `propio` es el piloto desde cuyo grupo se la está mirando, y cambia el título: adentro del grupo
 * de Fulano un toque se lee "Toque con Mengano", que es el dato que el comisario está buscando
 * —contra quién fue—, y no "Fulano vs Mengano", que repite el nombre del encabezado del grupo.
 */
function incidentCard(incident, propio) {
  const card = document.createElement("div");
  card.className = "incident" + (incident.status === "pending" ? "" : " resolved");

  const head = document.createElement("div");
  head.className = "head";

  const who = document.createElement("span");
  who.className = "who";
  who.textContent = tituloIncidente(incident, propio);
  head.appendChild(who);

  if (incident.status !== "pending") {
    const [cls, label] = INCIDENT_STATUS[incident.status];
    const badge = document.createElement("span");
    badge.className = "badge " + cls;
    badge.textContent = label;
    head.appendChild(badge);
  }
  card.appendChild(head);

  const ctxLine = document.createElement("div");
  ctxLine.className = "ctx";
  const bits = [];
  if (incident.kind === "car-contact") bits.push(GEOMETRY_LABELS[incident.geometry] || GEOMETRY_LABELS.unknown);
  // Una salida de pista no tiene velocidad de impacto: el backend manda el campo ausente en vez
  // de un cero, así que acá se omite la línea en lugar de mostrar "impacto a 0 km/h".
  if (typeof incident.impactSpeedKmh === "number") bits.push("impacto a " + Math.round(incident.impactSpeedKmh) + " km/h");
  if (incident.detail) bits.push(incident.detail);
  bits.push("vuelta " + incident.lap);
  if (incident.impactCount > 1) bits.push(incident.impactCount + " impactos seguidos");
  // hour12 explícito: sin esto el navegador puede resolverlo por su locale y mostrar "01:24:16"
  // para las cuatro y cuarto de la tarde, sin AM/PM que lo desambigüe.
  bits.push(new Date(incident.createdAt).toLocaleTimeString("es-AR", { hour12: false }));
  ctxLine.textContent = bits.join(" · ");
  card.appendChild(ctxLine);

  if (incident.status === "pending") {
    const row = document.createElement("div");
    row.className = "btn-row";
    row.appendChild(resolveButton(incident.id, "dismissed", "Descartar", "secondary"));
    row.appendChild(resolveButton(incident.id, "warned", "Advertir", "secondary"));

    // "Sancionar" no resuelve de una: abre el formulario. Un toque tiene dos pilotos y el
    // servidor no sabe de quién fue la culpa — elegir por él sería inventar un veredicto.
    const sanction = document.createElement("button");
    sanction.className = "btn-mini danger";
    sanction.textContent = "Sancionar";
    sanction.addEventListener("click", () => {
      row.replaceWith(penaltyForm(incident, card));
    });
    row.appendChild(sanction);
    card.appendChild(row);
  } else if (incident.status === "penalized") {
    // Qué sanción salió de este incidente. Sin esto, la bandeja decía "sancionado" y había que
    // ir a la otra tabla a adivinar cuál de las sanciones le correspondía.
    const issued = (lastState?.stewardPenalties || []).find((p) => p.incidentId === incident.id);
    if (issued) {
      const line = document.createElement("div");
      line.className = "ctx";
      const what = issued.type === "TIME" ? "+" + issued.timePenaltySeconds + "s" : PENALTY_TYPE_LABELS[issued.type] || issued.type;
      line.textContent = "Sanción aplicada: " + what + " a " + driverLabel(issued.driverGuid, issued.carId);
      card.appendChild(line);
    }
  }

  return card;
}

function tituloIncidente(incident, propio) {
  if (incident.kind !== "car-contact") {
    return INCIDENT_KIND_LABELS[incident.kind] || "incidente";
  }
  // Contra quién fue. El backend guarda a los dos en `parties` desde que existe el pareo de
  // paquetes, así que esto no adivina nada: es el otro auto del mismo toque.
  const otros = incident.parties.filter((p) => !propio || p.carId !== propio.carId);
  if (otros.length === 0) return "Toque entre autos";
  return "Toque con " + otros.map((p) => p.driverName).join(" y ");
}

const MANUAL_PENALTIES = [
  ["TIME", "Penalización de tiempo"],
  ["DT", "Drive-Through"],
  ["SG", "Stop & Go"],
  ["BALLAST", "Lastre"],
];

/** Formulario de sanción manual: a quién, qué y —si es de tiempo— cuántos segundos. */
function penaltyForm(incident, card) {
  const form = document.createElement("div");
  form.className = "penalty-form";

  const who = document.createElement("select");
  for (const party of incident.parties) {
    const opt = document.createElement("option");
    opt.value = String(party.carId);
    opt.textContent = party.driverName || "Auto " + party.carId;
    who.appendChild(opt);
  }
  // Con un solo piloto involucrado no hay nada que elegir: se muestra igual, deshabilitado, para
  // que quede claro a quién se está por sancionar.
  who.disabled = incident.parties.length < 2;

  const what = document.createElement("select");
  for (const [value, label] of MANUAL_PENALTIES) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    what.appendChild(opt);
  }

  const seconds = document.createElement("input");
  seconds.type = "number";
  seconds.min = "1";
  seconds.max = "600";
  seconds.value = "5";
  seconds.className = "seconds";
  seconds.title = "Segundos que se suman al resultado final";
  what.addEventListener("change", () => {
    seconds.hidden = what.value !== "TIME";
  });

  const confirm = document.createElement("button");
  confirm.className = "btn-mini danger";
  confirm.textContent = "Aplicar";
  const cancel = document.createElement("button");
  cancel.className = "btn-mini secondary";
  cancel.textContent = "Cancelar";
  cancel.addEventListener("click", () => {
    incidentsSignature = "";
    renderIncidents(lastState ? lastState.incidents || [] : []);
  });

  /**
   * Aplicar tampoco sale de un solo click.
   *
   * Los dos desplegables vienen con una opción ya elegida —el primer piloto del toque y
   * "Penalización de tiempo"— así que un click directo sanciona a alguien que nadie eligió. El
   * segundo click no es un trámite: entre uno y otro el botón dice en palabras a quién y qué se
   * está por aplicar, que es exactamente el dato que el formulario esconde en dos `select`.
   */
  let armada = null;
  const desarmar = () => {
    if (armada) clearTimeout(armada);
    armada = null;
    confirm.textContent = "Aplicar";
    confirm.classList.remove("arming");
  };
  // Cambiar de piloto o de sanción desarma: lo que se confirmó ya no es lo que se va a aplicar.
  who.addEventListener("change", desarmar);
  what.addEventListener("change", desarmar);
  seconds.addEventListener("input", desarmar);

  confirm.addEventListener("click", async () => {
    if (!armada) {
      const etiqueta = MANUAL_PENALTIES.find(([value]) => value === what.value);
      const queEs = what.value === "TIME" ? "+" + seconds.value + "s" : (etiqueta ? etiqueta[1] : what.value);
      armada = setTimeout(desarmar, KICK_ARM_MS);
      confirm.textContent = "¿" + queEs + " a " + who.options[who.selectedIndex].textContent + "?";
      confirm.classList.add("arming");
      return;
    }
    clearTimeout(armada);
    armada = null;
    confirm.disabled = true;
    try {
      const res = await post("/api/incidents/" + incident.id + "/resolve", {
        status: "penalized",
        carId: Number(who.value),
        penaltyType: what.value,
        seconds: Number(seconds.value),
      });
      incidentsSignature = ""; // forzar el redibujo con el estado nuevo
      toast("Sanción aplicada a " + (res.penalty ? driverLabel(res.penalty.driverGuid, res.penalty.carId) : "el piloto"));
      refresh().catch(() => {});
    } catch (err) {
      confirm.disabled = false;
      toast("No se pudo sancionar: " + err.message, 5000);
    }
  });

  const label = document.createElement("span");
  label.className = "meta";
  label.textContent = "Sancionar a";
  form.append(label, who, what, seconds, confirm, cancel);
  return form;
}

function resolveButton(id, status, label, cls) {
  const btn = document.createElement("button");
  btn.className = "btn-mini " + cls;
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await post("/api/incidents/" + id + "/resolve", { status });
      incidentsSignature = ""; // forzar el redibujo con el estado nuevo
      refresh().catch(() => {});
    } catch (err) {
      btn.disabled = false;
      toast("No se pudo resolver: " + err.message, 5000);
    }
  });
  return btn;
}

// ===================================================================== red

/**
 * La dirección `ip:puerto` que el servidor de Assetto Corsa tiene que apuntar.
 *
 * Vive acá, en el módulo, y no en el `value` de un input como antes: el campo copiable se fue del
 * cajón de Conexión, pero el mensaje para el soporte del hosting la sigue necesitando. Leerla de
 * un elemento del DOM la ataba a que ese elemento existiera, que es exactamente la clase de falla
 * silenciosa que ya nos costó caro: `$()` devuelve `null` y el botón deja de andar sin decir nada.
 */
let sendAddress = "--";

function renderNetwork(network) {
  sendAddress = network.sendAddress;

  // La dirección de la liga es el único dato del que depende que el servidor de AC pueda
  // encontrarnos. La asigna el portal al arrancar; si falta, algo está mal de nuestro lado.
  // Se muestra con el puerto: es el renglón exacto que el hosting tiene que haber cargado, así
  // que sirve para verificar de un vistazo, no solo para saber "cuál es mi IP".
  const ipEl = $("net-ip");
  if (network.publicIp) {
    ipEl.textContent = network.sendAddress;
    ipEl.className = "ok";
  } else {
    ipEl.textContent = "sin asignar";
    ipEl.className = "bad";
  }

  $("net-signal").textContent = network.receivingTelemetry ? "recibiendo" : "sin señal todavía";
  $("wizard-snippet").textContent = network.sendAddress;

  // "Llega telemetría" y "los pilotos alcanzan el backend" son dos cosas distintas que fallan por
  // separado: el UDP del servidor puede entrar perfecto mientras el puerto de los pilotos está
  // cerrado. Mostrarlas juntas hacía que el panel diera todo verde justo antes de kickear a todos.
  const d = network.driversReporting || { reporting: 0, connected: 0 };
  const driversEl = $("net-drivers");
  driversEl.textContent = d.connected === 0 ? "nadie conectado todavía" : d.reporting + " de " + d.connected;
  driversEl.className = d.connected > 0 && d.reporting === 0 ? "bad" : "";

  // Lo mismo, pero arriba de la torre de tiempos, que es donde se nota: Box, Neum. y Comb. salen
  // de la app del piloto y sin ella quedan en guiones. El cajón de conexión lo decía bien y nadie
  // lo abre, así que "no me aparecen los neumáticos" se leía como un producto roto.
  const chip = $("chip-sin-app");
  chip.hidden = !(d.connected > 0 && d.reporting === 0);
  chip.title =
    "Box, Neum. y Comb. solo existen en la Shared Memory del juego: los manda la app de " +
    "Race Control que instala cada piloto, no el servidor de carrera. Clickeá para revisar la conexión.";

  // Si los comandos todavía salen a loopback con telemetría entrando, el servidor no se identificó
  // y nada de lo que mande el backend (chat, sanciones, kicks) va a llegar a destino.
  const ac = network.acServer || {};
  const acEl = $("net-acserver");
  acEl.textContent = ac.autodetected ? ac.host + ":" + ac.port : "esperando la primera señal...";
  acEl.className = !ac.autodetected && network.receivingTelemetry ? "bad" : "";

  renderNetworkButton(network, ac);
}

// --------------------------------------------------------------- probar conexión

const CHECK_LABELS = { ok: "Bien", warn: "Atención", fail: "Falla", pending: "Esperando" };

function renderChecksInto(box, checks) {
  clearChildren(box);
  for (const check of checks) {
    const item = document.createElement("div");
    item.className = "check " + check.state;

    const head = document.createElement("div");
    head.className = "check-head";
    const title = document.createElement("strong");
    title.textContent = check.title;
    const state = document.createElement("span");
    state.textContent = CHECK_LABELS[check.state] || check.state;
    head.appendChild(title);
    head.appendChild(state);
    item.appendChild(head);

    const detail = document.createElement("p");
    detail.textContent = check.detail;
    item.appendChild(detail);

    if (check.action) {
      const action = document.createElement("p");
      action.className = "check-action";
      action.textContent = check.action;
      item.appendChild(action);
    }
    box.appendChild(item);
  }
}

/** El botón de la barra resume todo el cajón en un color. Verde solo si las DOS mitades están
 * bien: hay servidor identificado y entra telemetría. Media conexión es tan inútil como ninguna. */
function renderNetworkButton(network, ac) {
  const btn = $("btn-network");
  const ok = Boolean(ac.autodetected) && network.receivingTelemetry;
  btn.classList.toggle("ok", ok);
  btn.classList.toggle("bad", !ok);
  $("btn-network-label").textContent = ok ? "Conectado" : network.receivingTelemetry ? "Sin servidor" : "Sin señal";
}

// ===================================================================== modo de aplicación

function renderMode(shadowMode) {
  const wrap = $("mode-switch");
  const toggle = $("mode-toggle");
  // El switch representa "sanciona de verdad", que es lo que el admin piensa. El backend guarda
  // lo contrario (`shadowMode`), así que acá se invierte una sola vez, en un solo lugar.
  if (document.activeElement !== toggle) toggle.checked = !shadowMode;
  wrap.classList.toggle("shadow", shadowMode);
  wrap.classList.toggle("live", !shadowMode);
  $("mode-label").textContent = shadowMode ? "Modo sombra" : "Sancionando";
  wrap.title = shadowMode
    ? "El motor detecta y registra, pero no sanciona ni kickea de verdad. Recomendado en las primeras carreras."
    : "El motor aplica sanciones y expulsiones reales.";
}

// ===================================================================== bandera de carrera

/**
 * La bandera a cuadros de la barra ondea solo mientras la carrera está en curso.
 *
 * Antes no había forma de saberlo de un vistazo: había que buscar el semáforo de la tarjeta de
 * largada y leerlo. Con el panel abierto en una segunda pantalla durante una carrera, eso es
 * justo lo que no se quiere tener que hacer.
 */
function renderRaceFlag(state) {
  const racing = state.phase === "race" || state.lightState === "green";
  $("race-flag").classList.toggle("racing", racing);
  $("nav-live").title = racing ? "Carrera en curso" : "La carrera todavía no arrancó";

  // Las posiciones finales, en la torre, apenas cae la bandera a cuadros. Mientras la carrera
  // corre el link no está: la clasificación se sigue moviendo y un CSV bajado en la vuelta 20 no
  // es un resultado, es una foto que después nadie sabe de cuándo era.
  $("btn-report-timing").hidden = state.phase !== "finished";
}

// ===================================================================== botones de largada

/** Qué acciones tienen sentido en cada estado. Antes los tres botones estaban siempre activos y
 * el servidor ignoraba en silencio los que no correspondían, sin ningún feedback. */
const START_ACTIONS = {
  idle: { begin: true, green: false, reset: false },
  formation: { begin: false, green: true, reset: true },
  green: { begin: false, green: false, reset: true },
};

/** El tipo de sesión "carrera" del protocolo de AC. Ver `RACE_SESSION_TYPE` en adminApi.ts. */
const RACE_SESSION_TYPE = 3;

function renderStart(lightState, session) {
  const semaforo = $("semaforo");
  semaforo.className = "semaforo " + lightState;
  const labels = { idle: "Esperando", formation: "Formación", green: "VERDE" };
  semaforo.textContent = labels[lightState] || lightState;

  // Fuera de carrera la tarjeta entera se apaga. En práctica y clasificación no hay parrilla que
  // formar ni nadie a quien sancionar por adelantarse: los autos salen de boxes cuando quieren.
  // Antes los tres botones estaban activos igual y dar verde en una práctica mandaba un
  // "GREEN GREEN GREEN" por el chat a 20 pilotos que estaban girando tranquilos.
  //
  // Sin sesión todavía (`session` es null hasta el primer SESSION_INFO) NO se bloquea: un panel
  // recién abierto no sabe en qué sesión está el servidor, y bloquear por las dudas dejaría al
  // admin sin poder largar justo cuando más lo necesita. El backend tiene el chequeo de verdad.
  const esCarrera = !session || session.sessionType === RACE_SESSION_TYPE;
  const card = $("card-start");
  card.classList.toggle("off-session", !esCarrera);

  const allowed = START_ACTIONS[lightState] || START_ACTIONS.idle;
  $("btn-begin").disabled = !allowed.begin || !esCarrera;
  $("btn-green").disabled = !allowed.green || !esCarrera;
  // "Reiniciar" sigue disponible siempre a propósito: es la salida de emergencia. Si alguien armó
  // una formación y el servidor cambió de sesión, tiene que poder apagarla.
  $("btn-reset").disabled = !allowed.reset;

  // Con el verde dado, el renglón de ayuda se calla y habla el aviso grande: a esa altura el
  // admin ya no necesita instrucciones, necesita confirmar de un vistazo que la carrera corre.
  const racing = lightState === "green";
  card.classList.toggle("racing", racing);
  $("race-live").hidden = !racing;

  if (!esCarrera) {
    $("start-hint").textContent =
      "La largada se habilita sola cuando el servidor pase a la sesión de carrera.";
    return;
  }
  const hints = {
    idle: "Arrancá la formación cuando la parrilla esté completa.",
    formation: "Control de velocidad activo. Dale verde cuando la fila esté ordenada.",
  };
  $("start-hint").textContent = hints[lightState] || "";
}

// ===================================================================== contacto con el motor

/**
 * La banda de "perdí contacto", y la única pregunta que contesta: **¿qué tan viejo es lo que estoy
 * mirando?**
 *
 * Se dibuja desde un reloj propio y no desde el resultado del poll, porque el caso que importa es
 * justamente aquel en el que el poll no vuelve: si dependiera de la respuesta, el contador se
 * quedaría clavado en el mismo segundo en que se cortó la conexión.
 *
 * El umbral y el texto hablan de tiempo y no de intentos fallidos. "3 requests fallaron" es un
 * dato de implementación; "esto tiene 12 segundos" es lo que el admin necesita para decidir si
 * puede seguir dirigiendo la carrera con lo que ve.
 */
function renderLinkState() {
  const bar = $("link-down");
  const stale = Date.now() - lastGoodPollAt;

  if (stale < LINK_DOWN_AFTER_MS) {
    bar.hidden = true;
    document.body.classList.remove("link-down");
    return;
  }

  const seconds = Math.round(stale / 1000);
  $("link-down-text").textContent =
    "Sin contacto con Race Control hace " + seconds + (seconds === 1 ? " segundo" : " segundos") + ".";
  // El detalle es el motivo técnico y va en gris, detrás: sirve para reportar el problema, no para
  // entenderlo. Lo que hay que entender ya está dicho en la primera frase.
  $("link-down-detail").textContent = "Lo que ves en pantalla es de antes." + (lastPollError ? " (" + lastPollError + ")" : "");
  bar.hidden = false;
  document.body.classList.add("link-down");
}

// ===================================================================== ciclo principal

async function refresh() {
  const state = await api("/api/state");
  // Llegó: el reloj de la banda arranca de cero. Va antes de renderizar nada, porque lo que marca
  // es la edad del dato y no cuánto tardó el panel en dibujarlo.
  lastGoodPollAt = Date.now();
  lastPollError = "";
  renderLinkState();
  lastState = state;

  $("version-label").textContent = state.version ? "v" + state.version : "";
  $("league-label").textContent = state.leagueName || "";
  $("wizard-name").textContent = state.leagueName || "tu liga";

  // El asistente lo abre el servidor (no hay liga guardada) y lo cierra el usuario al terminarlo.
  // Se decide una sola vez y no en cada poll: si no, un cambio de `firstRun` a mitad de camino lo
  // cerraría de golpe en la cara del admin.
  if (state.firstRun && wizardOpen === null) {
    wizardOpen = true;
    $("wizard-overlay").hidden = false;
    showWizardStep(1);
  } else if (!state.firstRun && wizardOpen === null) {
    wizardOpen = false;
  }

  renderStart(state.lightState, state.session);
  renderRaceFlag(state);
  renderTiming(state.cars);
  renderNetwork(state.network);
  renderMode(state.shadowMode);
  renderPenalties(state.formationPenalties, state.pitPenalties, state.stewardPenalties);
  renderIncidents(state.incidents || []);

  const badge = $("nav-incident-count");
  badge.textContent = String(state.pendingIncidents || 0);
  badge.hidden = !state.pendingIncidents;

  // Al mapa van solo los que están en pista. La torre muestra la jornada entera desde la 1.2,
  // pero un desconectado no está en ningún lado del circuito: su punto quedaría clavado donde se
  // le cortó, indistinguible de un auto detenido de verdad.
  updateCarTargets(state.cars.filter((c) => c.connected !== false));
  pitZone = state.pitZone || null;
  await refreshTrack(state.track ? state.track.coverage : 0);
  renderMapStatus(state);
  renderSession(state.session);
}

function wireButtons() {
  const action = (path) => () => {
    post(path)
      .then(() => refresh())
      .catch((err) => toast(err.message, 5000));
  };
  $("btn-begin").addEventListener("click", action("/api/formation/begin"));
  $("btn-green").addEventListener("click", action("/api/formation/green"));
  $("btn-reset").addEventListener("click", action("/api/formation/reset"));

  // El encabezado de la columna de intervalo es un botón. Repinta la tabla en el acto en vez de
  // esperar al próximo poll: un click que tarda un segundo en hacer algo se siente roto y se
  // vuelve a clickear.
  $("btn-gap-mode").addEventListener("click", () => {
    gapMode = gapMode === "ahead" ? "leader" : "ahead";
    renderGapHeader();
    if (lastState) renderTiming(lastState.cars);
  });
  renderGapHeader();

  $("btn-test-network").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    button.textContent = "Probando...";
    try {
      renderChecksInto($("net-checks"), (await post("/api/network/test")).checks);
    } catch (err) {
      toast("No se pudo probar: " + err.message, 5000);
    } finally {
      button.disabled = false;
      button.textContent = "Probar de nuevo";
    }
  });

  $("mode-toggle").addEventListener("change", async (e) => {
    const shadowMode = !e.target.checked;
    try {
      await post("/api/config", { shadowMode });
      toast(shadowMode ? "Modo sombra activado" : "Sanciones reales activadas");
    } catch (err) {
      e.target.checked = !e.target.checked; // revertir: no se guardó
      toast("No se pudo guardar: " + err.message, 5000);
    }
  });

  wireLogout();

  $("btn-copy-support").addEventListener("click", copiarMensajeDeSoporte);

  $("chip-sin-app").addEventListener("click", () => openDrawer("drawer-network"));

  wireWizard();
}

/**
 * Copiar el ticket de soporte. Lo llaman dos botones —el del cajón de Conexión y el del paso 3 del
 * asistente—, que desde que la configuración manual se fue hacen exactamente lo mismo.
 */
function copiarMensajeDeSoporte() {
  // Sin dirección el mensaje sale con un "--" adentro y el soporte configura la nada. Mejor no
  // copiar nada y decirlo.
  if (!sendAddress || sendAddress === "--") {
    toast("Todavía no tenemos tu dirección. Esperá unos segundos y probá de nuevo.", 5000);
    return;
  }
  navigator.clipboard.writeText(supportMessage(sendAddress)).then(
    () => toast("Mensaje copiado. Pegalo en el ticket de soporte de tu hosting.", 6000),
    () => toast("No se pudo copiar — abrí la guía completa y copialo de ahí", 5000)
  );
}

/**
 * El ticket de soporte, ya armado y con la dirección de esta liga adentro.
 *
 * Va en **inglés** y no en castellano porque el soporte de los hostings de Assetto Corsa contesta
 * en inglés: EmperorServers, Pingperfect, GTXGaming, Nitrado. Un ticket en castellano suma una
 * traducción en el medio y un día de ida y vuelta.
 *
 * Pide que **configuren el plugin apuntando a esta dirección**, no que activen `disable_plugins`.
 * Es lo que pasó de verdad cuando se probó contra EmperorServers: no habilitaron el campo para que
 * lo llenara el cliente, lo configuraron ellos del lado del servidor. Pedir lo segundo deja al admin
 * esperando un campo que nunca va a aparecer.
 *
 * El párrafo del allowlist no es decorativo. El plugin de AC puede restringir quién le manda
 * comandos, y si queda sin autorizar, la telemetría entra igual: el panel se pone verde y todo lo
 * que sale —chat, credenciales, kicks, sanciones— se descarta en silencio. Verde y sordo al mismo
 * tiempo es el peor estado posible, y pedirlo en el mismo ticket cuesta cuatro renglones.
 */
function supportMessage(address) {
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

/**
 * La sesión no vive en el worker sino en el portal, así que el logout **no** pasa por `api()`:
 * `api()` antepone `BASE` (`/l/<slug>`) y ese prefijo se proxea al worker, que no sabe nada de
 * cookies de sesión. La ruta va absoluta y a mano, con el header que el portal exige para aceptar
 * algo que cambia estado.
 */
function wireLogout() {
  const btn = $("btn-logout");
  if (!BASE) return; // panel abierto directo contra el worker: no hay sesión que cerrar
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await fetch("/api/portal/logout", { method: "POST", headers: { "X-RC-Request": "1" } });
    } catch (_) {
      // Si el logout no llegó, igual conviene sacarlo del panel: la pantalla de ingreso le va a
      // decir qué pasa mejor que un toast acá adentro.
    }
    window.location.href = "/login";
  });
}

// ===================================================================== wizard de primer arranque

/**
 * Asistente de tres pasos: bienvenida, conexión y verificación.
 *
 * El de antes pedía solo el nombre de la liga y afirmaba que "el resto se detecta solo", lo cual
 * no era cierto: ni el servidor de AC quedaba conectado ni las reglas quedaban puestas. El admin
 * cerraba el modal creyendo que ya estaba y se enteraba de que faltaba todo el día de la carrera.
 *
 * Los pasos son, en orden, lo que hay que hacer antes de poder usar el producto. Ninguno de los
 * dos últimos es obligatorio —se puede terminar y arreglarlo después— pero están a la vista, que
 * es la diferencia.
 *
 * Eran cuatro hasta la 1.2: el segundo era elegir el tipo de torneo, y era el único obligatorio.
 * Se fue con los tres modos de fábrica. Pedirle a alguien que todavía no corrió una fecha que
 * elija entre "casual" y "estricto" era pedirle una decisión que no tenía con qué tomar, y la
 * respuesta quedaba después contradicha por el primer valor que tocara a mano.
 */
const WIZARD_LAST_STEP = 3;
let wizardStep = 1;
/** `null` = todavía no sabemos si es la primera vez; `true` = abierto; `false` = ya se cerró. */
let wizardOpen = null;

function wireWizard() {
  $("wizard-next").addEventListener("click", () => advanceWizard());
  $("wizard-back").addEventListener("click", () => showWizardStep(wizardStep - 1));
  // El mismo mensaje que el botón del cajón de Conexión. El snippet de arriba quedó como dato a
  // la vista, no como algo que haya que copiar por separado.
  $("wizard-copy").addEventListener("click", copiarMensajeDeSoporte);
  $("wizard-test").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    button.textContent = "Probando...";
    try {
      const result = await post("/api/network/test");
      renderChecksInto($("wizard-checks"), result.checks);
    } catch (err) {
      toast("No se pudo probar: " + err.message, 5000);
    } finally {
      button.disabled = false;
      button.textContent = "Probar de nuevo";
    }
  });
  renderWizardDots();
}

async function advanceWizard() {
  // El paso 1 no guarda nada: es una bienvenida que confirma de qué liga se trata. El nombre ya
  // viene puesto desde el portal cuando el motor arranca.
  if (wizardStep === WIZARD_LAST_STEP) {
    wizardOpen = false;
    $("wizard-overlay").hidden = true;
    toast("Todo listo. El botón \"Conexión\" tiene siempre a mano lo que acabás de ver.", 4000);
    return;
  }
  showWizardStep(wizardStep + 1);
}

function showWizardStep(step) {
  wizardStep = step;
  for (const panel of document.querySelectorAll(".wizard-step")) {
    panel.hidden = Number(panel.dataset.step) !== step;
  }
  $("wizard-back").hidden = step === 1;
  $("wizard-next").textContent = step === WIZARD_LAST_STEP ? "Listo, empezar" : "Siguiente";
  renderWizardDots();
  if (step === WIZARD_LAST_STEP) $("wizard-test").click();
}

function renderWizardDots() {
  const box = $("wizard-steps");
  clearChildren(box);
  for (let i = 1; i <= WIZARD_LAST_STEP; i++) {
    const dot = document.createElement("span");
    dot.className = "wizard-dot" + (i === wizardStep ? " current" : i < wizardStep ? " done" : "");
    box.appendChild(dot);
  }
}

wireRouter();
wireDrawers();
wireButtons();
wireMap();
wireProfiles();
setupForms();
renderRoute();

loadConfigForm().catch((err) => toast("No se pudo cargar la configuración: " + err.message, 5000));
refresh().catch((err) => toast("No se pudo conectar con el backend: " + err.message, 5000));

/**
 * El poll, con el error guardado en vez de tirado a la basura.
 *
 * Acá había un `.catch(() => {})` pelado. Se tragaba todos los errores del polling: si el worker
 * se caía a mitad de carrera, el panel se quedaba congelado mostrando el último estado bueno y no
 * había absolutamente nada en pantalla que lo dijera. `api()` sabe decir "se cortó la conexión",
 * pero ese mensaje solo llegaba al toast del primer `refresh()`, el del arranque.
 *
 * El error no se muestra en un toast: eso sería un cartel por segundo. Se guarda, y la banda
 * decide cuándo vale la pena mostrarlo.
 */
setInterval(() => {
  refresh().catch((err) => {
    lastPollError = err.message;
    renderLinkState();
  });
}, POLL_MS);

/**
 * Reloj propio de la banda, aparte del poll.
 *
 * Con el backend caído no vuelve ningún `refresh()`, así que nada volvería a dibujar la banda y el
 * contador quedaría clavado en el segundo en que se cortó. Este intervalo es el que lo hace
 * avanzar. No pide nada a la red: solo mira el reloj.
 */
setInterval(renderLinkState, 1000);

