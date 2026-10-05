import { StateTracker } from "../state/stateTracker";
import { AcUdpClient } from "../udp/client";

/**
 * Exige que cada piloto conectado tenga la app cliente corriendo (heartbeat), igual que Real Penalty:
 * si no se detecta heartbeat de su driverGuid dentro del período de gracia, se lo kickea.
 *
 * driverGuid en el protocolo ACSP es el SteamID del jugador — la app cliente lo obtiene con
 * `ac.getUserSteamID()` (a confirmar esa firma exacta contra la API real de apps de AC).
 */
export class PresenceWatchdog {
  private lastHeartbeat = new Map<string, number>();
  private connectedSince = new Map<string, number>();
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(
    private stateTracker: StateTracker,
    private udpClient: AcUdpClient,
    private graceMs: number = 15000,
    private checkIntervalMs: number = 5000
  ) {
    this.stateTracker.on("connected", (car: { carId: number; driverGuid: string }) => {
      this.connectedSince.set(car.driverGuid, Date.now());
    });
    this.stateTracker.on("disconnected", (car: { driverGuid: string }) => {
      this.connectedSince.delete(car.driverGuid);
      this.lastHeartbeat.delete(car.driverGuid);
    });
  }

  start(): void {
    this.checkTimer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
  }

  onHeartbeat(driverGuid: string): void {
    this.lastHeartbeat.set(driverGuid, Date.now());
  }

  private check(): void {
    const now = Date.now();
    for (const car of this.stateTracker.getConnected()) {
      const since = this.connectedSince.get(car.driverGuid);
      if (!since || now - since < this.graceMs) continue;

      const last = this.lastHeartbeat.get(car.driverGuid);
      if (!last || now - last > this.graceMs) {
        this.udpClient.kick(car.carId);
      }
    }
  }
}
