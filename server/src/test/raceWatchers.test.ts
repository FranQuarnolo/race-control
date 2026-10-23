import { strict as assert } from "assert";
import { test } from "node:test";
import { ObservedFact, WrongWayWatcher } from "../incident/raceWatchers";
import { defaultInfractions } from "../incident/catalog";
import { CarState, StateTracker } from "../state/stateTracker";
import { Clock } from "../util/clock";

class FakeClock implements Clock {
  private t = 0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function car(carId: number, spline: number, speedKmh: number, lapCount = 1): CarState {
  return {
    carId,
    driverName: `Piloto ${carId}`,
    driverGuid: `guid-${carId}`,
    carModel: "x",
    connected: true,
    speedKmh,
    posX: 0,
    posY: 0,
    posZ: 0,
    normalizedSplinePosition: spline,
    lapCount,
    lastUpdate: 0,
    lastLapMs: null,
    bestLapMs: null,
  };
}

// ---------------------------------------------------------------- contramano

function wrongWay(overrides: Partial<ReturnType<typeof defaultInfractions>["wrongWay"]> = {}) {
  const clock = new FakeClock();
  const watcher = new WrongWayWatcher({ ...defaultInfractions().wrongWay, ...overrides }, clock);
  const facts: ObservedFact[] = [];
  watcher.on("fact", (f: ObservedFact) => facts.push(f));
  return { watcher, facts, clock };
}

/** Simula el auto retrocediendo `steps` muestras de 200 ms, como llegan los CAR_UPDATE. */
function driveBackwards(watcher: WrongWayWatcher, clock: FakeClock, steps: number, speedKmh = 60) {
  let spline = 0.5;
  for (let i = 0; i < steps; i++) {
    watcher.onCarUpdate(car(3, spline, speedKmh));
    spline -= 0.002;
    clock.advance(200);
  }
}

test("retroceder unos instantes no es contramano", () => {
  const { watcher, facts, clock } = wrongWay();
  driveBackwards(watcher, clock, 5); // 1 s, el mínimo son 3
  assert.equal(facts.length, 0);
});

test("retroceder sostenido sí se reporta, y una sola vez", () => {
  const { watcher, facts, clock } = wrongWay();
  driveBackwards(watcher, clock, 40); // 8 s
  assert.equal(facts.length, 1, "mientras sigue en contramano no debe repetir el aviso cada 200 ms");
  assert.equal(facts[0].carId, 3);
  assert.match(facts[0].detail, /contramano/);
});

test("volver a avanzar reinicia el contador", () => {
  const { watcher, facts, clock } = wrongWay();
  driveBackwards(watcher, clock, 10); // 2 s: todavía no llega al mínimo
  watcher.onCarUpdate(car(3, 0.9, 60)); // avanza
  clock.advance(200);
  driveBackwards(watcher, clock, 10); // otros 2 s, que no deben sumarse a los anteriores
  assert.equal(facts.length, 0);
});

test("maniobrar despacio para salir de la grava no es contramano", () => {
  const { watcher, facts, clock } = wrongWay();
  driveBackwards(watcher, clock, 40, 15); // marcha atrás a 15 km/h
  assert.equal(facts.length, 0);
});

test("cruzar la meta no se confunde con retroceder", () => {
  const { watcher, facts, clock } = wrongWay();
  // El spline salta de 0.99 a 0.01 en cada vuelta: es un delta negativo enorme, no un retroceso.
  for (let i = 0; i < 40; i++) {
    watcher.onCarUpdate(car(3, 0.99, 200));
    clock.advance(200);
    watcher.onCarUpdate(car(3, 0.01, 200));
    clock.advance(200);
  }
  assert.equal(facts.length, 0);
});

test("en 'ignore' el vigía no mira nada", () => {
  const { watcher, facts, clock } = wrongWay({ action: "ignore" });
  driveBackwards(watcher, clock, 40);
  assert.equal(facts.length, 0);
});

test("reset olvida lo acumulado", () => {
  const { watcher, facts, clock } = wrongWay();
  driveBackwards(watcher, clock, 10);
  watcher.reset();
  driveBackwards(watcher, clock, 10);
  assert.equal(facts.length, 0);
});
