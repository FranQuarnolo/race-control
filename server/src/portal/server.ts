import express, { NextFunction, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { APP_VERSION } from "../api/adminApi";
import {
  DECOY_HASH,
  LoginThrottle,
  SESSION_COOKIE,
  SessionStore,
  delay,
  generatePassword,
  hashPassword,
  verifyWithDecoy,
} from "./auth";
import { LeagueEventsStore } from "../history/leagueEvents";
import { askWorker, proxyToWorker } from "./proxy";
import { EmbedTokenIssuer } from "../security/embedToken";
import { Liga, PortalStore, Servidor, User, normalizeEmail, toSlug } from "./store";
import { Supervisor, assignPorts } from "./supervisor";

/**
 * El portal: una sola puerta a internet, con las ligas detrás.
 *
 * Todo lo que entra pasa por acá. Las rutas `/l/<slug>/s/<servidorId>/...` se reenvían al worker de
 * ESE servidor después de verificar quién pide y si tiene permiso; lo demás son las pantallas del
 * portal (la landing pública, el login, la lista de ligas y el panel del operador).
 *
 * No hay registro: las cuentas las crea el operador y entrega usuario y contraseña. Es un servicio
 * con suscripción, no un sitio al que cualquiera se da de alta.
 */

export interface PortalConfig {
  port: number;
  dataRoot: string;
  /** Host público, ej. `race-control.fly.dev`. Sin esquema ni barra final. */
  publicHost: string;
  /** IP pública del servidor: la que va en el "Send Address" del hosting del admin. */
  publicIp: string;
  /**
   * A dónde escribe quien se quedó afuera.
   *
   * El producto decía "escribinos" en seis lugares distintos —la pantalla de ingreso, la de ligas,
   * el cierre de la landing, dos diagnósticos de red y el error de cuenta desactivada— y no había
   * una sola dirección en ningún lado. El único camino de recuperación que ofrecíamos terminaba en
   * una pared, y justo en la pantalla donde está la persona que no puede entrar.
   *
   * Es un `mailto:` o una URL (un Discord, un formulario): lo que entre acá se usa tal cual. Vacío
   * deja el texto en "pedíselo a quien te dio el acceso", que es impreciso pero al menos no manda
   * a ningún lado inexistente.
   */
  contact: string;
  udpBindAddress?: string;
  udpPortFrom: number;
  udpPortTo: number;
  /** Desde dónde se asignan los puertos de loopback de cada worker. */
  loopbackPortFrom: number;
  /** `false` en desarrollo: sin HTTPS no se puede usar el prefijo `__Host-` ni marcar `Secure`. */
  secureCookies: boolean;
}

export function portalConfigFromEnv(): PortalConfig {
  const num = (name: string, fallback: number) => {
    const raw = process.env[name];
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
  };
  return {
    port: num("PORT", 8080),
    dataRoot: process.env.RC_DATA_ROOT || "/data",
    publicHost: process.env.RC_PUBLIC_HOST || "localhost:8080",
    publicIp: process.env.RC_PUBLIC_IP || "",
    contact: (process.env.RC_CONTACT || "").trim(),
    udpBindAddress: process.env.RC_UDP_BIND || undefined,
    udpPortFrom: num("RC_UDP_FROM", 30000),
    udpPortTo: num("RC_UDP_TO", 30019),
    loopbackPortFrom: num("RC_LOOPBACK_FROM", 41000),
    secureCookies: process.env.RC_INSECURE_COOKIES !== "1",
  };
}

/** Sin `cookie-parser`: una sola cookie, y el parseo cabe en cuatro líneas. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** El body de un POST que el portal atiende directo (sin proxyear): no hay `express.json()` acá
 * arriba a propósito, porque `proxyToWorker` necesita el stream del request intacto. */
function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(raw || "{}");
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** Lo que genera `newId()` en `store.ts`: base64url de 9 bytes. */
const SERVIDOR_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Lo que hay que entregarle a un admin nuevo. La contraseña se ve una vez y nunca más. */
export interface Credenciales {
  liga: Liga;
  user: User;
  password: string;
  loginUrl: string;
}

export interface Portal {
  app: express.Express;
  store: PortalStore;
  supervisor: Supervisor;
  sessions: SessionStore;
  /** Crea la liga, su cuenta de admin y su primer servidor, y devuelve lo que hay que pasarle. */
  createLiga(
    input: { slug: string; name: string; email: string; password?: string; servidorNombre?: string },
    options?: { start?: boolean }
  ): Promise<Credenciales>;
  /** Un servidor más para una liga que ya existe. */
  addServidor(ligaId: string, nombre: string, options?: { start?: boolean }): Servidor;
  /** Contraseña nueva para una cuenta que ya existe: la pidió, o se la olvidó. */
  resetPassword(user: User, password?: string): Promise<string>;
  /** Siembra la cuenta del operador si todavía no hay ninguna. Devuelve la clave si la creó. */
  ensureOperator(email: string, password?: string): Promise<string | null>;
}

export function createPortal(config: PortalConfig): Portal {
  fs.mkdirSync(config.dataRoot, { recursive: true });
  const store = new PortalStore(path.join(config.dataRoot, "portal.json"));
  const sessions = new SessionStore();
  const throttle = new LoginThrottle();
  const supervisor = new Supervisor(store, {
    dataRoot: config.dataRoot,
    // Siempre el compilado: el worker vive al lado del portal dentro de `dist/`.
    workerPath: path.join(__dirname, "..", "worker", "leagueWorker.js"),
    publicIp: config.publicIp,
    publicHost: config.publicHost,
    udpBindAddress: config.udpBindAddress,
  });

  // Una `EmbedTokenIssuer` por liga, no por servidor: así el admin pega el snippet una sola vez y
  // el token le sirve para cualquier servidor que corra bajo esa liga (ver `store.ts`, `Liga.embed`).
  // La clave vive en `<dataRoot>/ligas/<ligaId>/secrets/embed.key`, al lado de —no adentro de—
  // ningún `dataDir` de servidor.
  const embedTokenIssuers = new Map<string, EmbedTokenIssuer>();
  function embedTokensFor(ligaId: string): EmbedTokenIssuer {
    let issuer = embedTokenIssuers.get(ligaId);
    if (!issuer) {
      issuer = new EmbedTokenIssuer(path.join(config.dataRoot, "ligas", ligaId));
      embedTokenIssuers.set(ligaId, issuer);
    }
    return issuer;
  }

  const sweeper = setInterval(() => sessions.sweep(), 10 * 60 * 1000);
  sweeper.unref();

  const app = express();
  app.disable("x-powered-by");
  // Fly.io (y cualquier proxy delante) manda la IP real acá. Sin esto, el freno por IP vería
  // una sola dirección —la del proxy— y bloquearía a todo el mundo junto.
  app.set("trust proxy", true);

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      // `style-src 'unsafe-inline'` queda porque el panel escribe estilos desde JS; los scripts,
      // que son los que importan, siguen restringidos a archivos propios. `fonts.googleapis.com` y
      // `fonts.gstatic.com` se suman solo para Oswald/Chivo (la tipografía copiada de
      // fslmanager.vercel.app, ver styles.css): sin esto el CSP corta la hoja de Google Fonts antes
      // de que llegue el archivo de la tipografía.
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    if (config.secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });

  /**
   * HTTP plano solo para la app de los pilotos.
   *
   * El Python embebido de Assetto Corsa es 3.3: no tiene `ssl.create_default_context`, no verifica
   * certificados por defecto y ni siquiera está confirmado que traiga el módulo `ssl`. O sea que
   * ese canal no puede ir por HTTPS. Todo lo demás —el panel, el login— sí, y se redirige.
   */
  app.use((req, res, next) => {
    const proto = String(req.headers["x-forwarded-proto"] || "");
    const esCanalDePilotos = /^\/l\/[a-z0-9-]+\/s\/[A-Za-z0-9_-]+\/api\/client\//.test(req.path);
    if (config.secureCookies && proto === "http" && !esCanalDePilotos) {
      res.redirect(308, `https://${config.publicHost}${req.originalUrl}`);
      return;
    }
    next();
  });

  // --- Sesión -----------------------------------------------------------------------------------

  interface SessionRequest extends Request {
    userId?: string;
  }

  app.use((req: SessionRequest, _res, next) => {
    const token = readCookie(req, cookieName());
    const userId = sessions.touch(token, (id) => store.findUser(id)?.sessionsVersion);
    if (userId) req.userId = userId;
    next();
  });

  function setSessionCookie(res: Response, token: string): void {
    // `__Host-` exige Secure y Path=/ y prohíbe Domain: es la variante que un subdominio
    // comprometido no puede sobrescribir. En desarrollo (sin HTTPS) el prefijo no se puede usar.
    const flags = ["Path=/", "HttpOnly", "SameSite=Strict"];
    if (config.secureCookies) flags.push("Secure");
    res.setHeader("Set-Cookie", `${cookieName()}=${encodeURIComponent(token)}; ${flags.join("; ")}`);
  }

  function cookieName(): string {
    return config.secureCookies ? SESSION_COOKIE : "rc_session";
  }

  function clearSessionCookie(res: Response): void {
    res.setHeader("Set-Cookie", `${cookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  /**
   * CSRF: cookie `SameSite=Strict` + header propio + chequeo de `Origin`.
   *
   * Los tres juntos y no uno solo porque cada uno falla distinto: `SameSite` no lo respetan los
   * navegadores viejos, el header obligatorio no lo puede poner un `<form>` cruzado pero sí un
   * `fetch` con CORS mal configurado, y `Origin` no llega en algunos clientes. El canal de
   * pilotos y el del embed quedan afuera: el primero no usa cookies, y el segundo tiene su propio
   * esquema de origen+token (ver `embedGate`) que cumple el mismo papel.
   */
  function checkCsrf(req: Request, res: Response, next: NextFunction): void {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    if (req.headers["x-rc-request"] !== "1") {
      res.status(403).json({ ok: false, error: "Pedido sin la marca de origen esperada." });
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `https://${config.publicHost}` && origin !== `http://${config.publicHost}`) {
      res.status(403).json({ ok: false, error: "Origen no permitido." });
      return;
    }
    next();
  }

  /**
   * Portero del Bearer de embed: un token por LIGA (ver `Liga.embed`), no por servidor.
   *
   * Hasta la 1.25 esto vivía en el worker (`adminApi.ts`) y se repetía por cada proceso. Con una
   * liga pudiendo correr varios servidores, el token tiene que validarse en un solo lugar que
   * conozca a la liga entera: acá. El worker ya no valida nada de esto — confía en que, si el
   * pedido le llegó, es porque pasó por este portero.
   */
  function embedGate(req: Request, res: Response, liga: Liga): boolean {
    const allowed = liga.embed.allowedOrigin;
    const origin = req.headers.origin;
    if (!allowed || origin !== allowed) {
      // Sin origen configurado, o un origen que no es el configurado: no se responde nada, ni con
      // el token correcto. Es defensa en profundidad y no solo lo que ya hace el navegador con
      // CORS — un cliente que no sea un navegador no respeta CORS, y el token por sí solo puede
      // terminar filtrado en cualquier página.
      res.status(403).json({ ok: false, error: "Origen no autorizado" });
      return false;
    }
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return false;
    }
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!embedTokensFor(liga.id).verify(token, liga.embed.tokenVersion)) {
      res.status(401).json({ ok: false, error: "Token inválido" });
      return false;
    }
    return true;
  }

  // --- API del portal ---------------------------------------------------------------------------

  const portalApi = express.Router();
  portalApi.use(express.json({ limit: "10kb" }));
  portalApi.use(checkCsrf);

  portalApi.get("/me", (req: SessionRequest, res) => {
    if (!req.userId) {
      // `contact` va también sin sesión, y es el caso que más lo necesita: la pantalla de ingreso
      // es justo donde está parado quien no puede entrar.
      res.json({ authenticated: false, version: APP_VERSION, contact: config.contact });
      return;
    }
    const user = store.findUser(req.userId);
    const leagues = store
      .membershipsOf(req.userId)
      .map((m) => store.findLiga(m.ligaId))
      .filter((l): l is Liga => Boolean(l))
      .map((liga) => {
        // El primer servidor de la liga: con una liga por cuenta y un servidor por liga (el caso
        // de todos los admins hoy), es "el" servidor. Ver el comentario de `filaDeAdmin`.
        const primero = store.servidoresDeLiga(liga.id)[0];
        return {
          slug: liga.slug,
          name: liga.name,
          status: primero?.status ?? "stopped",
          lastError: primero?.lastError,
          sendAddress: primero ? supervisor.sendAddressOf(primero) : "",
        };
      });
    res.json({
      authenticated: true,
      email: user?.email,
      role: user?.role ?? "admin",
      // Días que faltan para el vencimiento, o negativo si ya pasó. El cálculo va acá y no en el
      // navegador: el reloj del cliente lo pone el cliente, y con esto se decide qué avisar.
      subscription: subscriptionOf(user),
      leagues,
      version: APP_VERSION,
      contact: config.contact,
    });
  });

  /**
   * Lo único que la pantalla de puesta en marcha necesita: qué pegar, y si ya está llegando.
   *
   * Es por SERVIDOR y no por liga: con varios servidores en una liga, cada uno tiene su propia
   * dirección UDP y su propio estado de recepción. Sale del portal y no del panel porque es la
   * pantalla que ve alguien que todavía no entró nunca al panel — y porque el "Send Address" lo
   * sabe el portal (es su IP y el puerto que él asignó), no el worker.
   */
  portalApi.get("/liga/:slug/:servidorId", async (req: SessionRequest, res) => {
    const liga = store.findLigaBySlug(req.params.slug);
    const servidor = liga ? store.findServidor(req.params.servidorId) : undefined;
    if (!liga || !servidor || servidor.ligaId !== liga.id || !req.userId || !store.hasAccess(req.userId, liga.id)) {
      res.status(404).json({ ok: false, error: "No existe ese servidor." });
      return;
    }
    if (servidor.status === "stopped") supervisor.start(servidor.id);
    const state = await askWorker<{ network?: { receivingTelemetry?: boolean } }>(servidor.adminPort, "/api/state");
    res.json({
      ok: true,
      name: liga.name,
      slug: liga.slug,
      servidorId: servidor.id,
      status: servidor.status,
      sendAddress: supervisor.sendAddressOf(servidor),
      /** `null` mientras el worker todavía no contesta: no es lo mismo que "no está llegando". */
      receiving: state ? Boolean(state.network?.receivingTelemetry) : null,
      contact: config.contact,
    });
  });

  portalApi.post("/login", async (req, res) => {
    const ip = req.ip || "desconocida";
    if (throttle.ipBlocked(ip)) {
      res.status(429).json({ ok: false, error: "Demasiados intentos. Probá de nuevo en un rato." });
      return;
    }
    const email = normalizeEmail((req.body ?? {}).email);
    const password = String((req.body ?? {}).password ?? "");
    // La demora por cuenta se paga ANTES de contestar, para que no se pueda medir si existe.
    await delay(throttle.accountDelayMs(email));

    const user = store.findUserByEmail(email);
    const ok = await verifyWithDecoy(password, user?.password);
    if (!ok || !user) {
      throttle.fail(ip, email);
      res.status(401).json({ ok: false, error: "Email o contraseña incorrectos." });
      return;
    }
    // La cuenta desactivada se rechaza DESPUÉS de verificar la contraseña: contestar antes
    // convertiría el login en un detector de qué cuentas existen y cuáles están al día.
    if (!user.active) {
      res.status(403).json({
        ok: false,
        error:
          "Tu cuenta está desactivada. Tus datos siguen guardados: " +
          (config.contact
            ? "escribinos a " + config.contact.replace(/^mailto:/, "") + " para reactivarla."
            : "pedile a quien te dio el acceso que la reactive."),
      });
      return;
    }
    throttle.success(ip, email);
    store.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
    // `user` es la referencia del store y `updateUser` no toca `sessionsVersion` acá, así que
    // sigue siendo la correcta para la sesión que se crea.
    setSessionCookie(res, sessions.create(user.id, user.sessionsVersion));
    const memberships = store.membershipsOf(user.id);
    const única = memberships.length === 1 ? store.findLiga(memberships[0].ligaId) : undefined;
    const primerServidor = única ? store.servidoresDeLiga(única.id)[0] : undefined;
    res.json({
      ok: true,
      // A dónde mandarlo: el operador a su panel, y el admin de una sola liga directo adentro.
      // Una lista de un solo elemento es una pantalla que solo existe para hacer un click más.
      destino:
        user.role === "operador"
          ? "/operador"
          : única && primerServidor
          ? `/l/${única.slug}/s/${primerServidor.id}/`
          : única
          ? `/l/${única.slug}/`
          : "/mis-ligas",
    });
  });

  portalApi.post("/logout", (req: SessionRequest, res) => {
    sessions.destroy(readCookie(req, cookieName()));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.use("/api/portal", portalApi);

  // --- API del operador ---------------------------------------------------------------------------

  /**
   * Todo lo de acá es para quien vende el servicio, y está detrás de su propio rol.
   *
   * La separación no es cosmética: un admin con la sesión robada puede hacer destrozos en su liga,
   * pero no tiene que poder listar las cuentas de las demás ni darse de alta la suscripción solo.
   */
  const operadorApi = express.Router();
  operadorApi.use(express.json({ limit: "10kb" }));
  operadorApi.use(checkCsrf);
  operadorApi.use((req: SessionRequest, res, next) => {
    const user = req.userId ? store.findUser(req.userId) : undefined;
    if (!user || user.role !== "operador" || !user.active) {
      // 404 y no 403: para quien no es operador, esta sección no existe.
      res.status(404).json({ ok: false, error: "No encontrado." });
      return;
    }
    next();
  });

  /**
   * Una fila de la tabla del operador: la cuenta, su liga y en qué estado está cada cosa.
   *
   * `status`/`sendAddress`/`udpPort` a nivel liga siguen saliendo del PRIMER servidor —
   * compatibilidad con lo que ya pintaba la columna "Motor" antes de que una liga pudiera tener
   * más de uno. `servidores` es la lista completa: la tabla del operador la usa para la columna
   * "Servidores" (un modal con una pestaña por servidor, ver `operador.js`), con el detalle y el
   * historial de CADA UNO, no solo el primero.
   */
  function filaDeAdmin(user: User) {
    const leagues = store.ligasOwnedBy(user.id).map((liga) => {
      const servidoresDeLaLiga = store.servidoresDeLiga(liga.id);
      const primero = servidoresDeLaLiga[0];
      return {
        // El id va al panel porque es lo que `POST /api/operador/ligas/:id` necesita para editarla.
        // El slug no sirve: justamente puede cambiar en esa misma llamada.
        id: liga.id,
        slug: liga.slug,
        name: liga.name,
        status: primero?.status ?? "stopped",
        lastError: primero?.lastError,
        sendAddress: primero ? supervisor.sendAddressOf(primero) : "",
        udpPort: primero?.udpPort ?? 0,
        servidores: servidoresDeLaLiga.map((s) => ({
          id: s.id,
          nombre: s.nombre,
          status: s.status,
          lastError: s.lastError,
          sendAddress: supervisor.sendAddressOf(s),
          udpPort: s.udpPort,
          createdAt: s.createdAt,
          conectarUrl: `${baseUrl()}/conectar/${liga.slug}/${s.id}`,
        })),
      };
    });
    return {
      id: user.id,
      email: user.email,
      active: user.active,
      paidUntil: user.paidUntil ?? "",
      lastLoginAt: user.lastLoginAt ?? "",
      createdAt: user.createdAt,
      note: user.note ?? "",
      subscription: subscriptionOf(user),
      leagues,
    };
  }

  operadorApi.get("/admins", (_req, res) => {
    const admins = store
      .users()
      .filter((u) => u.role === "admin")
      .map(filaDeAdmin)
      // Primero lo que requiere acción: vencidos, después por vencer, después el resto.
      .sort((a, b) => ordenDeAtencion(a) - ordenDeAtencion(b) || a.email.localeCompare(b.email));
    res.json({ ok: true, admins, udpLibres: puertosUdpLibres() });
  });

  operadorApi.get("/admins/:id", (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user || user.role !== "admin") {
      res.status(404).json({ ok: false, error: "No existe esa cuenta." });
      return;
    }
    res.json({ ok: true, admin: filaDeAdmin(user) });
  });

  /** Alta: una liga, su primer servidor y su cuenta, en un solo paso. Devuelve la contraseña una
   * única vez. */
  operadorApi.post("/admins", async (req, res) => {
    const body = req.body ?? {};
    const nombre = String(body.leagueName ?? "").trim();
    const email = normalizeEmail(body.email);
    if (!nombre || !email.includes("@")) {
      res.status(400).json({ ok: false, error: "Hacen falta el nombre de la liga y un email válido." });
      return;
    }
    const password = body.password ? String(body.password) : undefined;
    if (password !== undefined && password.length < 8) {
      res.status(400).json({ ok: false, error: "La contraseña tiene que tener al menos 8 caracteres." });
      return;
    }
    try {
      const creds = await createLiga({
        slug: String(body.slug ?? "").trim() || toSlugSeguro(nombre),
        name: nombre,
        email,
        password,
      });
      if (body.paidUntil) store.updateUser(creds.user.id, { paidUntil: String(body.paidUntil) });
      res.json({
        ok: true,
        password: creds.password,
        loginUrl: creds.loginUrl,
        admin: filaDeAdmin(store.findUser(creds.user.id)!),
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  operadorApi.post("/admins/:id", (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user || user.role !== "admin") {
      res.status(404).json({ ok: false, error: "No existe esa cuenta." });
      return;
    }
    const body = req.body ?? {};
    const patch: Parameters<typeof store.updateUser>[1] = {};
    if (typeof body.active === "boolean") patch.active = body.active;
    if (typeof body.paidUntil === "string") patch.paidUntil = body.paidUntil.trim();
    if (typeof body.note === "string") patch.note = body.note.slice(0, 500);

    // El email es con lo que entra: cambiarlo mal lo deja afuera de su propia liga. Se valida que
    // sea un email y que no sea el de otra cuenta — dos cuentas con el mismo email harían que el
    // login eligiera una de las dos sin criterio.
    if (typeof body.email === "string" && body.email.trim()) {
      const email = normalizeEmail(body.email);
      if (!email.includes("@")) {
        res.status(400).json({ ok: false, error: `"${body.email}" no parece un email.` });
        return;
      }
      const otro = store.findUserByEmail(email);
      if (otro && otro.id !== user.id) {
        res.status(400).json({ ok: false, error: `Ya hay una cuenta con el email ${email}.` });
        return;
      }
      patch.email = email;
    }

    store.updateUser(user.id, patch);

    // Desactivar apaga TODOS los servidores de todas sus ligas; reactivar los vuelve a levantar.
    // Los datos no se tocan nunca: el worker se detiene, y la carpeta con su configuración, sus
    // sanciones y sus registros queda.
    const servidoresDelUsuario = () => store.ligasOwnedBy(user.id).flatMap((liga) => store.servidoresDeLiga(liga.id));
    if (patch.active === false) for (const s of servidoresDelUsuario()) supervisor.stop(s.id);
    if (patch.active === true) for (const s of servidoresDelUsuario()) supervisor.start(s.id);

    res.json({ ok: true, admin: filaDeAdmin(store.findUser(user.id)!) });
  });

  /** Contraseña nueva, porque se la olvidó o porque hay que echarlo de una sesión que no reconoce. */
  operadorApi.post("/admins/:id/clave", async (req, res) => {
    const user = store.findUser(req.params.id);
    if (!user || user.role !== "admin") {
      res.status(404).json({ ok: false, error: "No existe esa cuenta." });
      return;
    }
    const pedida = req.body?.password ? String(req.body.password) : undefined;
    if (pedida !== undefined && pedida.length < 8) {
      res.status(400).json({ ok: false, error: "La contraseña tiene que tener al menos 8 caracteres." });
      return;
    }
    res.json({ ok: true, password: await resetPassword(user, pedida) });
  });

  /**
   * Editar la liga: su nombre y su dirección.
   *
   * El nombre no se guarda en un solo lado. El portal tiene `Liga.name` —lo que se ve en esta
   * tabla— y cada worker de la liga tiene su propio `config.leagueName`, que es lo que muestra el
   * panel arriba a la izquierda. Para que el cambio se vea de verdad hay que reiniciar los
   * servidores: cada uno toma el nombre del portal al arrancar. Son unos segundos sin escuchar
   * telemetría por servidor, y por eso el panel avisa antes de hacerlo.
   */
  operadorApi.post("/ligas/:id", (req, res) => {
    const liga = store.findLiga(req.params.id);
    if (!liga) {
      res.status(404).json({ ok: false, error: "No existe esa liga." });
      return;
    }
    const body = req.body ?? {};
    const patch: Partial<Pick<Liga, "name" | "slug">> = {};

    if (typeof body.name === "string" && body.name.trim()) {
      patch.name = body.name.trim().slice(0, 80);
    }

    if (typeof body.slug === "string" && body.slug.trim() && body.slug.trim() !== liga.slug) {
      const slug = toSlug(body.slug);
      if (!SLUG_RE.test(slug)) {
        res.status(400).json({
          ok: false,
          error: "La dirección va en minúsculas, con números y guiones, y de 2 a 40 caracteres.",
        });
        return;
      }
      const otra = store.findLigaBySlug(slug);
      if (otra && otra.id !== liga.id) {
        res.status(400).json({ ok: false, error: `Ya hay una liga en /l/${slug}.` });
        return;
      }
      patch.slug = slug;
    }

    if (!patch.name && !patch.slug) {
      res.status(400).json({ ok: false, error: "No viene nada para cambiar." });
      return;
    }

    store.updateLiga(liga.id, patch);
    // Reiniciar solo los que estaban corriendo. Una liga de una cuenta desactivada tiene que
    // seguir apagada después de renombrarla: si no, editarle el nombre sería la forma de
    // saltearse la baja.
    for (const servidor of store.servidoresDeLiga(liga.id)) {
      if (supervisor.isRunning(servidor.id)) supervisor.restart(servidor.id);
    }

    const actualizada = store.findLiga(liga.id)!;
    res.json({ ok: true, league: { slug: actualizada.slug, name: actualizada.name } });
  });

  /**
   * Un servidor más para una liga que ya tiene admin y token de embed propios — el caso real de
   * `fsl` corriendo Spa/GT3, México/F3 e Interlagos/M2 a la vez bajo la misma cuenta.
   *
   * Hasta acá esto era solo un comando de CLI (`agregar-servidor`), a propósito: los comandos de
   * escritura del CLI exigen el portal apagado, porque reescriben `portal.json` por fuera del
   * proceso que lo tiene en memoria. Ese costo (bajar la app para sumar un servidor) dejó de tener
   * sentido en cuanto una liga real necesitó hacerlo más de una vez — este endpoint corre DENTRO
   * del proceso vivo, con el mismo `addServidor` que ya usa `createLiga`, así que no hay archivo
   * que se pise: cero downtime.
   */
  operadorApi.post("/ligas/:id/servidores", (req, res) => {
    const liga = store.findLiga(req.params.id);
    if (!liga) {
      res.status(404).json({ ok: false, error: "No existe esa liga." });
      return;
    }
    const nombre = String((req.body ?? {}).nombre ?? "").trim().slice(0, 80);
    if (!nombre) {
      res.status(400).json({ ok: false, error: "El servidor necesita un nombre." });
      return;
    }
    try {
      const servidor = addServidor(liga.id, nombre);
      res.json({
        ok: true,
        servidor: {
          id: servidor.id,
          nombre: servidor.nombre,
          sendAddress: supervisor.sendAddressOf(servidor),
        },
        conectarUrl: `${baseUrl()}/conectar/${liga.slug}/${servidor.id}`,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Historial de sesiones de UN servidor puntual de una liga: lo escribe el worker en su propio
   * `dataDir` (ver `history/leagueEvents.ts`), y acá se lee directo de disco en vez de pedírselo al
   * worker por `askWorker`. A propósito: un servidor desactivado o apagado no tiene worker
   * corriendo, y es justo el caso en que más falta hace poder revisar qué pasó la última vez.
   *
   * Es por servidor, no por liga, desde que una liga puede tener varios (`fsl` con Spa/México/
   * Interlagos a la vez) — el modal de "Servidores" del operador muestra el historial de cada
   * pestaña por separado, y mezclar todo en un único listado por liga confundiría de qué evento es
   * cada carrera.
   */
  operadorApi.get("/ligas/:id/servidores/:servidorId/eventos", (req, res) => {
    const liga = store.findLiga(req.params.id);
    if (!liga) {
      res.status(404).json({ ok: false, error: "No existe esa liga." });
      return;
    }
    const servidor = store.servidoresDeLiga(liga.id).find((s) => s.id === req.params.servidorId);
    const eventos = servidor ? new LeagueEventsStore(supervisor.dataDirOf(servidor.id)).list() : [];
    res.json({ ok: true, eventos });
  });

  /** Borra una entrada del historial de un servidor. La que está en curso no se puede borrar — ver
   * `remove` en `LeagueEventsStore`. */
  operadorApi.delete("/ligas/:id/servidores/:servidorId/eventos/:eventId", (req, res) => {
    const liga = store.findLiga(req.params.id);
    if (!liga) {
      res.status(404).json({ ok: false, error: "No existe esa liga." });
      return;
    }
    const servidor = store.servidoresDeLiga(liga.id).find((s) => s.id === req.params.servidorId);
    const borrado = servidor
      ? new LeagueEventsStore(supervisor.dataDirOf(servidor.id)).remove(req.params.eventId)
      : false;
    if (!borrado) {
      res.status(404).json({ ok: false, error: "No existe ese evento, o todavía está en curso." });
      return;
    }
    res.json({ ok: true });
  });

  app.use("/api/operador", operadorApi);

  // --- Rutas de una liga -------------------------------------------------------------------------

  /**
   * Allowlist, no denylist: se enumera lo que pasa y todo lo demás da 404.
   *
   * Primero se resuelven las rutas de LIGA (el token de embed, la lista de servidores): son datos
   * de la cuenta, no de un servidor puntual, así que viven antes de que aparezca `/s/:servidorId`
   * en el path. Todo lo demás cuelga de un servidor concreto.
   *
   * El canal de pilotos (`/s/:id/api/client/*`) es el único que viaja sin sesión, porque lo
   * consume la app dentro del juego, que no puede tener una. No queda abierto: el worker exige ahí
   * un token firmado por la liga (ver security/pilotToken.ts), así que el portal lo deja pasar y
   * es el worker el que decide.
   */
  app.use("/l/:slug", (req: SessionRequest, res) => {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) {
      res.status(404).send("No existe esa liga.");
      return;
    }
    const liga = store.findLigaBySlug(slug);
    if (!liga) {
      res.status(404).send("No existe esa liga.");
      return;
    }

    const query = req.originalUrl.split("?")[1];
    const qs = query ? `?${query}` : "";
    // `req.url` acá adentro trae la query pegada (Express no la separa al recortar el prefijo del
    // mount) — sin este `.split`, un `?x=1` termina duplicado en el redirect de más abajo
    // (`.../?x=1?x=1`) porque `qs` ya lo tiene aparte.
    const resto = (req.url === "/" ? "/" : req.url).split("?")[0];

    /**
     * Token de embed: cookie-autenticado (lo pide el panel), opera sobre `Liga.embed` directo, sin
     * pasar por ningún worker — funciona aunque ningún servidor de la liga esté corriendo.
     */
    if (resto === "/api/embed-token") {
      if (!req.userId || !store.hasAccess(req.userId, liga.id)) {
        res.status(401).json({ ok: false, error: "Sesión vencida." });
        return;
      }
      checkCsrf(req, res, async () => {
        if (req.method === "GET") {
          res.json({ token: embedTokensFor(liga.id).issue(liga.embed.tokenVersion), allowedOrigin: liga.embed.allowedOrigin });
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          if (typeof body.allowedOrigin === "string") {
            const origen = body.allowedOrigin.trim();
            // Un origen es ESQUEMA://HOST[:PUERTO], sin path ni barra final: eso es justo lo que
            // el navegador manda en la cabecera `Origin` de un fetch. Vacío es válido a propósito:
            // es el estado "todavía no configurado", no un error.
            const válido = origen === "" || /^https?:\/\/[^\s/]+$/.test(origen);
            store.updateLigaEmbed(liga.id, { allowedOrigin: válido ? origen : liga.embed.allowedOrigin });
          }
          const actualizada = store.findLiga(liga.id)!;
          res.json({ token: embedTokensFor(actualizada.id).issue(actualizada.embed.tokenVersion), allowedOrigin: actualizada.embed.allowedOrigin });
          return;
        }
        res.status(405).end();
      });
      return;
    }

    /** Invalida el token vigente: todo lo emitido con la versión anterior deja de servir al
     * instante, para TODOS los servidores de la liga a la vez (es un solo token por liga). */
    if (resto === "/api/embed-token/regenerate") {
      if (!req.userId || !store.hasAccess(req.userId, liga.id)) {
        res.status(401).json({ ok: false, error: "Sesión vencida." });
        return;
      }
      if (req.method !== "POST") {
        res.status(405).end();
        return;
      }
      checkCsrf(req, res, () => {
        store.updateLigaEmbed(liga.id, { tokenVersion: liga.embed.tokenVersion + 1 });
        const actualizada = store.findLiga(liga.id)!;
        res.json({ token: embedTokensFor(actualizada.id).issue(actualizada.embed.tokenVersion) });
      });
      return;
    }

    /** Lista de servidores de la liga, para el selector del panel (cookie). */
    if (resto === "/api/servidores") {
      if (!req.userId || !store.hasAccess(req.userId, liga.id)) {
        res.status(401).json({ ok: false, error: "Sesión vencida." });
        return;
      }
      if (req.method !== "GET") {
        res.status(405).end();
        return;
      }
      const servidores = store.servidoresDeLiga(liga.id).map((s) => ({ id: s.id, nombre: s.nombre, status: s.status }));
      res.json({ ok: true, servidores });
      return;
    }

    /** Lo mismo, para el selector del embed en una página ajena (Bearer de liga). */
    if (resto === "/api/embed/servidores") {
      if (!embedGate(req, res, liga)) return;
      if (req.method !== "GET") {
        res.status(405).end();
        return;
      }
      const servidores = store.servidoresDeLiga(liga.id).map((s) => ({ id: s.id, nombre: s.nombre, activo: s.status === "running" }));
      res.json({ ok: true, servidores });
      return;
    }

    /**
     * `embed.js`/`embed.css` (`src/api/public/embed/`) y los logos de marca
     * (`src/api/public/brands/*.svg`) los pide el navegador de quien mira fslmanager.vercel.app,
     * que no tiene sesión con Race Control — si esto le exigiera `req.userId` como el panel, el
     * `<script src="…/embed/embed.js">` recibiría la redirección al login en vez del archivo, y
     * fallaría en silencio (un script que "ejecuta" un 302 a una página HTML no hace nada). No hay
     * nada secreto en estos archivos — el token vive en el propio `<script>` del snippet, no acá —
     * así que alcanza con dejarlos pasar. Son evento-agnósticos: el contenido es idéntico entre
     * workers de la misma liga, así que van al PRIMER servidor sin que importe cuál.
     */
    const esAssetDeEmbed = resto.startsWith("/embed/");
    const esAssetDeBrands = resto.startsWith("/brands/");
    if (esAssetDeEmbed || esAssetDeBrands) {
      const primero = store.servidoresDeLiga(liga.id)[0];
      if (!primero) {
        res.status(404).send("Esta liga todavía no tiene servidores.");
        return;
      }
      proxyToWorker(req, res, { port: primero.adminPort, path: resto + qs });
      return;
    }

    // --- De acá para abajo, todo cuelga de UN servidor concreto -----------------------------------

    const matchServidor = resto.match(/^\/s\/([^/]+)((?:\/.*)?)$/);
    if (!matchServidor || !SERVIDOR_ID_RE.test(matchServidor[1])) {
      // Sin `/s/<id>` en el path: ni el panel puede resolver sus archivos relativos, ni el portal
      // sabe a qué proceso mandar el pedido. En vez de un 404 seco, se manda al primer servidor de
      // la liga con el resto del path pegado atrás — cubre tanto `/l/fsl` a secas (el caso típico:
      // alguien que recién entra) como un bookmark viejo de antes de que existiera el selector.
      const primero = store.servidoresDeLiga(liga.id)[0];
      if (!primero) {
        res.status(404).send("Esta liga todavía no tiene servidores.");
        return;
      }
      res.redirect(308, `/l/${slug}/s/${primero.id}${resto}${qs}`);
      return;
    }

    const servidorId = matchServidor[1];
    const sub = matchServidor[2] || "/";
    const servidor = store.findServidor(servidorId);
    if (!servidor || servidor.ligaId !== liga.id) {
      res.status(404).send("No existe ese servidor.");
      return;
    }

    const esCanalDePilotos = sub.startsWith("/api/client/");
    if (esCanalDePilotos) {
      proxyToWorker(req, res, { port: servidor.clientPort, path: sub + qs });
      return;
    }

    /**
     * El embed en una página ajena no tiene sesión ni cookie —viaja con el Bearer de la liga, ver
     * `embedGate`— así que bypassa el chequeo de `req.userId` de abajo igual que el canal de
     * pilotos. `x-rc-user` identifica el canal en el journal como lo que es, no como un comisario
     * logueado — el mismo criterio que ya usa `RC_PUBLIC_LEAGUE` más abajo.
     */
    const esCanalDeEmbed = sub.startsWith("/api/embed/");
    if (esCanalDeEmbed) {
      if (!embedGate(req, res, liga)) return;
      proxyToWorker(req, res, { port: servidor.adminPort, path: sub + qs }, { "x-rc-user": `embed:${slug}` });
      return;
    }

    if (!req.userId) {
      // Un `fetch` del panel espera JSON; una navegación del navegador, el login.
      if (sub.startsWith("/api/")) res.status(401).json({ ok: false, error: "Sesión vencida." });
      else res.redirect(`/login?volver=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (!store.hasAccess(req.userId, liga.id)) {
      res.status(403).send("No tenés acceso a esta liga.");
      return;
    }
    // La suscripción es del dueño, no de cada comisario: si el dueño está desactivado, la liga
    // entera queda cerrada aunque un comisario suyo siga teniendo su cuenta en pie.
    const dueño = liga.ownerId ? store.findUser(liga.ownerId) : undefined;
    if (dueño && !dueño.active) {
      res.status(403).send("Esta liga está desactivada. Hablá con quien te dio el acceso.");
      return;
    }
    if (servidor.status !== "running") {
      // Pedirlo es la señal más clara de que alguien lo quiere usar: si está parado, se levanta.
      if (servidor.status === "stopped") supervisor.start(servidor.id);
    }

    checkCsrf(req, res, () => {
      // El panel usa el History API: cualquier ruta que no sea un archivo ni una API tiene que
      // devolver el index. Eso ya lo resuelve el worker con su propio catch-all.
      //
      // `X-RC-User` es lo que convierte el registro del worker en auditoría de verdad: sin eso,
      // en una liga con varios comisarios el journal diría "alguien kickeó al piloto 7".
      const email = store.findUser(req.userId!)?.email ?? "?";
      proxyToWorker(req, res, { port: servidor.adminPort, path: sub + qs }, { "x-rc-user": email });
    });
  });

  /**
   * Rama `feature/panel-simplificado-fsl`: la pantalla fusionada va a vivir incrustada dentro de
   * fslmanager.vercel.app, no detrás de un login propio. `RC_PUBLIC_LEAGUE` (el slug de la liga)
   * hace que la raíz del dominio sirva el panel del PRIMER servidor de esa liga, directo, sin
   * sesión ni CSRF: no hay cookie que proteger, así que `checkCsrf` no pinta nada acá. Sin la
   * variable de entorno, el comportamiento de siempre (login, selección de liga) sigue intacto —
   * esto es estrictamente aditivo y no debería existir en `main`.
   */
  const PUBLIC_LEAGUE_SLUG = process.env.RC_PUBLIC_LEAGUE || "";
  if (PUBLIC_LEAGUE_SLUG) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (
        req.path.startsWith("/l/") ||
        req.path.startsWith("/api/operador") ||
        req.path === "/login" ||
        req.path === "/mis-ligas" ||
        req.path === "/operador" ||
        req.path.startsWith("/conectar/")
      ) {
        next();
        return;
      }
      const liga = store.findLigaBySlug(PUBLIC_LEAGUE_SLUG);
      const primero = liga ? store.servidoresDeLiga(liga.id)[0] : undefined;
      if (!liga || !primero) {
        next();
        return;
      }
      if (primero.status !== "running") {
        if (primero.status === "stopped") supervisor.start(primero.id);
      }
      proxyToWorker(req, res, { port: primero.adminPort, path: req.url }, { "x-rc-user": `embed:${PUBLIC_LEAGUE_SLUG}` });
    });
  }

  // --- Pantallas del portal ----------------------------------------------------------------------

  app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  const pagina = (nombre: string) => (_req: Request, res: Response) =>
    res.sendFile(path.join(__dirname, "public", nombre));

  app.get("/login", pagina("login.html"));
  app.get("/mis-ligas", pagina("mis-ligas.html"));
  app.get("/operador", pagina("operador.html"));
  app.get("/conectar/:slug/:servidorId", pagina("conectar.html"));
  app.get("/", pagina("index.html"));

  app.use((_req, res) => res.status(404).send("No encontrado."));

  // --- Altas y bajas ------------------------------------------------------------------------------

  function baseUrl(): string {
    return `${config.secureCookies ? "https" : "http"}://${config.publicHost}`;
  }

  /**
   * Crea la liga, su cuenta de admin y su primer servidor de una sola vez.
   *
   * Van juntas a propósito: una liga sin servidor es un puerto UDP que nadie reservó, una liga sin
   * dueño es un puerto UDP reservado que nadie usa, y una cuenta sin liga es alguien que entra y no
   * tiene nada que mirar.
   */
  async function createLiga(
    input: { slug: string; name: string; email: string; password?: string; servidorNombre?: string },
    options: { start?: boolean } = {}
  ): Promise<Credenciales> {
    if (!SLUG_RE.test(input.slug)) {
      throw new Error(`"${input.slug}" no sirve como dirección: usá minúsculas, números y guiones (2 a 40 caracteres).`);
    }
    if (store.findLigaBySlug(input.slug)) throw new Error(`Ya existe una liga en /l/${input.slug}.`);
    if (store.findUserByEmail(input.email)) {
      throw new Error(`Ya hay una cuenta con el email ${normalizeEmail(input.email)}.`);
    }

    // Los puertos primero: si no quedan, es mejor fallar antes de haber creado media cosa.
    const ports = assignPorts(store.usedPorts(), {
      udpFrom: config.udpPortFrom,
      udpTo: config.udpPortTo,
      loopbackFrom: config.loopbackPortFrom,
    });

    const password = input.password || generatePassword();
    const user = store.createUser(input.email, await hashPassword(password), "admin");
    const liga = store.createLiga({ slug: input.slug, name: input.name, ownerId: user.id });
    const servidor = store.createServidor({
      ligaId: liga.id,
      nombre: input.servidorNombre || input.name,
      udpPort: ports.udpPort,
      adminPort: ports.adminPort,
      clientPort: ports.clientPort,
    });
    store.addMembership({ userId: user.id, ligaId: liga.id, role: "owner" });
    // El CLI pasa `start: false`: ahí no hay portal corriendo, y un worker forkeado por un proceso
    // que termina en dos segundos se muere con él dejando el servidor marcado como "en marcha".
    if (options.start !== false) supervisor.start(servidor.id);

    return { liga, user, password, loginUrl: `${baseUrl()}/login` };
  }

  /** Un servidor más para una liga que ya existe — ej. México/F3 sumándose a una cuenta que ya
   * tenía Spa/GT3. No crea nada más: la cuenta y el acceso son de la liga, no de cada servidor. */
  function addServidor(ligaId: string, nombre: string, options: { start?: boolean } = {}): Servidor {
    const liga = store.findLiga(ligaId);
    if (!liga) throw new Error("No existe esa liga.");
    const ports = assignPorts(store.usedPorts(), {
      udpFrom: config.udpPortFrom,
      udpTo: config.udpPortTo,
      loopbackFrom: config.loopbackPortFrom,
    });
    const servidor = store.createServidor({
      ligaId,
      nombre,
      udpPort: ports.udpPort,
      adminPort: ports.adminPort,
      clientPort: ports.clientPort,
    });
    if (options.start !== false) supervisor.start(servidor.id);
    return servidor;
  }

  async function resetPassword(user: User, password?: string): Promise<string> {
    const nueva = password || generatePassword();
    // `setPassword` sube `sessionsVersion`, así que quien estuviera usando la cuenta con la clave
    // vieja se cae en el próximo pedido. Es el punto de la operación.
    store.setPassword(user.id, await hashPassword(nueva));
    return nueva;
  }

  /**
   * La primera cuenta de operador, sembrada desde el entorno en el primer arranque.
   *
   * Sin esto habría un huevo y la gallina: el panel del operador crea cuentas, pero a ese panel
   * solo entra un operador. Devuelve la contraseña si tuvo que crear la cuenta, y `null` si ya
   * había una — así un redeploy no la pisa ni la reimprime.
   */
  async function ensureOperator(email: string, password?: string): Promise<string | null> {
    if (store.hasOperator()) return null;
    const limpio = normalizeEmail(email);
    if (!limpio.includes("@")) throw new Error(`"${email}" no parece un email.`);
    if (store.findUserByEmail(limpio)) throw new Error(`Ya existe una cuenta con el email ${limpio}.`);
    const nueva = password || generatePassword();
    store.createUser(limpio, await hashPassword(nueva), "operador");
    return nueva;
  }

  // --- Auxiliares de presentación ------------------------------------------------------------------

  function puertosUdpLibres(): number {
    const usados = store.usedPorts();
    let libres = 0;
    for (let p = config.udpPortFrom; p <= config.udpPortTo; p++) if (!usados.has(p)) libres += 1;
    return libres;
  }

  function toSlugSeguro(nombre: string): string {
    const base = toSlug(nombre);
    if (!base || !SLUG_RE.test(base)) {
      throw new Error(`No pude armar una dirección con "${nombre}". Poné una a mano.`);
    }
    return base;
  }

  // Calienta el hash señuelo al arrancar: si se calculara en el primer login fallido, ese primer
  // intento tardaría distinto que los demás y delataría justo lo que el señuelo esconde.
  void DECOY_HASH;

  return { app, store, supervisor, sessions, createLiga, addServidor, resetPassword, ensureOperator };
}

/** Estado de la cuota, calculado en el servidor: el reloj del navegador no decide esto. */
export interface Subscription {
  paidUntil: string;
  /** Días que faltan (negativo si ya venció), o `null` si la cuenta no tiene cuota cargada. */
  daysLeft: number | null;
  state: "sin-cuota" | "al-dia" | "por-vencer" | "vencida";
}

const DIA_MS = 24 * 60 * 60 * 1000;
/** Una semana de aviso: alcanza para que el admin reaccione sin volverse un cartel permanente. */
const AVISO_DIAS = 7;

export function subscriptionOf(user: User | undefined): Subscription {
  const paidUntil = user?.paidUntil?.trim() || "";
  if (!paidUntil) return { paidUntil: "", daysLeft: null, state: "sin-cuota" };
  const vence = Date.parse(`${paidUntil}T23:59:59`);
  if (!Number.isFinite(vence)) return { paidUntil, daysLeft: null, state: "sin-cuota" };
  const daysLeft = Math.ceil((vence - Date.now()) / DIA_MS);
  const state = daysLeft < 0 ? "vencida" : daysLeft <= AVISO_DIAS ? "por-vencer" : "al-dia";
  return { paidUntil, daysLeft, state };
}

/** Orden de la tabla del operador: primero lo que hay que mirar hoy. */
function ordenDeAtencion(fila: { active: boolean; subscription: Subscription }): number {
  if (!fila.active) return 3;
  if (fila.subscription.state === "vencida") return 0;
  if (fila.subscription.state === "por-vencer") return 1;
  return 2;
}
