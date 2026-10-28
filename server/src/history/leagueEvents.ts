import * as fs from "fs";
import * as path from "path";
import { RaceReport } from "../report/raceReport";

/**
 * Historial de sesiones de una liga: fecha, circuito y el mismo informe que ya arma `buildReport`
 * para la descarga de posiciones finales.
 *
 * Hasta la 1.4 esto no existía en ningún lado: el portal (`portal/store.ts`) guarda usuarios, ligas
 * y membresías, y nada de las carreras que se corrieron. El operador no tenía cómo ver si una liga
 * corría de verdad sin pedirle una captura al admin.
 *
 * Vive adentro del worker (no del portal) y a nivel de archivo, igual que `config.json`: el portal
 * lo lee por el supervisor cuando hace falta, y así el historial sigue existiendo aunque el worker
 * esté parado o la liga se haya desactivado.
 */
export interface LeagueEvent {
  id: string;
  startedAt: number;
  endedAt: number | null;
  status: "en-progreso" | "terminado";
  track: string;
  trackConfig: string;
  sessionType: number;
  sessionTypeLabel: string;
  sessionName: string;
  /** El informe completo —clasificación, sanciones e incidentes—, `null` mientras la sesión sigue
   * en progreso: recién se arma al cerrarla, con `buildReport`. */
  report: RaceReport | null;
}

/**
 * Techo de entradas por liga.
 *
 * Mismo criterio que el techo de la torre de tiempos (`MAX_FILAS_JORNADA` en `stateTracker.ts`):
 * una liga que corre meses sin que nadie la borre no puede acumular `events.json` para siempre. Se
 * va la más vieja, que es la que menos le importa a un operador mirando qué pasó esta semana.
 */
const MAX_EVENTS = 200;

function leerArchivo(filePath: string): LeagueEvent[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    // Un events.json corrupto no puede tirar abajo el arranque de la liga: se arranca de cero.
    return [];
  }
}

export class LeagueEventsStore {
  private events: LeagueEvent[];
  private current: LeagueEvent | null = null;
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "events.json");
    this.events = leerArchivo(this.filePath);
  }

  /**
   * Si el worker murió a mitad de una sesión (caída, redeploy), esa entrada quedó "en progreso"
   * para siempre: nadie más la va a cerrar, porque el `NEW_SESSION` que la habría cerrado ya pasó
   * en la vida anterior del proceso. La llama `raceControl` una vez, al arrancar.
   *
   * Es un método aparte y no parte del constructor a propósito: el portal arma una instancia de
   * esta clase solo para leer o borrar desde `/api/operador`, sin que la liga esté corriendo, y una
   * recuperación automática en el constructor marcaría como "terminada" una sesión que en realidad
   * sigue en curso en el worker — que es justo el estado que esta misma clase existe para mostrar
   * bien.
   */
  recoverStaleInProgress(): void {
    const abierta = this.events.find((e) => e.status === "en-progreso");
    if (!abierta) return;
    abierta.status = "terminado";
    abierta.endedAt = abierta.endedAt ?? Date.now();
    this.persist();
  }

  /** Desde cuándo filtrar lo que le corresponde a la sesión en curso (el `IncidentEngine` no se
   * resetea entre sesiones, así que hay que recortar por fecha). `null` si no hay ninguna abierta. */
  currentStartedAt(): number | null {
    return this.current ? this.current.startedAt : null;
  }

  startSession(meta: {
    track: string;
    trackConfig: string;
    sessionType: number;
    sessionTypeLabel: string;
    sessionName: string;
  }): void {
    this.current = {
      id: `E${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      startedAt: Date.now(),
      endedAt: null,
      status: "en-progreso",
      report: null,
      ...meta,
    };
    this.events.unshift(this.current);
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
    this.persist();
  }

  /** Cierra la sesión en curso con su informe ya armado. No hace nada si no hay ninguna abierta —
   * pasa en el primer `END_SESSION` de un worker que arrancó con la carrera ya terminada. */
  closeCurrent(report: RaceReport | null): void {
    if (!this.current) return;
    this.current.status = "terminado";
    this.current.endedAt = Date.now();
    this.current.report = report;
    this.current = null;
    this.persist();
  }

  list(): LeagueEvent[] {
    return this.events;
  }

  /** `false` si el id no existe o es el de una sesión en curso: esa todavía no tiene informe para
   * mostrar, y el worker la va a seguir escribiendo — borrarla acá la haría reaparecer sola apenas
   * termine. Se mira el `status` de la propia entrada y no `this.current`, porque quien borra suele
   * ser el portal, con una instancia que nunca vio el `startSession` del worker. */
  remove(id: string): boolean {
    const idx = this.events.findIndex((e) => e.id === id);
    if (idx === -1 || this.events[idx].status === "en-progreso") return false;
    this.events.splice(idx, 1);
    this.persist();
    return true;
  }

  private persist(): void {
    // Mismo seguro que `config.ts` y `portal/store.ts`: la carpeta de datos de la liga la crea el
    // supervisor al arrancar el worker, pero no hay garantía de que ya exista la primera vez que
    // alguien escribe acá.
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.events, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath);
  }
}
