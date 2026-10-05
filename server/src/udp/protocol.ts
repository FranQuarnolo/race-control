/**
 * Protocolo UDP del plugin del servidor dedicado de Assetto Corsa (ACSP).
 *
 * IMPORTANTE: Los valores de opcode y los layouts de cada paquete están tomados de
 * implementaciones comunitarias de referencia (joaoubaldo/acudpclient, flamescape/acsp),
 * no de documentación oficial de Kunos. Antes de confiar en esto en producción hay que
 * validarlo con una captura real (Wireshark) contra un acServer de prueba —
 * ver "Spike de protocolo" en el plan.
 */

export const Opcode = {
  // Servidor -> plugin
  NEW_SESSION: 50,
  NEW_CONNECTION: 51,
  CONNECTION_CLOSED: 52,
  CAR_UPDATE: 53,
  CAR_INFO: 54,
  END_SESSION: 55,
  VERSION: 56,
  CHAT: 57,
  CLIENT_LOADED: 58,
  SESSION_INFO: 59,
  ERROR: 60,
  LAP_COMPLETED: 73,
  CLIENT_EVENT: 130,

  // Plugin -> servidor
  REALTIMEPOS_INTERVAL: 200,
  GET_CAR_INFO: 201,
  SEND_CHAT: 202,
  BROADCAST_CHAT: 203,
  GET_SESSION_INFO: 204,
  SET_SESSION_INFO: 205,
  KICK_USER: 206,
  NEXT_SESSION: 207,
  RESTART_SESSION: 208,
  ADMIN_COMMAND: 209,
} as const;

export interface CarUpdate {
  carId: number;
  posX: number;
  posY: number;
  posZ: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  gear: number;
  engineRpm: number;
  normalizedSplinePosition: number;
  speedKmh: number;
}

export interface NewConnection {
  carId: number;
  driverName: string;
  driverGuid: string;
  carModel: string;
  carSkin: string;
}

export interface ConnectionClosed extends NewConnection {}

export interface LapCompleted {
  carId: number;
  lapTimeMs: number;
  cuts: number;
}

export interface ChatMessage {
  carId: number;
  message: string;
}

export type IncomingPacket =
  | { type: "CAR_UPDATE"; data: CarUpdate }
  | { type: "NEW_CONNECTION"; data: NewConnection }
  | { type: "CONNECTION_CLOSED"; data: ConnectionClosed }
  | { type: "LAP_COMPLETED"; data: LapCompleted }
  | { type: "CHAT"; data: ChatMessage }
  | { type: "NEW_SESSION" | "END_SESSION" | "CLIENT_LOADED" | "SESSION_INFO" | "ERROR" | "CLIENT_EVENT"; raw: Buffer };

class BufferReader {
  private offset = 0;
  constructor(private buf: Buffer) {}

  byte(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  uint16(): number {
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  int32(): number {
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  float(): number {
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  /** Strings ACSP: 1 byte de longitud (en caracteres) + UTF-16LE. */
  string(): string {
    const len = this.byte();
    const str = this.buf.toString("utf16le", this.offset, this.offset + len * 2);
    this.offset += len * 2;
    return str;
  }

  hasMore(): boolean {
    return this.offset < this.buf.length;
  }
}

function writeAcString(value: string): Buffer {
  const chars = Buffer.from(value, "utf16le");
  const header = Buffer.from([value.length]);
  return Buffer.concat([header, chars]);
}

export function decodePacket(buf: Buffer): IncomingPacket | null {
  if (buf.length === 0) return null;
  const opcode = buf.readUInt8(0);
  const r = new BufferReader(buf.subarray(1));

  switch (opcode) {
    case Opcode.CAR_UPDATE: {
      const carId = r.byte();
      const posX = r.float();
      const posY = r.float();
      const posZ = r.float();
      const velocityX = r.float();
      const velocityY = r.float();
      const velocityZ = r.float();
      const gear = r.byte();
      const engineRpm = r.uint16();
      const normalizedSplinePosition = r.float();
      const speedMs = Math.sqrt(velocityX ** 2 + velocityY ** 2 + velocityZ ** 2);
      return {
        type: "CAR_UPDATE",
        data: {
          carId,
          posX,
          posY,
          posZ,
          velocityX,
          velocityY,
          velocityZ,
          gear,
          engineRpm,
          normalizedSplinePosition,
          speedKmh: speedMs * 3.6,
        },
      };
    }
    case Opcode.NEW_CONNECTION:
    case Opcode.CONNECTION_CLOSED: {
      const driverName = r.string();
      const driverGuid = r.string();
      const carId = r.byte();
      const carModel = r.string();
      const carSkin = r.string();
      const data = { carId, driverName, driverGuid, carModel, carSkin };
      return {
        type: opcode === Opcode.NEW_CONNECTION ? "NEW_CONNECTION" : "CONNECTION_CLOSED",
        data,
      };
    }
    case Opcode.LAP_COMPLETED: {
      const carId = r.byte();
      const lapTimeMs = r.int32();
      const cuts = r.byte();
      return { type: "LAP_COMPLETED", data: { carId, lapTimeMs, cuts } };
    }
    case Opcode.CHAT: {
      const carId = r.byte();
      const message = r.string();
      return { type: "CHAT", data: { carId, message } };
    }
    case Opcode.NEW_SESSION:
      return { type: "NEW_SESSION", raw: buf };
    case Opcode.END_SESSION:
      return { type: "END_SESSION", raw: buf };
    case Opcode.CLIENT_LOADED:
      return { type: "CLIENT_LOADED", raw: buf };
    case Opcode.SESSION_INFO:
      return { type: "SESSION_INFO", raw: buf };
    case Opcode.ERROR:
      return { type: "ERROR", raw: buf };
    case Opcode.CLIENT_EVENT:
      return { type: "CLIENT_EVENT", raw: buf };
    default:
      return null;
  }
}

export function encodeRealtimePosInterval(intervalMs: number): Buffer {
  const buf = Buffer.alloc(3);
  buf.writeUInt8(Opcode.REALTIMEPOS_INTERVAL, 0);
  buf.writeUInt16LE(intervalMs, 1);
  return buf;
}

export function encodeSendChat(carId: number, message: string): Buffer {
  return Buffer.concat([Buffer.from([Opcode.SEND_CHAT, carId]), writeAcString(message)]);
}

export function encodeBroadcastChat(message: string): Buffer {
  return Buffer.concat([Buffer.from([Opcode.BROADCAST_CHAT]), writeAcString(message)]);
}

export function encodeAdminCommand(command: string): Buffer {
  return Buffer.concat([Buffer.from([Opcode.ADMIN_COMMAND]), writeAcString(command)]);
}

export function encodeKickUser(carId: number): Buffer {
  return Buffer.from([Opcode.KICK_USER, carId]);
}
