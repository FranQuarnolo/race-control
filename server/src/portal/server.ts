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
  hashInviteToken,
  hashPassword,
  newInviteToken,
  verifyWithDecoy,
} from "./auth";
import { askWorker, proxyToWorker } from "./proxy";
import { League, PortalStore, normalizeEmail } from "./store";
import { Supervisor, assignPorts } from "./supervisor";

/**
 * El portal: una sola puerta a internet, con las ligas detrás.
 *
 * Todo lo que entra pasa por acá. Las rutas `/l/<slug>/...` se reenvían al worker de esa liga
 * después de verificar quién pide y si tiene permiso; lo demás son las pantallas del portal
 * (landing, login, aceptar una invitación, elegir liga).
 */

export interface PortalConfig {
  port: number;
  dataRoot: string;
  /** Host público, ej. `race-control.fly.dev`. Sin esquema ni barra final. */
  publicHost: string;
  /** IP pública del servidor: la que va en el "Send Address" del hosting del admin. */
  publicIp: string;
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

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export interface Portal {
  app: express.Express;
  store: PortalStore;
  supervisor: Supervisor;
  sessions: SessionStore;
  /** Crea una liga y su invitación. Lo usa el CLI y también los tests. */
  createLeague(input: { slug: string; name: string; email: string }): { league: League; inviteUrl: string };
  /** Invitación nueva a una liga que ya existe: sumar un comisario, o recuperar un acceso. */
  invite(league: League, email: string): string;
}

export function createPortal(config: PortalConfig): Portal {
  fs.mkdirSync(config.dataRoot, { recursive: true });
  const store = new PortalStore(path.join(config.dataRoot, "portal.json"));
  const sessions = new SessionStore();
  const throttle = new LoginThrottle();
  const supervisor = new Supervisor(store, {
    dataRoot: config.dataRoot,
    // En el `.exe` esto no existe: el worker solo vive compilado, al lado del portal.
    workerPath: path.join(__dirname, "..", "worker", "leagueWorker.js"),
    publicIp: config.publicIp,
    publicHost: config.publicHost,
    udpBindAddress: config.udpBindAddress,
  });

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
      // que son los que importan, siguen restringidos a archivos propios.
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
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
    const esCanalDePilotos = /^\/l\/[a-z0-9-]+\/api\/client\//.test(req.path);
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
   * pilotos queda afuera: no usa cookies, así que no hay sesión que robar.
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

  // --- API del portal ---------------------------------------------------------------------------

  const portalApi = express.Router();
  portalApi.use(express.json({ limit: "10kb" }));
  portalApi.use(checkCsrf);

  portalApi.get("/me", (req: SessionRequest, res) => {
    if (!req.userId) {
      res.json({ authenticated: false, version: APP_VERSION });
      return;
    }
    const user = store.findUser(req.userId);
    const leagues = store
      .membershipsOf(req.userId)
      .map((m) => store.findLeague(m.leagueId))
      .filter((l): l is League => Boolean(l))
      .map((l) => ({
        slug: l.slug,
        name: l.name,
        status: l.status,
        lastError: l.lastError,
        sendAddress: supervisor.sendAddressOf(l),
      }));
    res.json({ authenticated: true, email: user?.email, leagues, version: APP_VERSION });
  });

  /**
   * Lo único que la pantalla de puesta en marcha necesita: qué pegar, y si ya está llegando.
   *
   * Sale del portal y no del panel de la liga porque es la pantalla que ve alguien que todavía
   * no entró nunca al panel — y porque el "Send Address" lo sabe el portal (es su IP y el puerto
   * que él asignó), no el worker.
   */
  portalApi.get("/liga/:slug", async (req: SessionRequest, res) => {
    const league = store.findLeagueBySlug(req.params.slug);
    if (!league || !req.userId || !store.hasAccess(req.userId, league.id)) {
      res.status(404).json({ ok: false, error: "No existe esa liga." });
      return;
    }
    if (league.status === "stopped") supervisor.start(league.id);
    const state = await askWorker<{ network?: { receivingTelemetry?: boolean } }>(league.adminPort, "/api/state");
    res.json({
      ok: true,
      name: league.name,
      slug: league.slug,
      status: league.status,
      sendAddress: supervisor.sendAddressOf(league),
      /** `null` mientras el worker todavía no contesta: no es lo mismo que "no está llegando". */
      receiving: state ? Boolean(state.network?.receivingTelemetry) : null,
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
    throttle.success(ip, email);
    setSessionCookie(res, sessions.create(user.id, user.sessionsVersion));
    res.json({ ok: true });
  });

  portalApi.post("/logout", (req: SessionRequest, res) => {
    sessions.destroy(readCookie(req, cookieName()));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  /** Paso 1 del alta: el link de invitación dice a qué liga pertenece, sin exponer nada más. */
  portalApi.get("/invitacion/:token", (req, res) => {
    const invite = store.findInvite(hashInviteToken(req.params.token));
    if (!invite || invite.usedAt || invite.expiresAt < Date.now()) {
      res.status(404).json({ ok: false, error: "Esta invitación no existe o ya venció." });
      return;
    }
    const league = store.findLeague(invite.leagueId);
    res.json({ ok: true, email: invite.email, league: league ? { name: league.name, slug: league.slug } : null });
  });

  /** Paso 2: elige contraseña y queda adentro, sin un segundo login. */
  portalApi.post("/invitacion/:token", async (req, res) => {
    const hash = hashInviteToken(req.params.token);
    const invite = store.findInvite(hash);
    if (!invite || invite.usedAt || invite.expiresAt < Date.now()) {
      res.status(404).json({ ok: false, error: "Esta invitación no existe o ya venció." });
      return;
    }
    const password = String((req.body ?? {}).password ?? "");
    if (password.length < 10) {
      res.status(400).json({ ok: false, error: "La contraseña tiene que tener al menos 10 caracteres." });
      return;
    }
    const league = store.findLeague(invite.leagueId);
    if (!league) {
      res.status(410).json({ ok: false, error: "La liga de esta invitación ya no existe." });
      return;
    }

    let user = store.findUserByEmail(invite.email);
    if (user) store.setPassword(user.id, await hashPassword(password));
    else user = store.createUser(invite.email, await hashPassword(password));
    store.addMembership({ userId: user.id, leagueId: league.id, role: "owner" });
    store.setOwner(league.id, user.id);
    store.useInvite(hash);
    // La liga se crea parada y arranca recién cuando su dueño entra: no tiene sentido tener un
    // proceso ocupando un puerto UDP por una invitación que quizás nadie abra.
    supervisor.start(league.id);

    const fresh = store.findUser(user.id)!;
    setSessionCookie(res, sessions.create(fresh.id, fresh.sessionsVersion));
    res.json({ ok: true, slug: league.slug });
  });

  app.use("/api/portal", portalApi);

  // --- Rutas de una liga -------------------------------------------------------------------------

  /**
   * Allowlist, no denylist: se enumera lo que pasa y todo lo demás da 404.
   *
   * El canal de pilotos (`/api/client/*`) es el único que viaja sin sesión, porque lo consume la
   * app dentro del juego, que no puede tener una. No queda abierto: el worker exige ahí un token
   * firmado por la liga (ver security/pilotToken.ts), así que el portal lo deja pasar y es el
   * worker el que decide.
   */
  app.use("/l/:slug", (req: SessionRequest, res) => {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) {
      res.status(404).send("No existe esa liga.");
      return;
    }
    const league = store.findLeagueBySlug(slug);
    if (!league) {
      res.status(404).send("No existe esa liga.");
      return;
    }

    // `/l/fsl` sin barra final rompe todo lo relativo del panel: el navegador resolvería
    // `styles.css` contra `/l/` y pediría `/l/styles.css`. Una redirección y se acabó.
    const [soloRuta, query] = req.originalUrl.split("?");
    if (soloRuta === `/l/${slug}`) {
      res.redirect(308, `/l/${slug}/${query ? `?${query}` : ""}`);
      return;
    }

    const resto = req.url === "/" ? "/" : req.url;
    const esCanalDePilotos = resto.startsWith("/api/client/");
    if (esCanalDePilotos) {
      proxyToWorker(req, res, { port: league.clientPort, path: resto });
      return;
    }

    if (!req.userId) {
      // Un `fetch` del panel espera JSON; una navegación del navegador, el login.
      if (resto.startsWith("/api/")) res.status(401).json({ ok: false, error: "Sesión vencida." });
      else res.redirect(`/login?volver=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (!store.hasAccess(req.userId, league.id)) {
      res.status(403).send("No tenés acceso a esta liga.");
      return;
    }
    if (league.status !== "running") {
      // Pedirla es la señal más clara de que alguien la quiere usar: si está parada, se levanta.
      if (league.status === "stopped") supervisor.start(league.id);
    }

    checkCsrf(req, res, () => {
      // El panel usa el History API: cualquier ruta que no sea un archivo ni una API tiene que
      // devolver el index. Eso ya lo resuelve el worker con su propio catch-all.
      //
      // `X-RC-User` es lo que convierte el registro del worker en auditoría de verdad: sin eso,
      // en una liga con varios comisarios el journal diría "alguien kickeó al piloto 7".
      const email = store.findUser(req.userId!)?.email ?? "?";
      proxyToWorker(req, res, { port: league.adminPort, path: resto }, { "x-rc-user": email });
    });
  });

  // --- Pantallas del portal ----------------------------------------------------------------------

  app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  const pagina = (nombre: string) => (_req: Request, res: Response) =>
    res.sendFile(path.join(__dirname, "public", nombre));

  app.get("/login", pagina("login.html"));
  app.get("/invitacion/:token", pagina("invitacion.html"));
  app.get("/conectar/:slug", pagina("conectar.html"));
  app.get("/", pagina("index.html"));

  app.use((_req, res) => res.status(404).send("No encontrado."));

  // --- Alta de ligas (CLI) -----------------------------------------------------------------------

  function createLeague(input: { slug: string; name: string; email: string }): { league: League; inviteUrl: string } {
    if (!SLUG_RE.test(input.slug)) {
      throw new Error(`"${input.slug}" no sirve como dirección: usá minúsculas, números y guiones (2 a 40 caracteres).`);
    }
    if (store.findLeagueBySlug(input.slug)) throw new Error(`Ya existe una liga en /l/${input.slug}.`);

    const ports = assignPorts(store.usedPorts(), {
      udpFrom: config.udpPortFrom,
      udpTo: config.udpPortTo,
      loopbackFrom: config.loopbackPortFrom,
    });
    const league = store.createLeague({
      slug: input.slug,
      name: input.name,
      ownerId: "",
      udpPort: ports.udpPort,
      adminPort: ports.adminPort,
      clientPort: ports.clientPort,
    });

    return { league, inviteUrl: invite(league, input.email) };
  }

  function invite(league: League, email: string): string {
    const { token, hash } = newInviteToken();
    store.addInvite({
      tokenHash: hash,
      leagueId: league.id,
      email: normalizeEmail(email),
      // 48 h: suficiente para que el admin lo abra sin apuro, corto para que un link que quedó
      // en un chat no sirva para siempre.
      expiresAt: Date.now() + 48 * 60 * 60 * 1000,
    });
    const esquema = config.secureCookies ? "https" : "http";
    return `${esquema}://${config.publicHost}/invitacion/${token}`;
  }

  // Calienta el hash señuelo al arrancar: si se calculara en el primer login fallido, ese primer
  // intento tardaría distinto que los demás y delataría justo lo que el señuelo esconde.
  void DECOY_HASH;

  return { app, store, supervisor, sessions, createLeague, invite };
}
