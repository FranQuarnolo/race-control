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

// ===================================================================== estado compartido

/** Auto seleccionado. Es UNA sola variable para los dos sentidos de la selección: click en la
 * tabla y click en el mapa escriben acá, y los dos renders leen de acá. Sincronizarlos de a
 * pares (tabla→mapa y mapa→tabla por separado) es la forma segura de que se desincronicen. */
let selectedCarId = null;

let lastState = null;
let trackOutline = null;
let lastTrackCoverage = -1;

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
    if (e.key === "Escape") closeDrawers();
  });
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

function buildPresetsUI() {
  const list = $("preset-list");
  clearChildren(list);
  for (const preset of catalog.presets) {
    const button = document.createElement("button");
    button.className = "preset";
    button.dataset.preset = preset.name;
    button.setAttribute("aria-pressed", "false");
    const label = document.createElement("strong");
    label.textContent = preset.label;
    const description = document.createElement("span");
    description.textContent = preset.description;
    button.appendChild(label);
    button.appendChild(description);
    button.addEventListener("click", () => applyPreset(preset.name, preset.label));
    list.appendChild(button);
  }
}

async function applyPreset(name, label) {
  try {
    const config = await post("/api/config/preset", { preset: name });
    // El preset toca el catálogo Y las sanciones de largada y pit: se repinta todo el cajón en
    // vez de solo la sección, si no quedarían campos mostrando los valores anteriores.
    fillConfigForm(config);
    toast('Listo: reglas de "' + label + '"');
  } catch (err) {
    toast("No se pudo aplicar: " + err.message, 5000);
  }
}

function markActivePreset(active) {
  for (const button of $("preset-list").children) {
    button.setAttribute("aria-pressed", String(button.dataset.preset === active));
  }
}

async function loadConfigForm() {
  // El catálogo primero: la sección de infracciones se arma con lo que el backend dice que se
  // puede configurar, así que sin eso no hay campos donde volcar los valores.
  catalog = await api("/api/catalog");
  buildPresetsUI();
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
  markActivePreset(config.preset);

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
  $("cars-count").textContent = cars.length > 0 ? cars.length + " en pista" : "";

  // Orden de la torre: lo decide el servidor (progreso en carrera, mejor vuelta en práctica y
  // clasificación) y acá solo se respeta. Quien todavía no tiene posición va al fondo.
  const ordered = cars.slice().sort((a, b) => (a.position || 999) - (b.position || 999));

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
  }
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
    speed: cell("num"),
    laps: cell("num"),
    sectors: cell("c-sectors"),
    last: cell("num lap-time"),
    best: cell("num lap-time"),
    pits: cell("num"),
    tyre: cell(""),
    fuel: cell("num"),
    ping: cell("num"),
    actions: cell("actions"),
  };

  for (const key of ["sectors", "pits", "tyre", "fuel"]) cells[key].title = NO_APP_TITLE;

  const kick = document.createElement("button");
  kick.className = "btn-mini";
  kick.textContent = "Kick";
  kick.title = "Expulsar a este piloto del servidor";
  kick.addEventListener("click", () => onKickClick(carId));
  cells.actions.appendChild(kick);

  for (const key of Object.keys(cells)) tr.appendChild(cells[key]);
  return Object.assign({ tr, kick }, cells);
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

  row.speed.textContent = Math.round(car.speedKmh) + " km/h";
  row.laps.textContent = String(car.lapCount);

  renderSectors(row.sectors, telemetry);

  setText(row.last, formatLapTime(car.lastLapMs));
  setText(row.best, formatLapTime(car.bestLapMs));
  // Morado la mejor de todos, verde la mejor propia: es el código de color de cualquier torre de
  // tiempos de sim racing, así que no hay que explicarlo.
  row.best.classList.toggle("session-best", car.bestLapMs !== null && car.bestLapMs === sessionBest);
  row.best.classList.toggle("personal-best", car.bestLapMs !== null && car.bestLapMs !== sessionBest);
  row.last.classList.toggle("personal-best", car.lastLapMs !== null && car.lastLapMs === car.bestLapMs);

  renderPits(row.pits, telemetry);
  setText(row.tyre, telemetry ? telemetry.tyreCompound : null, NO_APP_TITLE);
  setText(row.fuel, telemetry && telemetry.fuelLiters !== null ? telemetry.fuelLiters.toFixed(1) + " L" : null, NO_APP_TITLE);

  clearChildren(row.ping);
  row.ping.appendChild(pingBadge(car));

  row.tr.classList.toggle("in-pit", Boolean(telemetry && telemetry.inPitLane));
  row.tr.classList.toggle("selected", selectedCarId === car.carId);
  const armed = armedKick !== null && armedKick.carId === car.carId;
  row.kick.classList.toggle("arming", armed);
  row.kick.textContent = armed ? "¿Seguro?" : "Kick";
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

/** ms → `m:ss.mmm`, la notación de cualquier torre de tiempos. */
function formatLapTime(ms) {
  if (ms === null || ms === undefined) return null;
  const minutes = Math.floor(ms / 60000);
  const seconds = (ms % 60000) / 1000;
  return minutes + ":" + (seconds < 10 ? "0" : "") + seconds.toFixed(3);
}

function renderSectors(td, telemetry) {
  const sectors = telemetry && telemetry.sectors ? telemetry.sectors : [];
  const signature = sectors.join(",");
  if (td.dataset.signature === signature) return;
  td.dataset.signature = signature;

  clearChildren(td);
  if (sectors.length === 0) {
    const span = document.createElement("span");
    span.className = "nodata";
    span.textContent = "--";
    td.appendChild(span);
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "sectors";
  for (const sector of sectors) {
    const span = document.createElement("span");
    if (sector === null) {
      span.className = "nodata";
      span.textContent = "--";
    } else {
      span.textContent = (sector / 1000).toFixed(3);
    }
    wrap.appendChild(span);
  }
  td.appendChild(wrap);
}

function renderPits(td, telemetry) {
  if (!telemetry || telemetry.pitStops === null) {
    setText(td, null, NO_APP_TITLE);
    return;
  }
  const label = telemetry.inPitLane ? telemetry.pitStops + " · en box" : String(telemetry.pitStops);
  if (td.textContent !== label) td.textContent = label;
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
  img.src = "/brands/" + encodeURIComponent(car.brandLogo) + ".svg";
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

/** Colores de las marcas que más aparecen en una liga. El resto no se mantiene a mano: se deriva
 * un tono estable del propio nombre, así un auto mod también tiene su color y siempre el mismo. */
const BRAND_COLORS = {
  "Abarth": "#b01c21",
  "Alfa Romeo": "#9b1b30",
  "Audi": "#bb0a30",
  "BMW": "#0066b1",
  "Chevrolet": "#d1a73a",
  "Ferrari": "#d40000",
  "Ford": "#1c3f94",
  "Honda": "#cc0000",
  "Jaguar": "#1d4a3f",
  "Lamborghini": "#ddb321",
  "Lancia": "#1b4f9c",
  "Lotus": "#1c6b3c",
  "Maserati": "#15284b",
  "Mazda": "#7b1d2b",
  "McLaren": "#ff8000",
  "Mercedes-Benz": "#00a19b",
  "Nissan": "#c3002f",
  "Pagani": "#2d4a6b",
  "Porsche": "#b12b28",
  "Renault": "#d6c01d",
  "Subaru": "#0b3d91",
  "Toyota": "#c8102e",
  "Volkswagen": "#0a3d7a",
};

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

// --------------------------------------------------------------- kick con doble confirmación

function disarmKick() {
  if (!armedKick) return;
  clearTimeout(armedKick.timer);
  const row = carRows.get(armedKick.carId);
  armedKick = null;
  if (row) {
    row.kick.classList.remove("arming");
    row.kick.textContent = "Kick";
  }
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
    executeKick(carId);
    return;
  }
  disarmKick();
  armedKick = { carId, timer: setTimeout(disarmKick, KICK_ARM_MS) };
  const row = carRows.get(carId);
  if (row) {
    row.kick.classList.add("arming");
    row.kick.textContent = "¿Seguro?";
  }
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
  if (trackOutline.coverage > 0.95) ctx.closePath();
  ctx.strokeStyle = "#2f3545";
  ctx.lineWidth = 13;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.strokeStyle = "#1b1f28";
  ctx.lineWidth = 9;
  ctx.stroke();

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

    ctx.beginPath();
    ctx.arc(p.x, p.y, selected || hovered ? 8 : 6, 0, Math.PI * 2);
    // Con el acento en dorado, el auto seleccionado ya no puede ser amarillo: sobre el resto de
    // la parrilla —que ahora es dorada— se perdería. El blanco es el único color que queda con
    // contraste propio en el mapa, y es además el más fuerte, que es lo que corresponde a lo
    // seleccionado. El hover queda en un dorado claro: un escalón, no otro color.
    ctx.fillStyle = selected ? "#ffffff" : hovered ? "#ffd877" : "#f0b429";
    ctx.fill();
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

async function refreshTrack(coverage) {
  // Solo se vuelve a bajar el trazado cuando creció: son ~600 puntos y no tiene sentido pedirlos
  // una vez por segundo cuando el circuito ya está aprendido y no cambia más.
  if (coverage <= lastTrackCoverage) return;
  lastTrackCoverage = coverage;
  try {
    const outline = await api("/api/track");
    trackOutline = outline;
  } catch (_) {
    // el backend puede estar reiniciando; el próximo poll reintenta
  }
}

function renderMapStatus(state) {
  const coverage = state.track ? state.track.coverage : 0;
  const ready = trackOutline !== null;
  $("map-empty").hidden = ready;
  $("map-hint").textContent = ready && coverage < 0.95 ? "aprendiendo: " + Math.round(coverage * 100) + "%" : "";
  $("map-progress").firstElementChild.style.width = Math.round(coverage * 100) + "%";
  $("map-empty-text").textContent =
    state.cars.length === 0
      ? "Esperando que alguien salga a pista para aprender el circuito."
      : "Aprendiendo el circuito: " + Math.round(coverage * 100) + "%";
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

  if (session.remainingMs === null) {
    // Sesión por vueltas: no hay cronómetro, hay un número de vueltas.
    clock.hidden = session.laps <= 0;
    clock.classList.remove("ending");
    $("ses-clock-label").textContent = "Vueltas";
    $("ses-clock-value").textContent = String(session.laps);
    return;
  }
  clock.hidden = false;
  $("ses-clock-label").textContent = "Restan";
  $("ses-clock-value").textContent = formatClock(session.remainingMs);
  clock.classList.toggle("ending", session.remainingMs <= 60000);
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
    body.appendChild(tr);
  }
}

function appendCell(tr, text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  tr.appendChild(td);
}

/** Las sanciones guardan el guid, no el nombre. Lo resolvemos contra los autos conectados para
 * no mostrarle "Auto 7" a quien quiere saber a quién sancionó. */
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
 * "Fulano vs Mengano", que se arma aparte. */
const INCIDENT_KIND_LABELS = {
  "env-collision": "choque en solitario",
  "track-limits": "límites de pista",
  "telemetry-mismatch": "telemetría inconsistente",
};

const INCIDENT_STATUS = {
  dismissed: ["neutral", "descartado"],
  warned: ["warn", "advertido"],
  penalized: ["bad", "sancionado"],
};

/** Firma de lo renderizado, para no reconstruir la lista entera una vez por segundo mientras el
 * admin está leyendo un incidente. */
let incidentsSignature = "";

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

  for (const incident of incidents) list.appendChild(incidentCard(incident));
}

function incidentCard(incident) {
  const card = document.createElement("div");
  card.className = "incident" + (incident.status === "pending" ? "" : " resolved");

  const head = document.createElement("div");
  head.className = "head";

  const who = document.createElement("span");
  who.className = "who";
  who.textContent =
    incident.kind === "car-contact"
      ? incident.parties.map((p) => p.driverName).join("  vs  ")
      : incident.parties[0].driverName + " — " + (INCIDENT_KIND_LABELS[incident.kind] || "incidente");
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

  confirm.addEventListener("click", async () => {
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

function renderNetwork(network) {
  // La dirección de la liga es el único dato del que depende que el servidor de AC pueda
  // encontrarnos. La asigna el portal al arrancar; si falta, algo está mal de nuestro lado.
  const ipEl = $("net-ip");
  if (network.publicIp) {
    ipEl.textContent = network.publicIp;
    ipEl.className = "ok";
  } else {
    ipEl.textContent = "sin asignar";
    ipEl.className = "bad";
  }

  $("net-signal").textContent = network.receivingTelemetry ? "recibiendo" : "sin señal todavía";
  // Es un <input>, no un bloque de texto: va por `value`.
  $("net-send-address").value = network.sendAddress;
  $("wizard-snippet").textContent = network.sendAddress;

  // "Llega telemetría" y "los pilotos alcanzan el backend" son dos cosas distintas que fallan por
  // separado: el UDP del servidor puede entrar perfecto mientras el puerto de los pilotos está
  // cerrado. Mostrarlas juntas hacía que el panel diera todo verde justo antes de kickear a todos.
  const d = network.driversReporting || { reporting: 0, connected: 0 };
  const driversEl = $("net-drivers");
  driversEl.textContent = d.connected === 0 ? "nadie conectado todavía" : d.reporting + " de " + d.connected;
  driversEl.className = d.connected > 0 && d.reporting === 0 ? "bad" : "";

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
}

// ===================================================================== botones de largada

/** Qué acciones tienen sentido en cada estado. Antes los tres botones estaban siempre activos y
 * el servidor ignoraba en silencio los que no correspondían, sin ningún feedback. */
const START_ACTIONS = {
  idle: { begin: true, green: false, reset: false },
  formation: { begin: false, green: true, reset: true },
  green: { begin: false, green: false, reset: true },
};

function renderStart(lightState) {
  const semaforo = $("semaforo");
  semaforo.className = "semaforo " + lightState;
  const labels = { idle: "Esperando", formation: "Formación", green: "VERDE" };
  semaforo.textContent = labels[lightState] || lightState;

  const allowed = START_ACTIONS[lightState] || START_ACTIONS.idle;
  $("btn-begin").disabled = !allowed.begin;
  $("btn-green").disabled = !allowed.green;
  $("btn-reset").disabled = !allowed.reset;

  // Con el verde dado, el renglón de ayuda se calla y habla el aviso grande: a esa altura el
  // admin ya no necesita instrucciones, necesita confirmar de un vistazo que la carrera corre.
  const racing = lightState === "green";
  $("card-start").classList.toggle("racing", racing);
  $("race-live").hidden = !racing;

  const hints = {
    idle: "Arrancá la formación cuando la parrilla esté completa.",
    formation: "Control de velocidad activo. Dale verde cuando la fila esté ordenada.",
  };
  $("start-hint").textContent = hints[lightState] || "";
}

// ===================================================================== ciclo principal

async function refresh() {
  const state = await api("/api/state");
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

  renderStart(state.lightState);
  renderRaceFlag(state);
  renderTiming(state.cars);
  renderNetwork(state.network);
  renderMode(state.shadowMode);
  renderPenalties(state.formationPenalties, state.pitPenalties, state.stewardPenalties);
  renderIncidents(state.incidents || []);

  const badge = $("nav-incident-count");
  badge.textContent = String(state.pendingIncidents || 0);
  badge.hidden = !state.pendingIncidents;

  updateCarTargets(state.cars);
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

  $("btn-copy-send-address").addEventListener("click", () => {
    navigator.clipboard.writeText($("net-send-address").value).then(
      () => toast("Copiado"),
      () => toast("No se pudo copiar — seleccionalo y copialo a mano", 4000)
    );
  });

  // Un click en el campo selecciona todo: si el portapapeles falla —pasa sin HTTPS—, copiarlo a
  // mano queda a un Ctrl+C.
  $("net-send-address").addEventListener("focus", (e) => e.target.select());

  wireWizard();
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
 * Asistente de cuatro pasos.
 *
 * El de antes pedía solo el nombre de la liga y afirmaba que "el resto se detecta solo", lo cual
 * no era cierto: ni el servidor de AC quedaba conectado ni las reglas quedaban puestas. El admin
 * cerraba el modal creyendo que ya estaba y se enteraba de que faltaba todo el día de la carrera.
 *
 * Los cuatro pasos son, en orden, lo que hay que hacer antes de poder usar el producto. Ninguno
 * de los tres últimos es obligatorio —se puede terminar y arreglarlo después— pero los tres están
 * a la vista, que es la diferencia.
 */
const WIZARD_LAST_STEP = 4;
let wizardStep = 1;
let wizardPreset = "";
/** `null` = todavía no sabemos si es la primera vez; `true` = abierto; `false` = ya se cerró. */
let wizardOpen = null;

function wireWizard() {
  $("wizard-next").addEventListener("click", () => advanceWizard());
  $("wizard-back").addEventListener("click", () => showWizardStep(wizardStep - 1));
  $("wizard-copy").addEventListener("click", () => {
    navigator.clipboard.writeText($("wizard-snippet").textContent).then(
      () => toast("Copiado"),
      () => toast("No se pudo copiar — seleccionalo y copialo a mano", 4000)
    );
  });
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
  if (wizardStep === 2 && !wizardPreset) {
    toast("Elegí un tipo de torneo");
    return;
  }
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
  if (step === 2) buildWizardPresets();
  if (step === 4) $("wizard-test").click();
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

function buildWizardPresets() {
  const list = $("wizard-presets");
  if (!catalog || list.children.length > 0) return;
  for (const preset of catalog.presets) {
    const button = document.createElement("button");
    button.className = "preset";
    button.dataset.preset = preset.name;
    button.setAttribute("aria-pressed", "false");
    const label = document.createElement("strong");
    label.textContent = preset.label;
    const description = document.createElement("span");
    description.textContent = preset.description;
    button.appendChild(label);
    button.appendChild(description);
    button.addEventListener("click", async () => {
      try {
        fillConfigForm(await post("/api/config/preset", { preset: preset.name }));
        wizardPreset = preset.name;
        for (const other of list.children) {
          other.setAttribute("aria-pressed", String(other.dataset.preset === preset.name));
        }
      } catch (err) {
        toast("No se pudo aplicar: " + err.message, 5000);
      }
    });
    list.appendChild(button);
  }
}

wireRouter();
wireDrawers();
wireButtons();
wireMap();
setupForms();
renderRoute();

loadConfigForm().catch((err) => toast("No se pudo cargar la configuración: " + err.message, 5000));
refresh().catch((err) => toast("No se pudo conectar con el backend: " + err.message, 5000));
setInterval(() => refresh().catch(() => {}), POLL_MS);

