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

let lastState = null;

/** Sugerencia de `PitZoneLearner` para el circuito actual (o `null` si todavía nadie con la app
 * pasó por boxes). Se guarda acá para que el botón "Usar esta calibración" la tenga disponible
 * sin tener que pedirla de nuevo al servidor. */
let pitZoneSuggestion = null;

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

// Esta rama fusiona Control de carrera y Sanciones en una sola pantalla —pedido para incrustarla
// en fslmanager.vercel.app sin iframe—, así que no hay más de una vista y no hace falta router. La
// versión completa, con el mapa y las dos pestañas, sigue viva tal cual en la rama main.

// ===================================================================== cajones laterales

/** Qué modal abre cada `#ancla`. Ninguno es una vista del router —se abren encima de lo que
 * haya— pero sí tienen que ser enlazables: así el aviso de "revisá la conexión" puede mandar
 * directo al lugar donde se revisa, en vez de describir dónde está el botón.
 *
 * Acá vivía `DRAWER_HASHES` y el cajón lateral de Conexión: pasó a ser un modal más, igual que
 * Reglas y Sanciones aplicadas, para que los tres se comporten y se cierren igual. */
const MODAL_HASHES = { "#conexion": "modal-network", "#reglas": "modal-rules", "#sanciones": "modal-penalties" };

function openModal(id) {
  $(id).hidden = false;
}

function closeModals() {
  $("modal-network").hidden = true;
  $("modal-penalties").hidden = true;
  $("modal-rules").hidden = true;
  // Sin esto, cerrar y volver a tocar el mismo botón no haría nada: el hash seguiría puesto y el
  // navegador no dispara `hashchange` si no cambió.
  if (window.location.hash) history.replaceState({}, "", window.location.pathname);
}

function applyOverlayHash() {
  const modalId = MODAL_HASHES[window.location.hash];
  if (modalId) openModal(modalId);
}

/** Pestañas del modal de Reglas: una sección a la vez, sin perder los ids de cada campo. */
function wireRulesTabs() {
  const tabs = document.querySelectorAll("#modal-rules .tab");
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
      for (const panel of document.querySelectorAll("#modal-rules .tab-panel")) {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      }
    });
  }
}

function wireDrawers() {
  $("btn-network").addEventListener("click", () => openModal("modal-network"));
  $("btn-rules").addEventListener("click", () => openModal("modal-rules"));
  $("btn-penalties").addEventListener("click", () => openModal("modal-penalties"));
  window.addEventListener("hashchange", applyOverlayHash);
  applyOverlayHash();
  wireRulesTabs();

  for (const btn of document.querySelectorAll("[data-close-modal]")) {
    btn.addEventListener("click", closeModals);
  }
  // Click en el fondo oscuro, no dentro del modal.
  for (const id of ["modal-network", "modal-penalties", "modal-rules"]) {
    $(id).addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeModals();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // El menú de fila primero: si hay uno abierto, Escape lo cierra a él y no lo que hay detrás.
    if (openMenu) {
      closeRowMenu();
      return;
    }
    closeModals();
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

/** Muestra u oculta el aviso de calibración automática del pit lane (`PitZoneLearner` en el
 * servidor), con el rango que propone. `null` cuando todavía nadie con la app pasó por boxes en
 * este circuito. */
function renderPitZoneSuggestion(suggestion) {
  pitZoneSuggestion = suggestion;
  const box = $("p-zone-suggestion");
  box.hidden = !suggestion;
  if (suggestion) {
    $("p-zone-suggestion-value").textContent =
      suggestion.splineStart.toFixed(3) + " – " + suggestion.splineEnd.toFixed(3);
  }
}

function setupForms() {
  registerForm(
    "formation",
    "btn-save-formation",
    ["f-threshold", "f-tolerance", "f-grace", "f-penalty-type", "f-escalation", "f-time-penalty"],
    () => ({
      formation: {
        penalty: {
          speedThresholdKmh: num("f-threshold"),
          toleranceSeconds: num("f-tolerance"),
          graceLaps: num("f-grace"),
          penaltyType: $("f-penalty-type").value,
          escalation: $("f-escalation").value,
          timePenaltySeconds: num("f-time-penalty"),
        },
      },
    })
  );
  // El campo de segundos solo tiene sentido con "Penalización de tiempo" elegida: el resto del
  // tiempo queda oculto, no deshabilitado, para no mandar un número que no se va a usar.
  $("f-escalation").addEventListener("change", () => {
    $("f-time-penalty-row").hidden = $("f-escalation").value !== "TIME_PENALTY";
  });

  registerForm(
    "pit",
    "btn-save-pit",
    ["p-zone-start", "p-zone-end", "p-threshold", "p-tolerance", "p-grace", "p-stopgo", "p-penalty-type", "p-escalation", "p-time-penalty"],
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
          timePenaltySeconds: num("p-time-penalty"),
        },
      },
    })
  );
  $("p-escalation").addEventListener("change", () => {
    $("p-time-penalty-row").hidden = $("p-escalation").value !== "TIME_PENALTY";
  });

  // El botón de la sugerencia no es parte del form "pit": copia los valores aprendidos a los dos
  // campos manuales y dispara el guardado de siempre, para que la calibración automática pase por
  // el mismo camino (y la misma validación) que un valor tipeado a mano.
  $("btn-use-zone-suggestion").addEventListener("click", () => {
    if (!pitZoneSuggestion) return;
    $("p-zone-start").value = pitZoneSuggestion.splineStart.toFixed(3);
    $("p-zone-end").value = pitZoneSuggestion.splineEnd.toFixed(3);
    refreshFormButton("pit");
    saveForm("pit");
  });

  registerForm(
    "presence",
    "btn-save-presence",
    ["pr-enforce", "pr-grace"],
    () => ({ presence: { enforce: $("pr-enforce").checked, graceSeconds: num("pr-grace") } })
  );

  // `tokenVersion` no se toca desde este formulario: `stripManagedFields` en adminApi.ts lo saca
  // de cualquier patch de `/api/config` justamente para que guardar el origen no revoque el token
  // de nadie sin que el admin lo haya pedido con el botón de regenerar.
  registerForm("embed", "btn-save-embed", ["embed-origin"], () => ({
    embed: { allowedOrigin: $("embed-origin").value.trim() },
  }));

  // Acá vivía el registro del campo "Liga" (solo lectura, lo administraba el portal). Esta
  // pantalla no tiene portal propio —vive incrustada en fslmanager.vercel.app— así que la pestaña
  // entera se fue. Ver el comentario en index.html, donde vivía el tab-panel.
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
  // Estos dos NO deciden si se sanciona: eso ya está arriba, en Largada y en Pit, junto al km/h y
  // los segundos de tolerancia. Acá se decide si el hecho además se le muestra al comisario. El
  // texto de ayuda lo dice con todas las letras, porque es exactamente lo que se malinterpreta.
  pitSpeeding: {
    title: "Exceso de velocidad en pit lane",
    help:
      "La sanción se configura en Pit lane, con el límite y la tolerancia. Acá elegís si además " +
      "aparece en la bandeja, agrupado por piloto: tres excesos seguidos del mismo auto dicen " +
      "algo que uno solo no dice.",
    fields: [],
  },
  formationSpeeding: {
    title: "Exceso de velocidad en la formación",
    help:
      "Lo mismo para la vuelta de formación: la sanción se configura en Largada, y acá elegís si " +
      "el hecho entra a la bandeja.",
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
  $("f-time-penalty").value = config.formation.penalty.timePenaltySeconds ?? 5;
  $("f-time-penalty-row").hidden = config.formation.penalty.escalation !== "TIME_PENALTY";

  $("p-zone-start").value = config.pit.zone.splineStart;
  $("p-zone-end").value = config.pit.zone.splineEnd;
  $("p-threshold").value = config.pit.penalty.speedThresholdKmh;
  $("p-tolerance").value = config.pit.penalty.toleranceSeconds;
  $("p-grace").value = config.pit.penalty.graceLaps;
  $("p-stopgo").value = config.pit.stopGoSeconds;
  $("p-penalty-type").value = config.pit.penalty.penaltyType;
  $("p-escalation").value = config.pit.penalty.escalation;
  $("p-time-penalty").value = config.pit.penalty.timePenaltySeconds ?? 5;
  $("p-time-penalty-row").hidden = config.pit.penalty.escalation !== "TIME_PENALTY";

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

  $("embed-origin").value = config.embed.allowedOrigin;

  for (const name of Object.keys(forms)) markFormSaved(name);
}

/**
 * El token del embed (ver security/embedToken.ts) no viaja en `/api/config` a propósito: no es un
 * dato de configuración, es un secreto que no tiene por qué pasar por el mismo camino que el resto
 * del reglamento. Se pide aparte y se guarda solo en memoria del panel — nunca en `forms` ni en
 * `config.json` del lado del cliente.
 */
let embedToken = null;

async function loadEmbedToken() {
  try {
    const data = await api("/api/embed-token");
    embedToken = data.token;
    renderEmbedSnippet();
  } catch (err) {
    $("embed-snippet").value = "No se pudo generar el código: " + err.message;
  }
}

/** El snippet trae la dirección de ESTE servidor (`location.origin`) y el slug de ESTA liga
 * (deducido de `BASE`, igual que el resto del panel): el admin lo pega tal cual, sin completar
 * nada a mano.
 *
 * El `src` del script lleva `BASE` (`/l/<slug>`) adelante de `/embed/embed.js`: sin eso apuntaba a
 * la raíz del dominio, que el portal no sabe a qué liga mandar (y que, de paso, nunca llegó a
 * servir nada ahí — ver el bypass de sesión nuevo en `portal/server.ts`). */
function renderEmbedSnippet() {
  if (!embedToken) return;
  const slug = BASE.slice(3);
  $("embed-snippet").value =
    '<div id="rc-embed"></div>\n' +
    '<script src="' +
    window.location.origin +
    BASE +
    '/embed/embed.js" data-slug="' +
    slug +
    '" data-token="' +
    embedToken +
    '"></script>';
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

/** Los incidentes agrupados por piloto (ver `agruparPorPiloto`), recalculados en cada `refresh()`.
 * Antes alimentaban una bandeja aparte ("Incidentes a revisar"); en esta pantalla fusionada cada
 * fila de la tabla lee de acá los números de Cuts/Insi y el contenido de su propio detalle. */
let incidentGroups = new Map();

function groupKeyFor(car) {
  return car.driverGuid || "car-" + car.carId;
}

/** El grupo de incidentes de un auto, buscado por `carId` contra el último estado conocido. Lo
 * usan los botones del detalle expandido (cancelar, descartar) para repintar sin esperar un poll. */
function groupForCarId(carId) {
  const car = (lastState ? lastState.cars : []).find((c) => c.carId === carId);
  if (!car) return null;
  return incidentGroups.get(groupKeyFor(car)) || null;
}

function updateIncidentGroups(incidents) {
  incidentGroups = new Map();
  for (const grupo of agruparPorPiloto(incidents)) incidentGroups.set(grupo.clave, grupo);
}

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

  const seen = new Set();
  for (const car of ordered) {
    seen.add(car.carId);
    let row = carRows.get(car.carId);
    if (!row) {
      row = createCarRow(car.carId);
      carRows.set(car.carId, row);
    }
    updateCarRow(row, car);
    // appendChild reordena si ya estaba: mantiene el orden de la torre. El detalle va siempre
    // pegado atrás de su propia fila, aunque las dos se muevan juntas en cada repintado.
    body.appendChild(row.tr);
    body.appendChild(row.detailTr);
  }

  for (const [carId, row] of carRows) {
    if (seen.has(carId)) continue;
    row.tr.remove();
    row.detailTr.remove();
    carRows.delete(carId);
    if (armedKick && armedKick.carId === carId) disarmKick();
    if (openMenu && openMenu.carId === carId) closeRowMenu();
  }

}

function createCarRow(carId) {
  const tr = document.createElement("tr");

  // Acá vivían el intervalo, las vueltas y la última/mejor vuelta: la torre de tiempos completa de
  // la rama main. Esta pantalla fusiona Control de carrera y Sanciones para incrustarla en
  // fslmanager.vercel.app, y suma en cambio Cuts e Insi —que antes vivían en una bandeja aparte—
  // directo en la fila de cada piloto.
  const cells = {
    pos: cell("num"),
    car: cell("c-car"),
    name: cell("c-driver"),
    speed: cell("num"),
    pits: cell("num"),
    fuel: cell("num"),
    cuts: cell("num"),
    incidents: cell("num"),
    actions: cell("c-actions"),
  };

  for (const key of ["pits", "fuel"]) cells[key].title = NO_APP_TITLE;

  // El detalle de este piloto —sus incidentes, con el formulario de sanción adentro— no se arma
  // hasta que se abre: por eso `expanded` empieza en `false` y `updateCarDetail` no hace nada
  // mientras tanto. Antes esto vivía en una tarjeta suelta por piloto, en una bandeja aparte.
  const expand = document.createElement("button");
  expand.className = "btn-expand";
  expand.title = "Ver los incidentes y sanciones de este piloto";
  expand.setAttribute("aria-label", "Ver detalle del piloto");
  expand.setAttribute("aria-expanded", "false");
  expand.textContent = "▾";
  expand.addEventListener("click", () => toggleCarDetail(carId));
  cells.actions.appendChild(expand);

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

  const detailTr = document.createElement("tr");
  detailTr.className = "car-detail-row";
  detailTr.hidden = true;
  const detailTd = document.createElement("td");
  detailTd.colSpan = Object.keys(cells).length;
  const detailBody = document.createElement("div");
  detailBody.className = "car-detail";
  detailTd.appendChild(detailBody);
  detailTr.appendChild(detailTd);

  return Object.assign(
    { tr, detailTr, detailBody, kebab, expand, carId, expanded: false, detailSignature: "" },
    cells
  );
}

/** Abre o cierra el detalle de un piloto. Se construye recién al abrir —`updateCarDetail` corta
 * en seco si `expanded` es `false`— así que cerrarlo y abrirlo de nuevo no tiene costo: el
 * contenido real se arma una sola vez por cambio real en sus incidentes. */
function toggleCarDetail(carId) {
  const row = carRows.get(carId);
  if (!row) return;
  row.expanded = !row.expanded;
  row.detailTr.hidden = !row.expanded;
  row.expand.textContent = row.expanded ? "▴" : "▾";
  row.expand.setAttribute("aria-expanded", String(row.expanded));
  if (row.expanded) {
    row.detailSignature = ""; // forzar el primer dibujo
    updateCarDetail(row, groupForCarId(carId));
  }
}

/**
 * El contenido del detalle: los incidentes de este piloto, más nuevo arriba, cada uno con su
 * propio formulario de sanción — es la misma `incidentCard` que antes vivía en la bandeja global,
 * ahora filtrada a un solo piloto.
 *
 * La firma evita reconstruir el DOM en cada poll mientras el admin está leyendo o completando un
 * formulario de sanción: sin esto, cada segundo se perdería lo que estuviera tipeado.
 */
function updateCarDetail(row, grupo) {
  if (!row.expanded) return;
  const filas = grupo ? grupo.filas : [];
  const signature = filas.map((f) => f.incident.id + f.incident.status + f.incident.impactCount).join("|");
  if (signature === row.detailSignature) return;
  row.detailSignature = signature;

  clearChildren(row.detailBody);
  if (filas.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Sin incidentes para este piloto en esta sesión.";
    row.detailBody.appendChild(empty);
    return;
  }
  const ordenadas = filas.slice().sort((a, b) => b.incident.createdAt - a.incident.createdAt);
  for (const fila of ordenadas) row.detailBody.appendChild(incidentCard(fila.incident, fila.propio, row));
}

function cell(className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  return td;
}

function updateCarRow(row, car) {
  const telemetry = car.telemetry || null;

  const label = car.driverName || "Auto " + car.carId;
  if (row.name.textContent !== label) row.name.textContent = label;
  row.name.title = label;

  setText(row.pos, car.position != null ? String(car.position) : null);
  renderCarBadge(row.car, car);
  // La velocidad sale del propio UDP del servidor (CAR_UPDATE), no de la app del piloto: por eso
  // no lleva `NO_APP_TITLE` como box y combustible, y nunca queda en "--" salvo sin dato todavía.
  setText(row.speed, typeof car.speedKmh === "number" ? Math.round(car.speedKmh) + " km/h" : null);
  renderPits(row.pits, telemetry);
  setText(row.fuel, telemetry && telemetry.fuelLiters !== null ? telemetry.fuelLiters.toFixed(1) + " L" : null, NO_APP_TITLE);

  // Cuts y incidentes salen del mismo agrupado por piloto que antes alimentaba la bandeja aparte
  // (`agruparPorPiloto`): la lógica de que solo cuentan en clasificación y carrera no cambió, vive
  // en el motor que decide si crear el incidente, no acá.
  const grupo = incidentGroups.get(groupKeyFor(car)) || null;
  const cuts = grupo ? grupo.cuts : 0;
  const incidentesCount = grupo ? grupo.choques + grupo.pit + grupo.largada + grupo.otros : 0;
  row.cuts.textContent = String(cuts);
  row.incidents.textContent = String(incidentesCount);
  row.incidents.classList.toggle("has-pending", Boolean(grupo && grupo.pendientes > 0));
  row.expand.classList.toggle("has-pending", Boolean(grupo && grupo.pendientes > 0));

  // Sin columna de posición ni de velocidad visibles de lejos no hay dónde escribir "desconectado"
  // o "sin señal": estas tres clases de fila son todo el aviso que le queda a esta pantalla
  // simplificada, y alcanzan — la atenúan entera en vez de marcar una sola celda.
  const fuera = car.connected === false;
  row.tr.classList.toggle("desconectado", fuera);
  row.tr.classList.toggle("in-pit", !fuera && Boolean(car.inPit));
  // Un desconectado tiene la telemetría vencida por definición: marcarlo además como "stale"
  // apilaría dos grises distintos sobre la misma fila y ninguno de los dos se leería.
  row.tr.classList.toggle("stale", !fuera && Boolean(car.telemetryStale));
  // Nada que hacerle a alguien que ya no está en el servidor: ni kickearlo ni sancionarlo en
  // vivo. El menú se deshabilita en vez de esconderse, para que la columna no baile.
  row.kebab.disabled = fuera;
  row.kebab.title = fuera ? "El piloto no está conectado" : "Más acciones";
  // El kick vive dentro del menú de tres puntitos, que puede estar cerrado: el punto rojo en los
  // puntitos es lo único que queda a la vista de que hay un kick a medio confirmar.
  row.kebab.classList.toggle("arming", armedKick !== null && armedKick.carId === car.carId);

  updateCarDetail(row, grupo);
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

// Acá vivían `renderGap`, `renderGapHeader`, `formatGap` y `formatLapTime`: el intervalo, la
// última y la mejor vuelta. Es la pantalla fusionada para fslmanager.vercel.app, no el panel
// completo — ese live timing ya lo tiene la página del admin por otro lado. La rama main conserva
// las cuatro funciones intactas.

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
 * Escudo con monograma: el reemplazo del logo cuando `brandLogo` viene `null` —la marca del auto
 * no está en la biblioteca `brands/`, o el archivo no cargó.
 *
 * Por qué un escudo y no el nombre de la marca en texto: la columna de auto se lee de reojo a
 * media carrera, y una palabra obliga a leerla. Una forma de color constante por marca se
 * reconoce sin leer, que es exactamente lo que hace el logo real. Se dibuja con CSS en vez de
 * pedir un archivo, así no hay 404 ni parpadeo mientras se resuelve.
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

// Acá vivía la sección entera del mapa del circuito: el canvas, la interpolación de los autos, el
// dibujo del trazado y de la zona de pit, el tooltip al pasar el mouse, la carga del trazado
// (`/api/track`) y las condiciones de sesión (`renderSession`/`renderSessionChip`) que vivían
// pegadas al mapa. Esta pantalla fusiona Control de carrera y Sanciones para incrustarla en
// fslmanager.vercel.app, y el mapa no entra en esa fusión — la rama main lo conserva intacto.

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
  "pit-speeding": "exceso en pit lane",
  "formation-speeding": "exceso en la formación",
};

/**
 * Las cuentas que el comisario lleva de cada piloto.
 *
 * **Cuts** es irse de pista; **choques** es pegarle a algo, solo o contra otro. Son dos cosas
 * distintas y se juzgan distinto: diez cuts es alguien que está usando de más el pianito, diez
 * choques es alguien peligroso. Antes la bandeja no las separaba —ni las sumaba—, así que un
 * trompo solo en una práctica llenaba la pantalla de diecinueve tarjetas sueltas y había que
 * contarlas a ojo para saber cuál de las dos cosas había pasado.
 *
 * Desde la 1.3 los dos excesos de velocidad tienen cuenta propia, **Pit** y **Largada**, y no van
 * dentro de "Otros": son objetivos y medidos —un número contra un límite, sin interpretación— y
 * meterlos en la misma bolsa que una desconexión perdería justo lo que los hace útiles. Tres
 * excesos en pit lane de un mismo piloto es un patrón; adentro de "Otros: 3" no se ve.
 *
 * Lo que no cae en ninguna (contramano, desconexión, telemetría inconsistente) se sigue contando
 * aparte en vez de forzarlo a una de estas: meter una desconexión adentro de "choques" sería
 * inventar un dato.
 */
const CUT_KINDS = ["track-limits", "cut-lap"];
const CHOQUE_KINDS = ["car-contact", "env-collision"];
const PIT_KINDS = ["pit-speeding"];
const LARGADA_KINDS = ["formation-speeding"];

const INCIDENT_STATUS = {
  dismissed: ["neutral", "descartado"],
  warned: ["warn", "advertido"],
  penalized: ["bad", "sancionado"],
};

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
        grupo = {
          clave,
          nombre: party.driverName,
          cuts: 0,
          choques: 0,
          pit: 0,
          largada: 0,
          otros: 0,
          pendientes: 0,
          ultimo: 0,
          filas: [],
        };
        porPiloto.set(clave, grupo);
      }
      if (party.driverName) grupo.nombre = party.driverName;
      grupo.filas.push({ incident, propio: party });
      if (CUT_KINDS.indexOf(incident.kind) !== -1) grupo.cuts++;
      else if (CHOQUE_KINDS.indexOf(incident.kind) !== -1) grupo.choques++;
      else if (PIT_KINDS.indexOf(incident.kind) !== -1) grupo.pit++;
      else if (LARGADA_KINDS.indexOf(incident.kind) !== -1) grupo.largada++;
      else grupo.otros++;
      if (incident.status === "pending") grupo.pendientes++;
      if (incident.createdAt > grupo.ultimo) grupo.ultimo = incident.createdAt;
    }
  }

  // Lo que pasó hace un minuto arriba. En una carrera el comisario revisa hacia atrás desde lo
  // último, no busca un nombre en una lista alfabética.
  return Array.from(porPiloto.values()).sort((a, b) => b.ultimo - a.ultimo);
}

/**
 * Una tarjeta de incidente.
 *
 * `propio` es el piloto desde cuyo grupo se la está mirando, y cambia el título: adentro del grupo
 * de Fulano un toque se lee "Toque con Mengano", que es el dato que el comisario está buscando
 * —contra quién fue—, y no "Fulano vs Mengano", que repite el nombre del encabezado del grupo.
 *
 * `carRow` es la fila de la torre a la que pertenece este detalle: lo necesitan sus propios
 * botones (cancelar el formulario de sanción) para repintar solo ese detalle, sin esperar el
 * próximo poll ni tocar las filas de los demás pilotos.
 */
function incidentCard(incident, propio, carRow) {
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
    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";
    btnRow.appendChild(resolveButton(incident.id, "dismissed", "Descartar", "secondary"));
    btnRow.appendChild(resolveButton(incident.id, "warned", "Advertir", "secondary"));

    // "Sancionar" no resuelve de una: abre el formulario. Un toque tiene dos pilotos y el
    // servidor no sabe de quién fue la culpa — elegir por él sería inventar un veredicto.
    const sanction = document.createElement("button");
    sanction.className = "btn-mini danger";
    sanction.textContent = "Sancionar";
    sanction.addEventListener("click", () => {
      btnRow.replaceWith(penaltyForm(incident, card, carRow));
    });
    btnRow.appendChild(sanction);
    card.appendChild(btnRow);
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
function penaltyForm(incident, card, carRow) {
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
    if (!carRow) return;
    carRow.detailSignature = ""; // forzar el redibujo: volver al botón "Sancionar" de siempre
    updateCarDetail(carRow, groupForCarId(carRow.carId));
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

  // El manual de "Cómo conectar tu servidor" es para quien todavía no lo hizo. Con la conexión ya
  // confirmada —mismo criterio que pinta de verde el botón de la barra— seguir mostrándolo es
  // ruido: ocupa lugar arriba de todo en un cajón que, a partir de acá, se abre sobre todo para
  // mirar el estado o tocar el modo.
  const connected = Boolean(ac.autodetected) && network.receivingTelemetry;
  $("network-howto").hidden = connected;

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

// ===================================================================== informe de posiciones finales

/**
 * Antes esto vivía junto a la bandera a cuadros de la barra, que se fue con el resto del
 * encabezado de marca (ver la nota del header en index.html). Lo único que queda de esa función es
 * lo que de verdad hacía falta: el link de posiciones finales solo aparece con la carrera
 * terminada. Mientras la carrera corre el link no está: la clasificación se sigue moviendo y un
 * JSON bajado en la vuelta 20 no es un resultado, es una foto que después nadie sabe de cuándo era.
 */
function renderFinishedReport(state) {
  $("btn-report-timing").hidden = state.phase !== "finished";
}

// ===================================================================== semáforo de 5 luces

/** Cada disco replica el mismo estado —no hay cinco valores independientes del servidor— así que
 * alcanza con tres clases CSS sobre el contenedor. Constantes calcadas de `RaceControlClient.py`
 * (`LIGHTS_BLINK_SECONDS`, `LIGHTS_GREEN_HOLD_SECONDS`): lo que ve el admin en el panel tiene que
 * ser lo mismo que ve el piloto en su propia app, no una aproximación. */
const LIGHTS_GREEN_HOLD_MS = 3000;

let lightsTrackedState = "idle";
let lightsGreenUntil = 0;
let lightsGreenTimer = null;

function renderLights(lightState) {
  if (lightState === "green" && lightsTrackedState !== "green") {
    lightsGreenUntil = Date.now() + LIGHTS_GREEN_HOLD_MS;
    clearTimeout(lightsGreenTimer);
    lightsGreenTimer = setTimeout(applyLightsClass, LIGHTS_GREEN_HOLD_MS);
  }
  lightsTrackedState = lightState;
  applyLightsClass();
}

function applyLightsClass() {
  const box = $("lights");
  const sosteniendoVerde = lightsTrackedState === "green" && Date.now() < lightsGreenUntil;
  box.classList.toggle("formation", lightsTrackedState === "formation");
  box.classList.toggle("green", sosteniendoVerde);
}

// ===================================================================== indicador de sesión

/** Mismos tipos que `labelForSessionType` en `session/sessionInfo.ts`, resumidos a una letra para
 * la chapa. El título completo (`session.typeLabel`) es el que de verdad explica qué sesión es.
 * Carrera es "R" (de "race", como en cualquier livetiming) y no "C": "Q" de Clasificación ya
 * seguía esa misma convención, así que "R" le hacía juego. Reserva pasa a "RES" para no empatarle
 * la letra a Carrera. */
const SESSION_SHORT_LABELS = { 0: "RES", 1: "P", 2: "Q", 3: "R", 4: "H", 5: "TA", 6: "D", 7: "REP" };

/** `mm:ss.cc`, igual que un cronómetro de carrera, salvo que `ms` sea tan grande que ya no tenga
 * sentido mostrarlo así: una práctica que el servidor dejó corriendo horas (bug visto en
 * producción: "1277:21.41") pasa a mostrarse como lo hace un livetiming, "HH:MM:SS" o, pasado el
 * día, "N día(s) + HH:MM:SS". Sirve tanto para la cuenta regresiva como para el tiempo
 * transcurrido: la diferencia la pone `renderSessionIndicator`, no el formato. */
function formatClock(ms) {
  const totalCentisimos = Math.max(0, Math.round(ms / 10));
  const totalSegundos = Math.floor(totalCentisimos / 100);
  const totalHoras = Math.floor(totalSegundos / 3600);

  if (totalHoras >= 1) {
    const dias = Math.floor(totalHoras / 24);
    const horas = String(totalHoras % 24).padStart(2, "0");
    const minutos = String(Math.floor((totalSegundos % 3600) / 60)).padStart(2, "0");
    const segundos = String(totalSegundos % 60).padStart(2, "0");
    const reloj = horas + ":" + minutos + ":" + segundos;
    return dias >= 1 ? dias + (dias === 1 ? " día + " : " días + ") + reloj : reloj;
  }

  const centisimos = totalCentisimos % 100;
  const segundos = totalSegundos % 60;
  const minutos = Math.floor(totalSegundos / 60);
  return minutos + ":" + String(segundos).padStart(2, "0") + "." + String(centisimos).padStart(2, "0");
}

function renderSessionIndicator(session) {
  const typeEl = $("session-type");
  const clockEl = $("session-clock");

  if (!session) {
    typeEl.textContent = "--";
    typeEl.title = "Esperando el primer aviso de sesión del servidor.";
    delete typeEl.dataset.sessionType;
    clockEl.textContent = "--:--";
    clockEl.title = "";
    return;
  }

  typeEl.textContent = SESSION_SHORT_LABELS[session.sessionType] || "?";
  typeEl.dataset.sessionType = session.sessionType;
  typeEl.title = session.typeLabel;

  if (session.remainingMs !== null) {
    clockEl.textContent = formatClock(session.remainingMs);
    clockEl.title = "Tiempo restante de " + session.typeLabel.toLowerCase();
  } else if (session.laps > 0) {
    clockEl.textContent = session.laps + " vueltas";
    clockEl.title = "Sesión a " + session.laps + " vueltas, sin límite de tiempo.";
  } else {
    clockEl.textContent = formatClock(session.elapsedMs);
    clockEl.title = "Tiempo transcurrido de " + session.typeLabel.toLowerCase();
  }
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
  // "VERDE VERDE VERDE" por el chat a 20 pilotos que estaban girando tranquilos.
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
    $("start-hint").textContent = "";
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

  // Con la pestaña en segundo plano el navegador frena los `setInterval`: el poll puede tardar
  // muchísimo más que `POLL_MS` sin que el servidor haya cortado nada. Sin esta guarda, volver a
  // esta pestaña después de un rato mostraba "sin contacto" por una desconexión que nunca existió.
  if (document.hidden) {
    bar.hidden = true;
    document.body.classList.remove("link-down");
    return;
  }

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

  // La chapa de marca y el nombre de la liga se fueron del encabezado con el resto del header:
  // esta pantalla vive incrustada en fslmanager.vercel.app, que ya tiene los dos. El asistente de
  // primer arranque sigue necesitando el nombre, así que esa línea queda. La versión sí se pidió
  // de vuelta, pegada contra "Sanciones aplicadas".
  $("wizard-name").textContent = state.leagueName || "tu liga";
  $("panel-version").textContent = state.version ? "v" + state.version : "";

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
  renderLights(state.lightState);
  renderSessionIndicator(state.session);
  renderFinishedReport(state);
  // Los grupos de incidentes van antes de pintar la tabla: cada fila lee de ahí sus columnas de
  // Cuts/Insi y el contenido de su propio detalle.
  updateIncidentGroups(state.incidents || []);
  renderTiming(state.cars);
  renderNetwork(state.network);
  renderMode(state.shadowMode);
  renderPenalties(state.formationPenalties, state.pitPenalties, state.stewardPenalties);

  renderPitZoneSuggestion(state.pitZoneSuggestion || null);
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

  $("btn-copy-support").addEventListener("click", copiarMensajeDeSoporte);

  $("btn-embed-regenerate").addEventListener("click", async () => {
    if (!window.confirm("¿Regenerar el token del embed?\n\nEl código que ya hayas pegado en otra página deja de funcionar al instante.")) {
      return;
    }
    try {
      const data = await post("/api/embed-token/regenerate");
      embedToken = data.token;
      renderEmbedSnippet();
      toast("Token regenerado. Actualizá el código pegado en tu página.");
    } catch (err) {
      toast("No se pudo regenerar: " + err.message, 5000);
    }
  });

  $("btn-copy-embed-snippet").addEventListener("click", () => {
    const value = $("embed-snippet").value;
    if (!value) return;
    navigator.clipboard.writeText(value).then(
      () => toast("Código copiado. Pegalo en tu página."),
      () => toast("No se pudo copiar — seleccioná el texto a mano y copialo", 5000)
    );
  });

  $("chip-sin-app").addEventListener("click", () => openModal("modal-network"));

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

// Acá vivía `wireLogout`, el ícono de salir que cerraba la sesión del portal. Esta pantalla no
// tiene sesión que cerrar: vive incrustada en fslmanager.vercel.app sin login propio (ver el
// middleware `RC_PUBLIC_LEAGUE` en `portal/server.ts`). El panel completo de la rama main, que sí
// tiene login, conserva el botón intacto.

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

wireDrawers();
wireButtons();
wireProfiles();
setupForms();

loadConfigForm().catch((err) => toast("No se pudo cargar la configuración: " + err.message, 5000));
loadEmbedToken();
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

/** Al volver a esta pestaña (o a esta ventana) el dato que había puede tener minutos de atraso por
 * el freno de `setInterval` en segundo plano: en vez de esperar al próximo poll y mostrar la banda
 * roja un instante, se pide el estado de una y de inmediato. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  refresh().catch((err) => {
    lastPollError = err.message;
    renderLinkState();
  });
});

