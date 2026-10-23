import { strict as assert } from "assert";
import { test } from "node:test";
import { IncidentEngine } from "../incident/incidentEngine";
import { InfractionCatalog, defaultInfractions } from "../incident/catalog";
import { StateTracker } from "../state/stateTracker";
import { ClientEvent } from "../udp/protocol";
import { Clock } from "../util/clock";

/** Catálogo fresco por test: los motores guardan la referencia y la mutan desde el panel, así que
 * compartir el objeto entre tests dejaría que uno le cambie las reglas al siguiente. */
function rules(): InfractionCatalog {
  return defaultInfractions();
}

/** Reloj falso — mismo patrón que ya usan speedWatcher y pitSpeeding. */
class FakeClock implements Clock {
  private t = 0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function v3(x: number, y: number, z: number) {
  return { x, y, z };
}

function contact(carId: number, otherCarId: number, impactSpeed: number, rel: { x: number; y: number; z: number }): ClientEvent {
  return { eventType: 10, carId, otherCarId, impactSpeed, worldPosition: v3(0, 0, 0), relPosition: rel };
}

function envHit(carId: number, impactSpeed: number): ClientEvent {
  return { eventType: 11, carId, impactSpeed, worldPosition: v3(0, 0, 0), relPosition: v3(0, 0, 1) };
}

function setup() {
  const tracker = new StateTracker();
  for (const [carId, name] of [
    [3, "Fulano"],
    [9, "Mengano"],
    [5, "Zutano"],
  ] as const) {
    tracker.onNewConnection({ carId, driverName: name, driverGuid: `guid-${carId}`, carModel: "x", carSkin: "y" } as any);
  }
  const clock = new FakeClock();
  const catalog = rules();
  const engine = new IncidentEngine(tracker, catalog, () => "race", clock);
  return { engine, tracker, clock, catalog };
}

const FRONT = v3(0, 0, 2); // golpe en la trompa
const REAR = v3(0, 0, -2); // golpe en la cola
const SIDE = v3(1.5, 0, 0.2); // golpe de costado

test("las dos perspectivas de un mismo toque generan UN solo incidente", () => {
  const { engine } = setup();
  engine.onClientEvent(contact(3, 9, 80, FRONT));
  engine.onClientEvent(contact(9, 3, 80, REAR));

  const all = engine.getAll();
  assert.equal(all.length, 1, "sin correlación, la bandeja mostraría el mismo toque dos veces");
  assert.equal(all[0].parties.length, 2);
  assert.deepEqual(
    all[0].parties.map((p) => p.driverName),
    ["Fulano", "Mengano"]
  );
});

test("cruzar las dos perspectivas clasifica la geometría del toque", () => {
  const cases: Array<[typeof FRONT, typeof FRONT, string]> = [
    [FRONT, REAR, "rear-end"],
    [REAR, FRONT, "rear-end"],
    [SIDE, SIDE, "side-by-side"],
    [FRONT, FRONT, "head-on"],
  ];
  for (const [relA, relB, expected] of cases) {
    const { engine } = setup();
    engine.onClientEvent(contact(3, 9, 80, relA));
    engine.onClientEvent(contact(9, 3, 80, relB));
    assert.equal(engine.getAll()[0].geometry, expected);
  }
});

test("con una sola perspectiva la geometría queda en 'unknown', no se adivina", async () => {
  const { engine } = setup();
  engine.onClientEvent(contact(3, 9, 80, FRONT));
  assert.equal(engine.getAll().length, 0, "no debe emitirse antes de esperar a la contraparte");

  // La ventana de correlación usa setTimeout real; esperamos a que venza.
  await new Promise((r) => setTimeout(r, 700));
  const all = engine.getAll();
  assert.equal(all.length, 1, "si el otro lado nunca llega, el incidente igual se registra");
  assert.equal(all[0].geometry, "unknown");
});

test("los impactos repetidos del mismo trompo se agrupan en un incidente", () => {
  const { engine, clock } = setup();
  for (let i = 0; i < 20; i++) {
    engine.onClientEvent(envHit(3, 100 + i));
    clock.advance(100);
  }
  const all = engine.getAll();
  assert.equal(all.length, 1, "sin antiflood, un trompo llenaría la bandeja de entradas");
  assert.equal(all[0].impactCount, 20);
  assert.equal(all[0].impactSpeedKmh, 119, "conserva el impacto más fuerte, no el último");
});

test("pasada la ventana de agrupación, un nuevo golpe es un incidente nuevo", () => {
  const { engine, clock } = setup();
  engine.onClientEvent(envHit(3, 100));
  clock.advance(5000);
  engine.onClientEvent(envHit(3, 100));
  assert.equal(engine.getAll().length, 2);
});

test("un toque contra otro rival NO se agrupa con el anterior", () => {
  const { engine } = setup();
  engine.onClientEvent(contact(3, 9, 80, FRONT));
  engine.onClientEvent(contact(9, 3, 80, REAR));
  // Mismo auto 3, pero contra otro piloto: es otro incidente, con otras partes involucradas.
  engine.onClientEvent(contact(3, 5, 80, FRONT));
  engine.onClientEvent(contact(5, 3, 80, REAR));

  const all = engine.getAll();
  assert.equal(all.length, 2);
  // El más reciente primero: es el orden en que un comisario quiere ver la bandeja.
  assert.deepEqual(
    all.map((i) => i.parties.map((p) => p.carId).sort()),
    [
      [3, 5],
      [3, 9],
    ]
  );
});

test("los impactos por debajo del umbral no llegan a la bandeja", () => {
  const { engine } = setup();
  engine.onClientEvent(contact(3, 9, 5, SIDE)); // roce de parrilla
  engine.onClientEvent(contact(9, 3, 5, SIDE));
  engine.onClientEvent(envHit(5, 10)); // piano
  assert.equal(engine.getAll().length, 0);
});

test("resolver un incidente lo saca de pendientes y no se puede resolver dos veces", () => {
  const { engine } = setup();
  engine.onClientEvent(envHit(3, 150));
  const id = engine.getAll()[0].id;

  assert.equal(engine.getPending().length, 1);
  assert.ok(engine.resolve(id, "dismissed", "fue solo"));
  assert.equal(engine.getPending().length, 0);
  assert.equal(engine.getAll()[0].status, "dismissed");
  assert.equal(engine.resolve(id, "penalized"), undefined);
});

// ------------------------------------------------ enrutado según el catálogo

test("en 'no controlar' el incidente ni siquiera se crea", () => {
  const { engine, catalog } = setup();
  catalog.envCollision.action = "ignore";
  engine.onClientEvent(envHit(3, 150));
  assert.equal(engine.getAll().length, 0);
});

test("en 'solo registrar' el hecho se emite pero no llega a la bandeja", () => {
  const { engine, catalog } = setup();
  catalog.envCollision.action = "log";
  const logged: unknown[] = [];
  engine.on("incident-logged", (i) => logged.push(i));

  engine.onClientEvent(envHit(3, 150));
  assert.equal(logged.length, 1, "el admin igual quiere que quede constancia para el informe");
  assert.equal(engine.getAll().length, 0, "pero no tiene que resolverlo uno por uno");
});

test("en 'solo registrar' el antiflood sigue armado", () => {
  const { engine, clock, catalog } = setup();
  catalog.envCollision.action = "log";
  const logged: unknown[] = [];
  engine.on("incident-logged", (i) => logged.push(i));

  // Un trompo: 20 impactos seguidos. Sin antiflood serían 20 líneas en el journal.
  for (let i = 0; i < 20; i++) {
    engine.onClientEvent(envHit(3, 100));
    clock.advance(100);
  }
  assert.equal(logged.length, 1);
});

test("cambiar la acción desde el panel se aplica en vivo, sin reiniciar", () => {
  // El motor guarda la REFERENCIA al catálogo: el panel muta ese mismo objeto al guardar.
  const { engine, clock, catalog } = setup();
  engine.onClientEvent(envHit(3, 150));
  assert.equal(engine.getAll().length, 1);

  catalog.envCollision.action = "ignore";
  clock.advance(10_000);
  engine.onClientEvent(envHit(3, 150));
  assert.equal(engine.getAll().length, 1, "el incidente nuevo no debe entrar");
});

test("un hecho observado respeta la acción de SU tipo, no la de las colisiones", () => {
  const { engine, catalog } = setup();
  catalog.disconnectDuringRace.action = "log";
  const logged: unknown[] = [];
  engine.on("incident-logged", (i) => logged.push(i));

  const returned = engine.reportObserved({
    kind: "disconnect",
    carId: 3,
    driverGuid: "guid-3",
    driverName: "Fulano",
    lap: 4,
    splinePosition: 0.3,
    detail: "Se desconectó en carrera",
  });
  assert.equal(returned, null, "en 'solo registrar' no hay incidente que mostrar");
  assert.equal(logged.length, 1);
  assert.equal(engine.getAll().length, 0);
});

test("un hecho observado en 'mandar a revisar' devuelve el incidente y entra una sola vez", () => {
  const { engine } = setup();
  const incident = engine.reportObserved({
    kind: "wrong-way",
    carId: 3,
    driverGuid: "guid-3",
    driverName: "Fulano",
    lap: 2,
    splinePosition: 0.6,
    detail: "Circuló en contramano",
  });
  assert.ok(incident);
  assert.equal(engine.getAll().length, 1, "enrutarlo dos veces lo duplicaría en la bandeja");
  assert.equal(engine.getAll()[0].id, incident!.id);
});

test("la telemetría inconsistente va a la bandeja sin importar el catálogo", () => {
  // No es una infracción del piloto sino una alerta de integridad: no tiene entrada propia y no
  // se puede apagar desde el panel. Lo que sí se apaga es el control que la produce.
  const { engine, catalog } = setup();
  for (const rule of Object.values(catalog)) rule.action = "ignore";
  const incident = engine.reportObserved({
    kind: "telemetry-mismatch",
    carId: 3,
    driverGuid: "guid-3",
    driverName: "Fulano",
    lap: 5,
    splinePosition: 0.1,
    detail: "El servidor reportó cortes que la app nunca informó",
  });
  assert.ok(incident);
  assert.equal(engine.getAll().length, 1);
});

test("el contexto del incidente es el del momento del impacto, no el de después", async () => {
  const { engine, tracker } = setup();
  tracker.onCarUpdate({ carId: 3, speedKmh: 180, normalizedSplinePosition: 0.5, posX: 0, posY: 0, posZ: 0 } as any);
  engine.onClientEvent(contact(3, 9, 80, FRONT));

  // El auto se frena y avanza mientras esperamos a la contraparte. El StateTracker MUTA el mismo
  // objeto, así que leerlo al emitir daría el estado de después del choque.
  tracker.onCarUpdate({ carId: 3, speedKmh: 20, normalizedSplinePosition: 0.52, posX: 0, posY: 0, posZ: 0 } as any);
  await new Promise((r) => setTimeout(r, 700));

  const incident = engine.getAll()[0];
  assert.equal(incident.parties[0].speedKmh, 180);
  assert.equal(incident.splinePosition, 0.5);
});
