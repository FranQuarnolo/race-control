import { EventEmitter } from "events";
import { CarUpdate, ConnectionClosed, LapCompleted, NewConnection } from "../udp/protocol";

export interface CarState {
  carId: number;
  driverName: string;
  driverGuid: string;
  carModel: string;
  connected: boolean;
  speedKmh: number;
  posX: number;
  posY: number;
  posZ: number;
  normalizedSplinePosition: number;
  lapCount: number;
  lastUpdate: number;
}

const MAX_PLAUSIBLE_SPEED_KMH = 400;

function emptyState(carId: number): CarState {
  return {
    carId,
    driverName: "",
    driverGuid: "",
    carModel: "",
    connected: false,
    speedKmh: 0,
    posX: 0,
    posY: 0,
    posZ: 0,
    normalizedSplinePosition: 0,
    lapCount: 0,
    lastUpdate: 0,
  };
}

/** Tabla en memoria de telemetría por auto, alimentada por el UDP client. */
export class StateTracker extends EventEmitter {
  private cars = new Map<number, CarState>();

  private getOrCreate(carId: number): CarState {
    let state = this.cars.get(carId);
    if (!state) {
      state = emptyState(carId);
      this.cars.set(carId, state);
    }
    return state;
  }

  onNewConnection(data: NewConnection): void {
    const state = this.getOrCreate(data.carId);
    // Un NEW_CONNECTION duplicado del mismo piloto ya conectado (reenvío, paquete repetido) no
    // debe resetear el conteo de vueltas a mitad de carrera.
    const isDuplicateOfCurrentOccupant = state.connected && state.driverGuid === data.driverGuid;
    state.driverName = data.driverName;
    state.driverGuid = data.driverGuid;
    state.carModel = data.carModel;
    state.connected = true;
    if (!isDuplicateOfCurrentOccupant) state.lapCount = 0;
    this.emit("connected", state);
  }

  onConnectionClosed(data: ConnectionClosed): void {
    const state = this.cars.get(data.carId);
    if (!state) return;
    // Un CONNECTION_CLOSED viejo/fuera de orden no debe desconectar al piloto que reocupó el
    // mismo slot después (caso borde: reconexión rápida con reuso de carId).
    if (state.driverGuid !== data.driverGuid) return;
    state.connected = false;
    this.emit("disconnected", state);
  }

  onCarUpdate(data: CarUpdate): void {
    if (!this.isPlausibleSample(data)) return;
    const state = this.getOrCreate(data.carId);
    state.speedKmh = data.speedKmh;
    state.posX = data.posX;
    state.posY = data.posY;
    state.posZ = data.posZ;
    state.normalizedSplinePosition = data.normalizedSplinePosition;
    state.lastUpdate = Date.now();
    this.emit("update", state);
  }

  private isPlausibleSample(data: CarUpdate): boolean {
    if (!Number.isFinite(data.speedKmh) || data.speedKmh < 0 || data.speedKmh > MAX_PLAUSIBLE_SPEED_KMH) {
      return false;
    }
    if (!Number.isFinite(data.normalizedSplinePosition) || data.normalizedSplinePosition < 0 || data.normalizedSplinePosition > 1) {
      return false;
    }
    return true;
  }

  onLapCompleted(data: LapCompleted): void {
    const state = this.getOrCreate(data.carId);
    state.lapCount += 1;
    this.emit("lapCompleted", { carId: data.carId, lapCount: state.lapCount, lapTimeMs: data.lapTimeMs, cuts: data.cuts });
  }

  get(carId: number): CarState | undefined {
    return this.cars.get(carId);
  }

  /** Resuelve el carId ACTUAL de un piloto por su driverGuid — necesario porque una sanción
   * emitida contra un carId puede quedar desactualizada si el piloto se reconecta y le toca
   * otro slot (reuso de carId por el servidor de AC). */
  findCarIdByGuid(driverGuid: string): number | undefined {
    for (const state of this.cars.values()) {
      if (state.connected && state.driverGuid === driverGuid) return state.carId;
    }
    return undefined;
  }

  getAll(): CarState[] {
    return Array.from(this.cars.values());
  }

  getConnected(): CarState[] {
    return this.getAll().filter((c) => c.connected);
  }
}
