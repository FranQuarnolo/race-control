import { AcUdpClient } from "../udp/client";

/**
 * ¿Nos está hablando el servidor de Assetto Corsa?
 *
 * Esto supo ser mucho más grande: detectaba la IP pública contra un servicio externo, intentaba
 * abrir el puerto del router por UPnP y escalaba entre tres estrategias. Todo eso existía porque
 * Race Control corría en la PC del admin, detrás de un router casero y con una IP que cambiaba
 * sola. Corriendo en un servidor con dirección fija y puertos publicados, no queda ninguna
 * pregunta que resolver por software: o el servidor de AC está mandando a la dirección correcta,
 * o no. Lo único que hace falta es mirar si llegan paquetes y mantener viva la conversación.
 */

export type NetworkStrategy = "pending" | "direct" | "manual";

/**
 * De dónde salió la dirección que se les anuncia a los pilotos.
 *
 * Solo hay dos casos: la fijó el portal al arrancar el worker (`detected`) o el despliegue no
 * tiene una IP pública configurada (`unknown`). El admin no puede escribirla —`publicHost` es uno
 * de los campos que `stripManagedFields` descarta—, así que no existe una tercera fuente.
 */
export type PublicHostSource = "detected" | "unknown";

export interface NetworkStatus {
  publicIp: string | null;
  publicHostSource: PublicHostSource;
  receivingTelemetry: boolean;
  strategy: NetworkStrategy;
  lastCheckedAt: number;
}

/** Cuánto se espera el primer paquete antes de decir que no está llegando nada. */
const TELEMETRY_WAIT_MS = 8000;
/**
 * Cada cuánto se repite el `setRealtimePosInterval`.
 *
 * No es solo un keepalive: si el servidor de Assetto Corsa se reinicia —que es exactamente lo que
 * el admin hace después de pegar el Send Address— arranca sin saber cada cuánto tiene que mandar
 * las posiciones. Sin esta repetición habría que reiniciar también la liga.
 */
const KEEPALIVE_INTERVAL_MS = 20000;

export class ConnectivityManager {
  private status: NetworkStatus = {
    publicIp: null,
    publicHostSource: "unknown",
    receivingTelemetry: false,
    strategy: "pending",
    lastCheckedAt: 0,
  };
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(
    private udpClient: AcUdpClient,
    /** La dirección pública de esta liga. La pone el portal y no se edita desde el panel. */
    private getPublicHost: () => string = () => ""
  ) {}

  getStatus(): NetworkStatus {
    const host = this.getPublicHost().trim();
    return { ...this.status, publicIp: host || null, publicHostSource: host ? "detected" : "unknown" };
  }

  /** No bloquea el arranque: la espera del primer paquete corre en segundo plano y va
   * actualizando el estado que expone /api/state, que el panel ya consulta por polling. */
  async start(): Promise<void> {
    this.keepaliveTimer = setInterval(() => {
      try {
        this.udpClient.setRealtimePosInterval(200);
      } catch {
        // best-effort: si falla, el próximo tick reintenta solo.
      }
    }, KEEPALIVE_INTERVAL_MS);

    this.esperarPrimerPaquete().catch((err) => console.error("[connectivity] error esperando telemetría:", err));
  }

  stop(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
  }

  /** Refresca "¿nos está llegando señal AHORA?" — para que el panel pueda avisar si la señal se
   * corta a mitad de una carrera ya en curso. */
  refreshTelemetryFlag(): void {
    const stats = this.udpClient.getStats();
    this.status.receivingTelemetry = stats.lastPacketAt > 0 && Date.now() - stats.lastPacketAt < 5000;
    this.status.lastCheckedAt = Date.now();
  }

  private async esperarPrimerPaquete(): Promise<void> {
    const antes = this.udpClient.getStats().packetsReceived;
    await delay(TELEMETRY_WAIT_MS);
    const llegó = this.udpClient.getStats().packetsReceived > antes;
    this.status.strategy = llegó ? "direct" : "manual";
    this.status.receivingTelemetry = llegó;
    this.status.lastCheckedAt = Date.now();
  }
}

function delay(ms: number): Promise<void> {
  // `unref` para que esta espera no mantenga vivo el proceso: no es motivo para que el worker
  // tarde 8 segundos más en cerrar, ni para que un test se quede esperándola.
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * El único dato que el admin tiene que llevar a su hosting: a dónde mandarnos la telemetría.
 *
 * Va solo y sin nombre de campo al lado porque es lo que se pega en el "Send Address" del panel,
 * que es un cuadro de texto que espera exactamente esto y nada más. El otro número del par —el
 * puerto de escucha del servidor— ya no hace falta pedirlo: se deduce del primer paquete que
 * llega (ver `adoptRemotePortIfNeeded` en udp/client.ts).
 */
export function buildSendAddress(publicIp: string | null, udpLocalPort: number): string {
  return `${publicIp ?? "<TU_IP_PUBLICA>"}:${udpLocalPort}`;
}

/*
 * Acá vivía `buildServerSnippet`, que armaba las dos líneas
 * (`UDP_PLUGIN_LOCAL_PORT` / `UDP_PLUGIN_ADDRESS`) para pegar en el `server_cfg.ini`.
 *
 * Se borró porque en un hosting administrado ese consejo es directamente falso: los paneles tipo
 * Assetto Corsa Server Manager **regeneran** el `server_cfg.ini` a partir de su propia base cada
 * vez que arranca el servidor, así que lo que se edite a mano se pierde en el próximo arranque.
 * Por eso varios paneles —EmperorServers entre ellos— muestran el archivo pero no lo dejan tocar.
 *
 * Dar una instrucción que el panel deshace sin avisar es peor que no darla: el admin cree que
 * conectó la liga y se entera el día de la carrera. El único camino que se documenta ahora es el
 * campo "Send Address" del panel, y `buildSendAddress` lo arma solo.
 */
