import * as fs from "fs";
import * as path from "path";

export interface PitZoneSample {
  splineStart: number;
  splineEnd: number;
}

/** Margen a cada lado de lo observado: el punto exacto en que `inPitLane` cambia de estado no cae
 * siempre en el mismo metro del circuito, vuelta a vuelta ni piloto a piloto. */
const MARGIN = 0.003;

/** Un pit lane que cruza la línea de meta daría un rango que tapa casi toda la vuelta — no es una
 * zona de pit, es un aprendizaje roto. Se descarta antes de llegar a eso. */
const MAX_SPAN = 0.5;

/**
 * Aprende la zona de pit lane de un circuito observando a los pilotos que ya tienen la app
 * instalada: su propia Shared Memory sabe si están en el pit lane (`DriverTelemetry.inPitLane`),
 * así que basta con mirar en qué posición de la vuelta están cuando eso es cierto.
 *
 * Es la contraparte de `TrackLearner`, pero para el pit lane en vez del trazado: mismo criterio de
 * "lo aprendido se guarda por liga, no en el catálogo", porque el catálogo no tiene este dato y
 * poblarlo para 198 circuitos a mano —con mods incluidos— no es viable. La calibración manual de
 * Reglas queda como lo que corrige esto cuando hace falta, no como el único camino.
 *
 * **Qué no soporta:** un pit lane que cruza la línea de meta (entrada cerca de 0.99, salida cerca
 * de 0.02). La zona manual ya asume `start < end` en todo el resto del código — `inZone()`
 * (pitSpeeding.ts) el primero — así que aprender un wraparound solo produciría un número que rompe
 * esa cuenta en silencio. Se detecta y se descarta la muestra para ese circuito en vez de sugerir
 * algo que después no se puede usar.
 */
export class PitZoneLearner {
  private byTrack = new Map<string, { min: number; max: number }>();

  constructor(private readonly storageDir: string) {
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  /** Una muestra: un piloto reportó `inPitLane: true` en esta posición de la vuelta. */
  observe(trackKey: string, splinePosition: number): void {
    if (!trackKey || !Number.isFinite(splinePosition) || splinePosition < 0 || splinePosition > 1) return;

    let acc = this.byTrack.get(trackKey);
    if (!acc) {
      acc = this.load(trackKey) ?? { min: splinePosition, max: splinePosition };
      this.byTrack.set(trackKey, acc);
    }
    const prevMin = acc.min;
    const prevMax = acc.max;
    acc.min = Math.min(acc.min, splinePosition);
    acc.max = Math.max(acc.max, splinePosition);

    if (acc.max - acc.min > MAX_SPAN) {
      this.byTrack.delete(trackKey);
      fs.rmSync(this.file(trackKey), { force: true });
      return;
    }
    if (acc.min !== prevMin || acc.max !== prevMax) this.save(trackKey, acc);
  }

  /** `null` si todavía no hay ninguna muestra de este circuito — ni en memoria ni en disco. */
  suggestionFor(trackKey: string): PitZoneSample | null {
    const acc = this.byTrack.get(trackKey) ?? this.load(trackKey);
    if (!acc) return null;
    return {
      splineStart: Math.max(0, acc.min - MARGIN),
      splineEnd: Math.min(1, acc.max + MARGIN),
    };
  }

  private file(trackKey: string): string {
    return path.join(this.storageDir, `pit-${trackKey}.json`);
  }

  private load(trackKey: string): { min: number; max: number } | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(trackKey), "utf8"));
      if (typeof data.min === "number" && typeof data.max === "number") return data;
    } catch {
      // Sin archivo todavía, o corrupto: se aprende de cero, no es un error que frene nada.
    }
    return null;
  }

  private save(trackKey: string, acc: { min: number; max: number }): void {
    fs.writeFileSync(this.file(trackKey), JSON.stringify(acc));
  }
}
