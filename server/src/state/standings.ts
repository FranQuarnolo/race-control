import { CarState } from "./stateTracker";

/** Tipos de sesión del protocolo ACSP (`NEW_SESSION.sessionType`). */
export const SESSION_RACE = 3;

type Rankable = Pick<CarState, "carId" | "lapCount" | "normalizedSplinePosition" | "bestLapMs" | "connected">;

type Gappable = Rankable & Pick<CarState, "lastLapMs">;

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
  const positions = new Map<number, number>();
  rankCars(cars, sessionType).forEach((car, index) => positions.set(car.carId, index + 1));
  return positions;
}

/** El orden de la torre. Está extraído para que las posiciones y los intervalos salgan del mismo
 * criterio: con dos copias del `sort`, tarde o temprano una muestra un gap contra un auto que en
 * la tabla aparece más atrás. */
function rankCars<T extends Rankable>(cars: T[], sessionType: number): T[] {
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
  return ranked;
}

export interface Gap {
  /** Milisegundos hasta el auto de adelante. `null` cuando no se puede estimar o no hay nadie
   * adelante (el líder). */
  aheadMs: number | null;
  /** Milisegundos hasta el líder. `null` por los mismos motivos. */
  leaderMs: number | null;
  /** Vueltas enteras de diferencia con el líder. 0 = va en la misma vuelta. Con 1 o más, los
   * milisegundos dejan de tener sentido y se devuelven en `null`: lo que importa es que está
   * doblado, no por cuántas décimas. */
  lapsDown: number;
}

/**
 * Intervalos de la torre de tiempos.
 *
 * Es el dato que más se mira en cualquier timing de carrera y el único que faltaba: la torre tenía
 * trece columnas y ninguna contestaba "¿a cuánto está del de adelante?". La landing llegó a
 * prometerlo antes de que existiera.
 *
 * **En carrera es una estimación, y conviene saber de qué tipo.** El UDP de Assetto Corsa no manda
 * tiempos de cruce por punto de pista: manda posición en el trazado (`normalizedSplinePosition`) y
 * vueltas completadas. De ahí sale la distancia entre dos autos en fracción de vuelta, y para
 * pasarla a tiempo hace falta un tiempo de vuelta de referencia. Se usa el del auto de atrás —es
 * quien tiene que recorrer esa distancia para alcanzar al de adelante— y se cae a la mejor de la
 * sesión mientras todavía no cerró ninguna.
 *
 * El error de esta estimación es el de suponer ritmo constante: en una frenada fuerte o saliendo de
 * boxes, el número se mueve más de lo que se movieron los autos. Para lo que se usa —¿lo alcanza?,
 * ¿lo tengo encima?— alcanza y sobra, y es lo mismo que hace cualquier torre que no tenga los
 * cruces de sector reales.
 *
 * **En práctica y clasificación no hay nada que estimar**: el intervalo es la resta de las mejores
 * vueltas, que es exactamente lo que ahí significa estar adelante.
 */
export function computeGaps(cars: Gappable[], sessionType: number): Map<number, Gap> {
  const ranked = rankCars(cars, sessionType);
  const gaps = new Map<number, Gap>();
  if (ranked.length === 0) return gaps;

  const sessionBest = ranked.reduce<number | null>(
    (best, c) => (c.bestLapMs !== null && (best === null || c.bestLapMs < best) ? c.bestLapMs : best),
    null
  );

  if (sessionType !== SESSION_RACE) {
    const leaderBest = ranked[0].bestLapMs;
    ranked.forEach((car, index) => {
      const previo = index > 0 ? ranked[index - 1].bestLapMs : null;
      gaps.set(car.carId, {
        aheadMs: car.bestLapMs !== null && previo !== null ? car.bestLapMs - previo : null,
        leaderMs: car.bestLapMs !== null && leaderBest !== null ? car.bestLapMs - leaderBest : null,
        lapsDown: 0,
      });
    });
    return gaps;
  }

  /** Progreso absoluto en la carrera. La suma maneja sola el cruce de meta: el que acaba de pasar
   * tiene vuelta+1 y spline ~0, y el que no llegó tiene vuelta y spline ~0.99, así que la
   * diferencia sigue siendo chica y positiva. */
  const progreso = (car: Gappable) => car.lapCount + car.normalizedSplinePosition;

  /** Cuánto tarda ESTE auto en recorrer una vuelta. Su mejor es mejor referencia que su última
   * —una vuelta con un trompo adentro inflaría el gap— y la de la sesión es el último recurso. */
  const referencia = (car: Gappable) => car.bestLapMs ?? car.lastLapMs ?? sessionBest;

  const lider = ranked[0];
  ranked.forEach((car, index) => {
    const lapsDown = Math.floor(progreso(lider) - progreso(car));
    const ref = referencia(car);

    if (index === 0) {
      gaps.set(car.carId, { aheadMs: null, leaderMs: null, lapsDown: 0 });
      return;
    }
    if (ref === null) {
      // Nadie dio una vuelta todavía: no hay con qué convertir distancia en tiempo. Las primeras
      // curvas de la largada caen acá, y es correcto que la columna diga "--" en vez de inventar.
      gaps.set(car.carId, { aheadMs: null, leaderMs: null, lapsDown });
      return;
    }
    if (lapsDown >= 1) {
      gaps.set(car.carId, { aheadMs: null, leaderMs: null, lapsDown });
      return;
    }
    const previo = ranked[index - 1];
    gaps.set(car.carId, {
      // `max(0, …)` por una ventana real de un par de décimas: el spline vuelve a cero al cruzar la
      // meta y el `LAP_COMPLETED` que incrementa `lapCount` llega por UDP un instante después. En
      // ese hueco el progreso de un auto retrocede casi una vuelta entera, y sin el piso la columna
      // mostraría un intervalo negativo delante de todo el mundo.
      aheadMs: Math.max(0, Math.round((progreso(previo) - progreso(car)) * ref)),
      leaderMs: Math.max(0, Math.round((progreso(lider) - progreso(car)) * ref)),
      lapsDown,
    });
  });

  return gaps;
}
