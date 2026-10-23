import { EventEmitter } from "events";
import { WrongWayRule } from "./catalog";
import { CarState, StateTracker } from "../state/stateTracker";
import { Clock, systemClock } from "../util/clock";

/**
 * Dos infracciones que no mandan ningún paquete: nadie avisa que un auto va en contramano ni que
 * un doblado no se corre. Se deducen del propio `CAR_UPDATE`, que ya llega cada 200 ms.
 *
 * Las dos comparten la misma precaución: **sostener la condición en el tiempo antes de afirmar
 * nada**. Un auto puede retroceder un instante al rebotar contra el muro, y un tren de autos en
 * una curva lenta se parece mucho a una retención. Lo que no se parece a nada es la misma
 * condición mantenida varios segundos seguidos.
 */

export interface ObservedFact {
  carId: number;
  driverGuid: string;
  driverName: string;
  lap: number;
  splinePosition: number;
  detail: string;
}

/** Un salto de spline mayor a esto no es movimiento: es el cruce de meta (0.99 → 0.01) o un
 * teletransporte a boxes. En ninguno de los dos casos el auto "retrocedió". */
const JUMP_THRESHOLD = 0.5;

interface WrongWayState {
  lastSpline: number;
  /** Desde cuándo viene retrocediendo sin interrupción, o `null` si va para adelante. */
  since: number | null;
  /** Para no repetir el mismo aviso cada 200 ms mientras sigue en contramano. */
  reported: boolean;
}

export class WrongWayWatcher extends EventEmitter {
  private byCar = new Map<number, WrongWayState>();

  constructor(private rules: WrongWayRule, private clock: Clock = systemClock) {
    super();
  }

  onCarUpdate(car: CarState): void {
    if (this.rules.action === "ignore") return;

    const previous = this.byCar.get(car.carId);
    const spline = car.normalizedSplinePosition;
    if (!previous) {
      this.byCar.set(car.carId, { lastSpline: spline, since: null, reported: false });
      return;
    }

    const delta = spline - previous.lastSpline;
    previous.lastSpline = spline;

    // Retrocede de verdad y lo hace rápido. Ir despacio marcha atrás después de un trompo es la
    // maniobra normal de recuperación, y sancionarla sería castigar a quien se está acomodando.
    const goingBackwards = delta < 0 && delta > -JUMP_THRESHOLD && car.speedKmh >= this.rules.minSpeedKmh;
    if (!goingBackwards) {
      previous.since = null;
      previous.reported = false;
      return;
    }

    const now = this.clock.now();
    if (previous.since === null) {
      previous.since = now;
      return;
    }
    if (previous.reported || now - previous.since < this.rules.minSeconds * 1000) return;

    previous.reported = true;
    this.emit("fact", {
      carId: car.carId,
      driverGuid: car.driverGuid,
      driverName: car.driverName,
      lap: car.lapCount,
      splinePosition: spline,
      detail: `Circuló en contramano durante ${this.rules.minSeconds} segundos o más, a ${Math.round(
        car.speedKmh
      )} km/h`,
    } satisfies ObservedFact);
  }

  reset(): void {
    this.byCar.clear();
  }
}
