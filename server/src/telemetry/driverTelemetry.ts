/**
 * Telemetría fina que reporta la app del piloto desde la Shared Memory del juego.
 *
 * Existe porque el protocolo UDP de AC **no transporta** nada de esto: `LAP_COMPLETED` trae el
 * tiempo total de la vuelta y los cortes, y se acabó. Tiempos por sector, compuesto, combustible
 * y paradas en boxes solo existen dentro del proceso del juego, en la PC de cada piloto.
 *
 * Consecuencia asumida: un piloto sin la app aparece en la torre de tiempos con todo lo
 * autoritativo (posición, velocidad, vueltas, tiempos de vuelta) y guiones en estas columnas.
 * No hay forma de taparlo desde el servidor, y fingir el dato sería peor que no tenerlo.
 *
 * Se indexa por `driverGuid` y no por `carId` porque el cliente solo conoce su propio SteamID: el
 * carId lo asigna el servidor de AC y puede cambiar en una reconexión.
 */

export interface DriverTelemetry {
  /** Tiempos por sector de la última vuelta cerrada, en ms. Posiciones sin dato quedan en `null`. */
  sectors: (number | null)[];
  /** Sector en el que está dando la vuelta ahora (0-based), o `null` si no se sabe. */
  currentSector: number | null;
  /** Nombre del compuesto tal como lo reporta el juego ("Soft", "Hypercar Hard", etc.). */
  tyreCompound: string | null;
  /** Litros restantes. */
  fuelLiters: number | null;
  /** Paradas en boxes completadas, contadas por el cliente. */
  pitStops: number | null;
  /** Está en el pit lane en este momento. */
  inPitLane: boolean;
  /** Ruedas fuera de pista ahora mismo (0..4). Base de los límites de pista de la Fase 2. */
  tyresOut: number | null;
  /**
   * Grip de la pista, 0..1. A diferencia de todo lo demás de esta interfaz, NO es una propiedad
   * del piloto sino del circuito: se reporta por este canal solo porque es el único que lo ve.
   * Lo consume `SessionTracker`, que lo muestra una vez en la banda del mapa en vez de repetirlo
   * en cada fila de la torre.
   */
  surfaceGrip: number | null;
  receivedAt: number;
}

/** Más viejo que esto y el dato deja de mostrarse: el cliente reporta cada 2 s, así que este
 * margen tolera varios fallos seguidos antes de blanquear la fila. Mostrar combustible de hace
 * un minuto es peor que no mostrar nada. */
const STALE_MS = 15_000;

export class DriverTelemetryStore {
  private byGuid = new Map<string, DriverTelemetry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  report(driverGuid: string, raw: unknown): void {
    if (!driverGuid || typeof raw !== "object" || raw === null) return;
    const body = raw as Record<string, unknown>;
    this.byGuid.set(driverGuid, {
      sectors: sanitizeSectors(body.sectors),
      currentSector: intIn(body.currentSector, 0, 9),
      tyreCompound: shortText(body.tyreCompound),
      fuelLiters: numberIn(body.fuelLiters, 0, 500),
      pitStops: intIn(body.pitStops, 0, 999),
      inPitLane: body.inPitLane === true,
      tyresOut: intIn(body.tyresOut, 0, 4),
      surfaceGrip: numberIn(body.surfaceGrip, 0, 1),
      receivedAt: this.now(),
    });
  }

  get(driverGuid: string): DriverTelemetry | null {
    const entry = this.byGuid.get(driverGuid);
    if (!entry) return null;
    if (this.now() - entry.receivedAt > STALE_MS) return null;
    return entry;
  }

  forget(driverGuid: string): void {
    this.byGuid.delete(driverGuid);
  }
}

/**
 * Todo lo de abajo valida valores que llegan de un `.py` en texto plano en la PC del piloto, o
 * sea editable. No se trata de impedir trampa —para eso está la validación cruzada contra el
 * servidor de la Fase 2.3— sino de que un valor roto no ensucie el panel ni rompa el render.
 */

function numberIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

function intIn(value: unknown, min: number, max: number): number | null {
  const n = numberIn(value, min, max);
  return n === null ? null : Math.round(n);
}

function shortText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 32);
}

function sanitizeSectors(value: unknown): (number | null)[] {
  if (!Array.isArray(value)) return [];
  // Tope de sectores: ningún circuito de AC define más de 3, y el array viene de afuera.
  return value.slice(0, 3).map((v) => numberIn(v, 1000, 600_000));
}
