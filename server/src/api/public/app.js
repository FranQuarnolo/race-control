// Panel admin — JS vanilla, sin build. Todo texto que viene del juego (nombre de piloto, motivo
// de sanción) se inserta con textContent, nunca con innerHTML, para no quedar expuestos a un
// nombre de piloto armado a propósito con HTML/JS (XSS).

const POLL_MS = 1000;

function $(id) {
  return document.getElementById(id);
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2000);
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderCars(cars) {
  const body = $("cars-body");
  clearChildren(body);
  for (const car of cars) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = car.driverName || "(auto " + car.carId + ")";
    tr.appendChild(tdName);

    const tdSpeed = document.createElement("td");
    tdSpeed.textContent = Math.round(car.speedKmh) + " km/h";
    tr.appendChild(tdSpeed);

    const tdLap = document.createElement("td");
    tdLap.textContent = String(car.lapCount);
    tr.appendChild(tdLap);

    const tdSpline = document.createElement("td");
    tdSpline.textContent = car.normalizedSplinePosition.toFixed(3);
    tr.appendChild(tdSpline);

    const tdSignal = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge " + (car.telemetryStale ? "bad" : "ok");
    badge.textContent = car.telemetryStale ? "sin señal" : "ok";
    tdSignal.appendChild(badge);
    tr.appendChild(tdSignal);

    body.appendChild(tr);
  }
}

function statusBadge(status) {
  const map = { servingWindow: ["warn", "pendiente"], served: ["ok", "cumplida"], escalated: ["bad", "escalada"] };
  const [cls, label] = map[status] || ["neutral", status];
  const span = document.createElement("span");
  span.className = "badge " + cls;
  span.textContent = label;
  return span;
}

function renderPenalties(formationPenalties, pitPenalties) {
  const body = $("penalties-body");
  clearChildren(body);
  const all = formationPenalties.map((p) => ({ ...p, engine: "Largada" })).concat(pitPenalties.map((p) => ({ ...p, engine: "Pit lane" })));
  all.sort((a, b) => b.createdAt - a.createdAt);
  for (const p of all) {
    const tr = document.createElement("tr");

    const tdEngine = document.createElement("td");
    tdEngine.textContent = p.engine;
    tr.appendChild(tdEngine);

    const tdCar = document.createElement("td");
    tdCar.textContent = "Auto " + p.carId;
    tr.appendChild(tdCar);

    const tdReason = document.createElement("td");
    tdReason.textContent = p.reason;
    tr.appendChild(tdReason);

    const tdStatus = document.createElement("td");
    tdStatus.appendChild(statusBadge(p.status));
    tr.appendChild(tdStatus);

    const tdGrace = document.createElement("td");
    tdGrace.textContent = p.status === "servingWindow" ? String(p.graceLapsRemaining) : "--";
    tr.appendChild(tdGrace);

    body.appendChild(tr);
  }
}

function renderNetwork(network) {
  $("net-ip").textContent = network.publicIp || "detectando...";
  $("net-signal").textContent = network.receivingTelemetry ? "recibiendo" : "sin señal todavía";
  const strategyLabels = { pending: "detectando...", direct: "directa (sin forwarding)", upnp: "UPnP automático", manual: "requiere forwarding manual" };
  $("net-strategy").textContent = strategyLabels[network.strategy] || network.strategy;
  $("net-snippet").textContent = network.emperorServersSnippet;
}

let wizardShown = false;

async function refresh() {
  const state = await api("/api/state");

  $("league-label").textContent = state.leagueName || "";

  if (state.firstRun && !wizardShown) {
    wizardShown = true;
    $("wizard-overlay").hidden = false;
  }

  const semaforo = $("semaforo");
  semaforo.className = "semaforo " + state.lightState;
  const labels = { idle: "Esperando", formation: "Formación", green: "VERDE" };
  semaforo.textContent = labels[state.lightState] || state.lightState;

  renderCars(state.cars);
  renderPenalties(state.formationPenalties, state.pitPenalties);
  renderNetwork(state.network);

  $("shadow-toggle").checked = state.shadowMode;
}

async function loadConfigForm() {
  const config = await api("/api/config");
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
}

function wireButtons() {
  $("btn-begin").addEventListener("click", () => api("/api/formation/begin", { method: "POST" }).catch(() => toast("Error")));
  $("btn-green").addEventListener("click", () => api("/api/formation/green", { method: "POST" }).catch(() => toast("Error")));
  $("btn-reset").addEventListener("click", () => api("/api/formation/reset", { method: "POST" }).catch(() => toast("Error")));

  $("btn-save-formation").addEventListener("click", async () => {
    await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        formation: {
          penalty: {
            speedThresholdKmh: Number($("f-threshold").value),
            toleranceSeconds: Number($("f-tolerance").value),
            graceLaps: Number($("f-grace").value),
            penaltyType: $("f-penalty-type").value,
            escalation: $("f-escalation").value,
          },
        },
      }),
    });
    toast("Guardado");
  });

  $("btn-save-pit").addEventListener("click", async () => {
    await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pit: {
          zone: {
            splineStart: Number($("p-zone-start").value),
            splineEnd: Number($("p-zone-end").value),
          },
          stopGoSeconds: Number($("p-stopgo").value),
          penalty: {
            speedThresholdKmh: Number($("p-threshold").value),
            toleranceSeconds: Number($("p-tolerance").value),
            graceLaps: Number($("p-grace").value),
            penaltyType: $("p-penalty-type").value,
            escalation: $("p-escalation").value,
          },
        },
      }),
    });
    toast("Guardado");
  });

  $("shadow-toggle").addEventListener("change", async (e) => {
    await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shadowMode: e.target.checked }),
    });
    toast(e.target.checked ? "Modo sombra activado" : "Aplicación automática activada");
  });

  $("btn-copy-snippet").addEventListener("click", () => {
    navigator.clipboard.writeText($("net-snippet").textContent).then(() => toast("Copiado"));
  });

  $("wizard-submit").addEventListener("click", async () => {
    const name = $("wizard-name").value.trim();
    if (!name) return;
    await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leagueName: name }),
    });
    $("wizard-overlay").hidden = true;
  });
}

wireButtons();
loadConfigForm();
refresh();
setInterval(refresh, POLL_MS);
