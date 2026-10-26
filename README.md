# 🏁 Race Control

Control de carrera para ligas de **Assetto Corsa**. Entrás a una página con tu usuario, conectás tu
servidor dedicado —el que sea: EmperorServers o cualquier otro hosting— y dirigís la carrera desde
una sola pantalla.

- 🟢 **Largada en movimiento**, controlada automáticamente.
- ⏱️ **Torre de tiempos en vivo** con posiciones, el intervalo con el de adelante —o con el líder, a
  un click—, sectores, neumáticos, combustible y ping.
- 🗺️ **Mapa del circuito en tiempo real**, que se dibuja solo a medida que se corre, con la zona de
  boxes marcada encima.
- 💥 **Bandeja de incidentes**: toques entre autos, choques contra el muro, salidas de pista y
  contramano, con el contexto de cada uno. **Reporta, no sanciona**: eso lo decidís vos.
- 🚩 **Sanciones** de pit lane y largada automáticas, y las del comisario a un click. Todas se
  pueden **anular**: al piloto le llega el aviso y dejan de contar en el informe.
- 📊 **Informe de carrera** descargable al terminar, para pegar en la planilla del campeonato.

## 🚦 Cómo se usa

**El admin no instala nada.** Entra a una dirección web con el usuario y la contraseña que le
pasaron, pega **un renglón** en el panel de su hosting y ya está dirigiendo. Lo único que se
descarga es la app de los pilotos.

1. 🔑 Te pasan la **dirección, un usuario y una contraseña**. Entrás por **"Ingresar"**.
2. 📋 La pantalla te muestra un renglón tipo `203.0.113.5:30000`. Lo pegás en el campo
   **"Send Address"** del panel de tu hosting —está en **"Server Options"**, en la sección de
   plugins UDP— y reiniciás el servidor de Assetto Corsa.
3. ✅ La pantalla **se pone verde sola** cuando empieza a llegar la telemetría. No hay nada más
   que configurar: el resto lo averigua solo.
4. 🎮 Le pasás `RaceControlClient.zip` a cada piloto, una sola vez para toda la temporada.
5. 🏁 El día de carrera entrás al panel y apretás los botones de largada.

### 🎬 En video

> 🚧 **Próximamente**: los cinco pasos de arriba, hechos en pantalla de punta a punta.

<!-- Cuando el video esté subido a YouTube, borrar el "Próximamente" de arriba y descomentar la
     línea de abajo, cambiando las dos veces que dice VIDEO_ID por el id del video (lo que va
     después de `watch?v=`). La miniatura la genera YouTube sola en esa dirección, no hay que
     subir ninguna imagen. GitHub no reproduce video embebido: una miniatura que linkea es lo
     máximo que se puede hacer en un README. Va comentado y no puesto a medias porque una imagen
     rota en lo primero que se ve del proyecto es peor que no tener video.

[![Ver el video](https://img.youtube.com/vi/VIDEO_ID/maxresdefault.jpg)](https://www.youtube.com/watch?v=VIDEO_ID)
-->

## 📥 Descargas

| Para | Qué bajar |
|---|---|
| 🏎️ Cada piloto | [**RaceControlClient.zip**](https://github.com/FranQuarnolo/race-control/releases/latest/download/RaceControlClient.zip) |

## 🏎️ Para el piloto

1. Abrí Content Manager.
2. Arrastrá `RaceControlClient.zip` a la ventana, como instalarías un mod de auto o pista. 📦
3. Activalo en el juego, en el menú de Apps: "Race Control". ✅

Nada más — ni una IP que tipear, ni un archivo que editar. El servidor le manda sola la dirección
y una credencial por el chat del juego apenas entrás. 🎮

> Si alguna vez te aparece **"Credencial vencida: volvé a entrar al servidor"**, es literal: salí y
> volvé a entrar, y la app recibe una credencial nueva. Duran 24 horas.

> De fábrica la app es obligatoria: quien entre sin ella es expulsado al minuto. Se puede apagar
> esa exigencia en **Reglas → App de los pilotos**, y entonces ese piloto aparece en la torre con
> posición, velocidad, vueltas y tiempos —todo lo que manda el servidor— y guiones en sectores,
> neumáticos y combustible. Esos datos solo los tiene el juego en la PC de cada uno.

## 🖥️ Para el admin: qué hay adentro del panel

- **Control de carrera**: los botones de largada, la torre de tiempos y el mapa en vivo. Si se corta
  el contacto con el motor, aparece una banda roja arriba de todo: un panel congelado no se puede
  confundir con uno sano.
- **Sanciones**: lo aplicado automáticamente, lo que aplicaste vos, y el botón
  **"Descargar informe de carrera"** — una planilla con la clasificación, los segundos de
  penalización de cada piloto y los incidentes revisados. 📊
- **Reglas**: el tipo de torneo y qué se controla. Cada infracción puede solo registrarse, mandarse
  a revisar o sancionarse sola. 🏎️
- **Conexión**: el renglón para pegar en el hosting, el estado de la señal y un diagnóstico para
  cuando algo no cierra.
- **Modo sombra**: 🛡️ **recomendado para las primeras carreras**. El sistema registra todo pero no
  sanciona a nadie en serio, así podés chequear que funcione antes de confiar en él del todo.

## 📚 Documentación

| Documento | De qué trata |
|---|---|
| [PUESTA-EN-MARCHA.md](PUESTA-EN-MARCHA.md) | Cómo poner a punto cada cosa y cómo funciona, de punta a punta |
| [docs/portal.md](server/docs/portal.md) | Arquitectura del portal: supervisor, workers, puertos, autenticación |
| [docs/operacion.md](server/docs/operacion.md) | Manual de operación: crear ligas, desplegar, leer logs, restaurar |
| [docs/seguridad.md](server/docs/seguridad.md) | Modelo de amenazas y qué queda explícitamente aceptado |
| [CHANGELOG.md](CHANGELOG.md) | Cada decisión de diseño, con el porqué y no solo el qué |
