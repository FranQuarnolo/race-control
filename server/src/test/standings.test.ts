import { strict as assert } from "assert";
import { test } from "node:test";
import { computeGaps, computeStandings, SESSION_RACE } from "../state/standings";
import { brandOf, brandSlug } from "../cars/carBadges";

const SESSION_QUALIFY = 2;

function car(
  carId: number,
  over: Partial<{ lapCount: number; spline: number; best: number | null; last: number | null; connected: boolean }> = {}
) {
  return {
    carId,
    lapCount: over.lapCount ?? 0,
    normalizedSplinePosition: over.spline ?? 0,
    bestLapMs: over.best === undefined ? null : over.best,
    lastLapMs: over.last === undefined ? null : over.last,
    connected: over.connected ?? true,
  };
}

test("en carrera lidera quien más vueltas lleva", () => {
  const positions = computeStandings([car(0, { lapCount: 2, spline: 0.9 }), car(1, { lapCount: 3, spline: 0.1 })], SESSION_RACE);
  assert.equal(positions.get(1), 1);
  assert.equal(positions.get(0), 2);
});

test("en carrera, a igual vuelta manda el avance en el trazado", () => {
  const positions = computeStandings([car(0, { lapCount: 3, spline: 0.2 }), car(1, { lapCount: 3, spline: 0.8 })], SESSION_RACE);
  assert.equal(positions.get(1), 1);
  assert.equal(positions.get(0), 2);
});

test("en clasificación manda la mejor vuelta, no el progreso", () => {
  // El auto 0 lleva el triple de vueltas: en una tanda libre eso no significa absolutamente nada.
  const positions = computeStandings(
    [car(0, { lapCount: 30, best: 95_000 }), car(1, { lapCount: 10, best: 93_000 })],
    SESSION_QUALIFY
  );
  assert.equal(positions.get(1), 1);
  assert.equal(positions.get(0), 2);
});

test("en clasificación, quien todavía no marcó tiempo va al fondo", () => {
  const positions = computeStandings([car(0, { best: null }), car(1, { best: 99_000 })], SESSION_QUALIFY);
  assert.equal(positions.get(1), 1);
  assert.equal(positions.get(0), 2);
});

test("los desconectados no ocupan posición", () => {
  const positions = computeStandings(
    [car(0, { lapCount: 5, connected: false }), car(1, { lapCount: 1 }), car(2, { lapCount: 2 })],
    SESSION_RACE
  );
  assert.equal(positions.get(0), undefined);
  assert.equal(positions.get(2), 1);
  assert.equal(positions.get(1), 2);
});

// ======================================================================== intervalos

test("el líder no tiene intervalo: no hay nadie adelante", () => {
  const gaps = computeGaps(
    [car(0, { lapCount: 3, spline: 0.5, best: 90_000 }), car(1, { lapCount: 3, spline: 0.2, best: 90_000 })],
    SESSION_RACE
  );
  assert.equal(gaps.get(0)!.aheadMs, null);
  assert.equal(gaps.get(0)!.leaderMs, null);
  assert.equal(gaps.get(0)!.lapsDown, 0);
});

test("en carrera el intervalo sale de la distancia en el trazado por la vuelta de referencia", () => {
  // 0.1 de vuelta de distancia, vuelta de 90 s → 9 s. El de atrás es quien tiene que recorrerla,
  // así que la referencia es la suya.
  const gaps = computeGaps(
    [car(0, { lapCount: 3, spline: 0.5, best: 90_000 }), car(1, { lapCount: 3, spline: 0.4, best: 100_000 })],
    SESSION_RACE
  );
  assert.equal(gaps.get(1)!.aheadMs, 10_000);
  assert.equal(gaps.get(1)!.leaderMs, 10_000);
});

test("el acumulado contra el líder no es la suma de los intervalos cuando los ritmos difieren", () => {
  // Cada auto convierte la distancia con SU vuelta: por eso el gap al líder del tercero no es
  // ahead(2) + ahead(3). Es correcto y es la razón de que se calculen los dos por separado.
  const gaps = computeGaps(
    [
      car(0, { lapCount: 5, spline: 0.9, best: 60_000 }),
      car(1, { lapCount: 5, spline: 0.8, best: 60_000 }),
      car(2, { lapCount: 5, spline: 0.7, best: 120_000 }),
    ],
    SESSION_RACE
  );
  assert.equal(gaps.get(1)!.aheadMs, 6_000);
  assert.equal(gaps.get(2)!.aheadMs, 12_000);
  assert.equal(gaps.get(2)!.leaderMs, 24_000);
});

test("un auto doblado no reporta milisegundos, reporta vueltas", () => {
  const gaps = computeGaps(
    [car(0, { lapCount: 10, spline: 0.5, best: 90_000 }), car(1, { lapCount: 8, spline: 0.5, best: 90_000 })],
    SESSION_RACE
  );
  assert.equal(gaps.get(1)!.lapsDown, 2);
  assert.equal(gaps.get(1)!.aheadMs, null);
  assert.equal(gaps.get(1)!.leaderMs, null);
});

test("sin ninguna vuelta cerrada, el intervalo no se inventa", () => {
  // Las primeras curvas de la largada: hay distancia pero no hay con qué convertirla a tiempo.
  const gaps = computeGaps(
    [car(0, { spline: 0.2 }), car(1, { spline: 0.1 })],
    SESSION_RACE
  );
  assert.equal(gaps.get(1)!.aheadMs, null);
  assert.equal(gaps.get(1)!.lapsDown, 0);
});

test("sin mejor vuelta propia la referencia es la última, y si tampoco hay, la mejor de la sesión", () => {
  const conUltima = computeGaps(
    [car(0, { lapCount: 2, spline: 0.5, best: 60_000 }), car(1, { lapCount: 2, spline: 0.4, last: 80_000 })],
    SESSION_RACE
  );
  assert.equal(conUltima.get(1)!.aheadMs, 8_000);

  const sinNada = computeGaps(
    [car(0, { lapCount: 2, spline: 0.5, best: 60_000 }), car(1, { lapCount: 2, spline: 0.4 })],
    SESSION_RACE
  );
  assert.equal(sinNada.get(1)!.aheadMs, 6_000);
});

/**
 * La ventana entre cruzar la meta y que llegue el `LAP_COMPLETED`.
 *
 * Por un par de décimas, el spline del que acaba de pasar vale ~0 mientras su `lapCount` sigue
 * siendo el de antes. Sin el piso en cero, el auto de adelante aparece con un progreso casi una
 * vuelta menor que el de atrás y la columna muestra un intervalo negativo delante de todo el
 * mundo. Negativo en una torre de tiempos no significa nada: significa que hay un bug.
 */
test("en el cruce de meta ningún intervalo queda negativo", () => {
  const gaps = computeGaps(
    [
      car(0, { lapCount: 4, spline: 0.001, best: 90_000 }), // cruzó y el UDP todavía no avisó
      car(1, { lapCount: 4, spline: 0.998, best: 90_000 }), // viene atrás, misma vuelta
    ],
    SESSION_RACE
  );
  for (const gap of gaps.values()) {
    if (gap.aheadMs !== null) assert.ok(gap.aheadMs >= 0, "intervalo negativo");
    if (gap.leaderMs !== null) assert.ok(gap.leaderMs >= 0, "intervalo negativo contra el líder");
  }
});

test("en clasificación el intervalo es la resta de las mejores vueltas, sin estimar nada", () => {
  const gaps = computeGaps(
    [car(0, { best: 90_000 }), car(1, { best: 90_500 }), car(2, { best: 92_000 })],
    SESSION_QUALIFY
  );
  assert.equal(gaps.get(1)!.aheadMs, 500);
  assert.equal(gaps.get(2)!.aheadMs, 1_500);
  assert.equal(gaps.get(2)!.leaderMs, 2_000);
});

test("en clasificación, quien no marcó tiempo no tiene intervalo contra nadie", () => {
  const gaps = computeGaps([car(0, { best: 90_000 }), car(1, { best: null })], SESSION_QUALIFY);
  assert.equal(gaps.get(1)!.aheadMs, null);
  assert.equal(gaps.get(1)!.leaderMs, null);
});

/**
 * Posiciones e intervalos tienen que salir del mismo orden.
 *
 * Es el motivo por el que `rankCars` está extraída. Con dos copias del `sort`, una divergencia
 * chica —un criterio de desempate distinto— muestra un gap contra un auto que en la tabla aparece
 * más atrás, y eso es peor que no mostrar nada: el número se lee igual de creíble.
 */
test("el intervalo se mide siempre contra el auto que la tabla pone adelante", () => {
  const cars = [
    car(0, { lapCount: 4, spline: 0.30, best: 90_000 }),
    car(1, { lapCount: 4, spline: 0.60, best: 90_000 }),
    car(2, { lapCount: 5, spline: 0.10, best: 90_000 }),
    car(3, { lapCount: 4, spline: 0.45, best: 90_000, connected: false }),
  ];
  const positions = computeStandings(cars, SESSION_RACE);
  const gaps = computeGaps(cars, SESSION_RACE);

  // Cada auto con posición tiene gap, y solo esos.
  assert.deepEqual([...gaps.keys()].sort(), [...positions.keys()].sort());
  // El primero de la tabla es el único sin nadie adelante.
  const lider = [...positions.entries()].find(([, pos]) => pos === 1)![0];
  for (const [carId, gap] of gaps) {
    if (carId === lider) assert.equal(gap.aheadMs, null);
    else assert.ok(gap.aheadMs !== null, `el auto ${carId} no tiene contra quién medirse`);
  }
});

test("la marca se deduce del nombre del modelo, con y sin prefijo de Kunos", () => {
  assert.equal(brandOf("ks_ferrari_488_gt3"), "Ferrari");
  assert.equal(brandOf("bmw_m3_e30"), "BMW");
  assert.equal(brandOf("ks_porsche_911_gt3_r_2016"), "Porsche");
  assert.equal(brandOf("abarth500"), "Abarth");
});

test("una marca de dos palabras le gana al prefijo más corto", () => {
  // Sin ordenar por longitud, "alfa" matchea primero y Alfa Romeo queda partida en dos marcas.
  assert.equal(brandOf("ks_alfa_romeo_gta"), "Alfa Romeo");
  assert.equal(brandOf("ks_aston_martin_v12_vantage"), "Aston Martin");
});

test("un modelo desconocido no se queda sin etiqueta", () => {
  assert.equal(brandOf("ks_tatuusfa1"), "Tatuus");
  assert.equal(brandOf("algun_mod_raro"), "Algun mod raro");
  assert.equal(brandOf(""), "");
});

test("el logo sale de la biblioteca empaquetada, y si la marca no está devuelve null", () => {
  // El panel usa el null para dibujar el escudo con monograma de una, sin pedir un SVG que no está.
  assert.equal(brandSlug("Ferrari"), "ferrari");
  assert.equal(brandSlug("Aston Martin"), "aston-martin");
  assert.equal(brandSlug("Marca Inventada"), null);
  assert.equal(brandSlug(""), null);
});

test("las sub-marcas llevan el logo de la marca madre", () => {
  // Un Corvette es un Chevrolet, y un RUF se construye sobre un Porsche: el logo genérico sería
  // menos informativo que el de la marca sobre la que está hecho el auto.
  assert.equal(brandSlug("Chevrolet Corvette"), "chevrolet");
  assert.equal(brandSlug("RUF"), "porsche");
  assert.equal(brandSlug("Shelby"), "ford");
  // Race Sim Studio es un estudio de mods, no una marca de autos: no hay logo que mostrar.
  assert.equal(brandSlug("Race Sim Studio"), null);
});

test("el prefijo del autor del mod no tapa la marca", () => {
  // El bug de la 1.1: se exigía que el nombre EMPEZARA con la marca, y el único prefijo de autor
  // que se sacaba era `ks_`. Toda la parrilla de una liga —que es casi toda mods— se veía en
  // hexágonos con tres letras.
  assert.equal(brandOf("acf_ferrari_296_gt3"), "Ferrari");
  assert.equal(brandOf("urd_bmw_m4_gt3_2024"), "BMW");
  assert.equal(brandOf("rss_porsche_992_gt3_cup"), "Porsche");
  assert.equal(brandOf("vrc_lamborghini_huracan_gt3_evo"), "Lamborghini");
  assert.equal(brandOf("emka_aston_martin_vantage_gt3"), "Aston Martin");
  // Y el prefijo de siempre sigue andando.
  assert.equal(brandOf("ks_mercedes_amg_gt3"), "Mercedes-Benz");
});

test("un modelo nombrado sin la marca resuelve por el modelo", () => {
  // Varios packs de GT3 nombran por modelo: el número o la sigla es lo único que identifica al auto.
  assert.equal(brandOf("emka_m4_gt3"), "BMW");
  assert.equal(brandOf("720s_evo_gt3"), "McLaren");
  assert.equal(brandOf("acf_rcf_gt3"), "Lexus");
  assert.equal(brandOf("gt3r_2023"), "Porsche");
  assert.equal(brandOf("z06_gt3r"), "Chevrolet Corvette");
  assert.equal(brandOf("nsx_gt3_evo"), "Acura");
  // La segunda pasada corre solo si la primera no encontró marca: acá gana Audi, no "r8".
  assert.equal(brandOf("ks_audi_r8_lms"), "Audi");
});

test("un nombre escrito de corrido también encuentra la marca", () => {
  // Sin separadores no hay tokens que partir, así que se busca por contención — pero solo con
  // claves largas: con `bmw` o `ford` adentro de cualquier palabra serían todos falsos positivos.
  assert.equal(brandOf("ksferrari488gt3"), "Ferrari");
  assert.equal(brandOf("modlamborghinigt3"), "Lamborghini");
});

test("toda la parrilla GT3 encuentra su logo en disco", () => {
  // La cadena completa: nombre de mod → marca → archivo que existe. Si falla acá, en el panel se
  // ve el escudo de iniciales y nadie se entera de por qué.
  const parrilla = [
    "acf_ferrari_296_gt3",
    "acf_porsche_992_gt3r",
    "emka_m4_gt3",
    "emka_amg_gt3_evo",
    "urd_aston_martin_vantage_gt3",
    "rss_mclaren_720s_gt3",
    "vrc_lamborghini_huracan_gt3_evo2",
    "acf_lexus_rcf_gt3",
    "ks_audi_r8_lms_2016",
    "acf_corvette_z06_gt3r",
    "acf_bentley_continental_gt3",
    "acf_ginetta_g55_gt4",
  ];
  for (const modelo of parrilla) {
    const marca = brandOf(modelo);
    assert.ok(brandSlug(marca), `${modelo} → "${marca}" se quedó sin logo`);
  }
});
