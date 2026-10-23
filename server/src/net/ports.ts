import * as net from "net";

/**
 * Busca un puerto libre a partir del preferido.
 *
 * El portal le asigna a cada liga sus puertos de un pool, así que en condiciones normales esto no
 * se usa. Queda para el replay y los tests, que levantan motores sueltos sin pasar por el portal y
 * no tienen forma de saber qué está ocupado en la máquina de quien los corre.
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
