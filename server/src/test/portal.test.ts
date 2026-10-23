import { strict as assert } from "assert";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { after, before, test } from "node:test";
import { createPortal, Portal } from "../portal/server";

/**
 * El portal es lo único que da a internet, así que lo que se verifica acá es quién pasa y quién
 * no — no que el panel funcione (eso es el worker, y vive en otros tests).
 *
 * Los workers no se levantan: forkear un proceso por liga para comprobar un 403 sería pagar
 * segundos por test para nada. En su lugar, `supervisor.start` se anula y se pone un servidor
 * HTTP de mentira en el puerto de la liga, que devuelve lo que recibió. Así se puede afirmar algo
 * que de otro modo no se ve: QUÉ headers llegan del otro lado.
 */

let portal: Portal;
let base: string;
let dataRoot: string;
const cerrar: Array<() => void> = [];

/** Lo que el worker falso vio del request que le reenviaron. */
interface Espejo {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function servidorEspejo(): Promise<{ port: number; ultimo: () => Espejo | null }> {
  let ultimo: Espejo | null = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      ultimo = { method: req.method || "", url: req.url || "", headers: req.headers, body };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ espejo: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      cerrar.push(() => server.close());
      resolve({ port: (server.address() as import("net").AddressInfo).port, ultimo: () => ultimo });
    });
  });
}

interface Respuesta {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => any;
}

function pedir(
  method: string,
  ruta: string,
  opciones: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<Respuesta> {
  return new Promise((resolve, reject) => {
    const payload = opciones.body === undefined ? null : JSON.stringify(opciones.body);
    const headers: Record<string, string> = { ...opciones.headers };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    if (opciones.cookie) headers.cookie = opciones.cookie;

    const req = http.request(`${base}${ruta}`, { method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body,
          json: () => JSON.parse(body),
        })
      );
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Acepta la invitación eligiendo contraseña y devuelve la cookie de sesión que quedó abierta. */
async function aceptar(inviteUrl: string, password: string): Promise<string> {
  const token = inviteUrl.split("/").pop()!;
  const res = await pedir("POST", `/api/portal/invitacion/${token}`, {
    body: { password },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 200, res.body);
  const setCookie = res.headers["set-cookie"]?.[0] || "";
  return setCookie.split(";")[0];
}

let cookieA = "";
let cookieB = "";
let espejoAdmin: { port: number; ultimo: () => Espejo | null };
let espejoPilotos: { port: number; ultimo: () => Espejo | null };

before(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rc-portal-"));
  portal = createPortal({
    port: 0,
    dataRoot,
    publicHost: "race-control.test",
    publicIp: "203.0.113.5",
    udpPortFrom: 39000,
    udpPortTo: 39009,
    loopbackPortFrom: 39100,
    // Sin HTTPS no hay `__Host-` ni redirección a https: es el mismo modo que se usa para
    // desarrollar contra el portal en la máquina propia.
    secureCookies: false,
  });
  // Nada de forkear workers de verdad.
  portal.supervisor.start = () => {};

  const server = http.createServer(portal.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("net").AddressInfo;
  base = `http://127.0.0.1:${port}`;
  cerrar.push(() => server.close());

  const a = portal.createLeague({ slug: "liga-a", name: "Liga A", email: "ana@example.com" });
  const b = portal.createLeague({ slug: "liga-b", name: "Liga B", email: "beto@example.com" });

  espejoAdmin = await servidorEspejo();
  espejoPilotos = await servidorEspejo();
  // Los puertos reales del worker se reemplazan por los de los espejos. `leagues()` devuelve las
  // mismas referencias que usa el portal, así que alcanza con escribirles encima.
  const ligaA = portal.store.findLeagueBySlug("liga-a")!;
  ligaA.adminPort = espejoAdmin.port;
  ligaA.clientPort = espejoPilotos.port;

  cookieA = await aceptar(a.inviteUrl, "contrasena-larga-1");
  cookieB = await aceptar(b.inviteUrl, "contrasena-larga-2");
});

after(() => {
  for (const fn of cerrar) fn();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

// --- Quién pasa y quién no ---------------------------------------------------------------------

test("sin sesión, una API de liga contesta 401 en JSON", async () => {
  const res = await pedir("GET", "/l/liga-a/api/state");
  assert.equal(res.status, 401);
  assert.equal(res.json().ok, false);
});

test("sin sesión, una navegación va al login y vuelve a donde estaba", async () => {
  const res = await pedir("GET", "/l/liga-a/sanciones");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/login?volver=%2Fl%2Fliga-a%2Fsanciones");
});

test("el admin de una liga no entra a la liga de al lado", async () => {
  // Es la propiedad central del multi-liga: una sesión válida no alcanza, tiene que ser válida
  // PARA ESA liga.
  const res = await pedir("GET", "/l/liga-a/api/state", { cookie: cookieB });
  assert.equal(res.status, 403);
});

test("una liga que no existe es 404, y un slug raro también", async () => {
  assert.equal((await pedir("GET", "/l/no-existe/", { cookie: cookieA })).status, 404);
  assert.equal((await pedir("GET", "/l/LIGA-A/", { cookie: cookieA })).status, 404);
  assert.equal((await pedir("GET", "/l/..%2F..%2Fetc/", { cookie: cookieA })).status, 404);
});

test("sin la barra final redirige, para que el panel resuelva bien sus archivos", async () => {
  const res = await pedir("GET", "/l/liga-a?x=1", { cookie: cookieA });
  assert.equal(res.status, 308);
  assert.equal(res.headers.location, "/l/liga-a/?x=1");
});

// --- CSRF --------------------------------------------------------------------------------------

test("un POST sin la marca de origen no llega al worker", async () => {
  const res = await pedir("POST", "/l/liga-a/api/config", { cookie: cookieA, body: { leagueName: "X" } });
  assert.equal(res.status, 403);
});

test("un POST desde otro origen tampoco", async () => {
  const res = await pedir("POST", "/l/liga-a/api/config", {
    cookie: cookieA,
    body: { leagueName: "X" },
    headers: { "x-rc-request": "1", origin: "https://sitio-ajeno.example" },
  });
  assert.equal(res.status, 403);
});

test("con la marca y el origen propio, el POST pasa con el cuerpo intacto", async () => {
  // Que el cuerpo llegue entero no es un detalle: el portal no puede parsear el JSON antes de
  // reenviarlo o el worker recibiría un POST vacío.
  const res = await pedir("POST", "/l/liga-a/api/config", {
    cookie: cookieA,
    body: { leagueName: "Fórmula Sur" },
    headers: { "x-rc-request": "1", origin: "http://race-control.test" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(espejoAdmin.ultimo()!.body), { leagueName: "Fórmula Sur" });
});

// --- Lo que llega del otro lado ------------------------------------------------------------------

test("el worker recibe quién pidió, y no la cookie de sesión", async () => {
  const res = await pedir("GET", "/l/liga-a/api/state", { cookie: cookieA });
  assert.equal(res.status, 200);
  const visto = espejoAdmin.ultimo()!;
  assert.equal(visto.headers["x-rc-user"], "ana@example.com");
  assert.equal(visto.headers.cookie, undefined);
  assert.equal(visto.url, "/api/state");
});

test("nadie puede firmar sus acciones con el nombre de otro", async () => {
  // Sin esto, el `x-rc-user` que el worker anota en la auditoría sería el que mandó el atacante.
  const res = await pedir("GET", "/l/liga-a/api/state", {
    cookie: cookieA,
    headers: { "x-rc-user": "otro@example.com" },
  });
  assert.equal(res.status, 200);
  assert.equal(espejoAdmin.ultimo()!.headers["x-rc-user"], "ana@example.com");
});

// --- Canal de pilotos ----------------------------------------------------------------------------

test("la app del piloto entra sin sesión y va al puerto de pilotos", async () => {
  // No tiene cookie ni puede tenerla: corre dentro del juego. Quien decide si pasa es el worker,
  // mirando el token firmado (ver pilotToken.test.ts).
  const res = await pedir("GET", "/l/liga-a/api/client/poll");
  assert.equal(res.status, 200);
  assert.equal(espejoPilotos.ultimo()!.url, "/api/client/poll");
});

test("el canal de pilotos no sirve para colarse al panel", async () => {
  const res = await pedir("GET", "/l/liga-a/api/client/../state");
  // El cliente HTTP normaliza `..` antes de salir, así que lo que llega es `/l/liga-a/api/state`:
  // sin sesión, 401. Lo que importa es que NO termine en el puerto del panel.
  assert.equal(res.status, 401);
});

// --- Portal ---------------------------------------------------------------------------------------

test("sin sesión el portal no cuenta nada de nadie", async () => {
  const res = await pedir("GET", "/api/portal/me");
  assert.equal(res.status, 200);
  assert.equal(res.json().authenticated, false);
  assert.equal(res.json().leagues, undefined);
});

test("con sesión, el portal lista solo las ligas propias", async () => {
  const res = await pedir("GET", "/api/portal/me", { cookie: cookieA });
  const data = res.json();
  assert.equal(data.authenticated, true);
  assert.deepEqual(
    data.leagues.map((l: { slug: string }) => l.slug),
    ["liga-a"]
  );
  assert.equal(data.leagues[0].sendAddress, "203.0.113.5:39000");
});

test("la invitación es de un solo uso", async () => {
  const { inviteUrl } = portal.createLeague({ slug: "liga-c", name: "Liga C", email: "caro@example.com" });
  const token = inviteUrl.split("/").pop()!;
  await aceptar(inviteUrl, "contrasena-larga-3");

  const segunda = await pedir("POST", `/api/portal/invitacion/${token}`, {
    body: { password: "otra-contrasena-larga" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(segunda.status, 404);
});

test("una contraseña corta no se acepta", async () => {
  const { inviteUrl } = portal.createLeague({ slug: "liga-d", name: "Liga D", email: "dani@example.com" });
  const token = inviteUrl.split("/").pop()!;
  const res = await pedir("POST", `/api/portal/invitacion/${token}`, {
    body: { password: "corta" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 400);
});

test("el login deja entrar y el logout cierra de verdad", async () => {
  const login = await pedir("POST", "/api/portal/login", {
    body: { email: "ANA@example.com", password: "contrasena-larga-1" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers["set-cookie"]?.[0] || "").split(";")[0];

  assert.equal((await pedir("GET", "/api/portal/me", { cookie })).json().authenticated, true);
  await pedir("POST", "/api/portal/logout", { cookie, headers: { "x-rc-request": "1" } });
  assert.equal((await pedir("GET", "/api/portal/me", { cookie })).json().authenticated, false);
});

test("una contraseña equivocada no entra", async () => {
  const res = await pedir("POST", "/api/portal/login", {
    body: { email: "ana@example.com", password: "la-que-no-es" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 401);
});

test("las pantallas del portal salen con sus cabeceras de seguridad", async () => {
  const res = await pedir("GET", "/");
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(String(res.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.match(String(res.headers["content-security-policy"]), /script-src 'self'/);
});
