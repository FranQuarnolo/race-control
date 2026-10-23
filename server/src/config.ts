import * as fs from "fs";
import * as path from "path";
import { PenaltyRules } from "./penalty/penaltyEngine";
import { PitZone } from "./instances/pitSpeeding";
import {
  AUTO_PENALTY_ALLOWED,
  InfractionAction,
  InfractionCatalog,
  InfractionType,
  PRESETS,
  PresetName,
  defaultInfractions,
} from "./incident/catalog";

export interface AppConfig {
  /** Nombre de la liga, solo para mostrar en el panel (wizard de primer arranque). */
  leagueName: string;
  http: {
    /** Panel admin y API de control — SIEMPRE loopback-only, nunca expuesto a internet. */
    adminPort: number;
    /** Endpoints del cliente Python (poll/heartbeat) — este es el que se expone/forwardea. */
    clientPort: number;
    /** Dirección por la que los pilotos y el servidor de AC llegan hasta acá. Vacío = se detecta
     * sola. Solo hace falta completarla si la detección falla (sin internet, o una red que bloquea
     * la consulta): sin esto, el backend anunciaba `127.0.0.1` y ningún piloto podía conectarse,
     * sin que nada en el panel dijera que algo salió mal. */
    publicHost: string;
  };
  acUdp: {
    localPort: number;
    remoteHost: string;
    remotePort: number;
    /** De dónde salió `remotePort`, igual que `publicHostSource` para la dirección.
     *
     * `"default"` es el valor de fábrica que nadie confirmó: el puerto se adopta del primer
     * datagrama que manda el servidor. `"detected"` es un valor ya adoptado así. `"manual"` es un
     * número que el admin escribió en el panel, y ese no se pisa nunca.
     *
     * Existe para que nadie tenga que buscar el "Listen Address" en el panel de su hosting: es el
     * dato más difícil de encontrar de toda la puesta en marcha, cambia de nombre según la versión
     * del panel, y el servidor lo dice solo con cada paquete que manda. */
    remotePortSource: "default" | "manual" | "detected";
  };
  /** Única fuente de verdad de las reglas de largada: la usa tanto el detector como la sanción. */
  formation: { penalty: PenaltyRules };
  /** Única fuente de verdad de las reglas de pit lane: el límite de velocidad es el mismo valor
   * que se usa para detectar el exceso y para validar que un Drive-Through se cumplió legal. */
  pit: { zone: PitZone; stopGoSeconds: number; penalty: PenaltyRules };
  /** Cuánto se espera el heartbeat de la app del piloto antes de kickearlo por no tenerla.
   * Tiene que ser holgadamente mayor que la ventana de auto-discovery (announcer.ts: 5 × 4s),
   * si no un piloto que activa la app después de entrar al servidor es expulsado antes de poder
   * recibir la dirección del backend. */
  presence: { graceSeconds: number; enforce: boolean };
  /** Catálogo de infracciones: qué se controla y qué se hace con cada cosa. Reemplaza a los
   * bloques `incidents` y `trackLimits` de versiones anteriores (ver migrateLegacyRules). */
  infractions: InfractionCatalog;
  /** Preset de torneo elegido en el wizard. Solo informativo: tocar cualquier regla a mano no lo
   * invalida, porque el preset es un punto de partida y no un candado. */
  preset: PresetName | "";
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
    http: { adminPort: 3000, clientPort: 3001, publicHost: "" },
    acUdp: { localPort: 12000, remoteHost: "127.0.0.1", remotePort: 11000, remotePortSource: "default" },
    formation: { penalty: defaultPenalty() },
    pit: { zone: { splineStart: 0.97, splineEnd: 0.995 }, stopGoSeconds: 30, penalty: defaultPenalty() },
    presence: { graceSeconds: 60, enforce: true },
    // 30 km/h de impacto deja afuera los roces de parrilla y los pianos, que si no inundan la
    // bandeja en la primera vuelta. Los choques en solitario arrancan con un umbral más alto:
    // un toque leve contra el muro es un error del piloto, no un incidente para revisar.
    infractions: defaultInfractions(),
    preset: "",
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

/** Como `clampPositive` pero con techo y aceptando el cero (hay umbrales donde 0 significa
 * "sin tolerancia", que es un valor legítimo y no un campo vacío). */
function clampIntIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return rounded < min || rounded > max ? fallback : rounded;
}

/** El piso es 1024 y no 1: por debajo de eso los puertos están reservados por el sistema y hacen
 * falta permisos de administrador en la mayoría de los entornos. Un admin que escriba 80 en el
 * panel no vería un error, vería una app que la próxima vez no abre. */
function clampPort(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535
    ? value
    : fallback;
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

/** Acepta IPv4/IPv6/hostname a ojo. No resuelve DNS: es validación de forma, para que un campo
 * vacío o con espacios desde el panel no deje al backend mandando comandos a la nada. */
function isPlausibleHost(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/\s/.test(value);
}

function validateAction(value: unknown, type: InfractionType, fallback: InfractionAction): InfractionAction {
  const valid: InfractionAction[] = ["ignore", "log", "review", "penalty"];
  if (typeof value !== "string" || !valid.includes(value as InfractionAction)) return fallback;
  const action = value as InfractionAction;
  // "Sancionar solo" solo se acepta donde el hecho es objetivo. En un toque el servidor sabe que
  // hubo contacto, no quién tuvo la culpa: se degrada a revisión en vez de sancionar a ciegas.
  if (action === "penalty" && !AUTO_PENALTY_ALLOWED.has(type)) return "review";
  return action;
}

function validateInfractions(rules: InfractionCatalog): void {
  const defaults = defaultInfractions();
  for (const key of Object.keys(defaults) as InfractionType[]) {
    if (!isPlainObject(rules[key])) (rules as unknown as Record<string, unknown>)[key] = defaults[key];
  }

  rules.carContact.action = validateAction(rules.carContact.action, "carContact", "review");
  rules.carContact.minImpactKmh = clampPositive(rules.carContact.minImpactKmh, 30);
  rules.envCollision.action = validateAction(rules.envCollision.action, "envCollision", "review");
  rules.envCollision.minImpactKmh = clampPositive(rules.envCollision.minImpactKmh, 60);

  const tl = rules.trackLimits;
  tl.action = validateAction(tl.action, "trackLimits", "review");
  // Solo 2 o 4: son los dos criterios que existen en reglamentos reales. Un valor intermedio no
  // significa nada (ningún auto apoya 3 ruedas afuera de forma estable) y dejaría el selector del
  // panel en blanco, que es peor que corregirlo acá.
  tl.minTyresOut = tl.minTyresOut === 2 ? 2 : 4;
  tl.excursionsForIncident = clampIntIn(tl.excursionsForIncident, 1, 99, 3);
  tl.minDurationMs = clampIntIn(tl.minDurationMs, 0, 10_000, 300);
  tl.reviewTimeGain = typeof tl.reviewTimeGain === "boolean" ? tl.reviewTimeGain : true;

  rules.wrongWay.action = validateAction(rules.wrongWay.action, "wrongWay", "review");
  rules.wrongWay.minSeconds = clampIntIn(rules.wrongWay.minSeconds, 1, 60, 3);
  rules.wrongWay.minSpeedKmh = clampIntIn(rules.wrongWay.minSpeedKmh, 1, 300, 40);


  rules.disconnectDuringRace.action = validateAction(rules.disconnectDuringRace.action, "disconnectDuringRace", "log");
}

/**
 * Migra un `config.json` de una versión anterior al catálogo nuevo.
 *
 * Se hace sobre el JSON crudo y ANTES del merge, no después: `mergeConfigInto` copia claves que
 * no conoce tal cual, así que un config viejo dejaría `incidents`/`trackLimits` colgando al lado
 * del catálogo nuevo, sin efecto y confundiendo a cualquiera que abra el archivo.
 */
function migrateLegacyRules(raw: Record<string, any>): void {
  if (!isPlainObject(raw.infractions)) raw.infractions = {};
  const target = raw.infractions as Record<string, any>;

  if (isPlainObject(raw.incidents)) {
    const old = raw.incidents;
    target.carContact = { action: "review", minImpactKmh: old.minContactSpeedKmh, ...target.carContact };
    target.envCollision = {
      // El booleano de antes era exactamente la decisión que ahora toma `action`.
      action: old.trackEnvCollisions === false ? "ignore" : "review",
      minImpactKmh: old.minEnvSpeedKmh,
      ...target.envCollision,
    };
    delete raw.incidents;
  }

  if (isPlainObject(raw.trackLimits)) {
    const old = raw.trackLimits;
    target.trackLimits = {
      action: old.enabled === false ? "ignore" : "review",
      minTyresOut: old.minTyresOut,
      excursionsForIncident: old.excursionsForIncident,
      minDurationMs: old.minDurationMs,
      reviewTimeGain: old.reviewTimeGain,
      ...target.trackLimits,
    };
    delete raw.trackLimits;
  }
}

/**
 * Aplica un preset de torneo sobre un config en memoria.
 *
 * No toca nada que el preset no mencione (nombre de liga, red, puertos): elegir "campeonato" no
 * puede desconfigurarle el servidor a nadie.
 */
export function applyPresetTo(config: AppConfig, preset: PresetName): void {
  const chosen = PRESETS[preset];
  mergeConfigInto(config.infractions as unknown as Record<string, unknown>, chosen.infractions);
  for (const penalty of [config.formation.penalty, config.pit.penalty]) {
    penalty.toleranceSeconds = chosen.penalty.toleranceSeconds;
    penalty.graceLaps = chosen.penalty.graceLaps;
    penalty.escalation = chosen.penalty.escalation;
  }
  config.preset = preset;
  validateConfig(config);
}

export function applyPreset(config: AppConfig, preset: PresetName): void {
  applyPresetTo(config, preset);
  saveConfig(config);
}

function validateConfig(config: AppConfig): void {
  // Un config.json editado a mano puede traer `null` o un escalar donde se espera un objeto, y
  // mergeConfigInto lo copia tal cual (solo recursa cuando AMBOS lados son objetos). Sin esta
  // guarda, leer config.presence.graceSeconds abajo tumbaría el arranque con un TypeError.
  const defaults = defaultConfig();
  for (const key of ["http", "acUdp", "formation", "pit", "presence", "infractions"] as const) {
    if (!isPlainObject(config[key])) (config as unknown as Record<string, unknown>)[key] = defaults[key];
  }
  if (!isPlainObject(config.formation.penalty)) config.formation.penalty = defaults.formation.penalty;
  if (!isPlainObject(config.pit.penalty)) config.pit.penalty = defaults.pit.penalty;
  if (!isPlainObject(config.pit.zone)) config.pit.zone = defaults.pit.zone;

  validatePenalty(config.formation.penalty);
  validatePenalty(config.pit.penalty);
  if (!isPlausibleHost(config.acUdp.remoteHost)) config.acUdp.remoteHost = "127.0.0.1";
  config.acUdp.localPort = clampPort(config.acUdp.localPort, 12000);
  config.acUdp.remotePort = clampPort(config.acUdp.remotePort, 11000);
  // Un config.json de una versión anterior no trae el campo. Se asume "default" —o sea, que el
  // puerto se puede autodetectar— porque hasta ahora nadie podía haberlo elegido a conciencia:
  // el campo recién existe en el panel desde la 0.3.
  if (!["default", "manual", "detected"].includes(config.acUdp.remotePortSource)) {
    config.acUdp.remotePortSource = "default";
  }
  config.http.adminPort = clampPort(config.http.adminPort, 3000);
  config.http.clientPort = clampPort(config.http.clientPort, 3001);
  // Los dos puertos se pueden editar desde el panel, y poner el mismo número en los dos es un
  // error fácil de cometer y imposible de diagnosticar después: el segundo `listen` muere con
  // EADDRINUSE y la app no abre. Se corrige acá, donde se guarda, y no al arrancar.
  if (config.http.clientPort === config.http.adminPort) {
    config.http.clientPort = clampPort(config.http.adminPort + 1, 3001);
  }
  config.http.publicHost = isPlausibleHost(config.http.publicHost) ? config.http.publicHost.trim() : "";
  config.presence.graceSeconds = clampPositive(config.presence.graceSeconds, 60);
  config.pit.stopGoSeconds = clampPositive(config.pit.stopGoSeconds, 30);
  if (
    typeof config.pit.zone.splineStart !== "number" ||
    typeof config.pit.zone.splineEnd !== "number" ||
    !Number.isFinite(config.pit.zone.splineStart) ||
    !Number.isFinite(config.pit.zone.splineEnd)
  ) {
    config.pit.zone = { splineStart: 0.97, splineEnd: 0.995 };
  }
  config.presence.enforce = typeof config.presence.enforce === "boolean" ? config.presence.enforce : true;
  validateInfractions(config.infractions);
  config.preset = config.preset in PRESETS ? config.preset : "";
  config.shadowMode = typeof config.shadowMode === "boolean" ? config.shadowMode : true;
}

/**
 * Construye un `AppConfig` válido a partir del JSON crudo de un `config.json`, sin tocar el disco.
 *
 * Es el camino completo —defaults, migración de formato viejo, merge y validación— separado del
 * I/O para poder probarlo: un config a medio editar o de una versión anterior no puede tumbar el
 * arranque, y eso solo se verifica si se puede ejercitar sin un archivo real de por medio.
 */
export function parseConfig(raw: unknown): AppConfig {
  const config = defaultConfig();
  if (isPlainObject(raw)) {
    migrateLegacyRules(raw);
    mergeConfigInto(config, raw);
  }
  validateConfig(config);
  return config;
}

export function loadConfig(): AppConfig {
  let raw: unknown = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch (err) {
      console.error(`[config] No se pudo leer ${CONFIG_PATH}, uso los valores por defecto:`, err);
    }
  }
  const config = parseConfig(raw);
  saveConfig(config);
  return config;
}

export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

/** Aplica un patch parcial (ej. desde POST /api/config) manteniendo vivas las referencias internas. */
export function applyConfigPatch(config: AppConfig, patch: Record<string, unknown>): void {
  const previousRemotePort = config.acUdp.remotePort;
  mergeConfigInto(config, patch);
  // Si el admin escribió un puerto distinto del que había, manda él: a partir de acá la
  // autodetección no lo vuelve a pisar. Se compara el valor y no la mera presencia del campo
  // porque el panel manda el formulario de puertos completo en cada guardado, y apretar "Guardar"
  // sin tocar nada no es una decisión sobre el puerto.
  if (config.acUdp.remotePort !== previousRemotePort) {
    // Dejar el campo vacío en el panel llega acá como 0, y es la forma de decir "no sé el número,
    // deducilo vos". Cualquier otro cambio es una decisión del admin y manda él.
    const cleared = !(typeof config.acUdp.remotePort === "number" && config.acUdp.remotePort > 0);
    config.acUdp.remotePortSource = cleared ? "default" : "manual";
  }
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
