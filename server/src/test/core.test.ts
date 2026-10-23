import { strict as assert } from "assert";
import * as dgram from "dgram";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import { parseConfig } from "../config";
import { createRaceControl, RaceControl } from "../core/raceControl";

/**
 * El núcleo, corriendo dos veces dentro del mismo proceso.
 *
 * Es exactamente lo que el portal necesita y lo que hasta la 0.3 era imposible: las rutas de
 * datos salían de una constante de módulo, así que dos instancias escribían en la misma carpeta.
 * Si estos tests se rompen, el worker por liga deja de ser viable.
 */

function carpetaTemporal(sufijo: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rc-core-${sufijo}-`));
}

function configDePrueba(puertoUdp: number, puertoAdmin: number): ReturnType<typeof parseConfig> {
  return parseConfig({
    leagueName: `Liga ${puertoUdp}`,
    http: { adminPort: puertoAdmin, clientPort: puertoAdmin + 1, publicHost: "203.0.113.5" },
    acUdp: { localPort: puertoUdp, remoteHost: "127.0.0.1", remotePort: puertoUdp + 500, remotePortSource: "manual" },
  });
}

async function levantar(sufijo: string, puertoUdp: number, puertoAdmin: number) {
  const dataDir = carpetaTemporal(sufijo);
  const rc = await createRaceControl({
    config: configDePrueba(puertoUdp, puertoAdmin),
    dataDir,
    mode: "portal",
    ports: { adminPort: puertoAdmin, clientPort: puertoAdmin + 1 },
    // Sin esto el test sale a internet a preguntar la IP pública y a buscar un router por UPnP.
    discovery: false,
  });
  return { rc, dataDir };
}

function limpiar(rc: RaceControl, dataDir: string): void {
  rc.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

test("dos instancias conviven en un proceso sin pisarse los datos ni los puertos", async () => {
  const a = await levantar("a", 12610, 13610);
  const b = await levantar("b", 12620, 13620);
  try {
    assert.notEqual(a.dataDir, b.dataDir);
    // Cada una escribe su propio journal dentro de SU carpeta: si el `logs/` fuera compartido,
    // el informe de una liga traería los incidentes de la otra.
    assert.ok(a.rc.journal.filePath.startsWith(a.dataDir));
    assert.ok(b.rc.journal.filePath.startsWith(b.dataDir));
    assert.ok(fs.existsSync(path.join(a.dataDir, "logs")));

    // Los puertos asignados se respetan tal cual: el portal hace proxy a estos números y no
    // tiene forma de enterarse si el worker se corre solo.
    assert.equal(a.rc.ports.adminPort, 13610);
    assert.equal(a.rc.ports.portsMoved, false);
    assert.equal(b.rc.ports.adminPort, 13620);

    // Y el estado es de cada una: el mismo carId en las dos es un auto distinto.
    a.rc.stateTracker.onNewConnection({
      driverName: "Piloto A",
      driverGuid: "76561190000000001",
      carId: 3,
      carModel: "ks_mazda_mx5",
      carSkin: "red",
    } as never);
    assert.equal(a.rc.stateTracker.get(3)?.driverName, "Piloto A");
    assert.equal(b.rc.stateTracker.get(3), undefined);
  } finally {
    limpiar(a.rc, a.dataDir);
    limpiar(b.rc, b.dataDir);
  }
});

test("stop() libera el puerto UDP, así que la misma liga puede reiniciarse en caliente", async () => {
  const primera = await levantar("reinicio", 12630, 13630);
  primera.rc.stop();

  // Si `stop()` no cerrara el socket, esto sería EADDRINUSE — que es justo lo que le pasaría al
  // supervisor al reintentar una liga que se cayó.
  const segunda = await createRaceControl({
    config: configDePrueba(12630, 13630),
    dataDir: primera.dataDir,
    mode: "portal",
    ports: { adminPort: 13630, clientPort: 13631 },
    discovery: false,
  });
  segunda.stop();
  fs.rmSync(primera.dataDir, { recursive: true, force: true });
});

test("stop() deja de escuchar: lo que llegue después no se procesa", async () => {
  const { rc, dataDir } = await levantar("sordo", 12640, 13640);
  rc.stop();

  const emisor = dgram.createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    emisor.send(Buffer.from([50]), 12640, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
  });
  emisor.close();

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(rc.udpClient.getStats().packetsReceived, 0);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
