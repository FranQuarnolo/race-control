import * as fs from "fs";
import * as path from "path";
import { Incident } from "../incident/incidentEngine";
import { Penalty } from "../penalty/penaltyEngine";

/**
 * Reconstrucción de la carrera tras un reinicio del backend.
 *
 * Hasta ahora las sanciones y los incidentes vivían solo en memoria: si el proceso se caía o el
 * admin cerraba la ventana negra sin querer a mitad de carrera, se perdía todo lo que había
 * pasado — y lo que el piloto ya había recibido por chat seguía siendo cierto para él. El journal
 * JSONL ya registraba todo, pero en forma de líneas de auditoría pensadas para que las lea una
 * persona: no alcanzaban para volver a armar los objetos (no llevan el id, ni las vueltas de
 * gracia que quedaban, ni el estado).
 *
 * La solución es un segundo tipo de línea en el MISMO archivo: `penalty.state` e `incident.state`,
 * que llevan el objeto entero cada vez que cambia. Así el journal sigue siendo una única fuente
 * append-only —auditable y reconstruible— en vez de abrir un formato de persistencia paralelo que
 * se puede desincronizar del registro.
 *
 * Lo que NO se restaura, a propósito:
 * - Posiciones, velocidades y vueltas: el servidor las vuelve a mandar en segundos, y una copia
 *   vieja sería peor que no tener nada.
 * - Carreras de hace rato: ver `MAX_AGE_MS`.
 */

/** Más allá de esto, lo que haya en el journal es de otra carrera, no de la que se interrumpió.
 * Una carrera de liga rara vez pasa de las 2 h, y un reinicio se hace en minutos. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface RestoredState {
  /** Sanciones por motor, con la misma etiqueta con que se registraron ("formation" | "pit"). */
  penalties: Map<string, Penalty[]>;
  incidents: Incident[];
  /** Cuándo se escribió la última línea de la sesión que se está restaurando. */
  interruptedAt: number;
  sourceFile: string;
}

interface StateLine {
  type?: string;
  tWall?: string;
  engine?: string;
  penalty?: Penalty;
  incident?: Incident;
}

/**
 * Busca la última sesión interrumpida y devuelve su estado, o `null` si no hay nada que restaurar.
 *
 * `excludeFile` es el archivo que acaba de abrir este proceso: sin excluirlo, al arrancar se leería
 * a sí mismo (vacío) y nunca se restauraría nada.
 */
export function restoreState(
  logDir: string,
  options: { excludeFile?: string; now?: number; maxAgeMs?: number } = {}
): RestoredState | null {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  const file = findPreviousJournal(logDir, options.excludeFile);
  if (!file) return null;

  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    // Un journal ilegible no puede impedir que Race Control arranque: se sigue sin restaurar.
    return null;
  }

  // Por id, para quedarnos con la última versión de cada objeto. Un Map preserva el orden de
  // inserción, así que el orden original de los incidentes se conserva aunque se hayan reescrito.
  const penalties = new Map<string, { engine: string; penalty: Penalty }>();
  const incidents = new Map<string, Incident>();
  let lastAt = 0;

  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    let entry: StateLine;
    try {
      entry = JSON.parse(line) as StateLine;
    } catch {
      // Última línea cortada por un cierre abrupto: es el caso normal de un journal interrumpido.
      continue;
    }
    const at = entry.tWall ? Date.parse(entry.tWall) : NaN;
    if (Number.isFinite(at)) lastAt = Math.max(lastAt, at);

    // Una sesión nueva invalida todo lo anterior: las sanciones de la clasificación no se arrastran
    // a la carrera. Es la misma regla que aplica el motor en vivo al recibir NEW_SESSION.
    if (entry.type === "ac.newSession") {
      penalties.clear();
      incidents.clear();
      continue;
    }
    if (entry.type === "penalty.state" && isPenalty(entry.penalty)) {
      penalties.set(entry.penalty.id, { engine: entry.engine || "pit", penalty: entry.penalty });
    } else if (entry.type === "incident.state" && isIncident(entry.incident)) {
      incidents.set(entry.incident.id, entry.incident);
    }
  }

  if (penalties.size === 0 && incidents.size === 0) return null;
  if (lastAt > 0 && now - lastAt > maxAgeMs) return null;

  const byEngine = new Map<string, Penalty[]>();
  for (const { engine, penalty } of penalties.values()) {
    const list = byEngine.get(engine) || [];
    list.push(penalty);
    byEngine.set(engine, list);
  }

  return { penalties: byEngine, incidents: [...incidents.values()], interruptedAt: lastAt, sourceFile: file };
}

/** El journal anterior a este arranque: el más reciente por nombre, que lleva la marca de tiempo
 * ISO del momento en que se creó y por eso ordena cronológicamente como texto. */
function findPreviousJournal(logDir: string, excludeFile?: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
    .map((name) => path.join(logDir, name))
    .filter((full) => full !== excludeFile)
    .sort();
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/**
 * Guardas mínimas antes de aceptar un objeto que vino de un archivo editable a mano.
 *
 * No se valida campo por campo a propósito: lo que importa es que exista la identidad y el estado
 * que mueven la máquina. Un valor raro en un campo descriptivo ensucia el informe; un `id`
 * faltante rompería la restauración entera.
 */
function isPenalty(value: unknown): value is Penalty {
  const p = value as Penalty | undefined;
  return (
    !!p &&
    typeof p.id === "string" &&
    typeof p.carId === "number" &&
    typeof p.driverGuid === "string" &&
    (p.status === "servingWindow" || p.status === "served" || p.status === "escalated")
  );
}

function isIncident(value: unknown): value is Incident {
  const i = value as Incident | undefined;
  return (
    !!i &&
    typeof i.id === "string" &&
    typeof i.kind === "string" &&
    Array.isArray(i.parties) &&
    (i.status === "pending" || i.status === "dismissed" || i.status === "warned" || i.status === "penalized")
  );
}
