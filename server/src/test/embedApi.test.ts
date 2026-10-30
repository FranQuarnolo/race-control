import { strict as assert } from "assert";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import { parseConfig } from "../config";
import { createRaceControl, RaceControl } from "../core/raceControl";

/**
 * El canal `/api/embed/*`, de punta a punta.
 *
 * Mismo patrón que `core.test.ts` (dos instancias del núcleo, `adminApp` escuchando en un puerto
 * efímero), pero acá lo que se prueba es la frontera de seguridad nueva: sin token no hay nada,
 * con el origen que no es, tampoco, y lo que SÍ entra tiene que salir sin `driverGuid` ni datos de
 * red internos. La paridad de negocio (resolver un incidente o anular una sanción por este canal
 * hace exactamente lo mismo que por el panel) se prueba reusando el mismo `/api/state` de siempre.
 */

const ORIGEN = "https://fslmanager.vercel.app";

function carpetaTemporal(sufijo: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rc-embed-api-${sufijo}-`));
}

function configDePrueba(puertoUdp: number, puertoAdmin: number): ReturnType<typeof parseConfig> {
  return parseConfig({
    leagueName: `Liga embed ${puertoUdp}`,
    http: { adminPort: puertoAdmin, clientPort: puertoAdmin + 1, publicHost: "203.0.113.5" },
    acUdp: { localPort: puertoUdp, remoteHost: "127.0.0.1", remotePort: puertoUdp + 500, remotePortSource: "manual" },
    embed: { allowedOrigin: ORIGEN, tokenVersion: 1 },
  });
}

async function levantar(sufijo: string, puertoUdp: number, puertoAdmin: number) {
  const dataDir = carpetaTemporal(sufijo);
  const rc = await createRaceControl({
    config: configDePrueba(puertoUdp, puertoAdmin),
    dataDir,
    ports: { adminPort: puertoAdmin, clientPort: puertoAdmin + 1 },
  });
  const server = http.createServer(rc.adminApp);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { rc, dataDir, server, base };
}

async function limpiar(rc: RaceControl, dataDir: string, server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rc.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function token(base: string): Promise<string> {
  const res = await fetch(`${base}/api/embed-token`);
  return ((await res.json()) as any).token;
}

const sesionDeCarrera = {
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
};

test("sin Authorization, el embed responde 401", async () => {
  const { rc, dataDir, server, base } = await levantar("sin-auth", 12910, 13910);
  try {
    const res = await fetch(`${base}/api/embed/state`, { headers: { Origin: ORIGEN } });
    assert.equal(res.status, 401);
  } finally {
    await limpiar(rc, dataDir, server);
  }
});

test("sin el origen configurado, el embed responde 403 y no deja cabecera CORS puesta", async () => {
  const dataDir = carpetaTemporal("sin-origen");
  const rc = await createRaceControl({
    config: parseConfig({
      leagueName: "Liga sin origen",
      http: { adminPort: 13920, clientPort: 13921, publicHost: "203.0.113.5" },
      acUdp: { localPort: 12920, remoteHost: "127.0.0.1", remotePort: 13421, remotePortSource: "manual" },
      // embedAllowedOrigin queda en "" (el default): a propósito, el embed no tiene que responder
      // a nadie hasta que el admin lo configure a mano.
    }),
    dataDir,
    ports: { adminPort: 13920, clientPort: 13921 },
  });
  const server = http.createServer(rc.adminApp);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const tok = await token(base);
    const res = await fetch(`${base}/api/embed/state`, {
      headers: { Origin: ORIGEN, Authorization: `Bearer ${tok}` },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await limpiar(rc, dataDir, server);
  }
});

test("con un origen que no es el configurado, 403", async () => {
  const { rc, dataDir, server, base } = await levantar("origen-distinto", 12930, 13930);
  try {
    const tok = await token(base);
    const res = await fetch(`${base}/api/embed/state`, {
      headers: { Origin: "https://otra-pagina.cualquiera", Authorization: `Bearer ${tok}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await limpiar(rc, dataDir, server);
  }
});

test("el token de una liga no vale en otra, aunque las dos tengan el mismo origen configurado", async () => {
  const a = await levantar("cruzado-a", 12940, 13940);
  const b = await levantar("cruzado-b", 12950, 13950);
  try {
    const tokenDeA = await token(a.base);
    const res = await fetch(`${b.base}/api/embed/state`, {
      headers: { Origin: ORIGEN, Authorization: `Bearer ${tokenDeA}` },
    });
    assert.equal(res.status, 401);
  } finally {
    await limpiar(a.rc, a.dataDir, a.server);
    await limpiar(b.rc, b.dataDir, b.server);
  }
});

test("regenerar el token invalida el viejo al instante", async () => {
  const { rc, dataDir, server, base } = await levantar("regenerar", 12960, 13960);
  try {
    const tokenViejo = await token(base);
    const regen = await fetch(`${base}/api/embed-token/regenerate`, { method: "POST" });
    const tokenNuevo = ((await regen.json()) as any).token;
    assert.notEqual(tokenViejo, tokenNuevo);

    const conElViejo = await fetch(`${base}/api/embed/state`, {
      headers: { Origin: ORIGEN, Authorization: `Bearer ${tokenViejo}` },
    });
    assert.equal(conElViejo.status, 401);

    const conElNuevo = await fetch(`${base}/api/embed/state`, {
      headers: { Origin: ORIGEN, Authorization: `Bearer ${tokenNuevo}` },
    });
    assert.equal(conElNuevo.status, 200);
  } finally {
    await limpiar(rc, dataDir, server);
  }
});

/**
 * Lo que puede terminar visible en "Ver código fuente" de una página ajena no puede traer el
 * SteamID de nadie ni a dónde le mandamos nosotros los comandos al servidor de AC.
 */
test("el estado del embed no trae driverGuid ni los datos de red internos", async () => {
  const { rc, dataDir, server, base } = await levantar("redaccion", 12970, 13970);
  try {
    rc.stateTracker.onNewConnection({
      driverName: "Piloto Visible",
      driverGuid: "76561190000000009",
      carId: 7,
      carModel: "ks_mazda_mx5",
      carSkin: "red",
    } as never);
    const p = rc.stewardPenaltyEngine.issuePenalty(7, "76561190000000009", "Comisario: toque", "TIME", {
      timePenaltySeconds: 5,
    });
    assert.ok(p);

    const tok = await token(base);
    const res = await fetch(`${base}/api/embed/state`, {
      headers: { Origin: ORIGEN, Authorization: `Bearer ${tok}` },
    });
    assert.equal(res.status, 200);
    const crudo = JSON.stringify(await res.json());
    assert.ok(!crudo.includes("driverGuid"), "driverGuid no debería salir de esta liga");
    assert.ok(!crudo.includes("76561190000000009"), "el SteamID no debería salir de esta liga");
    assert.ok(!crudo.includes("sendAddress"), "a dónde mandamos los comandos es dato interno");
    assert.ok(!crudo.includes("acServer"), "la identificación del servidor de AC es dato interno");
  } finally {
    await limpiar(rc, dataDir, server);
  }
});

test("resolver un incidente por el canal de embed queda igual de resuelto que por el panel", async () => {
  const { rc, dataDir, server, base } = await levantar("incidente", 12980, 13980);
  try {
    rc.udpClient.emit("NEW_SESSION", sesionDeCarrera);
    rc.stateTracker.onNewConnection({ driverName: "A", driverGuid: "guid-a", carId: 3, carModel: "x", carSkin: "y" } as never);
    rc.stateTracker.onNewConnection({ driverName: "B", driverGuid: "guid-b", carId: 9, carModel: "x", carSkin: "y" } as never);
    const v3 = (x: number, y: number, z: number) => ({ x, y, z });
    rc.incidentEngine.onClientEvent({
      eventType: 10,
      carId: 3,
      otherCarId: 9,
      impactSpeed: 80,
      worldPosition: v3(0, 0, 0),
      relPosition: v3(0, 0, 2),
    } as never);
    rc.incidentEngine.onClientEvent({
      eventType: 10,
      carId: 9,
      otherCarId: 3,
      impactSpeed: 80,
      worldPosition: v3(0, 0, 0),
      relPosition: v3(0, 0, -2),
    } as never);
    const pendiente = rc.incidentEngine.getPending()[0];
    assert.ok(pendiente, "el toque entre dos perspectivas tendría que haber generado un incidente");

    const tok = await token(base);
    const res = await fetch(`${base}/api/embed/incidents/${pendiente.id}/resolve`, {
      method: "POST",
      headers: { Origin: ORIGEN, Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    assert.equal(res.status, 200);

    const estado = (await (await fetch(`${base}/api/state`)).json()) as any;
    const resuelto = estado.incidents.find((i: any) => i.id === pendiente.id);
    assert.equal(resuelto.status, "dismissed");
  } finally {
    await limpiar(rc, dataDir, server);
  }
});

test("anular una sanción por el canal de embed queda igual de anulada que por el panel", async () => {
  const { rc, dataDir, server, base } = await levantar("sancion", 12990, 13990);
  try {
    const p = rc.stewardPenaltyEngine.issuePenalty(4, "guid-4", "Comisario: toque en la curva 1", "TIME", {
      timePenaltySeconds: 10,
    });

    const tok = await token(base);
    const res = await fetch(`${base}/api/embed/penalties/${p.id}/revoke`, {
      method: "POST",
      headers: { Origin: ORIGEN, Authorization: `Bearer ${tok}` },
    });
    assert.equal(res.status, 200);

    const estado = (await (await fetch(`${base}/api/state`)).json()) as any;
    assert.equal(estado.stewardPenalties.find((x: any) => x.id === p.id).status, "revoked");
  } finally {
    await limpiar(rc, dataDir, server);
  }
});

test("la largada por el canal de embed mueve el mismo semáforo que el panel", async () => {
  const { rc, dataDir, server, base } = await levantar("largada", 12900, 13900);
  try {
    rc.udpClient.emit("NEW_SESSION", sesionDeCarrera);
    const tok = await token(base);
    const headers = { Origin: ORIGEN, Authorization: `Bearer ${tok}` };

    const begin = await fetch(`${base}/api/embed/formation/begin`, { method: "POST", headers });
    assert.equal(((await begin.json()) as any).lightState, "formation");

    const green = await fetch(`${base}/api/embed/formation/green`, { method: "POST", headers });
    assert.equal(((await green.json()) as any).lightState, "green");

    assert.equal(rc.formationStart.getLightState(), "green", "el motor real tiene que haberse movido, no solo la respuesta");

    const reset = await fetch(`${base}/api/embed/formation/reset`, { method: "POST", headers });
    assert.equal(((await reset.json()) as any).lightState, "idle");
  } finally {
    await limpiar(rc, dataDir, server);
  }
});
