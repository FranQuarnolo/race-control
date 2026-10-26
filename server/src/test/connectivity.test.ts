import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";
import { AcUdpClient } from "../udp/client";
import { ConnectivityManager } from "../net/connectivity";

/**
 * El parpadeo de "Conectado" / "Sin señal".
 *
 * Con el servidor de Assetto Corsa andando y la pista vacía, el panel se caía y se levantaba solo
 * cada treinta segundos. No había nada roto en la red: con nadie manejando, el servidor no manda
 * un solo paquete por su cuenta, y lo único que llegaba era la respuesta al `GET_SESSION_INFO`
 * que pedíamos cada 30 s. La ventana de frescura era de 5. Cinco segundos en verde, veinticinco
 * en rojo, en loop.
 *
 * Es un bug de aritmética entre dos constantes que vivían en archivos distintos y que nadie había
 * puesto una al lado de la otra. Estos tests existen para que vuelvan a estar al lado.
 */

interface Latido {
  realtime: number;
  sessionInfo: number;
}

function fakeUdp(lastPacketHaceMs: number, latido: Latido) {
  return {
    getStats: () => ({
      packetsReceived: 100,
      packetsUnhandled: 0,
      lastPacketAt: Date.now() - lastPacketHaceMs,
      commandsSent: 0,
      commandSendErrors: 0,
      lastSourcePort: 11000,
    }),
    setRealtimePosInterval: () => {
      latido.realtime += 1;
    },
    requestSessionInfo: () => {
      latido.sessionInfo += 1;
    },
  } as unknown as AcUdpClient;
}

test("un hueco de un latido no se ve como una desconexión", () => {
  const latido = { realtime: 0, sessionInfo: 0 };
  // 6 segundos: más que el latido de 5, mucho menos que una caída real.
  const c = new ConnectivityManager(fakeUdp(6000, latido), () => "200.1.2.3");
  c.refreshTelemetryFlag();
  assert.equal(c.getStatus().receivingTelemetry, true);
});

test("un silencio largo sí se reporta", () => {
  const latido = { realtime: 0, sessionInfo: 0 };
  const c = new ConnectivityManager(fakeUdp(60_000, latido), () => "200.1.2.3");
  c.refreshTelemetryFlag();
  assert.equal(c.getStatus().receivingTelemetry, false);
});

test("sin ningún paquete nunca, no se inventa una conexión", () => {
  const latido = { realtime: 0, sessionInfo: 0 };
  const udp = {
    getStats: () => ({
      packetsReceived: 0,
      packetsUnhandled: 0,
      lastPacketAt: 0,
      commandsSent: 0,
      commandSendErrors: 0,
      lastSourcePort: 0,
    }),
    setRealtimePosInterval: () => {},
    requestSessionInfo: () => {},
  } as unknown as AcUdpClient;
  const c = new ConnectivityManager(udp, () => "200.1.2.3");
  c.refreshTelemetryFlag();
  assert.equal(c.getStatus().receivingTelemetry, false, "lastPacketAt en 0 es 'nunca', no 'hace 56 años'");
});

test("el latido pide algo que el servidor siempre contesta, y sale de entrada", async () => {
  const latido = { realtime: 0, sessionInfo: 0 };
  const c = new ConnectivityManager(fakeUdp(0, latido), () => "200.1.2.3");
  await c.start();
  c.stop();
  // Sin el `GET_SESSION_INFO` el latido no sirve para nada: `setRealtimePosInterval` no tiene
  // respuesta, así que con la pista vacía no llegaría un solo paquete y el panel diría "sin
  // señal" con el servidor perfecto.
  assert.equal(latido.sessionInfo, 1, "el primer latido tiene que salir sin esperar el primer tick");
  assert.equal(latido.realtime, 1, "y reafirmar el streaming de posiciones en el mismo tick");
});

/**
 * La invariante que de verdad importa, y que ningún test de comportamiento ve: la ventana de
 * silencio tiene que ser varias veces el latido. Si alguien sube el latido a 30 s sin tocar la
 * ventana, vuelve exactamente el bug original — y vuelve en silencio, porque todo "funciona".
 */
test("la ventana de silencio sigue siendo varios latidos, y es la misma en los dos archivos", () => {
  const DIST = path.join(__dirname, "..");
  const conectividad = fs.readFileSync(path.join(DIST, "net", "connectivity.js"), "utf-8");
  const diagnostico = fs.readFileSync(path.join(DIST, "net", "diagnostics.js"), "utf-8");

  const latido = Number(/KEEPALIVE_INTERVAL_MS\s*=\s*(\d+)/.exec(conectividad)?.[1]);
  const silencio = Number(/SILENCIO_TOLERADO_MS\s*=\s*(\d+)/.exec(conectividad)?.[1]);
  const fresco = Number(/TELEMETRY_FRESH_MS\s*=\s*(\d+)/.exec(diagnostico)?.[1]);

  assert.ok(latido > 0, "no encontré el latido en connectivity.js: el regex quedó viejo");
  assert.ok(silencio > 0, "no encontré la ventana de silencio en connectivity.js");
  assert.ok(fresco > 0, "no encontré TELEMETRY_FRESH_MS en diagnostics.js");

  assert.ok(
    silencio >= latido * 3,
    `La ventana de silencio (${silencio} ms) tiene que ser al menos tres latidos (${latido} ms). ` +
      `Con menos, un datagrama perdido —que en UDP pasa— se ve como una caída del servidor.`
  );
  assert.equal(
    fresco,
    silencio,
    "El botón de la barra y el diagnóstico tienen que decir lo mismo sobre exactamente lo mismo"
  );
});
