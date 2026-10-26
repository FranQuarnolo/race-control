const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

// Dos carpetas de estáticos y no una: la del panel la sirve el worker de cada liga, en su puerto
// de loopback, y la del portal la sirve el proceso que mira a internet. Son dos servidores
// distintos con dos raíces distintas; juntarlas haría que cualquiera de los dos pudiera servir
// archivos del otro.
const carpetas = [
  ["src/api/public", "dist/api/public"],
  ["src/portal/public", "dist/portal/public"],
  // El catálogo de trazados son JSON, y `tsc` solo emite TypeScript: sin esta línea la carpeta no
  // llega a `dist/`, `loadFromCatalog()` no encuentra nada y el mapa vuelve a salir vacío —en
  // producción, en silencio, y andando perfecto en desarrollo.
  ["src/track/catalog", "dist/track/catalog"],
];

for (const [desde, hacia] of carpetas) {
  const src = path.join(root, desde);
  const dest = path.join(root, hacia);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, dest, { recursive: true });
  console.log(`Copiado ${src} -> ${dest}`);
}

// El logo es uno solo y vive con el panel: copiarlo también al portal evita tener dos archivos
// que se pueden desincronizar la próxima vez que cambie la marca.
const icono = path.join(root, "src/api/public/icon.svg");
if (fs.existsSync(icono)) {
  fs.copyFileSync(icono, path.join(root, "dist/portal/public/icon.svg"));
}
