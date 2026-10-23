import { NetworkStatus } from "./connectivity";
import { UdpStats, isLoopback } from "../udp/client";

/**
 * Diagnóstico de conexión en castellano llano.
 *
 * Es la respuesta al único problema que el producto no puede resolver solo: cuando algo de la red
 * no anda, el admin —que no es técnico— ve un panel en rojo y no tiene forma de saber cuál de las
 * cuatro cosas que tienen que funcionar es la que falló. Cada chequeo dice qué se miró, cómo
 * salió, y —si salió mal— exactamente qué hacer, sin jerga.
 *
 * El orden importa: va de afuera hacia adentro, y es el orden en que conviene arreglarlos. No
 * tiene sentido pelearse con el puerto de los pilotos si todavía no entra la telemetría.
 */

export type CheckState = "ok" | "warn" | "fail" | "pending";

export interface Check {
  id: string;
  title: string;
  state: CheckState;
  /** Qué se observó. Siempre en pasado y en concreto: "llegaron 1.240 paquetes". */
  detail: string;
  /** Qué hacer al respecto. Vacío cuando no hay nada que hacer. */
  action: string;
}

export interface DiagnosticsInput {
  network: NetworkStatus;
  udp: UdpStats;
  remoteHost: string;
  udpLocalPort: number;
  /** Puerto al que le mandamos los comandos: el "Listen Address" del hosting. */
  udpRemotePort: number;
  /** De dónde salió ese puerto. Cambia qué se le pide al admin cuando algo no cierra: si lo
   * escribió él, hay que decirle que lo corrija; si lo dedujimos nosotros, no tiene nada que ver. */
  udpRemotePortSource: "default" | "manual" | "detected";
  /** El servidor habló desde más de un puerto: la autodetección no sirve y hace falta el dato real. */
  udpRemotePortUnstable: boolean;
  clientPort: number;
  driversConnected: number;
  driversReporting: number;
}

const TELEMETRY_FRESH_MS = 5000;

export function runDiagnostics(input: DiagnosticsInput): Check[] {
  return [
    checkPublicHost(input),
    checkIncomingTelemetry(input),
    checkOutgoingCommands(input),
    checkDriverPort(input),
  ];
}

/** Cuántos de los cuatro chequeos hay que mirar. Se usa para el resumen de una línea del panel. */
export function summarize(checks: Check[]): { state: CheckState; message: string } {
  const failed = checks.filter((c) => c.state === "fail");
  if (failed.length > 0) {
    return { state: "fail", message: failed[0].title + ": " + failed[0].action };
  }
  const warned = checks.filter((c) => c.state === "warn");
  if (warned.length > 0) return { state: "warn", message: warned[0].title + ": " + warned[0].detail };
  if (checks.some((c) => c.state === "pending")) return { state: "pending", message: "Todavía estamos probando." };
  return { state: "ok", message: "Todo en orden: el servidor y los pilotos llegan hasta acá." };
}

function checkPublicHost(input: DiagnosticsInput): Check {
  const { publicIp } = input.network;
  if (!publicIp) {
    return {
      id: "public-host",
      title: "La dirección de tu liga",
      state: "fail",
      detail: "Todavía no tiene una asignada.",
      action:
        "Es algo de nuestro lado, no tuyo: escribinos y lo resolvemos. Sin esta dirección no hay " +
        "nada que puedas pegar en el panel de tu hosting.",
    };
  }
  return {
    id: "public-host",
    title: "La dirección de tu liga",
    state: "ok",
    detail: publicIp,
    action: "",
  };
}

function checkIncomingTelemetry(input: DiagnosticsInput): Check {
  const { udp, network } = input;
  const fresh = udp.lastPacketAt > 0 && Date.now() - udp.lastPacketAt < TELEMETRY_FRESH_MS;
  if (fresh) {
    return {
      id: "telemetry",
      title: "Señal del servidor de carrera",
      state: "ok",
      detail: `Está llegando ahora mismo (${udp.packetsReceived.toLocaleString("es-AR")} paquetes recibidos).`,
      action: "",
    };
  }
  if (udp.packetsReceived > 0) {
    return {
      id: "telemetry",
      title: "Señal del servidor de carrera",
      state: "warn",
      detail: "Llegó antes, pero ahora está cortada.",
      action:
        "Es normal si el servidor de Assetto Corsa está apagado o entre sesiones. Si debería estar " +
        "corriendo, fijate que no lo hayan reiniciado sin la configuración de Race Control.",
    };
  }
  if (network.strategy === "pending") {
    return {
      id: "telemetry",
      title: "Señal del servidor de carrera",
      state: "pending",
      detail: "Todavía estamos esperando el primer paquete.",
      action: "",
    };
  }
  return {
    id: "telemetry",
    title: "Señal del servidor de carrera",
    state: "fail",
    detail: "Nunca llegó nada desde el servidor de Assetto Corsa.",
    action:
      'Entrá al panel de tu hosting, pegá en "Send Address" la dirección que te damos acá al lado ' +
      "y reiniciá el servidor de Assetto Corsa para que la tome. Si ya lo hiciste y sigue en rojo, " +
      "fijate que el plugin UDP no tenga una lista de IPs permitidas que nos deje afuera.",
  };
}

function checkOutgoingCommands(input: DiagnosticsInput): Check {
  if (isLoopback(input.remoteHost)) {
    return {
      id: "commands",
      title: "Órdenes hacia el servidor",
      state: "fail",
      detail: "Todavía no sabemos a qué servidor mandárselas.",
      action:
        "Se averigua sola apenas llegue la primera señal del servidor de carrera, así que " +
        "arreglá eso primero. Si tu hosting no se identifica, escribí su dirección acá abajo.",
    };
  }
  // Desajuste de puertos: la falla más silenciosa de todas. La telemetría entra perfecta —así que
  // los otros tres chequeos dan verde— y ni un solo comando llega, porque le estamos hablando a un
  // puerto donde el servidor no escucha. Sin esto, el síntoma es "las sanciones no se aplican" y no
  // hay absolutamente nada en pantalla que apunte a la causa.
  //
  // Normalmente el puerto se deduce solo del primer paquete, así que acá solo caen dos casos: que
  // el admin haya escrito un número a mano, o que el servidor no use un puerto fijo.
  if (input.udpRemotePortUnstable) {
    return {
      id: "commands",
      title: "Órdenes hacia el servidor",
      state: "fail",
      detail: "Tu servidor nos habla desde un puerto distinto cada vez, así que no podemos deducir a cuál contestarle.",
      action:
        'Entrá al panel de tu hosting y fijate que "Listen Address" (en paneles viejos, ' +
        "UDP_PLUGIN_LOCAL_PORT) tenga un puerto fijo. Si ya lo tiene, escribinos con ese número y " +
        "lo dejamos puesto. Hasta entonces el servidor te manda todo y no recibe nada: ni sanciones, " +
        "ni avisos, ni kicks.",
    };
  }
  const source = input.udp.lastSourcePort;
  if (source > 0 && source !== input.udpRemotePort) {
    return {
      id: "commands",
      title: "Órdenes hacia el servidor",
      state: "fail",
      detail: `Tu servidor nos habla desde el puerto ${source}, pero le estamos mandando las órdenes al ${input.udpRemotePort}.`,
      action:
        `Son dos números que tienen que ser el mismo. Cambiá el "Listen Address" de tu hosting ` +
        `(UDP_PLUGIN_LOCAL_PORT en paneles viejos) a ${input.udpRemotePort} y reiniciá el servidor. ` +
        "Hasta que coincidan, el servidor te manda todo y no recibe nada: ni sanciones, ni avisos, ni kicks.",
    };
  }
  if (input.udp.commandsSent === 0) {
    return {
      id: "commands",
      title: "Órdenes hacia el servidor",
      state: "pending",
      detail: `Sabemos a dónde mandarlas (${input.remoteHost}) pero todavía no mandamos ninguna.`,
      action: "",
    };
  }
  if (input.udp.commandSendErrors > 0) {
    return {
      id: "commands",
      title: "Órdenes hacia el servidor",
      state: "warn",
      detail: `${input.udp.commandSendErrors} no se pudieron mandar.`,
      action: "Puede ser un corte momentáneo de internet. Si se repite, revisá tu conexión.",
    };
  }
  const how = input.udpRemotePortSource === "detected" ? " (el puerto nos lo dijo él solo)" : "";
  return {
    id: "commands",
    title: "Órdenes hacia el servidor",
    state: "ok",
    detail:
      `Salieron ${input.udp.commandsSent.toLocaleString("es-AR")} hacia ` +
      `${input.remoteHost}:${input.udpRemotePort}${how}, sin errores.`,
    action: "",
  };
}

function checkDriverPort(input: DiagnosticsInput): Check {
  if (input.driversReporting > 0) {
    return {
      id: "drivers",
      title: "La app de los pilotos",
      state: "ok",
      detail: `${input.driversReporting} de ${input.driversConnected} en pista están reportando.`,
      action: "",
    };
  }
  if (input.driversConnected === 0) {
    return {
      id: "drivers",
      title: "La app de los pilotos",
      state: "pending",
      detail: "No hay nadie en pista todavía, así que no hay nada que comprobar.",
      action: "",
    };
  }
  return {
    id: "drivers",
    title: "La app de los pilotos",
    state: "fail",
    detail: `Hay ${input.driversConnected} en pista y ninguno llega hasta acá.`,
    action:
      "Pedile a los pilotos que confirmen que tienen la app de Race Control instalada y activada " +
      "en Content Manager. Si la tienen, que salgan y vuelvan a entrar al servidor: la app recibe " +
      "sus credenciales al conectarse.",
  };
}
