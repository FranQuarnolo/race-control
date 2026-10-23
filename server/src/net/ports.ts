import * as net from "net";

/**
 * Busca un puerto libre a partir del preferido.
 *
 * Existe porque el fallo de "puerto ocupado" es invisible para el usuario al que apunta el
 * producto: hasta ahora, si otra aplicación tenía tomado el 3000, el `listen` tiraba un
 * `EADDRINUSE` que se imprimía por consola — y en el `.exe` empaquetado la consola se cierra sola.
 * El admin veía una ventana que aparece y desaparece, sin ninguna explicación.
 *
 * Correrse de puerto es seguro para los dos que usa Race Control:
 * - el del panel es loopback y se abre solo en el navegador, así que el número da igual;
 * - el de los pilotos viaja hasta cada cliente en el anuncio del backend, así que también se
 *   propaga solo. Lo único que NO se propaga es una redirección de puertos hecha a mano en el
 *   router, y por eso el cambio se avisa en el panel en vez de hacerse en silencio.
 */
export async function findFreePort(
  preferred: number,
  host: string,
  // Puertos ya reservados por este mismo proceso. Hacen falta porque la búsqueda corre antes de
  // que nadie haga `listen`: con el 3000 ocupado, el panel se corre al 3001 y la búsqueda del
  // puerto de pilotos —que arranca justamente en 3001— lo encontraría "libre", porque todavía no
  // lo tomó nadie. Los dos listen saldrían al mismo número y el segundo moriría con EADDRINUSE.
  taken: readonly number[] = [],
  attempts = 20
): Promise<number> {
  for (let port = preferred; port < preferred + attempts && port <= 65535; port++) {
    if (taken.indexOf(port) === -1 && (await isPortFree(port, host))) return port;
  }
  // Si veinte puertos seguidos están ocupados, lo que pasa no es "está ocupado": devolvemos el
  // preferido para que el `listen` falle con su error real en vez de esconderlo detrás del nuestro.
  return preferred;
}

function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}
