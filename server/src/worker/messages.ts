/**
 * Mensajes que cruzan el canal IPC entre el supervisor del portal y el worker de una liga.
 *
 * La configuración viaja por acá y NO por `argv` a propósito: los argumentos de un proceso son
 * visibles para cualquier usuario de la máquina (`ps`, el Administrador de tareas), y acá viajan
 * rutas de datos y, más adelante, material de clave.
 */

export interface LeagueIdentity {
  id: string;
  /** El que aparece en la URL: `/l/<slug>`. */
  slug: string;
  name: string;
}

export interface LeaguePorts {
  /** UDP del servidor de AC. Es el ÚNICO puerto de la liga expuesto a internet tal cual. */
  udpPort: number;
  /** Panel y API de administración. Siempre en loopback: solo llega el portal. */
  adminPort: number;
  /** Endpoints de la app del piloto. También en loopback: el portal los publica bajo `/l/<slug>`. */
  clientPort: number;
}

export interface StartMessage {
  type: "start";
  league: LeagueIdentity;
  dataDir: string;
  ports: LeaguePorts;
  /** IP pública del servidor, la que va en el "Send Address" junto al puerto UDP. */
  publicIp: string;
  /** Base que se le anuncia a la app del piloto, ej. `race-control.fly.dev/l/fsl`. */
  clientBase: string;
  /** Interfaz a la que bindear el UDP. En Fly.io tiene que ser `fly-global-services`. */
  udpBindAddress?: string;
}

export interface StopMessage {
  type: "stop";
}

export type ToWorker = StartMessage | StopMessage;

export interface ReadyMessage {
  type: "ready";
  leagueId: string;
  ports: LeaguePorts;
}

export interface WorkerErrorMessage {
  type: "error";
  leagueId: string;
  /** `fatal` = no tiene sentido reintentar (ej. el puerto UDP ya está tomado por otra liga). */
  fatal: boolean;
  message: string;
}

export type FromWorker = ReadyMessage | WorkerErrorMessage;
