# 🏁 Race Control

Control de carrera para ligas de **Assetto Corsa**, pensado para vivir **incrustado dentro del panel
de administración de tu liga** (en este caso, fslmanager.vercel.app) en vez de ser una página propia
con login. Conectás tu servidor dedicado —el que sea: EmperorServers o cualquier otro hosting— y
dirigís la carrera desde una sola pantalla fusionada, sin salir del admin donde ya hacés todo lo
demás.

- 🟢 **Largada en movimiento**, controlada automáticamente.
- 🏎️ **Una sola tabla** con el auto, el piloto, las paradas en boxes, el combustible, los cortes de
  pista sin justificar y los incidentes pendientes de cada uno — lo que antes eran dos pestañas
  separadas (Control de carrera y Sanciones) se fusionó en una.
- 💥 **Incidentes**: toques entre autos, choques contra el muro, salidas de pista, contramano y
  excesos de velocidad en pit lane y en la formación, agrupados por piloto y con el contexto de
  cada uno. **Reporta, no sanciona**: eso lo decidís vos, resolviéndolos desde la fila del auto.
- 🚩 **Sanciones** de pit lane y largada automáticas, y las del comisario a un click. Todas se
  pueden **anular**: al piloto le llega el aviso y dejan de contar en el informe.
- 📊 **Informe de carrera** descargable al terminar, para pegar en la planilla del campeonato.
- 📋 **Perfiles de carrera**: guardás todo tu reglamento con un nombre —"Endurance", "4Fun"— y lo
  reponés entero de una, sin volver a tocar umbral por umbral.

No trae mapa en vivo ni torre de tiempos con velocidad, sectores o neumáticos: eso sigue existiendo
en el producto completo de Race Control (ver más abajo), pero esta pantalla fusionada está pensada
para la tarea del día de carrera —largar, mirar quién corta o para en boxes, resolver incidentes y
sancionar— no para reemplazar un live timing aparte.

## 🚦 Cómo se usa

**El admin no instala nada, no configura nada y no tiene usuario ni contraseña propios de Race
Control**: la pantalla ya está incrustada en la página de administración de la liga, y quien entra
ahí con su cuenta de siempre ve el panel de carrera sin ningún login adicional. Lo único que se
descarga es la app de los pilotos.

1. 📋 En **"Conexión"** apretás **"Copiar el mensaje para mi hosting"** y lo pegás en el ticket de
   soporte. Es el pedido ya escrito en inglés, con la dirección de tu liga adentro: que apunten el
   plugin UDP del servidor de Assetto Corsa a esa dirección.
2. ✅ Cuando te confirmen, reiniciás el servidor y entrás una vez con el juego. La pantalla
   **se pone verde sola** cuando empieza a llegar la telemetría. No hay nada más que configurar:
   el resto lo averigua solo.
3. 🎮 Le pasás `RaceControlClient.zip` a cada piloto, una sola vez para toda la temporada.
4. 🏁 El día de carrera entrás al admin de tu liga como siempre y apretás los botones de largada.

> ¿Tu hosting muestra el campo **"Send Address"** en **"Server Options"**? Entonces podés saltearte
> el ticket: pegá ahí la dirección que figura en **Conexión → Estado** y reiniciá. La mayoría no lo
> muestra, porque vienen con los plugins UDP apagados de fábrica.

> **Nota técnica para quien integra esta pantalla en un panel de administración:** el servidor
> sirve el panel sin sesión cuando la variable de entorno `RC_PUBLIC_LEAGUE` tiene el slug de una
> liga (ver `server/src/portal/server.ts`). Es aditivo y vive solo en esta rama: sin esa variable,
> Race Control se comporta como el producto completo de siempre, con login y selección de liga.

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
3. Activá en el juego, en el menú de Apps, las ventanas que quieras: **RC Mensajes** (tu contador
   de cortes, la sanción que debés y los avisos de dirección de carrera), **RC Banderas** (un
   cuadro de color), **RC Largada** (cinco luces) y **RC Alerta** (el marco rojo que aparece si
   algo anda mal con tu credencial). ✅
4. Acomodalas en pantalla. Una sola vez, y mejor antes de largar. 🖱️

Nada más — ni una IP que tipear, ni un archivo que editar. El servidor le manda sola la dirección
y una credencial por el chat del juego apenas entrás. 🎮

Son transparentes y sin barra de título: en reposo casi no se ven. Para volver a agarrarlas,
pasales el mouse por encima.

> ⚠️ **Si la instalaste antes de la 1.5, reinstalala.** No hay actualización automática: sin
> reinstalar no vas a escuchar los avisos de voz de la formación ("rolling start", "stay behind",
> "no overtaking" y "green green green"), ni el contador de cortes, ni el aviso de credencial, y
> vas a seguir viendo el cuadro verde durante la vuelta de formación. Arrastrá el `.zip` nuevo
> igual que la primera vez: pisa lo anterior sin dejar restos.

## 🖥️ Para el admin: qué hay adentro del panel

- **La pantalla principal**: los botones de largada arriba y, debajo, la tabla fusionada con cada
  auto — piloto, paradas en boxes, combustible, cortes de pista e incidentes pendientes—. Cada fila
  se despliega para resolver sus incidentes o aplicarle una sanción, sin salir de la tabla. Si se
  corta el contacto con el motor, aparece una banda roja arriba de todo: un panel congelado no se
  puede confundir con uno sano.
- **Sanciones aplicadas** (modal): lo aplicado automáticamente, lo que aplicaste vos, y el botón
  **"Descargar informe de carrera"** — una planilla con la clasificación, los segundos de
  penalización de cada piloto y los incidentes revisados. 📊
- **Reglas** (modal): tus perfiles de carrera y qué se controla. Cada infracción puede solo
  registrarse, mandarse a revisar o sancionarse sola. 🏎️
- **Conexión** (modal): el mensaje para el soporte del hosting, el estado de la señal, un
  diagnóstico para cuando algo no cierra, y el interruptor del **modo sombra**: 🛡️ **recomendado
  para las primeras carreras**. En sombra el sistema registra todo pero no sanciona a nadie en
  serio, así podés chequear que funcione antes de confiar en él del todo.

El producto completo de Race Control —con login propio, selección de liga, torre de tiempos
detallada y mapa en vivo— sigue existiendo en `main`; esta rama es la versión fusionada y sin login
pensada específicamente para incrustarse en el admin de una liga.
