import { StateTracker } from "../state/stateTracker";

/**
 * Exige que cada piloto conectado tenga la app cliente corriendo (heartbeat), igual que Real Penalty:
 * si no se detecta heartbeat de su driverGuid dentro del período de gracia, se lo kickea.
 *
 * driverGuid en el protocolo ACSP es el SteamID del jugador — la app cliente lo obtiene con
 * `ac.getUserSteamID()` (a confirmar esa firma exacta contra la API real de apps de AC).
 */
export interface PresenceWatchdogOptions {
  /** Se lee en vivo por función: el admin puede subirlo desde el panel a mitad de una sesión. */
  getGraceMs: () => number;
  /** Si es false, no se kickea a nadie por no tener la app — solo se registra quién la tiene. */
  isEnforced: () => boolean;
  /**
   * Único camino por el que sale un kick. Lo provee index.ts con el mismo `dispatchOrSuppress`
   * que usan las sanciones, para que el modo sombra valga también acá.
   *
   * Antes el watchdog llamaba a `udpClient.kick()` directo, sin pasar por el dispatcher ni dejar
   * rastro en el journal: con el modo sombra activado por defecto, la primera carrera de prueba
   * expulsaba a todo piloto sin la app instalada — exactamente lo contrario de lo que el panel
   * promete ("solo registra, no sanciona ni kickea de verdad"), y sin evidencia de qué pasó.
   */
  dispatchKick: (carId: number, driverGuid: string, driverName: string) => void;
  checkIntervalMs?: number;
}

export class PresenceWatchdog {
  private lastHeartbeat = new Map<string, number>();
  private lastPing = new Map<string, number>();
  private connectedSince = new Map<string, number>();
  private checkTimer: NodeJS.Timeout | null = null;
  /** Pilotos ya reportados como ausentes — se limpia al reconectar (ver listener "disconnected"). */
  private kicked = new Set<string>();
  private readonly checkIntervalMs: number;

  constructor(private stateTracker: StateTracker, private options: PresenceWatchdogOptions) {
    this.checkIntervalMs = options.checkIntervalMs ?? 5000;
    this.stateTracker.on("connected", (car: { carId: number; driverGuid: string }) => {
      this.connectedSince.set(car.driverGuid, Date.now());
      this.kicked.delete(car.driverGuid);
    });
    this.stateTracker.on("disconnected", (car: { driverGuid: string }) => {
      this.connectedSince.delete(car.driverGuid);
      this.lastHeartbeat.delete(car.driverGuid);
      this.lastPing.delete(car.driverGuid);
      this.kicked.delete(car.driverGuid);
    });
  }

  start(): void {
    this.checkTimer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
  }

  onHeartbeat(driverGuid: string, pingMs?: number): void {
    this.lastHeartbeat.set(driverGuid, Date.now());
    if (pingMs !== undefined) this.lastPing.set(driverGuid, pingMs);
  }

  /**
   * Último round-trip medido por la app del piloto contra el backend, en ms.
   *
   * No es el ping del piloto al servidor de AC: el protocolo ACSP no lo expone. Es la latencia de
   * su conexión hacia Race Control, que es lo que sirve para detectar a quién se le corta. El
   * panel lo etiqueta como tal para no prometer de más.
   */
  getPing(driverGuid: string): number | null {
    if (!this.isReporting(driverGuid)) return null;
    return this.lastPing.get(driverGuid) ?? null;
  }

  /** ¿Este piloto tiene la app reportando ahora mismo? Lo usa el panel para mostrar, por piloto,
   * quién está por ser kickeado antes de que pase. */
  isReporting(driverGuid: string): boolean {
    const last = this.lastHeartbeat.get(driverGuid);
    return last !== undefined && Date.now() - last <= this.options.getGraceMs();
  }

  /**
   * Cuántos pilotos conectados están reportando. El panel lo contrasta contra el total conectado:
   * "telemetría del servidor OK" y "los pilotos llegan al backend" son dos cosas distintas y
   * pueden fallar por separado — si el puerto de clientes no está abierto, el primero da verde y
   * el segundo cero, y hasta ahora eso era invisible hasta que empezaban los kicks.
   */
  getReportingCount(): { reporting: number; connected: number } {
    const connected = this.stateTracker.getConnected();
    return {
      reporting: connected.filter((car) => this.isReporting(car.driverGuid)).length,
      connected: connected.length,
    };
  }

  private check(): void {
    if (!this.options.isEnforced()) return;
    const now = Date.now();
    const graceMs = this.options.getGraceMs();
    for (const car of this.stateTracker.getConnected()) {
      const since = this.connectedSince.get(car.driverGuid);
      if (!since || now - since < graceMs) continue;

      const last = this.lastHeartbeat.get(car.driverGuid);
      if (!last || now - last > graceMs) {
        // Un solo kick por piloto por conexión. En modo sombra el kick se suprime, así que el
        // piloto sigue conectado y esta misma rama volvería a dispararse en cada tick (cada 5s),
        // inundando el journal con el mismo evento durante toda la carrera.
        if (this.kicked.has(car.driverGuid)) continue;
        this.kicked.add(car.driverGuid);
        this.options.dispatchKick(car.carId, car.driverGuid, car.driverName);
      }
    }
  }
}
