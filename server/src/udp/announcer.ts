import { AcUdpClient } from "./client";
import { NewConnection } from "./protocol";

export const BACKEND_ANNOUNCE_PREFIX = "RACECONTROL_BACKEND:";

const RETRY_INTERVAL_MS = 4000;
const MAX_RETRIES = 5;

/**
 * Auto-discovery del cliente: para que el piloto no tenga que configurar ni tipear nada, apenas
 * se conecta un auto el backend le manda (por el chat interno del juego, dirigido solo a ese
 * auto) la dirección a la que su app debe reportar. El cliente Python ya escucha chat y parsea
 * este prefijo (ver RaceControlClient.py). Reintenta hasta ver el primer heartbeat de ese piloto
 * (la app puede tardar un instante en terminar de cargar) o hasta agotar los reintentos.
 */
export class BackendAnnouncer {
  private pendingByGuid = new Map<string, { carId: number; attempts: number; timer: NodeJS.Timeout }>();

  /** `getClientAddress` devuelve `null` mientras no se sepa la dirección propia. En ese caso no se
   * anuncia nada: mandarle `127.0.0.1` a un piloto lo hace intentar conectarse a su propia PC, y
   * ese fallo es invisible para todos — ni el piloto ni el admin se enteran de por qué no anda. */
  constructor(private udpClient: AcUdpClient, private getClientAddress: () => string | null) {}

  onNewConnection(data: NewConnection): void {
    this.cancel(data.driverGuid);
    this.announce(data.carId, data.driverGuid, 0);
  }

  /** Lo llama el endpoint de heartbeat: si ya nos reportó, no hace falta seguir insistiendo. */
  onHeartbeatReceived(driverGuid: string): void {
    this.cancel(driverGuid);
  }

  private announce(carId: number, driverGuid: string, attempt: number): void {
    if (attempt >= MAX_RETRIES) {
      this.pendingByGuid.delete(driverGuid);
      return;
    }
    const address = this.getClientAddress();
    // Sin dirección se reintenta igual en vez de abandonar: la detección puede estar todavía en
    // curso cuando el primer piloto entra, y en unos segundos ya va a haber algo que anunciar.
    if (address) this.udpClient.sendChatToCar(carId, `${BACKEND_ANNOUNCE_PREFIX}${address}`);
    const timer = setTimeout(() => this.announce(carId, driverGuid, attempt + 1), RETRY_INTERVAL_MS);
    this.pendingByGuid.set(driverGuid, { carId, attempts: attempt + 1, timer });
  }

  private cancel(driverGuid: string): void {
    const pending = this.pendingByGuid.get(driverGuid);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingByGuid.delete(driverGuid);
    }
  }
}
