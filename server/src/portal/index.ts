import { createPortal, portalConfigFromEnv } from "./server";

/**
 * Entry del portal. Es el proceso que mira a internet; las ligas son hijos suyos.
 *
 * Toda la configuración viene por variables de entorno porque el destino es un contenedor: en
 * Fly.io se declaran una vez en `fly.toml` y no hay ningún archivo que editar dentro de la imagen.
 */
function main(): void {
  const config = portalConfigFromEnv();
  if (!config.publicIp) {
    console.warn(
      "[portal] RC_PUBLIC_IP está vacío: el portal no va a poder mostrarle a nadie qué pegar en el " +
        '"Send Address" de su hosting. Poné ahí la IPv4 dedicada de la app.'
    );
  }

  const portal = createPortal(config);
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

main();
