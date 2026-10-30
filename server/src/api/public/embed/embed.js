/**
 * Embed de Race Control para una página ajena (ej. fslmanager.vercel.app).
 *
 * Código nuevo y chico a propósito, NO una porción recortada de `../app.js`: ese bundle asume ser
 * la página entera (`html,body{overflow:hidden}`, overlays `position:fixed` contra el viewport, un
 * router que hace `pushState` sobre la URL del host) y nada de eso funciona metido en un `<div>`
 * dentro del layout de otra página. Esta pantalla se autocontiene en el elemento que le pasen y no
 * toca nada fuera de él — los dos modales nuevos (Conexión y Reglas) también se montan DENTRO de
 * ese elemento, no en `document.body`, aunque usen `position: fixed` para taparlo todo.
 *
 * Autenticación: un token Bearer leído de `data-token` en el propio `<script>`, no una cookie — la
 * cookie de sesión del panel es `SameSite=Strict` y no viaja en un `fetch` entre dominios distintos
 * aunque quisiera. Ver `security/embedToken.ts` para el esquema de firma y revocación.
 *
 * Fase 2: este token ya no sirve solo para accionar sobre la carrera en curso. Reglas y Conexión se
 * portaron enteros (duplicados, no compartidos con `app.js` — ver el plan "Ampliar el embed de
 * fslmanager.vercel.app"), así que el mismo token también puede leer y cambiar la configuración de
 * la liga. Es una decisión tomada y aceptada, no un descuido: ver `CHANGELOG.md`.
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
  var catalog = null; // /catalog del canal embed. Null hasta que responde.
  var pitZoneSuggestion = null;

  // ------------------------------------------------------------------------------ armado del DOM

  root.innerHTML = "";
  root.className = "rc-embed";

  var banner = el("div", "rc-embed__banner");
  banner.hidden = true;

  // Conexión y Reglas quedan siempre a la vista, no solo cuando hay algo pendiente: son los dos
  // cajones que antes solo existían en el panel completo, y el pedido explícito fue poder abrirlos
  // sin salir de la página donde está incrustado el embed.
  var topbar = el("div", "rc-embed__topbar");
  var btnConexion = boton("Conexión", function () { abrirModal(modalConexionBackdrop); }, "secondary");
  var btnReglas = boton("Reglas", function () { abrirModal(modalReglasBackdrop); }, "secondary");
  topbar.appendChild(btnConexion);
  topbar.appendChild(btnReglas);

  var start = el("div", "rc-embed__start");

  var sessionIndicator = el("div", "rc-embed__session");
  var sessionType = el("span", "rc-embed__session-type");
  sessionType.textContent = "--";
  var sessionClock = el("span", "rc-embed__session-clock");
  sessionClock.textContent = "--:--";
  sessionIndicator.appendChild(sessionType);
  sessionIndicator.appendChild(sessionClock);

  // Los 5 discos replican lo que ve el piloto en su propia app (ver `renderLights` más abajo); el
  // texto al lado es el mismo estado en palabras, para quien no los vea o prefiera leerlo.
  var lightsWrap = el("div", "rc-embed__lights-wrap");
  var lights = el("div", "rc-embed__lights");
  for (var i = 0; i < 5; i++) lights.appendChild(el("span", "rc-embed__light"));
  var semaforo = el("span", "rc-embed__semaforo");
  lightsWrap.appendChild(lights);
  lightsWrap.appendChild(semaforo);

  var botones = el("div", "rc-embed__botones");
  var btnBegin = boton("Formación", function () { ejecutar("/formation/begin"); });
  var btnGreen = boton("Verde", function () { ejecutar("/formation/green"); });
  var btnReset = boton("Reiniciar", function () { ejecutar("/formation/reset"); }, "secondary");
  botones.appendChild(btnBegin);
  botones.appendChild(btnGreen);
  botones.appendChild(btnReset);
  var hint = el("span", "rc-embed__hint");

  start.appendChild(sessionIndicator);
  start.appendChild(lightsWrap);
  start.appendChild(botones);
  start.appendChild(hint);

  var tablaWrap = el("div", "rc-embed__tabla-wrap");
  var tabla = document.createElement("table");
  tabla.className = "rc-embed__tabla";
  tabla.innerHTML =
    "<thead><tr><th>Auto</th><th>Piloto</th><th>Velocidad</th><th>Box</th><th>Combustible</th><th>Cortes</th><th>Acciones</th></tr></thead><tbody></tbody>";
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

  // ------------------------------------------------------------------- modal: conexión (reducido)

  /**
   * Del cajón completo de Conexión solo entran Estado, Modo de funcionamiento y ¿Algo anda mal?.
   * "Cómo conectar tu servidor" es un paso de alta inicial que no se mira día a día, y "Embed en
   * otra página" es circular: el token ya expuesto no puede ser el que regenera o expone el suyo
   * propio. Tampoco viaja la IP real en ningún texto — ver `redactForEmbed` y
   * `redactChecksForEmbed` en adminApi.ts.
   */
  var modalConexionBackdrop = el("div", "rc-embed__modal-backdrop");
  modalConexionBackdrop.hidden = true;
  var modalConexion = el("div", "rc-embed__modal");
  var headerConexion = el("div", "rc-embed__modal-header");
  var tituloConexion = document.createElement("h2");
  tituloConexion.textContent = "Conexión";
  var btnCerrarConexion = boton("×", function () { cerrarModal(modalConexionBackdrop); }, "cerrar");
  headerConexion.appendChild(tituloConexion);
  headerConexion.appendChild(btnCerrarConexion);
  modalConexion.appendChild(headerConexion);

  var seccionEstado = el("section", "rc-embed__modal-seccion");
  var h3Estado = document.createElement("h3");
  h3Estado.textContent = "Estado";
  var filaIp = filaEstado("La dirección de tu liga");
  var filaSignal = filaEstado("Señal del servidor de AC");
  var filaAc = filaEstado("Comandos salen hacia");
  var filaDrivers = filaEstado("Pilotos con la app reportando");
  var valorIp = filaIp.valor;
  var valorSignal = filaSignal.valor;
  var valorAc = filaAc.valor;
  var valorDrivers = filaDrivers.valor;
  seccionEstado.appendChild(h3Estado);
  seccionEstado.appendChild(filaIp.row);
  seccionEstado.appendChild(filaSignal.row);
  seccionEstado.appendChild(filaAc.row);
  seccionEstado.appendChild(filaDrivers.row);

  var seccionModo = el("section", "rc-embed__modal-seccion");
  var h3Modo = document.createElement("h3");
  h3Modo.textContent = "Modo de funcionamiento";
  var modoSwitch = el("label", "rc-embed__mode-switch");
  var modoInput = document.createElement("input");
  modoInput.type = "checkbox";
  var modoTrack = el("span", "rc-embed__mode-track");
  var modoLabel = el("span", "rc-embed__mode-label");
  modoLabel.textContent = "--";
  modoSwitch.appendChild(modoInput);
  modoSwitch.appendChild(modoTrack);
  modoSwitch.appendChild(modoLabel);
  var ayudaModo = document.createElement("p");
  ayudaModo.className = "rc-embed__hint";
  ayudaModo.textContent =
    "En modo sombra el sistema mira, detecta y anota todo, pero no sanciona ni expulsa a nadie de verdad.";
  seccionModo.appendChild(h3Modo);
  seccionModo.appendChild(modoSwitch);
  seccionModo.appendChild(ayudaModo);

  modoInput.addEventListener("change", function () {
    var shadowMode = !modoInput.checked;
    pedido("/config", { method: "POST", body: { shadowMode: shadowMode } }).then(
      function () { avisoConexion("", false); },
      function (err) {
        modoInput.checked = !modoInput.checked;
        avisoConexion("No se pudo guardar: " + err.message, true);
      }
    );
  });

  var seccionCheck = el("section", "rc-embed__modal-seccion");
  var h3Check = document.createElement("h3");
  h3Check.textContent = "¿Algo anda mal?";
  var ayudaCheck = document.createElement("p");
  ayudaCheck.className = "rc-embed__hint";
  ayudaCheck.textContent = "Revisa las cuatro cosas que tienen que funcionar y te dice qué hacer con la que falle.";
  var btnRevisar = boton("Revisar ahora", undefined, "secondary");
  var checksBox = el("div", "rc-embed__checks");
  seccionCheck.appendChild(h3Check);
  seccionCheck.appendChild(ayudaCheck);
  seccionCheck.appendChild(btnRevisar);
  seccionCheck.appendChild(checksBox);

  btnRevisar.addEventListener("click", function () {
    btnRevisar.disabled = true;
    btnRevisar.textContent = "Probando...";
    pedido("/network/test", { method: "POST" }).then(
      function (data) {
        renderChecksInto(checksBox, data.checks);
        btnRevisar.disabled = false;
        btnRevisar.textContent = "Revisar de nuevo";
      },
      function (err) {
        btnRevisar.disabled = false;
        btnRevisar.textContent = "Revisar ahora";
        avisoConexion("No se pudo probar: " + err.message, true);
      }
    );
  });

  var conexionAviso = el("p", "rc-embed__modal-aviso");
  conexionAviso.hidden = true;

  modalConexion.appendChild(seccionEstado);
  modalConexion.appendChild(seccionModo);
  modalConexion.appendChild(seccionCheck);
  modalConexion.appendChild(conexionAviso);
  modalConexionBackdrop.appendChild(modalConexion);
  modalConexionBackdrop.addEventListener("click", function (e) {
    if (e.target === modalConexionBackdrop) cerrarModal(modalConexionBackdrop);
  });

  // ------------------------------------------------------------------------- modal: reglas (completo)

  /**
   * Las 5 pestañas de siempre, duplicadas de `app.js` a propósito (ver el comentario del
   * encabezado). Lo único que no entra es la pestaña "Liga" (no existe tampoco en el panel
   * incrustado) y el campo `embed.allowedOrigin`: `stripEmbedManagedFields` en adminApi.ts lo
   * descarta de cualquier patch que llegue por este canal, así que ni siquiera se dibuja un campo
   * para él acá.
   */
  var modalReglasBackdrop = el("div", "rc-embed__modal-backdrop");
  modalReglasBackdrop.hidden = true;
  var modalReglas = el("div", "rc-embed__modal rc-embed__modal--tabs");
  var headerReglas = el("div", "rc-embed__modal-header");
  var tituloReglas = document.createElement("h2");
  tituloReglas.textContent = "Reglas";
  var btnCerrarReglas = boton("×", function () { cerrarModal(modalReglasBackdrop); }, "cerrar");
  headerReglas.appendChild(tituloReglas);
  headerReglas.appendChild(btnCerrarReglas);
  modalReglas.appendChild(headerReglas);

  var tabsBar = el("div", "rc-embed__tabs");
  var tabPerfiles = botonTab("Perfiles");
  var tabApp = botonTab("App pilotos");
  var tabLargada = botonTab("Largada");
  var tabPista = botonTab("Pista");
  var tabPit = botonTab("Pit lane");
  tabsBar.appendChild(tabPerfiles);
  tabsBar.appendChild(tabApp);
  tabsBar.appendChild(tabLargada);
  tabsBar.appendChild(tabPista);
  tabsBar.appendChild(tabPit);

  var panelPerfiles = el("div", "rc-embed__tab-panel");
  var panelApp = el("div", "rc-embed__tab-panel");
  panelApp.hidden = true;
  var panelLargada = el("div", "rc-embed__tab-panel");
  panelLargada.hidden = true;
  var panelPista = el("div", "rc-embed__tab-panel");
  panelPista.hidden = true;
  var panelPit = el("div", "rc-embed__tab-panel");
  panelPit.hidden = true;

  var PESTANAS_REGLAS = [
    { boton: tabPerfiles, panel: panelPerfiles },
    { boton: tabApp, panel: panelApp },
    { boton: tabLargada, panel: panelLargada },
    { boton: tabPista, panel: panelPista },
    { boton: tabPit, panel: panelPit },
  ];
  PESTANAS_REGLAS.forEach(function (par) {
    par.boton.addEventListener("click", function () {
      PESTANAS_REGLAS.forEach(function (otro) {
        otro.boton.setAttribute("aria-selected", String(otro === par));
        otro.boton.classList.toggle("rc-embed__tab--activa", otro === par);
        otro.panel.hidden = otro !== par;
      });
    });
  });
  tabPerfiles.setAttribute("aria-selected", "true");
  tabPerfiles.classList.add("rc-embed__tab--activa");

  // -- Perfiles --
  var tituloPerfiles = document.createElement("h3");
  tituloPerfiles.textContent = "Perfiles de carrera";
  var ayudaPerfiles = document.createElement("p");
  ayudaPerfiles.className = "rc-embed__hint";
  ayudaPerfiles.textContent = "Un perfil guarda todas las reglas de este modal de una vez, con el nombre que le pongas.";
  var selectPerfil = document.createElement("select");
  var btnCargarPerfil = boton("Cargar", undefined, "secondary");
  var btnBorrarPerfil = boton("Borrar", undefined, "secondary");
  btnBorrarPerfil.classList.add("rc-embed__btn--peligro");
  var accionesPerfil = el("div", "rc-embed__profile-actions");
  accionesPerfil.appendChild(btnCargarPerfil);
  accionesPerfil.appendChild(btnBorrarPerfil);
  var campoNombrePerfil = document.createElement("input");
  campoNombrePerfil.type = "text";
  campoNombrePerfil.maxLength = 60;
  campoNombrePerfil.placeholder = "Endurance";
  var btnGuardarPerfil = boton("Guardar como perfil", undefined);
  var perfilVacioMsg = document.createElement("p");
  perfilVacioMsg.className = "rc-embed__hint";
  perfilVacioMsg.textContent = "Todavía no guardaste ningún perfil.";

  panelPerfiles.appendChild(tituloPerfiles);
  panelPerfiles.appendChild(ayudaPerfiles);
  panelPerfiles.appendChild(filaCampo("Cargar un perfil", selectPerfil));
  panelPerfiles.appendChild(accionesPerfil);
  panelPerfiles.appendChild(filaCampo("Guardar lo que está puesto como", campoNombrePerfil));
  panelPerfiles.appendChild(btnGuardarPerfil);
  panelPerfiles.appendChild(perfilVacioMsg);

  // -- App pilotos --
  var campoPrEnforce = campoCheckbox();
  var campoPrGrace = campoNumero();
  campoPrGrace.min = "10";
  var btnGuardarPresence = boton("Guardar", undefined);
  var tituloApp = document.createElement("h3");
  tituloApp.textContent = "App de los pilotos";
  var ayudaApp = document.createElement("p");
  ayudaApp.className = "rc-embed__hint";
  ayudaApp.textContent =
    "Con esto activado, el piloto que entre sin la app instalada es expulsado del servidor pasado ese tiempo.";
  panelApp.appendChild(tituloApp);
  panelApp.appendChild(filaCampo("Exigir que todos la tengan", campoPrEnforce));
  panelApp.appendChild(filaCampo("Tiempo de espera antes de expulsar (s)", campoPrGrace));
  panelApp.appendChild(ayudaApp);
  panelApp.appendChild(btnGuardarPresence);

  // -- Largada --
  var campoFThreshold = campoNumero();
  var campoFTolerance = campoNumero();
  var campoFGrace = campoNumero();
  var campoFPenaltyType = selectSancion();
  var campoFEscalation = selectEscalacion();
  var campoFTimePenalty = campoNumero();
  campoFTimePenalty.min = "1";
  campoFTimePenalty.max = "600";
  var filaFTimePenalty = filaCampo("Segundos de penalización", campoFTimePenalty);
  filaFTimePenalty.hidden = true;
  var btnGuardarFormation = boton("Guardar", undefined);
  var tituloLargada = document.createElement("h3");
  tituloLargada.textContent = "Largada (vuelta de formación)";
  panelLargada.appendChild(tituloLargada);
  panelLargada.appendChild(filaCampo("Velocidad máxima (km/h)", campoFThreshold));
  panelLargada.appendChild(filaCampo("Tolerancia (s)", campoFTolerance));
  panelLargada.appendChild(filaCampo("Vueltas para cumplirla", campoFGrace));
  panelLargada.appendChild(filaCampo("Sanción", campoFPenaltyType));
  panelLargada.appendChild(filaCampo("Si no la cumple", campoFEscalation));
  panelLargada.appendChild(filaFTimePenalty);
  panelLargada.appendChild(btnGuardarFormation);

  campoFEscalation.addEventListener("change", function () {
    filaFTimePenalty.hidden = campoFEscalation.value !== "TIME_PENALTY";
  });

  // -- Pista --
  var tituloPista = document.createElement("h3");
  tituloPista.textContent = "Qué se controla en pista";
  var ayudaPista = document.createElement("p");
  ayudaPista.className = "rc-embed__hint";
  ayudaPista.textContent =
    'Para cada cosa decidís qué pasa cuando ocurre. "Solo registrar" la deja anotada sin molestarte durante la carrera; "mandar a revisar" la manda a la bandeja de sanciones.';
  var infraccionesList = el("div", "rc-embed__infracciones-list");
  var btnGuardarInfracciones = boton("Guardar", undefined);
  panelPista.appendChild(tituloPista);
  panelPista.appendChild(ayudaPista);
  panelPista.appendChild(infraccionesList);
  panelPista.appendChild(btnGuardarInfracciones);
  var camposInfracciones = {};

  // -- Pit lane --
  var zoneSuggestionBox = document.createElement("p");
  zoneSuggestionBox.className = "rc-embed__hint";
  zoneSuggestionBox.hidden = true;
  zoneSuggestionBox.appendChild(document.createTextNode("Calibración automática para este circuito: "));
  var zoneSuggestionValue = document.createElement("span");
  zoneSuggestionBox.appendChild(zoneSuggestionValue);
  zoneSuggestionBox.appendChild(document.createTextNode(". "));
  var btnUsarCalibracion = boton("Usar esta calibración", undefined, "secondary");
  zoneSuggestionBox.appendChild(btnUsarCalibracion);

  var campoPZoneStart = campoNumero();
  campoPZoneStart.step = "0.001";
  campoPZoneStart.min = "0";
  campoPZoneStart.max = "1";
  var campoPZoneEnd = campoNumero();
  campoPZoneEnd.step = "0.001";
  campoPZoneEnd.min = "0";
  campoPZoneEnd.max = "1";
  var campoPThreshold = campoNumero();
  var campoPTolerance = campoNumero();
  var campoPGrace = campoNumero();
  var campoPStopGo = campoNumero();
  var campoPPenaltyType = selectSancion();
  var campoPEscalation = selectEscalacion();
  var campoPTimePenalty = campoNumero();
  campoPTimePenalty.min = "1";
  campoPTimePenalty.max = "600";
  var filaPTimePenalty = filaCampo("Segundos de penalización", campoPTimePenalty);
  filaPTimePenalty.hidden = true;
  var btnGuardarPit = boton("Guardar", undefined);
  var tituloPit = document.createElement("h3");
  tituloPit.textContent = "Pit lane (durante la carrera)";
  panelPit.appendChild(tituloPit);
  panelPit.appendChild(zoneSuggestionBox);
  panelPit.appendChild(filaCampo("Zona de pit — inicio", campoPZoneStart));
  panelPit.appendChild(filaCampo("Zona de pit — fin", campoPZoneEnd));
  panelPit.appendChild(filaCampo("Velocidad legal (km/h)", campoPThreshold));
  panelPit.appendChild(filaCampo("Tolerancia (s)", campoPTolerance));
  panelPit.appendChild(filaCampo("Vueltas para cumplirla", campoPGrace));
  panelPit.appendChild(filaCampo("Duración del Stop-and-Go (s)", campoPStopGo));
  panelPit.appendChild(filaCampo("Sanción", campoPPenaltyType));
  panelPit.appendChild(filaCampo("Si no la cumple", campoPEscalation));
  panelPit.appendChild(filaPTimePenalty);
  panelPit.appendChild(btnGuardarPit);

  campoPEscalation.addEventListener("change", function () {
    filaPTimePenalty.hidden = campoPEscalation.value !== "TIME_PENALTY";
  });
  btnUsarCalibracion.addEventListener("click", function () {
    if (!pitZoneSuggestion) return;
    campoPZoneStart.value = pitZoneSuggestion.splineStart.toFixed(3);
    campoPZoneEnd.value = pitZoneSuggestion.splineEnd.toFixed(3);
    refrescarBotonReglas("pit");
    guardarFormReglas("pit");
  });

  registrarFormReglas(
    "formation",
    btnGuardarFormation,
    [campoFThreshold, campoFTolerance, campoFGrace, campoFPenaltyType, campoFEscalation, campoFTimePenalty],
    buildFormationPayload
  );
  registrarFormReglas(
    "pit",
    btnGuardarPit,
    [campoPZoneStart, campoPZoneEnd, campoPThreshold, campoPTolerance, campoPGrace, campoPStopGo, campoPPenaltyType, campoPEscalation, campoPTimePenalty],
    buildPitPayload
  );
  registrarFormReglas("presence", btnGuardarPresence, [campoPrEnforce, campoPrGrace], buildPresencePayload);
  wireProfiles();

  var reglasAviso = el("p", "rc-embed__modal-aviso");
  reglasAviso.hidden = true;

  modalReglas.appendChild(tabsBar);
  modalReglas.appendChild(panelPerfiles);
  modalReglas.appendChild(panelApp);
  modalReglas.appendChild(panelLargada);
  modalReglas.appendChild(panelPista);
  modalReglas.appendChild(panelPit);
  modalReglas.appendChild(reglasAviso);
  modalReglasBackdrop.appendChild(modalReglas);
  modalReglasBackdrop.addEventListener("click", function (e) {
    if (e.target === modalReglasBackdrop) cerrarModal(modalReglasBackdrop);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    cerrarModal(modalConexionBackdrop);
    cerrarModal(modalReglasBackdrop);
  });

  root.appendChild(banner);
  root.appendChild(topbar);
  root.appendChild(start);
  root.appendChild(tablaWrap);
  root.appendChild(sancionesTitulo);
  root.appendChild(sancionesWrap);
  root.appendChild(sancionesVacio);
  root.appendChild(modalConexionBackdrop);
  root.appendChild(modalReglasBackdrop);

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
    if (onClick) b.addEventListener("click", onClick);
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

  // ------------------------------------------------------------------------------------- modales

  function abrirModal(backdrop) {
    backdrop.hidden = false;
  }

  function cerrarModal(backdrop) {
    backdrop.hidden = true;
  }

  function filaEstado(etiquetaTexto) {
    var row = el("div", "rc-embed__row");
    var etiqueta = document.createElement("span");
    etiqueta.textContent = etiquetaTexto;
    var valor = document.createElement("span");
    row.appendChild(etiqueta);
    row.appendChild(valor);
    return { row: row, valor: valor };
  }

  function filaCampo(labelTexto, control) {
    var row = el("div", "rc-embed__row");
    var label = document.createElement("label");
    label.textContent = labelTexto;
    row.appendChild(label);
    row.appendChild(control);
    return row;
  }

  function campoNumero() {
    var input = document.createElement("input");
    input.type = "number";
    return input;
  }

  function campoCheckbox() {
    var input = document.createElement("input");
    input.type = "checkbox";
    return input;
  }

  function selectSancion() {
    var select = document.createElement("select");
    [
      ["DT", "Drive-Through (pasar por pits)"],
      ["SG", "Stop-and-Go (parar en pits)"],
      ["BALLAST", "Lastre (peso extra)"],
    ].forEach(function (pair) {
      var o = document.createElement("option");
      o.value = pair[0];
      o.textContent = pair[1];
      select.appendChild(o);
    });
    return select;
  }

  function selectEscalacion() {
    var select = document.createElement("select");
    [
      ["DQ", "Expulsar de la carrera"],
      ["TIME_PENALTY", "Penalización de tiempo"],
    ].forEach(function (pair) {
      var o = document.createElement("option");
      o.value = pair[0];
      o.textContent = pair[1];
      select.appendChild(o);
    });
    return select;
  }

  function botonTab(texto) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "rc-embed__tab";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", "false");
    b.textContent = texto;
    return b;
  }

  function avisoConexion(mensaje, esError) {
    conexionAviso.textContent = mensaje;
    conexionAviso.hidden = !mensaje;
    conexionAviso.classList.toggle("rc-embed__modal-aviso--error", Boolean(esError));
  }

  function avisoReglas(mensaje, esError) {
    reglasAviso.textContent = mensaje;
    reglasAviso.hidden = !mensaje;
    reglasAviso.classList.toggle("rc-embed__modal-aviso--error", Boolean(esError));
  }

  var CHECK_LABELS = { ok: "Bien", warn: "Atención", fail: "Falla", pending: "Esperando" };

  function renderChecksInto(box, checks) {
    box.textContent = "";
    checks.forEach(function (check) {
      var item = el("div", "rc-embed__check rc-embed__check--" + check.state);
      var head = el("div", "rc-embed__check-head");
      var title = document.createElement("strong");
      title.textContent = check.title;
      var estadoSpan = document.createElement("span");
      estadoSpan.textContent = CHECK_LABELS[check.state] || check.state;
      head.appendChild(title);
      head.appendChild(estadoSpan);
      item.appendChild(head);

      var detail = document.createElement("p");
      detail.textContent = check.detail;
      item.appendChild(detail);

      if (check.action) {
        var action = document.createElement("p");
        action.className = "rc-embed__check-action";
        action.textContent = check.action;
        item.appendChild(action);
      }
      box.appendChild(item);
    });
  }

  function renderConexionEstado(state) {
    var network = state.network || {};

    valorIp.textContent = network.publicIpConfigured ? "Configurada" : "Sin configurar";
    valorIp.className = network.publicIpConfigured ? "rc-embed__valor--ok" : "rc-embed__valor--bad";

    valorSignal.textContent = network.receivingTelemetry ? "recibiendo" : "sin señal todavía";
    valorSignal.className = "";

    valorAc.textContent = network.commandTargetKnown ? "Configurado" : "esperando la primera señal...";
    valorAc.className = !network.commandTargetKnown && network.receivingTelemetry ? "rc-embed__valor--bad" : "";

    var d = network.driversReporting || { reporting: 0, connected: 0 };
    valorDrivers.textContent = d.connected === 0 ? "nadie conectado todavía" : d.reporting + " de " + d.connected;
    valorDrivers.className = d.connected > 0 && d.reporting === 0 ? "rc-embed__valor--bad" : "";

    if (document.activeElement !== modoInput) modoInput.checked = !state.shadowMode;
    modoSwitch.classList.toggle("rc-embed__mode-switch--shadow", Boolean(state.shadowMode));
    modoSwitch.classList.toggle("rc-embed__mode-switch--live", !state.shadowMode);
    modoLabel.textContent = state.shadowMode ? "Modo sombra" : "Sancionando";
  }

  // -------------------------------------------------------------------- formularios de Reglas

  var reglasForms = {};

  function registrarFormReglas(nombre, botonGuardar, elementos, buildPayload) {
    var form = { boton: botonGuardar, elementos: elementos, buildPayload: buildPayload, guardado: null };
    reglasForms[nombre] = form;
    elementos.forEach(function (elemento) {
      elemento.addEventListener("input", function () { refrescarBotonReglas(nombre); });
      elemento.addEventListener("change", function () { refrescarBotonReglas(nombre); });
    });
    botonGuardar.addEventListener("click", function () { guardarFormReglas(nombre); });
  }

  function firmaFormReglas(form) {
    return JSON.stringify(
      form.elementos.map(function (elemento) {
        return elemento.type === "checkbox" ? elemento.checked : elemento.value;
      })
    );
  }

  function marcarFormReglasGuardado(nombre) {
    var form = reglasForms[nombre];
    form.guardado = firmaFormReglas(form);
    refrescarBotonReglas(nombre);
  }

  function refrescarBotonReglas(nombre) {
    var form = reglasForms[nombre];
    var limpio = form.guardado !== null && form.guardado === firmaFormReglas(form);
    form.boton.disabled = limpio;
    form.boton.textContent = limpio ? "Guardado" : "Guardar";
  }

  function guardarFormReglas(nombre) {
    var form = reglasForms[nombre];
    pedido("/config", { method: "POST", body: form.buildPayload() }).then(
      function () {
        marcarFormReglasGuardado(nombre);
        avisoReglas("", false);
      },
      function (err) { avisoReglas("No se pudo guardar: " + err.message, true); }
    );
  }

  function buildFormationPayload() {
    return {
      formation: {
        penalty: {
          speedThresholdKmh: Number(campoFThreshold.value),
          toleranceSeconds: Number(campoFTolerance.value),
          graceLaps: Number(campoFGrace.value),
          penaltyType: campoFPenaltyType.value,
          escalation: campoFEscalation.value,
          timePenaltySeconds: Number(campoFTimePenalty.value),
        },
      },
    };
  }

  function buildPitPayload() {
    return {
      pit: {
        zone: { splineStart: Number(campoPZoneStart.value), splineEnd: Number(campoPZoneEnd.value) },
        stopGoSeconds: Number(campoPStopGo.value),
        penalty: {
          speedThresholdKmh: Number(campoPThreshold.value),
          toleranceSeconds: Number(campoPTolerance.value),
          graceLaps: Number(campoPGrace.value),
          penaltyType: campoPPenaltyType.value,
          escalation: campoPEscalation.value,
          timePenaltySeconds: Number(campoPTimePenalty.value),
        },
      },
    };
  }

  function buildPresencePayload() {
    return { presence: { enforce: campoPrEnforce.checked, graceSeconds: Number(campoPrGrace.value) } };
  }

  function buildInfractionsPayload() {
    var infractions = {};
    Object.keys(camposInfracciones).forEach(function (type) {
      var campos = camposInfracciones[type];
      var spec = INFRACTION_UI[type];
      var rule = { action: campos.action.value };
      spec.fields.forEach(function (field) {
        var control = campos.fields[field.key];
        rule[field.key] = field.type === "checkbox" ? control.checked : Number(control.value);
      });
      infractions[type] = rule;
    });
    return { infractions: infractions };
  }

  // ----------------------------------------------------------------- catálogo de infracciones

  /** Cómo se presenta cada tipo de infracción. Calcado de `INFRACTION_UI` en `app.js`: ver el
   * comentario de ese archivo para por qué la lista de acciones NO se duplica acá (viene del
   * backend, que es el que después valida). */
  var INFRACTION_UI = {
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
    pitSpeeding: {
      title: "Exceso de velocidad en pit lane",
      help:
        "La sanción se configura en Pit lane, con el límite y la tolerancia. Acá elegís si además " +
        "aparece en la bandeja, agrupado por piloto.",
      fields: [],
    },
    formationSpeeding: {
      title: "Exceso de velocidad en la formación",
      help: "Lo mismo para la vuelta de formación: la sanción se configura en Largada, y acá elegís si el hecho entra a la bandeja.",
      fields: [],
    },
  };

  function makeActionSelect(type) {
    var select = document.createElement("select");
    Object.keys(catalog.actions).forEach(function (action) {
      if (action === "penalty" && catalog.autoPenaltyAllowed.indexOf(type) === -1) return;
      var option = document.createElement("option");
      option.value = action;
      option.textContent = catalog.actions[action];
      select.appendChild(option);
    });
    return select;
  }

  function makeFieldControl(field) {
    var control;
    if (field.options) {
      control = document.createElement("select");
      field.options.forEach(function (pair) {
        var option = document.createElement("option");
        option.value = pair[0];
        option.textContent = pair[1];
        control.appendChild(option);
      });
    } else {
      control = document.createElement("input");
      control.type = field.type === "checkbox" ? "checkbox" : "number";
      if (field.min !== undefined) control.min = String(field.min);
      if (field.max !== undefined) control.max = String(field.max);
    }
    return control;
  }

  function construirInfraccionesUI() {
    infraccionesList.textContent = "";
    camposInfracciones = {};

    Object.keys(INFRACTION_UI).forEach(function (type) {
      var spec = INFRACTION_UI[type];
      var box = el("div", "rc-embed__infraction");

      var title = document.createElement("h4");
      title.textContent = spec.title;
      box.appendChild(title);

      var help = document.createElement("p");
      help.textContent = spec.help;
      box.appendChild(help);

      var action = makeActionSelect(type);
      action.addEventListener("change", function () {
        box.classList.toggle("rc-embed__infraction--off", action.value === "ignore");
      });
      box.appendChild(filaCampo("Qué hacer", action));

      var campos = { action: action, fields: {} };
      spec.fields.forEach(function (field) {
        var control = makeFieldControl(field);
        campos.fields[field.key] = control;
        box.appendChild(filaCampo(field.label, control));
      });
      camposInfracciones[type] = campos;

      infraccionesList.appendChild(box);
    });

    var elementos = [];
    Object.keys(camposInfracciones).forEach(function (type) {
      elementos.push(camposInfracciones[type].action);
      Object.keys(camposInfracciones[type].fields).forEach(function (key) {
        elementos.push(camposInfracciones[type].fields[key]);
      });
    });
    registrarFormReglas("infractions", btnGuardarInfracciones, elementos, buildInfractionsPayload);
  }

  function llenarInfracciones(config) {
    Object.keys(camposInfracciones).forEach(function (type) {
      var rule = config.infractions[type];
      var campos = camposInfracciones[type];
      campos.action.value = rule.action;
      INFRACTION_UI[type].fields.forEach(function (field) {
        var control = campos.fields[field.key];
        if (field.type === "checkbox") control.checked = rule[field.key];
        else control.value = String(rule[field.key]);
      });
    });
  }

  // -------------------------------------------------------------------------- perfiles de carrera

  function renderPerfiles(config) {
    selectPerfil.textContent = "";
    var perfiles = config.ruleProfiles || [];
    perfiles.forEach(function (perfil) {
      var option = document.createElement("option");
      option.value = perfil.id;
      option.textContent = perfil.name;
      selectPerfil.appendChild(option);
    });
    if (config.activeProfileId) selectPerfil.value = config.activeProfileId;

    var vacio = perfiles.length === 0;
    selectPerfil.disabled = vacio;
    btnCargarPerfil.disabled = vacio;
    btnBorrarPerfil.disabled = vacio;
    perfilVacioMsg.hidden = !vacio;
  }

  function wireProfiles() {
    btnGuardarPerfil.addEventListener("click", function () {
      var nombre = campoNombrePerfil.value.trim();
      if (!nombre) {
        avisoReglas("Ponele un nombre al perfil", true);
        campoNombrePerfil.focus();
        return;
      }
      pedido("/profiles", { method: "POST", body: { name: nombre } }).then(
        function (res) {
          campoNombrePerfil.value = "";
          llenarReglas(res.config);
          avisoReglas('Guardado el perfil "' + res.profile.name + '"', false);
        },
        function (err) { avisoReglas(err.message, true); }
      );
    });

    btnCargarPerfil.addEventListener("click", function () {
      if (!selectPerfil.value) return;
      pedido("/profiles/" + encodeURIComponent(selectPerfil.value) + "/apply", { method: "POST" }).then(
        function (res) {
          llenarReglas(res.config);
          avisoReglas('Reglas de "' + res.profile.name + '" cargadas', false);
        },
        function (err) { avisoReglas("No se pudo cargar: " + err.message, true); }
      );
    });

    btnBorrarPerfil.addEventListener("click", function () {
      if (!selectPerfil.value) return;
      var nombre = selectPerfil.options[selectPerfil.selectedIndex].textContent;
      if (
        !window.confirm(
          '¿Borrar el perfil "' + nombre + '"?\n\nLas reglas que están puestas ahora no cambian: lo que se pierde es poder volver a cargarlas de una.'
        )
      ) {
        return;
      }
      pedido("/profiles/" + encodeURIComponent(selectPerfil.value), { method: "DELETE" }).then(
        function (res) {
          llenarReglas(res.config);
          avisoReglas('Perfil "' + nombre + '" borrado', false);
        },
        function (err) { avisoReglas("No se pudo borrar: " + err.message, true); }
      );
    });
  }

  function llenarReglas(config) {
    campoFThreshold.value = config.formation.penalty.speedThresholdKmh;
    campoFTolerance.value = config.formation.penalty.toleranceSeconds;
    campoFGrace.value = config.formation.penalty.graceLaps;
    campoFPenaltyType.value = config.formation.penalty.penaltyType;
    campoFEscalation.value = config.formation.penalty.escalation;
    campoFTimePenalty.value = config.formation.penalty.timePenaltySeconds != null ? config.formation.penalty.timePenaltySeconds : 5;
    filaFTimePenalty.hidden = config.formation.penalty.escalation !== "TIME_PENALTY";

    campoPZoneStart.value = config.pit.zone.splineStart;
    campoPZoneEnd.value = config.pit.zone.splineEnd;
    campoPThreshold.value = config.pit.penalty.speedThresholdKmh;
    campoPTolerance.value = config.pit.penalty.toleranceSeconds;
    campoPGrace.value = config.pit.penalty.graceLaps;
    campoPStopGo.value = config.pit.stopGoSeconds;
    campoPPenaltyType.value = config.pit.penalty.penaltyType;
    campoPEscalation.value = config.pit.penalty.escalation;
    campoPTimePenalty.value = config.pit.penalty.timePenaltySeconds != null ? config.pit.penalty.timePenaltySeconds : 5;
    filaPTimePenalty.hidden = config.pit.penalty.escalation !== "TIME_PENALTY";

    llenarInfracciones(config);
    renderPerfiles(config);

    campoPrEnforce.checked = config.presence.enforce;
    campoPrGrace.value = config.presence.graceSeconds;

    Object.keys(reglasForms).forEach(function (nombre) { marcarFormReglasGuardado(nombre); });
  }

  function cargarReglas() {
    return pedido("/catalog")
      .then(function (c) {
        catalog = c;
        construirInfraccionesUI();
        return pedido("/config");
      })
      .then(function (config) { llenarReglas(config); });
  }

  function renderPitZoneSuggestion(suggestion) {
    pitZoneSuggestion = suggestion;
    zoneSuggestionBox.hidden = !suggestion;
    if (suggestion) {
      zoneSuggestionValue.textContent = suggestion.splineStart.toFixed(3) + " – " + suggestion.splineEnd.toFixed(3);
    }
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

  // --------------------------------------------------------------------- escudo de marca (CSS)

  /** Escudo con monograma, siempre con CSS y nunca con `<img>`: pedir `/brands/*.svg` sin sesión
   * abriría una ruta nueva sin bypass en `portal/server.ts` solo para este dibujo. Ver
   * `brandShield` en `app.js` para el original del que esto es una copia deliberada. */
  var BRAND_COLORS = {
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
    var hash = 0;
    for (var i = 0; i < brand.length; i++) hash = (hash * 31 + brand.charCodeAt(i)) % 360;
    return "hsl(" + hash + ", 52%, 40%)";
  }

  function inkFor(color) {
    if (color.charAt(0) !== "#") return "#ffffff";
    var n = parseInt(color.slice(1), 16);
    var lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? "#101217" : "#ffffff";
  }

  function monogramOf(brand) {
    var words = brand.split(/[\s-]+/).filter(Boolean);
    if (words.length > 1) {
      return words
        .map(function (w) { return w.charAt(0); })
        .join("")
        .slice(0, 3)
        .toUpperCase();
    }
    return brand.slice(0, 3).toUpperCase();
  }

  function brandShield(car) {
    var brand = car.brand || car.carModel || "";
    var wrap = el("span", "rc-embed__brand-shield");
    wrap.title = car.carModel || brand;
    if (!brand) {
      wrap.classList.add("rc-embed__brand-shield--empty");
      wrap.textContent = "--";
      return wrap;
    }
    var color = brandColor(brand);
    wrap.style.setProperty("--shield", color);
    wrap.style.setProperty("--shield-ink", inkFor(color));
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", brand);
    var text = document.createElement("span");
    text.textContent = monogramOf(brand);
    wrap.appendChild(text);
    return wrap;
  }

  // ===================================================================== semáforo de 5 luces

  /** Constantes calcadas de `RaceControlClient.py`, igual que en `app.js`: lo que ve el admin acá
   * tiene que ser lo mismo que ve el piloto en su propia app. */
  var LIGHTS_GREEN_HOLD_MS = 3000;
  var lightsTrackedState = "idle";
  var lightsGreenUntil = 0;
  var lightsGreenTimer = null;

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
    var sosteniendoVerde = lightsTrackedState === "green" && Date.now() < lightsGreenUntil;
    lights.classList.toggle("rc-embed__lights--formation", lightsTrackedState === "formation");
    lights.classList.toggle("rc-embed__lights--green", sosteniendoVerde);
  }

  // ===================================================================== indicador de sesión

  /** Mismos tipos que `SESSION_SHORT_LABELS` en `app.js`. */
  var SESSION_SHORT_LABELS = { 0: "RES", 1: "P", 2: "Q", 3: "R", 4: "H", 5: "TA", 6: "D", 7: "REP" };

  function formatClock(ms) {
    var totalCentisimos = Math.max(0, Math.round(ms / 10));
    var totalSegundos = Math.floor(totalCentisimos / 100);
    var totalHoras = Math.floor(totalSegundos / 3600);

    if (totalHoras >= 1) {
      var dias = Math.floor(totalHoras / 24);
      var horas = String(totalHoras % 24).padStart(2, "0");
      var minutos = String(Math.floor((totalSegundos % 3600) / 60)).padStart(2, "0");
      var segundos = String(totalSegundos % 60).padStart(2, "0");
      var reloj = horas + ":" + minutos + ":" + segundos;
      return dias >= 1 ? dias + (dias === 1 ? " día + " : " días + ") + reloj : reloj;
    }

    var centisimos = totalCentisimos % 100;
    var segundos2 = totalSegundos % 60;
    var minutos2 = Math.floor(totalSegundos / 60);
    return minutos2 + ":" + String(segundos2).padStart(2, "0") + "." + String(centisimos).padStart(2, "0");
  }

  function renderSesion(session) {
    if (!session) {
      sessionType.textContent = "--";
      sessionType.title = "Esperando el primer aviso de sesión del servidor.";
      delete sessionType.dataset.sessionType;
      sessionClock.textContent = "--:--";
      sessionClock.title = "";
      return;
    }

    sessionType.textContent = SESSION_SHORT_LABELS[session.sessionType] || "?";
    sessionType.dataset.sessionType = session.sessionType;
    sessionType.title = session.typeLabel;

    if (session.remainingMs !== null) {
      sessionClock.textContent = formatClock(session.remainingMs);
      sessionClock.title = "Tiempo restante de " + session.typeLabel.toLowerCase();
    } else if (session.laps > 0) {
      sessionClock.textContent = session.laps + " vueltas";
      sessionClock.title = "Sesión a " + session.laps + " vueltas, sin límite de tiempo.";
    } else {
      sessionClock.textContent = formatClock(session.elapsedMs);
      sessionClock.title = "Tiempo transcurrido de " + session.typeLabel.toLowerCase();
    }
  }

  // ----------------------------------------------------------------------------------- render

  var START_ACTIONS = {
    idle: { begin: true, green: false, reset: false },
    formation: { begin: false, green: true, reset: true },
    green: { begin: false, green: false, reset: true },
  };

  function renderStart(state) {
    var lightState = state.lightState;
    renderLights(lightState);
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

      var autoCelda = document.createElement("td");
      autoCelda.className = "rc-embed__celda-auto";
      autoCelda.appendChild(brandShield(car));
      tr.appendChild(autoCelda);

      var nombre = document.createElement("td");
      nombre.textContent = car.driverName || "Auto " + car.carId;
      tr.appendChild(nombre);

      // La velocidad sale del propio UDP del servidor, no de la app del piloto: nunca queda en
      // "—" salvo que todavía no haya llegado ningún CAR_UPDATE.
      var velocidad = document.createElement("td");
      velocidad.textContent = typeof car.speedKmh === "number" ? Math.round(car.speedKmh) + " km/h" : "—";
      tr.appendChild(velocidad);

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

      var accionesCelda = document.createElement("td");
      var deEsteAuto = pendientes.filter(function (i) {
        return i.parties.some(function (p) { return p.carId === car.carId; });
      });
      renderIncidentesDeAuto(accionesCelda, car, deEsteAuto);
      tr.appendChild(accionesCelda);

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
    renderSesion(state.session);
    renderStart(state);
    renderTabla(state);
    renderSanciones(state);
    renderConexionEstado(state);
    renderPitZoneSuggestion(state.pitZoneSuggestion || null);
  }

  // ----------------------------------------------------------------------------------- arranque

  function poll() {
    refrescar().then(function () {
      pollTimer = setTimeout(poll, POLL_MS);
    });
  }

  cargarReglas().catch(function (err) {
    mostrarError("No se pudo cargar la configuración: " + err.message);
  });
  poll();
})();
