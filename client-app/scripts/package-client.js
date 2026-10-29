// Arma el .zip que se le reparte a los pilotos: solo hay que arrastrarlo a Content Manager.
// Usa PowerShell (Compress-Archive) para no sumar dependencias de npm a un proyecto que ni
// siquiera tiene package.json propio.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

// El .zip se arma igual sin los sonidos —la app los chequea con `os.path.exists` y sigue— pero el
// aviso tiene que estar: un piloto al que no le suena la largada reporta "no me anda la app", y
// desde acá no hay forma de distinguirlo de un problema real.
const sounds = path.join(root, "apps", "python", "RaceControlClient", "sounds");
const esperados = [
  ["green_green_green.wav", "el audio de largada"],
  ["cut_warning.wav", "la chicharra del corte"],
  ["rolling_start.wav", "el aviso de inicio de formación"],
  ["stay_behind.wav", "el aviso de 'quedate detrás' a los 10 s de formación"],
  ["no_overtaking.wav", "el aviso de 'prohibido adelantar' a los 40 s de formación"],
];
for (const [archivo, que] of esperados) {
  const ruta = path.join(sounds, archivo);
  if (!fs.existsSync(ruta)) {
    console.warn(`ADVERTENCIA: falta ${ruta} — ${que} no va a sonar hasta que agregues ese archivo.`);
  }
}

/**
 * Fuera los `__pycache__` antes de comprimir.
 *
 * Aparecen en cuanto alguien importa el módulo desde la PC de desarrollo —un chequeo de sintaxis,
 * un editor con el linter prendido— y `Compress-Archive` se lleva la carpeta entera, así que
 * terminan adentro del `.zip` que instalan los pilotos. Son bytecode de la versión de Python que
 * los generó (3.13 acá), metidos al lado de un `.py` que corre en el intérprete 3.3 de Assetto
 * Corsa. Un `.pyc` de otra versión no se usa, pero es basura que viaja a veinticuatro PCs y es
 * exactamente el tipo de cosa que después aparece como "a mí no me anda" sin ninguna pista.
 */
function limpiarPycache(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ruta = path.join(dir, entry.name);
    if (entry.name === "__pycache__") fs.rmSync(ruta, { recursive: true, force: true });
    else limpiarPycache(ruta);
  }
}
limpiarPycache(path.join(root, "apps"));

const releaseDir = path.join(root, "release");
fs.mkdirSync(releaseDir, { recursive: true });
const zipPath = path.join(releaseDir, "RaceControlClient.zip");
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

// Se comprime la carpeta "apps" completa (no su contenido suelto) para que el .zip reproduzca
// la misma estructura "apps/python/RaceControlClient/..." que usa Content Manager.
execFileSync(
  "powershell",
  ["-NoProfile", "-Command", `Compress-Archive -Path '${path.join(root, "apps")}' -DestinationPath '${zipPath}'`],
  { stdio: "inherit" }
);

console.log(`Listo: ${zipPath}`);
