# 🤖 Integrar el embed de Race Control — guía para un agente

**Este archivo está escrito para una IA que trabaja dentro del código de la página de una liga**
(Next.js, Astro, WordPress, HTML a mano, lo que sea) y tiene que dejar Race Control incrustado en
una sección de esa página.

Si sos una persona: pasale este link a tu agente y listo. Lo que sigue son instrucciones para él.

---

## Paso 0 — Leé esto antes de tocar nada

No empieces por el código. Primero tenés que saber qué estás pegando, porque la mitad de los
problemas de integración salen de suponer que esto es un iframe o un widget común, y no lo es.

**Qué es Race Control.** Un control de carrera para ligas de Assetto Corsa: lee la telemetría del
servidor dedicado por UDP y muestra, en vivo, la tabla de autos con incidentes, sanciones,
combustible, paradas en boxes y cortes de pista. El admin de la liga resuelve incidentes, aplica y
anula sanciones y controla la largada desde ahí.

**Qué es el embed.** La misma pantalla, servida como un `<script>` que se pega en una página
ajena. No es un iframe: dibuja su DOM dentro de un `<div>` tuyo, en el documento de tu página.
Trae su propia hoja de estilos, todo prefijado con `.rc-embed`, así que no pisa los estilos del
host ni el host lo pisa a él.

**Leé también** (en este mismo repositorio, son cortos):

- [`README.md`](README.md) — qué hace el producto, visto desde afuera.
- [`PUESTA-EN-MARCHA.md`](PUESTA-EN-MARCHA.md) §5, *"Incrustarlo en su propia página"* — los tres
  pasos que el admin de la liga tiene que haber hecho **del lado de Race Control** antes de que
  vos pegues una sola línea.

**Las tres cosas que tienen que estar listas antes de arrancar** (las hace el admin en el panel de
Race Control, en **Conexión → Embed externo**; no se hacen desde tu código):

1. **El origen autorizado.** La dirección exacta de la página donde vas a pegar esto, con esquema
   y sin barra final: `https://fslmanager.vercel.app`. Es comparación exacta, un origen por vez.
   Si está vacío o no coincide, el embed recibe `403` y no muestra nada — con token válido o sin él.
2. **El token.** Se genera con un botón. Formato `<kid>.<versión>.<firma>`.
3. **El slug de la liga.** Es el `<slug>` de la URL `https://race-control.fly.dev/l/<slug>`.

Si el admin te pasó el bloque de "Copiar código" del panel, ya tenés el slug y el token adentro:
no los inventes ni los retoques, y verificá que el slug del `src=` y el del `data-slug=` sean el
**mismo** (es el error más común al pegarlo a mano).

Recién ahora seguí con el wizard.

---

## Paso 1 — ¿Dónde lo integramos?

Preguntale al admin y esperá la respuesta. No elijas vos.

> **1. ¿Dónde querés que aparezca Race Control?**
>
> - **A) Una sección nueva en una página que ya existe** (ej. abajo de todo en el panel de la
>   liga). Es lo más común.
> - **B) Una página/ruta nueva y dedicada** (ej. `/control-de-carrera`), con su ítem en el menú.
> - **C) Una pestaña dentro de una pantalla que ya tiene pestañas.**
> - **D) Otro lugar** — que lo describa.

Reglas que valen para las cuatro:

- El contenedor tiene que ser **ancho**. La tabla tiene ocho columnas; abajo de ~900 px de ancho
  útil entra en scroll horizontal propio (no rompe la página, pero se usa incómodo). Si la página
  tiene un `max-width` angosto, pedí permiso para sacar el embed de ese contenedor.
- La altura es **variable y crece sola** con la cantidad de autos. No le pongas `height` fija ni
  `overflow: hidden`.
- **Ningún ancestro del `<div>` puede tener `transform`, `filter` ni `perspective`.** Eso crea un
  nuevo contexto de posicionamiento y los modales de Conexión y Reglas (que son `position: fixed`
  y viven adentro del div) se dibujan recortados dentro de la caja en vez de taparla. Es el único
  conflicto de CSS real que tiene esta integración; si la sección vive dentro de un carrusel o de
  un wrapper con animación de entrada, movela.

En el caso **C**, una advertencia: si la pestaña arranca oculta con `display: none`, el embed se
monta igual y sigue consultando el servidor en segundo plano. Funciona, pero si querés evitarlo,
montá el `<script>` recién cuando el usuario abre la pestaña (ver Paso 3, variante SPA).

---

## Paso 2 — ¿Quién puede verlo?

> **2. ¿La sección va a ser pública o solo para el staff de la liga?**
>
> - **A) Solo el staff** (detrás del login que ya tiene la página). **Recomendado.**
> - **B) Pública, cualquiera que entre la ve.**

Esto no cambia una línea del snippet, pero sí cambia a quién le estás dando el botón de sancionar.
Decilo claro y que decida el admin:

El token viaja en el código fuente de la página y **cualquiera que haga "ver código fuente" lo
puede leer**. Eso es parte del diseño, no un bug: el `allowedOrigin` es lo que hace que ese token
no sirva en ninguna otra página. Pero dentro de *tu* página, quien ve el embed puede accionarlo:
resolver incidentes, aplicar y anular sanciones, controlar la largada, y también **leer y cambiar
las reglas y la configuración de conexión de la liga**. No hay modo "solo lectura".

**No armes un proxy en tu backend para esconder el token.** No agrega seguridad (el proxy tendría
que aceptar los mismos pedidos desde el navegador) y rompe la validación de origen.

Si el admin elige **B**, dejá el embed detrás de algo igual: un `/control` sin link en el menú
tampoco es protección. Si no hay login en la página, decile que use el panel completo de Race
Control, que sí tiene usuario y contraseña.

---

## Paso 3 — ¿Con qué está hecha la página?

> **3. ¿Cómo está construida la página?**
>
> - **A) HTML, PHP, WordPress, Astro, Hugo** — cualquier cosa que sirva HTML directo.
> - **B) React / Next.js / Vue / Svelte** — una SPA que monta el DOM desde JavaScript.

### A) HTML directo

Pegá esto donde quieras que aparezca. Es todo.

```html
<div id="rc-embed"></div>
<script src="https://race-control.fly.dev/l/<slug>/embed/embed.js"
        data-slug="<slug>"
        data-token="<token>"></script>
```

No agregues un `<link>` a la hoja de estilos: el script la inyecta solo, y no la duplica si el
snippet aparece dos veces.

Si el `<div>` no puede llamarse `rc-embed` (porque ya existe ese id, o porque tu framework de
templates genera los ids), usá `data-target`:

```html
<div id="mi-seccion-de-carrera"></div>
<script src="..." data-slug="..." data-token="..." data-target="mi-seccion-de-carrera"></script>
```

El `<script>` tiene que ir **después** del div en el documento, o en un `DOMContentLoaded`: busca
el elemento apenas corre.

### B) React / Next.js / Vue / Svelte

El script se identifica a sí mismo con `document.currentScript`, y eso **vale `null`** si lo
cargás como módulo ES, con `next/script`, o desde un callback. En ese caso no arranca y vas a ver
un `console.error` que dice *"No se pudo leer el propio `<script>`"*.

La forma que funciona es crear un `<script>` clásico a mano al montar el componente:

```jsx
import { useEffect, useRef } from "react";

const SLUG = "<slug>";
const TOKEN = "<token>";

export default function ControlDeCarrera() {
  const ref = useRef(null);

  useEffect(() => {
    const s = document.createElement("script");
    s.src = `https://race-control.fly.dev/l/${SLUG}/embed/embed.js`;
    s.dataset.slug = SLUG;
    s.dataset.token = TOKEN;
    s.dataset.target = "rc-embed";
    document.body.appendChild(s);
    return () => s.remove();
  }, []);

  return <div id="rc-embed" ref={ref} />;
}
```

Tres cosas para no tropezar:

- **No uses `<Script>` de `next/script`.** Pone el script como módulo diferido y
  `document.currentScript` queda en `null`.
- **Esto es un componente de cliente.** En Next.js App Router necesita `"use client"` arriba.
- **El `remove()` del cleanup saca el `<script>`, no el DOM ya dibujado ni el `setInterval` del
  poll.** Con React 18 en modo estricto el efecto corre dos veces en desarrollo y vas a ver el
  embed dibujado dos veces: es un artefacto del modo estricto, en producción no pasa. Si te
  molesta, guardá un flag en un `useRef` y no vuelvas a montar.

---

## Paso 4 — Verificar

En este orden. Si algo falla, el paso siguiente no te va a decir nada útil.

1. **Abrí la página en el origen real, no en `file://` ni en un preview con otro dominio.** El
   origen tiene que ser exactamente el que configuró el admin. Si trabajás en local, pedile que
   cargue `http://localhost:3000` (acepta `http://`) — pero es **uno a la vez**: mientras esté el
   de localhost, la página de producción no anda.
2. **Tiene que verse la barra de arriba** con el nombre del servidor, el selector (si la liga
   tiene más de uno), el puntito de conexión y los botones Reglas y Conexión.
3. **La consola tiene que estar limpia.** Todo lo que falla acá avisa: o escribe un texto adentro
   del `<div>`, o deja un `console.error` con el prefijo `[race-control-embed]`.
4. **Probá un modal.** Abrí "Reglas" y cerralo. Si se dibuja recortado adentro de la caja en vez
   de tapar la pantalla, tenés un ancestro con `transform` (volvé al Paso 1).
5. **Achicá la ventana a 480 px.** La tabla tiene que pasar a su scroll horizontal propio y la
   página **no** tiene que scrollear de lado.
6. **Dejalo abierto un minuto.** Consulta el estado cada 1,5 s; el puntito tiene que quedarse
   verde o rojo, no parpadear entre los dos.

---

## Si algo no anda

Lo que ves es lo que pasó. Todos estos mensajes son textuales.

| Lo que ves | Qué pasó | Qué hacer |
|---|---|---|
| El `<div>` queda vacío y no hay nada en la consola | El `<script>` nunca corrió | Revisá que la etiqueta esté en el DOM y que no la haya filtrado un sanitizador de HTML (CMS, editor WYSIWYG) |
| `No se pudo leer el propio <script>` en consola | `document.currentScript` es `null` | Es una SPA cargando el script como módulo — usá la variante del Paso 3B |
| `No encontré ningún elemento con id="rc-embed"` | El script corrió antes que el div | Movelo después del div, o esperá al montaje del componente |
| `Falta data-slug o data-token` dentro del div | Faltan atributos en la etiqueta | Copiá de nuevo el snippet del panel, sin editarlo |
| `No se pudo conectar con Race Control: El servidor contestó 403` | Origen no autorizado | El `allowedOrigin` de la liga no coincide con el origen de tu página, carácter por carácter. Se arregla en el panel, no en tu código |
| `... El servidor contestó 401` | Token inválido o revocado | El admin regeneró el token y quedó el viejo pegado. Pedile el nuevo |
| `... 404` | El slug no existe | Casi siempre el `src=` y el `data-slug=` no coinciden |
| `Esta liga todavía no tiene ningún servidor` | La liga existe pero está vacía | No es tu problema: lo resuelve el operador de Race Control |
| Se ve todo pero el puntito está rojo y la tabla vacía | El embed anda; el que no está mandando telemetría es el servidor de Assetto Corsa | No es de la integración. Ver `PUESTA-EN-MARCHA.md` §4 |

---

## Lo que **no** hay que hacer

- **No copies ni adaptes el CSS del embed a tu hoja de estilos.** Se actualiza con el producto; una
  copia se queda vieja en silencio.
- **No le pongas `!important` encima para que combine con tu paleta.** Está hecho para verse igual
  que el panel completo, a propósito: el admin salta entre los dos todo el tiempo y cambiarle los
  colores de un lado lo desorienta. Si no pega con tu página, decilo y que lo decida el admin.
- **No envuelvas el `<div>` en un iframe.** Funciona, pero perdés el ajuste de alto automático y
  ganás una barra de scroll adentro de otra.
- **No guardes el token en una variable de entorno del servidor pensando que lo estás escondiendo.**
  Termina igual en el HTML servido, que es donde tiene que estar.
- **No lo pegues dos veces en la misma página.** El segundo snippet pisa el id y las dos copias
  consultan el servidor en paralelo.
