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
    state.driverName = data.driverName;
    state.driverGuid = data.driverGuid;
    state.carModel = data.carModel;
    state.connected = true;
    state.lapCount = 0;
    this.emit("connected", state);
  }

  onConnectionClosed(data: ConnectionClosed): void {
    const state = this.cars.get(data.carId);
    if (state) {
      state.connected = false;
      this.emit("disconnected", state);
    }
  }

  onCarUpdate(data: CarUpdate): void {
    const state = this.getOrCreate(data.carId);
    state.speedKmh = data.speedKmh;
    state.posX = data.posX;
    state.posY = data.posY;
    state.posZ = data.posZ;
    state.normalizedSplinePosition = data.normalizedSplinePosition;
    state.lastUpdate = Date.now();
    this.emit("update", state);
  }

  onLapCompleted(data: LapCompleted): void {
    const state = this.getOrCreate(data.carId);
    state.lapCount += 1;
    this.emit("lapCompleted", { carId: data.carId, lapCount: state.lapCount, lapTimeMs: data.lapTimeMs, cuts: data.cuts });
  }

  get(carId: number): CarState | undefined {
    return this.cars.get(carId);
  }

  getAll(): CarState[] {
    return Array.from(this.cars.values());
  }

  getConnected(): CarState[] {
    return this.getAll().filter((c) => c.connected);
  }
}
