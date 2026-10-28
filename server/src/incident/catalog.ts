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
  /**
   * Los dos excesos de velocidad. **No deciden si se sanciona** —eso ya lo deciden las secciones
   * de Largada y de Pit, que son las que tienen el km/h y los segundos de tolerancia—: deciden
   * qué pasa con el **registro** del hecho.
   *
   * Hasta la 1.2 el exceso emitía la sanción y nada más. Para la bandeja era como si no hubiera
   * pasado: el resumen de un piloto podía decir "0 incidentes" con tres sanciones de pit lane
   * encima, que es justo el dato que el comisario necesita para decidir si está pasado de vuelta
   * o si el límite está mal puesto. Por eso son `SimpleRule` y no tienen umbral propio: duplicar
   * el km/h acá sería tener dos números para lo mismo, y alguien iba a cambiar solo uno.
   */
  pitSpeeding: SimpleRule;
  formationSpeeding: SimpleRule;
}

/**
 * Tipos donde una sanción automática es defendible.
 *
 * Es uno solo, y es a propósito. En un toque el servidor sabe que hubo contacto, **no quién tuvo
 * la culpa**: ofrecer "sancionar" ahí sería prometer un juicio que el dato no respalda. Las
 * salidas de pista sí: contar ruedas afuera es objetivo y no se interpreta.
 *
 * Los dos excesos de velocidad **tampoco están**, aunque son todavía más objetivos: su sanción ya
 * se configura en Largada y en Pit, con su umbral y su tolerancia. Ofrecer acá un segundo
 * interruptor para lo mismo terminaría en dos lugares que dicen cosas distintas, y el día que
 * pasen a contradecirse nadie va a saber cuál manda.
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
    // Van a la bandeja y no a "solo registrar": el piloto ya recibió su sanción automática, así
    // que lo que queda es que el comisario vea el patrón —tres excesos del mismo auto en pit lane
    // no es lo mismo que uno— y pueda anularla si el límite estaba mal.
    pitSpeeding: { action: "review" },
    formationSpeeding: { action: "review" },
  };
}

/*
 * Acá vivían los tres presets de torneo: "Carrera casual", "Campeonato" y "Simulación estricta",
 * un patch de reglas cada uno que el admin elegía en el wizard.
 *
 * Se eliminaron en la 1.2, reemplazados por los perfiles de carrera (`RuleProfile` en config.ts),
 * que guardan el reglamento completo con el nombre que le ponga la liga. El motivo no fue que
 * sobraran sino que mentían: en cuanto el admin tocaba dos valores —que es lo primero que hace—,
 * el modo que figuraba elegido ya no describía lo que estaba corriendo, y no había forma de
 * volver a lo que uno tenía la fecha pasada. Un admin nuevo arranca con `defaultInfractions()`,
 * que son los mismos valores que tenía "Campeonato".
 *
 * Si alguna vez hiciera falta volver a ofrecer un punto de partida, la forma sería un perfil
 * sembrado en el primer arranque, no un tipo aparte.
 */

/** Etiquetas para el panel. Deliberadamente sin jerga: "revisar" y no "review". */
export const ACTION_LABELS: Record<InfractionAction, string> = {
  ignore: "No controlar",
  log: "Solo registrar",
  review: "Mandar a revisar",
  penalty: "Sancionar solo",
};
