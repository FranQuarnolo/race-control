import { ChildProcess, fork } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { FromWorker, StartMessage } from "../worker/messages";
import { Liga, PortalStore, Servidor } from "./store";

/**
 * Levanta un proceso por servidor y lo mantiene vivo.
 *
 * Lo que importa acá no es arrancar: es qué pasa cuando un servidor se cae en medio de una
 * carrera. Reintentar en bucle cerrado quema la máquina y llena el disco de logs; no reintentar
 * deja la carrera muerta. El medio es backoff creciente, un tope de intentos seguidos y, después
 * de eso, estado `failed` visible en el portal — que alguien se entere es parte del diseño.
 */

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** Si aguantó este tiempo, lo anterior fue un incidente y no un bucle: el contador se reinicia. */
const STABLE_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_CRASHES = 5;

export interface SupervisorOptions {
  /** Raíz de datos: cada servidor vive en `<dataRoot>/servidores/<id>`. */
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
  /** `true` cuando lo que pedimos es un reinicio: al salir hay que volver a levantarlo. */
  restartOnExit?: boolean;
}

export class Supervisor {
  private running = new Map<string, Running>();
  /** Caídas seguidas por servidor. Sobrevive entre procesos; se reinicia tras un rato estable. */
  private crashes = new Map<string, number>();
  private retries = new Map<string, NodeJS.Timeout>();

  constructor(private store: PortalStore, private options: SupervisorOptions) {}

  dataDirOf(servidorId: string): string {
    return path.join(this.options.dataRoot, "servidores", servidorId);
  }

  /** La base que se le anuncia por chat a la app del piloto. Ver `RaceControlOptions.clientBase`. */
  clientBaseOf(liga: Liga, servidor: Servidor): string {
    return `${this.options.publicHost}/l/${liga.slug}/s/${servidor.id}`;
  }

  /**
   * El renglón que el admin pega en el "Send Address" del panel de su hosting.
   *
   * Cadena vacía mientras el despliegue no tenga una IP pública configurada (`RC_PUBLIC_IP`). Es
   * importante que sea vacía y no `":30000"`: ese renglón se ve como un dato válido, el admin lo
   * pega, reinicia su servidor y no llega nada nunca, sin un solo síntoma que apunte a la causa.
   * Vacío obliga a las pantallas a decir que todavía no hay dirección.
   */
  sendAddressOf(servidor: Servidor): string {
    const ip = this.options.publicIp.trim();
    return ip ? `${ip}:${servidor.udpPort}` : "";
  }

  isRunning(servidorId: string): boolean {
    return this.running.has(servidorId);
  }

  /** Al arrancar el portal: todos los servidores menos los que no corresponde levantar. */
  startAll(): void {
    for (const servidor of this.store.servidores()) {
      if (servidor.status === "failed") continue;
      const liga = this.store.findLiga(servidor.ligaId);
      // Un servidor cuyo dueño está desactivado no vuelve solo después de un redeploy: si lo
      // hiciera, reiniciar sería la forma de saltearse la baja por falta de pago.
      const dueño = liga?.ownerId ? this.store.findUser(liga.ownerId) : undefined;
      if (dueño && !dueño.active) continue;
      this.start(servidor.id);
    }
  }

  start(servidorId: string): void {
    if (this.running.has(servidorId)) return;
    const servidor = this.store.findServidor(servidorId);
    if (!servidor) return;
    const liga = this.store.findLiga(servidor.ligaId);
    if (!liga) return;

    const pending = this.retries.get(servidorId);
    if (pending) {
      clearTimeout(pending);
      this.retries.delete(servidorId);
    }

    const dataDir = this.dataDirOf(servidorId);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    this.store.updateServidor(servidorId, { status: "starting", lastError: undefined });
    const child = fork(this.options.workerPath, [], {
      // El worker escribe en la misma consola que el portal: con una sola máquina, tener todo
      // en un lugar vale más que separar los flujos.
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, RC_LEAGUE_SLUG: liga.slug, RC_SERVIDOR_ID: servidor.id },
    });

    this.running.set(servidorId, { child, startedAt: Date.now(), stopping: false });

    child.on("message", (msg: FromWorker) => this.onWorkerMessage(servidorId, msg));
    child.on("exit", (code, signal) => this.onExit(servidorId, code, signal));
    child.on("error", (err) => this.store.updateServidor(servidorId, { lastError: String(err) }));

    const start: StartMessage = {
      type: "start",
      liga: { id: liga.id, slug: liga.slug, name: liga.name },
      servidorId: servidor.id,
      dataDir,
      ports: { udpPort: servidor.udpPort, adminPort: servidor.adminPort, clientPort: servidor.clientPort },
      publicIp: this.options.publicIp,
      clientBase: this.clientBaseOf(liga, servidor),
      udpBindAddress: this.options.udpBindAddress,
    };
    child.send(start);
  }

  stop(servidorId: string): void {
    const pending = this.retries.get(servidorId);
    if (pending) {
      clearTimeout(pending);
      this.retries.delete(servidorId);
    }
    this.crashes.delete(servidorId);

    const entry = this.running.get(servidorId);
    if (!entry) {
      this.store.updateServidor(servidorId, { status: "stopped" });
      return;
    }
    entry.stopping = true;
    entry.child.send({ type: "stop" });
    // Si no se fue solo en 5 s, se lo mata: un worker trabado no puede quedar reteniendo el
    // puerto UDP del servidor, porque entonces tampoco se puede volver a arrancar.
    const kill = setTimeout(() => entry.child.kill("SIGKILL"), 5000);
    kill.unref();
    this.store.updateServidor(servidorId, { status: "stopped" });
  }

  /**
   * Reinicio pedido a propósito — hoy, porque el operador le cambió el slug a la liga y el
   * worker anuncia ese dato por chat al piloto (`clientBase`).
   *
   * No es lo mismo que una caída: acá no hay backoff ni contador de crashes, porque no falló
   * nada. Y no alcanza con `stop()` seguido de `start()`: el worker tarda en irse, y `start()`
   * se iría sin hacer nada al ver que el servidor todavía figura corriendo. Por eso el arranque
   * se cuelga del `exit`.
   */
  restart(servidorId: string): void {
    const entry = this.running.get(servidorId);
    if (!entry) {
      this.start(servidorId);
      return;
    }
    entry.restartOnExit = true;
    this.stop(servidorId);
  }

  /** Para el cierre ordenado del portal: no toca el estado guardado, porque al volver a arrancar
   * los servidores tienen que levantarse solos. */
  shutdown(): void {
    for (const [servidorId, entry] of this.running) {
      entry.stopping = true;
      entry.child.send({ type: "stop" });
      entry.child.kill("SIGTERM");
      void servidorId;
    }
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  private onWorkerMessage(servidorId: string, msg: FromWorker): void {
    if (msg.type === "ready") {
      this.store.updateServidor(servidorId, { status: "running", lastError: undefined });
      return;
    }
    if (msg.type === "error") {
      this.store.updateServidor(servidorId, { lastError: msg.message });
      if (msg.fatal) {
        // Un EADDRINUSE no se cura esperando: el puerto se lo asignamos nosotros y si está
        // tomado es un problema de configuración. Reintentar sería un bucle garantizado.
        const entry = this.running.get(servidorId);
        if (entry) entry.stopping = true;
        this.store.updateServidor(servidorId, { status: "failed" });
      }
    }
  }

  private onExit(servidorId: string, code: number | null, signal: string | null): void {
    const entry = this.running.get(servidorId);
    this.running.delete(servidorId);
    if (!entry) return;
    if (entry.stopping) {
      // Salida pedida por nosotros. Si lo que se pidió fue un reinicio, este es el momento: el
      // puerto UDP recién queda libre cuando el proceso viejo se fue del todo.
      if (entry.restartOnExit) this.start(servidorId);
      return;
    }

    const servidor = this.store.findServidor(servidorId);
    if (!servidor) return;

    // Si estuvo arriba lo suficiente, lo que pasó fue un incidente aislado y el contador vuelve
    // a cero: un servidor que se cae una vez por mes no tiene que arrastrar el backoff del mes
    // pasado y reintentar recién al minuto.
    const estable = Date.now() - entry.startedAt > STABLE_MS;
    const crashes = estable ? 1 : (this.crashes.get(servidorId) ?? 0) + 1;
    this.crashes.set(servidorId, crashes);

    if (crashes > MAX_CONSECUTIVE_CRASHES) {
      this.store.updateServidor(servidorId, {
        status: "failed",
        lastError: `El proceso se cayó ${crashes} veces seguidas (último código ${code ?? signal}). No reintento más: arrancalo a mano cuando sepas por qué.`,
      });
      console.error(`[portal] servidor ${servidor.id}: ${crashes} caídas seguidas, lo dejo en failed.`);
      return;
    }

    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (crashes - 1));
    this.store.updateServidor(servidorId, {
      status: "stopped",
      lastError: `Se cayó (código ${code ?? signal}); reintento en ${Math.round(wait / 1000)} s.`,
    });
    console.warn(`[portal] servidor ${servidor.id} caído (${code ?? signal}), reintento en ${wait} ms.`);

    const timer = setTimeout(() => this.start(servidorId), wait);
    timer.unref();
    this.retries.set(servidorId, timer);
  }
}

/**
 * Asigna los tres puertos de un servidor nuevo.
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
      `No quedan puertos UDP libres entre ${pools.udpFrom} y ${pools.udpTo}. Para alojar más servidores hay que ampliar el rango acá Y en fly.toml.`
    );
  }

  const loopback: number[] = [];
  for (let p = pools.loopbackFrom; loopback.length < 2 && p < pools.loopbackFrom + 2000; p++) {
    if (!used.has(p) && p !== udpPort) loopback.push(p);
  }
  if (loopback.length < 2) throw new Error("No quedan puertos de loopback libres para el servidor.");

  return { udpPort, adminPort: loopback[0], clientPort: loopback[1] };
}
