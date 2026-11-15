import { strict as assert } from "assert";
import * as dgram from "dgram";
import { afterEach, describe, it } from "node:test";
import { AcUdpClient, AcUdpConfig } from "../udp/client";

/**
 * El servidor de AC se identifica solo: dirección y puerto salen del primer datagrama que manda.
 *
 * Son sockets de verdad sobre loopback y no un mock, porque lo que se está probando es justamente
 * qué trae el `rinfo` de Node — un doble de prueba daría por cierto el dato que se quiere
 * verificar. Lo que SÍ queda fuera de alcance acá y solo se confirma contra un servidor real
 * (`docs/spike-protocolo.md`) es si el acServer manda desde su puerto de escucha o desde uno
 * efímero.
 */

const abiertos: Array<{ close(): void }> = [];

function trackCliente(config: AcUdpConfig): AcUdpClient {
  const client = new AcUdpClient(config);
  abiertos.push({ close: () => client.stop() });
  return client;
}

/** Un acServer de mentira que manda un byte desde un puerto que elegimos nosotros. */
async function servidorFalso(puertoOrigen: number): Promise<dgram.Socket> {
  const socket = dgram.createSocket("udp4");
  abiertos.push({ close: () => socket.close() });
  await new Promise<void>((resolve) => socket.bind(puertoOrigen, "127.0.0.1", resolve));
  return socket;
}

function hablar(socket: dgram.Socket, hacia: number): Promise<void> {
  return new Promise((resolve, reject) =>
    socket.send(Buffer.from([0x00]), hacia, "127.0.0.1", (err) => (err ? reject(err) : resolve()))
  );
}

/** Espera a que el cliente emita el evento, o falla por timeout en vez de colgarse. */
function esperarEvento(client: AcUdpClient, evento: string, ms = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`nunca llegó el evento ${evento}`)), ms);
    client.once(evento, (info: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

function config(over: Partial<AcUdpConfig> = {}): AcUdpConfig {
  return { localPort: 0, remoteHost: "127.0.0.1", remotePort: 11000, remotePortSource: "default", ...over };
}

/** Puerto efímero real: el que el SO nos dio al bindear en 0. */
function puertoDe(client: AcUdpClient): number {
  return (client as unknown as { socket: dgram.Socket }).socket.address().port;
}

describe("autodetección del servidor de AC", () => {
  afterEach(() => {
    while (abiertos.length > 0) {
      try {
        abiertos.pop()!.close();
      } catch {
        // Ya estaba cerrado: no es lo que se está probando.
      }
    }
  });

  it("adopta el puerto desde el que le habló el servidor", async () => {
    const client = trackCliente(config());
    await client.start();
    const detectado = esperarEvento(client, "remotePortDetected");

    const server = await servidorFalso(18008);
    await hablar(server, puertoDe(client));

    const info = await detectado;
    assert.equal(info.previous, 11000);
    assert.equal(info.detected, 18008);
    assert.equal(client.getRemoteTarget().port, 18008);
  });

  // Un puerto escrito a mano es una decisión del admin: puede venir de un hosting que relaya los
  // datagramas, donde el origen NO es el destino correcto. Pisarlo rompería el único caso en que
  // el admin sabe más que nosotros.
  it("no pisa un puerto que el admin escribió a mano", async () => {
    const client = trackCliente(config({ remotePort: 9999, remotePortSource: "manual" }));
    await client.start();
    let emitio = false;
    client.on("remotePortDetected", () => (emitio = true));

    const server = await servidorFalso(18009);
    await hablar(server, puertoDe(client));
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(client.getRemoteTarget().port, 9999);
    assert.equal(emitio, false);
  });

  // El caso de Spa de FSL (1.40): el servidor está detrás de un NAT, escucha en un puerto que el
  // router no abre, y el router le cambia el origen. Lo único que vuelve a entrar es una respuesta
  // al último IP:puerto que habló; quedarse con el primero dejaba todo lo saliente en su firewall.
  it("si el servidor habla desde otro puerto, le contesta al último", async () => {
    const client = trackCliente(config());
    await client.start();
    const detectado = esperarEvento(client, "remotePortDetected");

    const primero = await servidorFalso(18010);
    await hablar(primero, puertoDe(client));
    await detectado;
    const segundo = await servidorFalso(18011);
    await hablar(segundo, puertoDe(client));
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(client.getRemoteTarget().port, 18011, "se quedó con el puerto viejo: detrás de un NAT, nada llega");
    assert.equal(client.hasUnstableRemotePort(), false);
  });

  it("el host se adopta igual que el puerto, y solo mientras siga en loopback", async () => {
    const client = trackCliente(config({ remoteHost: "203.0.113.7" }));
    await client.start();
    let emitio = false;
    client.on("remoteHostDetected", () => (emitio = true));

    const server = await servidorFalso(18012);
    await hablar(server, puertoDe(client));
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(client.getRemoteTarget().host, "203.0.113.7");
    assert.equal(emitio, false);
  });

  // --- El servidor se muda (desde la 1.38) -------------------------------------------------------
  //
  // Sin sockets: lo que se prueba es la regla, y una IP pública de mentira no se puede bindear.
  function recibirDe(client: AcUdpClient, address: string, port: number): void {
    const rinfo = { address, port, family: "IPv4", size: 1 } as dgram.RemoteInfo;
    (client as unknown as { handleMessage(m: Buffer, r: dgram.RemoteInfo): void }).handleMessage(Buffer.from([0x00]), rinfo);
  }

  it("si el servidor de AC cambia de IP, le contesta al nuevo y vuelve a detectar el puerto", () => {
    const client = trackCliente(
      config({ remoteHost: "160.119.76.171", remotePort: 10051, remotePortSource: "detected" })
    );
    recibirDe(client, "172.233.26.106", 913);

    // El caso real de FSL: la torre se llenaba con el servidor nuevo y el chat salía hacia el viejo.
    assert.deepEqual(client.getRemoteTarget(), { host: "172.233.26.106", port: 913, autodetected: true });
    assert.equal(client.hasUnstableRemotePort(), false);
  });

  it("al cambiar de IP respeta el puerto que el admin fijó a mano", () => {
    const client = trackCliente(
      config({ remoteHost: "160.119.76.171", remotePort: 12000, remotePortSource: "manual" })
    );
    recibirDe(client, "172.233.26.106", 913);
    assert.equal(client.getRemoteTarget().host, "172.233.26.106");
    assert.equal(client.getRemoteTarget().port, 12000);
  });

  it("dos servidores de AC en el mismo puerto: deja de saltar entre ellos y avisa", () => {
    const client = trackCliente(config({ remoteHost: "198.51.100.1", remotePort: 9000, remotePortSource: "detected" }));
    let aviso: Record<string, unknown> | null = null;
    client.on("remoteHostUnstable", (info: Record<string, unknown>) => (aviso = info));

    recibirDe(client, "198.51.100.2", 9100);
    recibirDe(client, "198.51.100.1", 9000);

    assert.ok(aviso, "no avisó que hay dos servidores mezclados");
    assert.equal(client.getRemoteTarget().host, "198.51.100.2");
    recibirDe(client, "198.51.100.3", 9200);
    assert.equal(client.getRemoteTarget().host, "198.51.100.2", "siguió saltando después de rendirse");
  });
});
