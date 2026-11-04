# 🏁 Race Control

🔗 **[race-control.fly.dev](https://race-control.fly.dev/)**

Control de carrera para ligas de **Assetto Corsa**, pensado para vivir **incrustado dentro del panel
de administración de tu liga** en vez de ser una página propia con login. Conectás tu servidor
dedicado —el que sea: EmperorServers o cualquier otro hosting— y dirigís la carrera desde una sola
pantalla fusionada, sin salir del admin donde ya hacés todo lo demás. También funciona por su
cuenta, con su propio usuario y contraseña, si todavía no querés integrarlo.

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
- 🔀 **Varias carreras a la vez**: una liga puede tener varios servidores corriendo en simultáneo
  (Spa/GT3, Interlagos/F3, lo que sea) y elegís cuál mirar desde un selector, sin recargar nada ni
  volver a configurar.
- 🔌 **Semáforo de conexión** siempre a la vista: te dice si el servidor está mandando telemetría,
  si está callado, o si todavía no habló nunca — que es un problema distinto y se arregla distinto.

## 🧩 Incrustarlo en tu página

Tu liga ya tiene su panel de administración. Race Control se pega ahí adentro con dos líneas de
HTML, en una sección nueva o donde vos decidas: se dibuja dentro de un `<div>` tuyo, con su propia
hoja de estilos, y no es un iframe.

En **Conexión → Embed externo** del panel guardás la dirección de tu página, generás un token y
copiás el código. Eso es todo lo que hay que tocar de tu lado.

📖 **[INTEGRAR-EMBED.md](INTEGRAR-EMBED.md)** es un wizard paso a paso pensado para que se lo pases
a una IA (Claude Code, Cursor, lo que uses) y lo integre sola: le hace las preguntas al admin, le
da la variante de React/Next.js, y tiene la tabla de "si ves esto, pasó esto otro".

## 📥 Descargas

| Para | Qué bajar |
|---|---|
| 🏎️ Cada piloto | [**RaceControlClient.zip**](https://github.com/FranQuarnolo/race-control/releases/latest/download/RaceControlClient.zip) — versión actual: **1.8** |

## 🏎️ Para el piloto

1. Abrí Content Manager.
2. Arrastrá `RaceControlClient.zip` a la ventana, como instalarías un mod de auto o pista. 📦
3. **RC Mensajes** (tu contador de cortes, la sanción que debés y los avisos de dirección de
   carrera) y **RC Largada** (el semáforo) aparecen solas apenas entrás, y no se pueden sacar del
   menú de Apps: mientras tengas la app instalada, las vas a ver. **RC Banderas** (un cuadro de
   color) y **RC Alerta** (el marco rojo que aparece si algo anda mal con tu credencial) quedan a
   tu elección, ahí mismo. ✅
4. Acomodalas en pantalla. Una sola vez, y mejor antes de largar. 🖱️

## 📚 Documentación

No hay wiki: la documentación del producto son los `.md` de la raíz.

| Archivo | Para quién |
|---|---|
| [**PUESTA-EN-MARCHA.md**](PUESTA-EN-MARCHA.md) | El operador que levanta el servicio y da de alta ligas, y el admin que conecta su servidor de AC. |
| [**INTEGRAR-EMBED.md**](INTEGRAR-EMBED.md) | La IA (o la persona) que incrusta el embed en la página de la liga. |
| [**CHANGELOG.md**](CHANGELOG.md) | Qué cambió en cada versión, y por qué. |
| [**CLAUDE.md**](CLAUDE.md) | Convenciones del repositorio, para quien toque el código. |
