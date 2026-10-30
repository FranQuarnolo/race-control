import { strict as assert } from "assert";
import * as dgram from "dgram";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
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
    ports: { adminPort: puertoAdmin, clientPort: puertoAdmin + 1 },
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
    ports: { adminPort: 13630, clientPort: 13631 },
  });
  segunda.stop();
  fs.rmSync(primera.dataDir, { recursive: true, force: true });
});

/**
 * Anular una sanción, de punta a punta.
 *
 * Los tests del motor ya cubren la máquina de estados; lo que acá se comprueba es lo único que el
 * panel ve: que la ruta encuentre la sanción sin que le digan de qué motor salió, y que
 * `/api/state` la devuelva anulada en el poll siguiente.
 */
/**
 * Dos reinicios seguidos, sin que cambie nada en el medio, no tienen que perder lo recuperado.
 *
 * `restore()` no emite eventos (así no se le reenvía el mensaje de chat al piloto por una sanción
 * ya avisada), y por eso lo restaurado no pasaba por los listeners que escriben `penalty.state` en
 * el journal. El primer reinicio recuperaba bien, pero su propio journal quedaba sin ninguna línea
 * de estado — así que un SEGUNDO reinicio, leyendo ESE journal, no encontraba nada para restaurar
 * y la sanción (que seguía vigente de verdad) desaparecía. Ver el comentario en `raceControl.ts`
 * junto a `restoreState`.
 */
test("una sanción sobrevive a dos reinicios seguidos, no solo al primero", async () => {
  const primera = await levantar("doble-reinicio", 12640, 13640);
  const p = primera.rc.stewardPenaltyEngine.issuePenalty(7, "guid-7", "Comisario: corte de pista", "TIME", {
    timePenaltySeconds: 10,
  });
  primera.rc.stop();

  const segunda = await createRaceControl({
    config: configDePrueba(12640, 13640),
    dataDir: primera.dataDir,
    ports: { adminPort: 13640, clientPort: 13641 },
  });
  assert.equal(segunda.stewardPenaltyEngine.getAll().find((x) => x.id === p.id)?.status, p.status);
  segunda.stop();

  const tercera = await createRaceControl({
    config: configDePrueba(12640, 13640),
    dataDir: primera.dataDir,
    ports: { adminPort: 13640, clientPort: 13641 },
  });
  try {
    // Esta es la comprobación que fallaba antes del fix: sin la reescritura en el journal de
    // `segunda`, acá no había nada que restaurar.
    assert.equal(tercera.stewardPenaltyEngine.getAll().find((x) => x.id === p.id)?.status, p.status);
  } finally {
    tercera.stop();
    fs.rmSync(primera.dataDir, { recursive: true, force: true });
  }
});

test("se puede anular una sanción desde la API y el estado lo refleja", async () => {
  const { rc, dataDir } = await levantar("anular", 12650, 13650);
  // `createRaceControl` arma la app pero no escucha: quien abre el puerto es el entry. Acá se abre
  // en uno efímero para no chocar con nada.
  const server = http.createServer(rc.adminApp);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const p = rc.stewardPenaltyEngine.issuePenalty(4, "guid-4", "Comisario: toque en la curva 1", "TIME", {
      timePenaltySeconds: 10,
    });

    const res = await fetch(`${base}/api/penalties/${p.id}/revoke`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).penalty.status, "revoked");

    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    assert.equal(state.stewardPenalties.length, 1, "la anulada sigue en la lista");
    assert.equal(state.stewardPenalties[0].status, "revoked");

    // El doble click en el botón tiene que dar un error que se pueda leer, no un 500.
    const repetida = await fetch(`${base}/api/penalties/${p.id}/revoke`, { method: "POST" });
    assert.equal(repetida.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    limpiar(rc, dataDir);
  }
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

/**
 * El circuito se toma del `SESSION_INFO`, no solo del `NEW_SESSION`.
 *
 * El caso real del producto es conectar Race Control a un servidor de Assetto Corsa que ya viene
 * corriendo hace rato. Ahí `NEW_SESSION` no llega nunca —ese evento marca el ARRANQUE de una
 * sesión—, y hasta la 1.0 eso dejaba al `trackLearner` sin circuito para siempre. El síntoma en
 * pista fue Spa: el mapa vacío y, como `onCarUpdate` arranca con `if (!this.track) return`, los
 * autos tampoco aparecían. Dos bugs que parecían distintos y eran este.
 *
 * `SESSION_INFO` es la respuesta al `GET_SESSION_INFO` que el latido manda cada 5 segundos, así
 * que con esto el mapa sale a los 5 segundos de conectar, pase lo que pase.
 */
test("el circuito se carga aunque el servidor ya estuviera corriendo (sin NEW_SESSION)", async () => {
  const { rc, dataDir } = await levantar("pista", 12650, 13650);
  try {
    assert.equal(rc.trackLearner.isCatalogued(), false, "no debería haber circuito antes del primer paquete");

    // Lo que llega de un servidor que ya estaba en pista: la respuesta a nuestro propio pedido.
    rc.udpClient.emit("SESSION_INFO", {
      protocolVersion: 4,
      sessionIndex: 0,
      currentSessionIndex: 0,
      sessionCount: 1,
      serverName: "Liga de prueba",
      track: "spa",
      trackConfig: "",
      name: "Race",
      sessionType: 3,
      timeMinutes: 20,
      laps: 0,
      waitTimeSeconds: 0,
      ambientTemp: 20,
      roadTemp: 28,
      weatherGraphics: "3_clear",
      elapsedMs: 0,
    });

    assert.equal(rc.trackLearner.isCatalogued(), true, "spa está en el catálogo y tendría que haberse cargado");

    const outline = rc.trackLearner.getOutline();
    assert.ok(outline, "sin outline el panel recibe 204 y el mapa queda vacío");
    assert.ok(outline!.points.length > 100, `el trazado de Spa vino con ${outline!.points.length} puntos`);
    assert.equal(outline!.track, "spa");
  } finally {
    limpiar(rc, dataDir);
  }
});

const sesionDePrueba = (sessionType: number) => ({
  protocolVersion: 4,
  sessionIndex: 0,
  currentSessionIndex: 0,
  sessionCount: 1,
  serverName: "Liga de prueba",
  track: "spa",
  trackConfig: "",
  name: sessionType === 1 ? "Practice" : "Race",
  sessionType,
  timeMinutes: 20,
  laps: 0,
  waitTimeSeconds: 0,
  ambientTemp: 20,
  roadTemp: 28,
  weatherGraphics: "3_clear",
  elapsedMs: 0,
});

/**
 * El semáforo se apaga con la carrera, no se arrastra a la práctica siguiente.
 *
 * Hasta la 1.5, `formationStart` solo volvía a "idle" con el botón "Reiniciar" o con una sesión
 * nueva que venía de `finished` sin que el admin lo hubiera reseteado antes: dar verde, que la
 * carrera termine y que el servidor pase a práctica dejaba `lightState` en "green" para siempre.
 * El panel, que calcula "Carrera en curso" a partir de ese valor, mostraba la carrera corriendo
 * en medio de una práctica. Visto en pista, no en un test, que es justo el problema.
 */
test("el semáforo se apaga al pasar de carrera a práctica, aunque el END_SESSION nunca haya llegado", async () => {
  const { rc, dataDir } = await levantar("semaforo", 12660, 13660);
  try {
    rc.udpClient.emit("NEW_SESSION", sesionDePrueba(3));
    rc.formationStart.beginFormation();
    rc.formationStart.triggerGreen();
    assert.equal(rc.formationStart.getLightState(), "green");
    assert.equal(rc.phaseTracker.get(), "race");

    // El END_SESSION no todos los hostings lo mandan: el reset tiene que valer sin él.
    rc.udpClient.emit("NEW_SESSION", sesionDePrueba(1));

    assert.equal(rc.formationStart.getLightState(), "idle", "el semáforo quedó en verde en la práctica siguiente");
    assert.equal(rc.phaseTracker.get(), "idle", "la fase siguió en carrera en la práctica siguiente");
  } finally {
    limpiar(rc, dataDir);
  }
});
