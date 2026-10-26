import { strict as assert } from "assert";
import { test } from "node:test";
import { AddressInfo } from "net";
import { createClientApi } from "../api/clientApi";
import { PilotMessageBoard } from "../instances/pilotMessages";

const GUID = "76561190000000001";
const OTRO = "76561190000000002";

test("cada piloto ve solo sus avisos", () => {
  const board = new PilotMessageBoard();
  board.push(GUID, "penalty", "Drive-Through");
  board.push(OTRO, "warning", "Vuelta invalidada");

  assert.deepEqual(
    board.since(GUID, 0).map((m) => m.text),
    ["Drive-Through"]
  );
  assert.deepEqual(
    board.since(OTRO, 0).map((m) => m.text),
    ["Vuelta invalidada"]
  );
});

test("el `since` del cliente evita que el mismo aviso se muestre dos veces", () => {
  const board = new PilotMessageBoard();
  board.push(GUID, "warning", "primero");
  const primero = board.since(GUID, 0);
  assert.equal(primero.length, 1);

  // El cliente confirma hasta acá y vuelve a preguntar: no tiene que venir nada.
  assert.deepEqual(board.since(GUID, primero[0].seq), []);

  board.push(GUID, "warning", "segundo");
  assert.deepEqual(
    board.since(GUID, primero[0].seq).map((m) => m.text),
    ["segundo"]
  );
});

test("la cola por piloto tiene techo: una carrera larga no acumula sin límite", () => {
  const board = new PilotMessageBoard();
  for (let i = 0; i < 50; i++) board.push(GUID, "warning", "aviso " + i);
  const vigentes = board.since(GUID, 0);
  assert.equal(vigentes.length, 10);
  assert.equal(vigentes[vigentes.length - 1].text, "aviso 49", "se descartan los viejos, no los nuevos");
});

test("el cambio de sesión limpia la pizarra", () => {
  const board = new PilotMessageBoard();
  board.push(GUID, "penalty", "Drive-Through de la qualy");
  board.resetSession();
  assert.deepEqual(board.since(GUID, 0), []);
});

test("un aviso sin texto o sin piloto no entra", () => {
  const board = new PilotMessageBoard();
  board.push(GUID, "warning", "");
  board.push("", "warning", "algo");
  assert.deepEqual(board.since(GUID, 0), []);
});

/* ------------------------------------------------------- el endpoint que lo entrega */

function deps(board: PilotMessageBoard, guidAcreditado: string | null) {
  return {
    lightEventTracker: { get: () => ({ seq: 0, type: "idle" as const }) } as never,
    messageBoard: board,
    presenceWatchdog: { onHeartbeat: () => {} } as never,
    telemetryStore: { report: () => {}, get: () => null } as never,
    onExcursions: () => {},
    onHeartbeat: () => {},
    onSurfaceGrip: () => {},
    verifyToken: () => guidAcreditado,
  };
}

async function pedir(board: PilotMessageBoard, guidAcreditado: string | null, query: string) {
  const app = createClientApi(deps(board, guidAcreditado));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/client/poll${query}`, {
      headers: { Authorization: "Bearer x" },
    });
    return (await res.json()) as { messages: Array<{ seq: number; text: string }> };
  } finally {
    server.close();
  }
}

test("el poll entrega los avisos del piloto que acredita el token", async () => {
  const board = new PilotMessageBoard();
  board.push(GUID, "penalty", "Drive-Through");
  const body = await pedir(board, GUID, "?since=0&guid=" + GUID);
  assert.deepEqual(
    body.messages.map((m) => m.text),
    ["Drive-Through"]
  );
});

/**
 * El `guid` de la URL es una comodidad del modo local, donde no hay token. Con token tiene que
 * ser decorativo: si mandando otro guid se pudieran leer los avisos ajenos, cualquier piloto
 * sabría al instante qué sanciones tienen sus rivales, que es información de carrera.
 */
test("con token, el guid de la URL no sirve para leer los avisos de otro", async () => {
  const board = new PilotMessageBoard();
  board.push(OTRO, "penalty", "Drive-Through del rival");
  const body = await pedir(board, GUID, "?since=0&guid=" + OTRO);
  assert.deepEqual(body.messages, []);
});

test("un poll sin `since` no rompe: devuelve la lista vacía", async () => {
  const board = new PilotMessageBoard();
  board.push(GUID, "penalty", "Drive-Through");
  const body = await pedir(board, GUID, "");
  assert.deepEqual(body.messages, []);
});
