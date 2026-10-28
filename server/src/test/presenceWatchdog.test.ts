import { strict as assert } from "assert";
import { test } from "node:test";
import { PresenceWatchdog } from "../presence/presenceWatchdog";
import { StateTracker } from "../state/stateTracker";

/**
 * El aviso antes del kick.
 *
 * Hasta la 1.2 el watchdog echaba y no decía nada: el piloto aparecía de golpe en el menú
 * principal, en medio de una sesión, sin ninguna explicación. Desde el panel se veía un
 * `presence.kick` prolijo en el journal; desde el auto se veía un juego que te sacó.
 *
 * Todo lo que hay acá son cuentas regresivas de minutos, así que el reloj es falso y `check()` se
 * llama a mano en vez de esperar su tick de 5 s. Es la única forma de que el test dure
 * milisegundos — y, de paso, la razón por la que esta lógica no tenía ningún test hasta ahora.
 */

const GUID = "76561190000000042";
const GRACIA_MS = 120_000;

interface Aviso {
  carId: number;
  driverGuid: string;
  secondsLeft: number;
}

function armar(graciaMs = GRACIA_MS) {
  const reloj = { t: 1_700_000_000_000 };
  const stateTracker = new StateTracker();
  const avisos: Aviso[] = [];
  const kicks: number[] = [];
  const watchdog = new PresenceWatchdog(stateTracker, {
    getGraceMs: () => graciaMs,
    isEnforced: () => true,
    dispatchKick: (carId) => kicks.push(carId),
    warnMissingApp: (carId, driverGuid, _driverName, secondsLeft) => avisos.push({ carId, driverGuid, secondsLeft }),
    now: () => reloj.t,
  });
  stateTracker.onNewConnection({
    carId: 6,
    driverName: "Ignacio Fuentes",
    driverGuid: GUID,
    carModel: "ks_ferrari_488_gt3",
    carSkin: "default",
  } as never);

  // `check` es privado porque nadie fuera de la clase tiene por qué llamarlo; el test sí, que es
  // lo que le ahorra los cinco segundos de cada tick.
  const tick = () => (watchdog as unknown as { check: () => void }).check();
  const avanzar = (segundos: number) => {
    reloj.t += segundos * 1000;
  };
  return { watchdog, avisos, kicks, tick, avanzar };
}

test("al piloto sin la app se le avisa dos veces antes de echarlo, y con los segundos que le quedan", () => {
  const { avisos, kicks, tick, avanzar } = armar();

  // Recién conectado: le sobra tiempo, no hay nada que decirle todavía.
  tick();
  assert.equal(avisos.length, 0, "avisó antes de tiempo: el chat se llenaría de cuenta regresiva");

  avanzar(80); // quedan 40 de los 120
  tick();
  assert.equal(avisos.length, 1, "no llegó el primer aviso");
  assert.equal(avisos[0].secondsLeft, 40);
  assert.equal(avisos[0].carId, 6);
  assert.equal(avisos[0].driverGuid, GUID);

  // Dos ticks más dentro del mismo tramo no repiten el aviso.
  avanzar(5);
  tick();
  avanzar(5);
  tick();
  assert.equal(avisos.length, 1, "repitió el mismo aviso en cada tick");

  avanzar(20); // quedan 10
  tick();
  assert.equal(avisos.length, 2, "no llegó la última llamada");
  assert.equal(avisos[1].secondsLeft, 10);

  assert.equal(kicks.length, 0, "lo echó mientras todavía le quedaba gracia");

  avanzar(11);
  tick();
  assert.deepEqual(kicks, [6]);
});

test("el que tiene la app no recibe ningún aviso, por larga que sea la carrera", () => {
  const { watchdog, avisos, kicks, tick, avanzar } = armar();
  // El heartbeat sale cada 2 s; acá se simula uno cada 5, que ya es pesimista.
  for (let i = 0; i < 60; i++) {
    watchdog.onHeartbeat(GUID);
    avanzar(5);
    tick();
  }
  assert.equal(avisos.length, 0);
  assert.equal(kicks.length, 0);
});

/**
 * El caso que el diseño anterior dejaba afuera, y es el que más importa.
 *
 * Al que tenía la app y se le cayó se lo echaba sin decirle nada: entre la caída y el kick,
 * `isReporting()` seguía contestando que sí —mide contra la gracia entera— así que el aviso nunca
 * salía. Y es justo el piloto al que avisarle sirve de algo: ya tiene la app instalada, le
 * alcanza con volver a abrirla.
 */
test("al que se le cae la app también se le avisa, no solo al que nunca la tuvo", () => {
  const { watchdog, avisos, kicks, tick, avanzar } = armar();

  watchdog.onHeartbeat(GUID);
  avanzar(5);
  tick();
  assert.equal(avisos.length, 0, "avisó con la app funcionando");

  // Se cierra la app. Desde el último heartbeat corren los 120 segundos de gracia.
  avanzar(80);
  tick();
  assert.equal(avisos.length, 1, "la caída lo agarró sin avisarle nada");
  // 35 y no 40: la cuenta corre desde el último heartbeat, no desde el tick anterior.
  assert.equal(avisos[0].secondsLeft, 35);

  avanzar(45);
  tick();
  assert.deepEqual(kicks, [6]);
});

test("si la app vuelve a tiempo, no se lo echa y los avisos se olvidan", () => {
  const { watchdog, avisos, kicks, tick, avanzar } = armar();

  avanzar(80); // quedan 40
  tick();
  avanzar(30); // quedan 10: ya recibió los dos avisos
  tick();
  assert.equal(avisos.length, 2);

  watchdog.onHeartbeat(GUID);
  avanzar(20);
  tick();
  assert.equal(kicks.length, 0, "lo echó después de que la app apareciera");

  // Y si se vuelve a caer, la cuenta regresiva arranca de nuevo con sus avisos.
  avanzar(70); // 90 desde el último heartbeat: quedan 30
  tick();
  assert.equal(avisos.length, 3, "la segunda caída quedó muda");
  assert.equal(avisos[2].secondsLeft, 30);
});

test("pasada la gracia lo echa una sola vez, aunque el kick se haya suprimido", () => {
  const { kicks, tick, avanzar } = armar();
  avanzar(121);
  tick();
  tick();
  tick();
  assert.deepEqual(kicks, [6], "en modo sombra el piloto sigue conectado y esto se repetiría cada 5 s");
});

test("con `enforce` apagado no se avisa ni se echa a nadie", () => {
  const stateTracker = new StateTracker();
  const avisos: number[] = [];
  const kicks: number[] = [];
  const watchdog = new PresenceWatchdog(stateTracker, {
    getGraceMs: () => GRACIA_MS,
    isEnforced: () => false,
    dispatchKick: (carId) => kicks.push(carId),
    warnMissingApp: (carId) => avisos.push(carId),
    now: () => 1_700_000_999_000,
  });
  stateTracker.onNewConnection({
    carId: 6,
    driverName: "Ignacio Fuentes",
    driverGuid: GUID,
    carModel: "ks_ferrari_488_gt3",
    carSkin: "default",
  } as never);
  (watchdog as unknown as { check: () => void }).check();

  assert.equal(avisos.length, 0, "amenazar con un kick que no va a pasar es peor que no avisar");
  assert.equal(kicks.length, 0);
});
