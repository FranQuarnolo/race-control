const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const releaseDir = path.join(rootDir, "release");
const buildDir = path.join(rootDir, "build");
fs.mkdirSync(releaseDir, { recursive: true });
fs.mkdirSync(buildDir, { recursive: true });

const pkgBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "pkg.cmd" : "pkg");
const exePath = path.join(releaseDir, "RaceControlServer.exe");
const target = "node22-win-x64";
const version = require(path.join(rootDir, "package.json")).version;

/**
 * Ícono y nombre del ejecutable.
 *
 * El intento anterior (documentado en el CHANGELOG 0.2.1) corría `rcedit` sobre el `.exe` ya
 * armado por pkg y corrompía su payload: "Pkg: Error reading from file" al arrancar. El
 * diagnóstico era correcto pero la conclusión no: el problema es el ORDEN, no la herramienta.
 *
 * Acá se marca el **binario base** de Node —antes de que pkg le inyecte nada— y después se le
 * dice a pkg que use ese binario marcado en vez del de su caché, con `PKG_NODE_PATH`. Como rcedit
 * toca el PE cuando todavía no hay payload, no hay nada que corromper.
 *
 * `PKG_NODE_PATH` además saltea la verificación de hash del binario base (ver
 * `@yao-pkg/pkg-fetch/lib-es5/index.js`), que es justamente lo que haría fallar un binario
 * modificado.
 *
 * Qué cambia para el usuario: el `.exe` muestra el logo en el Explorador, y SmartScreen y el
 * Firewall dicen "Race Control" en vez de "node" — que es el momento exacto en que hoy un admin
 * no técnico desconfía y cierra todo. La firma digital, lo único que saca el aviso de SmartScreen
 * del todo, necesita un certificado pago y queda afuera.
 */
async function brandedBaseBinary() {
  const iconPath = path.join(rootDir, "..", "brand", "icon.ico");
  if (!fs.existsSync(iconPath)) {
    console.warn(`No está ${iconPath}: el .exe sale con el ícono de Node.`);
    return null;
  }

  // El binario base de Node para el target, bajándolo a la caché si todavía no está.
  const { need } = require("@yao-pkg/pkg-fetch");
  const stock = await need({ nodeRange: "node22", platform: "win", arch: "x64" });

  // Copia propia: marcar el de la caché lo dejaría modificado para cualquier otro proyecto que
  // use pkg en esta máquina, y la próxima verificación de hash lo borraría y lo volvería a bajar.
  const branded = path.join(buildDir, "node-racecontrol.exe");
  fs.copyFileSync(stock, branded);

  const { rcedit } = require("rcedit");
  await rcedit(branded, {
    icon: iconPath,
    "version-string": {
      ProductName: "Race Control",
      FileDescription: "Race Control - control de carrera para Assetto Corsa",
      CompanyName: "Race Control",
      LegalCopyright: "",
      OriginalFilename: "RaceControlServer.exe",
      InternalName: "RaceControlServer",
    },
    // Windows exige cuatro números acá, aunque la versión de producto sea de dos.
    "file-version": `${version}.0`,
    "product-version": `${version}.0`,
  });
  return branded;
}

// La guía de conexión ya no se copia suelta al release: vive dentro del panel
// (src/api/public/docs/guia-conexion.html) y se abre desde el botón "Conexión". Un HTML suelto en
// la carpeta de descarga es un archivo que el admin encuentra antes de abrir la app, cuando
// todavía no tiene la pantalla delante para seguir los pasos. Lo que queda en server/docs/ es
// documentación interna del proyecto y no tiene por qué viajar al usuario final.

const leeme = `Race Control - servidor del admin
==================================

Antes de empezar: esto es la version para correr en TU PC. Desde la 0.4 hay tambien un portal
web donde no hace falta descargar nada, ni abrir puertos, ni dejar una ventana abierta: entras
con tu usuario y listo. Si lo preferis, pedi tu liga en:
https://github.com/FranQuarnolo/race-control

Si vas a usar esta version, sigue estos pasos:

1. Hace doble click en RaceControlServer.exe.
2. Windows puede avisarte "Windows protegió su PC" (SmartScreen) porque esta app es nueva y no
   tiene una firma digital paga todavia. Es normal y seguro: hace click en "Mas informacion" y
   despues en "Ejecutar de todas formas".
3. Tambien puede aparecer un aviso del Firewall de Windows pidiendo permiso de red, identificado
   como "Race Control". Hace click en "Permitir acceso" - lo necesita para recibir los datos de la
   carrera y para que los pilotos puedan reportar presencia.
4. Se va a abrir una ventana negra (no la cierres mientras uses Race Control) y el panel se va
   a abrir solo en tu navegador, en http://localhost:3000. Si ese puerto esta ocupado por otro
   programa, Race Control usa el siguiente libre y abre el navegador ahi: no tenes que hacer nada.
5. La primera vez te va a guiar un asistente de 4 pasos: nombre de tu liga, tipo de torneo,
   conexion con tu servidor, y una comprobacion en vivo de que todo llega. No hace falta que
   entiendas de redes para usarlo.
6. Cuando quieras volver a ver esos datos, el boton "Conexion" (arriba a la derecha) tiene el
   texto listo para pegar en el panel de tu hosting, un boton "Probar ahora" que te dice que
   falta, y la guia paso a paso con el detalle de donde pegarlo en cada hosting.
7. El dia de carrera: abri RaceControlServer.exe y usa los botones del panel para la largada.
8. Cuando termine, el boton "Sanciones" tiene "Descargar informe de carrera": una planilla con la
   clasificacion, los segundos de penalizacion de cada piloto y los incidentes revisados.

Para cerrarlo: cerra la ventana negra (o apreta Ctrl+C adentro de ella).

Tu configuración y los registros de cada carrera se guardan en:
%APPDATA%\\RaceControl (normalmente C:\\Users\\TU_USUARIO\\AppData\\Roaming\\RaceControl)
`;

(async () => {
  const branded = await brandedBaseBinary();

  execFileSync(pkgBin, ["dist/index.js", "--config", "package.json", "--targets", target, "--output", exePath], {
    cwd: rootDir,
    stdio: "inherit",
    // En Windows, los binarios de node_modules/.bin son shims .cmd (scripts de batch) — hace
    // falta un shell para ejecutarlos directamente con execFileSync.
    shell: process.platform === "win32",
    env: branded ? { ...process.env, PKG_NODE_PATH: branded } : process.env,
  });

  fs.writeFileSync(path.join(releaseDir, "LEEME.txt"), leeme, "utf-8");
  console.log(`Listo: ${releaseDir}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
