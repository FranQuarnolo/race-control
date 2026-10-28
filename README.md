# 🏁 Race Control

Control de carrera para ligas de **Assetto Corsa**. Entrás a una página con tu usuario, conectás tu
servidor dedicado —el que sea: EmperorServers o cualquier otro hosting— y dirigís la carrera desde
una sola pantalla.

- 🟢 **Largada en movimiento**, controlada automáticamente.
- ⏱️ **Torre de tiempos en vivo** con posiciones, el intervalo con el de adelante —o con el líder, a
  un click—, sectores, neumáticos, combustible y ping.
- 🗺️ **Mapa del circuito en tiempo real**, dibujado desde el primer segundo —198 circuitos vienen
  incluidos— con la zona de boxes marcada encima.
- 💥 **Bandeja de incidentes**: toques entre autos, choques contra el muro, salidas de pista y
  contramano, con el contexto de cada uno. **Reporta, no sanciona**: eso lo decidís vos.
- 🚩 **Sanciones** de pit lane y largada automáticas, y las del comisario a un click. Todas se
  pueden **anular**: al piloto le llega el aviso y dejan de contar en el informe.
- 📊 **Informe de carrera** descargable al terminar, para pegar en la planilla del campeonato.
- 📋 **Perfiles de carrera**: guardás todo tu reglamento con un nombre —"Endurance", "4Fun"— y lo
  reponés entero de una, sin volver a tocar umbral por umbral.

## 🚦 Cómo se usa

**El admin no instala nada ni configura nada.** Entra a una dirección web con el usuario y la
contraseña que le pasaron, copia un mensaje, se lo manda al soporte de su hosting y ya está
dirigiendo. Lo único que se descarga es la app de los pilotos.

1. 🔑 Te pasan la **dirección, un usuario y una contraseña**. Entrás por **"Ingresar"**.
2. 📋 En **"Conexión"** apretás **"Copiar el mensaje para mi hosting"** y lo pegás en el ticket de
   soporte. Es el pedido ya escrito en inglés, con la dirección de tu liga adentro: que apunten el
   plugin UDP del servidor de Assetto Corsa a esa dirección.
3. ✅ Cuando te confirmen, reiniciás el servidor y entrás una vez con el juego. La pantalla
   **se pone verde sola** cuando empieza a llegar la telemetría. No hay nada más que configurar:
   el resto lo averigua solo.
4. 🎮 Le pasás `RaceControlClient.zip` a cada piloto, una sola vez para toda la temporada.
5. 🏁 El día de carrera entrás al panel y apretás los botones de largada.

> ¿Tu hosting muestra el campo **"Send Address"** en **"Server Options"**? Entonces podés saltearte
> el ticket: pegá ahí la dirección que figura en **Conexión → Estado** y reiniciá. La mayoría no lo
> muestra, porque vienen con los plugins UDP apagados de fábrica.

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
3. Activá en el juego, en el menú de Apps, las ventanas que quieras: **RC Mensajes** (sanciones y
   vueltas invalidadas, en rojo), **RC Banderas** (un cuadro de color) y **RC Largada** (cinco
   luces). ✅
4. Acomodalas en pantalla. Una sola vez, y mejor antes de largar. 🖱️

Nada más — ni una IP que tipear, ni un archivo que editar. El servidor le manda sola la dirección
y una credencial por el chat del juego apenas entrás. 🎮

Son transparentes y sin barra de título: en reposo casi no se ven. Para volver a agarrarlas,
pasales el mouse por encima.

> ⚠️ **Si la instalaste antes de la 1.1, reinstalala.** La app cambió entera. Arrastrá el `.zip`
> nuevo igual que la primera vez: pisa lo anterior sin dejar restos.

## 🖥️ Para el admin: qué hay adentro del panel

- **Control de carrera**: los botones de largada, la torre de tiempos y el mapa en vivo. Si se corta
  el contacto con el motor, aparece una banda roja arriba de todo: un panel congelado no se puede
  confundir con uno sano.
- **Sanciones**: lo aplicado automáticamente, lo que aplicaste vos, y el botón
  **"Descargar informe de carrera"** — una planilla con la clasificación, los segundos de
  penalización de cada piloto y los incidentes revisados. 📊
- **Reglas**: tus perfiles de carrera y qué se controla. Cada infracción puede solo registrarse,
  mandarse a revisar o sancionarse sola. 🏎️
- **Conexión**: el mensaje para el soporte del hosting, el estado de la señal, un diagnóstico para
  cuando algo no cierra, y el interruptor del **modo sombra**: 🛡️ **recomendado para las primeras
  carreras**. En sombra el sistema registra todo pero no sanciona a nadie en serio, así podés
  chequear que funcione antes de confiar en él del todo.
