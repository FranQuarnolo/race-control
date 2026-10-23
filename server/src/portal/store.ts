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
 */

export type LeagueStatus = "stopped" | "starting" | "running" | "failed";

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
   * En `false` la cuenta no entra y su liga se apaga, pero no se borra nada: config, sanciones y
   * registros quedan intactos para cuando vuelva a pagar.
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

export interface League {
  id: string;
  /** Lo que va en la URL: `/l/<slug>`. Minúsculas, números y guiones. */
  slug: string;
  name: string;
  ownerId: string;
  udpPort: number;
  adminPort: number;
  clientPort: number;
  status: LeagueStatus;
  /** Último error del worker, para mostrarlo en el portal en vez de reintentar en silencio. */
  lastError?: string;
  createdAt: string;
}

export interface Membership {
  userId: string;
  leagueId: string;
  role: "owner" | "steward";
}

interface PortalData {
  version: 1;
  users: User[];
  leagues: League[];
  memberships: Membership[];
}

function emptyData(): PortalData {
  return { version: 1, users: [], leagues: [], memberships: [] };
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

  leagues(): League[] {
    return this.data.leagues.slice();
  }

  findLeagueBySlug(slug: string): League | undefined {
    return this.data.leagues.find((l) => l.slug === slug);
  }

  findLeague(id: string): League | undefined {
    return this.data.leagues.find((l) => l.id === id);
  }

  createLeague(league: Omit<League, "id" | "createdAt" | "status">): League {
    const created: League = { ...league, id: newId(), status: "stopped", createdAt: new Date().toISOString() };
    this.data.leagues.push(created);
    this.save();
    return created;
  }

  /** Todas las ligas de las que este usuario es dueño. El operador las apaga al desactivarlo. */
  leaguesOwnedBy(userId: string): League[] {
    return this.data.leagues.filter((l) => l.ownerId === userId);
  }

  updateLeague(id: string, patch: Partial<Pick<League, "status" | "lastError" | "name" | "slug">>): void {
    const league = this.findLeague(id);
    if (!league) return;
    Object.assign(league, patch);
    this.save();
  }

  /** Puertos ya tomados, para que el asignador no repita ninguno. */
  usedPorts(): Set<number> {
    const used = new Set<number>();
    for (const league of this.data.leagues) {
      used.add(league.udpPort);
      used.add(league.adminPort);
      used.add(league.clientPort);
    }
    return used;
  }

  // --- Membresías ------------------------------------------------------------------------------

  membershipsOf(userId: string): Membership[] {
    return this.data.memberships.filter((m) => m.userId === userId);
  }

  hasAccess(userId: string, leagueId: string): boolean {
    return this.data.memberships.some((m) => m.userId === userId && m.leagueId === leagueId);
  }

  addMembership(membership: Membership): void {
    if (this.hasAccess(membership.userId, membership.leagueId)) return;
    this.data.memberships.push(membership);
    this.save();
  }
}
