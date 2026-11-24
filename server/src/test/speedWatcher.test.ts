import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { SpeedWatcher } from "../state/speedWatcher";
import { StateTracker, CarState } from "../state/stateTracker";
import { PenaltyRules } from "../penalty/penaltyEngine";

/**
 * La cuenta regresiva de la gracia en RC Largada (1.47) sale de `getGraceRemaining`. Se prueba
 * con un reloj falso y un emisor suelto en lugar del StateTracker entero: lo que importa es la
 * aritmética de la racha, no cómo llegan los paquetes.
 */
function armar(toleranceSeconds: number) {
  let ahora = 0;
  const emisor = new EventEmitter();
  const reglas = { speedThresholdKmh: 80, toleranceSeconds } as PenaltyRules;
  const watcher = new SpeedWatcher(emisor as unknown as StateTracker, reglas, undefined, { now: () => ahora });
  const violaciones: number[] = [];
  watcher.on("violation", (v) => violaciones.push(v.carId));
  watcher.arm();
  const muestra = (ms: number, speedKmh: number) => {
    ahora = ms;
    emisor.emit("update", { carId: 1, speedKmh } as CarState);
  };
  return { watcher, muestra, violaciones };
}

test("la gracia baja con las muestras por encima del límite y vuelve a null al quedar abajo", () => {
  const { watcher, muestra } = armar(10);
  assert.equal(watcher.getGraceRemaining(1), null, "sin racha no hay cuenta");

  muestra(0, 100);
  assert.equal(watcher.getGraceRemaining(1), 10);
  muestra(1000, 100);
  muestra(2000, 100);
  assert.equal(watcher.getGraceRemaining(1), 8);

  // Debajo del límite pero sin cumplir el debounce: la cuenta queda congelada, no desaparece.
  muestra(2200, 60);
  assert.equal(watcher.getGraceRemaining(1), 8);
  muestra(2800, 60);
  assert.equal(watcher.getGraceRemaining(1), null, "pasado el debounce la racha se corta");
});

test("una vez sancionado ya no hay cuenta, y desarmado tampoco", () => {
  const { watcher, muestra, violaciones } = armar(2);
  muestra(0, 100);
  muestra(1000, 100);
  muestra(2000, 100);
  assert.deepEqual(violaciones, [1]);
  assert.equal(watcher.getGraceRemaining(1), null);

  const otro = armar(10);
  otro.muestra(0, 100);
  otro.watcher.disarm();
  assert.equal(otro.watcher.getGraceRemaining(1), null);
});
