import { CarState } from "./stateTracker";

/** Tipos de sesión del protocolo ACSP (`NEW_SESSION.sessionType`). */
export const SESSION_RACE = 3;

type Rankable = Pick<CarState, "carId" | "lapCount" | "normalizedSplinePosition" | "bestLapMs" | "connected">;

/**
 * Orden de clasificación en vivo.
 *
 * En carrera manda el progreso: vueltas completadas y, dentro de la misma vuelta, qué tan avanzado
 * está cada uno en el trazado (`normalizedSplinePosition`). Es el mismo criterio que usa cualquier
 * timing de carrera y no necesita nada que el UDP no entregue ya.
 *
 * En práctica y clasificación manda la mejor vuelta, que es lo único que importa ahí: ordenar por
 * progreso en una tanda libre daría un orden sin ningún significado (lidera el que más vueltas
 * lleva dando, no el más rápido). Quien todavía no marcó tiempo va al fondo, en orden de carId
 * para que la tabla no baile entre refrescos.
 *
 * Función pura sobre un snapshot: no toca `StateTracker` ni depende del reloj.
 */
export function computeStandings(cars: Rankable[], sessionType: number): Map<number, number> {
  const ranked = cars.filter((c) => c.connected).slice();

  if (sessionType === SESSION_RACE) {
    ranked.sort((a, b) => {
      if (b.lapCount !== a.lapCount) return b.lapCount - a.lapCount;
      return b.normalizedSplinePosition - a.normalizedSplinePosition;
    });
  } else {
    ranked.sort((a, b) => {
      const at = a.bestLapMs;
      const bt = b.bestLapMs;
      if (at === null && bt === null) return a.carId - b.carId;
      if (at === null) return 1;
      if (bt === null) return -1;
      if (at !== bt) return at - bt;
      return a.carId - b.carId;
    });
  }

  const positions = new Map<number, number>();
  ranked.forEach((car, index) => positions.set(car.carId, index + 1));
  return positions;
}
