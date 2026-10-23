import * as fs from "fs";
import * as path from "path";
import { createPortal, portalConfigFromEnv, subscriptionOf } from "./server";
import { toSlug } from "./store";

/**
 * Salida de emergencia para quien opera el servicio. **Lo normal es hacer todo esto desde
 * `/operador`**, que es la misma funcionalidad con una pantalla delante.
 *
 *   node dist/portal/cli.js ligas                                   (lectura, siempre disponible)
 *   node dist/portal/cli.js crear-liga --nombre "Fast Sim" --email admin@liga.com
 *   node dist/portal/cli.js clave --email admin@liga.com
 *   node dist/portal/cli.js baja  --email admin@liga.com
 *   node dist/portal/cli.js alta  --email admin@liga.com --pago 2026-12-31
 *
 * Los comandos que escriben exigen el portal apagado, y el motivo es concreto: el portal tiene
 * todo `portal.json` en memoria y lo reescribe entero cada vez que algo cambia. Si el CLI tocara
 * el archivo mientras tanto, el primer guardado del portal borraría el cambio sin avisar.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** ¿Hay un portal vivo usando esta misma carpeta de datos? */
function portalCorriendo(dataRoot: string): number | null {
  const pidFile = path.join(dataRoot, "portal.pid");
  let pid: number;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // Señal 0: no manda nada, solo pregunta si el proceso existe y es alcanzable.
    process.kill(pid, 0);
    return pid;
  } catch {
    // Quedó de un cierre abrupto. El archivo miente y no hay nadie del otro lado.
    return null;
  }
}

async function main(): Promise<void> {
  const comando = process.argv[2];
  const config = portalConfigFromEnv();

  const SOLO_LECTURA = new Set(["ligas"]);
  if (comando && !SOLO_LECTURA.has(comando)) {
    const pid = portalCorriendo(config.dataRoot);
    if (pid !== null) {
      console.error(`El portal está corriendo (PID ${pid}) y escribe el mismo archivo que este comando.`);
      console.error("");
      console.error(`Hacelo desde el panel: ${config.secureCookies ? "https" : "http"}://${config.publicHost}/operador`);
      console.error("Si de verdad necesitás el CLI, pará el portal primero (fly machines stop).");
      process.exit(1);
      return;
    }
  }

  const portal = createPortal(config);

  if (comando === "ligas") {
    for (const league of portal.store.leagues()) {
      const dueño = league.ownerId ? portal.store.findUser(league.ownerId) : undefined;
      const cuota = subscriptionOf(dueño);
      const estadoCuenta = !dueño ? "sin dueño" : dueño.active ? cuota.state : "DESACTIVADA";
      console.log(
        `${league.slug.padEnd(20)} ${league.status.padEnd(9)} UDP ${league.udpPort}  ` +
          `${(dueño?.email ?? "-").padEnd(28)} ${estadoCuenta}${league.lastError ? `  — ${league.lastError}` : ""}`
      );
    }
    return;
  }

  if (comando === "crear-liga") {
    const nombre = arg("nombre");
    const email = arg("email");
    if (!nombre || !email) {
      console.error('Uso: crear-liga --nombre "Nombre de la liga" --email admin@liga.com [--slug mi-liga] [--clave ...]');
      process.exit(2);
      return;
    }
    const creds = await portal.createLeague(
      { slug: arg("slug") || toSlug(nombre), name: nombre, email, password: arg("clave") },
      { start: false }
    );
    console.log(`Liga creada: ${creds.league.name}  (/l/${creds.league.slug})`);
    console.log(`Send Address que va a ver el admin: ${portal.supervisor.sendAddressOf(creds.league)}`);
    console.log("");
    console.log("Pasale ESTO al admin:");
    console.log(`  Dirección:  ${creds.loginUrl}`);
    console.log(`  Usuario:    ${creds.user.email}`);
    console.log(`  Contraseña: ${creds.password}`);
    console.log("");
    console.log("La contraseña no se vuelve a mostrar. Si se pierde, generá otra con \"clave\".");
    console.log("La liga arranca cuando vuelvas a levantar el portal.");
    return;
  }

  const cuenta = () => {
    const email = arg("email");
    const user = email ? portal.store.findUserByEmail(email) : undefined;
    if (!user) {
      console.error('No existe esa cuenta. Mirá los emails con "ligas".');
      process.exit(1);
    }
    return user!;
  };

  if (comando === "clave") {
    const user = cuenta();
    const clave = await portal.resetPassword(user, arg("clave"));
    console.log(`Contraseña nueva para ${user.email}: ${clave}`);
    console.log("Las sesiones que tuviera abiertas quedaron cerradas.");
    return;
  }

  if (comando === "baja" || comando === "alta") {
    const user = cuenta();
    const active = comando === "alta";
    portal.store.updateUser(user.id, { active, paidUntil: arg("pago") ?? user.paidUntil });
    console.log(`${user.email}: ${active ? "reactivada" : "desactivada"}. Sus datos quedan donde estaban.`);
    console.log("Se aplica cuando vuelvas a levantar el portal.");
    return;
  }

  console.error("Comandos: ligas | crear-liga | clave | baja | alta");
  console.error("La cuenta de operador se crea sola con RC_OPERATOR_EMAIL en el arranque del portal.");
  process.exit(2);
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
