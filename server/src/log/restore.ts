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
 * - Lo de antes de una sesión nueva (`ac.newSession`) o de "Terminar evento" (`evento.terminar`):
 *   esas dos cosas son las que vacían el panel en vivo, y un reinicio no puede deshacerlas.
 *
 * Hasta la 1.48 había además un límite de 6 h: más viejo que eso se daba por "otra carrera". Pero
 * lo que reportó el usuario fue justamente lo contrario: corría la carrera, a la noche o al día
 * siguiente se hacía un deploy, y el panel aparecía vacío sin que nadie hubiera terminado el
 * evento. Desde la 1.49 la última carrera queda a la vista hasta que la vacíe una de las dos
 * acciones de arriba, como pasaría sin reinicio de por medio. `maxAgeMs` sigue existiendo como
 * opción por si alguna vez hace falta volver a acotarlo.
 */

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
  const maxAgeMs = options.maxAgeMs ?? Infinity;

  // Del más nuevo al más viejo. Un journal sin nada que restaurar y sin marca de corte es el de un
  // arranque en el que no pasó nada (por ejemplo, dos deploys seguidos): hasta la 1.48 se miraba
  // solo el anterior, y el segundo reinicio encontraba ese journal vacío y perdía la carrera.
  for (const file of previousJournals(logDir, options.excludeFile)) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      // Un journal ilegible no puede impedir que Race Control arranque: se prueba con el anterior.
      continue;
    }
    const leido = leerJournal(content);
    if (leido.penalties.size === 0 && leido.incidents.size === 0) {
      // Vacío después de un corte: la carrera se terminó a propósito, no hay nada que traer.
      if (leido.huboCorte) return null;
      continue;
    }
    if (leido.lastAt > 0 && now - leido.lastAt > maxAgeMs) return null;

    const byEngine = new Map<string, Penalty[]>();
    for (const { engine, penalty } of leido.penalties.values()) {
      const list = byEngine.get(engine) || [];
      list.push(penalty);
      byEngine.set(engine, list);
    }
    return {
      penalties: byEngine,
      incidents: [...leido.incidents.values()],
      interruptedAt: leido.lastAt,
      sourceFile: file,
    };
  }
  return null;
}

function leerJournal(content: string): {
  penalties: Map<string, { engine: string; penalty: Penalty }>;
  incidents: Map<string, Incident>;
  lastAt: number;
  huboCorte: boolean;
} {

  // Por id, para quedarnos con la última versión de cada objeto. Un Map preserva el orden de
  // inserción, así que el orden original de los incidentes se conserva aunque se hayan reescrito.
  const penalties = new Map<string, { engine: string; penalty: Penalty }>();
  const incidents = new Map<string, Incident>();
  let lastAt = 0;
  let huboCorte = false;

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
    if (entry.type === "ac.newSession" || entry.type === "evento.terminar") {
      penalties.clear();
      incidents.clear();
      huboCorte = true;
      continue;
    }
    if (entry.type === "penalty.state" && isPenalty(entry.penalty)) {
      penalties.set(entry.penalty.id, { engine: entry.engine || "pit", penalty: entry.penalty });
    } else if (entry.type === "incident.state" && isIncident(entry.incident)) {
      incidents.set(entry.incident.id, entry.incident);
    }
  }

  return { penalties, incidents, lastAt, huboCorte };
}

/** Los journals anteriores a este arranque, del más reciente al más viejo. El nombre lleva la
 * marca de tiempo ISO del momento en que se creó y por eso ordena cronológicamente como texto. */
function previousJournals(logDir: string, excludeFile?: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
    .map((name) => path.join(logDir, name))
    .filter((full) => full !== excludeFile)
    .sort()
    .reverse();
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
    // `revoked` tiene que estar en esta lista o pasa lo peor que podría pasar: la sanción anulada
    // se descarta al restaurar y la última línea válida que queda es la de antes de anularla, así
    // que un reinicio del worker resucita una sanción que el comisario ya había dado de baja.
    (p.status === "servingWindow" || p.status === "served" || p.status === "escalated" || p.status === "revoked")
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
