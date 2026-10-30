/**
 * Embed de Race Control para una página ajena (ej. fslmanager.vercel.app).
 *
 * Código nuevo y chico a propósito, NO una porción recortada de `../app.js`: ese bundle asume ser
 * la página entera (`html,body{overflow:hidden}`, overlays `position:fixed` contra el viewport, un
 * router que hace `pushState` sobre la URL del host) y nada de eso funciona metido en un `<div>`
 * dentro del layout de otra página. Esta pantalla se autocontiene en el elemento que le pasen y no
 * toca nada fuera de él.
 *
 * Autenticación: un token Bearer leído de `data-token` en el propio `<script>`, no una cookie — la
 * cookie de sesión del panel es `SameSite=Strict` y no viaja en un `fetch` entre dominios distintos
 * aunque quisiera. Ver `security/embedToken.ts` para el esquema de firma y revocación.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) {
    console.error("[race-control-embed] No se pudo leer el propio <script>: hace falta un navegador con document.currentScript.");
    return;
  }

  var slug = script.getAttribute("data-slug");
  var token = script.getAttribute("data-token");
  var targetId = script.getAttribute("data-target") || "rc-embed";
  var root = document.getElementById(targetId);

  if (!root) {
    console.error('[race-control-embed] No encontré ningún elemento con id="' + targetId + '" en la página.');
    return;
  }
  if (!slug || !token) {
    root.textContent = "Falta data-slug o data-token en el <script> de Race Control.";
    return;
  }

  // Absoluta y no relativa a propósito: este script corre en el documento de OTRO dominio
  // (fslmanager.vercel.app), así que una ruta relativa resolvería contra ESE origen y no contra el
  // de Race Control. `script.src` es el único dato que tenemos de dónde vive de verdad este archivo.
  var origin = new URL(script.src, document.baseURI).origin;
  var API = origin + "/l/" + encodeURIComponent(slug) + "/api/embed";

  // El snippet que se pega en la página ajena es SOLO el div y este <script> — no le pedimos al
  // admin que agregue también un <link> de la hoja de estilos. Si todavía no está, se suma sola, al
  // lado de este mismo script. La marca evita duplicarla si el snippet aparece dos veces en la página.
  if (!document.querySelector('link[data-rc-embed-css="' + slug + '"]')) {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = origin + "/l/" + encodeURIComponent(slug) + "/embed/embed.css";
    link.setAttribute("data-rc-embed-css", slug);
    document.head.appendChild(link);
  }
  var POLL_MS = 1500;
  var RACE_SESSION_TYPE = 3; // Ver RACE_SESSION_TYPE en adminApi.ts: el tipo de sesión "carrera" del protocolo de AC.
  var ARM_MS = 4000; // Ventana del "¿Seguro?" antes de que una acción irreversible se desarme sola.

  var lastState = null;
  var armed = null; // { key, timer } — una sola acción armada a la vez, sea sanción o anulación.
  var pollTimer = null;

  // ------------------------------------------------------------------------------ armado del DOM

  root.innerHTML = "";
  root.className = "rc-embed";

  var banner = el("div", "rc-embed__banner");
  banner.hidden = true;

  var start = el("div", "rc-embed__start");
  var semaforo = el("div", "rc-embed__semaforo");
  var botones = el("div", "rc-embed__botones");
  var btnBegin = boton("Formación", function () { ejecutar("/formation/begin"); });
  var btnGreen = boton("Verde", function () { ejecutar("/formation/green"); });
  var btnReset = boton("Reiniciar", function () { ejecutar("/formation/reset"); }, "secondary");
  botones.appendChild(btnBegin);
  botones.appendChild(btnGreen);
  botones.appendChild(btnReset);
  var hint = el("span", "rc-embed__hint");
  start.appendChild(semaforo);
  start.appendChild(botones);
  start.appendChild(hint);

  var tablaWrap = el("div", "rc-embed__tabla-wrap");
  var tabla = document.createElement("table");
  tabla.className = "rc-embed__tabla";
  tabla.innerHTML =
    "<thead><tr><th>Piloto</th><th>Box</th><th>Combustible</th><th>Cortes</th><th>Incidentes</th></tr></thead><tbody></tbody>";
  var filas = tabla.querySelector("tbody");
  tablaWrap.appendChild(tabla);

  var sancionesTitulo = el("h3", "rc-embed__titulo");
  sancionesTitulo.textContent = "Sanciones aplicadas";
  var sancionesWrap = el("div", "rc-embed__tabla-wrap");
  var sancionesTabla = document.createElement("table");
  sancionesTabla.className = "rc-embed__tabla";
  sancionesTabla.innerHTML = "<thead><tr><th>Piloto</th><th>Sanción</th><th>Estado</th><th></th></tr></thead><tbody></tbody>";
  var sancionesFilas = sancionesTabla.querySelector("tbody");
  sancionesWrap.appendChild(sancionesTabla);
  var sancionesVacio = el("p", "rc-embed__vacio");
  sancionesVacio.textContent = "No hay sanciones aplicadas todavía.";

  root.appendChild(banner);
  root.appendChild(start);
  root.appendChild(tablaWrap);
  root.appendChild(sancionesTitulo);
  root.appendChild(sancionesWrap);
  root.appendChild(sancionesVacio);

  // --------------------------------------------------------------------------------------- red

  function pedido(path, opts) {
    opts = opts || {};
    var headers = { Authorization: "Bearer " + token };
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (res.status === 401) throw new Error("El token de este embed ya no vale. Pedile uno nuevo a quien administra Race Control.");
      if (res.status === 403) throw new Error("Este sitio no está autorizado para este embed todavía.");
      if (!res.ok) {
        return res
          .json()
          .catch(function () { return {}; })
          .then(function (j) {
            throw new Error((j && j.error) || "El servidor contestó " + res.status);
          });
      }
      return res.status === 204 ? null : res.json();
    });
  }

  function ejecutar(path, body) {
    return pedido(path, { method: "POST", body: body || {} }).then(
      function () { return refrescar(); },
      function (err) { mostrarError(err.message); }
    );
  }

  function refrescar() {
    return pedido("/state").then(
      function (state) {
        lastState = state;
        mostrarError(null);
        render(state);
      },
      function (err) { mostrarError(err.message); }
    );
  }

  function mostrarError(msg) {
    banner.hidden = !msg;
    if (msg) banner.textContent = msg;
  }

  // ------------------------------------------------------------------------------- utilidades DOM

  function el(tag, className) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    return e;
  }

  function boton(texto, onClick, variante) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "rc-embed__btn" + (variante ? " rc-embed__btn--" + variante : "");
    b.textContent = texto;
    b.addEventListener("click", onClick);
    return b;
  }

  /**
   * Botón de doble click para una acción irreversible: el primer click arma ("¿Seguro?") y el
   * segundo, dentro de `ARM_MS`, ejecuta. Mismo patrón que ya usa el panel completo para anular una
   * sanción o kickear a un piloto, y por el mismo motivo: esta tabla se vuelve a dibujar entera en
   * cada poll, así que un solo click sobre algo que avisa al piloto por chat es demasiado fácil de
   * apretar por error.
   */
  function botonConfirmacion(key, textoNormal, onConfirmar, variante) {
    var armadoAhora = armed !== null && armed.key === key;
    var b = boton(armadoAhora ? "¿Seguro?" : textoNormal, function () {
      if (armed && armed.key === key) {
        clearTimeout(armed.timer);
        armed = null;
        b.disabled = true;
        onConfirmar();
        return;
      }
      if (armed) clearTimeout(armed.timer);
      armed = { key: key, timer: setTimeout(function () { armed = null; if (lastState) render(lastState); }, ARM_MS) };
      if (lastState) render(lastState);
    }, armadoAhora ? "arming" : variante);
    return b;
  }

  function driverLabelByCarId(carId) {
    var cars = (lastState && lastState.cars) || [];
    for (var i = 0; i < cars.length; i++) if (cars[i].carId === carId) return cars[i].driverName || "Auto " + carId;
    return "Auto " + carId;
  }

  // -------------------------------------------------------------------------------- incidentes

  /** Título de los incidentes de un solo piloto. Calcado del mismo diccionario del panel completo
   * (`app.js`): es texto de presentación, duplicarlo acá es más simple que compartir un módulo
   * entre dos bundles que no tienen ningún otro motivo para depender uno del otro. */
  var INCIDENT_KIND_LABELS = {
    "env-collision": "choque en solitario",
    "track-limits": "límites de pista",
    "cut-lap": "se fue de pista",
    "telemetry-mismatch": "telemetría inconsistente",
    "wrong-way": "contramano",
    disconnect: "se desconectó en carrera",
    "pit-speeding": "exceso en pit lane",
    "formation-speeding": "exceso en la formación",
  };

  function tituloIncidente(incident, carId) {
    if (incident.kind === "car-contact") {
      var otro = incident.parties.filter(function (p) { return p.carId !== carId; })[0];
      return "Toque con " + (otro ? driverLabelByCarId(otro.carId) : "otro auto");
    }
    return INCIDENT_KIND_LABELS[incident.kind] || "incidente";
  }

  function renderIncidentesDeAuto(celda, car, incidentesPendientes) {
    celda.textContent = "";
    if (incidentesPendientes.length === 0) {
      celda.appendChild(document.createTextNode("—"));
      return;
    }
    incidentesPendientes.forEach(function (incident) {
      var card = el("div", "rc-embed__incidente");
      var texto = el("span", "rc-embed__incidente-texto");
      texto.textContent = tituloIncidente(incident, car.carId);
      var acciones = el("div", "rc-embed__incidente-botones");
      acciones.appendChild(boton("Descartar", function () { resolver(incident.id, "dismissed"); }, "secondary"));
      acciones.appendChild(boton("Advertir", function () { resolver(incident.id, "warned"); }, "secondary"));
      acciones.appendChild(
        botonConfirmacion(
          "sancionar:" + incident.id,
          "Sancionar (+5s)",
          function () { resolver(incident.id, "penalized", { penaltyType: "TIME", seconds: 5, carId: car.carId }); }
        )
      );
      card.appendChild(texto);
      card.appendChild(acciones);
      celda.appendChild(card);
    });
  }

  function resolver(incidentId, status, extra) {
    var body = Object.assign({ status: status }, extra || {});
    ejecutar("/incidents/" + encodeURIComponent(incidentId) + "/resolve", body);
  }

  // ----------------------------------------------------------------------------------- render

  var START_ACTIONS = {
    idle: { begin: true, green: false, reset: false },
    formation: { begin: false, green: true, reset: true },
    green: { begin: false, green: false, reset: true },
  };

  function renderStart(state) {
    var lightState = state.lightState;
    semaforo.className = "rc-embed__semaforo rc-embed__semaforo--" + lightState;
    var labels = { idle: "Esperando", formation: "Formación", green: "VERDE" };
    semaforo.textContent = labels[lightState] || lightState;

    var esCarrera = !state.session || state.session.sessionType === RACE_SESSION_TYPE;
    var allowed = START_ACTIONS[lightState] || START_ACTIONS.idle;
    btnBegin.disabled = !allowed.begin || !esCarrera;
    btnGreen.disabled = !allowed.green || !esCarrera;
    btnReset.disabled = !allowed.reset;

    if (!esCarrera) {
      hint.textContent = "El servidor no está en una sesión de carrera.";
      return;
    }
    var hints = {
      idle: "Arrancá la formación cuando la parrilla esté completa.",
      formation: "Control de velocidad activo. Dale verde cuando la fila esté ordenada.",
      green: "Carrera en marcha.",
    };
    hint.textContent = hints[lightState] || "";
  }

  function renderTabla(state) {
    filas.textContent = "";
    var pendientes = state.incidents.filter(function (i) { return i.status === "pending"; });

    state.cars.forEach(function (car) {
      var tr = document.createElement("tr");
      tr.className = "rc-embed__fila" + (car.connected === false ? " rc-embed__fila--desconectado" : "");

      var nombre = document.createElement("td");
      nombre.textContent = car.driverName || "Auto " + car.carId;
      tr.appendChild(nombre);

      var box = document.createElement("td");
      if (!car.telemetry || car.telemetry.pitStops === null || car.telemetry.pitStops === undefined) {
        box.textContent = "—";
        box.title = "Sin la app del piloto";
      } else {
        box.textContent = car.telemetry.inPitLane ? car.telemetry.pitStops + " · PIT" : String(car.telemetry.pitStops);
      }
      tr.appendChild(box);

      var combustible = document.createElement("td");
      combustible.textContent =
        car.telemetry && car.telemetry.fuelLiters !== null && car.telemetry.fuelLiters !== undefined
          ? car.telemetry.fuelLiters.toFixed(1) + " L"
          : "—";
      tr.appendChild(combustible);

      var cortes = document.createElement("td");
      cortes.textContent = String(car.cuts || 0);
      tr.appendChild(cortes);

      var incidentesCelda = document.createElement("td");
      var deEsteAuto = pendientes.filter(function (i) {
        return i.parties.some(function (p) { return p.carId === car.carId; });
      });
      renderIncidentesDeAuto(incidentesCelda, car, deEsteAuto);
      tr.appendChild(incidentesCelda);

      filas.appendChild(tr);
    });
  }

  var ENGINE_LABELS = { formation: "Largada", pit: "Pit lane", steward: "Comisario" };
  var PENALTY_TYPE_LABELS = { DT: "Drive-Through", SG: "Stop & Go", BALLAST: "Lastre", TIME: "Tiempo" };
  var PENALTY_STATUS_LABELS = {
    servingWindow: "pendiente",
    served: "cumplida",
    escalated: "escalada",
    revoked: "anulada",
  };

  function renderSanciones(state) {
    var todas = []
      .concat(state.formationPenalties.map(function (p) { return Object.assign({ engine: "formation" }, p); }))
      .concat(state.pitPenalties.map(function (p) { return Object.assign({ engine: "pit" }, p); }))
      .concat(state.stewardPenalties.map(function (p) { return Object.assign({ engine: "steward" }, p); }))
      .sort(function (a, b) { return b.createdAt - a.createdAt; });

    sancionesVacio.hidden = todas.length > 0;
    sancionesWrap.hidden = todas.length === 0;
    sancionesFilas.textContent = "";

    todas.forEach(function (p) {
      var tr = document.createElement("tr");
      var piloto = document.createElement("td");
      piloto.textContent = driverLabelByCarId(p.carId) + " (" + (ENGINE_LABELS[p.engine] || p.engine) + ")";
      tr.appendChild(piloto);

      var detalle = document.createElement("td");
      var tipo = p.type === "TIME" ? "+" + p.timePenaltySeconds + "s" : PENALTY_TYPE_LABELS[p.type] || p.type;
      detalle.textContent = tipo + " — " + p.reason;
      tr.appendChild(detalle);

      var estado = document.createElement("td");
      var badge = el("span", "rc-embed__badge rc-embed__badge--" + p.status);
      badge.textContent = PENALTY_STATUS_LABELS[p.status] || p.status;
      estado.appendChild(badge);
      tr.appendChild(estado);

      var acciones = document.createElement("td");
      if (p.status !== "revoked") {
        acciones.appendChild(
          botonConfirmacion("revocar:" + p.id, "Anular", function () { ejecutar("/penalties/" + encodeURIComponent(p.id) + "/revoke"); }, "secondary")
        );
      }
      tr.appendChild(acciones);

      sancionesFilas.appendChild(tr);
    });
  }

  function render(state) {
    renderStart(state);
    renderTabla(state);
    renderSanciones(state);
  }

  // ----------------------------------------------------------------------------------- arranque

  function poll() {
    refrescar().then(function () {
      pollTimer = setTimeout(poll, POLL_MS);
    });
  }
  poll();
})();
