const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const releaseDir = path.join(rootDir, "release");
fs.mkdirSync(releaseDir, { recursive: true });

const pkgBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "pkg.cmd" : "pkg");

execFileSync(
  pkgBin,
  [
    "dist/index.js",
    "--config",
    "package.json",
    "--targets",
    "node22-win-x64",
    "--output",
    path.join("release", "RaceControlServer.exe"),
  ],
  {
    cwd: rootDir,
    stdio: "inherit",
    // En Windows, los binarios de node_modules/.bin son shims .cmd (scripts de batch) — hace
    // falta un shell para ejecutarlos directamente con execFileSync.
    shell: process.platform === "win32",
  }
);

const docsDir = path.join(rootDir, "docs");
if (fs.existsSync(docsDir)) {
  fs.cpSync(docsDir, path.join(releaseDir, "docs"), { recursive: true });
}

const leeme = `Race Control - servidor del admin
==================================

1. Hace doble click en RaceControlServer.exe.
2. Se va a abrir una ventana negra (no la cierres mientras uses Race Control) y el panel se va
   a abrir solo en tu navegador, en http://localhost:3000.
3. La primera vez te va a pedir el nombre de tu liga. El resto (puertos, IP publica) se detecta
   solo - no hace falta que entiendas de redes para usarlo.
4. En el panel, en la seccion "Red", vas a encontrar ya armado el texto para pegar en el panel
   de tu hosting (ej. EmperorServers). Para el detalle de donde pegarlo y por que, mira
   docs/guia-emperorservers.html.
5. El dia de carrera: abri RaceControlServer.exe y usa los botones del panel para la largada.

Para cerrarlo: cerra la ventana negra (o apreta Ctrl+C adentro de ella).

Si algo no funciona, revisa la carpeta "logs" (al lado de este .exe) - ahi queda un registro
detallado de todo lo que paso, util para pedir ayuda.
`;
fs.writeFileSync(path.join(releaseDir, "LEEME.txt"), leeme, "utf-8");

console.log(`Listo: ${releaseDir}`);
