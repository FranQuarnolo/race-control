import * as dgram from "dgram";
import { EventEmitter } from "events";
import {
  decodePacket,
  encodeAdminCommand,
  encodeBroadcastChat,
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
    this.socket.on("message", (msg) => this.handleMessage(msg));
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

  private handleMessage(msg: Buffer): void {
    this.stats.packetsReceived += 1;
    this.stats.lastPacketAt = Date.now();
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
}
