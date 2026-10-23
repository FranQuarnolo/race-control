import { ChildProcess, fork } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { FromWorker, StartMessage } from "../worker/messages";
import { League, PortalStore } from "./store";

/**
 * Levanta un proceso por liga y lo mantiene vivo.
 *
 * Lo que importa acá no es arrancar: es qué pasa cuando una liga se cae en medio de una carrera.
 * Reintentar en bucle cerrado quema la máquina y llena el disco de logs; no reintentar deja la
 * carrera muerta. El medio es backoff creciente, un tope de intentos seguidos y, después de eso,
 * estado `failed` visible en el portal — que alguien se entere es parte del diseño.
 */

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** Si aguantó este tiempo, lo anterior fue un incidente y no un bucle: el contador se reinicia. */
const STABLE_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_CRASHES = 5;

export interface SupervisorOptions {
  /** Raíz de datos: cada liga vive en `<dataRoot>/leagues/<id>`. */
  dataRoot: string;
  /** Ruta al entry del worker ya compilado. */
  workerPath: string;
  /** IP pública del servidor — la que el admin pega en el "Send Address" de su hosting. */
  publicIp: string;
  /** Host público del portal, ej. `race-control.fly.dev`. Sin esquema ni barra final. */
  publicHost: string;
  /** Interfaz de bind del UDP. En Fly.io, `fly-global-services`. */
  udpBindAddress?: string;
}

interface Running {
  child: ChildProcess;
  startedAt: number;
  /** `true` cuando el cierre lo pedimos nosotros: entonces el exit no es una caída. */
  stopping: boolean;
}

export class Supervisor {
  private running = new Map<string, Running>();
  /** Caídas seguidas por liga. Sobrevive entre procesos; se reinicia tras un rato estable. */
  private crashes = new Map<string, number>();
  private retries = new Map<string, NodeJS.Timeout>();

  constructor(private store: PortalStore, private options: SupervisorOptions) {}

  dataDirOf(leagueId: string): string {
    return path.join(this.options.dataRoot, "leagues", leagueId);
  }

  /** La base que se le anuncia por chat a la app del piloto. Ver `RaceControlOptions.clientBase`. */
  clientBaseOf(league: League): string {
    return `${this.options.publicHost}/l/${league.slug}`;
  }

  /** El renglón que el admin pega en el "Send Address" del panel de su hosting. */
  sendAddressOf(league: League): string {
    return `${this.options.publicIp}:${league.udpPort}`;
  }

  isRunning(leagueId: string): boolean {
    return this.running.has(leagueId);
  }

  /** Al arrancar el portal: todas las ligas menos las que no corresponde levantar. */
  startAll(): void {
    for (const league of this.store.leagues()) {
      if (league.status === "failed") continue;
      // Una liga cuyo dueño está desactivado no vuelve sola después de un redeploy: si lo hiciera,
      // reiniciar el servidor sería la forma de saltearse la baja por falta de pago.
      const dueño = league.ownerId ? this.store.findUser(league.ownerId) : undefined;
      if (dueño && !dueño.active) continue;
      this.start(league.id);
    }
  }

  start(leagueId: string): void {
    if (this.running.has(leagueId)) return;
    const league = this.store.findLeague(leagueId);
    if (!league) return;

    const pending = this.retries.get(leagueId);
    if (pending) {
      clearTimeout(pending);
      this.retries.delete(leagueId);
    }

    const dataDir = this.dataDirOf(leagueId);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    this.store.updateLeague(leagueId, { status: "starting", lastError: undefined });
    const child = fork(this.options.workerPath, [], {
      // El worker escribe en la misma consola que el portal: con una sola máquina, tener todo
      // en un lugar vale más que separar los flujos.
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, RC_LEAGUE_SLUG: league.slug },
    });

    this.running.set(leagueId, { child, startedAt: Date.now(), stopping: false });

    child.on("message", (msg: FromWorker) => this.onWorkerMessage(leagueId, msg));
    child.on("exit", (code, signal) => this.onExit(leagueId, code, signal));
    child.on("error", (err) => this.store.updateLeague(leagueId, { lastError: String(err) }));

    const start: StartMessage = {
      type: "start",
      league: { id: league.id, slug: league.slug, name: league.name },
      dataDir,
      ports: { udpPort: league.udpPort, adminPort: league.adminPort, clientPort: league.clientPort },
      publicIp: this.options.publicIp,
      clientBase: this.clientBaseOf(league),
      udpBindAddress: this.options.udpBindAddress,
    };
    child.send(start);
  }

  stop(leagueId: string): void {
    const pending = this.retries.get(leagueId);
    if (pending) {
      clearTimeout(pending);
      this.retries.delete(leagueId);
    }
    this.crashes.delete(leagueId);

    const entry = this.running.get(leagueId);
    if (!entry) {
      this.store.updateLeague(leagueId, { status: "stopped" });
      return;
    }
    entry.stopping = true;
    entry.child.send({ type: "stop" });
    // Si no se fue solo en 5 s, se lo mata: un worker trabado no puede quedar reteniendo el
    // puerto UDP de la liga, porque entonces tampoco se puede volver a arrancar.
    const kill = setTimeout(() => entry.child.kill("SIGKILL"), 5000);
    kill.unref();
    this.store.updateLeague(leagueId, { status: "stopped" });
  }

  /** Para el cierre ordenado del portal: no toca el estado guardado, porque al volver a arrancar
   * las ligas tienen que levantarse solas. */
  shutdown(): void {
    for (const [leagueId, entry] of this.running) {
      entry.stopping = true;
      entry.child.send({ type: "stop" });
      entry.child.kill("SIGTERM");
      void leagueId;
    }
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  private onWorkerMessage(leagueId: string, msg: FromWorker): void {
    if (msg.type === "ready") {
      this.store.updateLeague(leagueId, { status: "running", lastError: undefined });
      return;
    }
    if (msg.type === "error") {
      this.store.updateLeague(leagueId, { lastError: msg.message });
      if (msg.fatal) {
        // Un EADDRINUSE no se cura esperando: el puerto se lo asignamos nosotros y si está
        // tomado es un problema de configuración. Reintentar sería un bucle garantizado.
        const entry = this.running.get(leagueId);
        if (entry) entry.stopping = true;
        this.store.updateLeague(leagueId, { status: "failed" });
      }
    }
  }

  private onExit(leagueId: string, code: number | null, signal: string | null): void {
    const entry = this.running.get(leagueId);
    this.running.delete(leagueId);
    if (!entry || entry.stopping) return;

    const league = this.store.findLeague(leagueId);
    if (!league) return;

    // Si estuvo arriba lo suficiente, lo que pasó fue un incidente aislado y el contador vuelve
    // a cero: una liga que se cae una vez por mes no tiene que arrastrar el backoff del mes
    // pasado y reintentar recién al minuto.
    const estable = Date.now() - entry.startedAt > STABLE_MS;
    const crashes = estable ? 1 : (this.crashes.get(leagueId) ?? 0) + 1;
    this.crashes.set(leagueId, crashes);

    if (crashes > MAX_CONSECUTIVE_CRASHES) {
      this.store.updateLeague(leagueId, {
        status: "failed",
        lastError: `El proceso de la liga se cayó ${crashes} veces seguidas (último código ${code ?? signal}). No reintento más: arrancala a mano cuando sepas por qué.`,
      });
      console.error(`[portal] liga ${league.slug}: ${crashes} caídas seguidas, la dejo en failed.`);
      return;
    }

    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (crashes - 1));
    this.store.updateLeague(leagueId, {
      status: "stopped",
      lastError: `Se cayó (código ${code ?? signal}); reintento en ${Math.round(wait / 1000)} s.`,
    });
    console.warn(`[portal] liga ${league.slug} caída (${code ?? signal}), reintento en ${wait} ms.`);

    const timer = setTimeout(() => this.start(leagueId), wait);
    timer.unref();
    this.retries.set(leagueId, timer);
  }
}

/**
 * Asigna los tres puertos de una liga nueva.
 *
 * El UDP sale de un rango fijo y chico porque en Fly.io cada puerto UDP tiene que estar declarado
 * en `fly.toml` uno por uno: el rango de acá y el del archivo tienen que coincidir, y por eso el
 * tope es un error explícito y no un número que se estira solo.
 */
export interface PortPools {
  udpFrom: number;
  udpTo: number;
  loopbackFrom: number;
}

export function assignPorts(used: Set<number>, pools: PortPools): { udpPort: number; adminPort: number; clientPort: number } {
  let udpPort = 0;
  for (let p = pools.udpFrom; p <= pools.udpTo; p++) {
    if (!used.has(p)) {
      udpPort = p;
      break;
    }
  }
  if (!udpPort) {
    throw new Error(
      `No quedan puertos UDP libres entre ${pools.udpFrom} y ${pools.udpTo}. Para alojar más ligas hay que ampliar el rango acá Y en fly.toml.`
    );
  }

  const loopback: number[] = [];
  for (let p = pools.loopbackFrom; loopback.length < 2 && p < pools.loopbackFrom + 2000; p++) {
    if (!used.has(p) && p !== udpPort) loopback.push(p);
  }
  if (loopback.length < 2) throw new Error("No quedan puertos de loopback libres para la liga.");

  return { udpPort, adminPort: loopback[0], clientPort: loopback[1] };
}
