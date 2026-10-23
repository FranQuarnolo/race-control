import { SessionInfo } from "../udp/protocol";

/**
 * Las condiciones de la sesión que se corre ahora, tal como las publica el panel.
 *
 * Qué hay y qué no, porque importa no prometer de más:
 *
 * - **Circuito, variante, nombre y tipo de sesión, clima, temperatura de aire y de pista** vienen
 *   del propio servidor en `NEW_SESSION`/`SESSION_INFO`. Son autoritativos y llegan siempre.
 * - **El grip de la pista** no viaja por UDP: solo existe en la Shared Memory del juego, así que
 *   lo reporta la app del piloto. Sin ningún piloto con la app, queda en `null`.
 * - **Viento y hora del juego NO existen en Assetto Corsa.** Son campos de ACC. Ni el UDP ni la
 *   Shared Memory de AC los exponen, así que no se inventa una columna que diría "--" para
 *   siempre. (Custom Shaders Patch los publica por su cuenta, pero eso obligaría a que los 24
 *   pilotos tengan CSP y a seguir una struct de terceros que cambia entre versiones.)
 */
export interface SessionSnapshot {
  track: string;
  trackConfig: string;
  /** Nombre que el admin le puso a la sesión en el server_cfg ("Carrera", "Quali 20'"...). */
  name: string;
  sessionType: number;
  typeLabel: string;
  serverName: string;
  weather: string;
  weatherLabel: string;
  ambientTemp: number;
  roadTemp: number;
  /** Duración declarada. `0` en una sesión por vueltas. */
  durationMinutes: number;
  /** Vueltas declaradas. `0` en una sesión por tiempo. */
  laps: number;
  /** Cuánto falta, en ms. `null` si la sesión es por vueltas o si todavía no sabemos nada. */
  remainingMs: number | null;
  /** Cuánto va corrido, en ms. Negativo durante la cuenta regresiva previa a la largada. */
  elapsedMs: number;
  /** Grip de la pista 0..1, de la app del piloto. `null` si nadie la tiene. */
  surfaceGrip: number | null;
  /** Cuándo llegó el último SESSION_INFO. `0` si nunca llegó uno. */
  updatedAt: number;
}

/** Los tipos que define el protocolo de AC. El 0 ("Booking") no se usa en una liga pero existe. */
const SESSION_TYPE_LABELS: Record<number, string> = {
  0: "Reserva",
  1: "Práctica",
  2: "Clasificación",
  3: "Carrera",
  4: "Hotlap",
  5: "Time attack",
  6: "Deriva",
  7: "Repetición",
};

/**
 * Los `weather_graphics` del contenido base de AC. El valor crudo es el nombre de la carpeta
 * (`3_clear`), que no se le muestra a nadie. Un clima de mod que no esté acá se muestra con su
 * nombre limpiado en vez de caer a "desconocido": el nombre de carpeta de un mod suele ser
 * legible ("sol_heavy_fog"), y es mejor que un hueco.
 */
const WEATHER_LABELS: Record<string, string> = {
  "1_heavy_fog": "Niebla densa",
  "2_light_fog": "Niebla",
  "3_clear": "Despejado",
  "4_mid_clear": "Algo nublado",
  "5_light_clouds": "Nubes dispersas",
  "6_mid_clouds": "Nublado",
  "7_heavy_clouds": "Muy nublado",
};

export function labelForSessionType(type: number): string {
  return SESSION_TYPE_LABELS[type] || "Sesión";
}

export function labelForWeather(raw: string): string {
  if (!raw) return "";
  const known = WEATHER_LABELS[raw.toLowerCase()];
  if (known) return known;
  // "sol_heavy_fog" -> "Sol heavy fog". Se le saca el prefijo numérico que usa el juego.
  const cleaned = raw.replace(/^\d+_/, "").replace(/_/g, " ").trim();
  return cleaned.length > 0 ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "";
}

/**
 * Lleva la cuenta de la sesión en curso.
 *
 * El servidor manda `SESSION_INFO` cuando se le pregunta y `NEW_SESSION` al cambiar de sesión: en
 * el medio pueden pasar 20 minutos sin una sola actualización. Por eso el tiempo restante no se
 * guarda, se **calcula** contra el reloj local a partir del último `elapsedMs` conocido. Si se
 * guardara el número recibido, el panel mostraría "restan 18:42" congelado toda la carrera.
 */
export class SessionTracker {
  private info: SessionInfo | null = null;
  /** `Date.now()` del momento en que llegó `info`, para extrapolar el tiempo corrido. */
  private receivedAt = 0;
  private surfaceGrip: number | null = null;

  constructor(private now: () => number = Date.now) {}

  onSessionInfo(info: SessionInfo): void {
    // Una sesión nueva empieza con el grip que el servidor haya configurado, no con el de la
    // anterior: una clasificación deja la pista mucho más gomada que el arranque de la carrera.
    if (!this.info || this.info.sessionIndex !== info.sessionIndex || this.info.track !== info.track) {
      this.surfaceGrip = null;
    }
    this.info = info;
    this.receivedAt = this.now();
  }

  /** El grip lo reporta la app del piloto. Se queda con el valor más reciente que haya llegado:
   * es una propiedad de la pista, no del auto, así que cualquier piloto sirve de sensor. */
  onSurfaceGrip(grip: number): void {
    if (!Number.isFinite(grip) || grip <= 0 || grip > 1) return;
    this.surfaceGrip = grip;
  }

  get(): SessionSnapshot | null {
    if (!this.info) return null;
    const info = this.info;
    const elapsedMs = info.elapsedMs + (this.now() - this.receivedAt);
    const durationMs = info.timeMinutes * 60_000;
    return {
      track: info.track,
      trackConfig: info.trackConfig,
      name: info.name,
      sessionType: info.sessionType,
      typeLabel: labelForSessionType(info.sessionType),
      serverName: info.serverName,
      weather: info.weatherGraphics,
      weatherLabel: labelForWeather(info.weatherGraphics),
      ambientTemp: info.ambientTemp,
      roadTemp: info.roadTemp,
      durationMinutes: info.timeMinutes,
      laps: info.laps,
      // Una sesión por vueltas no tiene tiempo restante que mostrar, y `0 - elapsed` daría un
      // número negativo creciente que parecería un cronómetro al revés.
      remainingMs: durationMs > 0 ? Math.max(0, durationMs - elapsedMs) : null,
      elapsedMs,
      surfaceGrip: this.surfaceGrip,
      updatedAt: this.receivedAt,
    };
  }
}
