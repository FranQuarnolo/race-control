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

// El pilote no tiene forma de saber qué versión tiene instalada salvo que algo adentro del .zip se
// lo diga: ni Content Manager ni el juego lo muestran. Se genera a partir de `ui.json` (la fuente
// de verdad de la versión del cliente) para que nunca queden desincronizados, y se borra apenas
// termina de comprimir para no dejarlo como un archivo suelto en el árbol de git.
const appDir = path.join(root, "apps", "python", "RaceControlClient");
const uiJson = JSON.parse(fs.readFileSync(path.join(appDir, "ui.json"), "utf8"));
const versionTxtPath = path.join(appDir, "VERSION.txt");
fs.writeFileSync(versionTxtPath, uiJson.version + "\n", "utf8");

const releaseDir = path.join(root, "release");
fs.mkdirSync(releaseDir, { recursive: true });
const zipPath = path.join(releaseDir, "RaceControlClient.zip");
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

// Zips versionados de builds anteriores (release/ es local, no se borra solo entre corridas).
for (const entry of fs.readdirSync(releaseDir)) {
  if (/^RaceControlClient-.*\.zip$/.test(entry)) fs.rmSync(path.join(releaseDir, entry));
}

// Se comprime la carpeta "apps" completa (no su contenido suelto) para que el .zip reproduzca
// la misma estructura "apps/python/RaceControlClient/..." que usa Content Manager.
execFileSync(
  "powershell",
  ["-NoProfile", "-Command", `Compress-Archive -Path '${path.join(root, "apps")}' -DestinationPath '${zipPath}'`],
  { stdio: "inherit" }
);

fs.rmSync(versionTxtPath);

// Mismo contenido, un segundo nombre con la versión adentro: el README linkea siempre al genérico
// de arriba (no se toca en cada release), pero quien entra a la página del release a mano hoy no
// tenía forma de saber, sin bajarlo, qué versión de ui.json trae.
const versionedZipPath = path.join(releaseDir, `RaceControlClient-${uiJson.version}.zip`);
fs.copyFileSync(zipPath, versionedZipPath);

console.log(`Listo: ${zipPath}`);
console.log(`Listo: ${versionedZipPath}`);
