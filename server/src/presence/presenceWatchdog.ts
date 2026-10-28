import { StateTracker } from "../state/stateTracker";

/**
 * Exige que cada piloto conectado tenga la app cliente corriendo (heartbeat), igual que Real Penalty:
 * si no se detecta heartbeat de su driverGuid dentro del período de gracia, se lo kickea.
 *
 * driverGuid en el protocolo ACSP es el SteamID del jugador — la app cliente lo obtiene con
 * `ac.getUserSteamID()` (a confirmar esa firma exacta contra la API real de apps de AC).
 */
export interface PresenceWatchdogOptions {
  /** Se lee en vivo por función: el admin puede subirlo desde el panel a mitad de una sesión. */
  getGraceMs: () => number;
  /** Si es false, no se kickea a nadie por no tener la app — solo se registra quién la tiene. */
  isEnforced: () => boolean;
  /**
   * Único camino por el que sale un kick. Lo provee index.ts con el mismo `dispatchOrSuppress`
   * que usan las sanciones, para que el modo sombra valga también acá.
   *
   * Antes el watchdog llamaba a `udpClient.kick()` directo, sin pasar por el dispatcher ni dejar
   * rastro en el journal: con el modo sombra activado por defecto, la primera carrera de prueba
   * expulsaba a todo piloto sin la app instalada — exactamente lo contrario de lo que el panel
   * promete ("solo registra, no sanciona ni kickea de verdad"), y sin evidencia de qué pasó.
   */
  dispatchKick: (carId: number, driverGuid: string, driverName: string) => void;
  /**
   * Aviso al piloto de que le falta la app, con los segundos que le quedan antes del kick.
   *
   * Hasta la 1.2 el kick salía sin decir nada: el piloto se encontraba de golpe en el menú
   * principal, sin ninguna explicación y en medio de una sesión. Desde la dirección de carrera se
   * veía un `presence.kick` en el journal; desde el auto se veía un juego que te echó.
   *
   * El canal es el chat del servidor y no la pizarra de la app, por lo obvio: el destinatario es
   * justamente quien no tiene la app. Ver el límite documentado en `AVISOS_SEGUNDOS_RESTANTES`.
   */
  warnMissingApp?: (carId: number, driverGuid: string, driverName: string, secondsLeft: number) => void;
  checkIntervalMs?: number;
  /** Reloj inyectable. Existe por los tests: toda la lógica de acá son cuentas regresivas de
   * minutos, y sin esto probarlas significaría dormir esos minutos. */
  now?: () => number;
}

/**
 * En qué momentos de la gracia se avisa, medido en segundos que faltan para el kick.
 *
 * Dos y no uno: el primero llega con tiempo para instalar la app, el segundo es el "última
 * llamada" para quien estaba manejando y no vio el chat pasar. Y dos y no cinco porque cada aviso
 * es una línea en el chat de todos — el chat de AC no tiene mensajes privados reales, el
 * `sendChatToCar` los dirige pero el piloto los lee en el mismo lugar que el resto.
 *
 * Ascendente a propósito: se busca el umbral más chico que todavía cubre lo que queda, así un
 * tick tardío (el watchdog mira cada 5 s) usa el aviso que corresponde y no el anterior.
 *
 * **Límite que conviene tener escrito:** a quien no tiene la app no se le puede dibujar nada
 * dentro del juego — el overlay ES la app. El chat y después el kick son los dos únicos canales
 * que le llegan.
 */
const AVISOS_SEGUNDOS_RESTANTES = [15, 45];

/**
 * Cuánto hace que tiene que haber llegado el último heartbeat para considerar que la app está
 * viva **a los efectos del aviso**.
 *
 * No se usa `isReporting()`, que mide contra la gracia entera, y la razón es que ahí había un
 * agujero: entre que la app se cae y que vence la gracia, `isReporting()` sigue diciendo que sí,
 * así que el aviso nunca salía y al piloto lo agarraba el kick de sorpresa — justo el caso que
 * más importa, porque es el único donde la app ya estaba instalada y el problema se arregla solo
 * volviendo a abrirla.
 *
 * Diez segundos es cinco veces el intervalo del heartbeat (2 s): tolera un par de requests
 * perdidas sin dar por muerta una app que anda bien. Con una gracia más corta que el doble de
 * eso se usa la mitad de la gracia, porque si no no habría margen para avisar nada.
 */
const HEARTBEAT_VIVO_MS = 10_000;

export class PresenceWatchdog {
  private lastHeartbeat = new Map<string, number>();
  private lastPing = new Map<string, number>();
  private connectedSince = new Map<string, number>();
  private checkTimer: NodeJS.Timeout | null = null;
  /** Pilotos ya reportados como ausentes — se limpia al reconectar (ver listener "disconnected"). */
  private kicked = new Set<string>();
  /** Último umbral de `AVISOS_SEGUNDOS_RESTANTES` que se le avisó a cada piloto. */
  private warnedAt = new Map<string, number>();
  private readonly checkIntervalMs: number;
  private readonly now: () => number;

  constructor(private stateTracker: StateTracker, private options: PresenceWatchdogOptions) {
    this.checkIntervalMs = options.checkIntervalMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.stateTracker.on("connected", (car: { carId: number; driverGuid: string }) => {
      this.connectedSince.set(car.driverGuid, this.now());
      this.kicked.delete(car.driverGuid);
      this.warnedAt.delete(car.driverGuid);
    });
    this.stateTracker.on("disconnected", (car: { driverGuid: string }) => {
      this.connectedSince.delete(car.driverGuid);
      this.lastHeartbeat.delete(car.driverGuid);
      this.lastPing.delete(car.driverGuid);
      this.kicked.delete(car.driverGuid);
      this.warnedAt.delete(car.driverGuid);
    });
  }

  start(): void {
    this.checkTimer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
  }

  onHeartbeat(driverGuid: string, pingMs?: number): void {
    this.lastHeartbeat.set(driverGuid, this.now());
    if (pingMs !== undefined) this.lastPing.set(driverGuid, pingMs);
    // Apareció la app: los avisos de "te faltan 45 segundos" se olvidan, así que si más adelante
    // se le vuelve a caer la cuenta regresiva empieza de nuevo en vez de quedar muda.
    this.warnedAt.delete(driverGuid);
  }

  /**
   * Último round-trip medido por la app del piloto contra el backend, en ms.
   *
   * No es el ping del piloto al servidor de AC: el protocolo ACSP no lo expone. Es la latencia de
   * su conexión hacia Race Control, que es lo que sirve para detectar a quién se le corta. El
   * panel lo etiqueta como tal para no prometer de más.
   */
  getPing(driverGuid: string): number | null {
    if (!this.isReporting(driverGuid)) return null;
    return this.lastPing.get(driverGuid) ?? null;
  }

  /** ¿Este piloto tiene la app reportando ahora mismo? Lo usa el panel para mostrar, por piloto,
   * quién está por ser kickeado antes de que pase. */
  isReporting(driverGuid: string): boolean {
    const last = this.lastHeartbeat.get(driverGuid);
    return last !== undefined && this.now() - last <= this.options.getGraceMs();
  }

  /**
   * Cuántos pilotos conectados están reportando. El panel lo contrasta contra el total conectado:
   * "telemetría del servidor OK" y "los pilotos llegan al backend" son dos cosas distintas y
   * pueden fallar por separado — si el puerto de clientes no está abierto, el primero da verde y
   * el segundo cero, y hasta ahora eso era invisible hasta que empezaban los kicks.
   */
  getReportingCount(): { reporting: number; connected: number } {
    const connected = this.stateTracker.getConnected();
    return {
      reporting: connected.filter((car) => this.isReporting(car.driverGuid)).length,
      connected: connected.length,
    };
  }

  private check(): void {
    if (!this.options.isEnforced()) return;
    const now = this.now();
    const graceMs = this.options.getGraceMs();
    for (const car of this.stateTracker.getConnected()) {
      const since = this.connectedSince.get(car.driverGuid);
      if (!since) continue;

      // El reloj corre desde el último de los dos: conectarse, o el último heartbeat que llegó.
      // Son dos situaciones distintas con la misma cuenta regresiva —nunca tuvo la app, o la
      // tenía y se le cayó— y al piloto le quedan los mismos segundos en las dos.
      const last = this.lastHeartbeat.get(car.driverGuid) ?? 0;
      const restanteMs = graceMs - (now - Math.max(since, last));

      if (restanteMs > 0) {
        this.warnIfDue(car, restanteMs);
        continue;
      }

      // Un solo kick por piloto por conexión. En modo sombra el kick se suprime, así que el
      // piloto sigue conectado y esta misma rama volvería a dispararse en cada tick (cada 5s),
      // inundando el journal con el mismo evento durante toda la carrera.
      if (this.kicked.has(car.driverGuid)) continue;
      this.kicked.add(car.driverGuid);
      this.options.dispatchKick(car.carId, car.driverGuid, car.driverName);
    }
  }

  /**
   * Un aviso por umbral y solo hacia abajo.
   *
   * Lo de "solo hacia abajo" es lo que impide el modo de fallo evidente: sin eso, un heartbeat
   * que llega justo y vuelve a cortarse reinicia la cuenta, y el piloto recibe el mismo "te
   * quedan 45 segundos" cada minuto durante toda la carrera. El contador se limpia entero cuando
   * la app aparece de verdad (`onHeartbeat`), que es el único lugar donde volver a avisar tiene
   * sentido.
   */
  private warnIfDue(car: { carId: number; driverGuid: string; driverName: string }, restanteMs: number): void {
    if (!this.options.warnMissingApp) return;

    // La app está viva: no hay nada que avisar. Ver `HEARTBEAT_VIVO_MS` — el umbral es más corto
    // que el de `isReporting()` justamente para que el que la tenía y se le cayó reciba el aviso.
    const last = this.lastHeartbeat.get(car.driverGuid);
    const vivoMs = Math.min(HEARTBEAT_VIVO_MS, this.options.getGraceMs() / 2);
    if (last !== undefined && this.now() - last < vivoMs) return;

    const restanteS = Math.ceil(restanteMs / 1000);
    const umbral = AVISOS_SEGUNDOS_RESTANTES.find((u) => restanteS <= u);
    if (umbral === undefined) return;

    const anterior = this.warnedAt.get(car.driverGuid);
    if (anterior !== undefined && umbral >= anterior) return;
    this.warnedAt.set(car.driverGuid, umbral);
    this.options.warnMissingApp(car.carId, car.driverGuid, car.driverName, restanteS);
  }
}
