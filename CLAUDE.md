# Convenciones del repo

Notas para quien (o lo que) trabaje acá y no tenga el contexto de las sesiones anteriores. Lo que
sigue no es estilo opcional: casi todo está escrito porque ya se rompió una vez.

## Estructura

| Carpeta | Qué es |
|---|---|
| `server/` | El backend y el panel. TypeScript 5.5 strict, CommonJS, Node 22, Express 4 (única dependencia de runtime). |
| `client-app/` | La app que los pilotos instalan en Content Manager. Python. |
| `*.md` de la raíz | **La documentación del producto.** No hay wiki. |

## Tests

```
cd server && npm test
```

Es `npm run build && node --test "dist/test/*.test.js"`. Corre desde `server/`, no desde la raíz.
Al 2026-10-27 son 270 y están todos en verde; que queden en verde es la condición para publicar.

**Los tests de `panel.test.ts`, `assets.test.ts` y `clientApp.test.ts` son distintos al resto**: no
prueban lógica, prueban invariantes de archivos que nadie compila. Existen porque este proyecto
tiene una familia de bugs recurrente —cosas que **no fallan**, simplemente no pasan— y es la única
forma de atraparlos. Los encabezados de cada archivo cuentan el bug concreto que los originó. Si
vas a tocar el panel o la app del piloto, leelos antes.

## El frontend no tiene build

`src/api/public/` y `src/portal/public/` son HTML, CSS y JS a mano. `scripts/copy-assets.js` los
copia a `dist/` junto con `src/track/catalog/` (JSON, que `tsc` no emite). Si agregás una carpeta
de assets, va en ese script o no llega a producción — y anda perfecto en desarrollo, que es lo que
lo hace peligroso.

**Todo texto de persona o del juego se inserta con `textContent`, nunca con `innerHTML`.** Los
nombres de los pilotos los elige el piloto.

## La app del piloto corre en Python 3.3

`client-app/apps/python/RaceControlClient/RaceControlClient.py` vive dentro del intérprete embebido
de Assetto Corsa, que es **3.3**. Nada de f-strings (3.6), walrus (3.8) ni `async` (3.5): usá
`.format()`. Solo stdlib, y solo la que existe en 3.3 — ni `pathlib` ni `enum`, que son de 3.4.

Un error de sintaxis ahí **no da error**: la app no aparece en el menú del juego y el reporte que
llega es "no me anda". `server/src/test/clientApp.test.ts` lo revisa, pero no reemplaza al cuidado.

Toda ventana nueva tiene que pasar por `ocultarChrome()`, o sale como un recuadro negro tapando el
parabrisas.

## Comentarios y CHANGELOG

El código está comentado en un registro particular y conviene mantenerlo: los comentarios explican
**por qué** algo es así, qué pasaba antes y qué se rompe si se cambia. Cuando se borra código,
suele quedar un comentario en su lugar diciendo qué había y bajo qué condición habría que reponerlo.

El `CHANGELOG.md` sigue la misma idea: cada entrada cuenta el síntoma, la causa y la decisión, no
una lista de archivos tocados. Las entradas van arriba de todo.

## Publicar

Ver `CHANGELOG.md` para el historial. Las versiones del producto son de dos números (`1.1`), y hay
que tocarlas en cuatro lugares: `server/package.json`, dos líneas de `server/package-lock.json`
(la 3 y `packages[""].version`), y `APP_VERSION` en `server/src/api/adminApi.ts`.

El `ui.json` de la app del piloto lleva **su propia** numeración y se sube solo cuando el `.py`
cambia. Cuando cambia, los pilotos tienen que reinstalar el `.zip`: no hay actualización
automática. Si cambia, hay que tocar también el número que aparece en el README, en la fila de
descargas ("versión actual: X.Y").

El `.zip` se arma con `node client-app/scripts/package-client.js` y no se commitea
(`client-app/release/` está en `.gitignore`): produce dos archivos idénticos,
`RaceControlClient.zip` (el que linkea el README, con nombre fijo para no tener que tocar ese link
en cada release) y `RaceControlClient-<versión>.zip` (mismo contenido, para quien entra a la
página de releases de GitHub a elegir una versión puntual). Los dos se adjuntan al release.

## Idioma

Todo en español rioplatense, con acentos. Vale tanto para el código y los comentarios como para la
documentación y los mensajes que ve el usuario.

> En Windows, **no uses `Get-Content`/`Set-Content` de PowerShell 5.1 para reemplazar texto**: te
> destroza los acentos de los archivos UTF-8. Usá `sed` de Git Bash o un script de Python.
