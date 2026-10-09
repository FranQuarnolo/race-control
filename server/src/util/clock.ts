import { performance } from "perf_hooks";

/**
 * Reloj monotónico inyectable. Evita Date.now() para cronómetros de detección: Date.now()
 * puede saltar hacia atrás (ajuste de NTP) y rompería cronómetros de violación/gracia.
 * También permite acelerar el tiempo en tests y en el modo de simulación/replay.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => performance.now(),
};
