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

export interface User {
  id: string;
  email: string;
  /** Formato `scrypt$N$r$p$saltHex$hashHex` — autodescriptivo para poder subir el costo después. */
  password: string;
  /** Se incrementa al cambiar la contraseña: invalida de golpe todas las sesiones abiertas. */
  sessionsVersion: number;
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

export interface Invite {
  /** Hash del token, nunca el token: quien lea el archivo no puede entrar con lo que encuentra. */
  tokenHash: string;
  leagueId: string;
  email: string;
  expiresAt: number;
  usedAt?: number;
}

interface PortalData {
  version: 1;
  users: User[];
  leagues: League[];
  memberships: Membership[];
  invites: Invite[];
}

function emptyData(): PortalData {
  return { version: 1, users: [], leagues: [], memberships: [], invites: [] };
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

  createUser(email: string, password: string): User {
    const user: User = {
      id: newId(),
      email: normalizeEmail(email),
      password,
      sessionsVersion: 1,
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

  /** El dueño se conoce recién cuando alguien acepta la invitación, no cuando se crea la liga. */
  setOwner(leagueId: string, userId: string): void {
    const league = this.findLeague(leagueId);
    if (!league || league.ownerId) return;
    league.ownerId = userId;
    this.save();
  }

  updateLeague(id: string, patch: Partial<Pick<League, "status" | "lastError" | "name">>): void {
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

  // --- Invitaciones ----------------------------------------------------------------------------

  addInvite(invite: Invite): void {
    this.data.invites.push(invite);
    this.save();
  }

  findInvite(tokenHash: string): Invite | undefined {
    return this.data.invites.find((i) => i.tokenHash === tokenHash);
  }

  useInvite(tokenHash: string): void {
    const invite = this.findInvite(tokenHash);
    if (!invite) return;
    invite.usedAt = Date.now();
    this.save();
  }
}
