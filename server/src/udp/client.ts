import * as dgram from "dgram";
import { EventEmitter } from "events";
import {
  decodePacket,
  encodeAdminCommand,
  encodeBroadcastChat,
  encodeGetCarInfo,
  encodeGetSessionInfo,
  encodeKickUser,
  encodeRealtimePosInterval,
  encodeSendChat,
} from "./protocol";

export interface AcUdpConfig {
  /** Puerto local donde este proceso escucha los paquetes que manda el acServer. */
  localPort: number;
  /** Host/puerto del acServer al que le mandamos comandos (UDP_PLUGIN_ADDRESS del server_cfg.ini). */
  remoteHost: string;
  remotePort: number;
}

/** `0.0.0.0` incluido a propósito: como destino de un `send()` es equivalente a loopback. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
}

export interface UdpStats {
  packetsReceived: number;
  /** Paquetes con opcode desconocido o malformados/truncados — nunca deberían crashear el proceso. */
  packetsUnhandled: number;
  lastPacketAt: number;
  commandsSent: number;
  commandSendErrors: number;
}

/** Habla el protocolo ACSP con el servidor dedicado de Assetto Corsa. Ver protocol.ts. */
export class AcUdpClient extends EventEmitter {
  private socket: dgram.Socket;
  private stats: UdpStats = {
    packetsReceived: 0,
    packetsUnhandled: 0,
    lastPacketAt: 0,
    commandsSent: 0,
    commandSendErrors: 0,
  };

  constructor(private config: AcUdpConfig) {
    super();
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (msg, rinfo) => this.handleMessage(msg, rinfo));
    // Nunca dejar que un error de socket tumbe el proceso: el que arma el backend (index.ts)
    // decide qué hacer (loguear, reintentar). Un EventEmitter sin listener de "error" relanza
    // la excepción y mata el proceso — por eso este reenvío es obligatorio, no cosmético.
    this.socket.on("error", (err) => this.emit("error", err));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onBindError = (err: Error) => reject(err);
      this.socket.once("error", onBindError);
      this.socket.bind(this.config.localPort, () => {
        this.socket.removeListener("error", onBindError);
        resolve();
      });
    });
  }

  stop(): void {
    this.socket.close();
  }

  getStats(): UdpStats {
    return { ...this.stats };
  }

  /** A dónde se están mandando los comandos ahora mismo — el panel lo muestra para que un fallo
   * de envío sea diagnosticable sin leer el config a mano. */
  getRemoteTarget(): { host: string; port: number; autodetected: boolean } {
    return {
      host: this.config.remoteHost,
      port: this.config.remotePort,
      autodetected: !isLoopback(this.config.remoteHost),
    };
  }

  /**
   * El servidor de AC se identifica solo: el primer datagrama que manda trae su dirección real.
   *
   * Esto existe porque `remoteHost` arrancaba fijo en 127.0.0.1 y no era configurable desde
   * ningún lado — contra un hosting remoto (el caso de uso real: EmperorServers) TODO el tráfico
   * saliente moría en loopback: el chat de penalización, los kicks, `/ballast` y el keepalive que
   * abre el pinhole de NAT del que depende la estrategia de red "direct". El backend recibía
   * telemetría perfecta y no podía contestar nada.
   *
   * Solo se adopta la dirección de origen, no el puerto: el puerto de comandos es el que el admin
   * declaró en `UDP_PLUGIN_LOCAL_PORT` de su `server_cfg.ini`, y ese es el valor autoritativo. Si
   * el origen no coincide se emite igual para que quede registrado en el journal, porque es el
   * dato que explicaría por qué los comandos no llegan si alguna versión del servidor difiere.
   */
  private adoptRemoteHostIfNeeded(rinfo: dgram.RemoteInfo): void {
    if (!isLoopback(this.config.remoteHost) || isLoopback(rinfo.address)) return;
    const previous = this.config.remoteHost;
    this.config.remoteHost = rinfo.address;
    this.emit("remoteHostDetected", {
      previous,
      detected: rinfo.address,
      sourcePort: rinfo.port,
      configuredPort: this.config.remotePort,
    });
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    this.stats.packetsReceived += 1;
    this.stats.lastPacketAt = Date.now();
    this.adoptRemoteHostIfNeeded(rinfo);
    this.emit("rawPacket", msg);

    const packet = decodePacket(msg);
    if (!packet) {
      this.stats.packetsUnhandled += 1;
      return;
    }
    this.emit(packet.type, "data" in packet ? packet.data : packet.raw);
    this.emit("packet", packet);
  }

  private send(buf: Buffer): void {
    this.stats.commandsSent += 1;
    this.socket.send(buf, this.config.remotePort, this.config.remoteHost, (err) => {
      if (err) {
        this.stats.commandSendErrors += 1;
        this.emit("sendError", err);
      }
    });
  }

  /** Activa el streaming periódico de CAR_UPDATE para todos los autos. */
  setRealtimePosInterval(intervalMs: number): void {
    this.send(encodeRealtimePosInterval(intervalMs));
  }

  sendChatToCar(carId: number, message: string): void {
    this.send(encodeSendChat(carId, message));
  }

  broadcastChat(message: string): void {
    this.send(encodeBroadcastChat(message));
  }

  /** Comandos de consola admin: "/ballast <carId> <kg>", "/restrictor <carId> <pct>", "/kick <carId>", etc. */
  sendAdminCommand(command: string): void {
    this.send(encodeAdminCommand(command));
  }

  kick(carId: number): void {
    this.send(encodeKickUser(carId));
  }

  /** Pregunta quién ocupa un slot. El servidor responde con CAR_INFO, aunque el piloto se haya
   * conectado antes de que este proceso existiera. */
  requestCarInfo(carId: number): void {
    this.send(encodeGetCarInfo(carId));
  }

  /** Pide las condiciones de la sesión en curso. El servidor no las manda solo salvo al cambiar
   * de sesión, así que sin preguntar el tiempo corrido se va quedando viejo. */
  requestSessionInfo(): void {
    this.send(encodeGetSessionInfo());
  }
}
