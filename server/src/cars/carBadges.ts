import * as fs from "fs";
import * as path from "path";

/**
 * Marca y logo del auto que maneja cada piloto.
 *
 * El logo sale de una **biblioteca de logos empaquetada con la app** (`api/public/brands/`): 126
 * SVG de marcas, armados con los sets MIT `car-brand-logos` y `car-makes-icons`. Ver
 * `brands/LEEME.md` para la procedencia exacta y cómo actualizarla.
 *
 * Antes se leían del `content/cars/<modelo>/ui/badge.png` de la instalación local de Assetto
 * Corsa. Funcionaba, pero obligaba a que el admin tuviera el juego instalado en la misma PC que
 * el backend —que no es el caso de quien dirige la carrera sin correrla— y a hurgar en el
 * registro de Steam para encontrarlo. Con la biblioteca empaquetada el logo se ve siempre, sin
 * configurar nada, que es el objetivo del producto.
 *
 * Qué pasa con una marca que no está en la biblioteca (autos mod, marcas chicas como Praga o
 * Tatuus): `brandSlug` devuelve `null` y el panel dibuja un escudo con el monograma de la marca
 * en su color. Nunca queda un hueco vacío.
 */

/** Marcas del contenido base de AC más las que aparecen en los packs de mods más usados. La clave
 * va sin separadores para que matcheen igual `alfa_romeo`, `alfaromeo` y `alfa`. */
const BRANDS: Array<[string, string]> = [
  ["abarth", "Abarth"],
  ["acura", "Acura"],
  ["alfaromeo", "Alfa Romeo"],
  ["alfa", "Alfa Romeo"],
  ["alpine", "Alpine"],
  ["astonmartin", "Aston Martin"],
  ["audi", "Audi"],
  ["bentley", "Bentley"],
  ["bmw", "BMW"],
  ["brabham", "Brabham"],
  ["bugatti", "Bugatti"],
  ["cadillac", "Cadillac"],
  ["chevrolet", "Chevrolet"],
  ["citroen", "Citroën"],
  ["corvette", "Chevrolet Corvette"],
  ["dallara", "Dallara"],
  ["datsun", "Datsun"],
  ["dodge", "Dodge"],
  ["ferrari", "Ferrari"],
  ["fiat", "Fiat"],
  ["ford", "Ford"],
  ["glickenhaus", "Glickenhaus"],
  ["honda", "Honda"],
  ["hyundai", "Hyundai"],
  ["jaguar", "Jaguar"],
  ["jeep", "Jeep"],
  ["koenigsegg", "Koenigsegg"],
  ["ktm", "KTM"],
  ["lamborghini", "Lamborghini"],
  ["lancia", "Lancia"],
  ["lexus", "Lexus"],
  ["lotus", "Lotus"],
  ["maserati", "Maserati"],
  ["matra", "Matra"],
  ["mazda", "Mazda"],
  ["mclaren", "McLaren"],
  ["mercedes", "Mercedes-Benz"],
  ["mini", "MINI"],
  ["mitsubishi", "Mitsubishi"],
  ["nissan", "Nissan"],
  ["opel", "Opel"],
  ["pagani", "Pagani"],
  ["peugeot", "Peugeot"],
  ["porsche", "Porsche"],
  ["praga", "Praga"],
  ["renault", "Renault"],
  ["rss", "Race Sim Studio"],
  ["ruf", "RUF"],
  ["shelby", "Shelby"],
  ["subaru", "Subaru"],
  ["tatuus", "Tatuus"],
  ["tesla", "Tesla"],
  ["toyota", "Toyota"],
  ["volkswagen", "Volkswagen"],
  ["vw", "Volkswagen"],
];

/** Prefijo de autor, no de marca: `ks_` es Kunos Simulazioni, el estudio. Sacarlo deja a la vista
 * la marca real, que es el token siguiente. */
const AUTHOR_PREFIXES = ["ks_"];

/** Deduce la marca del nombre del modelo (`ks_ferrari_488_gt3` → "Ferrari"). Si no reconoce
 * ninguna, devuelve el nombre del modelo presentable, que sigue siendo más útil que nada. */
export function brandOf(carModel: string): string {
  if (!carModel) return "";
  let normalized = carModel.toLowerCase();
  for (const prefix of AUTHOR_PREFIXES) {
    if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
  }
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  // Más larga primero: sin esto `alfa` le gana a `alfaromeo` y "Alfa Romeo 155" quedaría como
  // marca distinta según el modelo.
  const candidates = BRANDS.slice().sort((a, b) => b[0].length - a[0].length);
  for (const [key, label] of candidates) {
    if (compact.startsWith(key)) return label;
  }
  return prettifyModel(carModel);
}

function prettifyModel(carModel: string): string {
  const cleaned = carModel.replace(/^ks_/i, "").replace(/[_-]+/g, " ").trim();
  if (!cleaned) return carModel;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Marcas cuyo nombre presentable no coincide con el archivo de la biblioteca.
 *
 * El caso que importa es el de las sub-marcas: un Corvette lleva el logo de Chevrolet, y un RUF o
 * un Shelby —que no están en la biblioteca— llevan el de la marca sobre la que están construidos
 * antes que un escudo genérico.
 */
const SLUG_ALIASES: Record<string, string> = {
  "chevrolet corvette": "chevrolet",
  corvette: "chevrolet",
  "mercedes-amg": "mercedes-benz",
  mercedes: "mercedes-benz",
  shelby: "ford",
  ruf: "porsche",
  "race sim studio": "",
};

/** Nombre de archivo de la biblioteca, sin extensión. */
function toSlug(brand: string): string {
  return (
    brand
      .toLowerCase()
      .normalize("NFD")
      // Los diacríticos se sacan ANTES de reemplazar lo no alfanumérico. Al revés, la diéresis
      // de "Citroën" —que NFD deja como carácter aparte— se convertiría en un guion: "citroe-n".
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

/** Qué logos hay realmente en disco. Se lee una sola vez: la carpeta se empaqueta con la app y no
 * cambia en caliente. Sin esto el panel pediría un SVG inexistente por cada auto mod de la
 * parrilla, una vez por segundo, solo para recibir 404. */
let available: Set<string> | null = null;

function availableSlugs(): Set<string> {
  if (available) return available;
  available = new Set<string>();
  try {
    for (const name of fs.readdirSync(path.join(__dirname, "..", "api", "public", "brands"))) {
      if (name.endsWith(".svg")) available.add(name.slice(0, -4));
    }
  } catch {
    // Sin la carpeta, todas las marcas caen al escudo con monograma. Degrada, no rompe.
  }
  return available;
}

/**
 * Nombre del archivo de logo de esa marca, o `null` si no está en la biblioteca.
 *
 * Devolver `null` y no un slug optimista es lo que le permite al panel dibujar el escudo de una
 * vez, en lugar de pedir una imagen, esperar el 404 y recién entonces reemplazarla —que se veía
 * como un parpadeo en cada fila de auto mod.
 */
export function brandSlug(brand: string): string | null {
  if (!brand) return null;
  const key = brand.toLowerCase().trim();
  const alias = SLUG_ALIASES[key];
  if (alias === "") return null;
  const slug = alias || toSlug(brand);
  return availableSlugs().has(slug) ? slug : null;
}

