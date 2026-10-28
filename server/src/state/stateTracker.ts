import { EventEmitter } from "events";
import { CarInfo, CarUpdate, ConnectionClosed, LapCompleted, NewConnection } from "../udp/protocol";

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
  /** Última vuelta cerrada, en ms. `null` hasta que complete la primera. Viene de `LAP_COMPLETED`,
   * que es autoritativo del servidor — no se toma del cliente aunque la app también lo sepa. */
  lastLapMs: number | null;
  /** Mejor vuelta de la sesión, en ms. Se deriva acá y no se pide a nadie. */
  bestLapMs: number | null;
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
    lastLapMs: null,
    bestLapMs: null,
  };
}

/** Una vuelta de AC por debajo de ~15 s no es una vuelta real de ningún circuito: es el servidor
 * cerrando una vuelta parcial al entrar en sesión o al teletransportarse a boxes. Dejarla pasar
 * ensucia la mejor vuelta de forma permanente. */
const MIN_PLAUSIBLE_LAP_MS = 15_000;

/**
 * Techo de filas de la jornada.
 *
 * La torre persiste a todo el que pasó por el servidor en el día, y una jornada larga de liga
 * —práctica abierta a la tarde, clasificación y carrera— puede ver pasar bastante más gente que
 * los veinticuatro de la parrilla. Sin techo, la tabla crece sola hasta no entrar en pantalla, que
 * es exactamente lo que la regla de oro del layout no permite. Al pasarse, se van los
 * desconectados más viejos: son los que menos chance tienen de volver.
 */
const MAX_FILAS_JORNADA = 64;

/** Tabla en memoria de telemetría por auto, alimentada por el UDP client. */
export class StateTracker extends EventEmitter {
  private cars = new Map<number, CarState>();

  /**
   * Pilotos de la jornada que ya no ocupan ningún slot, indexados por `driverGuid`.
   *
   * Hace falta porque `cars` está indexado por `carId`, que es el **slot** de la parrilla y no la
   * persona: el servidor de AC se lo da al primero que entra y se lo vuelve a dar al siguiente en
   * cuanto queda libre. Mientras la torre mostraba solo a los conectados eso no molestaba; al
   * persistir la jornada, el piloto que se desconectaba desaparecía de la tabla en el momento en
   * que otro agarraba su número — que es, encima, el momento en que menos obvio resulta.
   */
  private historial = new Map<string, CarState>();

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
    this.desalojar(state, data.driverGuid);
    state.driverName = data.driverName;
    state.driverGuid = data.driverGuid;
    state.carModel = data.carModel;
    state.connected = true;
    if (!isDuplicateOfCurrentOccupant) state.lapCount = 0;
    this.absorberSlotAnterior(state);
    this.podarJornada();
    this.emit("connected", state);
  }

  /**
   * Un piloto que vuelve a entrar y cae en otro slot es el mismo piloto, no uno nuevo.
   *
   * El servidor de AC reparte los `carId` por slot libre, así que una reconexión suele llegar con
   * un número distinto. Con la torre persistiendo toda la jornada eso dejaba al mismo piloto dos
   * veces en la tabla: una fila gris con sus tiempos y una fila nueva en blanco. Se identifica por
   * `driverGuid` —que es el SteamID y no cambia nunca— y el slot viejo se absorbe.
   *
   * **Se arrastran las vueltas y los tiempos**, no solo los tiempos. Es una decisión discutible:
   * Assetto Corsa no le devuelve las vueltas al que se reconecta, así que la torre puede quedar
   * una vuelta por encima de lo que cree el juego. Se eligió igual porque el caso real es el del
   * piloto al que se le cerró el juego y volvió, y mostrarle cero vueltas en la vuelta 18 lo manda
   * al fondo de la tabla y borra el dato que el comisario necesita. Si alguna vez molesta, lo que
   * hay que sacar es el `Math.max` de abajo: con eso vuelve a arrancar de cero.
   */
  private absorberSlotAnterior(state: CarState): void {
    if (!state.driverGuid) return;
    const previos: CarState[] = [];
    const delHistorial = this.historial.get(state.driverGuid);
    if (delHistorial) previos.push(delHistorial);
    for (const otro of this.cars.values()) {
      // Dos slots conectados con el mismo GUID no debería existir; si pasa, no se toca ninguno.
      if (otro !== state && otro.driverGuid === state.driverGuid && !otro.connected) previos.push(otro);
    }
    for (const previo of previos) {
      state.lapCount = Math.max(state.lapCount, previo.lapCount);
      if (state.lastLapMs === null) state.lastLapMs = previo.lastLapMs;
      if (previo.bestLapMs !== null && (state.bestLapMs === null || previo.bestLapMs < state.bestLapMs)) {
        state.bestLapMs = previo.bestLapMs;
      }
      this.cars.delete(previo.carId);
    }
    this.historial.delete(state.driverGuid);
  }

  /**
   * El slot cambia de dueño: el ocupante anterior se guarda antes de que lo pisen.
   *
   * Es el único momento en que un piloto desconectado perdía su fila. `cars` está indexado por
   * slot, así que escribir el nombre del que entra encima del que se fue lo borraba sin dejar
   * rastro — y el reuso de slot es lo normal, no un caso raro.
   */
  private desalojar(slot: CarState, nuevoGuid: string): void {
    if (!slot.driverGuid || slot.driverGuid === nuevoGuid || slot.connected) return;
    this.historial.set(slot.driverGuid, { ...slot });
  }

  private podarJornada(): void {
    const filas = this.getRoster();
    let sobran = filas.length - MAX_FILAS_JORNADA;
    if (sobran <= 0) return;
    // Se van los que hace más que no están. Al conectado no se lo toca nunca: está corriendo.
    const descartables = filas.filter((c) => !c.connected).sort((a, b) => a.lastUpdate - b.lastUpdate);
    for (const viejo of descartables) {
      if (sobran <= 0) break;
      this.historial.delete(viejo.driverGuid);
      if (this.cars.get(viejo.carId) === viejo) this.cars.delete(viejo.carId);
      sobran--;
    }
  }

  /**
   * Respuesta a una consulta nuestra por un slot de la parrilla, no un evento de la carrera.
   *
   * A diferencia de `onNewConnection`, nunca toca el contador de vueltas: esto llega después de
   * un reinicio del backend, con la carrera ya corriendo, y poner las vueltas en cero sería peor
   * que no saber el nombre. Un slot vacío se ignora en vez de crear un auto fantasma.
   */
  onCarInfo(data: CarInfo): void {
    if (!data.isConnected || data.driverGuid.length === 0) return;
    const state = this.getOrCreate(data.carId);
    const wasConnected = state.connected;
    this.desalojar(state, data.driverGuid);
    state.driverName = data.driverName;
    state.driverGuid = data.driverGuid;
    state.carModel = data.carModel;
    state.connected = true;
    this.absorberSlotAnterior(state);
    this.podarJornada();
    if (!wasConnected) this.emit("connected", state);
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
    if (Number.isFinite(data.lapTimeMs) && data.lapTimeMs >= MIN_PLAUSIBLE_LAP_MS) {
      state.lastLapMs = data.lapTimeMs;
      // Una vuelta con cortes no cuenta como mejor vuelta: es el criterio de cualquier liga, y el
      // dato ya viene del servidor. Sí queda como última vuelta — pasó, y el admin la ve.
      if (data.cuts === 0 && (state.bestLapMs === null || data.lapTimeMs < state.bestLapMs)) {
        state.bestLapMs = data.lapTimeMs;
      }
    }
    this.emit("lapCompleted", { carId: data.carId, lapCount: state.lapCount, lapTimeMs: data.lapTimeMs, cuts: data.cuts });
  }

  /** Arranca una sesión nueva: los tiempos de la anterior no valen más. No se borran los autos
   * —siguen conectados— solo lo que es propio de la sesión que terminó. */
  onNewSession(): void {
    for (const state of [...this.cars.values(), ...this.historial.values()]) {
      state.lapCount = 0;
      state.lastLapMs = null;
      state.bestLapMs = null;
    }
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

  /**
   * Todos los pilotos de la jornada, conectados o no: las filas de la torre de tiempos.
   *
   * Hasta la 1.1 el panel mostraba `getConnected()` y al que se desconectaba se lo tragaba la
   * tierra — junto con sus tiempos, sus vueltas y el único rastro de que había estado ahí. En una
   * liga eso importa: el que se va a los boxes a arreglar el auto, el que crashea el juego y
   * vuelve, y el que abandona son tres cosas distintas, y las tres se veían igual que no haber
   * corrido nunca.
   *
   * Se filtran los slots sin piloto: `onCarUpdate` puede crear una entrada por un `carId` del que
   * todavía no llegó el `NEW_CONNECTION`, y esa fila no tiene a quién mostrar.
   */
  getRoster(): CarState[] {
    const porPiloto = new Map<string, CarState>();
    for (const viejo of this.historial.values()) porPiloto.set(viejo.driverGuid, viejo);
    // El slot vivo pisa al historial: si el piloto volvió a entrar, lo que vale es su fila actual.
    for (const state of this.cars.values()) {
      if (state.driverGuid.length > 0) porPiloto.set(state.driverGuid, state);
    }
    return Array.from(porPiloto.values());
  }
}
