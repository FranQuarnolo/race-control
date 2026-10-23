import * as http from "http";
import { loadConfig, saveConfig, setConfigDir } from "../config";
import { createRaceControl, RaceControl } from "../core/raceControl";
import { FromWorker, StartMessage, ToWorker } from "./messages";

/**
 * Entry del proceso hijo que corre UNA liga.
 *
 * Es un proceso aparte y no un objeto más dentro del portal porque hay estado que es global por
 * construcción —`StateTracker` indexado por `carId`, un solo circuito aprendido a la vez, el tipo
 * de sesión— y porque un error no controlado de una liga no puede llevarse puestas a las demás.
 * El precio son unas decenas de MB por liga; se paga.
 */

let rc: RaceControl | null = null;
let servers: http.Server[] = [];
let leagueId = "";
let cerrando = false;

function enviar(message: FromWorker): void {
  process.send?.(message);
}

/** Levanta un `Server` y promete cuando está escuchando (o rechaza si el puerto está tomado). */
function escuchar(app: http.RequestListener, port: number, host: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve(server);
    });
  });
}

async function arrancar(msg: StartMessage): Promise<void> {
  leagueId = msg.league.id;
  // El config.json de la liga vive en SU carpeta. Se fija antes de cualquier load/save.
  setConfigDir(msg.dataDir);
  const config = loadConfig();

  // Los puertos y la dirección pública los manda el portal y no son negociables: el panel de la
  // liga no los puede editar (ver la allowlist de POST /api/config). Se escriben igual en el
  // config.json para que lo que muestra el panel coincida con lo que de verdad está corriendo.
  config.http.adminPort = msg.ports.adminPort;
  config.http.clientPort = msg.ports.clientPort;
  config.acUdp.localPort = msg.ports.udpPort;
  config.http.publicHost = msg.publicIp;
  // El nombre lo manda el portal y pisa al que hubiera: es el que el operador ve y edita en su
  // tabla, y tener dos nombres editables en dos lugares termina siempre igual —el panel muestra
  // uno y la factura dice otro—. Por eso el panel lo muestra pero no lo deja cambiar.
  config.leagueName = msg.league.name;
  saveConfig(config);

  rc = await createRaceControl({
    config,
    dataDir: msg.dataDir,
    ports: { adminPort: msg.ports.adminPort, clientPort: msg.ports.clientPort },
    udpBindAddress: msg.udpBindAddress,
    clientBase: () => msg.clientBase,
  });

  // Los dos HTTP escuchan SOLO en loopback: a internet sale el portal, que es quien verifica la
  // sesión del admin y el token del piloto. Un worker alcanzable de afuera sería el panel de una
  // liga ajena abierto sin contraseña.
  servers = [
    await escuchar(rc.adminApp as unknown as http.RequestListener, msg.ports.adminPort, "127.0.0.1"),
    await escuchar(rc.clientApp as unknown as http.RequestListener, msg.ports.clientPort, "127.0.0.1"),
  ];

  enviar({ type: "ready", leagueId, ports: msg.ports });
  console.log(`[liga:${msg.league.slug}] lista — UDP ${msg.ports.udpPort}, panel ${msg.ports.adminPort}`);
}

function cerrar(code: number): void {
  if (cerrando) return;
  cerrando = true;
  for (const server of servers) server.close();
  rc?.stop();
  // `unref` en los timers ya deja al proceso salir solo, pero las conexiones HTTP vivas (el
  // polling del panel) pueden demorarlo: el exit explícito evita un hijo zombi por liga.
  process.exit(code);
}

process.on("message", (msg: ToWorker) => {
  if (msg?.type === "start") {
    arrancar(msg).catch((err) => {
      // EADDRINUSE no se arregla reintentando: el puerto se lo asignó el portal y si está tomado
      // es un error de configuración, no una caída. Se lo decimos para que no entre en un bucle.
      const fatal = (err as NodeJS.ErrnoException)?.code === "EADDRINUSE";
      enviar({ type: "error", leagueId, fatal, message: String(err) });
      cerrar(1);
    });
    return;
  }
  if (msg?.type === "stop") cerrar(0);
});

process.on("SIGTERM", () => cerrar(0));
process.on("SIGINT", () => cerrar(0));

// A diferencia del modo local, acá morir es barato: el supervisor vuelve a levantar esta liga y
// las demás ni se enteran. Lo que no se puede es seguir corriendo con el estado a medias.
process.on("uncaughtException", (err) => {
  console.error(`[liga:${leagueId}] error no controlado:`, err);
  rc?.journal.log("fatal.uncaughtException", { message: String(err), stack: err.stack });
  enviar({ type: "error", leagueId, fatal: false, message: String(err) });
  cerrar(1);
});
