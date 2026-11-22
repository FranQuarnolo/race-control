import { strict as assert } from "assert";
import { test } from "node:test";
import { PenaltyEngine } from "../penalty/penaltyEngine";
import { StateTracker } from "../state/stateTracker";
import { PitComplianceTracker } from "../instances/pitSpeeding";

/**
 * Cumplimiento del Drive-Through.
 *
 * El bug de la 1.44: el piloto pasaba por boxes y el DT seguía pendiente (y en "RC mensajes").
 * El cumplimiento se medía solo con la zona de spline, que por defecto es una sola para todas las
 * pistas; si no coincidía con el pit lane real, el auto nunca figuraba "dentro" y nada lo cumplía.
 */

const ZONA = { splineStart: 0.97, splineEnd: 0.995 };

function armar(inPitLane: () => boolean | null, clock: { now: () => number } = { now: () => Date.now() }) {
  const state = new StateTracker();
  const engine = new PenaltyEngine({
    speedThresholdKmh: 80,
    toleranceSeconds: 2,
    graceLaps: 3,
    penaltyType: "DT",
    escalation: "DQ",
    timePenaltySeconds: 5,
  });
  new PitComplianceTracker(state, [engine], ZONA, () => 30, () => 80, clock as never, inPitLane);
  state.onNewConnection({ carId: 1, driverName: "Piloto", driverGuid: "g1", carModel: "x", carSkin: "y" } as never);
  const muestra = (spline: number, kmh: number) =>
    state.onCarUpdate({ carId: 1, speedKmh: kmh, normalizedSplinePosition: spline, posX: 0, posY: 0, posZ: 0 } as never);
  return { engine, muestra };
}

test("un DT se cumple con la zona de spline cuando no hay telemetría de la app", () => {
  const { engine, muestra } = armar(() => null);
  const p = engine.issuePenalty(1, "g1", "Contacto", "DT");
  muestra(0.98, 70);
  muestra(0.99, 75);
  muestra(0.5, 200);
  assert.equal(p.status, "served");
});

test("un DT se cumple con el flag del juego aunque la zona de spline no coincida con la pista", () => {
  let enPit: boolean | null = false;
  const { engine, muestra } = armar(() => enPit);
  const p = engine.issuePenalty(1, "g1", "Contacto", "DT");

  // Pit lane real en 0.40–0.45: fuera de la zona configurada, que es lo que rompía todo.
  enPit = true;
  muestra(0.41, 60);
  muestra(0.43, 78);
  enPit = false;
  muestra(0.47, 150);
  assert.equal(p.status, "served");
});

test("pasar por pits muy por encima del límite no cumple el DT", () => {
  let enPit: boolean | null = true;
  const { engine, muestra } = armar(() => enPit);
  const p = engine.issuePenalty(1, "g1", "Contacto", "DT");
  muestra(0.41, 140);
  enPit = false;
  muestra(0.47, 150);
  assert.equal(p.status, "servingWindow");
});

test("unos km/h sobre el límite en la entrada no invalidan el pasaje", () => {
  let enPit: boolean | null = true;
  const { engine, muestra } = armar(() => enPit);
  const p = engine.issuePenalty(1, "g1", "Contacto", "DT");
  muestra(0.41, 83);
  muestra(0.43, 78);
  enPit = false;
  muestra(0.47, 150);
  assert.equal(p.status, "served");
});

test("entrar a boxes y quedarse parado no cumple el DT: es una parada, no un pasaje", () => {
  let t = 0;
  let enPit: boolean | null = true;
  const { engine, muestra } = armar(() => enPit, { now: () => t });
  const p = engine.issuePenalty(1, "g1", "Contacto", "DT");
  muestra(0.41, 60);
  t = 1000;
  muestra(0.42, 0);
  t = 6000; // 5 s detenido
  muestra(0.42, 0);
  t = 7000;
  muestra(0.43, 40);
  enPit = false;
  muestra(0.47, 150);
  assert.equal(p.status, "servingWindow");
});

test("frenar un instante en la calle de boxes no le saca el DT", () => {
  let t = 0;
  let enPit: boolean | null = true;
  const { engine, muestra } = armar(() => enPit, { now: () => t });
  const p = engine.issuePenalty(1, "g1", "Contacto", "DT");
  muestra(0.41, 60);
  t = 1000;
  muestra(0.42, 0);
  t = 2000; // 1 s detenido, menos que el umbral
  muestra(0.42, 30);
  enPit = false;
  muestra(0.47, 150);
  assert.equal(p.status, "served");
});

test("una regla con sanción de tiempo emite +N s cumplida en el acto", () => {
  const engine = new PenaltyEngine({
    speedThresholdKmh: 80,
    toleranceSeconds: 2,
    graceLaps: 3,
    penaltyType: "TIME",
    escalation: "DQ",
    timePenaltySeconds: 12,
  });
  const p = engine.issuePenalty(1, "g1", "Exceso en pit lane");
  assert.equal(p.type, "TIME");
  assert.equal(p.timePenaltySeconds, 12);
  assert.equal(p.status, "served");
});
