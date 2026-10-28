/**
 * La torre de tiempos persiste toda la jornada.
 *
 * El bug que lo originó: hasta la 1.1 el panel mostraba `getConnected()`, así que al piloto que se
 * desconectaba se lo tragaba la tierra —con sus vueltas, sus tiempos y el único rastro de que
 * había estado en pista—. Y el que volvía a entrar caía en otro slot del servidor de AC, con otro
 * `carId`, y aparecía como una fila nueva en blanco al lado de la vieja.
 *
 * Los dos casos se prueban acá porque los dos son invisibles en desarrollo: con un solo piloto de
 * prueba entrando y saliendo prolijamente, la tabla se ve bien.
 */
import { strict as assert } from "assert";
import { test } from "node:test";
import { StateTracker } from "../state/stateTracker";

function conectar(tracker: StateTracker, carId: number, driverGuid: string, driverName = "Piloto " + driverGuid) {
  tracker.onNewConnection({ carId, driverName, driverGuid, carModel: "ks_ferrari_488_gt3", carSkin: "y" } as any);
}

function vuelta(tracker: StateTracker, carId: number, lapTimeMs: number) {
  tracker.onLapCompleted({ carId, lapTimeMs, cuts: 0 } as any);
}

test("el piloto que se desconecta sigue en la torre, marcado como desconectado", () => {
  const tracker = new StateTracker();
  conectar(tracker, 3, "guid-a", "Fulano");
  vuelta(tracker, 3, 92_000);
  tracker.onConnectionClosed({ carId: 3, driverGuid: "guid-a" } as any);

  const roster = tracker.getRoster();
  assert.equal(roster.length, 1);
  assert.equal(roster[0].driverName, "Fulano");
  assert.equal(roster[0].connected, false);
  assert.equal(roster[0].bestLapMs, 92_000, "los tiempos de la sesión no se pierden al salir");
  assert.equal(tracker.getConnected().length, 0, "pero no cuenta como alguien en pista");
});

test("el que vuelve en otro slot recupera su fila, no estrena una", () => {
  const tracker = new StateTracker();
  conectar(tracker, 3, "guid-a", "Fulano");
  vuelta(tracker, 3, 92_000);
  vuelta(tracker, 3, 91_000);
  tracker.onConnectionClosed({ carId: 3, driverGuid: "guid-a" } as any);

  // El servidor de AC le da el slot libre que encuentra: casi nunca es el mismo.
  conectar(tracker, 11, "guid-a", "Fulano");

  const roster = tracker.getRoster();
  assert.equal(roster.length, 1, "dos filas acá es el mismo piloto duplicado");
  assert.equal(roster[0].carId, 11);
  assert.equal(roster[0].connected, true);
  assert.equal(roster[0].bestLapMs, 91_000, "la mejor vuelta de la sesión la hizo él, no el slot");
  assert.equal(roster[0].lapCount, 2, "y las vueltas tampoco vuelven a cero");
});

test("otro piloto que ocupa el slot liberado es otra fila", () => {
  const tracker = new StateTracker();
  conectar(tracker, 3, "guid-a", "Fulano");
  tracker.onConnectionClosed({ carId: 3, driverGuid: "guid-a" } as any);
  // Mismo carId, GUID distinto: el servidor reusó el slot con otra persona adentro.
  conectar(tracker, 3, "guid-b", "Mengano");

  const roster = tracker.getRoster();
  assert.equal(roster.length, 2);
  assert.deepEqual(
    roster.map((c) => c.driverName).sort(),
    ["Fulano", "Mengano"],
    "el que se fue no se puede perder porque otro agarró su número"
  );
});

test("la sesión nueva resetea los tiempos pero no borra a nadie", () => {
  const tracker = new StateTracker();
  conectar(tracker, 3, "guid-a", "Fulano");
  vuelta(tracker, 3, 92_000);
  tracker.onConnectionClosed({ carId: 3, driverGuid: "guid-a" } as any);

  tracker.onNewSession();

  const roster = tracker.getRoster();
  assert.equal(roster.length, 1, "la jornada sigue: quien apareció en práctica sigue en la lista");
  assert.equal(roster[0].bestLapMs, null, "pero los tiempos son de la sesión, no de la jornada");
  assert.equal(roster[0].lapCount, 0);
});

test("un slot sin piloto no es una fila de la torre", () => {
  const tracker = new StateTracker();
  // Un CAR_UPDATE de un carId del que todavía no llegó el NEW_CONNECTION crea el estado igual.
  tracker.onCarUpdate({ carId: 9, speedKmh: 100, posX: 0, posY: 0, posZ: 0, normalizedSplinePosition: 0.5 } as any);
  assert.equal(tracker.getRoster().length, 0, "no hay a quién mostrar en esa fila");
  assert.ok(tracker.get(9), "el estado existe igual, para la telemetría");
});

test("la jornada tiene techo: los desconectados más viejos se caen de la lista", () => {
  const tracker = new StateTracker();
  // 64 es el techo. Se conectan 70 y se desconectan todos menos el último.
  for (let i = 0; i < 70; i++) {
    conectar(tracker, i, "guid-" + i);
    tracker.onCarUpdate({ carId: i, speedKmh: 10, posX: 0, posY: 0, posZ: 0, normalizedSplinePosition: 0.1 } as any);
    if (i < 69) tracker.onConnectionClosed({ carId: i, driverGuid: "guid-" + i } as any);
  }
  const roster = tracker.getRoster();
  assert.ok(roster.length <= 64, "la tabla no puede crecer sin fin: son " + roster.length);
  assert.ok(
    roster.some((c) => c.driverGuid === "guid-69" && c.connected),
    "el que está conectado nunca se poda"
  );
  assert.ok(!roster.some((c) => c.driverGuid === "guid-0"), "se va el más viejo de los que ya no están");
});
