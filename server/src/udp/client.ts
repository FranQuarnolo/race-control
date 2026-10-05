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

/** Habla el protocolo ACSP con el servidor dedicado de Assetto Corsa. Ver protocol.ts. */
export class AcUdpClient extends EventEmitter {
  private socket: dgram.Socket;

  constructor(private config: AcUdpConfig) {
    super();
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (msg) => this.handleMessage(msg));
    this.socket.on("error", (err) => this.emit("error", err));
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.bind(this.config.localPort, () => resolve());
    });
  }

  stop(): void {
    this.socket.close();
  }

  private handleMessage(msg: Buffer): void {
    const packet = decodePacket(msg);
    if (!packet) return;
    this.emit(packet.type, "data" in packet ? packet.data : packet.raw);
    this.emit("packet", packet);
  }

  private send(buf: Buffer): void {
    this.socket.send(buf, this.config.remotePort, this.config.remoteHost);
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
