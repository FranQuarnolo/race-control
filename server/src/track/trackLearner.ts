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
  /**
   * Si la pista vuelve a donde empezó.
   *
   * Casi siempre sí, y por eso el default es `true` cuando el campo no está. El caso que obliga a
   * tenerlo es el de las pistas que no son un circuito —una subida de montaña, una ruta punto a
   * punto—: ahí el panel no puede unir el último punto con el primero, porque eso dibujaría una
   * recta cruzando el mapa entero que parece parte del trazado.
   */
  closed?: boolean;
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
 * El trazado del circuito: del catálogo si está, aprendido de la telemetría si no.
 *
 * **Primero el catálogo.** `src/track/catalog/` trae un JSON por circuito, generado con
 * `scripts/build-track-catalog.js` a partir de la línea de la IA que viene adentro de cada pista de
 * Assetto Corsa. Cuando la pista está ahí, el mapa sale dibujado entero desde el primer segundo,
 * con la forma real.
 *
 * **Si no está, se aprende.** Es lo que hacía el producto hasta la 0.7 y sigue siendo la red de
 * contención para las pistas mod que no estén en el catálogo. `CAR_UPDATE` trae `posX`/`posZ` en
 * coordenadas del mundo junto con la posición normalizada en la vuelta, así que alcanza con
 * guardar, para cada tramo, dónde estaba el auto. Se indexa por `normalizedSplinePosition` y no
 * por orden de llegada: así el trazado sale ordenado aunque las muestras lleguen mezcladas de 20
 * autos repartidos por toda la pista.
 *
 * Por qué dejó de ser el camino principal: el aprendizaje necesita que alguien dé vueltas, y hasta
 * que junta el 40% no dibuja nada. Con un solo auto en pista —que es el caso de la primera prueba
 * de cualquier liga, y el de la práctica libre— eso es una tarde entera mirando una barra de
 * progreso. Y lo que aprende es por dónde pasaron los autos, no dónde está la pista: en una curva
 * que todos cortan, el dibujo corta.
 *
 * Lo aprendido queda en disco por liga; el catálogo viaja con la app y es igual para todas.
 */
export class TrackLearner {
  private slots: Array<{ x: number; z: number } | null> = new Array(SLOTS).fill(null);
  private track = "";
  private dirty = false;
  /** Trazado exacto, venido del catálogo. Cuando está, no se aprende ni se guarda nada. */
  private catalogued: TrackOutline | null = null;
  /**
   * Si la pista cierra. Solo puede ser `false` cuando el archivo de la liga lo dice.
   *
   * Lo aprendido no tiene cómo saberlo —aprende tramos sueltos, no la forma— y asume que sí, que
   * es lo correcto para casi toda pista. El caso que esto cubre es el de un trazado generado con
   * el script y dejado a mano en la carpeta de la liga, que es cómo se agrega un circuito nuevo
   * sin esperar a una versión: si el campo se perdiera en ese camino, una subida de montaña se
   * dibujaría cerrada.
   */
  private closed = true;

  constructor(
    private storageDir: string,
    /** Dónde están los JSON del catálogo. Inyectable para que los tests no dependan del empaquetado. */
    private catalogDir: string = path.join(__dirname, "catalog")
  ) {}

  /**
   * Cambio de circuito: se guarda lo aprendido del anterior y se carga lo que haya del nuevo.
   *
   * `config` es la variante del circuito y entra en la clave a propósito. Spa con chicane y sin
   * chicane, o el Nordschleife turístico y el de endurance, son la misma carpeta de pista y dos
   * dibujos distintos. Hasta la 0.7 compartían una sola entrada y el segundo que se corriera
   * quedaba mirando el trazado del primero.
   */
  setTrack(track: string, config = ""): void {
    const normalized = trackKey(track, config);
    if (normalized === this.track) return;
    this.flush();
    this.track = normalized;
    this.slots = new Array(SLOTS).fill(null);
    this.catalogued = null;
    this.closed = true;
    this.loadFromCatalog();
    if (!this.catalogued) this.load();
  }

  onCarUpdate(car: Pick<CarState, "posX" | "posZ" | "normalizedSplinePosition">): void {
    if (!this.track || this.catalogued) return;
    // El auto parado en boxes manda posiciones válidas con un spline que no corresponde al
    // trazado; (0,0) es además el valor que llega antes del primer sample real.
    if (car.posX === 0 && car.posZ === 0) return;

    const slot = Math.min(SLOTS - 1, Math.max(0, Math.floor(car.normalizedSplinePosition * SLOTS)));
    if (this.slots[slot]) return; // ya aprendido: el primero que pasa define el tramo
    this.slots[slot] = { x: car.posX, z: car.posZ };
    this.dirty = true;
  }

  getOutline(): TrackOutline | null {
    if (this.catalogued) return this.catalogued;

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
    return { track: this.track, points, bounds: { minX, maxX, minZ, maxZ }, coverage, closed: this.closed };
  }

  /** Cuánto se conoce, incluso por debajo del mínimo para dibujar — el panel muestra el progreso. */
  getCoverage(): number {
    if (this.catalogued) return 1;
    return this.slots.filter(Boolean).length / SLOTS;
  }

  /** Si el trazado salió del catálogo. El panel lo usa para no prometer un aprendizaje que no va a
   * pasar: con catálogo no hay nada que esperar, y sin catálogo hay que explicar la espera. */
  isCatalogued(): boolean {
    return this.catalogued !== null;
  }

  private file(): string {
    return path.join(this.storageDir, `${this.track}.json`);
  }

  /**
   * Busca la pista en el catálogo empaquetado.
   *
   * Si la pista tiene variante y esa variante no está, se prueba con la pista sola. Es deliberado:
   * un circuito de una sola configuración declarado con variante vacía, o una variante de mod que
   * no llegó al catálogo, son más parecidos al trazado principal que a nada. Lo que no se hace es
   * al revés —usar una variante cualquiera cuando se pidió la pista base— porque ahí sí se elegiría
   * un dibujo entre varios posibles sin ningún criterio.
   */
  private loadFromCatalog(): void {
    const base = this.track.split("__")[0];
    for (const clave of this.track === base ? [base] : [this.track, base]) {
      const outline = readOutline(path.join(this.catalogDir, `${clave}.json`));
      if (outline) {
        this.catalogued = { ...outline, track: this.track, coverage: 1 };
        return;
      }
    }
  }

  private load(): void {
    const outline = readOutline(this.file());
    if (!outline) return; // no existe todavía: se aprende de cero
    this.closed = outline.closed !== false;
    for (const p of outline.points) {
      const slot = Math.min(SLOTS - 1, Math.max(0, Math.floor(p.s * SLOTS)));
      this.slots[slot] = { x: p.x, z: p.z };
    }
    this.dirty = false;
  }

  /** Persiste lo aprendido. Es idempotente y barato de llamar de más. */
  flush(): void {
    // Con catálogo no hay nada aprendido que guardar, y escribirlo igual dejaría una copia en la
    // carpeta de la liga que le ganaría al catálogo si alguna vez se corrige un trazado.
    if (this.catalogued) return;
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

/**
 * La clave con la que se guarda y se busca un trazado: pista y variante, separadas por `__`.
 *
 * El mismo formato que genera `scripts/build-track-catalog.js`; si una de las dos puntas cambia,
 * el catálogo deja de encontrarse y el mapa vuelve a salir vacío sin decir por qué.
 */
function trackKey(track: string, config: string): string {
  const base = normalizeTrackName(track);
  if (!config) return base;
  return `${base}__${normalizeTrackName(config)}`;
}

/**
 * Lee un trazado de disco, o `null` si no está o no es un trazado.
 *
 * Lo comparten el catálogo y lo aprendido porque son el mismo formato a propósito: un JSON
 * generado por el script se puede dejar a mano en la carpeta de una liga y funciona igual.
 */
function readOutline(file: string): TrackOutline | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!Array.isArray(raw?.points) || raw.points.length === 0) return null;
    const points: TrackPoint[] = [];
    for (const p of raw.points) {
      if (typeof p?.s !== "number" || typeof p?.x !== "number" || typeof p?.z !== "number") continue;
      points.push({ s: p.s, x: p.x, z: p.z });
    }
    if (points.length === 0) return null;
    const bounds = raw.bounds;
    if (
      typeof bounds?.minX !== "number" ||
      typeof bounds?.maxX !== "number" ||
      typeof bounds?.minZ !== "number" ||
      typeof bounds?.maxZ !== "number"
    ) {
      return null;
    }
    return {
      track: typeof raw.track === "string" ? raw.track : "",
      points,
      bounds: { minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ },
      coverage: typeof raw.coverage === "number" ? raw.coverage : points.length / SLOTS,
      // Ausente = cerrado. Es lo que vale para todo lo aprendido y para la enorme mayoría de los
      // circuitos; solo el catálogo marca el caso raro, y solo cuando es falso.
      closed: raw.closed !== false,
    };
  } catch {
    // No existe, o quedó corrupto. Ninguna de las dos cosas es un error que valga la pena mostrar:
    // sin catálogo se aprende, y sin lo aprendido se vuelve a aprender.
    return null;
  }
}
