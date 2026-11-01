import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Todo el estado del portal en un archivo JSON, con escritura atómica.
 *
 * No es una base de datos y no hace falta que lo sea: escribe un solo proceso, la escala es de
 * decenas de ligas y las consultas son "dame la liga por slug". `node:sqlite` todavía es
 * experimental en Node 22 y agregaría una pieza que acá no compra nada. Si algún día hacen falta
 * consultas de verdad, se migra.
 *
 * **Liga vs. Servidor**: una Liga es la cuenta (login, slug, membresías, el token de embed que se
 * pega UNA vez en una página ajena). Un Servidor es un proceso worker concreto — un puerto UDP, un
 * `adminPort`/`clientPort`, un `dataDir` — lo que hasta la versión 1.25 el código llamaba `League`
 * 1:1. Una liga puede tener varios servidores corriendo a la vez (ej. Spa/GT3, México/F3,
 * Interlagos/M2 bajo la misma cuenta de hosting), nunca dos en la misma sesión de carrera a la vez.
 * No se llamó "Evento" a propósito: esa palabra ya la usa el producto para una sesión de carrera
 * archivada (ver `history/leagueEvents.ts` y el botón "Terminar evento") — ponerle el mismo nombre
 * a un proceso worker hubiera dejado dos "evento" con significados distintos en el mismo panel.
 */

export type ServidorStatus = "stopped" | "starting" | "running" | "failed";

/**
 * `operador` es quien vende el servicio (uno solo, normalmente); `admin` es el dueño de una liga.
 *
 * No hay registro abierto: todas las cuentas las crea el operador. Por eso no hace falta un rol
 * "invitado" ni un estado "pendiente de confirmar" — una cuenta existe porque alguien la creó a
 * propósito.
 */
export type UserRole = "operador" | "admin";

export interface User {
  id: string;
  email: string;
  /** Formato `scrypt$N$r$p$saltHex$hashHex` — autodescriptivo para poder subir el costo después. */
  password: string;
  /** Se incrementa al cambiar la contraseña: invalida de golpe todas las sesiones abiertas. */
  sessionsVersion: number;
  role: UserRole;
  /**
   * El interruptor de la suscripción, y el único que corta de verdad.
   *
   * En `false` la cuenta no entra y sus servidores se apagan, pero no se borra nada: config,
   * sanciones y registros quedan intactos para cuando vuelva a pagar.
   */
  active: boolean;
  /**
   * Hasta cuándo está paga la cuota (`2026-11-30`). Vacío = sin control de pago.
   *
   * A propósito **no** bloquea solo cuando vence. Un corte automático en mitad de una carrera del
   * domingo por una fecha mal cargada es peor que cualquier impago: lo que hace es avisarle al
   * admin y ordenar la lista del operador, que decide con el dedo.
   */
  paidUntil?: string;
  lastLoginAt?: string;
  /** Lo que el operador necesite anotarse: cómo paga, por dónde se contactan, lo que sea. */
  note?: string;
  createdAt: string;
}

export interface Liga {
  id: string;
  /** Lo que va en la URL: `/l/<slug>`. Minúsculas, números y guiones. */
  slug: string;
  name: string;
  ownerId: string;
  /**
   * Token de embed, uno solo por liga — no por servidor. El admin lo pega una vez en su página
   * (ej. fslmanager.vercel.app) y desde ahí elige con un selector a qué servidor mirar, sin tener
   * que generar un token nuevo ni volver a pegar el snippet cada vez que cambia de carrera.
   */
  embed: {
    tokenVersion: number;
    allowedOrigin: string;
  };
  createdAt: string;
}

export interface Servidor {
  id: string;
  ligaId: string;
  /** Lo que ve el admin en el selector: "Spa GT3", "México F3". No es lo que muestra el panel
   * arriba a la izquierda — eso sigue siendo `Liga.name` (ver `config.leagueName`). */
  nombre: string;
  udpPort: number;
  adminPort: number;
  clientPort: number;
  status: ServidorStatus;
  /** Último error del worker, para mostrarlo en el portal en vez de reintentar en silencio. */
  lastError?: string;
  createdAt: string;
}

export interface Membership {
  userId: string;
  ligaId: string;
  role: "owner" | "steward";
}

interface PortalData {
  version: 2;
  users: User[];
  ligas: Liga[];
  servidores: Servidor[];
  memberships: Membership[];
}

function emptyData(): PortalData {
  return { version: 2, users: [], ligas: [], servidores: [], memberships: [] };
}

export function newId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

/** Normaliza el email para comparar: el alta y el login tienen que coincidir aunque uno venga
 * con mayúsculas. No se toca el dominio ni se quitan puntos — eso rompe proveedores reales. */
export function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

/** Slug válido para una URL: lo que no entra se cae, y vacío no se acepta. */
export function toSlug(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export class PortalStore {
  private data: PortalData = emptyData();

  constructor(private file: string) {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) {
      this.save();
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      // Sin migración: `version` pasó de 1 a 2 con el quiebre de esquema Liga/Servidor (ver
      // CHANGELOG). Un `portal.json` de la versión anterior no carga — no hay datos de producción
      // que preservar todavía, así que arranca vacío en vez de adivinar cómo partir cada `League`.
      if (parsed.version !== 2) {
        const backup = `${this.file}.v${parsed.version ?? "?"}-${Date.now()}`;
        fs.renameSync(this.file, backup);
        console.error(`[portal] ${this.file} es de un esquema viejo (versión ${parsed.version}). Lo guardé en ${backup} y arranco vacío.`);
        this.data = emptyData();
        this.save();
        return;
      }
      this.data = { ...emptyData(), ...parsed };
      // Cuentas de antes del modelo de suscripción: sin `role` ni `active`. Si no se rellenan acá,
      // `active === undefined` es falsy y todo el mundo quedaría afuera de golpe tras un deploy.
      for (const user of this.data.users) {
        if (user.role !== "operador") user.role = "admin";
        if (typeof user.active !== "boolean") user.active = true;
      }
    } catch (err) {
      // Mover el archivo ilegible en vez de pisarlo: ahí adentro están las cuentas de las ligas.
      const backup = `${this.file}.corrupto-${Date.now()}`;
      fs.renameSync(this.file, backup);
      console.error(`[portal] ${this.file} ilegible (${err}). Lo guardé en ${backup} y arranco vacío.`);
      this.data = emptyData();
      this.save();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // --- Usuarios --------------------------------------------------------------------------------

  findUserByEmail(email: string): User | undefined {
    const normalized = normalizeEmail(email);
    return this.data.users.find((u) => u.email === normalized);
  }

  findUser(id: string): User | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  users(): User[] {
    return this.data.users.slice();
  }

  /** ¿Ya hay alguien al mando? Lo usa el arranque para sembrar la primera cuenta de operador. */
  hasOperator(): boolean {
    return this.data.users.some((u) => u.role === "operador");
  }

  createUser(email: string, password: string, role: UserRole = "admin"): User {
    const user: User = {
      id: newId(),
      email: normalizeEmail(email),
      password,
      sessionsVersion: 1,
      role,
      active: true,
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    this.save();
    return user;
  }

  setPassword(userId: string, password: string): void {
    const user = this.findUser(userId);
    if (!user) return;
    user.password = password;
    // Cambiar la contraseña tiene que echar al que estuviera adentro con la vieja. Si no, el
    // caso que motiva el cambio —"alguien entró a mi cuenta"— no se resuelve.
    user.sessionsVersion += 1;
    this.save();
  }

  /**
   * Cambios que hace el operador sobre una cuenta.
   *
   * `sessionsVersion` sube cuando se desactiva, y eso es deliberado: sin ese empujón, el admin que
   * ya estaba adentro seguiría usando el panel con su cookie vigente hasta que venciera sola.
   * Desactivar tiene que echarlo ahora.
   */
  updateUser(
    id: string,
    patch: Partial<Pick<User, "active" | "paidUntil" | "note" | "lastLoginAt" | "email">>
  ): User | undefined {
    const user = this.findUser(id);
    if (!user) return undefined;
    const seDesactiva = patch.active === false && user.active;
    Object.assign(user, patch);
    if (seDesactiva) user.sessionsVersion += 1;
    this.save();
    return user;
  }

  // --- Ligas -----------------------------------------------------------------------------------

  ligas(): Liga[] {
    return this.data.ligas.slice();
  }

  findLigaBySlug(slug: string): Liga | undefined {
    return this.data.ligas.find((l) => l.slug === slug);
  }

  findLiga(id: string): Liga | undefined {
    return this.data.ligas.find((l) => l.id === id);
  }

  createLiga(liga: Omit<Liga, "id" | "createdAt" | "embed">): Liga {
    const created: Liga = {
      ...liga,
      id: newId(),
      embed: { tokenVersion: 1, allowedOrigin: "" },
      createdAt: new Date().toISOString(),
    };
    this.data.ligas.push(created);
    this.save();
    return created;
  }

  /** Todas las ligas de las que este usuario es dueño. El operador las apaga al desactivarlo. */
  ligasOwnedBy(userId: string): Liga[] {
    return this.data.ligas.filter((l) => l.ownerId === userId);
  }

  updateLiga(id: string, patch: Partial<Pick<Liga, "name" | "slug">>): void {
    const liga = this.findLiga(id);
    if (!liga) return;
    Object.assign(liga, patch);
    this.save();
  }

  updateLigaEmbed(id: string, patch: Partial<Liga["embed"]>): void {
    const liga = this.findLiga(id);
    if (!liga) return;
    Object.assign(liga.embed, patch);
    this.save();
  }

  // --- Servidores ------------------------------------------------------------------------------

  servidores(): Servidor[] {
    return this.data.servidores.slice();
  }

  servidoresDeLiga(ligaId: string): Servidor[] {
    return this.data.servidores.filter((s) => s.ligaId === ligaId);
  }

  findServidor(id: string): Servidor | undefined {
    return this.data.servidores.find((s) => s.id === id);
  }

  createServidor(servidor: Omit<Servidor, "id" | "createdAt" | "status">): Servidor {
    const created: Servidor = { ...servidor, id: newId(), status: "stopped", createdAt: new Date().toISOString() };
    this.data.servidores.push(created);
    this.save();
    return created;
  }

  updateServidor(id: string, patch: Partial<Pick<Servidor, "status" | "lastError" | "nombre">>): void {
    const servidor = this.findServidor(id);
    if (!servidor) return;
    Object.assign(servidor, patch);
    this.save();
  }

  /** Borra un servidor y lo que tenga guardado en memoria (no su `dataDir`: lo que haya en disco
   * —sanciones, registros— queda, igual que al desactivar una liga). */
  removeServidor(id: string): boolean {
    const antes = this.data.servidores.length;
    this.data.servidores = this.data.servidores.filter((s) => s.id !== id);
    if (this.data.servidores.length === antes) return false;
    this.save();
    return true;
  }

  /** Puertos ya tomados, para que el asignador no repita ninguno. */
  usedPorts(): Set<number> {
    const used = new Set<number>();
    for (const servidor of this.data.servidores) {
      used.add(servidor.udpPort);
      used.add(servidor.adminPort);
      used.add(servidor.clientPort);
    }
    return used;
  }

  // --- Membresías ------------------------------------------------------------------------------

  membershipsOf(userId: string): Membership[] {
    return this.data.memberships.filter((m) => m.userId === userId);
  }

  hasAccess(userId: string, ligaId: string): boolean {
    return this.data.memberships.some((m) => m.userId === userId && m.ligaId === ligaId);
  }

  addMembership(membership: Membership): void {
    if (this.hasAccess(membership.userId, membership.ligaId)) return;
    this.data.memberships.push(membership);
    this.save();
  }
}
