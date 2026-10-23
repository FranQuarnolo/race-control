import { strict as assert } from "assert";
import { test } from "node:test";
import { StateTracker } from "../state/stateTracker";
import { TrackLimitsIncident, TrackLimitsTracker } from "../track/trackLimits";
import { TrackLimitsRule, defaultInfractions } from "../incident/catalog";

const RULES: TrackLimitsRule = defaultInfractions().trackLimits;

function setup(overrides: Partial<TrackLimitsRule> = {}, hasClient = true) {
  const tracker = new StateTracker();
  tracker.onNewConnection({ carId: 3, driverName: "Fulano", driverGuid: "guid-3", carModel: "x", carSkin: "y" } as any);
  const limits = new TrackLimitsTracker(tracker, { ...RULES, ...overrides }, () => hasClient);
  const incidents: TrackLimitsIncident[] = [];
  limits.on("incident", (i: TrackLimitsIncident) => incidents.push(i));
  return { tracker, limits, incidents };
}

function excursion(tyres: number, durationMs = 1000) {
  return { maxTyresOut: tyres, durationMs, splinePosition: 0.5, lap: 1, sector: 1 };
}

test("una salida sola no genera incidente; la tercera sí", () => {
  const { limits, incidents } = setup();
  limits.report("guid-3", [excursion(4)]);
  assert.equal(incidents.length, 0);
  assert.equal(limits.getCount("guid-3"), 1);

  limits.report("guid-3", [excursion(4), excursion(4)]);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].kind, "track-limits");
  assert.equal(incidents[0].driverName, "Fulano");
  assert.equal(incidents[0].carId, 3);
});

test("vuelve a avisar cada N salidas, no en cada salida posterior", () => {
  const { limits, incidents } = setup();
  for (let i = 0; i < 6; i++) limits.report("guid-3", [excursion(4)]);
  assert.equal(incidents.length, 2); // a la 3ra y a la 6ta
});

test("con el umbral en 4 ruedas, las de 2 no cuentan", () => {
  const { limits, incidents } = setup();
  limits.report("guid-3", [excursion(2), excursion(2), excursion(2), excursion(3)]);
  assert.equal(limits.getCount("guid-3"), 0);
  assert.equal(incidents.length, 0);
});

test("con el umbral en 2 ruedas, las de 2 sí cuentan", () => {
  const { limits } = setup({ minTyresOut: 2 });
  limits.report("guid-3", [excursion(2), excursion(3)]);
  assert.equal(limits.getCount("guid-3"), 2);
});

test("las salidas más cortas que el mínimo se descartan", () => {
  const { limits } = setup();
  limits.report("guid-3", [excursion(4, 100), excursion(4, 299), excursion(4, 300)]);
  assert.equal(limits.getCount("guid-3"), 1);
});

test("una salida en la vuelta más rápida se reporta aunque no haya reincidencia", () => {
  const { limits, incidents } = setup();
  // Primero una vuelta limpia, que fija la referencia.
  limits.onLapCompleted(3, 95_000, 0);
  // Ahora una vuelta con salida, más rápida que la limpia.
  limits.report("guid-3", [excursion(4)]);
  limits.onLapCompleted(3, 93_000, 0);

  assert.equal(incidents.length, 1);
  assert.match(incidents[0].detail, /vuelta más rápida/);
});

test("una salida en una vuelta lenta no reporta ganancia de tiempo", () => {
  const { limits, incidents } = setup();
  limits.onLapCompleted(3, 95_000, 0);
  limits.report("guid-3", [excursion(4)]);
  limits.onLapCompleted(3, 97_000, 0);
  assert.equal(incidents.length, 0);
});

test("la mejor vuelta de referencia ignora las vueltas sucias", () => {
  const { limits, incidents } = setup();
  limits.onLapCompleted(3, 95_000, 0); // limpia: 95s es la referencia

  // Vuelta sucia y rapidísima: no debe pasar a ser la referencia.
  limits.report("guid-3", [excursion(4)]);
  limits.onLapCompleted(3, 90_000, 0);
  assert.equal(incidents.length, 1);

  // Otra vuelta con salida a 93s: sigue siendo más rápida que la mejor LIMPIA (95s), así que
  // se reporta. Si la de 90s hubiera quedado como referencia, esta pasaría desapercibida.
  limits.report("guid-3", [excursion(4)]);
  limits.onLapCompleted(3, 93_000, 0);
  assert.equal(incidents.length, 2);
});

test("los cortes del servidor que el cliente nunca reportó terminan en la bandeja", () => {
  const { limits, incidents } = setup();
  limits.onLapCompleted(3, 95_000, 1);
  limits.onLapCompleted(3, 95_000, 1);
  assert.equal(incidents.length, 0); // 2 de diferencia: puede ser desfasaje del heartbeat
  limits.onLapCompleted(3, 95_000, 1);

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].kind, "telemetry-mismatch");
});

test("un piloto sin la app no genera incidente por telemetría inconsistente", () => {
  const { limits, incidents } = setup({}, false);
  for (let i = 0; i < 5; i++) limits.onLapCompleted(3, 95_000, 2);
  assert.equal(incidents.length, 0);
});

test("las salidas que el cliente sí reportó compensan los cortes del servidor", () => {
  const { limits, incidents } = setup();
  // Tres cortes reales, los tres informados por el cliente: no hay nada sospechoso.
  for (let i = 0; i < 3; i++) {
    limits.report("guid-3", [excursion(2)]);
    limits.onLapCompleted(3, 95_000, 1);
  }
  assert.equal(incidents.length, 0);
});

test("las salidas de dos ruedas cuentan para la validación cruzada aunque no para el umbral", () => {
  const { limits, incidents } = setup(); // umbral en 4 ruedas
  for (let i = 0; i < 4; i++) {
    limits.report("guid-3", [excursion(2)]);
    limits.onLapCompleted(3, 95_000, 1);
  }
  assert.equal(limits.getCount("guid-3"), 0); // no superan el umbral del admin
  assert.equal(incidents.length, 0); // pero el servidor y el cliente coinciden
});

test("un reporte con basura no rompe ni cuenta", () => {
  const { limits } = setup();
  limits.report("guid-3", [null, "x", {}, { maxTyresOut: 99, durationMs: 1000 }, { maxTyresOut: 4 }] as any);
  assert.equal(limits.getCount("guid-3"), 0);
  limits.report("guid-3", "no es un array" as any);
  assert.equal(limits.getCount("guid-3"), 0);
});

test("deshabilitado no registra nada", () => {
  const { limits, incidents } = setup({ action: "ignore" });
  limits.report("guid-3", [excursion(4), excursion(4), excursion(4)]);
  limits.onLapCompleted(3, 95_000, 5);
  assert.equal(limits.getCount("guid-3"), 0);
  assert.equal(incidents.length, 0);
});

test("el cambio de sesión limpia los contadores", () => {
  const { limits } = setup();
  limits.report("guid-3", [excursion(4), excursion(4)]);
  limits.resetSession();
  assert.equal(limits.getCount("guid-3"), 0);
});
