import * as dgram from "dgram";
import { EventEmitter } from "events";
import {
  decodePacket,
  encodeAdminCommand,
  encodeBroadcastChat,
  encodeGetCarInfo,
  encodeGetSessionInfo,
  encodeKickUser,
  encodeRealtimePosInterval,
  encodeSendChat,
} from "./protocol";

export interface AcUdpConfig {
  /** Puerto local donde este proceso escucha los paquetes que manda el acServer. */
  localPort: number;
  /** Host/puerto del acServer al que le mandamos comandos — el "Send Address" del panel del
   * hosting (`UDP_PLUGIN_ADDRESS` en el server_cfg.ini). */
  remoteHost: string;
  remotePort: number;
  /** Ver `AppConfig["acUdp"]`. Si falta, se trata como `"default"` y el puerto se autodetecta. */
  remotePortSource?: "default" | "manual" | "detected";
}

/** `0.0.0.0` incluido a propósito: como destino de un `send()` es equivalente a loopback. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
}

export interface UdpStats {
  packetsReceived: number;
  /** Paquetes con opcode desconocido o malformados/truncados — nunca deberían crashear el proceso. */
  packetsUnhandled: number;
  lastPacketAt: number;
  commandsSent: number;
  commandSendErrors: number;
  /** Puerto desde el que nos habló el servidor de AC. 0 si todavía no habló.
   *
   * Es el dato que delata la falla más silenciosa que hay: el servidor manda telemetría perfecta
   * y ningún comando nuestro le llega, porque su `UDP_PLUGIN_LOCAL_PORT` no es el que tenemos
   * configurado. El diagnóstico lo contrasta y lo dice con los dos números a la vista. */
  lastSourcePort: number;
}

/** Habla el protocolo ACSP con el servidor dedicado de Assetto Corsa. Ver protocol.ts. */
export class AcUdpClient extends EventEmitter {
  private socket: dgram.Socket;
  private stats: UdpStats = {
    packetsReceived: 0,
    packetsUnhandled: 0,
    lastPacketAt: 0,
    commandsSent: 0,
    commandSendErrors: 0,
    lastSourcePort: 0,
  };
  private remotePortAdoptionGaveUp = false;

  /**
   * `config` se guarda POR REFERENCIA a propósito: es el mismo objeto `config.acUdp` de la app, y
   * la autodetección de host/puerto lo muta para que el panel y el `config.json` queden al día
   * sin tener que propagar el cambio a mano. Copiarlo acá rompería eso en silencio.
   *
   * `bindAddress` va aparte justamente porque NO es parte de la configuración del usuario: no se
   * persiste ni se muestra. Vacío = todas las interfaces (lo correcto en una PC de escritorio).
   * Existe por Fly.io, donde el UDP entrante solo funciona si el proceso escucha en la dirección
   * especial `fly-global-services`: con `0.0.0.0` el kernel contesta desde una IP de origen que
   * no es la pública y las respuestas se descartan en silencio — telemetría que entra y comandos
   * que nunca llegan, el modo de fallo más difícil de diagnosticar que tiene este producto.
   */
  constructor(private config: AcUdpConfig, private bindAddress?: string) {
    super();
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (msg, rinfo) => this.handleMessage(msg, rinfo));
    // Nunca dejar que un error de socket tumbe el proceso: el que arma el backend (index.ts)
    // decide qué hacer (loguear, reintentar). Un EventEmitter sin listener de "error" relanza
    // la excepción y mata el proceso — por eso este reenvío es obligatorio, no cosmético.
    this.socket.on("error", (err) => this.emit("error", err));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onBindError = (err: Error) => reject(err);
      this.socket.once("error", onBindError);
      this.socket.bind(this.config.localPort, this.bindAddress || undefined, () => {
        this.socket.removeListener("error", onBindError);
        resolve();
      });
    });
  }

  stop(): void {
    this.socket.close();
  }

  getStats(): UdpStats {
    return { ...this.stats };
  }

  /** A dónde se están mandando los comandos ahora mismo — el panel lo muestra para que un fallo
   * de envío sea diagnosticable sin leer el config a mano. */
  getRemoteTarget(): { host: string; port: number; autodetected: boolean } {
    return {
      host: this.config.remoteHost,
      port: this.config.remotePort,
      autodetected: !isLoopback(this.config.remoteHost),
    };
  }

  /**
   * El servidor de AC se identifica solo: el primer datagrama que manda trae su dirección real.
   *
   * Esto existe porque `remoteHost` arrancaba fijo en 127.0.0.1 y no era configurable desde
   * ningún lado — contra un hosting remoto (el caso de uso real: EmperorServers) TODO el tráfico
   * saliente moría en loopback: el chat de penalización, los kicks, `/ballast` y el keepalive que
   * abre el pinhole de NAT del que depende la estrategia de red "direct". El backend recibía
   * telemetría perfecta y no podía contestar nada.
   *
   * El puerto se adopta aparte, con reglas propias: ver `adoptRemotePortIfNeeded`.
   */
  private adoptRemoteHostIfNeeded(rinfo: dgram.RemoteInfo): void {
    if (!isLoopback(this.config.remoteHost) || isLoopback(rinfo.address)) return;
    const previous = this.config.remoteHost;
    this.config.remoteHost = rinfo.address;
    this.emit("remoteHostDetected", {
      previous,
      detected: rinfo.address,
      sourcePort: rinfo.port,
      configuredPort: this.config.remotePort,
    });
  }

  /**
   * El puerto de comandos también lo dice el servidor solo, con cada paquete que manda.
   *
   * Esto existe porque encontrar ese número es, por lejos, el paso más difícil de la puesta en
   * marcha: vive en el panel del hosting bajo un nombre que cambió entre versiones ("Listen
   * Address" desde Assetto Corsa Server Manager 2.4.8, antes "UDP Plugin Local Port"), en muchos
   * planes no es editable, y equivocarlo produce la falla más cara de diagnosticar que tiene el
   * producto: la telemetría entra perfecta, el panel se pone verde entero, y ni una sola sanción
   * llega nunca al servidor.
   *
   * Se apoya en un supuesto que hay que confirmar en pista (ver `docs/spike-protocolo.md`): que el
   * acServer usa un solo socket para el plugin y entonces manda desde el mismo puerto en el que
   * escucha. Si resultara falso, el puerto de origen sería efímero y cambiaría solo — ese caso se
   * detecta acá mismo, se deja de adoptar y se avisa, en vez de quedar pisando el valor bueno con
   * basura nueva en cada paquete.
   */
  private adoptRemotePortIfNeeded(rinfo: dgram.RemoteInfo): void {
    if (this.config.remotePortSource === "manual") return;
    // Volver el campo a "default" desde el panel (borrándolo) es pedir explícitamente que se
    // reintente la detección, incluso si antes la habíamos abandonado por inestable.
    if (this.config.remotePortSource === "default") this.remotePortAdoptionGaveUp = false;
    if (this.remotePortAdoptionGaveUp) return;
    if (rinfo.port === this.config.remotePort) return;
    const previous = this.config.remotePort;
    if (this.config.remotePortSource === "detected") {
      this.remotePortAdoptionGaveUp = true;
      this.emit("remotePortUnstable", { adopted: previous, alsoSeen: rinfo.port });
      return;
    }
    this.config.remotePort = rinfo.port;
    this.config.remotePortSource = "detected";
    this.emit("remotePortDetected", { previous, detected: rinfo.port });
  }

  /** `true` cuando el servidor habló desde más de un puerto: ninguno sirve como destino fijo. */
  hasUnstableRemotePort(): boolean {
    return this.remotePortAdoptionGaveUp;
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    this.stats.packetsReceived += 1;
    this.stats.lastPacketAt = Date.now();
    this.stats.lastSourcePort = rinfo.port;
    this.adoptRemoteHostIfNeeded(rinfo);
    this.adoptRemotePortIfNeeded(rinfo);
    this.emit("rawPacket", msg);

    const packet = decodePacket(msg);
    if (!packet) {
      this.stats.packetsUnhandled += 1;
      return;
    }
    this.emit(packet.type, "data" in packet ? packet.data : packet.raw);
    this.emit("packet", packet);
  }

  private send(buf: Buffer): void {
    this.stats.commandsSent += 1;
    this.socket.send(buf, this.config.remotePort, this.config.remoteHost, (err) => {
      if (err) {
        this.stats.commandSendErrors += 1;
        this.emit("sendError", err);
      }
    });
  }

  /** Activa el streaming periódico de CAR_UPDATE para todos los autos. */
  setRealtimePosInterval(intervalMs: number): void {
    this.send(encodeRealtimePosInterval(intervalMs));
  }

  sendChatToCar(carId: number, message: string): void {
    this.send(encodeSendChat(carId, message));
  }

  broadcastChat(message: string): void {
    this.send(encodeBroadcastChat(message));
  }

  /** Comandos de consola admin: "/ballast <carId> <kg>", "/restrictor <carId> <pct>", "/kick <carId>", etc. */
  sendAdminCommand(command: string): void {
    this.send(encodeAdminCommand(command));
  }

  kick(carId: number): void {
    this.send(encodeKickUser(carId));
  }

  /** Pregunta quién ocupa un slot. El servidor responde con CAR_INFO, aunque el piloto se haya
   * conectado antes de que este proceso existiera. */
  requestCarInfo(carId: number): void {
    this.send(encodeGetCarInfo(carId));
  }

  /** Pide las condiciones de la sesión en curso. El servidor no las manda solo salvo al cambiar
   * de sesión, así que sin preguntar el tiempo corrido se va quedando viejo. */
  requestSessionInfo(): void {
    this.send(encodeGetSessionInfo());
  }
}
