import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { test } from "node:test";
import { parseConfig } from "../config";
import { createRaceControl, RaceControl } from "../core/raceControl";
import { PilotTokenIssuer } from "../security/pilotToken";

/**
 * Lo que la app del piloto muestra arriba de todo: el contador de cortes y lo que debe.
 *
 * Se prueba contra el motor entero y entrando por el HTTP real, no llamando a `getPilotStatus`
 * suelto, porque ese dato cruza tres piezas que no se conocen entre sí —el contador vive en
 * `TrackLimitsTracker`, las sanciones en tres motores distintos, y el cableado en `raceControl`—
 * y lo que se rompe es el cable, no las piezas. Es el mismo criterio de `speedingIncidents`.
 *
 * El reparto de la cola de avisos (que es otra cosa, y viaja aparte) se prueba en
 * `pilotMessages.test.ts`.
 */

interface Montado {
  rc: RaceControl;
  /** Pregunta el estado como lo hace la app: GET al poll, con la credencial de ese piloto. */
  estado: (guid: string) => Promise<{ cuts: number; cutsLimit: number; penalty: string | null }>;
  cerrar: () => void;
}

async function montar(sufijo: string, puertoUdp: number, puertoAdmin: number): Promise<Montado> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `rc-status-${sufijo}-`));
  const config = parseConfig({
    leagueName: "Liga de prueba",
    http: { adminPort: puertoAdmin, clientPort: puertoAdmin + 1, publicHost: "203.0.113.5" },
    acUdp: { localPort: puertoUdp, remoteHost: "127.0.0.1", remotePort: puertoUdp + 500, remotePortSource: "manual" },
  });
  const rc = await createRaceControl({
    config,
    dataDir,
    ports: { adminPort: puertoAdmin, clientPort: puertoAdmin + 1 },
  });

  // El mismo `dataDir` que el motor: la clave se guarda en disco la primera vez, así que este
  // emisor firma con la misma que el motor va a verificar. Sin token el poll devuelve 401, y con
  // razón — el canal del piloto es el único que sale a internet.
  const tokens = new PilotTokenIssuer(dataDir);

  const server = rc.clientApp.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const puerto = (server.address() as AddressInfo).port;

  return {
    rc,
    estado: async (guid: string) => {
      const res = await fetch(`http://127.0.0.1:${puerto}/api/client/poll?since=0&guid=${guid}`, {
        headers: { Authorization: `Bearer ${tokens.issue(guid)}` },
      });
      return ((await res.json()) as { status: { cuts: number; cutsLimit: number; penalty: string | null } }).status;
    },
    cerrar: () => {
      server.close();
      rc.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function conectar(rc: RaceControl, carId: number, nombre: string): string {
  const driverGuid = String(76561190000000000n + BigInt(carId));
  rc.stateTracker.onNewConnection({
    carId,
    driverName: nombre,
    driverGuid,
    carModel: "ks_ferrari_488_gt3",
    carSkin: "default",
  } as never);
  return driverGuid;
}

test("el contador cuenta los cortes del servidor y se reinicia al llegar al tope", async () => {
  const m = await montar("cortes", 12740, 13740);
  try {
    const guid = conectar(m.rc, 3, "Rocío Vidal");
    const tope = m.rc.config.infractions.trackLimits.excursionsForIncident;
    assert.ok(tope >= 2, "el test asume un tope de al menos 2 cortes");

    assert.deepEqual(await m.estado(guid), { cuts: 0, cutsLimit: tope, penalty: null });

    // Una vuelta invalidada por un corte. 95 s es una vuelta plausible (el tracker descarta las
    // de menos de 15 s, que son reinicios y teletransportes a boxes).
    m.rc.trackLimits.onLapCompleted(3, 95_000, 1);
    assert.equal((await m.estado(guid)).cuts, 1);

    // Hasta el tope. El que lo alcanza reinicia la cuenta: el piloto tiene que ver 0 y no "6/5",
    // porque a partir de ahí le vuelven a quedar las cinco.
    for (let i = 1; i < tope; i++) m.rc.trackLimits.onLapCompleted(3, 95_000, 1);
    assert.equal((await m.estado(guid)).cuts, 0, "al llegar al tope la cuenta arranca de nuevo");

    m.rc.trackLimits.onLapCompleted(3, 95_000, 1);
    assert.equal((await m.estado(guid)).cuts, 1, "y sigue contando desde ahí");
  } finally {
    m.cerrar();
  }
});

test("la sanción pendiente llega con las vueltas de gracia que quedan", async () => {
  const m = await montar("sancion", 12750, 13750);
  try {
    const guid = conectar(m.rc, 5, "Martín Olaguer");
    assert.equal((await m.estado(guid)).penalty, null);

    m.rc.stewardPenaltyEngine.issuePenalty(5, guid, "Contacto en la curva 1", "DT");
    const texto = (await m.estado(guid)).penalty;
    assert.ok(texto, "la sanción no llegó a la app");
    assert.ok(texto!.includes("DRIVE THROUGH"), "el texto no dice qué tiene que cumplir: " + texto);
    assert.ok(/vuelta/.test(texto!), "el texto no dice cuántas vueltas le quedan: " + texto);
  } finally {
    m.cerrar();
  }
});

/**
 * La sanción se busca por `driverGuid` y no por `carId`, y esto es lo que lo comprueba.
 *
 * Los motores indexan por slot porque el UDP de AC habla de slots, pero el slot cambia al
 * reconectarse: el mismo piloto vuelve como otro auto. Buscando por `carId`, la app le diría a
 * quien se reconectó que no debe nada —justo al que más le importa saberlo— y el Drive-Through le
 * escalaría a descalificación mientras ve la pantalla limpia.
 */
test("la sanción sigue a la persona, no al slot: sobrevive a una reconexión", async () => {
  const m = await montar("reconexion", 12760, 13760);
  try {
    const guid = conectar(m.rc, 8, "Ezequiel Pratt");
    m.rc.stewardPenaltyEngine.issuePenalty(8, guid, "Adelantamiento con bandera amarilla", "DT");

    // Se cae y vuelve en otro slot, que es lo que hace el servidor de AC cuando se libera uno.
    m.rc.stateTracker.onConnectionClosed({ carId: 8, driverGuid: guid } as never);
    m.rc.stateTracker.onNewConnection({
      carId: 19,
      driverName: "Ezequiel Pratt",
      driverGuid: guid,
      carModel: "ks_ferrari_488_gt3",
      carSkin: "default",
    } as never);

    const texto = (await m.estado(guid)).penalty;
    assert.ok(texto && texto.includes("DRIVE THROUGH"), "la sanción se perdió al reconectarse: " + texto);
  } finally {
    m.cerrar();
  }
});

test("una sanción ya cumplida deja de mostrarse", async () => {
  const m = await montar("cumplida", 12770, 13770);
  try {
    const guid = conectar(m.rc, 11, "Sofía Arrieta");
    const sancion = m.rc.stewardPenaltyEngine.issuePenalty(11, guid, "Exceso en pit lane", "DT");
    assert.ok((await m.estado(guid)).penalty);

    m.rc.stewardPenaltyEngine.markServed(sancion.id);
    assert.equal((await m.estado(guid)).penalty, null, "la app seguiría mostrando una sanción ya cumplida");
  } finally {
    m.cerrar();
  }
});
