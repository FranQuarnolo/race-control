const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

// Dos carpetas de estáticos y no una: la del panel viaja adentro del .exe (está declarada en
// `pkg.assets` del package.json) y la del portal no, porque el .exe no tiene portal. Mezclarlas
// metería las pantallas de login en el ejecutable del admin, que no las usa nunca.
const carpetas = [
  ["src/api/public", "dist/api/public"],
  ["src/portal/public", "dist/portal/public"],
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
