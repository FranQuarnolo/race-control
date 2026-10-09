const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const releaseDir = path.join(rootDir, "release");
fs.mkdirSync(releaseDir, { recursive: true });

const pkgBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "pkg.cmd" : "pkg");
const exePath = path.join(releaseDir, "RaceControlServer.exe");

// NOTA: se probó parchear el .exe resultante con rcedit para que Windows lo identifique como
// "Race Control" en vez de "node" en los diálogos de SmartScreen/Firewall, pero reescribir los
// recursos del PE después de que pkg lo arma corrompe el payload embebido de pkg ("Pkg: Error
// reading from file" al arrancar). No vale el riesgo — queda documentado en el LEEME que esos
// diálogos van a aparecer y son esperables.
execFileSync(
  pkgBin,
  ["dist/index.js", "--config", "package.json", "--targets", "node22-win-x64", "--output", exePath],
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
2. Windows puede avisarte "Windows protegió su PC" (SmartScreen) porque esta app es nueva y no
   tiene una firma digital paga todavia. Es normal y seguro: hace click en "Mas informacion" y
   despues en "Ejecutar de todas formas".
3. Tambien puede aparecer un aviso del Firewall de Windows pidiendo permiso de red (puede
   aparecer identificado como "node" - es Race Control, no hace falta instalar nada aparte).
   Hace click en "Permitir acceso" - lo necesita para recibir los datos de la carrera y para que
   los pilotos puedan reportar presencia.
4. Se va a abrir una ventana negra (no la cierres mientras uses Race Control) y el panel se va
   a abrir solo en tu navegador, en http://localhost:3000.
5. La primera vez te va a pedir el nombre de tu liga. El resto (puertos, IP publica) se detecta
   solo - no hace falta que entiendas de redes para usarlo.
6. En el panel, en la seccion "Red", vas a encontrar ya armado el texto para pegar en el panel
   de tu hosting (ej. EmperorServers). Para el detalle de donde pegarlo y por que, mira
   docs/guia-emperorservers.html.
7. El dia de carrera: abri RaceControlServer.exe y usa los botones del panel para la largada.

Para cerrarlo: cerra la ventana negra (o apreta Ctrl+C adentro de ella).

Tu configuración y los registros de cada carrera se guardan en:
%APPDATA%\\RaceControl (normalmente C:\\Users\\TU_USUARIO\\AppData\\Roaming\\RaceControl)
`;
fs.writeFileSync(path.join(releaseDir, "LEEME.txt"), leeme, "utf-8");

console.log(`Listo: ${releaseDir}`);
