# Junta los trazados de Assetto Corsa en un zip, para generar el catálogo en otra PC.
#
#   powershell -ExecutionPolicy Bypass -File recolectar-trazados.ps1
#
# Para qué: `build-track-catalog.js` necesita los archivos del juego, y el juego puede estar en una
# PC que no es la de desarrollo. Copiar `content\tracks` entero son decenas de GB (son los modelos
# 3D y las texturas de cada circuito); los `fast_lane.ai`, que es lo único que se lee, son unos
# pocos MB en total. Este script se queda solo con esos.
#
# No instala nada ni necesita Node: PowerShell ya está en cualquier Windows. Tampoco toca el juego,
# solo lee.

param(
  # Ruta a la carpeta del juego o directamente a `content\tracks`. Si no se pasa, se busca sola.
  [string]$Juego = "",
  # Dónde dejar el zip. Por defecto, el Escritorio: es el lugar donde después se encuentra.
  [string]$Salida = (Join-Path ([Environment]::GetFolderPath("Desktop")) "trazados-ac.zip")
)

$ErrorActionPreference = "Stop"

function Buscar-Tracks {
  param([string]$Pista)
  if (-not $Pista) { return $null }
  # Se acepta tanto la carpeta del juego como `content\tracks` directamente: el que corre esto no
  # tiene por qué saber cuál de las dos le estamos pidiendo.
  $candidatos = @($Pista, (Join-Path $Pista "content\tracks"))
  foreach ($c in $candidatos) {
    if (Test-Path (Join-Path $c "ks_monza")) { return $c }
    if ((Test-Path $c) -and (Get-ChildItem $c -Directory -ErrorAction SilentlyContinue | Where-Object {
          Test-Path (Join-Path $_.FullName "ai\fast_lane.ai")
        })) { return $c }
  }
  return $null
}

function Detectar-Juego {
  $rutas = @()

  # Steam anota su propia carpeta en el registro, y las bibliotecas extra (otro disco, un SSD
  # aparte) en `libraryfolders.vdf`. Sin leer ese archivo, una instalación fuera del disco C
  # quedaría sin detectar, que es el caso más común en una PC de simracing.
  try {
    $steam = (Get-ItemProperty "HKCU:\Software\Valve\Steam" -ErrorAction Stop).SteamPath
    if ($steam) {
      $rutas += $steam
      $vdf = Join-Path $steam "steamapps\libraryfolders.vdf"
      if (Test-Path $vdf) {
        foreach ($linea in Get-Content $vdf) {
          if ($linea -match '"path"\s+"(.+?)"') { $rutas += $Matches[1].Replace("\\", "\") }
        }
      }
    }
  } catch {}

  $rutas += "C:\Program Files (x86)\Steam"
  $rutas += "D:\Steam"

  foreach ($r in $rutas) {
    $ac = Join-Path $r "steamapps\common\assettocorsa"
    $tracks = Buscar-Tracks $ac
    if ($tracks) { return $tracks }
  }
  return $null
}

$tracks = Buscar-Tracks $Juego
if (-not $tracks) { $tracks = Detectar-Juego }

if (-not $tracks) {
  Write-Host ""
  Write-Host "No encontre Assetto Corsa." -ForegroundColor Red
  Write-Host "Pasame la ruta a mano, por ejemplo:"
  Write-Host '  powershell -ExecutionPolicy Bypass -File recolectar-trazados.ps1 -Juego "D:\SteamLibrary\steamapps\common\assettocorsa"'
  exit 1
}

Write-Host "Circuitos en: $tracks"

$temp = Join-Path $env:TEMP ("trazados-" + [guid]::NewGuid().ToString("N"))
$destinoRaiz = Join-Path $temp "tracks"
New-Item -ItemType Directory -Path $destinoRaiz -Force | Out-Null

$archivos = Get-ChildItem $tracks -Recurse -Filter "fast_lane.ai" -File -ErrorAction SilentlyContinue
$copiados = 0
foreach ($a in $archivos) {
  # Se preserva la ruta relativa tal cual porque la estructura ES el dato: de ella sale el nombre
  # del circuito y el de la variante. Copiar todo aplanado perdería cuál es cuál.
  $relativa = $a.FullName.Substring($tracks.Length).TrimStart("\")
  $destino = Join-Path $destinoRaiz $relativa
  New-Item -ItemType Directory -Path (Split-Path $destino) -Force | Out-Null
  Copy-Item $a.FullName $destino
  $copiados++
}

if ($copiados -eq 0) {
  Write-Host "No habia ningun fast_lane.ai ahi adentro. Revisa la ruta." -ForegroundColor Red
  Remove-Item $temp -Recurse -Force
  exit 1
}

if (Test-Path $Salida) { Remove-Item $Salida -Force }
Compress-Archive -Path $destinoRaiz -DestinationPath $Salida
Remove-Item $temp -Recurse -Force

$mb = [math]::Round((Get-Item $Salida).Length / 1MB, 1)
Write-Host ""
Write-Host "Listo: $copiados trazados, $mb MB" -ForegroundColor Green
Write-Host "  $Salida"
Write-Host ""
Write-Host "Pasa ese archivo a la PC donde esta Race Control."
