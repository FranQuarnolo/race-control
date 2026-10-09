import * as fs from "fs";
import * as path from "path";
import { PenaltyRules } from "./penalty/penaltyEngine";
import { PitZone } from "./instances/pitSpeeding";

export interface AppConfig {
  /** Nombre de la liga, solo para mostrar en el panel (wizard de primer arranque). */
  leagueName: string;
  http: {
    /** Panel admin y API de control — SIEMPRE loopback-only, nunca expuesto a internet. */
    adminPort: number;
    /** Endpoints del cliente Python (poll/heartbeat) — este es el que se expone/forwardea. */
    clientPort: number;
  };
  acUdp: { localPort: number; remoteHost: string; remotePort: number };
  /** Única fuente de verdad de las reglas de largada: la usa tanto el detector como la sanción. */
  formation: { penalty: PenaltyRules };
  /** Única fuente de verdad de las reglas de pit lane: el límite de velocidad es el mismo valor
   * que se usa para detectar el exceso y para validar que un Drive-Through se cumplió legal. */
  pit: { zone: PitZone; stopGoSeconds: number; penalty: PenaltyRules };
  /** Si está activo, el motor detecta y registra todo pero NO aplica sanciones/kicks reales. */
  shadowMode: boolean;
}

function resolveConfigDir(): string {
  // Dentro de un ejecutable empaquetado (pkg/@yao-pkg/pkg) el snapshot es de solo lectura —
  // el config tiene que vivir fuera de él. Usamos %APPDATA%\RaceControl (siempre escribible por
  // el usuario actual) en vez de "al lado del .exe": esa carpeta puede ser Descargas o cualquier
  // otra con permisos restringidos por el antivirus/Windows, lo que hacía fallar el guardado en
  // silencio (ej. el wizard de primer arranque nunca cerraba porque el POST fallaba).
  if ((process as unknown as { pkg?: unknown }).pkg) {
    const appData = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
    return path.join(appData, "RaceControl");
  }
  return path.join(__dirname, "..");
}

export function getConfigDir(): string {
  return resolveConfigDir();
}

const CONFIG_PATH = path.join(resolveConfigDir(), "config.json");

function defaultPenalty(): PenaltyRules {
  return {
    speedThresholdKmh: 80,
    toleranceSeconds: 5,
    graceLaps: 3,
    penaltyType: "DT",
    escalation: "DQ",
    ballastKg: 50,
  };
}

function defaultConfig(): AppConfig {
  return {
    leagueName: "",
    http: { adminPort: 3000, clientPort: 3001 },
    acUdp: { localPort: 12000, remoteHost: "127.0.0.1", remotePort: 11000 },
    formation: { penalty: defaultPenalty() },
    pit: { zone: { splineStart: 0.97, splineEnd: 0.995 }, stopGoSeconds: 30, penalty: defaultPenalty() },
    shadowMode: true,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fusiona `patch` dentro de `target`, MUTANDO los objetos anidados existentes en vez de
 * reemplazarlos. Esto es lo que permite que los cambios desde el panel se apliquen en vivo: los
 * motores de sanción guardan una referencia directa a `config.formation.penalty`/`config.pit.penalty`,
 * así que si esos objetos se reemplazan (en vez de mutarse) quedan leyendo una copia vieja.
 */
export function mergeConfigInto(target: Record<string, any>, patch: Record<string, any>): void {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeConfigInto(target[key], value);
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
}

function clampPositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function validatePenalty(rules: PenaltyRules): void {
  rules.speedThresholdKmh = clampPositive(rules.speedThresholdKmh, 80);
  rules.toleranceSeconds = clampPositive(rules.toleranceSeconds, 5);
  rules.graceLaps = clampPositive(rules.graceLaps, 3);
  if (rules.penaltyType !== "DT" && rules.penaltyType !== "SG" && rules.penaltyType !== "BALLAST") {
    rules.penaltyType = "DT";
  }
  if (rules.escalation !== "DQ" && rules.escalation !== "TIME_PENALTY") {
    rules.escalation = "DQ";
  }
}

function validateConfig(config: AppConfig): void {
  validatePenalty(config.formation.penalty);
  validatePenalty(config.pit.penalty);
  config.pit.stopGoSeconds = clampPositive(config.pit.stopGoSeconds, 30);
  if (
    typeof config.pit.zone.splineStart !== "number" ||
    typeof config.pit.zone.splineEnd !== "number" ||
    !Number.isFinite(config.pit.zone.splineStart) ||
    !Number.isFinite(config.pit.zone.splineEnd)
  ) {
    config.pit.zone = { splineStart: 0.97, splineEnd: 0.995 };
  }
  config.shadowMode = typeof config.shadowMode === "boolean" ? config.shadowMode : true;
}

export function loadConfig(): AppConfig {
  const config = defaultConfig();
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      mergeConfigInto(config, raw);
    } catch (err) {
      console.error(`[config] No se pudo leer ${CONFIG_PATH}, uso los valores por defecto:`, err);
    }
  }
  validateConfig(config);
  saveConfig(config);
  return config;
}

export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

/** Aplica un patch parcial (ej. desde POST /api/config) manteniendo vivas las referencias internas. */
export function applyConfigPatch(config: AppConfig, patch: Record<string, unknown>): void {
  mergeConfigInto(config, patch);
  validateConfig(config);
  saveConfig(config);
}

/** "Primera vez" se deriva en vivo del nombre de la liga, no de un snapshot tomado al arrancar
 * el proceso — así, apenas se guarda el nombre, deja de considerarse primera vez en el acto
 * (incluía un bug real: antes quedaba en `true` para siempre durante toda la vida del proceso,
 * aunque el admin ya hubiera completado el wizard, haciendo que el modal volviera a aparecer si
 * se recargaba la página). */
export function isFirstRun(config: AppConfig): boolean {
  return config.leagueName.trim().length === 0;
}
