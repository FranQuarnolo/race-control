import * as assert from "assert";
import * as net from "net";
import { after, before, describe, it } from "node:test";
import { findFreePort } from "../net/ports";

/**
 * Puerto base alto y poco transitado para no chocar con nada real de la máquina donde corra la
 * suite. Si alguno estuviera ocupado de verdad, los tests que esperan "libre" lo dirían.
 */
const BASE = 47310;
const HOST = "127.0.0.1";

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

describe("findFreePort", () => {
  const opened: net.Server[] = [];

  before(async () => {
    opened.push(await occupy(BASE));
    opened.push(await occupy(BASE + 1));
  });

  after(async () => {
    await Promise.all(opened.map((s) => new Promise((done) => s.close(done))));
  });

  it("devuelve el preferido cuando está libre", async () => {
    assert.strictEqual(await findFreePort(BASE + 5, HOST), BASE + 5);
  });

  it("se corre al siguiente libre si el preferido está ocupado", async () => {
    assert.strictEqual(await findFreePort(BASE, HOST), BASE + 2);
  });

  it("saltea los puertos que este mismo proceso ya reservó", async () => {
    // El caso real: el panel se corrió a BASE+2 y todavía no hizo listen, así que el sistema
    // operativo lo ve libre. Sin la lista de reservados, los dos servidores pedirían el mismo.
    assert.strictEqual(await findFreePort(BASE + 2, HOST, [BASE + 2]), BASE + 3);
  });

  it("devuelve el preferido si no encuentra ninguno libre, para que el listen falle con su error real", async () => {
    assert.strictEqual(await findFreePort(BASE, HOST, [BASE + 2, BASE + 3], 4), BASE);
  });
});
