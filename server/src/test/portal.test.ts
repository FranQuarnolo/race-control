import { strict as assert } from "assert";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { after, before, test } from "node:test";
import { createPortal, Portal } from "../portal/server";
import { LeagueEventsStore } from "../history/leagueEvents";

/**
 * El portal es lo único que da a internet, así que lo que se verifica acá es quién pasa y quién
 * no — no que el panel funcione (eso es el worker, y vive en otros tests).
 *
 * Los workers no se levantan: forkear un proceso por servidor para comprobar un 403 sería pagar
 * segundos por test para nada. En su lugar, `supervisor.start` se anula y se pone un servidor
 * HTTP de mentira en el puerto de cada servidor, que devuelve lo que recibió. Así se puede afirmar
 * algo que de otro modo no se ve: QUÉ headers llegan del otro lado.
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

/** Entra con usuario y contraseña y devuelve la cookie de sesión que quedó abierta. */
async function entrar(email: string, password: string): Promise<string> {
  const res = await pedir("POST", "/api/portal/login", {
    body: { email, password },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 200, res.body);
  const setCookie = res.headers["set-cookie"]?.[0] || "";
  return setCookie.split(";")[0];
}

/** El servidor que `createLiga`/`altaDePrueba` crea junto con la liga: hoy toda cuenta de prueba
 * tiene exactamente uno, así que "el primero" es "el único". */
function primerServidor(ligaId: string) {
  return portal.store.servidoresDeLiga(ligaId)[0];
}

const CLAVE_A = "contrasena-larga-1";
const CLAVE_B = "contrasena-larga-2";
const CLAVE_OP = "contrasena-del-operador";

let cookieA = "";
let cookieB = "";
let cookieOp = "";
let ligaAId = "";
let servidorAId = "";
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
    // Rango holgado a propósito: varios tests dan de alta su propia liga para no pisar las de los
    // demás, y un pool justo haría que el alta fallara por cupo y el test mintiera sobre la causa.
    udpPortTo: 39049,
    loopbackPortFrom: 39100,
    // Sin HTTPS no hay `__Host-` ni redirección a https: es el mismo modo que se usa para
    // desarrollar contra el portal en la máquina propia.
    secureCookies: false,
    contact: "mailto:hola@race.test",
  });
  // Nada de forkear workers de verdad.
  portal.supervisor.start = () => {};

  const server = http.createServer(portal.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("net").AddressInfo;
  base = `http://127.0.0.1:${port}`;
  cerrar.push(() => server.close());

  const credsA = await portal.createLiga({ slug: "liga-a", name: "Liga A", email: "ana@example.com", password: CLAVE_A });
  await portal.createLiga({ slug: "liga-b", name: "Liga B", email: "beto@example.com", password: CLAVE_B });
  await portal.ensureOperator("jefe@example.com", CLAVE_OP);

  espejoAdmin = await servidorEspejo();
  espejoPilotos = await servidorEspejo();
  // Los puertos reales del worker se reemplazan por los de los espejos. `servidoresDeLiga` devuelve
  // las mismas referencias que usa el portal, así que alcanza con escribirles encima.
  ligaAId = credsA.liga.id;
  const servidorA = primerServidor(ligaAId);
  servidorA.adminPort = espejoAdmin.port;
  servidorA.clientPort = espejoPilotos.port;
  servidorAId = servidorA.id;

  cookieA = await entrar("ana@example.com", CLAVE_A);
  cookieB = await entrar("beto@example.com", CLAVE_B);
  cookieOp = await entrar("jefe@example.com", CLAVE_OP);
});

after(() => {
  for (const fn of cerrar) fn();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

// --- Quién pasa y quién no ---------------------------------------------------------------------

test("sin sesión, una API de servidor contesta 401 en JSON", async () => {
  const res = await pedir("GET", `/l/liga-a/s/${servidorAId}/api/state`);
  assert.equal(res.status, 401);
  assert.equal(res.json().ok, false);
});

test("sin sesión, una navegación va al login y vuelve a donde estaba", async () => {
  const res = await pedir("GET", `/l/liga-a/s/${servidorAId}/sanciones`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/login?volver=${encodeURIComponent(`/l/liga-a/s/${servidorAId}/sanciones`)}`);
});

test("el admin de una liga no entra a la liga de al lado", async () => {
  // Es la propiedad central del multi-liga: una sesión válida no alcanza, tiene que ser válida
  // PARA ESA liga.
  const res = await pedir("GET", `/l/liga-a/s/${servidorAId}/api/state`, { cookie: cookieB });
  assert.equal(res.status, 403);
});

test("una liga que no existe es 404, y un slug raro también", async () => {
  assert.equal((await pedir("GET", "/l/no-existe/", { cookie: cookieA })).status, 404);
  assert.equal((await pedir("GET", "/l/LIGA-A/", { cookie: cookieA })).status, 404);
  assert.equal((await pedir("GET", "/l/..%2F..%2Fetc/", { cookie: cookieA })).status, 404);
});

test("un servidor que no existe, o que es de otra liga, es 404", async () => {
  assert.equal((await pedir("GET", "/l/liga-a/s/no-existe/", { cookie: cookieA })).status, 404);
  const servidorB = primerServidor((await portal.store.findLigaBySlug("liga-b"))!.id);
  assert.equal((await pedir("GET", `/l/liga-a/s/${servidorB.id}/`, { cookie: cookieA })).status, 404);
});

test("sin /s/<id> en el path, redirige al primer servidor de la liga con el resto del path pegado atrás", async () => {
  const res = await pedir("GET", "/l/liga-a?x=1", { cookie: cookieA });
  assert.equal(res.status, 308);
  assert.equal(res.headers.location, `/l/liga-a/s/${servidorAId}/?x=1`);

  // Lo mismo para un bookmark viejo con un sub-path, de antes de que existiera el selector.
  const conSubpath = await pedir("GET", "/l/liga-a/sanciones", { cookie: cookieA });
  assert.equal(conSubpath.status, 308);
  assert.equal(conSubpath.headers.location, `/l/liga-a/s/${servidorAId}/sanciones`);
});

// --- CSRF --------------------------------------------------------------------------------------

test("un POST sin la marca de origen no llega al worker", async () => {
  const res = await pedir("POST", `/l/liga-a/s/${servidorAId}/api/config`, { cookie: cookieA, body: { leagueName: "X" } });
  assert.equal(res.status, 403);
});

test("un POST desde otro origen tampoco", async () => {
  const res = await pedir("POST", `/l/liga-a/s/${servidorAId}/api/config`, {
    cookie: cookieA,
    body: { leagueName: "X" },
    headers: { "x-rc-request": "1", origin: "https://sitio-ajeno.example" },
  });
  assert.equal(res.status, 403);
});

test("con la marca y el origen propio, el POST pasa con el cuerpo intacto", async () => {
  // Que el cuerpo llegue entero no es un detalle: el portal no puede parsear el JSON antes de
  // reenviarlo o el worker recibiría un POST vacío.
  const res = await pedir("POST", `/l/liga-a/s/${servidorAId}/api/config`, {
    cookie: cookieA,
    body: { leagueName: "Fórmula Sur" },
    headers: { "x-rc-request": "1", origin: "http://race-control.test" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(espejoAdmin.ultimo()!.body), { leagueName: "Fórmula Sur" });
});

// --- Lo que llega del otro lado ------------------------------------------------------------------

test("el worker recibe quién pidió, y no la cookie de sesión", async () => {
  const res = await pedir("GET", `/l/liga-a/s/${servidorAId}/api/state`, { cookie: cookieA });
  assert.equal(res.status, 200);
  const visto = espejoAdmin.ultimo()!;
  assert.equal(visto.headers["x-rc-user"], "ana@example.com");
  assert.equal(visto.headers.cookie, undefined);
  // El `/s/<id>` no viaja al worker: cada worker ya sabe quién es, con el path pelado alcanza.
  assert.equal(visto.url, "/api/state");
});

test("nadie puede firmar sus acciones con el nombre de otro", async () => {
  // Sin esto, el `x-rc-user` que el worker anota en la auditoría sería el que mandó el atacante.
  const res = await pedir("GET", `/l/liga-a/s/${servidorAId}/api/state`, {
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
  const res = await pedir("GET", `/l/liga-a/s/${servidorAId}/api/client/poll`);
  assert.equal(res.status, 200);
  assert.equal(espejoPilotos.ultimo()!.url, "/api/client/poll");
});

test("el canal de pilotos no sirve para colarse al panel", async () => {
  const res = await pedir("GET", `/l/liga-a/s/${servidorAId}/api/client/../state`);
  // El cliente HTTP normaliza `..` antes de salir, así que lo que llega es
  // `/l/liga-a/s/<id>/api/state`: sin sesión, 401. Lo que importa es que NO termine en el puerto
  // del panel.
  assert.equal(res.status, 401);
});

// --- Bundle del embed (embed.js / embed.css) -------------------------------------------------------

test("sin sesión, embed.js se sirve igual: lo pide el navegador de quien mira la página ajena", async () => {
  // Si esto exigiera sesión como el resto del panel, el <script> del snippet recibiría la
  // redirección al login en vez del archivo — el bug real que motivó este bypass. Es de la LIGA,
  // no de un servidor puntual: no lleva `/s/<id>` en el path.
  const res = await pedir("GET", "/l/liga-a/embed/embed.js");
  assert.equal(res.status, 200);
  assert.equal(espejoAdmin.ultimo()!.url, "/embed/embed.js");
});

// --- Token de embed: por LIGA, no por servidor ----------------------------------------------------

test("sin sesión, el token de embed no se puede ni leer", async () => {
  assert.equal((await pedir("GET", "/l/liga-a/api/embed-token")).status, 401);
});

test("con sesión, se puede leer y guardar el origen permitido", async () => {
  const leido = await pedir("GET", "/l/liga-a/api/embed-token", { cookie: cookieA });
  assert.equal(leido.status, 200, leido.body);
  assert.equal(leido.json().allowedOrigin, "");
  assert.ok(leido.json().token.length > 10);

  const guardado = await pedir("POST", "/l/liga-a/api/embed-token", {
    cookie: cookieA,
    body: { allowedOrigin: "https://fslmanager.vercel.app" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(guardado.status, 200, guardado.body);
  assert.equal(guardado.json().allowedOrigin, "https://fslmanager.vercel.app");

  // Un admin de OTRA liga no puede tocar el embed de esta.
  assert.equal((await pedir("GET", "/l/liga-a/api/embed-token", { cookie: cookieB })).status, 401);
});

test("el embed exige el origen configurado y el token vigente, y regenerar invalida el viejo al instante", async () => {
  const ruta = `/l/liga-a/s/${servidorAId}/api/embed/state`;
  const origin = "https://fslmanager.vercel.app";

  // Sin Authorization: ni con el origen correcto pasa.
  assert.equal((await pedir("GET", ruta, { headers: { origin } })).status, 401);

  // Con un origen que no es el configurado: 403, aunque el token sea el correcto.
  const { token } = (await pedir("GET", "/l/liga-a/api/embed-token", { cookie: cookieA })).json();
  assert.equal(
    (await pedir("GET", ruta, { headers: { origin: "https://otro-sitio.example", authorization: `Bearer ${token}` } })).status,
    403
  );

  // Origen y token correctos: pasa, y llega al servidor correcto.
  const ok = await pedir("GET", ruta, { headers: { origin, authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(espejoAdmin.ultimo()!.headers["x-rc-user"], "embed:liga-a");

  // Regenerar: el token viejo deja de servir al instante.
  const regen = await pedir("POST", "/l/liga-a/api/embed-token/regenerate", {
    cookie: cookieA,
    headers: { "x-rc-request": "1" },
  });
  assert.equal(regen.status, 200, regen.body);
  const nuevo = regen.json().token;
  assert.notEqual(nuevo, token);
  assert.equal((await pedir("GET", ruta, { headers: { origin, authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await pedir("GET", ruta, { headers: { origin, authorization: `Bearer ${nuevo}` } })).status, 200);
});

// --- Selector de servidores -------------------------------------------------------------------------

test("la lista de servidores para el panel exige cookie; para el embed, Bearer de la liga", async () => {
  assert.equal((await pedir("GET", "/l/liga-a/api/servidores")).status, 401);
  const panel = await pedir("GET", "/l/liga-a/api/servidores", { cookie: cookieA });
  assert.equal(panel.status, 200, panel.body);
  assert.deepEqual(
    panel.json().servidores.map((s: { id: string }) => s.id),
    [servidorAId]
  );

  const { token } = (await pedir("GET", "/l/liga-a/api/embed-token", { cookie: cookieA })).json();
  const origin = "https://fslmanager.vercel.app";
  assert.equal((await pedir("GET", "/l/liga-a/api/embed/servidores")).status, 403);
  const embed = await pedir("GET", "/l/liga-a/api/embed/servidores", { headers: { origin, authorization: `Bearer ${token}` } });
  assert.equal(embed.status, 200, embed.body);
  assert.deepEqual(embed.json().servidores, [{ id: servidorAId, nombre: servidorA().nombre, activo: false }]);
});

function servidorA() {
  return primerServidor(ligaAId);
}

test("una liga con dos servidores rutea a cada uno por separado, sin mezclar sus estados", async () => {
  const segundo = portal.addServidor(ligaAId, "México F3", { start: false });
  const espejoDos = await servidorEspejo();
  segundo.adminPort = espejoDos.port;

  const unoRes = await pedir("GET", `/l/liga-a/s/${servidorAId}/api/state`, { cookie: cookieA });
  assert.equal(unoRes.status, 200);
  assert.equal(espejoAdmin.ultimo()!.url, "/api/state");
  assert.equal(espejoDos.ultimo(), null);

  const dosRes = await pedir("GET", `/l/liga-a/s/${segundo.id}/api/state`, { cookie: cookieA });
  assert.equal(dosRes.status, 200);
  assert.equal(espejoDos.ultimo()!.url, "/api/state");

  const lista = await pedir("GET", "/l/liga-a/api/servidores", { cookie: cookieA });
  assert.deepEqual(
    lista.json().servidores.map((s: { id: string }) => s.id).sort(),
    [servidorAId, segundo.id].sort()
  );

  // Limpieza: que no le pese a los tests que siguen contando "un solo servidor por liga".
  assert.ok(portal.store.removeServidor(segundo.id));
});

/**
 * El modal de "Servidores" del operador (`operador.js`) necesita la lista completa, no solo el
 * primero: `filaDeAdmin` (`portal/server.ts`) la expone entera para que cada servidor tenga su
 * propia pestaña, con su propio Send Address e historial.
 */
test("la fila del operador trae todos los servidores de la liga, no solo el primero", async () => {
  const segundo = portal.addServidor(ligaAId, "México F3", { start: false });

  const fila = (await pedir("GET", "/api/operador/admins", { cookie: cookieOp }))
    .json()
    .admins.find((a: { email: string }) => a.email === "ana@example.com");

  assert.deepEqual(
    fila.leagues[0].servidores.map((s: { id: string }) => s.id).sort(),
    [servidorAId, segundo.id].sort()
  );
  const srvSegundo = fila.leagues[0].servidores.find((s: { id: string }) => s.id === segundo.id);
  assert.equal(srvSegundo.nombre, "México F3");
  assert.ok(srvSegundo.conectarUrl.includes(segundo.id));

  assert.ok(portal.store.removeServidor(segundo.id));
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

// Un despliegue sin `RC_PUBLIC_IP` es un caso real: la IPv4 dedicada se pide aparte y puede no
// estar todavía. Lo que no puede pasar es que el admin vea ":39000" como si fuera una dirección:
// la pega, reinicia su servidor, y no llega nada nunca sin un solo síntoma que apunte a la causa.
test("sin IP pública no se inventa media dirección", async () => {
  const otro = createPortal({
    port: 0,
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "rc-portal-sin-ip-")),
    publicHost: "race-control.test",
    publicIp: "",
    udpPortFrom: 39200,
    udpPortTo: 39209,
    loopbackPortFrom: 39300,
    secureCookies: false,
    contact: "",
  });
  otro.supervisor.start = () => {};
  const { liga } = await otro.createLiga({
    slug: "liga-c",
    name: "Liga C",
    email: "caro@example.com",
    password: CLAVE_A,
  });
  const servidor = otro.store.servidoresDeLiga(liga.id)[0];
  assert.equal(otro.supervisor.sendAddressOf(servidor), "");
});

test("el login deja entrar y el logout cierra de verdad", async () => {
  const login = await pedir("POST", "/api/portal/login", {
    body: { email: "ANA@example.com", password: CLAVE_A },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(login.status, 200);
  // Con una sola liga, el destino es su primer servidor: la lista intermedia solo agregaría un
  // click, y el selector del servidor vive adentro del panel, no antes de entrar.
  assert.equal(login.json().destino, `/l/liga-a/s/${servidorAId}/`);
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

test("dos ligas con el mismo email no se pueden crear", async () => {
  await assert.rejects(
    () => portal.createLiga({ slug: "otra", name: "Otra", email: "ana@example.com" }),
    /Ya hay una cuenta/
  );
});

// --- Operador ------------------------------------------------------------------------------------

test("el panel del operador no existe para quien no lo es", async () => {
  // 404 y no 403: un admin curioso no tiene por qué enterarse de que esta sección está acá.
  assert.equal((await pedir("GET", "/api/operador/admins", { cookie: cookieA })).status, 404);
  assert.equal((await pedir("GET", "/api/operador/admins")).status, 404);
});

test("el operador ve a todos los admins, pero no a sí mismo", async () => {
  const res = await pedir("GET", "/api/operador/admins", { cookie: cookieOp });
  assert.equal(res.status, 200);
  const emails = res.json().admins.map((a: { email: string }) => a.email);
  assert.ok(emails.includes("ana@example.com"));
  assert.ok(emails.includes("beto@example.com"));
  assert.ok(!emails.includes("jefe@example.com"));
});

test("el alta devuelve la contraseña una vez y con ella se entra", async () => {
  const res = await pedir("POST", "/api/operador/admins", {
    cookie: cookieOp,
    body: { leagueName: "Liga Nueva", email: "nueva@example.com" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 200, res.body);
  const { password, admin } = res.json();
  assert.ok(password.length >= 8);
  assert.equal(admin.leagues[0].slug, "liga-nueva");

  const cookie = await entrar("nueva@example.com", password);
  assert.equal((await pedir("GET", "/api/portal/me", { cookie })).json().authenticated, true);
});

test("desactivar echa al admin y cierra la liga; reactivar la devuelve", async () => {
  const alta = await pedir("POST", "/api/operador/admins", {
    cookie: cookieOp,
    body: { leagueName: "Liga Morosa", email: "morosa@example.com" },
    headers: { "x-rc-request": "1" },
  });
  const { password, admin } = alta.json();
  const cookie = await entrar("morosa@example.com", password);
  assert.equal((await pedir("GET", "/api/portal/me", { cookie })).json().authenticated, true);

  await pedir("POST", `/api/operador/admins/${admin.id}`, {
    cookie: cookieOp,
    body: { active: false },
    headers: { "x-rc-request": "1" },
  });

  // La sesión que ya tenía abierta se cae sola: desactivar sube `sessionsVersion`.
  assert.equal((await pedir("GET", "/api/portal/me", { cookie })).json().authenticated, false);
  // Y tampoco puede volver a entrar con su contraseña, que sigue siendo la correcta.
  const reintento = await pedir("POST", "/api/portal/login", {
    body: { email: "morosa@example.com", password },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(reintento.status, 403);

  await pedir("POST", `/api/operador/admins/${admin.id}`, {
    cookie: cookieOp,
    body: { active: true },
    headers: { "x-rc-request": "1" },
  });
  const vuelta = await entrar("morosa@example.com", password);
  assert.equal((await pedir("GET", "/api/portal/me", { cookie: vuelta })).json().authenticated, true);
});

test("una clave nueva invalida la anterior", async () => {
  const admin = portal.store.findUserByEmail("beto@example.com")!;
  const res = await pedir("POST", `/api/operador/admins/${admin.id}/clave`, {
    cookie: cookieOp,
    body: {},
    headers: { "x-rc-request": "1" },
  });
  const nueva = res.json().password;
  assert.notEqual(nueva, CLAVE_B);

  const vieja = await pedir("POST", "/api/portal/login", {
    body: { email: "beto@example.com", password: CLAVE_B },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(vieja.status, 401);
  cookieB = await entrar("beto@example.com", nueva);
});

test("el estado de la cuota lo calcula el servidor", async () => {
  const admin = portal.store.findUserByEmail("ana@example.com")!;
  const ayer = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await pedir("POST", `/api/operador/admins/${admin.id}`, {
    cookie: cookieOp,
    body: { paidUntil: ayer },
    headers: { "x-rc-request": "1" },
  });
  const fila = (await pedir("GET", "/api/operador/admins", { cookie: cookieOp }))
    .json()
    .admins.find((a: { email: string }) => a.email === "ana@example.com");
  assert.equal(fila.subscription.state, "vencida");
  // La cuota vencida avisa, pero NO echa a nadie: cortar en mitad de una carrera por una fecha
  // es peor que cualquier impago. El corte es `active`, y lo decide una persona.
  assert.equal(fila.active, true);
  assert.equal((await pedir("GET", `/l/liga-a/s/${servidorAId}/api/state`, { cookie: cookieA })).status, 200);
});

// --- Edición desde el panel del operador ---------------------------------------------------------

/** Da de alta una liga propia del test, para no renombrar las que usan los demás. */
async function altaDePrueba(leagueName: string, email: string) {
  const res = await pedir("POST", "/api/operador/admins", {
    cookie: cookieOp,
    body: { leagueName, email },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 200, res.body);
  const { admin, password } = res.json();
  return { admin, password, liga: admin.leagues[0] };
}

test("el operador le cambia el nombre y la dirección a una liga", async () => {
  const { admin, liga } = await altaDePrueba("Copa Vieja", "copa@example.com");
  assert.equal(liga.slug, "copa-vieja");

  const res = await pedir("POST", `/api/operador/ligas/${liga.id}`, {
    cookie: cookieOp,
    body: { name: "Copa Nueva", slug: "Copa Nueva 2027" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 200, res.body);
  // El slug se normaliza del lado del servidor: lo que el operador escriba como título llega
  // igual a una URL válida, sin pedirle que la arme él.
  assert.equal(res.json().league.slug, "copa-nueva-2027");

  const fila = (await pedir("GET", "/api/operador/admins", { cookie: cookieOp }))
    .json()
    .admins.find((a: { id: string }) => a.id === admin.id);
  assert.equal(fila.leagues[0].name, "Copa Nueva");
  assert.equal(fila.leagues[0].slug, "copa-nueva-2027");

  // La dirección vieja deja de existir, y eso es lo que hay que avisarle al admin antes de tocarla.
  assert.equal((await pedir("GET", "/l/copa-vieja/", { cookie: cookieOp })).status, 404);
});

test("una liga no se puede mudar encima de otra", async () => {
  const { liga } = await altaDePrueba("Copa Chocadora", "chocadora@example.com");
  const res = await pedir("POST", `/api/operador/ligas/${liga.id}`, {
    cookie: cookieOp,
    body: { slug: "liga-b" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 400);
  assert.match(res.json().error, /liga-b/);
  // Y la liga de al lado sigue donde estaba.
  assert.equal(portal.store.findLigaBySlug("liga-b")!.id !== liga.id, true);
});

test("editar una liga que no existe es 404, y sin cambios es 400", async () => {
  const { liga } = await altaDePrueba("Copa Sin Cambios", "sincambios@example.com");
  assert.equal(
    (await pedir("POST", "/api/operador/ligas/no-existe", {
      cookie: cookieOp,
      body: { name: "Lo que sea" },
      headers: { "x-rc-request": "1" },
    })).status,
    404
  );
  assert.equal(
    (await pedir("POST", `/api/operador/ligas/${liga.id}`, {
      cookie: cookieOp,
      body: {},
      headers: { "x-rc-request": "1" },
    })).status,
    400
  );
});

test("editar ligas tampoco existe para quien no es operador", async () => {
  const liga = portal.store.findLigaBySlug("liga-a")!;
  const res = await pedir("POST", `/api/operador/ligas/${liga.id}`, {
    cookie: cookieA,
    body: { name: "Mi propia liga renombrada" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 404);
  assert.equal(portal.store.findLiga(liga.id)!.name, "Liga A");
});

test("cambiar el email cambia con qué entra el admin", async () => {
  const { admin, password } = await altaDePrueba("Copa Del Mail", "viejo@example.com");

  const res = await pedir("POST", `/api/operador/admins/${admin.id}`, {
    cookie: cookieOp,
    body: { email: "Nuevo@Example.com" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 200, res.body);
  // Normalizado a minúsculas: si no, el login con el mismo email escrito distinto no encontraría
  // la cuenta.
  assert.equal(res.json().admin.email, "nuevo@example.com");

  const viejo = await pedir("POST", "/api/portal/login", {
    body: { email: "viejo@example.com", password },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(viejo.status, 401);

  const cookie = await entrar("nuevo@example.com", password);
  assert.equal((await pedir("GET", "/api/portal/me", { cookie })).json().authenticated, true);
});

test("un email que ya es de otra cuenta se rechaza", async () => {
  const { admin } = await altaDePrueba("Copa Repetida", "repetida@example.com");
  const res = await pedir("POST", `/api/operador/admins/${admin.id}`, {
    cookie: cookieOp,
    body: { email: "ana@example.com" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 400);
  assert.equal(portal.store.findUser(admin.id)!.email, "repetida@example.com");

  const feo = await pedir("POST", `/api/operador/admins/${admin.id}`, {
    cookie: cookieOp,
    body: { email: "esto no es un email" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(feo.status, 400);
});

test("el operador puede elegir la contraseña en vez de que se la generen", async () => {
  const { admin, password } = await altaDePrueba("Copa De Clave", "declave@example.com");

  const corta = await pedir("POST", `/api/operador/admins/${admin.id}/clave`, {
    cookie: cookieOp,
    body: { password: "corta" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(corta.status, 400);

  const res = await pedir("POST", `/api/operador/admins/${admin.id}/clave`, {
    cookie: cookieOp,
    body: { password: "la-que-yo-elijo" },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json().password, "la-que-yo-elijo");

  const vieja = await pedir("POST", "/api/portal/login", {
    body: { email: "declave@example.com", password },
    headers: { "x-rc-request": "1" },
  });
  assert.equal(vieja.status, 401);
  const cookie = await entrar("declave@example.com", "la-que-yo-elijo");
  assert.equal((await pedir("GET", "/api/portal/me", { cookie })).json().authenticated, true);
});

// --- Historial de eventos --------------------------------------------------------------------------

test("el historial de un servidor no existe para quien no es operador", async () => {
  const liga = portal.store.findLigaBySlug("liga-a")!;
  const servidorId = primerServidor(liga.id).id;
  assert.equal(
    (await pedir("GET", `/api/operador/ligas/${liga.id}/servidores/${servidorId}/eventos`, { cookie: cookieA })).status,
    404
  );
  assert.equal((await pedir("GET", `/api/operador/ligas/${liga.id}/servidores/${servidorId}/eventos`)).status, 404);
});

test("una liga que no existe tampoco tiene historial", async () => {
  assert.equal(
    (await pedir("GET", "/api/operador/ligas/no-existe/servidores/no-existe/eventos", { cookie: cookieOp })).status,
    404
  );
  assert.equal(
    (
      await pedir("DELETE", "/api/operador/ligas/no-existe/servidores/no-existe/eventos/E1", {
        cookie: cookieOp,
        headers: { "x-rc-request": "1" },
      })
    ).status,
    404
  );
});

test("el operador lee el historial de un servidor directo del disco, sin pasar por el worker", async () => {
  const { liga, admin } = await altaDePrueba("Copa Con Historial", "historial@example.com");
  const servidorId = primerServidor(liga.id).id;
  const store = new LeagueEventsStore(portal.supervisor.dataDirOf(servidorId));
  store.startSession({
    track: "ks_barcelona",
    trackConfig: "layout_gp",
    sessionType: 3,
    sessionTypeLabel: "Carrera",
    sessionName: "Carrera",
  });
  store.closeCurrent({
    generatedAt: new Date().toISOString(),
    leagueName: "Copa Con Historial",
    version: "1.4",
    track: "Barcelona · GP",
    sessionName: "Carrera",
    sessionType: "Carrera",
    classification: [],
    penalties: [],
    incidents: [],
  });

  const res = await pedir("GET", `/api/operador/ligas/${liga.id}/servidores/${servidorId}/eventos`, { cookie: cookieOp });
  assert.equal(res.status, 200, res.body);
  const eventos = res.json().eventos;
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].status, "terminado");
  assert.equal(eventos[0].track, "ks_barcelona");
  assert.equal(eventos[0].report.track, "Barcelona · GP");

  // Sigue viéndose aunque la liga esté desactivada: el historial vive en disco, a nivel de
  // archivo, igual que `config.json` — no detrás de un worker que podría estar parado.
  await pedir("POST", `/api/operador/admins/${admin.id}`, {
    cookie: cookieOp,
    body: { active: false },
    headers: { "x-rc-request": "1" },
  });
  const tras = await pedir("GET", `/api/operador/ligas/${liga.id}/servidores/${servidorId}/eventos`, { cookie: cookieOp });
  assert.equal(tras.status, 200);
  assert.equal(tras.json().eventos.length, 1);
});

test("un evento en curso no se puede borrar, y uno terminado sí", async () => {
  const { liga } = await altaDePrueba("Copa Para Borrar", "borrar@example.com");
  const servidorId = primerServidor(liga.id).id;
  const store = new LeagueEventsStore(portal.supervisor.dataDirOf(servidorId));
  store.startSession({
    track: "ks_monza",
    trackConfig: "",
    sessionType: 1,
    sessionTypeLabel: "Práctica",
    sessionName: "Práctica",
  });
  const enCurso = store.list()[0].id;

  const headers = { "x-rc-request": "1" };
  const base = `/api/operador/ligas/${liga.id}/servidores/${servidorId}/eventos`;

  // Mientras está en curso, ni el operador lo puede borrar: el worker lo sigue escribiendo.
  const intento = await pedir("DELETE", `${base}/${enCurso}`, { cookie: cookieOp, headers });
  assert.equal(intento.status, 404);

  store.closeCurrent(null);
  const borrado = await pedir("DELETE", `${base}/${enCurso}`, { cookie: cookieOp, headers });
  assert.equal(borrado.status, 200, borrado.body);

  const eventos = (await pedir("GET", base, { cookie: cookieOp })).json().eventos;
  assert.equal(eventos.length, 0);

  // Un id que no existe también es 404, y no un 200 que no borró nada.
  const inexistente = await pedir("DELETE", `${base}/no-existe`, { cookie: cookieOp, headers });
  assert.equal(inexistente.status, 404);
});

// --- Renombre de un servidor -------------------------------------------------------------------

test("el operador renombra un servidor sin tocar el worker ni su id", async () => {
  const { liga } = await altaDePrueba("Copa Renombrable", "renombrable@example.com");
  const servidor = portal.addServidor(liga.id, "Nombre con herror", { start: false });
  const headers = { "x-rc-request": "1" };

  // El nombre no viaja en `StartMessage`, así que renombrar no tiene por qué reiniciar nada: si lo
  // hiciera, corregir un tipeo le cortaría la carrera en curso al admin.
  const detenidos: string[] = [];
  const stopOriginal = portal.supervisor.stop.bind(portal.supervisor);
  portal.supervisor.stop = (id: string) => {
    detenidos.push(id);
    stopOriginal(id);
  };
  try {
    const res = await pedir("PATCH", `/api/operador/ligas/${liga.id}/servidores/${servidor.id}`, {
      cookie: cookieOp,
      headers,
      body: { nombre: "México F3" },
    });
    assert.equal(res.status, 200, res.body);
  } finally {
    portal.supervisor.stop = stopOriginal;
  }

  assert.deepEqual(detenidos, []);
  const actualizado = portal.store.findServidor(servidor.id);
  assert.equal(actualizado?.nombre, "México F3");
  // Mismo id y mismos puertos: el link de conexión que el admin ya tenía guardado sigue sirviendo,
  // que es justo lo que hacía caro arreglar un nombre borrando y recreando el servidor.
  assert.equal(actualizado?.udpPort, servidor.udpPort);

  // Un nombre vacío es 400 y no deja el servidor sin rótulo.
  const vacio = await pedir("PATCH", `/api/operador/ligas/${liga.id}/servidores/${servidor.id}`, {
    cookie: cookieOp,
    headers,
    body: { nombre: "   " },
  });
  assert.equal(vacio.status, 400);
  assert.equal(portal.store.findServidor(servidor.id)?.nombre, "México F3");

  // Y los mismos 404 que el borrado: servidor inexistente, liga inexistente, y un admin cualquiera.
  assert.equal(
    (await pedir("PATCH", `/api/operador/ligas/${liga.id}/servidores/no-existe`, { cookie: cookieOp, headers, body: { nombre: "X" } })).status,
    404
  );
  assert.equal(
    (await pedir("PATCH", `/api/operador/ligas/${liga.id}/servidores/${servidor.id}`, { cookie: cookieA, headers, body: { nombre: "X" } })).status,
    404
  );
});

// --- Borrado de un servidor --------------------------------------------------------------------

test("el operador borra un servidor: para el worker antes de sacarlo del store", async () => {
  const { liga } = await altaDePrueba("Copa Con Dos Servidores", "dosservidores@example.com");
  const segundo = portal.addServidor(liga.id, "México F3", { start: false });

  // `supervisor.start` ya está anulado para todo el archivo (no se forkean workers de verdad); acá
  // se espía `stop` para el único dato que ese mock no deja ver por sí solo: que el portal lo llama
  // ANTES de sacar el servidor del store, no después — si no, `usedPorts()` dejaría de contar el
  // puerto de un proceso que en los hechos seguiría vivo.
  const detenidos: string[] = [];
  const stopOriginal = portal.supervisor.stop.bind(portal.supervisor);
  portal.supervisor.stop = (id: string) => {
    detenidos.push(id);
    assert.ok(portal.store.findServidor(id), "se llamó a stop() después de sacar el servidor del store");
    stopOriginal(id);
  };
  try {
    const res = await pedir("DELETE", `/api/operador/ligas/${liga.id}/servidores/${segundo.id}`, {
      cookie: cookieOp,
      headers: { "x-rc-request": "1" },
    });
    assert.equal(res.status, 200, res.body);
  } finally {
    portal.supervisor.stop = stopOriginal;
  }

  assert.deepEqual(detenidos, [segundo.id]);
  assert.equal(portal.store.findServidor(segundo.id), undefined);
  assert.deepEqual(portal.store.servidoresDeLiga(liga.id).map((s) => s.id), [primerServidor(liga.id).id]);
});

test("borrar un servidor que no existe, o de una liga que no existe, da 404", async () => {
  const { liga } = await altaDePrueba("Copa Sin Segundo Servidor", "sinsegundo@example.com");
  const headers = { "x-rc-request": "1" };

  assert.equal(
    (await pedir("DELETE", `/api/operador/ligas/${liga.id}/servidores/no-existe`, { cookie: cookieOp, headers })).status,
    404
  );
  assert.equal(
    (await pedir("DELETE", `/api/operador/ligas/no-existe/servidores/no-existe`, { cookie: cookieOp, headers })).status,
    404
  );
  assert.equal(
    (
      await pedir("DELETE", `/api/operador/ligas/${liga.id}/servidores/${primerServidor(liga.id).id}`, {
        cookie: cookieA,
        headers,
      })
    ).status,
    404
  );
});

test("las pantallas del portal salen con sus cabeceras de seguridad", async () => {
  const res = await pedir("GET", "/");
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(String(res.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.match(String(res.headers["content-security-policy"]), /script-src 'self'/);
});
