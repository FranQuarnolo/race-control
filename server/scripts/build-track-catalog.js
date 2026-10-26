/**
 * Genera el catálogo de trazados a partir de una instalación de Assetto Corsa.
 *
 *   node scripts/build-track-catalog.js "C:\\...\\assettocorsa\\content\\tracks"
 *
 * Lee la línea ideal de la IA de cada circuito (`ai/fast_lane.ai`) y escribe un JSON por pista en
 * `src/track/catalog/`. Esos JSON se empaquetan con la app y reemplazan al aprendizaje por
 * telemetría: el mapa sale dibujado desde el primer segundo, completo y con la forma real, en vez
 * de irse rellenando a pedazos a medida que alguien da vueltas.
 *
 * ---
 *
 * **Por qué la línea de la IA y no el `map.png`.** El PNG es una imagen: para sacarle la forma hay
 * que recorrer píxeles y adivinar el orden del recorrido. La línea de la IA ya es lo que hace falta
 * —una secuencia ordenada de coordenadas del mundo, las mismas en las que el servidor reporta la
 * posición de cada auto— así que el mapa y los puntitos de los autos quedan en el mismo sistema de
 * coordenadas sin convertir nada.
 *
 * **Por qué no se usa el campo `length` del archivo.** Está ahí y sería cómodo, pero obliga a
 * confiar en que ese float signifique lo que uno cree. La distancia acumulada entre puntos
 * consecutivos se calcula sola y da lo mismo: `normalizedSplinePosition` de Assetto Corsa es
 * exactamente eso, distancia recorrida sobre largo total. Un supuesto menos.
 *
 * **Qué pasa si un archivo no cuadra.** Se saltea y se avisa por consola. Un trazado torcido es
 * peor que no tener trazado: el mapa quedaría dibujando una pista que no es, y nadie lo notaría
 * hasta que un auto pase por afuera del dibujo.
 */

const fs = require("fs");
const path = require("path");

const SALIDA = path.join(__dirname, "..", "src", "track", "catalog");

/** Mismo número de tramos que usa TrackLearner: los JSON son intercambiables. */
const SLOTS = 600;

/** Cabecera del `fast_lane.ai`: versión, cantidad de puntos, y dos enteros que no se usan. */
const CABECERA_BYTES = 16;
/** Cada punto de la línea ideal: x, y, z, largo acumulado (4 floats) y un id (int). */
const PUNTO_BYTES = 20;

/** La única versión del formato que se da por conocida. Si aparece otra, mejor saltear que adivinar. */
const VERSION_ESPERADA = 7;

/** Límites de cordura. Un circuito de AC entra holgado acá; cualquier cosa afuera es basura. */
const MIN_PUNTOS = 20;
const MAX_PUNTOS = 200_000;
const MAX_COORDENADA = 100_000;

/**
 * Cuánto puede separarse el último punto del primero, como fracción del largo total.
 *
 * Un circuito cerrado vuelve a donde empezó. Si la línea termina a un 5% del largo de donde
 * arrancó, eso no es una vuelta: es un archivo de otra cosa —un pit lane, un rally point a punto,
 * una línea a medio editar— y dibujarlo daría una pista abierta con un tajo.
 */
const TOLERANCIA_CIERRE = 0.05;

function main() {
  const raiz = process.argv[2];
  if (!raiz) {
    console.error("Uso: node scripts/build-track-catalog.js <ruta a content/tracks>");
    console.error('Ejemplo: node scripts/build-track-catalog.js "C:\\Steam\\steamapps\\common\\assettocorsa\\content\\tracks"');
    process.exit(1);
  }
  if (!fs.existsSync(raiz)) {
    console.error("No existe esa carpeta: " + raiz);
    process.exit(1);
  }

  fs.mkdirSync(SALIDA, { recursive: true });

  let escritos = 0;
  let salteados = 0;
  for (const { clave, archivo } of buscarLineas(raiz)) {
    const trazado = leerTrazado(archivo);
    if (!trazado) {
      salteados += 1;
      continue;
    }
    const destino = path.join(SALIDA, clave + ".json");
    fs.writeFileSync(destino, JSON.stringify({ track: clave, ...trazado }), "utf-8");
    console.log("  ok  " + clave + " (" + trazado.points.length + " puntos)");
    escritos += 1;
  }

  console.log("");
  console.log(escritos + " trazados escritos en src/track/catalog/, " + salteados + " salteados.");
  if (escritos === 0) {
    console.error("No se generó ninguno. ¿La ruta apunta a content/tracks?");
    process.exit(1);
  }
}

/**
 * Encuentra los `fast_lane.ai` y arma la clave de cada uno.
 *
 * Assetto Corsa guarda los circuitos de dos formas y hay que soportar las dos: los de un solo
 * trazado tienen `<pista>/ai/fast_lane.ai`, y los que tienen variantes —Spa con y sin chicane,
 * Nordschleife turístico y endurance— tienen una carpeta por variante,
 * `<pista>/<variante>/ai/fast_lane.ai`. La clave lleva la variante adentro porque son dibujos
 * distintos: compartir una sola entre todas dibujaría la pista equivocada.
 */
function* buscarLineas(raiz) {
  for (const pista of fs.readdirSync(raiz, { withFileTypes: true })) {
    if (!pista.isDirectory()) continue;
    const base = path.join(raiz, pista.name);

    const simple = path.join(base, "ai", "fast_lane.ai");
    if (fs.existsSync(simple)) {
      yield { clave: normalizar(pista.name), archivo: simple };
      continue;
    }

    for (const variante of fs.readdirSync(base, { withFileTypes: true })) {
      if (!variante.isDirectory() || variante.name === "ui" || variante.name === "data") continue;
      const conVariante = path.join(base, variante.name, "ai", "fast_lane.ai");
      if (fs.existsSync(conVariante)) {
        yield { clave: normalizar(pista.name + "__" + variante.name), archivo: conVariante };
      }
    }
  }
}

/** Mismo saneo que `normalizeTrackName` en trackLearner.ts: las claves tienen que coincidir. */
function normalizar(nombre) {
  return (nombre || "desconocido").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
}

/** Lee un `fast_lane.ai` y devuelve el trazado remuestreado, o `null` si el archivo no cuadra. */
function leerTrazado(archivo) {
  let buf;
  try {
    buf = fs.readFileSync(archivo);
  } catch (err) {
    console.warn("  --  " + archivo + ": no se pudo leer (" + err.message + ")");
    return null;
  }

  if (buf.length < CABECERA_BYTES) return avisar(archivo, "archivo demasiado chico");

  const version = buf.readInt32LE(0);
  const cantidad = buf.readInt32LE(4);
  if (version !== VERSION_ESPERADA) return avisar(archivo, "versión " + version + ", se esperaba " + VERSION_ESPERADA);
  if (cantidad < MIN_PUNTOS || cantidad > MAX_PUNTOS) return avisar(archivo, cantidad + " puntos declarados");
  if (buf.length < CABECERA_BYTES + cantidad * PUNTO_BYTES) return avisar(archivo, "declara más puntos de los que entran");

  const crudos = [];
  for (let i = 0; i < cantidad; i++) {
    const off = CABECERA_BYTES + i * PUNTO_BYTES;
    const x = buf.readFloatLE(off);
    const z = buf.readFloatLE(off + 8); // el +4 es la altura, que no se dibuja
    if (!Number.isFinite(x) || !Number.isFinite(z)) return avisar(archivo, "coordenadas no numéricas");
    if (Math.abs(x) > MAX_COORDENADA || Math.abs(z) > MAX_COORDENADA) {
      return avisar(archivo, "coordenadas fuera de rango");
    }
    crudos.push({ x, z });
  }

  // Distancia acumulada: es la misma magnitud que `normalizedSplinePosition`.
  const acumulado = [0];
  for (let i = 1; i < crudos.length; i++) {
    acumulado.push(acumulado[i - 1] + distancia(crudos[i - 1], crudos[i]));
  }
  const largo = acumulado[acumulado.length - 1];
  if (largo <= 0) return avisar(archivo, "largo total cero");

  const cierre = distancia(crudos[0], crudos[crudos.length - 1]);
  if (cierre / largo > TOLERANCIA_CIERRE) {
    return avisar(archivo, "la línea no cierra (quedan " + Math.round(cierre) + " m entre el final y el principio)");
  }

  return remuestrear(crudos, acumulado, largo);
}

function avisar(archivo, motivo) {
  console.warn("  --  " + path.basename(path.dirname(path.dirname(archivo))) + ": " + motivo);
  return null;
}

function distancia(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Lleva la línea a los 600 tramos del formato, repartidos parejo a lo largo de la vuelta.
 *
 * La línea de la IA trae miles de puntos y están repartidos de forma despareja —muchos en las
 * curvas, pocos en las rectas—. Remuestrear por distancia da un punto cada tantos metros, que es
 * lo que el dibujo necesita y lo que ya producía el aprendizaje por telemetría.
 */
function remuestrear(crudos, acumulado, largo) {
  const points = [];
  let i = 0;
  for (let slot = 0; slot < SLOTS; slot++) {
    const objetivo = (slot / SLOTS) * largo;
    while (i < acumulado.length - 2 && acumulado[i + 1] < objetivo) i++;
    // Interpolación lineal entre los dos puntos que rodean a la distancia buscada.
    const tramo = acumulado[i + 1] - acumulado[i];
    const t = tramo > 0 ? (objetivo - acumulado[i]) / tramo : 0;
    points.push({
      s: slot / SLOTS,
      x: redondear(crudos[i].x + (crudos[i + 1].x - crudos[i].x) * t),
      z: redondear(crudos[i].z + (crudos[i + 1].z - crudos[i].z) * t),
    });
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }

  // `coverage: 1` no es optimismo: el trazado está entero porque salió del archivo del circuito,
  // no de ver pasar autos. Es lo que hace que el panel no muestre nunca la barra de "aprendiendo".
  return { points, bounds: { minX, maxX, minZ, maxZ }, coverage: 1 };
}

/** Un decimal alcanza y sobra para metros, y recorta el JSON a menos de la mitad. */
function redondear(n) {
  return Math.round(n * 10) / 10;
}

main();
