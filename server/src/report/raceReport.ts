import { Incident } from "../incident/incidentEngine";
import { Penalty } from "../penalty/penaltyEngine";
import { SessionSnapshot, labelForSessionType } from "../session/sessionInfo";
import { CarState } from "../state/stateTracker";
import { computeStandings } from "../state/standings";

/**
 * Informe de fin de carrera.
 *
 * Existe porque hasta ahora las penalizaciones de tiempo quedaban solo en el journal y el admin
 * tenía que volcarlas a mano a su planilla, leyendo JSONL. Lo que se entrega acá es lo que no
 * tiene el resultado del servidor de AC: cuántos segundos hay que sumarle a cada piloto, por qué,
 * y qué incidentes se revisaron.
 *
 * **Lo que el informe NO trae, y por qué.** No hay tiempo total de carrera por piloto: el UDP de
 * AC no lo transporta (`LAP_COMPLETED` manda el tiempo de *esa* vuelta y nada más). Por eso la
 * clasificación de acá es por progreso —vueltas y avance en el trazado— y los segundos de
 * penalización van en su propia columna, para sumarlos sobre el resultado oficial del servidor.
 * Inventar un tiempo total acumulando vueltas daría un número parecido al real y distinto, que es
 * la peor clase de dato en un informe que decide un campeonato.
 */

export interface ReportRow {
  position: number | null;
  driverName: string;
  driverGuid: string;
  carModel: string;
  laps: number;
  bestLapMs: number | null;
  /** Suma de las sanciones de tipo TIME que le tocaron, en segundos. */
  timePenaltySeconds: number;
  /** DT/SG/lastre que quedaron sin cumplir al terminar: el admin decide qué hace con ellas. */
  unservedPenalties: number;
  disqualified: boolean;
  /** `false` si se fue antes del final. No lo descalifica: eso lo decide el reglamento. */
  finished: boolean;
}

export interface ReportPenalty {
  engine: string;
  driverName: string;
  type: string;
  timePenaltySeconds: number | null;
  reason: string;
  status: string;
  at: string;
}

export interface ReportIncident {
  kind: string;
  drivers: string;
  lap: number;
  detail: string;
  resolution: string;
  at: string;
}

export interface RaceReport {
  generatedAt: string;
  leagueName: string;
  version: string;
  track: string;
  sessionName: string;
  sessionType: string;
  classification: ReportRow[];
  penalties: ReportPenalty[];
  incidents: ReportIncident[];
}

const ENGINE_LABELS: Record<string, string> = {
  formation: "Largada",
  pit: "Pit lane",
  steward: "Comisario",
};

const PENALTY_TYPE_LABELS: Record<string, string> = {
  DT: "Drive-Through",
  SG: "Stop & Go",
  BALLAST: "Lastre",
  TIME: "Tiempo",
};

const PENALTY_STATUS_LABELS: Record<string, string> = {
  servingWindow: "Sin cumplir",
  served: "Cumplida",
  escalated: "Escalada",
  // Sigue en la lista del informe a propósito: una anulación es una corrección del comisario y
  // tiene que quedar escrita. Lo que no hace es sumar al resultado — ver `cuenta`.
  revoked: "Anulada",
};

/**
 * Las claves son los `IncidentKind` tal cual, y eso importa: lo que no matchea sale crudo en el
 * CSV. Acá decía `disconnect-during-race` —que es el nombre de la *entrada del catálogo*, no el
 * del tipo— así que una desconexión en carrera figuraba como "disconnect" en la planilla que el
 * admin le muestra a su liga. No falla, solo sale feo, que es por donde se escapan estas cosas.
 */
const INCIDENT_LABELS: Record<string, string> = {
  "car-contact": "Toque entre autos",
  "env-collision": "Choque en solitario",
  "track-limits": "Límites de pista",
  "cut-lap": "Vuelta invalidada por irse de pista",
  "wrong-way": "Contramano",
  "telemetry-mismatch": "Telemetría inconsistente",
  disconnect: "Se desconectó en carrera",
  "pit-speeding": "Exceso de velocidad en pit lane",
  "formation-speeding": "Exceso de velocidad en la formación",
};

const INCIDENT_STATUS_LABELS: Record<string, string> = {
  pending: "Sin resolver",
  dismissed: "Descartado",
  warned: "Advertencia",
  penalized: "Sancionado",
};

export interface ReportInput {
  leagueName: string;
  version: string;
  cars: CarState[];
  sessionType: number;
  session: SessionSnapshot | null;
  /** Las sanciones de cada motor, con el nombre con el que se muestran. */
  penaltiesByEngine: Array<[string, Penalty[]]>;
  incidents: Incident[];
  now: number;
}

export function buildReport(input: ReportInput): RaceReport {
  // Se clasifica a TODOS los que pasaron por la sesión, no solo a los conectados: un piloto que
  // abandonó en la vuelta 3 tiene que aparecer en el informe, con sus sanciones. Para calcular
  // posiciones se los marca como conectados, que es lo único que `computeStandings` mira, y
  // después se los ordena al fondo por haberse ido.
  const cars = input.cars.filter((c) => c.driverGuid || c.driverName);
  const standings = computeStandings(
    cars.map((c) => ({ ...c, connected: true })),
    input.sessionType
  );

  const all = input.penaltiesByEngine.flatMap(([engine, list]) => list.map((p) => ({ engine, p })));
  const byGuid = new Map<string, Array<{ engine: string; p: Penalty }>>();
  for (const entry of all) {
    const list = byGuid.get(entry.p.driverGuid) || [];
    list.push(entry);
    byGuid.set(entry.p.driverGuid, list);
  }

  /** Una sanción anulada no pesa en la clasificación. Es la mitad que importa de poder anular: si
   * los segundos se siguieran sumando al resultado, el botón solo cambiaría una etiqueta. */
  const cuenta = (e: { p: Penalty }) => e.p.status !== "revoked";

  const classification: ReportRow[] = cars
    .map((car) => {
      const mine = (byGuid.get(car.driverGuid) || []).filter(cuenta);
      return {
        position: standings.get(car.carId) ?? null,
        driverName: car.driverName,
        driverGuid: car.driverGuid,
        carModel: car.carModel,
        laps: car.lapCount,
        bestLapMs: car.bestLapMs,
        timePenaltySeconds: mine
          .filter((e) => e.p.type === "TIME")
          .reduce((sum, e) => sum + (e.p.timePenaltySeconds || 0), 0),
        unservedPenalties: mine.filter((e) => e.p.status === "servingWindow" && e.p.type !== "TIME").length,
        disqualified: mine.some((e) => e.p.escalatedTo === "DQ"),
        finished: car.connected,
      };
    })
    .sort((a, b) => {
      // Los que se fueron van al fondo: su posición por progreso es real pero engañosa, porque el
      // resto siguió corriendo.
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return (a.position ?? 999) - (b.position ?? 999);
    });

  const penalties: ReportPenalty[] = all
    .slice()
    .sort((a, b) => a.p.createdAt - b.p.createdAt)
    .map(({ engine, p }) => ({
      engine: ENGINE_LABELS[engine] || engine,
      driverName: nameOf(cars, p.driverGuid, p.carId),
      type: PENALTY_TYPE_LABELS[p.type] || p.type,
      timePenaltySeconds: p.type === "TIME" ? p.timePenaltySeconds ?? 0 : null,
      reason: p.reason,
      status: PENALTY_STATUS_LABELS[p.status] || p.status,
      at: new Date(p.createdAt).toISOString(),
    }));

  const incidents: ReportIncident[] = input.incidents
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((i) => ({
      kind: INCIDENT_LABELS[i.kind] || i.kind,
      drivers: i.parties.map((p) => p.driverName).join(" vs "),
      lap: i.lap,
      detail: describe(i),
      resolution: INCIDENT_STATUS_LABELS[i.status] || i.status,
      at: new Date(i.createdAt).toISOString(),
    }));

  return {
    generatedAt: new Date(input.now).toISOString(),
    leagueName: input.leagueName,
    version: input.version,
    track: input.session
      ? [prettyTrack(input.session.track), prettyLayout(input.session.trackConfig)].filter(Boolean).join(" · ")
      : "",
    sessionName: input.session?.name || "",
    sessionType: labelForSessionType(input.sessionType),
    classification,
    penalties,
    incidents,
  };
}

/** `ks_barcelona` → `Barcelona`. El informe lo lee gente, no el juego: el prefijo del autor del
 * contenido no le dice nada a nadie. */
function prettyTrack(track: string): string {
  const cleaned = track.replace(/^(ks_|acu_|rt_|at_|pm_|tcl_|vrc_)/i, "").replace(/[_-]+/g, " ").trim();
  if (!cleaned) return track;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** `layout_gp` → `GP`. Las variantes cortas son siglas (GP, National, Club) y van en mayúscula. */
function prettyLayout(layout: string): string {
  const cleaned = layout.replace(/^layout_/i, "").replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= 4) return cleaned.toUpperCase();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function nameOf(cars: CarState[], driverGuid: string, carId: number): string {
  const byGuid = cars.find((c) => c.driverGuid === driverGuid);
  if (byGuid && byGuid.driverName) return byGuid.driverName;
  const byId = cars.find((c) => c.carId === carId);
  return byId?.driverName || `Auto ${carId}`;
}

function describe(incident: Incident): string {
  const bits: string[] = [];
  if (typeof incident.impactSpeedKmh === "number") bits.push(`impacto a ${Math.round(incident.impactSpeedKmh)} km/h`);
  if (incident.detail) bits.push(incident.detail);
  if (incident.impactCount > 1) bits.push(`${incident.impactCount} impactos`);
  return bits.join("; ");
}

/** mm:ss.mmm, el formato en que un piloto lee un tiempo de vuelta. */
export function formatLap(ms: number | null): string {
  if (ms === null || ms <= 0) return "";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/**
 * CSV con tres bloques separados por una línea en blanco: clasificación, sanciones e incidentes.
 *
 * Tres bloques en un archivo y no tres archivos porque el destinatario es un admin de liga que
 * quiere *un* adjunto para mandar al grupo, y Excel y Google Sheets abren esto sin chistar. El
 * separador es `;` y no `,`: Excel en español interpreta la coma como separador decimal y, con
 * comas, mete todo en una sola columna.
 */
export function toCsv(report: RaceReport): string {
  const lines: string[] = [];
  const row = (...cells: Array<string | number | null>) =>
    lines.push(cells.map((c) => csvCell(c === null ? "" : String(c))).join(";"));

  row(`Race Control ${report.version} — informe de carrera`);
  row("Liga", report.leagueName);
  row("Circuito", report.track);
  // El nombre que el admin le puso a la sesión suele ser el tipo tal cual ("Carrera"): mostrar
  // los dos daría "Carrera · Carrera".
  const sessionLabel = [report.sessionName, report.sessionType]
    .filter(Boolean)
    .filter((v, i, list) => list.indexOf(v) === i)
    .join(" · ");
  row("Sesión", sessionLabel);
  row("Generado", report.generatedAt);
  lines.push("");

  row("CLASIFICACIÓN");
  row("Pos.", "Piloto", "Auto", "Vueltas", "Mejor vuelta", "Penalización (s)", "Sanciones sin cumplir", "Estado");
  for (const r of report.classification) {
    row(
      r.position,
      r.driverName,
      r.carModel,
      r.laps,
      formatLap(r.bestLapMs),
      r.timePenaltySeconds || "",
      r.unservedPenalties || "",
      r.disqualified ? "Descalificado" : r.finished ? "" : "Abandonó"
    );
  }
  lines.push("");

  row("SANCIONES");
  if (!report.penalties.length) row("Sin sanciones.");
  else {
    row("Hora", "Origen", "Piloto", "Tipo", "Segundos", "Estado", "Motivo");
    for (const p of report.penalties) {
      row(p.at, p.engine, p.driverName, p.type, p.timePenaltySeconds ?? "", p.status, p.reason);
    }
  }
  lines.push("");

  row("INCIDENTES");
  if (!report.incidents.length) row("Sin incidentes.");
  else {
    row("Hora", "Tipo", "Pilotos", "Vuelta", "Detalle", "Resolución");
    for (const i of report.incidents) {
      row(i.at, i.kind, i.drivers, i.lap, i.detail, i.resolution);
    }
  }

  // BOM: sin esto Excel abre el archivo en la codificación del sistema y los acentos y la "ñ"
  // salen rotos, que en un informe con nombres de pilotos se nota en la primera fila.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function csvCell(value: string): string {
  // Inyección de fórmulas: Excel y LibreOffice interpretan como fórmula toda celda que arranque
  // con = + - @ (y con tabulador o retorno, que algunos lectores usan igual). Un piloto puede
  // ponerse de nombre `=HYPERLINK(...)` y esa fórmula se ejecuta en la planilla del comisario
  // cuando abre el informe. El apóstrofo inicial es la forma estándar de forzar texto; no se ve
  // en la celda, pero desarma la fórmula.
  const escapado = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (!/[;"\r\n]/.test(escapado)) return escapado;
  return '"' + escapado.replace(/"/g, '""') + '"';
}

/** Nombre de archivo sugerido, sin caracteres que Windows rechace. */
export function reportFileName(report: RaceReport): string {
  const stamp = report.generatedAt.slice(0, 16).replace(/[:T]/g, "-");
  const track = report.track.split(" · ")[0] || "carrera";
  return `informe-${slug(track)}-${stamp}.csv`;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      // Los diacríticos antes que lo no alfanumérico: al revés, la tilde que NFD dejó suelta se
      // convertiría en un guion y "Nürburgring" quedaría "nu-rburgring".
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "carrera"
  );
}
