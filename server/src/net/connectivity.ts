import * as https from "https";
import { Client as NatUpnpClient } from "@runonflux/nat-upnp";
import { AcUdpClient } from "../udp/client";

export type NetworkStrategy = "pending" | "direct" | "upnp" | "manual";

export interface NetworkStatus {
  publicIp: string | null;
  receivingTelemetry: boolean;
  strategy: NetworkStrategy;
  upnpAttempted: boolean;
  upnpSuccess: boolean | null;
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
    receivingTelemetry: false,
    strategy: "pending",
    upnpAttempted: false,
    upnpSuccess: null,
    lastCheckedAt: 0,
  };
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(private udpClient: AcUdpClient, private ports: { udpLocalPort: number; tcpClientPort: number }) {}

  getStatus(): NetworkStatus {
    return { ...this.status };
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

    this.status.publicIp = await detectPublicIp();
    this.waitAndEscalate().catch((err) => console.error("[connectivity] error en la escalada de red:", err));
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
    const before = this.udpClient.getStats().packetsReceived;
    await delay(TELEMETRY_WAIT_MS);
    if (this.udpClient.getStats().packetsReceived > before) {
      this.status.strategy = "direct";
      this.status.receivingTelemetry = true;
      this.status.lastCheckedAt = Date.now();
      return;
    }

    this.status.upnpAttempted = true;
    const upnpOk = await tryUpnpMapping(this.ports);
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
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function tryUpnpMapping(ports: { udpLocalPort: number; tcpClientPort: number }): Promise<boolean> {
  const client = new NatUpnpClient({ timeout: UPNP_TIMEOUT_MS });
  try {
    await withTimeout(
      client.createMapping({
        public: ports.udpLocalPort,
        private: ports.udpLocalPort,
        protocol: "UDP",
        ttl: 0,
        description: "Race Control (telemetria Assetto Corsa)",
      }),
      UPNP_TIMEOUT_MS
    );
    await withTimeout(
      client.createMapping({
        public: ports.tcpClientPort,
        private: ports.tcpClientPort,
        protocol: "TCP",
        ttl: 0,
        description: "Race Control (clientes)",
      }),
      UPNP_TIMEOUT_MS
    );
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

/** Arma el bloque listo para copiar/pegar en server_cfg.ini del hosting (ej. EmperorServers). */
export function buildEmperorServersSnippet(publicIp: string | null, udpLocalPort: number, acRemotePort: number): string {
  const ip = publicIp ?? "<TU_IP_PUBLICA>";
  return [`UDP_PLUGIN_LOCAL_PORT=${acRemotePort}`, `UDP_PLUGIN_ADDRESS=${ip}:${udpLocalPort}`].join("\n");
}
