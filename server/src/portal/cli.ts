import { createPortal, portalConfigFromEnv } from "./server";
import { toSlug } from "./store";

/**
 * Comandos de operación del portal. No son para el admin de una liga: son para quien opera el
 * servicio (o sea, vos).
 *
 *   node dist/portal/cli.js crear-liga --nombre "Fast Sim League" --email admin@liga.com
 *   node dist/portal/cli.js ligas
 *   node dist/portal/cli.js invitar --slug fsl --email otro@liga.com
 *   node dist/portal/cli.js clave --email admin@liga.com
 *
 * El alta es por invitación y no por registro abierto a propósito: cada liga ocupa un puerto UDP
 * de un rango chico y declarado a mano en `fly.toml`. Un formulario público agotaría el rango el
 * primer día.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const comando = process.argv[2];
  const portal = createPortal(portalConfigFromEnv());

  if (comando === "crear-liga") {
    const nombre = arg("nombre");
    const email = arg("email");
    if (!nombre || !email) {
      console.error('Uso: crear-liga --nombre "Nombre de la liga" --email admin@liga.com [--slug mi-liga]');
      process.exit(2);
    }
    const slug = arg("slug") || toSlug(nombre);
    const { league, inviteUrl } = portal.createLeague({ slug, name: nombre, email });
    console.log(`Liga creada: ${league.name}  (/l/${league.slug})`);
    console.log(`Puerto UDP:  ${league.udpPort}`);
    console.log(`Send Address que va a ver el admin: ${portal.supervisor.sendAddressOf(league)}`);
    console.log("");
    console.log("Pasale ESTE link al admin (vence en 48 h y sirve una sola vez):");
    console.log(`  ${inviteUrl}`);
    return;
  }

  if (comando === "ligas") {
    for (const league of portal.store.leagues()) {
      const owner = league.ownerId ? portal.store.findUser(league.ownerId)?.email : "(sin dueño todavía)";
      console.log(
        `${league.slug.padEnd(20)} ${league.status.padEnd(9)} UDP ${league.udpPort}  ${owner}${league.lastError ? `  — ${league.lastError}` : ""}`
      );
    }
    return;
  }

  if (comando === "invitar") {
    const slug = arg("slug");
    const email = arg("email");
    if (!slug || !email) {
      console.error("Uso: invitar --slug mi-liga --email alguien@liga.com");
      process.exit(2);
    }
    const league = portal.store.findLeagueBySlug(slug);
    if (!league) {
      console.error(`No existe la liga /l/${slug}.`);
      process.exit(1);
      return;
    }
    console.log(portal.invite(league, email));
    return;
  }

  if (comando === "clave") {
    const email = arg("email");
    const user = email ? portal.store.findUserByEmail(email) : undefined;
    if (!user) {
      console.error("No existe esa cuenta.");
      process.exit(1);
      return;
    }
    // No se resetea la contraseña desde acá: se manda una invitación nueva a la misma liga y el
    // admin elige la suya. Así nadie —ni vos— tipea nunca la contraseña de otro.
    console.log(
      `Para que ${user.email} recupere el acceso, generá una invitación a su liga con "invitar" y pasásela.`
    );
    return;
  }

  console.error("Comandos: crear-liga | ligas | invitar | clave");
  process.exit(2);
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
