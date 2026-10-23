import * as fs from "fs";
import * as path from "path";
import { CarState } from "../state/stateTracker";

export interface TrackPoint {
  /** Posición en la vuelta, 0..1. Es la clave: ordena el trazado sin depender de por dónde se
   * empezó a muestrear. */
  s: number;
  x: number;
  z: number;
}

export interface TrackOutline {
  track: string;
  points: TrackPoint[];
  /** Caja que contiene al trazado, para escalar el dibujo a cualquier canvas. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Qué porcentaje del circuito se conoce, 0..1. El panel lo usa para avisar "aprendiendo". */
  coverage: number;
}

/**
 * Cuántos tramos tiene la pista. Con 600 muestras un circuito de 5 km queda con un punto cada
 * ~8 metros: suficiente para que la curva se vea suave y lo bastante grueso para que una vuelta
 * de telemetría a 200 ms (unos 180 puntos a velocidad de carrera) complete buena parte del mapa.
 */
const SLOTS = 600;

/** Debajo de esto el trazado se ve como una tira de puntos sueltos y conviene no dibujarlo. */
const MIN_COVERAGE_TO_DRAW = 0.4;

/**
 * Aprende el trazado del circuito solo, mirando por dónde pasan los autos.
 *
 * El protocolo de AC no entrega el dibujo de la pista, y pedirle al admin que consiga los
 * archivos del circuito sería exactamente el tipo de paso técnico que este producto evita.
 * Pero `CAR_UPDATE` ya trae `posX`/`posZ` en coordenadas reales del mundo junto con la posición
 * normalizada en la vuelta: basta con guardar, para cada tramo de la vuelta, dónde estaba el auto.
 *
 * Se indexa por `normalizedSplinePosition` y no por orden de llegada porque así el trazado sale
 * ordenado aunque las muestras lleguen mezcladas de 20 autos repartidos por toda la pista — de
 * hecho, cuantos más autos hay, más rápido se completa.
 *
 * Se aprende una vez por circuito y queda en disco para siempre.
 */
export class TrackLearner {
  private slots: Array<{ x: number; z: number } | null> = new Array(SLOTS).fill(null);
  private track = "";
  private dirty = false;

  constructor(private storageDir: string) {}

  /** Cambio de circuito: se guarda lo aprendido del anterior y se carga lo que ya hubiera del nuevo. */
  setTrack(track: string): void {
    const normalized = normalizeTrackName(track);
    if (normalized === this.track) return;
    this.flush();
    this.track = normalized;
    this.slots = new Array(SLOTS).fill(null);
    this.load();
  }

  onCarUpdate(car: Pick<CarState, "posX" | "posZ" | "normalizedSplinePosition">): void {
    if (!this.track) return;
    // El auto parado en boxes manda posiciones válidas con un spline que no corresponde al
    // trazado; (0,0) es además el valor que llega antes del primer sample real.
    if (car.posX === 0 && car.posZ === 0) return;

    const slot = Math.min(SLOTS - 1, Math.max(0, Math.floor(car.normalizedSplinePosition * SLOTS)));
    if (this.slots[slot]) return; // ya aprendido: el primero que pasa define el tramo
    this.slots[slot] = { x: car.posX, z: car.posZ };
    this.dirty = true;
  }

  getOutline(): TrackOutline | null {
    const points: TrackPoint[] = [];
    for (let i = 0; i < SLOTS; i++) {
      const p = this.slots[i];
      if (p) points.push({ s: i / SLOTS, x: p.x, z: p.z });
    }
    const coverage = points.length / SLOTS;
    if (coverage < MIN_COVERAGE_TO_DRAW) return null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    return { track: this.track, points, bounds: { minX, maxX, minZ, maxZ }, coverage };
  }

  /** Cuánto se conoce, incluso por debajo del mínimo para dibujar — el panel muestra el progreso. */
  getCoverage(): number {
    return this.slots.filter(Boolean).length / SLOTS;
  }

  private file(): string {
    return path.join(this.storageDir, `${this.track}.json`);
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf-8"));
      if (!Array.isArray(raw?.points)) return;
      for (const p of raw.points) {
        if (typeof p?.s !== "number" || typeof p?.x !== "number" || typeof p?.z !== "number") continue;
        const slot = Math.min(SLOTS - 1, Math.max(0, Math.floor(p.s * SLOTS)));
        this.slots[slot] = { x: p.x, z: p.z };
      }
      this.dirty = false;
    } catch {
      // No existe todavía, o quedó corrupto: se vuelve a aprender solo. No es un error que valga
      // la pena mostrarle a nadie.
    }
  }

  /** Persiste lo aprendido. Es idempotente y barato de llamar de más. */
  flush(): void {
    if (!this.dirty || !this.track) return;
    const outline = this.getOutline();
    if (!outline) return; // no guardar medio trazado: la próxima sesión lo completa igual
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(outline), "utf-8");
      this.dirty = false;
    } catch (err) {
      console.error("[track] No se pudo guardar el trazado aprendido:", err);
    }
  }
}

/** El nombre de pista que manda AC puede traer barras (`ks_nordschleife/touristenfahrten`), que
 * no pueden ir en un nombre de archivo. */
function normalizeTrackName(track: string): string {
  return (track || "desconocido").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
}
