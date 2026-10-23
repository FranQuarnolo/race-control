import * as crypto from "crypto";

/**
 * Contraseñas y sesiones, sin una sola dependencia de npm.
 *
 * `crypto.scrypt` viene en Node y es exactamente lo que hace falta: una KDF con costo de memoria,
 * que es lo que vuelve caro el ataque por GPU. Lo demás —comparación en tiempo constante, hash
 * señuelo, cookies de sesión— es cuestión de usarlo bien, no de traer una librería.
 */

const SCRYPT_N = 1 << 15; // 32768: ~90 ms y 32 MB por verificación. Un login humano ni lo nota.
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `maxmem` por defecto (32 MB) queda JUSTO en el límite con N=2^15 y tira "memory limit
    // exceeded" de forma intermitente. Se sube explícitamente en vez de bajar el costo.
    crypto.scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("hex"), key.toString("hex")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
    const key = await scrypt(password, Buffer.from(saltHex, "hex"), Number(n), Number(r), Number(p));
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * Hash de una contraseña que no existe, para gastar el mismo tiempo cuando el email no está.
 *
 * Sin esto, un login con email inexistente contesta en microsegundos y uno con email real tarda
 * ~90 ms: medir el tiempo de respuesta alcanza para listar qué cuentas existen en el portal.
 */
export const DECOY_HASH = hashPassword(crypto.randomBytes(32).toString("hex"));

export async function verifyWithDecoy(password: string, stored: string | undefined): Promise<boolean> {
  if (!stored) {
    await verifyPassword(password, await DECOY_HASH);
    return false;
  }
  return verifyPassword(password, stored);
}

// --- Sesiones -----------------------------------------------------------------------------------

export const SESSION_COOKIE = "__Host-rc_session";

/** 2 h sin tocar nada cierra la sesión; 12 h la cierran igual aunque se esté usando. */
const IDLE_MS = 2 * 60 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;

interface Session {
  userId: string;
  /** Si la del usuario avanzó, esta sesión es de antes del cambio de contraseña: se cae. */
  sessionsVersion: number;
  createdAt: number;
  lastSeenAt: number;
}

export class SessionStore {
  /** Indexadas por el HASH del id, no por el id: lo que se guarda en memoria no sirve para
   * entrar si algo lo filtra (un volcado de memoria, un log de depuración). */
  private sessions = new Map<string, Session>();

  private static key(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  create(userId: string, sessionsVersion: number): string {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    this.sessions.set(SessionStore.key(token), { userId, sessionsVersion, createdAt: now, lastSeenAt: now });
    return token;
  }

  /** Devuelve el userId y refresca la ventana de inactividad, o `null` si ya no vale. */
  touch(token: string | undefined, currentVersionOf: (userId: string) => number | undefined): string | null {
    if (!token) return null;
    const key = SessionStore.key(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    const now = Date.now();
    if (now - session.lastSeenAt > IDLE_MS || now - session.createdAt > ABSOLUTE_MS) {
      this.sessions.delete(key);
      return null;
    }
    if (currentVersionOf(session.userId) !== session.sessionsVersion) {
      this.sessions.delete(key);
      return null;
    }
    session.lastSeenAt = now;
    return session.userId;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(SessionStore.key(token));
  }

  /** Limpieza periódica: sin esto, cada login deja una entrada en memoria para siempre. */
  sweep(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastSeenAt > IDLE_MS || now - session.createdAt > ABSOLUTE_MS) this.sessions.delete(key);
    }
  }
}

// --- Freno a la fuerza bruta ---------------------------------------------------------------------

/**
 * Dos frenos distintos porque son dos ataques distintos.
 *
 * Por IP se **bloquea**: quien prueba contraseñas contra muchas cuentas viene de una dirección y
 * cortarle no le hace daño a nadie más. Por cuenta se **demora** y no se bloquea: si bloqueara,
 * cualquiera podría dejar al admin afuera de su propia liga el día de la carrera tirando diez
 * logins fallidos a propósito.
 */
export class LoginThrottle {
  private byIp = new Map<string, { fails: number; until: number }>();
  private byAccount = new Map<string, number>();

  private static readonly IP_MAX_FAILS = 10;
  private static readonly IP_WINDOW_MS = 15 * 60 * 1000;

  ipBlocked(ip: string): boolean {
    const entry = this.byIp.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.until) {
      this.byIp.delete(ip);
      return false;
    }
    return entry.fails >= LoginThrottle.IP_MAX_FAILS;
  }

  /** Cuánto esperar antes de contestar este intento, por los fallos previos de esta cuenta. */
  accountDelayMs(email: string): number {
    const fails = this.byAccount.get(email) || 0;
    if (fails === 0) return 0;
    return Math.min(30_000, 1000 * 2 ** (fails - 1));
  }

  fail(ip: string, email: string): void {
    const entry = this.byIp.get(ip);
    const now = Date.now();
    if (!entry || now > entry.until) this.byIp.set(ip, { fails: 1, until: now + LoginThrottle.IP_WINDOW_MS });
    else entry.fails += 1;
    this.byAccount.set(email, (this.byAccount.get(email) || 0) + 1);
  }

  success(ip: string, email: string): void {
    this.byIp.delete(ip);
    this.byAccount.delete(email);
  }
}

export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Token de invitación: se entrega en claro una sola vez y se guarda hasheado. */
export function newInviteToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(24).toString("base64url");
  return { token, hash: crypto.createHash("sha256").update(token).digest("hex") };
}

export function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
