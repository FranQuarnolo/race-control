import { exec } from "child_process";
import { getConfigDir, loadConfig } from "./config";
import { createRaceControl } from "./core/raceControl";

export { createRaceControl, RaceControl, RaceControlOptions } from "./core/raceControl";

/**
 * Entry del modo local: el `.exe` que abre el admin en su propia PC.
 *
 * Todo lo que es "soy el dueño de este proceso" vive acá y no en el núcleo —los handlers de
 * señales, el `process.exit`, abrir el navegador— porque en el portal el mismo núcleo corre como
 * un worker entre varios y un `process.exit` ante un error de UNA liga se llevaría puestas a
 * todas las demás.
 */
async function main() {
  const config = loadConfig();
  const rc = await createRaceControl({ config, dataDir: getConfigDir(), mode: "local" });

  // Puerto A: panel y API de administración — SIEMPRE loopback-only, nunca expuesto a internet.
  rc.adminApp.listen(rc.ports.adminPort, "127.0.0.1", () => {
    console.log(`Panel admin: http://localhost:${rc.ports.adminPort}`);
    openBrowser(`http://localhost:${rc.ports.adminPort}`);
  });

  // Puerto B: lo que reporta el cliente Python (poll/heartbeat) — este es el que se expone/forwardea.
  rc.clientApp.listen(rc.ports.clientPort, "0.0.0.0", () => {
    console.log(`Endpoints de cliente: puerto ${rc.ports.clientPort} (0.0.0.0)`);
  });

  console.log(`UDP: escuchando en :${config.acUdp.localPort}, enviando a ${config.acUdp.remoteHost}:${config.acUdp.remotePort}`);
  if (config.shadowMode) {
    console.log("MODO SOMBRA activo: el motor detecta y registra, pero no aplica sanciones/kicks reales.");
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nCerrando race-control (${signal})...`);
    rc.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Un error no controlado puede dejar el estado de sanciones a medio camino — mejor cortar y
  // que el admin lo reinicie (el journal queda como evidencia de qué pasó) que seguir corriendo
  // con un estado potencialmente corrupto.
  process.on("uncaughtException", (err) => {
    console.error("[race-control] Error no controlado, cerrando:", err);
    rc.journal.log("fatal.uncaughtException", { message: String(err), stack: err.stack });
    rc.stop();
    process.exit(1);
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err: Error | null) => {
    if (err) console.error("[race-control] No se pudo abrir el navegador automáticamente:", err.message);
  });
}

main().catch((err) => {
  console.error("[race-control] No se pudo arrancar:", err);
  process.exit(1);
});
