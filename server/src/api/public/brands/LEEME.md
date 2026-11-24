# Biblioteca de logos de marca

126 SVG, uno por marca, servidos como `/brands/<slug>.svg`. El backend decide qué archivo le
corresponde a cada auto en `src/cars/carBadges.ts` (`brandOf` → `brandSlug`).

## De dónde salen

Mezcla de dos sets de íconos de autos, ambos con licencia **MIT**:

| Paquete npm | Aporte | Por qué |
|---|---|---|
| `car-brand-logos` | 100 archivos, fuente preferida | Trazos más limpios y `viewBox` consistente |
| `car-makes-icons` | 79 archivos, solo para rellenar huecos | Tiene marcas que el otro no: Lamborghini, Ford, Honda |

Ninguno de los dos alcanza solo: `car-brand-logos` no trae Lamborghini ni Ford, y
`car-makes-icons` no trae Pagani, Lancia, Alpine ni Renault. De ahí la mezcla.

De `car-makes-icons` se descartaron las variantes `" alt"`: son el mismo logo en otra versión y
solo generan archivos que nunca se piden.

## Logos elegidos a mano (1.41)

Diecinueve archivos se reemplazaron por SVG que eligió el operador de la liga, más fieles a cómo se
ve el logo en el auto: aston-martin, audi, bentley, bmw, citroen, corvette (nuevo), ferrari, ford,
lamborghini, lexus, mazda, mclaren, mercedes-benz, nissan, peugeot, porsche, renault, toyota y
volkswagen. Antes de reemplazar alguno de estos con el paso de abajo, fijate si no se pisa una
elección hecha a propósito.

En la **1.50** el operador cambió porsche y corvette por versiones nuevas y sumó alfa-romeo, cupra,
honda, hyundai y seat, para la parrilla de TCR. `porsche.svg` pesa ~1 MB (trae la imagen
embebida); el navegador lo cachea, pero si alguna vez molesta, es el primero a aligerar.

Además hay cuatro logos de **categoría**: `f1`, `f2`, `f3` y `lmp2`. No salen de la marca sino
del nombre del modelo (`categorySlug` en `carBadges.ts`): si el mod dice `f1`, `f2`, `f3`,
`formula_2` o `lmp2` como palabra suelta, gana sobre el logo de la marca.

Dos para tener en cuenta: `mazda.svg` trae una imagen raster embebida (se ve igual, pero no escala
como un vector) y `porsche.svg` pesa ~290 KB. Si alguna vez se nota en la carga de la tabla,
son los primeros candidatos para cambiar.

## Marcas que no están

Quedaron afuera varias que sí aparecen en Assetto Corsa, casi todas de nicho o de competición:
Lancia, Pagani, Praga, KTM, Tatuus, Glickenhaus, Dallara, Datsun y Matra.

No es un problema: `brandSlug` devuelve `null` para esas y el panel dibuja un **escudo con el
monograma** de la marca en un color derivado del nombre. Se reconoce de un vistazo igual, y nunca
queda una celda vacía.

RUF y Shelby tampoco están, pero se resuelven por alias (`SLUG_ALIASES`) al logo de la marca sobre
la que están construidos: Porsche y Ford.

## Cómo actualizarla

1. `npm i car-brand-logos car-makes-icons` en una carpeta aparte (**no** en el `package.json` del
   proyecto: esto es un asset, no una dependencia de runtime).
2. Copiar los SVG a esta carpeta, en minúsculas y con guiones (`aston-martin.svg`), dando
   prioridad a `car-brand-logos` cuando el nombre se repite.
3. Si agregás una marca nueva, verificá que `brandOf` la reconozca: el slug tiene que coincidir
   con lo que devuelve `toSlug(brandOf(modelo))`.

No hace falta tocar ninguna lista en el código: la carpeta se lee del disco al arrancar.

## Marcas registradas

Los logos son marcas registradas de sus respectivos fabricantes. Se usan acá para identificar el
auto que maneja cada piloto dentro de una herramienta de dirección de carrera —uso nominativo—,
no para sugerir ningún tipo de vínculo, patrocinio ni aprobación.
