import { strict as assert } from "assert";
import { test } from "node:test";
import { estaEnPit } from "../api/adminApi";
import { CarState } from "../state/stateTracker";
import { DriverTelemetry } from "../telemetry/driverTelemetry";

/**
 * El "PIT" de la columna de velocidad.
 *
 * Hasta la 0.8 la fila se pintaba de ámbar solo con `telemetry.inPitLane`, que sale de la Shared
 * Memory del juego y por lo tanto existe únicamente si el piloto tiene la app instalada. En una
 * liga donde nadie la tiene —que es el caso normal al empezar— nunca se veía un auto en boxes: el
 * admin solo notaba que alguien se descolgaba de la clasificación, sin saber si era una parada o
 * un abandono.
 *
 * La red de contención es la zona de pit configurada, la misma que usa el motor para sancionar.
 */

const ZONA = { splineStart: 0.97, splineEnd: 0.995 };

function auto(spline: number): CarState {
  return {
    carId: 1,
    driverName: "Piloto",
    driverGuid: "76561198000000001",
    carModel: "x",
    connected: true,
    speedKmh: 0,
    posX: 0,
    posY: 0,
    posZ: 0,
    normalizedSplinePosition: spline,
    lapCount: 0,
    lastLapMs: null,
    bestLapMs: null,
    lastUpdate: 1,
  } as CarState;
}

function conApp(inPitLane: boolean): DriverTelemetry {
  return { inPitLane } as DriverTelemetry;
}

test("sin la app del piloto, la zona de pit configurada alcanza para saberlo", () => {
  assert.equal(estaEnPit(auto(0.98), null, ZONA), true);
  assert.equal(estaEnPit(auto(0.5), null, ZONA), false);
});

test("los extremos de la zona cuentan como adentro, igual que en el motor", () => {
  // `PitSpeedMonitor` usa `>=` y `<=`. Si acá fuera `>` y `<`, el panel diría "en pista" justo en
  // el tramo donde el motor ya está midiendo la velocidad de pit.
  assert.equal(estaEnPit(auto(0.97), null, ZONA), true);
  assert.equal(estaEnPit(auto(0.995), null, ZONA), true);
});

test("la app del piloto le gana a la zona, en los dos sentidos", () => {
  // El juego lo sabe de verdad; la zona es una aproximación por tramo de vuelta. Donde las dos
  // opinan, manda el juego —incluido el caso en que contradice a una zona mal calibrada.
  assert.equal(estaEnPit(auto(0.5), conApp(true), ZONA), true);
  assert.equal(estaEnPit(auto(0.98), conApp(false), ZONA), false);
});

test("una zona al revés no inventa un pit lane", () => {
  // `splineEnd <= splineStart` es una zona que no existe. Sin esta guarda, la comparación daría
  // siempre `false` por casualidad en vez de por decisión, y una zona de 0 a 1 —igual de
  // inválida— marcaría a todo el mundo en boxes toda la carrera.
  assert.equal(estaEnPit(auto(0.98), null, { splineStart: 0.995, splineEnd: 0.97 }), false);
  assert.equal(estaEnPit(auto(0.5), null, { splineStart: 0.5, splineEnd: 0.5 }), false);
});

test("un auto detenido fuera de la zona no está en boxes", () => {
  // El caso que descarta la heurística intuitiva de "velocidad 0 por mucho tiempo": un abandono
  // en la grava también está parado, y es justo cuando el admin necesita ver que NO es una parada.
  assert.equal(estaEnPit(auto(0.42), null, ZONA), false);
});
