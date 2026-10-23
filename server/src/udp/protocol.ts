/**
 * Protocolo UDP del plugin del servidor dedicado de Assetto Corsa (ACSP).
 *
 * Opcodes y layouts verificados contra el ejemplo oficial de Kunos
 * (`acRemoteServerUDP_Example`, un proyecto C# que Kunos distribuye como referencia del
 * protocolo), cruzado además contra dos implementaciones comunitarias independientes
 * (joaoubaldo/acudpclient en Python, flamescape/acsp en Node.js) — las tres coinciden
 * exactamente en opcodes, orden de campos y, crucialmente, en el formato de los strings
 * (ver `wideString`/`narrowString` abajo, antes mal implementado como UTF-16LE genérico).
 *
 * Lo que SIGUE sin poder confirmarse sin un servidor real (ver docs/spike-protocolo.md):
 * el formato exacto real de `driverGuid` en la práctica, y el comportamiento de la red bajo
 * pérdida de paquetes/múltiples autos — eso no depende de leer código, depende de observar
 * tráfico real.
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

/**
 * Respuesta a GET_CAR_INFO: quién ocupa un slot de la parrilla *ahora*, sin esperar a que se
 * conecte de nuevo.
 *
 * Es lo que permite que un reinicio del backend a mitad de carrera no deje la torre llena de
 * autos sin nombre: `NEW_CONNECTION` ya pasó y no se vuelve a emitir, y `CAR_UPDATE` solo trae
 * el número de slot. Preguntando por cada slot al arrancar, la parrilla se repuebla sola.
 */
export interface CarInfo extends NewConnection {
  isConnected: boolean;
  driverTeam: string;
}

export interface LapCompleted {
  carId: number;
  lapTimeMs: number;
  cuts: number;
}

export interface ChatMessage {
  carId: number;
  message: string;
}

export interface SessionInfo {
  protocolVersion: number;
  sessionIndex: number;
  currentSessionIndex: number;
  sessionCount: number;
  serverName: string;
  track: string;
  trackConfig: string;
  name: string;
  sessionType: number;
  /** Duración de la sesión en MINUTOS. El nombre anterior ("timeSeconds") estaba mal y nunca se
   * había usado: en el ejemplo oficial de Kunos este campo se imprime como "Time: {0} minutes",
   * mientras que `wait_time`, el de abajo, sí viene en segundos. Un campo sin usar no duele; el
   * tiempo restante de carrera calculado con la unidad equivocada daría 60 veces menos. */
  timeMinutes: number;
  laps: number;
  waitTimeSeconds: number;
  ambientTemp: number;
  roadTemp: number;
  weatherGraphics: string;
  elapsedMs: number;
}

export interface ErrorMessage {
  message: string;
}

/** Subtipos de CLIENT_EVENT. Los dos de colisión son los únicos documentados por Kunos. */
export const ClientEventType = {
  COLLISION_WITH_CAR: 10,
  COLLISION_WITH_ENV: 11,
} as const;

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface ClientEvent {
  /** 10 = contra otro auto, 11 = contra el entorno (muro, piano, cualquier parte del circuito). */
  eventType: number;
  carId: number;
  /** Solo presente cuando eventType === COLLISION_WITH_CAR. */
  otherCarId?: number;
  /** Velocidad de la componente de impacto. Es lo que distingue rozar un piano de estrellarse. */
  impactSpeed: number;
  /** Dónde ocurrió, en coordenadas del mundo. */
  worldPosition: Vector3;
  /**
   * Dónde golpeó, RELATIVO al chasis del auto que reporta. Es el campo que permite deducir la
   * geometría del toque: `z` positivo/negativo indica trompa o cola, `x` indica el costado.
   * El servidor manda un paquete por cada auto involucrado, cada uno con su propio relPosition —
   * cruzando los dos se sabe quién embistió a quién (ver incident/incidentEngine.ts).
   */
  relPosition: Vector3;
}

export type IncomingPacket =
  | { type: "CAR_UPDATE"; data: CarUpdate }
  | { type: "NEW_CONNECTION"; data: NewConnection }
  | { type: "CONNECTION_CLOSED"; data: ConnectionClosed }
  | { type: "CAR_INFO"; data: CarInfo }
  | { type: "LAP_COMPLETED"; data: LapCompleted }
  | { type: "CHAT"; data: ChatMessage }
  | { type: "NEW_SESSION" | "SESSION_INFO"; data: SessionInfo }
  | { type: "ERROR"; data: ErrorMessage }
  | { type: "CLIENT_EVENT"; data: ClientEvent }
  | { type: "END_SESSION" | "CLIENT_LOADED"; raw: Buffer };

/** Paquete UDP más corto de lo que exige el opcode decodificado — nunca debe tumbar el proceso. */
export class TruncatedPacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedPacketError";
  }
}

class BufferReader {
  private offset = 0;
  constructor(private buf: Buffer) {}

  private ensure(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new TruncatedPacketError(
        `Se esperaban ${n} bytes en offset ${this.offset} pero el paquete mide ${this.buf.length}`
      );
    }
  }

  byte(): number {
    this.ensure(1);
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  uint16(): number {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  int32(): number {
    this.ensure(4);
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  uint32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  float(): number {
    this.ensure(4);
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  vector3(): Vector3 {
    return { x: this.float(), y: this.float(), z: this.float() };
  }

  /**
   * Strings "anchas" del protocolo (nombre de piloto, guid, mensajes de chat, nombre de
   * servidor): 1 byte de longitud EN CARACTERES, seguido de 4 bytes por carácter en UTF-32LE.
   * Confirmado contra el ejemplo oficial de Kunos (`Encoding.UTF32.GetString(...)` en
   * `readStringW`) — el código anterior de este archivo asumía UTF-16LE (2 bytes/char), lo
   * cual corrompía cualquier driverGuid/driverName/mensaje de chat leído.
   */
  wideString(): string {
    const len = this.byte();
    this.ensure(len * 4);
    let result = "";
    for (let i = 0; i < len; i++) {
      result += String.fromCodePoint(this.buf.readUInt32LE(this.offset + i * 4));
    }
    this.offset += len * 4;
    return result;
  }

  /** Strings "angostas" (modelo/skin de auto, nombre de pista, clima): 1 byte de longitud EN
   * BYTES, seguido de esa cantidad de bytes en ASCII/UTF-8. */
  narrowString(): string {
    const len = this.byte();
    this.ensure(len);
    const str = this.buf.toString("utf8", this.offset, this.offset + len);
    this.offset += len;
    return str;
  }

  hasMore(): boolean {
    return this.offset < this.buf.length;
  }
}

/** Codifica para mandar AL servidor — todos los comandos de texto (chat, admin) usan el mismo
 * formato ancho (UTF-32LE) que las strings anchas que recibimos. */
function writeWideString(value: string): Buffer {
  const codePoints = Array.from(value);
  if (codePoints.length > 255) {
    throw new RangeError("El mensaje no puede superar los 255 caracteres");
  }
  const body = Buffer.alloc(codePoints.length * 4);
  codePoints.forEach((ch, i) => body.writeUInt32LE(ch.codePointAt(0)!, i * 4));
  return Buffer.concat([Buffer.from([codePoints.length]), body]);
}

function readSessionInfo(r: BufferReader): SessionInfo {
  return {
    protocolVersion: r.byte(),
    sessionIndex: r.byte(),
    currentSessionIndex: r.byte(),
    sessionCount: r.byte(),
    serverName: r.wideString(),
    track: r.narrowString(),
    trackConfig: r.narrowString(),
    name: r.narrowString(),
    sessionType: r.byte(),
    timeMinutes: r.uint16(),
    laps: r.uint16(),
    waitTimeSeconds: r.uint16(),
    ambientTemp: r.byte(),
    roadTemp: r.byte(),
    weatherGraphics: r.narrowString(),
    elapsedMs: r.int32(),
  };
}

export function decodePacket(buf: Buffer): IncomingPacket | null {
  if (buf.length === 0) return null;
  try {
    return decodePacketUnsafe(buf);
  } catch (err) {
    if (err instanceof TruncatedPacketError) return null;
    throw err;
  }
}

function decodePacketUnsafe(buf: Buffer): IncomingPacket | null {
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
      // Asumimos Y como eje vertical (convención estándar del motor de AC) y calculamos la
      // velocidad solo con el plano horizontal — incluir la componente vertical sobreestimaría
      // la velocidad en subidas/bajadas. Pendiente de confirmar contra un servidor real.
      const speedMs = Math.sqrt(velocityX ** 2 + velocityZ ** 2);
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
      const driverName = r.wideString();
      const driverGuid = r.wideString();
      const carId = r.byte();
      const carModel = r.narrowString();
      const carSkin = r.narrowString();
      const data = { carId, driverName, driverGuid, carModel, carSkin };
      return {
        type: opcode === Opcode.NEW_CONNECTION ? "NEW_CONNECTION" : "CONNECTION_CLOSED",
        data,
      };
    }
    case Opcode.CAR_INFO: {
      // Orden distinto al de NEW_CONNECTION, y no es un error de transcripción: acá el slot viene
      // primero y el modelo/skin antes que el nombre. Verificado contra el ejemplo oficial de
      // Kunos (`ACSP_CAR_INFO` en el plugin de muestra) y `joaoubaldo/acudpclient`.
      const carId = r.byte();
      const isConnected = r.byte() !== 0;
      const carModel = r.wideString();
      const carSkin = r.wideString();
      const driverName = r.wideString();
      const driverTeam = r.wideString();
      const driverGuid = r.wideString();
      return {
        type: "CAR_INFO",
        data: { carId, isConnected, carModel, carSkin, driverName, driverTeam, driverGuid },
      };
    }
    case Opcode.LAP_COMPLETED: {
      const carId = r.byte();
      const lapTimeMs = r.uint32();
      const cuts = r.byte();
      // Después de esto el paquete trae un leaderboard (cars_count + N × {carId, time, laps})
      // y un grip_level final — no los necesitamos hoy, así que no los leemos (no hace falta
      // consumir el resto del buffer, decodePacket no exige llegar al final).
      return { type: "LAP_COMPLETED", data: { carId, lapTimeMs, cuts } };
    }
    case Opcode.CHAT: {
      const carId = r.byte();
      const message = r.wideString();
      return { type: "CHAT", data: { carId, message } };
    }
    case Opcode.NEW_SESSION:
      return { type: "NEW_SESSION", data: readSessionInfo(r) };
    case Opcode.SESSION_INFO:
      return { type: "SESSION_INFO", data: readSessionInfo(r) };
    case Opcode.ERROR:
      return { type: "ERROR", data: { message: r.wideString() } };
    case Opcode.END_SESSION:
      return { type: "END_SESSION", raw: buf };
    case Opcode.CLIENT_LOADED:
      return { type: "CLIENT_LOADED", raw: buf };
    case Opcode.CLIENT_EVENT: {
      // El orden importa: `other_car_id` SOLO existe si el evento es contra otro auto. Leerlo
      // siempre desfasaría un byte todo el resto (velocidad de impacto y las dos posiciones).
      const eventType = r.byte();
      const carId = r.byte();
      const otherCarId = eventType === ClientEventType.COLLISION_WITH_CAR ? r.byte() : undefined;
      const impactSpeed = r.float();
      const worldPosition = r.vector3();
      const relPosition = r.vector3();
      return {
        type: "CLIENT_EVENT",
        data: { eventType, carId, otherCarId, impactSpeed, worldPosition, relPosition },
      };
    }
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
  return Buffer.concat([Buffer.from([Opcode.SEND_CHAT, carId]), writeWideString(message)]);
}

export function encodeBroadcastChat(message: string): Buffer {
  return Buffer.concat([Buffer.from([Opcode.BROADCAST_CHAT]), writeWideString(message)]);
}

export function encodeAdminCommand(command: string): Buffer {
  return Buffer.concat([Buffer.from([Opcode.ADMIN_COMMAND]), writeWideString(command)]);
}

export function encodeKickUser(carId: number): Buffer {
  return Buffer.from([Opcode.KICK_USER, carId]);
}

export function encodeGetCarInfo(carId: number): Buffer {
  return Buffer.from([Opcode.GET_CAR_INFO, carId]);
}

/** `-1` (el valor por defecto) pide la sesión que se está corriendo ahora. El índice va como
 * int16 con signo justamente para poder expresar ese -1. */
export function encodeGetSessionInfo(sessionIndex = -1): Buffer {
  const buf = Buffer.alloc(3);
  buf.writeUInt8(Opcode.GET_SESSION_INFO, 0);
  buf.writeInt16LE(sessionIndex, 1);
  return buf;
}
