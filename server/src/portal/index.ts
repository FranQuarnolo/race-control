import * as fs from "fs";
import * as path from "path";
import { createPortal, portalConfigFromEnv } from "./server";

/**
 * Entry del portal. Es el proceso que mira a internet; las ligas son hijos suyos.
 *
 * Toda la configuración viene por variables de entorno porque el destino es un contenedor: en
 * Fly.io se declaran una vez en `fly.toml` y no hay ningún archivo que editar dentro de la imagen.
 */
async function main(): Promise<void> {
  const config = portalConfigFromEnv();
  if (!config.publicIp) {
    console.warn(
      "[portal] RC_PUBLIC_IP está vacío: el portal no va a poder mostrarle a nadie qué pegar en el " +
        '"Send Address" de su hosting. Poné ahí la IPv4 dedicada de la app.'
    );
  }

  const portal = createPortal(config);

  /**
   * La primera cuenta de operador sale del entorno, no de un comando.
   *
   * Es el único huevo-y-gallina del sistema: las cuentas se crean desde el panel del operador, y a
   * ese panel solo entra un operador. Resolverlo por CLI no alcanza, porque el CLI y el portal
   * escriben el mismo `portal.json` y el que corre segundo pisa al primero. Acá lo hace el propio
   * portal, antes de empezar a atender, y la contraseña queda en el log una sola vez.
   */
  const operadorEmail = process.env.RC_OPERATOR_EMAIL;
  if (operadorEmail) {
    try {
      const clave = await portal.ensureOperator(operadorEmail, process.env.RC_OPERATOR_PASSWORD);
      if (clave) {
        console.log("");
        console.log("====================================================================");
        console.log(`  Cuenta de operador creada: ${operadorEmail}`);
        console.log(`  Contraseña: ${clave}`);
        console.log("  Anotala: este mensaje no se repite en el próximo arranque.");
        console.log("====================================================================");
        console.log("");
      }
    } catch (err) {
      console.error(`[portal] no pude crear la cuenta de operador: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    console.warn(
      "[portal] RC_OPERATOR_EMAIL no está puesto. Sin eso no hay con qué entrar a /operador: " +
        "ponelo con `fly secrets set RC_OPERATOR_EMAIL=...` y mirá el log del próximo arranque."
    );
  }

  /**
   * Sin dirección de contacto, varias pantallas se quedan sin su único camino de salida.
   *
   * No es fatal —todas caen a "pedíselo a quien te dio el acceso", que es verdad— pero sí es una
   * pérdida silenciosa: la pantalla de ingreso deja de ofrecer recuperación de contraseña y el
   * cierre de la landing se queda sin su botón principal. Vale un renglón en el log.
   */
  if (!config.contact) {
    console.warn(
      "[portal] RC_CONTACT no está puesto. La recuperación de contraseña, el alta de ligas y los " +
        "diagnósticos que dependen de nosotros quedan sin a dónde mandar a la gente. Ponelo con " +
        "`fly secrets set RC_CONTACT=mailto:tu@mail.com` (también vale un link de Discord)."
    );
  }

  // Marca de "el portal está corriendo", para que el CLI no escriba el mismo archivo a la vez.
  const pidFile = path.join(config.dataRoot, "portal.pid");
  fs.writeFileSync(pidFile, String(process.pid), "utf-8");

  const server = portal.app.listen(config.port, "0.0.0.0", () => {
    console.log(`[portal] escuchando en :${config.port} — público en ${config.publicHost}`);
    console.log(`[portal] puertos UDP para ligas: ${config.udpPortFrom}-${config.udpPortTo}`);
    portal.supervisor.startAll();
  });

  let cerrando = false;
  const cerrar = (signal: string) => {
    if (cerrando) return;
    cerrando = true;
    console.log(`[portal] cerrando (${signal})...`);
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Si no está, mejor: el CLI ya lo considera muerto.
    }
    portal.supervisor.shutdown();
    server.close(() => process.exit(0));
    // Las conexiones de polling del panel pueden demorar el `close`: 5 s y se corta igual, que
    // es lo que hace el orquestador de todos modos antes de mandar SIGKILL.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => cerrar("SIGTERM"));
  process.on("SIGINT", () => cerrar("SIGINT"));

  // El portal NO se cae por un error no controlado: adentro suyo están las sesiones de todas las
  // ligas, y cortarlo por un bug de una ruta es el peor cambio posible. Se registra y sigue.
  process.on("uncaughtException", (err) => {
    console.error("[portal] error no controlado (sigo corriendo):", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[portal] promesa sin manejar (sigo corriendo):", err);
  });
}

main().catch((err) => {
  console.error("[portal] no pude arrancar:", err);
  process.exit(1);
});
