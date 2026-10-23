import { strict as assert } from "assert";
import { test } from "node:test";
import { computeStandings, SESSION_RACE } from "../state/standings";
import { brandOf, brandSlug } from "../cars/carBadges";

const SESSION_QUALIFY = 2;

function car(carId: number, over: Partial<{ lapCount: number; spline: number; best: number | null; connected: boolean }> = {}) {
  return {
    carId,
    lapCount: over.lapCount ?? 0,
    normalizedSplinePosition: over.spline ?? 0,
    bestLapMs: over.best === undefined ? null : over.best,
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
