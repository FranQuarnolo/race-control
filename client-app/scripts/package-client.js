// Arma el .zip que se le reparte a los pilotos: solo hay que arrastrarlo a Content Manager.
// Usa PowerShell (Compress-Archive) para no sumar dependencias de npm a un proyecto que ni
// siquiera tiene package.json propio.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const soundPath = path.join(root, "apps", "python", "RaceControlClient", "sounds", "green_green_green.wav");
if (!fs.existsSync(soundPath)) {
  console.warn(
    "ADVERTENCIA: falta " +
      soundPath +
      " — el audio de largada no va a sonar hasta que agregues ese archivo " +
      "(un .wav corto tipo 'green green green', libre de derechos)."
  );
}

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
