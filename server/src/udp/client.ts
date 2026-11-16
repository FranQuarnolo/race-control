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
  /** Ver `sendHeartbeat`. El más reciente primero, a lo sumo `KNOWN_PORTS_MAX`. */
  knownPorts?: number[];
}

/**
 * Cuántos puertos de origen se recuerdan por servidor. Detrás de un NAT se vieron dos (911 y
 * 11000 en FSL); cuatro dan margen sin convertir el latido en un barrido de puertos.
 */
const KNOWN_PORTS_MAX = 4;

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

/** Dos cambios de host dentro de esta ventana = dos servidores de AC en el mismo puerto. Ver
 * `adoptRemoteHostIfNeeded`. */
const HOST_FLAP_WINDOW_MS = 60_000;

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
  /** Cuándo se avisó por última vez que el puerto cambió. Ver `adoptRemotePortIfNeeded`. */
  private lastPortNoticeAt = 0;
  /** Cuándo se cambió de host por última vez, y si se dejó de seguir los cambios. Ver
   * `adoptRemoteHostIfNeeded`. */
  private lastHostChangeAt = 0;
  private remoteHostAdoptionGaveUp = false;

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
   *
   * **El host se sigue también cuando CAMBIA (desde la 1.38).** Hasta ahí se adoptaba una sola
   * vez, al salir de 127.0.0.1, y quedaba fijo para siempre en el `config.json`. Una liga cuyo
   * servidor de AC se mudó de hosting (FSL: de `160.119.76.171` a otra IP) siguió recibiendo
   * telemetría perfecta del servidor nuevo mientras le mandaba todo —el anuncio a la app, el
   * chat, las sanciones— al viejo. El piloto veía la app en "Buscando servidor" y ni un mensaje
   * de Race Control en el chat. El que manda los datagramas es, por definición, el servidor que
   * está corriendo: ese es a quien hay que contestarle.
   *
   * Al cambiar de host, el puerto aprendido del anterior deja de valer (salvo que el admin lo
   * haya fijado a mano) y se vuelve a detectar desde cero con el servidor nuevo.
   *
   * Lo único que esto no tolera son DOS servidores de AC apuntando al mismo puerto UDP: el host
   * saltaría de uno a otro con cada paquete. Eso ya es una configuración rota —dos carreras
   * mezcladas en una torre—, así que si el host cambia dos veces en menos de un minuto se deja de
   * seguir, se queda el último y se avisa.
   */
  private adoptRemoteHostIfNeeded(rinfo: dgram.RemoteInfo): void {
    if (isLoopback(rinfo.address) || rinfo.address === this.config.remoteHost) return;
    if (this.remoteHostAdoptionGaveUp) return;
    const previous = this.config.remoteHost;
    const moved = !isLoopback(previous);
    if (moved) {
      const now = Date.now();
      if (this.lastHostChangeAt > 0 && now - this.lastHostChangeAt < HOST_FLAP_WINDOW_MS) {
        this.remoteHostAdoptionGaveUp = true;
        this.emit("remoteHostUnstable", { kept: previous, alsoSeen: rinfo.address });
        return;
      }
      this.lastHostChangeAt = now;
      if (this.config.remotePortSource !== "manual") this.config.remotePortSource = "default";
      // Los puertos del servidor viejo no le sirven al nuevo: el latido no tiene por qué ir ahí.
      this.config.knownPorts = [];
    }
    this.config.remoteHost = rinfo.address;
    this.emit("remoteHostDetected", {
      previous,
      detected: rinfo.address,
      sourcePort: rinfo.port,
      configuredPort: this.config.remotePort,
      moved,
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
   * **Se le contesta siempre al último puerto de origen (desde la 1.40).** Hasta ahí, si el servidor
   * hablaba desde un segundo puerto se dejaba de adoptar y se quedaba el primero, por miedo a que
   * fuera un socket efímero. Lo que apareció en pista fue otra cosa: el servidor de Spa de FSL
   * corre detrás de un router con NAT. Escucha en 9813 adentro de su red, ese puerto no está
   * abierto hacia afuera, y el router le cambia el origen a lo que quiere (913, 11000...). Lo único
   * que atraviesa ese router de vuelta es una respuesta al mismo par IP:puerto que acaba de
   * hablar, desde nuestro mismo puerto — exactamente lo que hace cualquier juego online. Al
   * quedarnos con el primer puerto, apenas el router renovaba el mapeo todo lo saliente (chat,
   * anuncio a la app, sanciones) moría en su firewall, en silencio, con la telemetría entrando
   * perfecta. Con un servidor sin NAT no cambia nada: ahí el origen ya es el puerto de escucha.
   *
   * Si el puerto saltara en cada paquete (un relay con dos sockets, por ejemplo) se lo sigue
   * igual, pero se avisa y se persiste a lo sumo una vez por minuto para no reescribir el
   * `config.json` con cada datagrama.
   *
   * El puerto fijado a mano manda siempre: es la salida para un hosting que sí abre su
   * "Listen Address" y manda desde otro lado.
   */
  private adoptRemotePortIfNeeded(rinfo: dgram.RemoteInfo, packetType: number): void {
    if (this.config.remotePortSource === "manual") return;
    const nuevoEnLaLista = this.recordKnownPort(rinfo.port);
    if (rinfo.port === this.config.remotePort) return;
    const previous = this.config.remotePort;
    const followed = this.config.remotePortSource === "detected";
    this.config.remotePort = rinfo.port;
    this.config.remotePortSource = "detected";
    const now = Date.now();
    // Un puerto que el latido todavía no conocía se persiste siempre, sin la pausa de un minuto:
    // es lo que hace que después de un deploy el latido ya salga hacia él.
    if (!nuevoEnLaLista && followed && now - this.lastPortNoticeAt < HOST_FLAP_WINDOW_MS) return;
    this.lastPortNoticeAt = now;
    // `packetType` es diagnóstico: en FSL todavía no se sabe qué manda el servidor desde 11000.
    this.emit("remotePortDetected", { previous, detected: rinfo.port, followed, packetType });
  }

  /** Pone el puerto primero en `knownPorts`. Devuelve si no estaba (o sea, si hay que persistir). */
  private recordKnownPort(port: number): boolean {
    const lista = this.config.knownPorts ?? [];
    const estaba = lista.includes(port);
    this.config.knownPorts = [port, ...lista.filter((p) => p !== port)].slice(0, KNOWN_PORTS_MAX);
    return !estaba;
  }

  /**
   * El latido: reafirma el streaming de posiciones y pide la sesión, a TODOS los puertos desde
   * los que habló el servidor, no solo al último (desde la 1.42).
   *
   * **Por qué.** Detrás del NAT de FSL cada servidor habla desde su puerto bueno (9813 adentro →
   * 913 afuera) y, de vez en cuando, desde 11000. Contestarle a 11000 no atraviesa el router. Si lo
   * último que llegó fue un paquete desde 11000 y la pista se quedaba vacía, el latido salía hacia
   * ahí, el servidor no se enteraba, no contestaba nada, y el panel decía "Sin señal" con el
   * servidor andando —hasta que entraba un piloto—. Spa estuvo así una mañana entera.
   *
   * Duplicar ESTOS dos paquetes no hace daño: el intervalo es idempotente y `GET_SESSION_INFO` solo
   * pide información. Por eso los comandos (chat, sanciones, kicks) NO se mandan a todos: un chat o
   * un `/ballast` repetido sí se notaría. Tampoco hace falta: el servidor contesta el latido desde
   * su puerto bueno, y con eso `remotePort` se corrige solo antes del próximo comando.
   *
   * Con un puerto escrito a mano va solo a ese: ahí el admin sabe más que nosotros.
   */
  sendHeartbeat(intervalMs: number): void {
    const puertos =
      this.config.remotePortSource === "manual"
        ? [this.config.remotePort]
        : [this.config.remotePort, ...(this.config.knownPorts ?? [])].filter((p, i, arr) => arr.indexOf(p) === i);
    const paquetes = [encodeRealtimePosInterval(intervalMs), encodeGetSessionInfo()];
    for (const port of puertos) {
      for (const buf of paquetes) this.sendTo(buf, port);
    }
  }

  /**
   * Quedó por compatibilidad con el diagnóstico: desde la 1.40 el puerto no se abandona nunca
   * (ver `adoptRemotePortIfNeeded`), así que siempre es `false`. Si alguna vez se vuelve a
   * abandonar la detección, este es el lugar donde decirlo.
   */
  hasUnstableRemotePort(): boolean {
    return false;
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    this.stats.packetsReceived += 1;
    this.stats.lastPacketAt = Date.now();
    this.stats.lastSourcePort = rinfo.port;
    this.adoptRemoteHostIfNeeded(rinfo);
    this.adoptRemotePortIfNeeded(rinfo, msg.length > 0 ? msg[0] : -1);
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
    this.sendTo(buf, this.config.remotePort);
  }

  private sendTo(buf: Buffer, port: number): void {
    this.stats.commandsSent += 1;
    this.socket.send(buf, port, this.config.remoteHost, (err) => {
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
