import * as https from "https";
import { Client as NatUpnpClient } from "@runonflux/nat-upnp";
import { AcUdpClient } from "../udp/client";

export type NetworkStrategy = "pending" | "direct" | "upnp" | "manual";

/**
 * De dónde salió la dirección que se les anuncia a los pilotos.
 *
 * Importa mostrarlo porque los tres casos se ven iguales desde afuera y solo uno funciona. Antes,
 * si la detección fallaba, el backend anunciaba `127.0.0.1` y el panel seguía diciendo
 * "detectando..." para siempre: los pilotos no se conectaban y nada indicaba por qué.
 */
export type PublicHostSource = "manual" | "detected" | "unknown";

export interface NetworkStatus {
  publicIp: string | null;
  publicHostSource: PublicHostSource;
  receivingTelemetry: boolean;
  strategy: NetworkStrategy;
  upnpAttempted: boolean;
  upnpSuccess: boolean | null;
  /** Si se logró mapear por UPnP el puerto TCP que usan los pilotos. `false` no significa que no
   * funcione: muchos routers dejan pasar igual, o el admin ya tiene el forwarding hecho a mano.
   * La prueba real es `driversReporting` en /api/state. */
  clientPortMapped: boolean | null;
  lastCheckedAt: number;
}

const UPNP_TIMEOUT_MS = 4000;
const TELEMETRY_WAIT_MS = 8000;
const KEEPALIVE_INTERVAL_MS = 20000;
const PUBLIC_IP_TIMEOUT_MS = 4000;

/**
 * Estrategia en 3 niveles para que ni el admin ni el piloto tengan que entender de redes:
 *
 * 1. "direct": el backend ya manda primero un comando saliente al servidor de AC
 *    (setRealtimePosInterval) y lo reenvía cada 20s (keepalive) — en la mayoría de los routers
 *    caseros (NAT tipo cone) eso alcanza para que la respuesta vuelva sola sin tocar nada.
 * 2. "upnp": si a los pocos segundos no llegó nada, se intenta mapear el puerto automáticamente
 *    por UPnP (best-effort: con timeout corto y sin romper el arranque si falla).
 * 3. "manual": si ninguna de las dos funcionó, el panel le muestra al admin los pasos manuales
 *    (o la alternativa de VPS) — esto es lo único que no se puede resolver por software.
 */
export class ConnectivityManager {
  private status: NetworkStatus = {
    publicIp: null,
    publicHostSource: "unknown",
    receivingTelemetry: false,
    strategy: "pending",
    upnpAttempted: false,
    upnpSuccess: null,
    clientPortMapped: null,
    lastCheckedAt: 0,
  };
  private keepaliveTimer: NodeJS.Timeout | null = null;
  /** Lo que devolvió la detección automática, aparte de lo que el admin haya escrito a mano: si
   * borra el campo manual, se vuelve a lo detectado sin tener que reiniciar. */
  private detectedIp: string | null = null;

  constructor(
    private udpClient: AcUdpClient,
    private ports: { udpLocalPort: number; tcpClientPort: number },
    /** Dirección puesta a mano en el panel. Vacío = usar la detectada. */
    private getManualHost: () => string = () => "",
    /**
     * `discovery: false` apaga la detección de IP pública y el mapeo UPnP.
     *
     * Es lo correcto en el portal: la dirección del servidor es fija y conocida, no hay router
     * casero que abrir, y tanto la consulta a api.ipify.org como el descubrimiento SSDP de UPnP
     * son ruido que en un datacenter no resuelve nada (y que en Fly.io devolvería la IP de salida
     * de la máquina, que no es la que reciben los paquetes entrantes).
     */
    private options: { discovery?: boolean } = {}
  ) {}

  getStatus(): NetworkStatus {
    const manual = this.getManualHost().trim();
    return {
      ...this.status,
      publicIp: manual || this.detectedIp,
      publicHostSource: manual ? "manual" : this.detectedIp ? "detected" : "unknown",
    };
  }

  /** No bloquea el arranque del panel: la detección de IP pública es rápida (segundos), pero la
   * escalada completa (esperar telemetría -> UPnP) corre en segundo plano y va actualizando el
   * estado que expone /api/state, que el panel ya consulta por polling. */
  async start(): Promise<void> {
    this.keepaliveTimer = setInterval(() => {
      try {
        this.udpClient.setRealtimePosInterval(200);
      } catch {
        // best-effort: si falla, el próximo tick reintenta solo.
      }
    }, KEEPALIVE_INTERVAL_MS);

    if (this.options.discovery !== false) this.detectedIp = await detectPublicIp();
    this.waitAndEscalate().catch((err) => console.error("[connectivity] error en la escalada de red:", err));
  }

  /** Reintenta la detección de IP pública a pedido — es lo primero que un admin quiere volver a
   * probar después de conectar internet o apagar la VPN que la bloqueaba.
   *
   * En el portal la dirección la fija quien despliega y no hay nada que redetectar: sin esta
   * guarda, cada click en "Probar ahora" de cada liga saldría a un servicio externo para tirar
   * el resultado a la basura. */
  async redetectPublicIp(): Promise<string | null> {
    if (this.options.discovery === false) return this.getStatus().publicIp;
    this.detectedIp = await detectPublicIp();
    return this.detectedIp;
  }

  stop(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
  }

  /** Refresca "¿nos está llegando señal AHORA?" sin repetir la escalada — para que el panel
   * pueda avisar si la señal se corta a mitad de una carrera ya en curso. */
  refreshTelemetryFlag(): void {
    const stats = this.udpClient.getStats();
    this.status.receivingTelemetry = stats.lastPacketAt > 0 && Date.now() - stats.lastPacketAt < 5000;
    this.status.lastCheckedAt = Date.now();
  }

  private async waitAndEscalate(): Promise<void> {
    // Sin descubrimiento (portal) no hay nada que escalar: los puertos están abiertos en el
    // firewall del servidor y la única pregunta que queda es si el servidor de AC está mandando.
    if (this.options.discovery === false) {
      const before = this.udpClient.getStats().packetsReceived;
      await delay(TELEMETRY_WAIT_MS);
      const arrived = this.udpClient.getStats().packetsReceived > before;
      this.status.strategy = arrived ? "direct" : "manual";
      this.status.receivingTelemetry = arrived;
      this.status.lastCheckedAt = Date.now();
      return;
    }

    // El puerto TCP de los clientes se mapea SIEMPRE, antes de cualquier otra cosa.
    //
    // Antes esto vivía dentro de la rama de fallo del UDP, y ahí está el problema: el pinhole de
    // NAT que hace entrar la telemetría UDP no abre nada para el TCP entrante de los pilotos. Con
    // el UDP entrando "directo", esta función retornaba temprano y el puerto de clientes no se
    // tocaba nunca: el panel mostraba "directa / recibiendo" en verde mientras ningún piloto podía
    // mandar heartbeat, y todos terminaban kickeados por el watchdog de presencia.
    this.status.clientPortMapped = await tryUpnpMapping([
      { public: this.ports.tcpClientPort, private: this.ports.tcpClientPort, protocol: "TCP", description: "Race Control (clientes)" },
    ]);

    const before = this.udpClient.getStats().packetsReceived;
    await delay(TELEMETRY_WAIT_MS);
    if (this.udpClient.getStats().packetsReceived > before) {
      this.status.strategy = "direct";
      this.status.receivingTelemetry = true;
      this.status.lastCheckedAt = Date.now();
      return;
    }

    this.status.upnpAttempted = true;
    const upnpOk = await tryUpnpMapping([
      { public: this.ports.udpLocalPort, private: this.ports.udpLocalPort, protocol: "UDP", description: "Race Control (telemetria Assetto Corsa)" },
    ]);
    this.status.upnpSuccess = upnpOk;

    if (upnpOk) {
      const beforeUpnp = this.udpClient.getStats().packetsReceived;
      await delay(TELEMETRY_WAIT_MS);
      if (this.udpClient.getStats().packetsReceived > beforeUpnp) {
        this.status.strategy = "upnp";
        this.status.receivingTelemetry = true;
        this.status.lastCheckedAt = Date.now();
        return;
      }
    }

    this.status.strategy = "manual";
    this.status.receivingTelemetry = false;
    this.status.lastCheckedAt = Date.now();
  }
}

function delay(ms: number): Promise<void> {
  // `unref` para que esta espera no mantenga vivo el proceso: la escalada de red corre en segundo
  // plano y no es motivo para que el backend tarde 8 segundos más en cerrar (ni para que un test
  // se quede esperando a que termine una detección que a nadie le importa).
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface PortMapping {
  public: number;
  private: number;
  protocol: "TCP" | "UDP";
  description: string;
}

/** Best-effort: timeout corto y sin romper el arranque si el router no habla UPnP. */
async function tryUpnpMapping(mappings: PortMapping[]): Promise<boolean> {
  const client = new NatUpnpClient({ timeout: UPNP_TIMEOUT_MS });
  try {
    for (const mapping of mappings) {
      await withTimeout(client.createMapping({ ...mapping, ttl: 0 }), UPNP_TIMEOUT_MS);
    }
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

function detectPublicIp(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get("https://api.ipify.org?format=json", { timeout: PUBLIC_IP_TIMEOUT_MS }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve(typeof parsed.ip === "string" ? parsed.ip : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
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

/**
 * Arma el bloque listo para copiar/pegar en el `server_cfg.ini` del hosting.
 *
 * Sigue haciendo falta para quien edita el archivo a mano, donde sí hay que declarar las dos
 * líneas. Sirve para cualquier hosting de Assetto Corsa, no solo EmperorServers:
 * `UDP_PLUGIN_LOCAL_PORT` y `UDP_PLUGIN_ADDRESS` son del propio juego, no de ninguna empresa en
 * particular — en los paneles modernos aparecen como "Listen Address" y "Send Address".
 */
export function buildServerSnippet(publicIp: string | null, udpLocalPort: number, acRemotePort: number): string {
  const ip = publicIp ?? "<TU_IP_PUBLICA>";
  return [`UDP_PLUGIN_LOCAL_PORT=${acRemotePort}`, `UDP_PLUGIN_ADDRESS=${ip}:${udpLocalPort}`].join("\n");
}
