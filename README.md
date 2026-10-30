# 🏁 Race Control

🔗 **[race-control.fly.dev](https://race-control.fly.dev/)**

Control de carrera para ligas de **Assetto Corsa**, pensado para vivir **incrustado dentro del panel
de administración de tu liga** en
vez de ser una página propia con login. Conectás tu servidor dedicado —el que sea: EmperorServers o cualquier otro hosting— y
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

## 📥 Descargas

| Para | Qué bajar |
|---|---|
| 🏎️ Cada piloto | [**RaceControlClient.zip**](https://github.com/FranQuarnolo/race-control/releases/latest/download/RaceControlClient.zip) — versión actual: **1.7** |

Este link no cambia nunca: siempre baja el último release, sea cual sea su número. Si preferís
elegir una versión puntual, en la [página de releases](https://github.com/FranQuarnolo/race-control/releases)
cada una queda publicada también como `RaceControlClient-<versión>.zip`.

## 🏎️ Para el piloto

1. Abrí Content Manager.
2. Arrastrá `RaceControlClient.zip` a la ventana, como instalarías un mod de auto o pista. 📦
3. **RC Mensajes** (tu contador de cortes, la sanción que debés y los avisos de dirección de
   carrera) y **RC Largada** (el semáforo) aparecen solas apenas entrás, y no se pueden sacar del
   menú de Apps: mientras tengas la app instalada, las vas a ver. **RC Banderas** (un cuadro de
   color) y **RC Alerta** (el marco rojo que aparece si algo anda mal con tu credencial) quedan a
   tu elección, ahí mismo. ✅
4. Acomodalas en pantalla. Una sola vez, y mejor antes de largar. 🖱️

Nada más — ni una IP que tipear, ni un archivo que editar. El servidor le manda sola la dirección
y una credencial por el chat del juego apenas entrás. 🎮

Son transparentes y sin barra de título: en reposo casi no se ven. Para volver a agarrarlas,
pasales el mouse por encima.

El producto completo de Race Control —con login propio, selección de liga, torre de tiempos
detallada y mapa en vivo— sigue existiendo en `main`; esta rama es la versión fusionada y sin login
pensada específicamente para incrustarse en el admin de una liga.
