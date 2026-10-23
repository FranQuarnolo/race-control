/**
 * Catálogo de infracciones: qué se controla y qué se hace con cada cosa.
 *
 * Antes cada tipo tenía su propio bloque de configuración con su propia forma (`incidents`,
 * `trackLimits`), y la única decisión disponible era un `enabled` booleano. Eso dejaba afuera lo
 * que un admin de liga realmente quiere decidir: no *si* se mira, sino **qué pasa cuando ocurre**.
 * Una liga casual quiere que los toques queden registrados sin interrumpir; una estricta quiere
 * que las salidas de pista se sancionen solas.
 *
 * De ahí el campo `action`, que es el mismo en todos los tipos.
 */

export type InfractionAction = "ignore" | "log" | "review" | "penalty";

export type InfractionType = keyof InfractionCatalog;

export interface ImpactRule {
  action: InfractionAction;
  /** Por debajo de esto no se registra. Sin umbral, cada roce de parrilla llena la bandeja. */
  minImpactKmh: number;
}

export interface TrackLimitsRule {
  action: InfractionAction;
  /** Ruedas afuera que cuentan. 4 es la definición estándar; 2 es el criterio estricto. */
  minTyresOut: number;
  /** Cada cuántas salidas se avisa (o se sanciona, si `action` es "penalty"). */
  excursionsForIncident: number;
  /** Salidas más cortas que esto se descartan: pisar el pasto un frame no es una salida. */
  minDurationMs: number;
  /** Una salida en la vuelta más rápida del piloto va a la bandeja sin esperar reincidencia. */
  reviewTimeGain: boolean;
}

export interface WrongWayRule {
  action: InfractionAction;
  /** Segundos seguidos retrocediendo en el trazado antes de considerarlo contramano. */
  minSeconds: number;
  /** Por debajo de esta velocidad no cuenta: maniobrar despacio para salir de la grava es
   * normal, y es exactamente lo que hace un piloto que acaba de trompear. */
  minSpeedKmh: number;
}

export interface SimpleRule {
  action: InfractionAction;
}

export interface InfractionCatalog {
  carContact: ImpactRule;
  envCollision: ImpactRule;
  trackLimits: TrackLimitsRule;
  wrongWay: WrongWayRule;
  disconnectDuringRace: SimpleRule;
}

/**
 * Tipos donde una sanción automática es defendible.
 *
 * Es uno solo, y es a propósito. En un toque el servidor sabe que hubo contacto, **no quién tuvo
 * la culpa**: ofrecer "sancionar" ahí sería prometer un juicio que el dato no respalda. Las
 * salidas de pista sí: contar ruedas afuera es objetivo y no se interpreta.
 */
export const AUTO_PENALTY_ALLOWED = new Set<InfractionType>(["trackLimits"]);

export function defaultInfractions(): InfractionCatalog {
  return {
    // 30 km/h deja afuera los roces de parrilla y los pianos. Los choques en solitario arrancan
    // más arriba: un toque leve contra el muro es un error del piloto, no algo para revisar.
    carContact: { action: "review", minImpactKmh: 30 },
    envCollision: { action: "review", minImpactKmh: 60 },
    trackLimits: {
      action: "review",
      minTyresOut: 4,
      excursionsForIncident: 3,
      minDurationMs: 300,
      reviewTimeGain: true,
    },
    wrongWay: { action: "review", minSeconds: 3, minSpeedKmh: 40 },
    // Conservador a propósito: un tren de autos en una curva lenta puede parecer una retención
    // sin serlo. Diez segundos es mucho más de lo que tarda cualquier piloto de buena fe.
    disconnectDuringRace: { action: "log" },
  };
}

/**
 * Presets por tipo de torneo.
 *
 * Existen porque un admin no técnico no tiene forma de saber qué umbral de impacto poner. Elige
 * "campeonato" y todos los números quedan puestos; después puede tocar lo que quiera.
 *
 * Cada preset es un patch sobre los valores por defecto, no un catálogo completo: así, agregar un
 * tipo de infracción nuevo no obliga a tocar los tres presets ni deja huecos silenciosos.
 */
export type PresetName = "casual" | "campeonato" | "estricto";

export interface Preset {
  label: string;
  description: string;
  infractions: Partial<InfractionCatalog>;
  /** Qué tan dura es la sanción automática de largada y pit lane. */
  penalty: { toleranceSeconds: number; graceLaps: number; escalation: "DQ" | "TIME_PENALTY" };
}

export const PRESETS: Record<PresetName, Preset> = {
  casual: {
    label: "Carrera casual",
    description: "Casi todo queda registrado sin interrumpir la carrera. Para juntadas y amistosos.",
    infractions: {
      carContact: { action: "review", minImpactKmh: 60 },
      envCollision: { action: "ignore", minImpactKmh: 60 },
      trackLimits: {
        action: "log",
        minTyresOut: 4,
        excursionsForIncident: 5,
        minDurationMs: 500,
        reviewTimeGain: false,
      },
      wrongWay: { action: "review", minSeconds: 5, minSpeedKmh: 50 },
      disconnectDuringRace: { action: "log" },
    },
    penalty: { toleranceSeconds: 8, graceLaps: 4, escalation: "TIME_PENALTY" },
  },
  campeonato: {
    label: "Campeonato",
    description: "Los toques y las salidas van a la bandeja del comisario. Es el equilibrio recomendado.",
    infractions: defaultInfractions(),
    penalty: { toleranceSeconds: 5, graceLaps: 3, escalation: "DQ" },
  },
  estricto: {
    label: "Simulación estricta",
    description: "Umbrales bajos y sanción automática por límites de pista. Para ligas de reglamento duro.",
    infractions: {
      carContact: { action: "review", minImpactKmh: 20 },
      envCollision: { action: "review", minImpactKmh: 40 },
      trackLimits: {
        action: "penalty",
        minTyresOut: 2,
        excursionsForIncident: 3,
        minDurationMs: 200,
        reviewTimeGain: true,
      },
      wrongWay: { action: "review", minSeconds: 2, minSpeedKmh: 30 },
      disconnectDuringRace: { action: "review" },
    },
    penalty: { toleranceSeconds: 3, graceLaps: 2, escalation: "DQ" },
  },
};

/** Etiquetas para el panel. Deliberadamente sin jerga: "revisar" y no "review". */
export const ACTION_LABELS: Record<InfractionAction, string> = {
  ignore: "No controlar",
  log: "Solo registrar",
  review: "Mandar a revisar",
  penalty: "Sancionar solo",
};
