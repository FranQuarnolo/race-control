# Changelog

Todas las fechas en hora local (Argentina). Formato libre, pensado para trazabilidad de decisiones,
no solo de código — cada entrada explica el porqué, no solo el qué.

## [1.13] — 2026-10-29

**El panel copia la paleta y la tipografía de fslmanager.vercel.app tal cual salen del inspector, y
el README linkea el panel en producción.**

### "Tomada de fslmanager" en el comentario, pero a ojo sobre una captura

**Síntoma:** desde la 1.11 el `:root` de `styles.css` ya decía inspirarse en fslmanager.vercel.app,
pero el propio comentario admitía que el ajuste había sido a ojo sobre una captura — y se notaba: el
fondo quedaba más plano y los colores más claros y saturados que el admin real, y la tipografía era
la del sistema en vez de la condensada en mayúscula que usa esa página.

**Decisión:** con una sesión real en fslmanager.vercel.app se extrajeron los valores con el
inspector (`getComputedStyle` y las variables `--carbon`/`--gold`/`--gl`/etc. de sus propias hojas de
estilo) en vez de aproximar por captura: fondo `#0f1116`, tarjeta `#191c22`, campo hundido `#14161b`,
texto `#e8d5a3`, acento `#c9a84c`, verde `#4ade80`, borde `rgba(255,255,255,.06)` y radio `12px` —
más Oswald (títulos, botones, chapas y pestañas, siempre en mayúscula) y Chivo (el resto del texto),
el mismo par que usa esa página. Sumar Google Fonts obligó a ampliar el `Content-Security-Policy` del
portal (`style-src`/`font-src`) para `fonts.googleapis.com` y `fonts.gstatic.com`, que antes no
estaban permitidos y hubiesen cortado la tipografía en silencio.

### El README no decía dónde vive el panel en producción

**Decisión del usuario:** se agrega el link a `https://race-control.fly.dev/` debajo del título.

## [1.12] — 2026-10-29

**La app del piloto obliga a mostrar "RC Mensajes" y "RC Largada", y el README se poda a lo
esencial** (`ui.json` pasa de 1.6 a 1.7 — hace falta reinstalar el `.zip`).

### Tener la app instalada no garantiza ver los avisos ni el semáforo

**Síntoma:** expulsar a quien no tiene la app (ver versiones anteriores) no alcanza — un piloto que
sí la tiene instalada puede no haber activado nunca "RC Mensajes" o "RC Largada" en el menú de Apps
del juego, o haberlas cerrado sin querer, y corre la carrera sin ver ni los avisos de dirección de
carrera ni el semáforo de largada.

**Decisión:** `ac.setVisible(window, 1)` apenas se crean esas dos ventanas en `acMain`, para que
aparezcan sin depender de lo que el piloto haya dejado en una carrera anterior, más
`ac.addOnAppDismissedListener` en cada una para volver a mostrarlas en el acto si el piloto intenta
cerrarlas — se pueden mover y redimensionar como siempre, pero no sacar de pantalla. Alcanza con
Mensajes y Largada: "RC Banderas" duplica el indicador del propio juego y queda opcional, y "RC
Alerta" ya se dibuja vacía el 99% del tiempo, forzarla solo pondría un marco rojo sin motivo. Ver el
comentario "MENSAJES Y LARGADA NO SE PUEDEN SACAR" en el encabezado de `RaceControlClient.py`.

### El README traía pasos de puesta en marcha que ya no hacen falta

**Decisión del usuario:** se saca la sección "Cómo se usa" (el ticket al hosting, activar el modo
sombra la primera vez) y "Para el admin: qué hay adentro del panel" — ese recorrido ahora vive en la
propia página de administración donde el panel está incrustado, no en un README genérico. También
se saca el aviso puntual de "si la instalaste antes de la 1.6, reinstalá" de la sección del piloto:
cada versión que necesite reinstalación ya queda registrada acá, en el changelog. De paso, el
nombre de la página de administración (fslmanager.vercel.app) pasa a ser un link.

## [1.11] — 2026-10-29

**La tabla seguía rota después de la 1.10, el aviso de "auto en pista" mentía, y un reinicio de
largada no cancelaba los avisos de voz ya programados** (`ui.json` pasa de 1.5 a 1.6 — hace falta
reinstalar el `.zip`).

### "Insi" y "Acciones" seguían superpuestos: el diagnóstico de la 1.10 estaba incompleto

**Síntoma:** después de publicar el `overflow: hidden` de la 1.10, el usuario reportó el mismo
problema con una captura nueva ("tabla.png"): la tabla seguía sin llegar al final del contenedor y
"Insi"/"Acciones" seguían pisándose.

**Causa real:** `.c-actions` (la clase de la celda con los dos botones de acción) ponía
`display: flex` tanto en el `<td>` de cada fila como en el `<th>` del encabezado, que comparte la
clase solo para heredar el ancho de columna. Un `<th>` con `display: flex` deja de participar como
celda de verdad en `table-layout: fixed`: el navegador le calcula un ancho propio por contenido
(38px en vez del 15% que le correspondía) e ignora el `width` declarado. El `overflow: hidden` de
la 1.10 no tenía nada que recortar — el encabezado ya se dibujaba angosto y pegado contra "Insi",
no desbordado. Se verificó con Playwright contra el sitio en vivo: midiendo el `getBoundingClientRect`
de cada celda, el `<th>` medía 38px y el `<td>` de la misma columna 253px.

**Decisión:** `display: flex` pasa a `td.c-actions` únicamente. El `<th>` vuelve a ser una celda de
tabla normal y respeta el ancho de `#timing-table th:nth-child(9)` como el resto de las columnas.

### "Esperando el primer auto en pista." se quedaba a la vista con autos ya en la tabla

**Causa:** mismo bug de fondo que ya atrapó `#wizard-overlay[hidden]` en una rama anterior: `.empty`
define `display: flex` sin un `.empty[hidden] { display: none; }` que lo pise, así que el
`cars-empty.hidden = true` que pone `renderTiming` no alcanzaba para ocultar el aviso.

**Decisión:** se agrega el seguro `.empty[hidden] { display: none; }`. De paso se blindó `.row`
(usado por el campo nuevo de "Segundos de penalización", más abajo) con el mismo seguro antes de
que hiciera falta.

### Reiniciar la largada a mitad de formación no cancelaba "stay behind" ni "no overtaking"

**Síntoma:** si el admin arrancaba la formación y la reiniciaba antes de los 10 o los 40 segundos,
los avisos de voz sonaban igual, en el momento que les tocaba originalmente.

**Causa:** a `startFormationAudioSequence()` le faltaba `global formation_audio_timers`. Sin esa
declaración, la asignación final de la función creaba una variable local que se descartaba al
volver — la lista global que lee `cancelFormationAudioSequence()` quedaba vacía para siempre
después de la primera formación, y "cancelar" una lista vacía no cancela nada. Los `Timer` de
verdad quedaban sueltos, sonando en su horario sin que nada los pudiera parar.

**Decisión:** se agrega el `global` que faltaba.

### El marco ámbar de foco se cortaba en los inputs de los modales

**Causa:** `input:focus-visible, select:focus-visible` dibujaba el contorno hacia AFUERA del borde
(`outline-offset: 0`). Un campo pegado al borde derecho de `.tab-panel` —que por el `overflow-y:
auto` de esa clase termina recortando también en X, no solo en Y— se comía la mitad del marco.

**Decisión:** `outline-offset: -2px`, el mismo criterio que ya usaba `.tab:focus-visible`: el
contorno se dibuja hacia adentro y nunca lo recorta nada, sea cual sea el ancho del modal.

### Otros tres pedidos sueltos

- **La versión del panel** se muestra ahora pegada contra "Sanciones aplicadas", para saber de un
  vistazo qué build corre sin tener que abrir Reglas.
- **El `.zip` de la app del piloto** trae un `VERSION.txt` generado a partir de `ui.json` en el
  momento de empaquetar (y se borra después, no queda como archivo suelto en git): un piloto que
  pregunta "¿qué versión tengo?" lo puede chequear sin tener que contar reinstalaciones.
- **"Penalización de tiempo" como escalado automático** (largada y pit lane) tenía el campo
  `timePenaltySeconds` en el motor desde la 1.9 pero ningún lugar del panel para cargarlo —se
  aplicaba siempre con el `?? 5` de respaldo del motor, sin que el admin pudiera cambiarlo. Ahora
  aparece un campo "Segundos de penalización" en cuanto se elige esa opción, en las dos pestañas
  (Largada y Pit lane).

## [1.10] — 2026-10-29

**Tercera revisión de la pantalla fusionada contra el admin real, y la app del piloto suma voz a
la largada** (`ui.json` pasa de 1.4 a 1.5 — hace falta reinstalar el `.zip`).

### "Insi" y "Acciones" se superponían en la cabecera de la tabla

**Síntoma:** con el embed en un ancho real de fslmanager.vercel.app (no el ~1800 px asumido al
armar el `table-layout: fixed` de la 1.9), el encabezado "ACCIONES" no entraba en su columna y se
dibujaba montado encima de "Insi" (imagen "bugtabla").

**Causa:** `white-space: nowrap` sin `overflow: hidden` no recorta el texto que no entra en la
celda — lo sigue dibujando igual, invadiendo la columna vecina. El reparto de porcentajes de la
1.9 además le daba a "Acciones" (9%) menos aire que a columnas con menos texto.

**Decisión:** `overflow: hidden; text-overflow: ellipsis` en todos los `th`/`td` de la torre, para
que un desborde futuro termine en "…" y no en texto superpuesto, sea cual sea el ancho real del
embed. De paso, "Acciones" pasa de 9% a 15% y "Piloto" cede algo de su 28%.

### La chapa de sesión decía "C" de carrera, no "R"

**Decisión:** "R" (de "race", la misma convención que ya usaba "Q" de clasificación) en vez de "C".
Reserva, que ya usaba "R", pasa a "RES" para no empatarle la letra a Carrera. Las ocho chapas
(Reserva, Práctica, Clasificación, Carrera, Hotlap, Time attack, Deriva, Repetición) suman además
un color propio cada una — antes todas compartían el mismo ámbar y solo se distinguían leyendo la
letra.

### La vuelta de formación ahora se anuncia por voz, no solo con el semáforo

**Decisión:** cuatro locuciones (provistas por el usuario, carpeta `sounds/` de la app del
piloto): "rolling start" apenas arranca la formación, "stay behind" a los 10 s, "no overtaking" a
los 40 s —los tres tiempos contados desde el inicio de la formación, no uno después del otro— y
"green green green" cuando el semáforo pasa a verde de verdad (ese locución ya existía; se
reemplaza por la nueva, de la misma voz). Los dos avisos intermedios se programan con
`threading.Timer` —Python 3.3 no tiene `asyncio`— y se cancelan si la largada se reinicia o el
semáforo pasa a verde antes de los 40 s: el admin puede dar verde cuando quiera, nada garantiza que
la formación dure eso.

## [1.9] — 2026-10-29

**Race Control deja de ser un portal aparte con login propio.** Esta versión fusiona Control de
carrera y Sanciones en una sola pantalla pensada para vivir incrustada dentro del admin de la
liga (fslmanager.vercel.app), no detrás de una dirección y una contraseña propias.

### El panel completo no se podía "meter en un div"

**Causa:** `app.js` asumía ser la página entera —`html,body{height:100%;overflow:hidden}`,
overlays `position:fixed`, un router que hace `pushState` sobre la URL del host— y traía mapa en
vivo y torre de tiempos detallada (velocidad, sectores, neumáticos), que no hacen falta para la
tarea del día de carrera.

**Decisión:** la raíz del dominio sirve, sin sesión ni CSRF, el panel de una liga puntual cuando la
variable de entorno `RC_PUBLIC_LEAGUE` trae su slug (`server/src/portal/server.ts`). Es aditivo:
sin la variable, el producto completo de siempre —login, selección de liga, mapa, torre de
tiempos— sigue intacto. Control de carrera y Sanciones se fusionan en una sola tabla con fila
expandible, y los cajones laterales (Conexión) pasan a ser modales, igual que Sanciones aplicadas
y Reglas, para que las tres capas se abran y cierren igual. La paleta se acerca a la de
fslmanager.vercel.app.

### Cuatro arreglos puntuales de la revisión contra el admin real

- La tabla de autos se rompía con el embed muy ancho: `table-layout: auto` reparte el ancho
  sobrante mirando el contenido, y con la tabla vacía estiraba las columnas de cualquier manera.
  Pasa a `fixed`, con un porcentaje de ancho fijo por columna.
- La banda de "sin contacto con Race Control" se disparaba sola al cambiar de pestaña del
  navegador o minimizar la ventana: el freno que los navegadores le ponen a los `setInterval` en
  segundo plano atrasaba el poll más allá del umbral de tres segundos, y eso se leía como una
  desconexión que nunca existió. Ahora se ignora mientras la pestaña está oculta y se resincroniza
  apenas vuelve a primer plano.
- El reloj de sesión mostraba minutos crudos de más de tres dígitos ("1277:21.41") cuando una
  práctica quedaba corriendo mucho más de lo normal. Pasado el umbral de una hora pasa a mostrarse
  en `HH:MM:SS`, y pasado el día, en "N día(s) + HH:MM:SS" — como un livetiming.
- El modal de Reglas cambiaba de tamaño según la pestaña que estuviera activa; ahora tiene un alto
  fijo, así que cambiar de pestaña no mueve el resto de la pantalla.

## [1.8] — 2026-10-28

**Tercera tanda de la misma carrera de prueba, ahora del lado de la app del piloto** (`ui.json`
pasa de 1.3 a 1.4 — hace falta reinstalar el `.zip`). Cuatro observaciones puntuales de manejarla
en pista.

### "RC Largada" no se encontraba en pantalla

**Síntoma:** un piloto que recién instala la app encuentra "RC Banderas" y "RC Mensajes", pero no
"RC Largada" — el admin, que ya la tenía acomodada de antes, no veía el problema.

**Causa:** ninguna de las cuatro ventanas tenía una posición propia al crearse, así que Assetto
Corsa las apilaba todas en el mismo origen de pantalla. "RC Mensajes" (460×158) tapaba por completo
a "RC Largada", mucho más chica — el semáforo estaba ahí, perfectamente funcional, debajo de otra
ventana.

**Decisión:** `posicionarVentanasDeFabrica()` les da una posición de fábrica bien separada, pero
solo la primera vez que la app corre en esa instalación (una marca en disco lo recuerda) — después
de esa vez el juego ya recuerda dónde las dejó el piloto, y este código no vuelve a tocarlas.

### El semáforo se veía pixelado

**Causa:** cada luz se armaba apilando doce franjas horizontales (`drawDisc`, es lo único que
permite `ac.glQuad`); de cerca el escalonado se notaba.

**Decisión:** pasan a ser veintiocho, al mismo costo de siempre — diez discos por frame entre
carcasas y luces, menos de trescientos rectángulos.

### El click derecho para fijar una ventana no es algo que la app deba implementar

**Verificado contra la documentación pública de la API de Python de Assetto Corsa:** no existe un
evento de click derecho ni una función para bloquear la posición de una ventana desde un script. El
"click derecho para fijarla" que ya funciona en otras apps es una función nativa de Content
Manager / Custom Shaders Patch (click derecho arriba a la izquierda de la ventana → "Pin window"),
y aplica igual a las tres ventanas de Race Control sin que haga falta cambiar nada acá — el único
impedimento real era el bug anterior, que no dejaba encontrar "RC Largada" para poder fijarla.

### La vuelta de formación no decía a qué velocidad ir

**Decisión:** mientras el semáforo está en rojo parpadeando, debajo de las luces aparecen dos
renglones nuevos: "VUELTA DE FORMACION" y el límite de velocidad configurado en el panel (sección
Largada). El número sale de `config.formation.penalty.speedThresholdKmh` —la misma regla con la que
se sanciona el exceso— y viaja en cada respuesta de `/api/client/poll` como `formationSpeedLimitKmh`
(servidor 1.8). Mismo criterio que el contador de cortes: es estado mientras dure la formación, no
un aviso que vence a los 25 segundos.

## [1.7] — 2026-10-28

**Segunda tanda de observaciones de la misma carrera de prueba**, esta vez del lado del servidor:
qué sesiones cuentan, qué ve el piloto en modo sombra, qué mensaje recibe al conectarse y cómo se
calibra el pit lane.

### Los incidentes se registraban también en Práctica

**Síntoma:** un choque o un corte de pista en Práctica generaba un incidente en la bandeja, igual que
en Clasificación o Carrera.

**Causa:** `IncidentEngine.route()` no sabía en qué tipo de sesión estaba — enrutaba todo lo que le
llegaba, sin importar que la sesión fuera de descarte.

**Decisión:** `route()` ahora recibe el tipo de sesión y descarta todo en Práctica (`sessionType`
1 del protocolo de AC), antes de mirar el catálogo de reglas. Test nuevo en `incidentEngine.test.ts`
que prueba el mismo choque en Práctica (nada) y en Clasificación (sí entra).

### En modo sombra, el piloto no se enteraba de nada

**Síntoma:** con el modo sombra activo —el default de instalación—, una sanción detectada no
generaba ningún aviso al piloto, así que la ventana de mensajes de la app se veía vacía siempre. Lo
que se había reportado como "no me aparece ningún mensaje" era, en la mayoría de los casos, esto: el
admin nunca había desactivado el modo sombra.

**Decisión del usuario:** el modo sombra sigue suprimiendo el efecto real de la sanción (el comando
de lastre, la expulsión), pero ya no suprime el aviso — el piloto ve "te corresponde Drive-Through"
igual, aunque el servidor no se lo aplique. Nuevo helper `avisarSiempre()` en `raceControl.ts`,
separado del `dispatchOrSuppress()` que sigue gateando solo la acción real.

### El mensaje de bienvenida en el chat era el técnico de autodescubrimiento

**Síntoma:** lo único que veía un piloto al entrar al servidor era
`RACECONTROL_BACKEND:dirección|token` — repetido, porque el anuncio reintenta hasta el primer latido
de la app — más el aviso de Real Penalty de que la app no está activa si no la tiene instalada.

**Límite:** ese mensaje técnico no se puede tocar, ocultar ni reemplazar — es el único canal que AC
ofrece para hablarle a un auto puntual (no a toda la parrilla), y el cliente Python lo necesita tal
cual para autoconfigurarse.

**Decisión:** se agrega, además, un saludo corto: "Race Control ENCENDIDO". No reemplaza al técnico,
convive con él.

### Calibrar el pit lane era un procedimiento manual y poco claro

**Síntoma:** para configurar la zona de pit de un circuito había que pedirle a un piloto que pasara
por boxes, hacer click en su auto en el mapa y copiar a mano el "punto de la vuelta" de entrada y de
salida.

**Decisión:** nuevo `PitZoneLearner` (mismo patrón que `TrackLearner`: aprende de la telemetría que
ya manda la app en cada latido, persiste por liga y circuito). En cuanto cualquier piloto con la app
pasa por boxes, el panel ofrece "Usar esta calibración" con el rango aprendido; los dos campos
manuales quedan para corregirlo o para un circuito donde todavía nadie pasó por boxes con la app
puesta. No contempla pit lanes que cruzan la línea de meta — una muestra así se descarta en vez de
sugerir una zona rota.

## [1.6] — 2026-10-28

**Primer uso real en modo carrera completo**: formación, verde, bandera a cuadros y vuelta a
práctica, de punta a punta. Dejó un bug visible desde el primer intento.

### "Carrera en curso" y la bandera seguían encendidos en la práctica siguiente

**Síntoma:** después de dar el verde y terminar la carrera, el servidor volvía a Práctica y el panel
seguía mostrando el cartel "Carrera en curso", la bandera ondeando en la barra y el semáforo en
VERDE, como si la carrera siguiera.

**Causa:** el semáforo (`FormationStart.lightState`) solo volvía a `"idle"` con el botón "Reiniciar"
largada. El `NEW_SESSION` de la sesión siguiente reseteaba la fase (`phaseTracker`) cuando venía de
`finished`, pero nunca tocaba el semáforo — el comentario original decía que "las otras transiciones
de fase las maneja la largada", dando por sentado que nadie necesitaba resetearla desde afuera. El
panel calcula tanto el cartel como la bandera a partir de `lightState === "green"`, así que ese valor
fantasma bastaba para que las dos cosas quedaran prendidas en medio de una práctica.

**Decisión:** el `NEW_SESSION` resetea el semáforo siempre, no solo cuando la fase venía de
`finished` — algunos hostings no mandan `END_SESSION` para práctica o clasificación, así que atarlo
a esa condición hubiera dejado el mismo bug en esos servidores. Test de regresión nuevo en
`core.test.ts` que reproduce la secuencia completa (formación → verde → sesión nueva sin
`END_SESSION`) y verifica que el semáforo y la fase vuelven a `idle`.

### El chat de la largada decía "GREEN GREEN GREEN"

**Síntoma:** el único texto en inglés de todo el producto, en el chat que ven los pilotos al dar
verde.

**Decisión:** pasa a decir "VERDE VERDE VERDE".

## [1.5] — 2026-10-28

**Repaso visual y de textos después de probar la 1.4 con los ojos puestos en pantalla**, no en el
código: tres detalles sueltos que recién se notan usando el producto.

### Los íconos del historial eran los únicos emoji de toda la interfaz

**Síntoma:** el ojito y la basurita de la fila de historial (`/operador`) eran 👁 y 🗑, emoji a
color, al lado de un kebab de texto (⋮) y de una tabla de admins que siempre usó botones de
palabra.

**Decisión:** pasan a ser botones `.compacto` con texto ("Ver", "Borrar"), igual criterio que el
resto de la tabla. La clase `.btn-icono` se fue del CSS; `.arming` (el estado de "confirmá para
borrar") queda genérica para que la siga usando cualquier botón.

### Varios textos del panel y de la landing sonaban a eslogan, no a producto

**Síntoma:** frases como "Acá se registra lo que pasó, no quién tuvo la culpa. Eso lo decidís vos.",
"Dirigí tu carrera, no el software" o "Tres pasos, una sola vez" seguían el mismo molde de
contraste ("X, no Y") y de frase corta cortada con un punto, que es más de copy publicitario
genérico que de la voz directa que tiene el resto del producto.

**Decisión:** se reescribieron a favor de decir el mecanismo en vez de la frase ingeniosa: el motor
detecta y la persona decide, en vez de "no quién tuvo la culpa"; qué es el producto en vez de contra
qué se define. De paso, la torre vacía ("Todavía no hay nadie en pista.") suma un ícono de volante
centrado en vez de ser solo una línea de texto perdida arriba de una tabla sin filas.

### El logo del auto se veía con un recuadro blanco duro, no con la placa suave que ya existía

**Síntoma:** varios logos de marca (Porsche, Lotus, Kia, Bentley, entre otros) se veían con un fondo
blanco opaco y sin el radio de borde que sí tiene el resto de los logos de la misma biblioteca.

**Causa:** la biblioteca `brands/` ya tiene una placa clara propia en CSS (`.car-badge`) pensada
para los logos que son solo líneas oscuras y necesitan fondo claro para no desaparecer sobre el
panel. Doce de los 126 SVG de la biblioteca traían además su propio rectángulo blanco de fondo
horneado en el archivo —herencia de cómo se exportaron—, que tapaba esa placa con un blanco más
duro y sin esquinas redondeadas.

**Decisión:** se les sacó ese rectángulo a los doce archivos; la placa de `.car-badge` queda como el
único fondo, y es la misma para toda la biblioteca. De paso se actualizaron dos comentarios de
`styles.css` y `app.js` que describían una versión anterior de este sistema (logos leídos de la
instalación local de Assetto Corsa) y habían quedado desactualizados desde que la biblioteca
`brands/` los reemplazó.

## [1.4] — 2026-10-28

**La lista que dejó la 1.1, tercera y última tanda: el panel del operador.** Las dos primeras
tandas se miran desde la cabina o arriba del auto; esta se mira desde el escritorio de quien vende
el servicio y tiene que responder "¿esta liga corrió de verdad esta semana?" sin pedirle una
captura al admin.

### No había forma de saber si una liga corría de verdad

**Síntoma:** el operador veía el motor "en marcha" y la cuota al día, pero nada le decía si detrás
de eso había carreras reales. Para enterarse tenía que escribirle al admin y confiar en la
respuesta.

**Causa:** el portal (`portal/store.ts`) guarda usuarios, ligas y membresías, y nada de las
sesiones que corrió cada una. El dato existía un instante —`sessionInfo`, los motores de sanción,
el `IncidentEngine`— y se perdía apenas terminaba la carrera, salvo que el admin bajara el informe
a mano.

**Decisión:** cada worker escribe su propio `events.json` en la carpeta de datos de la liga, con
una entrada por sesión —práctica, clasificación o carrera— y el mismo informe que ya arma
`buildReport` para la descarga de posiciones finales. Vive en disco, a nivel de archivo, igual que
`config.json`: el portal lo lee por el supervisor cuando hace falta, así que el historial sigue
visible aunque el worker esté parado o la liga desactivada. En `/operador`, el ojito de cada fila
muestra el detalle completo y la basurita borra con doble confirmación; un evento en curso no se
puede borrar, porque el worker lo sigue escribiendo.

### Cuatro botones sueltos por fila eran un click fallido esperando a pasar

**Síntoma:** la tabla de admins tenía Editar, Cobré, Desactivar/Reactivar y Clave nueva como
botones sueltos en la misma fila, con "Desactivar" —una acción que corta el motor de la liga de
alguien— al lado de todos los demás.

**Decisión:** las cinco acciones (se sumó "Ver historial") pasan a un menú de tres puntitos, mismo
patrón que ya usa el panel de carrera para el kick del piloto y por el mismo motivo: una acción
destructiva suelta en una fila es un accidente esperando, y agruparla detrás de un click extra es
la fricción mínima que lo evita.

## [1.3] — 2026-10-28

**La lista que dejó la 1.1, segunda tanda: la pista y el auto.** Lo que la 1.2 arregló se mira
desde un escritorio; esto se mira a doscientos por hora y con las dos manos ocupadas. Cuatro
cambios, los cuatro salidos de la misma prueba en pista.

**Los pilotos tienen que reinstalar el `.zip`.** El `.py` cambió, así que el `ui.json` de la app
subió a 1.3 y no hay actualización automática: quien siga con la versión anterior no va a ver el
contador de cortes ni el aviso de credencial, y va a seguir viendo el cuadro verde durante la
vuelta de formación.

### El exceso de velocidad no figuraba en el resumen del piloto

**Síntoma:** un piloto se pasaba tres veces de velocidad en pit lane, se llevaba sus tres
Drive-Through, y en la bandeja de incidentes su resumen decía "0 incidentes". El comisario no
tenía forma de ver el patrón.

**Causa:** `PitSpeedMonitor` y `FormationStart` emitían un evento `violation` que **no escuchaba
nadie**. La sanción salía por otro camino, así que nada fallaba: simplemente el hecho no se
registraba en ningún lado donde se pudiera leer junto al resto.

**Decisión:** dos tipos de incidente nuevos (`pit-speeding`, `formation-speeding`) con sus dos
entradas en el catálogo de infracciones, y dos contadores propios al lado de Cuts y Choques: Pit y
Largada. Propios y no dentro de "Otros" porque son hechos objetivos y medidos — mezclarlos con una
desconexión perdería el dato. Las dos entradas del catálogo gobiernan el **registro** y no la
sanción: el km/h y la tolerancia siguen viviendo en las secciones de Pit lane y de Largada, que es
donde el admin ya los configura. Dos interruptores para lo mismo son dos interruptores que algún
día se contradicen.

### El piloto se enteraba de sus cortes cuando ya lo habían sancionado

**Síntoma:** el contador de salidas de pista existía en el servidor y el piloto no lo veía por
ningún lado. La sanción por reincidencia le llegaba de sorpresa.

**Causa:** el dato autoritativo son los `cuts` del `LAP_COMPLETED`, que no llega hasta que el
piloto cruza la meta — hasta un minuto y medio después del corte.

**Decisión:** dos renglones fijos arriba de la cola de avisos en RC Mensajes: `CUTS: 3/5` en
amarillo y grande, y la sanción pendiente con las vueltas de gracia que le quedan. Son **estado**
y no avisos: viajan en un campo `status` que el poll trae en cada respuesta, no por la cola. La
cola entrega cada cosa una sola vez, así que una app reabierta a mitad de carrera arrancaría sin
saber cuántos cortes lleva — el número por el que lo van a sancionar. Y la inmediatez la resuelve
la app sola: el juego invalida la vuelta en el mismo frame, así que la app adelanta la cuenta y
hace sonar una chicharra nueva (`cut_warning.wav`, dos bips ascendentes de 220 ms); el servidor
corrige en el poll siguiente.

### Al que le faltaba la app lo echábamos sin decirle nada

**Síntoma:** el watchdog de presencia kickeaba, y el piloto aparecía de golpe en el menú
principal en medio de una sesión. En el journal quedaba un `presence.kick` prolijo; en el auto, un
juego que te sacó.

**Causa:** no había ningún aviso previo. Y el que sí tenía la app y se le caía estaba peor: entre
la caída y el kick, `isReporting()` seguía contestando que sí —mide contra la gracia entera—, así
que ni siquiera el panel lo marcaba.

**Decisión:** aviso por chat del servidor a los 45 y a los 15 segundos del final de la gracia, con
la cuenta regresiva, y un umbral propio de "app viva" (10 s, cinco veces el intervalo del
heartbeat) para que la caída también dispare los avisos. El aviso pasa por el mismo dispatcher que
el kick: en modo sombra no sale, porque anunciar una desconexión que no va a pasar es peor que no
avisar. Del lado de la app, una ventana nueva —RC Alerta— con un marco rojo pulsante para el caso
de app instalada sin credencial, que es el único que el piloto puede arreglar solo.

**El límite, escrito para que no se vuelva a discutir:** a quien **no tiene la app instalada** no
se le puede dibujar nada dentro del juego, porque el overlay *es* la app. El chat del servidor y
después el kick son los dos únicos canales que le llegan.

### El `.zip` de los pilotos se llevaba bytecode de otra versión de Python

**Síntoma:** ninguno todavía, y por eso vale anotarlo. Se descubrió al revisar el contenido del
`.zip`: adentro viajaba un `__pycache__/RaceControlClient.cpython-313.pyc`.

**Causa:** el `__pycache__` lo deja cualquier import desde la PC de desarrollo —un chequeo de
sintaxis, un editor con el linter prendido— y `Compress-Archive` se lleva la carpeta entera.

**Decisión:** el empaquetador los borra antes de comprimir. Es bytecode de Python 3.13 al lado de
un `.py` que corre en el 3.3 embebido del juego: no se usa, pero es basura que viaja a
veinticuatro PCs y es justo el tipo de cosa que después aparece como "a mí no me anda" sin
ninguna pista.

### La bandera estaba verde durante la vuelta de formación

**Síntoma:** se sale detrás del pace car y al costado de la pantalla hay un cuadro verde.

**Causa:** `graphics.flag == 0` —"ninguna bandera", que es el valor del 95% de una carrera— se
pintaba de verde fijo, documentado como "pista despejada". El argumento original era que un cuadro
que desaparece deja al piloto sin saber si no hay bandera o si la app se colgó.

**Decisión:** el 0 deja de dibujar nada. El verde aparece solo cuando se **da** el verde, los
mismos 3 segundos que las luces, y para eso la ventana de banderas pasa a mirar también el estado
del semáforo que trae el poll: el juego no tiene ninguna bandera para "arrancó la carrera". La
amarilla ahora parpadea, que es lo único que la distingue de un cuadro que ya estaba. Y la duda
que el verde fijo pretendía resolver —"¿se colgó la app?"— la contestan el renglón de estado de RC
Mensajes y el marco de RC Alerta, que es donde corresponde.

## [1.2] — 2026-10-28

**La lista que dejó la 1.1, primera tanda.** La 1.1 fue la primera versión probada en pista y
volvió con once observaciones de uso real. Las seis que tocan el panel entran acá; las de la app
del piloto y las del panel del operador van en la 1.3 y la 1.4, porque la app del piloto obliga a
que todos reinstalen el `.zip` y eso no se mete en la misma entrega que un cambio de CSS.

### Los íconos de marca no aparecían con ningún mod

**Síntoma:** en la torre, casi todos los autos mostraban el hexágono con tres letras en vez del
logo de la marca. Con los `ks_` de fábrica andaba; con cualquier pack de mods, no.

**Causa:** `brandOf()` exigía que el nombre del modelo **empezara** con la marca
(`compact.startsWith(key)`) y sabía sacar exactamente un prefijo de autor: `ks_`. Todo mod llega
con el prefijo de quien lo hizo adelante —`acf_`, `emka_`, `urd_`, `rss_`, `vrc_`— así que nunca
matcheaba y caía al escudo de iniciales. No era un problema de assets: los 127 SVG a color están
en el repo desde la 0.7 y están todas las marcas GT3.

**Decisión:** matchear por token en vez de por prefijo, en cuatro pasadas: cada token del nombre
contra la lista de marcas (las claves largas primero), después el nombre pegado de corrido, después
un diccionario chico de modelos que se nombran sin la marca (`296`, `720s`, `m4`, `amg`, `gt3r`,
`z06`, `elkhart`), y recién al final los estudios. El orden importa: `rss_porsche_992_gt3_cup`
resolvía a "Race Sim Studio" porque el estudio venía primero en el nombre, y lo que el usuario
quiere ver ahí es el Porsche. Un estudio solo gana cuando no hay ninguna marca real en el nombre,
que es el caso de `rss_formula_hybrid`. El test nuevo recorre la parrilla GT3 entera y verifica que
el nombre termine en un archivo que existe en disco, no solo en una cadena no vacía.

### Los pilotos desaparecían de la torre al desconectarse

**Síntoma:** alguien se va a boxes, se le cuelga el juego, vuelve a entrar — y mientras tanto no
estaba en la tabla. Si el servidor le daba otro slot al volver, entraba como una fila nueva, sin
sus vueltas. Al final de la fecha, la clasificación tenía al mismo tipo dos veces.

**Causa:** `StateTracker` indexa por `carId`, que es el número de slot y el servidor lo reutiliza.
`/api/state` mandaba `getConnected()`: el que no estaba conectado en ese instante, no existía.

**Decisión:** la torre pasa a ser de la **jornada**, no del instante. La identidad es el
`driverGuid` —el SteamID, que no cambia— y el snapshot lleva `connected: true|false`. El
desconectado queda en gris al 45 %, con sus tiempos y sin posición, abajo de todo; el que vuelve
recupera su fila aunque el slot sea otro. Los tiempos y las vueltas se siguen reseteando con cada
sesión, que es lo correcto: lo que persiste es la persona, no sus tiempos de práctica.

Esto obligó a un segundo mapa, `historial`, indexado por guid: cuando otro piloto ocupa un slot
liberado, el ocupante anterior se muda ahí antes de que le pisen la identidad. Sin eso, el primer
piloto que se iba y era reemplazado desaparecía igual que antes — con la diferencia de que ahora
nadie lo habría notado hasta ver la clasificación final. Hay un techo de 64 filas por jornada, para
que una fecha larga de servidor público no acumule sin fin.

### La carrera no podía terminar

**Causa:** `SessionPhase` tiene `"finished"` desde la 0.5 y **nadie lo ponía nunca**. El único que
movía la fase era la largada, que conoce idle, formación y verde. Era el bug de siempre de este
proyecto: no falla, simplemente no pasa.

**Decisión:** `END_SESSION` del servidor de AC pone la fase en `finished` si veníamos en carrera, y
el `NEW_SESSION` siguiente la devuelve a `idle`. Recién con eso el link de **"Posiciones finales"**
—el mismo informe que ya vivía en la pestaña Sanciones— puede aparecer en el título de la torre al
terminar, que es cuando se lo busca. Hay un test de invariante que verifica las dos puntas: que el
backend llegue al estado y que el panel lo lea.

### Los tres tipos de torneo se fueron: ahora la liga guarda su reglamento

**Síntoma:** no había vuelta atrás. El admin tocaba dos umbrales para la fecha de resistencia y la
configuración de la fecha normal se perdía; además, el modo que figuraba elegido ya no describía lo
que estaba corriendo.

**Decisión:** fuera `PRESETS`, `PresetName`, `applyPreset()` y `POST /api/config/preset`. En su
lugar, **perfiles de carrera**: el admin guarda todo el reglamento —catálogo de infracciones,
sanción de largada, zona y sanción de pit, presencia— con el nombre que su liga use para hablar de
él, y lo repone entero de una. Un perfil **no guarda nada de red, puertos ni nombre de liga**:
elegir un perfil no puede desconfigurar un servidor.

Las dos validaciones viven en el servidor y devuelven 409 con el mensaje ya escrito: nombre
repetido —comparado sin mayúsculas ni acentos— y contenido idéntico a uno que ya existe, **diciendo
cuál es**. La segunda compara un JSON canónico con las claves ordenadas, no el objeto crudo, que
cambia de orden según por dónde se lo escribió. Aplicar un perfil usa `mergeConfigInto` y no un
reemplazo: los motores tienen referencias vivas a los objetos anidados de la config, y pisarlos los
deja mirando un objeto huérfano.

Un `config.json` viejo con `preset` adentro pierde la clave al cargarse, igual que ya pasaba con
`incidents` y `trackLimits`. El asistente de primera vez queda en **tres pasos**: el que se fue era
justamente el de elegir modo, y era el único obligatorio — pedirle a alguien que nunca vio el
producto que elija entre "casual" y "estricto" es pedirle una decisión que no tiene con qué tomar.

### La chapa de sesión y los colores del mapa

Dos cosas que en el escritorio se ven bien y a dos metros de la pantalla no: la chapa **P/Q/R**
medía 13 px al lado de un reloj de 26, así que su color —gris, ámbar, verde según cuánto pesa la
sesión— no llegaba a leerse. Ahora mide 22, el reloj bajó a 18 y los colores subieron de saturación
porque ocupan más superficie.

Y en el mapa los veinte autos eran veinte puntos del mismo dorado. Ahora cada uno se pinta del
color de su marca —Ferrari rojo, BMW azul, Porsche celeste, Mercedes gris, Aston Martin verde
oscuro, Lexus violeta, McLaren naranja, Corvette amarillo— con un borde oscuro fino para que un
color apagado no se pierda sobre el asfalto. Es la **misma** tabla que ya usaban los escudos de
monograma, no una segunda: tener dos paletas para lo mismo termina en un auto que es rojo en la
torre y naranja en el mapa. Lo que no está en la tabla sigue derivando un tono estable de su
nombre. El auto seleccionado sigue blanco y el que perdió telemetría sigue hueco y gris: esos dos
estados ganan sobre el color de marca, porque dicen algo que el color de marca no dice.

### Tests

De 270 a 288. Los nuevos: el matcheo de marcas contra los archivos en disco, la persistencia del
roster —incluido el caso del slot reutilizado, que es el que falló primero—, los perfiles de reglas
con sus dos conflictos, y dos invariantes de panel: que la fase `finished` sea alcanzable y que la
sección de perfiles esté cableada de punta a punta. Ese último existe porque un borrado a medias no
rompe nada visible: el cajón de Reglas sigue abriendo y la sección nueva queda muerta.

## [1.1] — 2026-10-26

**La primera versión probada en pista.** La 1.0 se corrió en Spa con gente adentro y volvió con
dieciséis observaciones. Una era un bug que dejaba el producto sin su pantalla principal; el resto
son todas de la misma familia: cosas que en el escritorio se ven bien y arriba del auto no sirven.
Eso es lo que no se puede deducir desde acá, y por eso esta entrada es larga.

### El mapa no se dibujaba nunca (y los autos tampoco)

**Síntoma:** en Spa el circuito no apareció y el piloto no se vio a sí mismo en el mapa en vivo.
Parecían dos problemas —uno de trazado y otro de posiciones— y eran el mismo.

**Causa:** `trackLearner.setTrack()` se llamaba en un solo lugar, el handler de `NEW_SESSION`. Ese
evento llega cuando la sesión **arranca**, y el caso normal del producto es el contrario: el admin
conecta Race Control a un servidor que ya viene corriendo hace rato. Ahí `NEW_SESSION` no llega
nunca. Con `track` vacío pasan dos cosas, las dos en silencio: `loadFromCatalog()` no corre, así
que el trazado de Spa —que está en el catálogo, entre los 199 circuitos— no se carga; y
`onCarUpdate()` arranca con `if (!this.track) return`, así que tampoco se aprende nada de la
telemetría. Sin trazado no hay límites del mapa, y sin límites no se puede ubicar un auto. De ahí
que fallaran las dos cosas juntas.

**Arreglo:** el circuito también se toma del `SESSION_INFO`, que es la respuesta a nuestro propio
`GET_SESSION_INFO` y que el latido de `ConnectivityManager` dispara cada 5 segundos desde la 0.9.
Trae los mismos campos. Así el mapa aparece a los cinco segundos de conectar, venga o no un
`NEW_SESSION`. `setTrack` compara la clave y sale enseguida si no cambió, así que llamarlo doce
veces por minuto no cuesta nada.

**Test:** `core.test.ts` levanta un Race Control, le manda un único `SESSION_INFO` de Spa y exige
que el outline exista y tenga más de 100 puntos. Se verificó que falla sin el arreglo.

### Torre de tiempos

**El compuesto ahora dice `S8M` y no `Michellin S8M`.** El juego devuelve el nombre comercial
completo y lo único que distingue un compuesto de otro es la sigla entre paréntesis. El nombre
largo queda en el `title` de la celda para quien lo necesite.

**`PIT` quiere decir lo mismo en las dos columnas.** La de velocidad decía `PIT` y la de paradas
decía `En box`: dos palabras para el mismo estado, en la misma fila, a tres centímetros una de
otra. Ahora las dos dicen `PIT`.

**Se fueron las columnas "Fuera" y "Sectores".** La de sectores porque no funciona —el reparto por
sector que manda la app no estaba llegando bien— y una columna que muestra guiones es peor que no
tenerla. La de cortes porque la cuenta real ahora vive en la bandeja de incidentes, agrupada por
piloto, que es donde se la mira. El código de `renderSectors` se borró en vez de dejarlo
comentado: si vuelve, vuelve con el dato andando.

**`Vts.` ahora dice `Laps`.** Era la única abreviatura de la tabla que necesitaba explicación.

### La bandeja de incidentes se agrupa por piloto

**El problema, textual:** "giré yo solo y me anotó 10 incidentes". Y es correcto —hubo diez
eventos— pero la bandeja los mostraba como diez tarjetas sueltas en orden cronológico. Para saber
qué hizo un piloto había que recorrer la lista entera contando a ojo.

**Ahora cada piloto es un bloque plegable** con su nombre y dos cuentas: **Cuts** (irse de pista) y
**Choques** (pegarle a algo, solo o contra otro). Son dos cosas que se juzgan distinto: diez cuts
es alguien usando de más el pianito, diez choques es alguien peligroso. Lo que no cae en ninguna
de las dos —contramano, desconexión, telemetría inconsistente— se cuenta aparte en "Otros", en vez
de forzarlo adentro de una: meter una desconexión en "choques" sería inventar un dato. Hay además
un chip de "N sin revisar", para que no haya que abrir el bloque para saber si queda algo
pendiente.

**Los toques ahora dicen contra quién fueron.** El dato ya estaba —`Incident.parties` guarda los
dos pilotos desde siempre— y no lo mostraba nadie. El título pasó de "Toque entre autos" a "Toque
con Fulano".

**Un toque aparece en los dos bloques, a propósito.** Es el mismo incidente (mismo id: resolverlo
de un lado lo resuelve de los dos), pero cada piloto tiene que ver su propia cuenta completa, y el
título se da vuelta según de qué lado se lo esté leyendo.

**Test nuevo:** `panel.test.ts` lee el union `IncidentKind` del motor y exige que cada miembro esté
clasificado en el panel. Sin eso, el día que se agregue un tipo nuevo de infracción el panel lo va
a contar como "otro" y titularlo "incidente", sin romperse y sin avisar.

### La app del piloto dejó de ser tres recuadros negros

Esta es la mitad del release y es toda la misma idea: **un overlay de carrera no es una ventana**.
Lo que no está pasando ahora mismo no tiene que ocupar un pixel.

**Las tres ventanas van sin fondo, sin borde, sin título y sin ícono.** Son cuatro llamadas
distintas (`setBackgroundOpacity`, `drawBorder`, `setTitle`, `setIconPosition`) y dejarse una
afuera se nota: sin la segunda queda el marco flotando alrededor de la nada, sin la cuarta queda
el iconito colgado sin ventana que lo sostenga. El juego igual las deja mover y redimensionar, y
les vuelve a dibujar el fondo mientras el mouse está encima —que es justo cuando hace falta—.

**RC Mensajes: más finita, más grande y en rojo.** La letra pasó de 14 a 20 px y las líneas de
cuatro a tres: a cuatro líneas chiquitas no las lee nadie en movimiento, y sin bajar una la
ventana quedaba más alta que antes en vez de más finita. Tres avisos simultáneos en pista son
muchísimos; lo normal es uno.

**"Conectado a Race Control" ahora se borra a los 8 segundos.** Se escribía una vez y se quedaba
toda la carrera informando algo que ya había pasado. Los estados que sí son un problema —que no
aparezca el backend, que venza la credencial— no vencen y se quedan: ahí el cartel es la única
pista que tiene el piloto de por qué la app no hace nada.

**La vuelta invalidada se avisa en el momento del corte, no al cruzar meta.** Era el pedido más
importante de la lista y obligó a cambiar de fuente. El backend se entera por el `LAP_COMPLETED`,
o sea al cerrar la vuelta: para el comisario está perfecto —lo que juzga es la vuelta cerrada—
pero el piloto se enteraba un minuto y medio después de haberla arruinado, cuando ya la manejó
entera apretando. El juego, en cambio, la invalida en el instante del corte y lo publica en
`acsys.CS.LapInvalidated`; como la app corre adentro del juego, lo lee y avisa ahí mismo. **El
servidor dejó de empujar ese aviso a la pizarra**, porque llegaría tarde y repetido. El incidente
se sigue registrando igual.

Dos sutilezas que costaron un bug cada una: se avisa por **flanco** y no por estado (leído cada
frame, el estado da sesenta avisos por segundo), y **en el pit lane no se avisa** (la out lap nace
invalidada siempre, así que sin el filtro cada salida de boxes arrancaría con un cartel rojo que
no corresponde a ningún error).

**El aviso ya no dice el número de vuelta.** Dice `VUELTA INVALIDADA` y nada más. El número era
información del servidor, no del piloto: uno sabe perfectamente en qué vuelta está.

**RC Banderas es un cuadro de color, sin una sola palabra.** Verde cuando no hay bandera, amarillo
cuando hay amarilla, azul, negra, blanca, el tablero de cuadros para la final y el círculo naranja
sobre negro para la de penalidad —que es negra igual que la otra y sin el círculo serían
indistinguibles—. Es la única de las tres que muestra algo en reposo, y es deliberado: "pista
despejada" también es información, y un cuadro que desaparece cuando no pasa nada dejaría al
piloto sin saber si no hay bandera o si la app se colgó.

**RC Largada son cinco luces y antes era la palabra "idle".** En reposo no se dibuja nada: la
ventana es un vidrio. Al apretar "Iniciar formación" aparecen cinco discos rojos parpadeando a
medio segundo —el ritmo del semáforo de verdad, lento como para que se note de reojo sin
convertirse en un estrobo—. Al apretar "Verde" pasan a verde y suena el `green green green`, y a
los tres segundos desaparecen.

Todo esto se dibuja con `ac.glQuad`, que es lo único que hay: rectángulos de un color plano. Los
discos se arman apilando doce franjas horizontales cuyo ancho sale del círculo. No hay imágenes,
así que no hay un asset más que empaquetar, que se pueda perder al instalar, ni que haya que
escalar a la resolución de cada uno.

**La geometría se verificó fuera del juego**, con un stub de la API de AC: las siete banderas caen
dentro de la ventana, el tablero alterna dos colores, el idle no dibuja nada, la formación
parpadea mitad y mitad, son diez discos (cinco luces con su carcasa) y el verde se apaga a los
3,0 s exactos.

### El archivo que nunca corre en CI ahora tiene tests

`RaceControlClient.py` vive dentro del intérprete Python embebido de Assetto Corsa. No lo compila
nadie, no lo importa ningún test, y la primera vez que se ejecuta es en la PC de un piloto a punto
de largar. Si tiene un error de sintaxis el juego no avisa: la app **no aparece** en el menú, y el
reporte que llega es "no me anda", sin línea y sin excepción.

El riesgo concreto es la versión: AC trae **Python 3.3**. Un f-string, un walrus o un `async` son
sintaxis que ese intérprete no conoce, y el editor no los marca porque el archivo es Python
perfectamente válido en cualquier versión moderna. `clientApp.test.ts` los busca, verifica que no
se importe nada que no exista en 3.3, y exige que **toda** ventana creada pase por
`ocultarChrome` —una ventana nueva agregada dentro de seis meses aparecería con el fondo negro
puesto y volvería el problema que esta versión acaba de arreglar—.

### Hay que reinstalar la app

La app cambió entera, así que **todos los pilotos tienen que volver a bajar el `.zip` y arrastrarlo
a Content Manager**. Pisa la instalación anterior sin dejar restos. El `ui.json` pasó a `1.2` para
que se note en el listado de apps del juego cuál está instalada.

## [1.0] — 2026-10-26

**Primer release público.** El repositorio pasa a ser público y el `.zip` de la app de los pilotos
deja de dar 404 a quien no tenga acceso — era la única pieza que impedía que un admin ajeno al
proyecto pudiera arrancar solo. El salto de número es por eso y no por el tamaño del cambio: lo
que sigue es media docena de ajustes de barra y de cajón, pero son los que hacen que la primera
pantalla se entienda sin que nadie la explique al lado.

### La configuración manual del hosting se fue

**Contexto:** la 0.9 decidió dejarla. El razonamiento está escrito más abajo y era defendible:
había hostings donde el campo **Send Address** está a la vista, se completa en diez segundos y el
ticket de soporte era una espera de dos días al pedo. Lo que lo invalida es un dato nuevo: **el
primer release sale sobre EmperorServers**, y ahí ese campo no existe. Los plugins UDP vienen
apagados de fábrica y la sección directamente no se dibuja. Es decir que los dos primeros pasos
del manual mandaban al admin a buscar algo que no estaba, y el camino real —el botón del final,
que arma el ticket en inglés con la dirección ya adentro— quedaba escondido como nota al pie del
paso 2.

**Ahora el cajón de Conexión tiene un paso y es ese botón.** El campo copiable, su botón de copiar
y la instrucción de pegarlo en **Server Options** se fueron. El paso 3 del asistente de primer
arranque dice lo mismo que el cajón, así que cambió igual. La guía completa sigue linkeada y sigue
documentando el campo, que es donde corresponde que viva el caso del hosting que sí lo expone.

**La dirección no desapareció, cambió de rol.** Estaba en un input porque era algo que había que
copiar; ahora está en la fila "La dirección de tu liga" del bloque de Estado, **con el puerto**
—antes mostraba solo la IP—, que es el renglón exacto que el soporte del hosting tiene que haber
cargado. Sirve para verificar, no para configurar. Y como el mensaje de soporte la sigue
necesitando, dejó de leerse del DOM y pasó a una variable del módulo: leerla de un input la ataba
a que ese input existiera, que es la clase de falla silenciosa que este proyecto ya pagó varias
veces —`$()` devuelve `null`, el botón deja de andar, nadie se entera—.

### La barra de arriba

**Control de carrera y Sanciones ahora se ven como lo que son: secciones.** Eran dos links de
texto gris con el mismo fondo `#20242e` que los botones usan en hover, así que la pestaña activa y
un botón cualquiera se dibujaban idénticos. Cinco cosas en fila, todas iguales, y dos de ellas
cambian la pantalla entera mientras las otras tres abren un cajón y te devuelven donde estabas.
Ahora las dos pestañas viven en un control segmentado: un hueco hundido, más oscuro que la barra,
con la activa levantada adentro. La diferencia con los botones es de **relieve**, no de color, y
por eso se lee sin tener que comparar — un grupo está metido en la barra y el otro apoyado encima.
Sanciones además tiene ícono, un mazo de juez. No otra bandera: a 15 px se confundiría con la de
al lado.

**Salir es un ícono y es rojo.** Una puerta con la flecha saliendo, sin texto y sin fondo. Es la
única acción de la barra que no se deshace con otro click, así que conviene que no se parezca a
las dos que sí. El nombre accesible va en `aria-label`, y el área de click se mantiene en 30×30
aunque el ícono mida 16.

**El cartel de modo sombra se fue de la barra.** El modo vive entero adentro del cajón de
Conexión: el interruptor y la explicación.

**Esto reabre un riesgo conocido y conviene dejarlo dicho.** El cartel existía porque se puede
correr una carrera entera en sombra sin notarlo: las sanciones se anotan, nadie las cobra, y el
panel se ve exactamente igual que uno sancionando de verdad. El test
`el modo sombra sigue siendo visible fuera del cajón de conexión` se borró con él. Queda anotado,
en el HTML y en el test que lo reemplaza, dónde reponer el aviso si eso llega a pasar en una fecha
real: en el encabezado de la torre de tiempos, junto a la chapa de "ningún piloto con la app", que
es donde el ojo ya está.

### Tests

Los dos que se fueron se reemplazaron por dos que cubren lo que quedó: que `.btn-salir[hidden]`
tenga su `display: none` explícito —es `flex` y arranca escondido, exactamente el bug que dejó el
modal de primer arranque visible para siempre— y que el control segmentado tenga marco propio y la
pestaña activa se distinga de la inactiva. **256 tests, todos verdes.**

### Un arreglo de orden en este mismo archivo

La entrada de la 0.9 había quedado **debajo** de la 0.8, entre la 0.8 y la 0.7. Está movida arriba
de todo donde corresponde. No cambió una palabra de su contenido, incluido el párrafo "Lo que no
cambió, y por qué" que esta versión revierte: un changelog que se corrige a sí mismo hacia atrás
deja de servir para entender por qué se decidió algo.

---

## [0.9] — 2026-10-26

La 0.8 nunca llegó a desplegarse: todo lo de esa versión sale a producción con esta. Lo que se
sumó encima es una tanda de detalles de la torre de tiempos y **un bug de red que hacía parecer
que el servidor se caía solo cada treinta segundos**.

### El panel decía "Sin señal" con el servidor perfecto

**El síntoma:** con el servidor de Assetto Corsa andando y conectado, el botón de la barra
parpadeaba. Verde un ratito, rojo un rato largo, verde otra vez. En loop, sin que pasara nada.

**La causa es aritmética, y estaba repartida en dos archivos.** Con nadie manejando, el servidor
de AC **no manda un solo paquete por su cuenta**: todo su tráfico es telemetría de autos en pista.
Lo único que llegaba con la pista vacía era la respuesta a nuestro `GET_SESSION_INFO`, que se
pedía **cada 30 segundos**. Y la ventana que decide "¿me está llegando señal?" era de **5**.

Cinco segundos en verde, veinticinco en rojo. El admin veía su servidor caerse y levantarse solo,
cada medio minuto, con todo funcionando.

**El arreglo son dos números y una consolidación:**

- El latido bajó de 30 a **5 segundos**, y pasó a vivir en el mismo tick que el keepalive de
  posiciones, en `ConnectivityManager`. Antes eran dos temporizadores distintos, en dos archivos,
  mandando pedidos al mismo servidor a cadencias distintas — la clase de duplicación que termina
  en que alguien cambia una sola.
- La ventana de silencio subió de 5 a **15 segundos**, que son tres latidos. Hay que perder tres
  respuestas seguidas para que el panel se ponga en rojo, así que un datagrama perdido —que en UDP
  pasa— ya no se ve como una caída.

Y queda **más** sensible a una desconexión de verdad, no menos: la ventana de 5 s medida contra un
latido de 30 no detectaba absolutamente nada; ahora una caída real aparece en 15 segundos.

**`GET_SESSION_INFO` como latido, y no un ping inventado.** El protocolo de plugins de AC no tiene
un ping. Lo que sí tiene es un pedido que el servidor contesta **siempre**, haya o no alguien en
pista, y esa respuesta ya hacía falta por otro motivo: sin ella el reloj de la sesión se extrapola
contra el reloj local y se desfasa durante toda la carrera. Un solo mecanismo para las dos cosas.

**Una invariante nueva (`connectivity.test.ts`).** El test lee las constantes del `dist/` y exige
que la ventana de silencio sea al menos tres latidos, y que `connectivity.js` y `diagnostics.js`
usen exactamente el mismo número. Si mañana alguien sube el latido sin tocar la ventana, vuelve
este bug, y vuelve en silencio — porque todo "funciona".

### Cinco detalles de la torre de tiempos

Los cinco salen de mirar el panel durante una carrera real. Ninguno es un bug; los cinco son
cosas que la pantalla no terminaba de decir.

**"L4" en vez de "4".** La columna de vueltas queda entre tiempos y velocidades, todos números. Un
"4" pelado no se lee como vueltas hasta que uno sube la vista al encabezado.

**"PIT" en la columna de velocidad.** En boxes la velocidad no dice nada —va a 40, o a 0— y lo que
el admin necesita saber es por qué ese auto se descolgó de la clasificación. Hasta ahora la fila
se pintaba de ámbar **solo** con `telemetry.inPitLane`, que sale de la Shared Memory del juego y
por lo tanto existe únicamente si el piloto tiene la app. En una liga donde nadie la tiene —el
caso normal al empezar— no se veía nunca a nadie en boxes.

Ahora hay dos fuentes, en orden: la app del piloto cuando está, y la **zona de pit configurada**
cuando no. Es la misma zona que ya usan `PitSpeedMonitor` y `PitComplianceTracker` para sancionar,
a propósito: si el panel dijera PIT con una definición propia, el admin vería a alguien "en boxes"
al que el motor no le mide la velocidad de pit, y calibraría la zona mirando un dibujo que miente.

Lo que se descartó: deducirlo de "velocidad 0 por mucho tiempo", que es lo intuitivo. Un abandono
en la grava también está parado, y es justo el caso en el que hace falta ver que **no** es una
parada en boxes.

**La columna de Ping desaparece cuando nadie la puede llenar.** Decía "sin app" en rojo en cada
fila. El ping no viene del servidor de Assetto Corsa —el protocolo UDP no transporta ese dato, ni
el nuestro ni el de ningún plugin— sino que es el round-trip de la app del piloto contra Race
Control. Sin app no hay número posible, así que veinte celdas rojas no informaban nada y hacían
parecer roto algo que simplemente no aplica. Cuando al menos un piloto reporta, la columna vuelve.

**El kick se mudó adentro de un menú de tres puntitos.** Un botón "Expulsar" visible en veinte
filas de una tabla que se reordena sola es un accidente esperando que alguien mueva el mouse en el
momento equivocado. La doble confirmación sigue igual, y con el menú cerrado queda un punto rojo
sobre los puntitos: es lo único que avisa que hay un kick a medio confirmar.

El menú se cuelga del `<body>` con `position: fixed`, no de la celda. La tabla vive adentro de un
contenedor con `overflow: auto` en los dos ejes, así que un popup dentro de la fila quedaría
recortado por el scroll — y justo en la última fila, que es donde más se usa.

**"Ningún piloto con la app", al lado del título de la torre.** Es la respuesta a "los neumáticos
y los sectores no me aparecen". No era un bug: Sectores, Box, Neum., Comb. y Ping salen todos del
mismo lado —la app que instala cada piloto— y sin ella quedan en guiones para siempre. El cajón de
Conexión ya lo decía bien, en "Pilotos con la app reportando", y nadie abre ese cajón. Ahora el
aviso está donde se nota el síntoma, en gris y no en rojo —no es una falla, es una pieza que
todavía no está instalada— y clickearlo abre el diagnóstico.

**Una invariante nueva en `panel.test.ts`.** El test que verifica que toda clase tenga al menos
una regla CSS solo miraba `index.html`, y la torre de tiempos no está en el HTML: cada fila la
construye `createCarRow` en vivo, con las clases escritas a mano en un string. El menú nuevo, el
"PIT" y los badges viven ahí. Una errata en ese string no rompe nada —el elemento se dibuja igual,
sin formato— que es exactamente la familia de bugs que este archivo persigue.

### El README adelgaza

Se le sacó la sección de documentación: el README es la puerta de entrada de quien va a usar el
producto, no el índice del repositorio. Los documentos siguen donde estaban y enlazados desde
donde corresponde. También se fue el párrafo sobre credenciales vencidas y sobre la exigencia de
la app: son detalles de operación que ya viven en `client-app/README.md` y en el propio panel, y
en la primera página solo agregaban una preocupación antes de tener el producto andando.

### Lo que no cambió, y por qué

**La sección "Cómo conectar tu servidor" se queda donde está.** La pregunta era si no alcanzaba
con el botón que arma el mensaje para el soporte del hosting, dejando "Revisar ahora" adelante. No
alcanza: hay hostings donde el campo **Send Address** está a la vista y se completa en diez
segundos sin hablar con nadie, y para esos el ticket de soporte es una espera de dos días que no
hacía falta. El manual primero y el diagnóstico después sigue siendo el orden correcto para quien
abre ese cajón por primera vez, que es cuando las cuatro filas de estado dicen "--" y no
significan nada todavía.

---

## [0.8] — 2026-10-26

La 0.7 cerró la puesta en marcha. Esta versión sale de la primera carrera de verdad: alguien
manejó, se fue de pista dos veces, chocó contra un muro dos veces, y después contó qué vio y qué
no. Seis cosas, y las tres primeras son fallas silenciosas de manual — el producto estaba
"funcionando" en todas ellas.

### El circuito ya no se aprende: viene dibujado

**Contexto:** hasta ahora el trazado del mapa se aprendía de la telemetría. Cada `CAR_UPDATE` trae
la posición del auto en el mundo y en qué punto de la vuelta está, así que con suficientes vueltas
el dibujo se arma solo. Funcionaba en la demo y no funcionaba en pista, por dos razones que no se
arreglan afinando el algoritmo:

- **Necesita que alguien dé vueltas, y no dibuja nada hasta el 40%.** Con un solo auto en pista
  —que es exactamente el caso de la primera prueba de cualquier liga, y el de toda la práctica
  libre— eso es una tarde mirando una barra de progreso.
- **Aprende por dónde pasaron los autos, no dónde está la pista.** En una curva que todos cortan,
  el dibujo corta.

Ahora hay un **catálogo**: un JSON por circuito que viaja empaquetado con Race Control, y el mapa
sale completo y con la forma real desde el primer segundo. Los trazados se generan con
`server/scripts/build-track-catalog.js` sobre una instalación de Assetto Corsa.

**De dónde sale el dibujo.** De `ai/fast_lane.ai`, la línea de la IA que cada circuito trae
adentro. Y no del `map.png`, que era la opción obvia: el PNG es una imagen, y sacarle la forma
obliga a recorrer píxeles y adivinar el orden del recorrido. La línea de la IA ya es lo que hace
falta —una secuencia **ordenada** de coordenadas del mundo, en el mismo sistema en el que el
servidor reporta la posición de cada auto—, así que el dibujo y los puntitos quedan alineados sin
convertir nada.

**Lo que se descartó a propósito:** el campo `length` del archivo. Está ahí y era cómodo, pero
obliga a confiar en que ese float signifique lo que uno cree. La distancia acumulada entre puntos
se calcula sola y da lo mismo, porque `normalizedSplinePosition` de AC es exactamente eso. Un
supuesto menos. Y un archivo que no cierra —una línea que termina lejos de donde empezó— se
saltea con un aviso en vez de generarse: un trazado torcido es peor que no tener trazado, porque
el mapa dibujaría una pista que no es y nadie lo notaría hasta ver un auto pasar por afuera.

**El aprendizaje no se borró.** Sigue siendo la red de contención para las pistas mod que no estén
en el catálogo. Lo que cambió es cuál es el camino principal. El panel además dice en cuál de los
dos está, en vez de prometer siempre un aprendizaje: con catálogo no hay nada que esperar, y sin
catálogo hay que explicar la espera.

**Van 198 circuitos** en esta primera generación. Para sumar uno que no esté no hace falta una
versión nueva: el formato de lo aprendido y el del catálogo son el mismo a propósito, así que el
JSON generado se puede dejar en la carpeta de datos de la liga y se toma en la sesión siguiente.
Está documentado en [operacion.md](server/docs/operacion.md).

**Pistas que no son un circuito.** Una subida de montaña (Trento-Bondone) o una ruta punto a punto
terminan a kilómetros de donde arrancaron. La primera versión del generador las descartaba por "la
línea no cierra", que era confundir "no es una vuelta" con "está roto": son pistas perfectamente
válidas. Ahora entran marcadas `closed: false` y el panel no une el último punto con el primero
—hacerlo dibujaría una recta cruzando el mapa entero, y nada en la pantalla diría que esa recta no
es pista—. De los 199 archivos leídos, el único que se descartó de verdad fue una pista de drift
sin línea de IA.

**Si el juego está en otra PC** —que es el caso normal— hay un recolector en PowerShell
(`scripts/recolectar-trazados.ps1`) que junta solo los `fast_lane.ai` en un zip de pocos MB. No
hace falta copiar `content\tracks`, que son decenas de GB de modelos y texturas, ni instalar Node
en la máquina del simulador.

**Un bug que apareció al hacer esto:** `setTrack()` recibía el nombre del circuito y descartaba la
variante. Spa con chicane y sin chicane, o el Nordschleife turístico y el de endurance, son la
misma carpeta y dos dibujos distintos: compartían una sola entrada, y el segundo que se corriera
quedaba mirando el trazado del primero. Ahora la variante entra en la clave.

### Irse de pista por fin cuenta

**Contexto:** el piloto se fue de pista dos veces, el juego le invalidó las dos vueltas, y en Race
Control no apareció absolutamente nada. Los choques contra el muro sí se registraron.

El único camino que existía para detectar una salida pasaba por tres filtros: que el piloto tuviera
la app instalada, que la salida superara el umbral de ruedas del admin (4 por defecto), y que
hubiera tres salidas antes de que algo llegara a la bandeja. Mientras tanto, el `cuts` que manda el
propio servidor en cada `LAP_COMPLETED` —que es exactamente lo que había invalidado esas vueltas—
se usaba solo para detectar telemetría inconsistente.

Se dio vuelta: **el corte del servidor es ahora la fuente principal**, y la app del piloto pasa a
aportar el detalle. Quedó así:

| | De dónde sale | Llega siempre | Qué hace |
|---|---|---|---|
| **Corte** | `cuts` del `LAP_COMPLETED` | sí | cuenta en la torre, abre la entrada en la bandeja, dispara la sanción por reincidencia |
| **Salida** | `numberOfTyresOut` de la app | solo con la app | aporta ruedas, duración, dónde, y la revisión por ganancia de tiempo |

Tres consecuencias:

- **Columna "Fuera" en la torre de tiempos**, visible siempre, con las vueltas que el servidor le
  invalidó a cada piloto en esta sesión.
- **Una entrada en la bandeja por vuelta invalidada**, no una por corte: una vuelta con tres
  cortes es un renglón que dice tres, no tres renglones.
- **La sanción automática ahora sale del corte del servidor.** Esto corrige algo que, de haberse
  dejado como estaba, habría sancionado dos veces por la misma salida al piloto que tiene la app y
  nunca al que no la tiene — la misma infracción costando distinto según lo que cada uno tenga
  instalado. Hay un test que lo cubre.

### El logo de la marca no se veía en ninguna fila

**Contexto:** se probó con un Mercedes y la columna "Auto" mostraba el escudo con iniciales. No
era un problema de reconocer la marca: `mercedes-benz.svg` está en la biblioteca y el modelo
resolvía bien.

El panel pedía el logo a `/brands/<marca>.svg`, una ruta **absoluta**. En producción el panel vive
en `/l/<liga>/`, así que esa ruta no le pegaba al worker de la liga sino a la raíz del portal, que
no tiene esa carpeta. 404 por cada auto, y el escudo de iniciales en **todas** las filas, siempre,
desde que el producto salió a internet. En desarrollo —panel en la raíz— andaba perfecto.

Es el mismo error que ya tenía su propia regla en el proyecto: toda URL del panel va con el prefijo
`BASE`. Lo cumplían los `fetch` y los links de navegación; esta imagen, no.

### Práctica, Qualy o Carrera, al lado del reloj

Una chapa de una letra junto al reloj de sesión: **P**, **Q** o **R**, con color propio. El panel
mostraba el tiempo restante sin decir de qué sesión era, y no es un detalle: la torre de tiempos se
ordena distinto en carrera que en clasificación, así que leerla sin saber en cuál se está es leer
mal.

### La largada se apaga fuera de la carrera

Los botones de formación y verde solo tienen sentido en una carrera. En práctica o clasificación
quedaban habilitados, y apretarlos mandaba comandos que no significaban nada. Ahora la tarjeta se
atenúa y los botones se deshabilitan; el backend además rechaza el pedido con un mensaje claro, por
si llega por otro camino.

**"Reiniciar" queda siempre disponible**, a propósito: es la salida de emergencia, y una salida de
emergencia que se deshabilita sola según el estado no es una salida de emergencia.

### La app del piloto: tres ventanas en vez de una

**Contexto:** la app funcionaba, pero en el menú de apps del juego aparecía una sola entrada con
las cuatro etiquetas apiladas. El piloto que solo quería ver las banderas tenía que aguantar el
resto ocupando pantalla.

Ahora son tres entradas independientes:

- **RC Mensajes** — los avisos de dirección de carrera, al estilo RealPenalty.
- **RC Banderas** — la bandera de pista vigente.
- **RC Largada** — el semáforo de la largada en movimiento.

Las tres comparten los mismos hilos de fondo. Cerrar una ventana, o no abrir ninguna, no apaga el
heartbeat ni el reporte de telemetría: solo deja de dibujar. Si fuera al revés, un piloto que
cierra la ventana equivocada sería expulsado por el watchdog de presencia sin entender por qué.

**Lo nuevo de fondo es la pizarra de avisos.** Hasta ahora el único canal hacia el piloto era el
chat, y la app mostraba únicamente lo que empezara con "PENALIDAD". Las vueltas invalidadas, las
sanciones anuladas y todo lo demás no llegaban. Ahora el servidor mantiene una pizarra por piloto
(`/api/client/poll`) y la app la muestra: hasta cuatro avisos a la vez, que se borran solos a los
25 segundos.

**Los dos canales conviven y no es redundancia.** El chat le llega a cualquiera, tenga la app o no,
y es la única garantía de que un sancionado se entere; la pizarra deja el aviso fijo en pantalla en
vez de que se pierda entre las líneas de "fulano se conectó". Un aviso que llega por los dos lados
se muestra una sola vez.

**El modo sombra calla a los dos.** El aviso por la app sale desde adentro de la misma acción que
el del chat, así que no hay forma de que el modo sombra silencie uno y deje pasar el otro.

**Un dato que no se le manda al piloto:** la sospecha de telemetría inconsistente. Es una sospecha
sobre su propia app y es asunto del comisario — decírsela al sospechoso solo le avisaría que lo
están mirando.

### Lo que no cambió, y por qué

**La biblioteca de logos de marcas no hacía falta.** Ya hay 127 SVG empaquetados, incluido el de
Mercedes-Benz. El problema era la ruta, no el catálogo.

---

## [0.7] — 2026-10-26

La 0.6 cerró la auditoría. Esta versión cierra lo que la auditoría no podía ver: el momento en que
alguien que no es técnico se sienta por primera vez frente al panel y tiene que conectar su
servidor. Hubo que probarlo contra un hosting real para descubrir que el camino que el producto
describía no era el camino que terminaba funcionando.

### El ticket de soporte viene escrito

**Contexto:** el campo `Send Address` no siempre existe. Varios hostings de Assetto Corsa vienen con
el soporte de plugins apagado desde un archivo del propio panel (`disable_plugins` en el
`config.yml` del Server Manager), y cuando está apagado la sección entera no se dibuja. No está
escondida en otra pestaña: no está. El admin busca un campo que no existe, y es el primer paso del
producto.

Ahora el cajón de **Conexión** tiene un botón, **"Copiar el mensaje para mi hosting"**, que arma el
ticket completo y lo deja en el portapapeles. Tres decisiones sobre ese texto, las tres aprendidas
de la ida y vuelta real con EmperorServers:

- **Va en inglés.** El soporte de los hostings de AC contesta en inglés. Un ticket en castellano
  agrega una traducción en el medio y un día de demora.
- **Pide que configuren el plugin, no que habiliten el campo.** Es la diferencia entre que funcione
  y esperar para siempre: el soporte no habilitó nada para que lo llenara el cliente, lo
  configuraron ellos del lado del servidor con la dirección que les pasamos. Pedir "habilitame los
  plugins así me aparece el campo" deja al admin esperando un campo que nunca va a aparecer.
- **Pide explícitamente la autorización de salida.** El plugin puede restringir quién le manda
  comandos, y ese fallo es el peor de todos: la telemetría entra igual, el panel se pone **verde**, y
  el chat, las credenciales de los pilotos, los kicks y las sanciones se descartan sin un solo error.
  Verde y sordo al mismo tiempo. Pedirlo en el mismo ticket cuesta cuatro renglones.

La dirección de la liga va adentro del mensaje, ya resuelta. Si todavía no llegó, el botón no copia
nada y lo dice, en vez de mandar un ticket con un `--` donde iba el dato.

### El cajón de Conexión se da vuelta

Arriba estaba el estado —cuatro filas que dicen `--`— y abajo, adentro de un `<details>`, lo que
había que hacer. Al revés de como se usa: quien abre ese cajón por primera vez necesita
instrucciones, y las cuatro filas no significan nada todavía; quien ya conectó no vuelve a entrar.

Ahora arranca con **un manual de tres pasos** en castellano y sin una palabra técnica, el estado va
abajo, y el `<details>` se fue. El caso "no encuentro el campo" dejó de ser una nota al pie escondida
en un desplegable y es el paso 2, a la vista, con su botón. El tercer paso explica por qué hay que
entrar una vez al servidor con el juego: el acServer solo habla cuando pasa algo, y hasta que no diga
la primera palabra, Race Control no sabe a dónde contestarle.

### El modo sombra deja la barra, pero no desaparece

El switch de modo estaba en la barra de arriba, visible los siete días, y se toca dos veces en la
vida de una liga. Se mudó a Conexión, que es donde vive lo que se configura una vez.

La mudanza reabre el problema que el switch en la barra resolvía, y conviene decirlo claro: se puede
correr una carrera entera en modo sombra sin notarlo —las sanciones se anotan, nadie las cobra, y el
panel se ve idéntico a uno sancionando de verdad—. Por eso en la barra quedó un **cartel ámbar que
aparece solo cuando el modo está activo** y que al clickearlo lleva derecho al switch. Ocupa lugar
únicamente cuando hay algo que avisar.

El cartel trae su propio `.chapa-sombra[hidden] { display: none; }`, una línea de seguro contra el
bug que ya se pagó dos veces en este repo: un `display` propio le gana al atributo `hidden` y el
elemento queda imposible de esconder.

### La columna "Piloto" se comía la tabla

`#timing-table th.c-driver` tenía `width: 100%`. La columna glotona se quedaba con todo el espacio
sobrante y empujaba a las otras trece contra el borde derecho, con un hueco en el medio. Se veía peor
con la tabla vacía —que es como se ve al abrir el panel— pero estaba mal a cualquier ancho. Ahora son
`20ch`, con el recorte por `text-overflow` que ya estaba para los nombres largos.

### La landing dice menos

Cinco textos. Los dos párrafos que describían columna por columna lo que la captura de al lado
muestra sola, afuera: en una landing, el texto que explica una imagen que está a diez centímetros
compite con la imagen y pierde. Lo mismo el párrafo de Reglas y el de la app de los pilotos, que
explicaba el mecanismo del chat interno del juego —la parte más ingeniosa del producto y la que menos
le importa a quien está decidiendo si lo contrata—. Y se sacó un ítem que prometía un aviso de
congelamiento que el panel da, pero no por el canal que la lista daba a entender.

La bajada del hero ahora nombra el dolor antes que la función.

### Dos invariantes nuevas en `panel.test.ts`

Las dos del mismo linaje que las de la 0.6 — cosas que no fallan ruidosamente:

- **Toda clase del HTML tiene al menos una regla que la alcance.** Es el `$("id")` que devuelve
  `null`, pero del lado del estilo: no existe la clase inválida, el navegador acepta cualquier cosa, y
  el resultado es contenido sin formato en medio de una pantalla formateada. Lo descubrió al primer
  intento: el manual nuevo salió con `class="pasos"` antes de que la regla existiera. Perdona las
  clases de estado y los ganchos de `querySelectorAll`, que no están para pintar nada.
- **El modo sombra sigue siendo visible fuera del cajón.** Que el cartel exista, que alguien lo
  muestre y lo esconda según el modo, y que el seguro del `[hidden]` esté puesto.

### Versión

`0.7` en el panel y en `/api/state`, `0.7.0` en `package.json`. La única dependencia de producción
sigue siendo `express`. 216 tests.

## [0.6] — 2026-10-26

Una auditoría completa del producto y los arreglos que salieron de ella. No hay funcionalidad nueva
grande: hay tres defectos que hacían que el panel mintiera en silencio, un camino de recuperación
que terminaba en una pared, y dos cosas que el producto prometía y no cumplía.

El hilo que une todo es un modo de falla, el peor que puede tener este producto: **todo anda y algo
simplemente no pasa**. Sin excepción, sin error en consola, sin un test en rojo. Es el mismo
patrón del `--` adentro del comentario del SVG que rompió el ícono en la 0.5.

### Tres cosas que el panel no decía

**Cuando se corta el contacto con el motor, ahora se ve.** El poll era
`setInterval(() => refresh().catch(() => {}), POLL_MS)`: con el backend caído, el panel se quedaba
congelado mostrando el último estado bueno. Lo grave no era perder la conexión —eso pasa— sino que
un panel congelado y uno sano se vieran **idénticos** durante una carrera. Ahora, a los tres polls
sin respuesta, aparece una banda roja arriba de todo con hace cuántos segundos que no llega nada, y
la torre y el mapa se apagan. Tres segundos y no uno porque un fallo suelto no tiene por qué pintar
la pantalla de rojo; tres seguidos ya no son un hipo.

**La telemetría congelada de un piloto se distingue de un auto en pista.** El backend marcaba
`telemetryStale` en cada auto que llevaba más de dos segundos sin mandar un `CAR_UPDATE`, y el
panel no leía el campo: el punto de alguien que crasheó el juego quedaba clavado en el mapa, del
mismo dorado que el resto, y su última velocidad seguía en la tabla como si todavía estuviera
girando a esa velocidad. Ahora la fila se apaga, la celda de velocidad dice "sin señal" y el punto
del mapa pasa a ser un anillo gris hueco.

**El reloj de sesión avisa de verdad en el último minuto.** La regla decía `color: var(--warn)`, una
variable que no está definida en ningún lado. Una variable inexistente invalida la propiedad entera
y el navegador la descarta sin decir nada: la clase se aplicaba bien y el reloj seguía del mismo
color de siempre.

**Y el reintento del mapa estaba muerto.** `refreshTrack` marcaba la cobertura como bajada *antes*
del `await`, así que un solo error transitorio al arrancar —el worker todavía levantándose— dejaba
la tarjeta del mapa en "esperando telemetría" hasta que alguien recargara la página. El caso que lo
disparaba era el normal: una liga que ya aprendió su circuito arranca con cobertura 1.0 y no crece
más en toda la carrera.

Los cuatro quedan cubiertos por `panel.test.ts`, que valida sobre `dist/` —lo que se le sirve al
navegador— que toda variable CSS usada exista, que todo id que `app.js` busca esté en el HTML, y
que ningún campo que el backend calcula para el panel quede sin leer.

### El producto ya tiene dónde escribirle

Seis pantallas decían "escribinos" y no existía una dirección en ninguna parte: la recuperación de
contraseña, el alta de liga, la cuenta desactivada, el cierre de la landing y dos diagnósticos. El
único camino de salida de quien no podía entrar terminaba en una pared.

La dirección es ahora una variable de despliegue, **`RC_CONTACT`** (`mailto:` o un link de Discord o
Telegram), y llega a las seis pantallas: a las del portal por `/api/portal/me` y
`/api/portal/liga/:slug`, y al worker por `process.env`, que ya hereda del portal. Tres decisiones
que importan:

- **Sin configurar, cada pantalla degrada a una frase que sigue siendo verdad** ("pedísela a quien
  te dio el acceso"), en vez de a una frase vacía. En la de ingreso, esa es además la que se ve por
  defecto: si el pedido de la dirección no vuelve, lo que queda en pantalla no miente.
- **Solo se aceptan `mailto:`, `https:` y `http:`.** Un `javascript:` ahí adentro ejecutaría en la
  pantalla de ingreso de todos.
- El portal **avisa en el log del arranque** si falta.

De paso, la contraseña de ingreso tiene un botón para verla. Es el campo que más se escribe mal en
todo el producto y el único que no dejaba comprobar qué se tecleó.

### La columna que faltaba en la torre de tiempos

La torre tenía trece columnas y ninguna contestaba la pregunta de toda carrera: *¿a cuánto está del
de adelante?* La landing llegó a prometerlo antes de que existiera. Ahora está, y el encabezado es
un botón que alterna entre el intervalo con el de adelante y el acumulado contra el líder.

**En carrera es una estimación y conviene saber de qué tipo.** El UDP de Assetto Corsa no manda
tiempos de cruce por punto de pista: manda posición en el trazado y vueltas completadas. De ahí
sale la distancia en fracción de vuelta, y para pasarla a tiempo se usa el tiempo de vuelta del auto
**de atrás** —es quien tiene que recorrer esa distancia—. El error es el de suponer ritmo constante:
en una frenada fuerte o saliendo de boxes, el número se mueve más que los autos. En práctica y
clasificación no hay nada que estimar: es la resta de las mejores vueltas.

El `sort` de la torre se extrajo a `rankCars` para que las posiciones y los intervalos salgan del
mismo criterio. Con dos copias, tarde o temprano una muestra un gap contra un auto que en la tabla
aparece más atrás, y eso es peor que no mostrar nada: el número se lee igual de creíble.

### Las sanciones se pueden anular

El panel tenía un botón de kick con doble confirmación y uno de "Sancionar" sin ninguna, al lado de
un desplegable que viene con un piloto ya elegido. Es el orden inverso al de la gravedad: de un kick
el piloto vuelve a entrar.

Ahora **"Aplicar" también pide dos clicks**, y entre uno y otro el botón dice en palabras a quién y
qué se está por aplicar —justo el dato que el formulario esconde en dos `select`—. Cambiar
cualquiera de los dos campos desarma la confirmación.

Y hay un estado `revoked`, que es terminal y **no es un borrado**: la sanción sigue en la tabla y en
el informe, porque anular es un comisario corrigiéndose en público y si la fila desapareciera el
piloto sancionado por error no tendría cómo comprobar que la corrección existió. Lo que sí cambia:

- Deja de sumar al resultado en el informe, y un DQ anulado deja de descalificar. Sin eso, el botón
  solo cambiaría una etiqueta en la pantalla.
- Se puede anular desde cualquier estado, incluido `served`. La sanción de tiempo —la que más se
  aplica mal— nace cumplida en el mismo instante en que se emite.
- **Al piloto le llega el aviso por chat**, que es el canal por el que le llegó la sanción. Si no,
  entra a boxes a cumplir un Drive-Through que ya no debe.
- El lastre **se saca de verdad** (`/ballast <car> 0`). Es el único caso con algo físico que
  deshacer, y sin eso "anulada" sería mentira justo en la sanción que más se nota al manejar.
- `isPenalty`, en la restauración, acepta el estado nuevo. Sin eso pasaba lo peor: la línea de la
  anulación se descartaba al reiniciar y la sanción resucitaba.

### La zona de pit se ve en el mapa

Es la única regla del producto que se configura con dos números abstractos —0.97 y 0.995— y no había
ninguna forma de ver a qué pedazo de pista correspondían. El texto de Reglas mandaba a "mirar el
mapa mientras alguien maneja por boxes", y el mapa no mostraba ni la zona ni el punto de la vuelta
de nadie: era pedirle a alguien que calibre a ciegas.

Ahora el tramo configurado se pinta en ámbar sobre el trazado, y con un auto seleccionado aparece
debajo del mapa su punto de la vuelta con tres decimales —la misma precisión que aceptan los campos
del formulario— y si está dentro o fuera de la zona. El dibujo usa **exactamente** el mismo criterio
que `isInPitZone`, sin envolver al cruzar la meta: un dibujo más piadoso que el motor pintaría en
ámbar un tramo donde no se sanciona a nadie, que es la peor forma posible de equivocarse acá. Un
inicio mayor que el fin ahora se dice en pantalla en vez de simplemente no marcar a nadie.

### La landing dejó de prometer lo que no hay

- **"Clima, viento y hora del juego"**: el viento y la hora son campos de ACC. El protocolo de
  Assetto Corsa no los manda por ningún canal. Quedó lo que el panel muestra de verdad: clima,
  temperatura de aire y pista, y el agarre.
- **"Banderas de pista en vivo"** estaba en la lista del panel, y la bandera solo existe donde la lee
  el juego: adentro de la app del piloto, de su Shared Memory. Se movió a la sección que
  corresponde, con los colores que muestra.
- **"Diferencia con el de adelante"** ahora es cierto, así que se quedó.

### El ícono vuelve a ser una bandera a cuadros

Se revierte la decisión de la 0.5 (["El ícono es un semáforo de largada"](#el-ícono-es-un-semáforo-de-largada)).
El argumento de entonces sigue siendo técnicamente cierto —la bandera a cuadros dice "automovilismo"
y el semáforo decía lo que hace este producto— pero perdió contra el único criterio que manda en una
marca: **no gustaba.** Un ícono que al dueño del producto no le cierra no se defiende con un
razonamiento, por bueno que sea el razonamiento.

Lo que sí se conserva es todo lo que la 0.5 aprendió sobre el tamaño chico, que no era una cuestión
de gusto sino de física:

- **Damero de 3x3 y no de 4x4.** A 16 px, un damero de 4x4 deja celdas de 4 px y la alternancia se
  convierte en un gris parejo. Con 3x3 cada celda mide 5 px y todavía se lee como cuadros. Es el
  damero más fino que aguanta la pestaña del navegador, y es el mismo motivo por el que el semáforo
  tenía cuatro lámparas y no diez.
- **Fondo claro.** La barra del panel es oscura. Un ícono de fondo oscuro ahí adentro se funde con la
  barra y parece una imagen rota — que fue literalmente el bug reportado en la 0.5.
- **A sangre, sin margen.** Un ícono con aire adentro desperdicia la mitad de los pixeles que tiene
  a 16 px.
- **Un filo ámbar abajo**, el mismo acento del panel. Son veinte pixeles que a tamaño de pestaña
  sobreviven como una línea de uno, y es lo único que distingue esto de la bandera a cuadros genérica
  de cualquier app de automovilismo.

El archivo es el mismo, `icon.svg`, y lo sirven las siete pantallas sin tocar una sola referencia.
El test de `assets.test.ts` que nació del bug del `--` adentro del comentario sigue cubriéndolo.

### Versión

`0.6` en el panel y en `/api/state`, `0.6.0` en `package.json`. La única dependencia de producción
sigue siendo `express`. 214 tests.

## [0.5] — 2026-10-23

Race Control deja de ser un programa que se baja y pasa a ser un servicio al que se entra. No hay
más `.exe`, no hay más invitaciones por link, y hay una landing que explica el producto antes de
pedirle nada a nadie.

### El `.exe` se fue entero

No se dejó de recomendar: se borró. `src/index.ts`, `scripts/package.js`, el `.ico`, la carpeta
`release/`, el script `npm run package` y la fila de descarga del README.

Con él se fueron las dos piezas que existían **solo** para que funcionara en la PC de una persona:
el mapeo de puertos por **UPnP** y la **detección de IP pública** contra servicios externos. Eso
elimina la última dependencia npm que no era `express` (`@runonflux/nat-upnp`) y deja
`net/connectivity.ts` en lo único que sigue siendo cierto en un servidor: mandar un keepalive y
contar si entran datagramas.

El motor también perdió el parámetro `mode`. Mientras hubo dos destinos había dos comportamientos
—el token del piloto obligatorio acá y opcional allá, la retención sí acá y no allá, formularios
que aparecían en un lado y no en el otro— y cada uno era un camino de código que alguien tenía que
acordarse de probar. Ahora hay uno.

Lo que esto arregla sin pedir permiso: la guía de conexión dejó de tener una sección sobre abrir
puertos en el router, y los cuatro textos del diagnóstico dejaron de mandar a revisar cosas que en
un servidor no existen.

### Las cuentas las crea el operador, una por una

El alta por link de invitación se cambió entera. El motivo es el modelo de negocio: no se invita a
nadie, se le vende. Quien paga la cuota recibe un usuario y una contraseña; quien deja de pagar se
queda sin acceso.

Hay un **panel de operador** en `/operador`, detrás de su propio rol:

- La lista de admins ordenada por lo que requiere atención: primero las cuotas vencidas, después
  las que vencen esta semana, después el resto, y al final lo desactivado.
- Alta de liga y cuenta en un paso, con la contraseña generada por el portal y mostrada **una sola
  vez** —en disco solo queda el hash—, con un botón para copiar los tres datos que hay que pasarle
  al admin.
- "Cobré" suma un mes desde donde venía la cuota, o desde hoy si ya estaba vencida.
- Desactivar **para el worker de esa liga y no toca un solo archivo**. La alternativa —borrar
  datos— convertiría un atraso en el pago en la pérdida del historial de un campeonato.
- Cuántos lugares libres quedan. Cada liga ocupa un puerto UDP de un rango declarado a mano en
  `fly.toml`, así que el cupo es real y conviene verlo venir.

**Nada vence solo**: una cuota vencida se pinta en rojo y espera. Dar de baja a alguien en medio de
su campeonato es una decisión, no un `setInterval`.

Tres detalles que no se ven pero deciden el diseño:

- `/api/operador/*` contesta **404 y no 403** a quien no tiene el rol. Para un admin común esa
  sección no existe.
- Una liga de cuenta desactivada **no vuelve sola en un redeploy**. Si volviera, reiniciar el
  servidor sería la forma de saltearse la baja.
- El CLI sigue existiendo con los mismos comandos, pero **se niega a correr con el portal vivo**:
  el portal tiene todo `portal.json` en memoria y lo reescribe entero, así que su primer guardado
  borraría el cambio del CLI sin que nadie se entere. Se detecta con un `portal.pid` en el volumen.

La cuenta de operador no se crea a mano: el portal la genera en el arranque si `RC_OPERATOR_EMAIL`
está puesto, y escribe la contraseña en el log una sola vez. Hacerlo por CLI no servía —el CLI y el
portal escriben el mismo archivo— y dejarlo para después significaba un panel de operador al que no
se podía entrar.

### Una landing que muestra el producto

Antes, la raíz era un formulario de login. Ahora es una página que explica sección por sección qué
hace Race Control, con el botón de "Ingresar" donde corresponde.

**Los cuatro lugares de captura salen con el hueco puesto**, a la espera de las fotos definitivas.
El hueco no es un `<div>` vacío: lleva el `aspect-ratio` exacto de la imagen que va a ir ahí, así
la página ya tiene hoy la altura final y no se reacomoda sola el día que se suban. Cómo llenarlos
está en `PUESTA-EN-MARCHA.md`.

**Cuando se saquen, van a ser el panel de verdad.** Para eso existe `src/sim/demo.ts`: levanta el
panel completo con una carrera inventada —diez pilotos GT3, un trazado sintético, seis incidentes
en la bandeja, tres sanciones en curso— y de ahí sale cada imagen, sin necesidad de un servidor de
Assetto Corsa. No es un script descartable: está versionado para que, cuando el panel cambie, las
capturas se puedan rehacer en un comando.

Dos cosas que hubo que resolver para que la foto no mienta:

- Un pinger UDP real bindeado al puerto que la config declara como el del servidor de AC, para que
  el indicador de señal diga "recibiendo" porque **entran paquetes**, y no porque se trucó una
  variable. Bindeado y no efímero: si cada datagrama saliera de un puerto distinto, el motor
  concluiría —con razón— que el servidor no tiene puerto fijo y el diagnóstico se pondría en rojo.
- Las posiciones de los autos están congeladas. Moviéndolos, la torre se reordenaba entre capturas
  y en cuanto el líder cruzaba la meta pasaba a figurar último.

De paso, los cajones de Conexión y Reglas aceptan ahora un ancla (`#conexion`, `#reglas`) y se
abren solos. Nació para poder fotografiarlos, pero sirve para que un aviso enlace directo a donde
se arregla el problema.

El pie quedó en la mitad de alto y con el aviso de derechos —el año lo escribe el JS, para que no
haya una fecha a mano que quede vieja el 1 de enero sin que nadie se entere—. Perdió el botón de
"Ingresar", que era el tercero de la misma página. Y la página, que es larga, tiene ahora una
flecha de volver arriba que aparece recién pasada la pantalla y media: antes de eso no hay nada
arriba a donde volver y el botón solo taparía contenido.

### Salir de la sesión, desde donde sea que estés

Las tres pantallas con sesión tienen ahora su botón: el panel de operador, la lista de ligas y
—esta es la que faltaba— el panel de la liga, que era justamente donde el admin pasa toda la
carrera. Sin él, cerrar sesión era borrar la cookie a mano o esperar a que venciera, y en una PC
compartida en un evento eso no es un detalle.

El botón del panel de liga tiene una particularidad: **no pasa por el helper `api()`**. La sesión
vive en el portal, no en el worker, y `api()` antepone el prefijo `/l/<slug>` que se proxea al
worker —que no sabe nada de cookies—. Va con la ruta absoluta y el header `X-RC-Request` a mano.
Y solo aparece si el panel se abrió desde el portal: abierto directo contra el puerto del worker
no hay sesión que cerrar y el botón mentiría.

### El acento pasa de celeste a dorado

`--accent` era `#3fa9f5` en las tres hojas de estilo y ahora es `#f0b429`. El cambio arrastró algo
que no era opcional: el amarillo de aviso (`--yellow`, `#e0b84b`) quedaba a un paso del dorado
nuevo, y son **dos cosas distintas** —uno es "esto es un link / esto es el acento", el otro es
"prestá atención"—. Si se parecen, el aviso deja de avisar. El amarillo de aviso pasó entonces a
ámbar (`#ef8e3c`): sigue leyéndose como precaución y ya no se confunde con el acento.

El mapa del circuito tuvo el mismo problema en chico. El auto seleccionado era amarillo sobre una
parrilla celeste; con la parrilla dorada se habría perdido adentro. Ahora el seleccionado es
blanco —el color de más contraste del mapa, que es lo que le corresponde a lo que está
seleccionado— y el hover es un dorado claro: un escalón del mismo color, no un color nuevo.

### El ícono es un semáforo de largada

`brand/icon.svg` —y su copia en el panel— dejó de ser una bandera a cuadros. La bandera dice
"automovilismo", que es lo que dicen todas las demás; el semáforo dice lo que hace **este**
producto, que es dar la largada y decidir si la carrera está en verde.

Son cuatro lámparas y no diez por la misma razón de siempre: a 16 px en la pestaña del navegador
cada una mide menos de 4 px, y lo único que sobrevive a ese tamaño son las dos manchas de color
—rojo arriba, verde abajo—. Cinco luces en fila, o un damero de 4x4, se vuelven un gris sin forma.

El primer intento tenía las lámparas chicas sobre un panel oscuro. En la barra del panel —que ya
es oscura— el ícono se perdía contra el fondo. Ahora las lámparas ocupan casi todo el cuadro y lo
que queda del cuerpo del semáforo es apenas la junta entre ellas.

**Y el ícono además estaba roto de verdad, por otra razón.** Uno de sus comentarios citaba dos
variables CSS escribiéndolas con su prefijo de dos guiones. Un comentario XML **no puede contener
dos guiones seguidos**: el archivo dejaba de ser XML bien formado y el navegador no dibujaba nada,
el ícono de imagen rota.

Lo que lo hace valer una entrada propia es lo bien que se esconde. El archivo existe, el servidor
contesta 200 con el `content-type` correcto, el contenido se ve perfecto en el editor y el único
síntoma es un dibujito roto indistinguible de un 404. Se diagnosticó mal dos veces —primero como
problema de ruta, después como problema de contraste— antes de pensar en el parser.

Queda cubierto: `test/assets.test.ts` valida **todos** los SVG que se sirven, los dos del ícono y
los ~130 logos de marca. Ahí el mismo error sería aún más invisible, porque un logo roto en la
tabla de pilotos no lo reporta nadie.

### El operador edita la liga y la cuenta desde la tabla

Faltaba lo más obvio: dar de alta una liga se podía, corregirla no. Si el nombre venía con un
error de tipeo, o el admin cambiaba de email, había que editar el `portal.json` a mano por SSH.

Cada fila tiene ahora un botón **Editar** con los cuatro datos que importan: nombre de la liga,
dirección (`/l/<slug>/`), email del admin y contraseña nueva. Se manda solo lo que cambió, y los
dos cambios con consecuencias las avisan antes de guardar: renombrar reinicia el motor —unos
segundos sin escuchar telemetría— y cambiar la dirección deja muerto el link anterior.

La contraseña dejó de ser siempre generada: el operador puede escribir una, o dejar el campo vacío
y que no se toque. Sigue sin guardarse en claro en ningún lado.

Debajo hay una decisión que venía postergada: **el nombre de la liga tenía dos dueños**. El portal
guardaba `League.name` —lo que se ve en la tabla y en la factura— y el worker guardaba su propio
`config.leagueName` —lo que se ve arriba a la izquierda en el panel—, y cada uno se editaba en un
lado distinto. Ahora manda el portal: el worker lo toma al arrancar y `POST /api/config` descarta
`leagueName` como descarta los puertos. En el panel del admin el campo quedó de solo lectura, y el
paso 1 del asistente dejó de pedir el nombre para pasar a confirmarlo.

### Un campo para copiar, no un bloque de texto

En "Configuración del servidor", el Send Address pasó de ser un `<pre>` a un input de solo lectura
con el botón de copiar **adentro**. El gesto de copiar queda donde está el dato, y un click en el
campo lo selecciona entero.

### Se dejó de recomendar editar el `server_cfg.ini`

Salió de una prueba contra un hosting real (EmperorServers): el admin no encontraba el "Send
Address" por ningún lado, y el `server_cfg.ini` el panel se lo dejaba **ver pero no editar**.

Las dos cosas tienen la misma causa y ninguna era un problema de ese hosting en particular:

- Los paneles tipo Assetto Corsa Server Manager **regeneran** el `server_cfg.ini` desde su propia
  base cada vez que arranca el servidor. Lo que se edite a mano se pierde en el próximo arranque,
  que es exactamente el paso siguiente de la guía. Por eso lo muestran en solo lectura: ese
  archivo es una salida, no una entrada.
- La sección de plugins del Server Manager **se puede apagar entera** desde su `config.yml`
  (`disable_plugins`), y apagada no se dibuja. Al admin le parece que el campo no existe, y en su
  pantalla efectivamente no existe. El archivo lo maneja el hosting, así que la única salida es un
  ticket al soporte.

Entonces: se borró `buildServerSnippet` y el campo `serverSnippet` de `/api/state`, y con ellos el
bloque "Si editás el `server_cfg.ini` a mano" del panel. Dar una instrucción que el panel deshace
sin avisar es peor que no darla — el admin cree que conectó la liga y se entera el día de carrera.

En su lugar, donde estaba ese bloque hay ahora un desplegable **"No encuentro el campo Send
Address"** con la causa real y qué pedir. La guía de conexión suma una sección propia con el texto
del ticket listo para copiar, y el camino del campo quedó completo en todos lados: **Server
Options → sección de plugins UDP → "Send Address"**, y no solo "buscá Send Address".

### Versión y limpieza

`0.5` en el panel y en `/api/state`, `0.5.0` en `package.json`. La única dependencia de producción
que queda es `express`.

## [0.4] — 2026-10-23

El admin ya no descarga nada. Race Control pasa de ser un `.exe` que corre en la PC de una persona
a un **portal web multi-liga**: se entra con usuario y contraseña, se pega un renglón en el panel
del hosting, y eso es toda la puesta en marcha.

El `.exe` sigue existiendo y hace exactamente lo mismo. No es una versión degradada ni un modo de
compatibilidad: es el mismo motor con `mode: "local"`.

### Por qué

La 0.3.1 arregló cada paso difícil de la configuración por separado y aun así la secuencia completa
seguía siendo impracticable: bajar un ejecutable que SmartScreen marca, convivir con una ventana de
cmd abierta toda la carrera, entrar a un `localhost:3000` que parece un error, averiguar la IP
pública propia, abrir un puerto en el router y esperar que la IP dinámica no cambie en el medio.
Ninguno de esos pasos es el producto. Todos desaparecen cuando el motor corre en un servidor que ya
tiene IP fija, puertos abiertos y un certificado válido.

Lo único que no se puede eliminar es apuntar el servidor de Assetto Corsa a Race Control: ese dato
solo lo puede poner quien tiene acceso al panel del hosting. Lo que sí se pudo es reducirlo a
copiar y pegar un renglón que el portal muestra ya armado.

### Un proceso por liga

El portal no atiende varias ligas dentro del mismo proceso, y no por comodidad. Hay estado que es
global por construcción —el `StateTracker` indexado por `carId`, el circuito que se aprende, el
tipo de sesión— y un `uncaughtException` llamaba a `process.exit`. En un proceso compartido, un
`carId` de una liga pisaría al de otra y cualquier falla se llevaría puestas a todas las carreras
en curso a la vez. El precio son unas decenas de MB por liga y se paga.

De ahí sale el resto de la arquitectura:

- **`core/raceControl.ts`**: todo el backend extraído del entry, parametrizable. Recibe su carpeta
  de datos, sus puertos y su modo por argumento, y tiene un `stop()` que cierra los timers, el
  socket y los archivos. Sin eso no se pueden tener dos instancias en un proceso, que es lo que los
  tests necesitan para poder probar el aislamiento entre ligas.
- **`portal/supervisor.ts`**: levanta un hijo por liga y lo mantiene vivo con backoff creciente
  (1 s, 2 s, 4 s… tope 60 s). El contador se reinicia tras cinco minutos estable, y después de
  cinco caídas seguidas la liga queda en `failed` y se avisa en el portal. Reintentar para siempre
  quema la máquina y llena el disco; no reintentar deja la carrera muerta.
- **`portal/store.ts`**: cuentas, ligas, membresías e invitaciones en un JSON con escritura
  atómica. No es una base de datos y no hace falta que lo sea: escribe un solo proceso y la escala
  es de decenas de ligas. `node:sqlite` sigue siendo experimental en Node 22.

### Rutas en vez de subdominios

Cada liga vive en `race-control.fly.dev/l/<liga>/`. La alternativa era un subdominio por liga, que
hubiera dejado el panel intacto —todas sus rutas absolutas seguirían funcionando—, pero exige un
certificado wildcard y un dominio propio. Con `*.fly.dev` no hay sub-subdominios, así que arrancar
sin pagar un dominio obliga a rutas.

El costo fue real pero acotado: el panel aprendió a vivir bajo un prefijo (`BASE` en `app.js`, que
se deduce de la propia URL). El cliente Python no necesitó un solo cambio de ruteo, porque ya
armaba su URL como `http://<lo que le digan>/api/client/...` y un prefijo entra ahí sin que se
entere.

### El canal de los pilotos ahora está firmado

Hasta acá ese canal no tenía ninguna autenticación: cualquiera que supiera un SteamID podía mandar
telemetría en nombre de otro. En loopback no importaba —había que estar en la misma PC—; expuesto a
internet, sí.

Cada liga firma un token por piloto con su propia clave de 32 bytes (`security/pilotToken.ts`). El
`steamGuid` va dentro de la firma, así que un piloto no puede usar su token para hacerse pasar por
otro, y el token de una liga es ruido en otra. Viaja por el mismo chat del juego que ya le
anunciaba la dirección al auto, que es el único canal que Assetto Corsa ofrece para decirle algo a
una persona y no a toda la parrilla.

**El token es obligatorio en el portal y opcional en el `.exe`.** No es un descuido: exigirlo
también en local dejaría afuera, en plena carrera y sin ningún mensaje que lo explique, a todos los
pilotos que todavía tengan la app de la 0.3. Local lo emite igual y lo usa si llega; lo que no hace
es rechazar a quien no lo tenga.

Lo que este esquema **no** resuelve, y se asume: el token viaja en claro, porque la app corre en el
Python 3.3 embebido de Assetto Corsa y ahí no hay HTTPS utilizable (`ssl.create_default_context`
llegó en 3.4, la verificación de certificados por defecto en 3.4.3, y no lee el almacén de
Windows). Quien esté en la red de un piloto puede capturar su token y falsificar su presencia y su
telemetría por 24 h. No da acceso al panel ni a otra liga. Está escrito en `docs/seguridad.md`.

### Endurecimiento del panel, que ahora sale a internet

El panel vivía en `127.0.0.1` y eso permitía no pensar en nada de esto:

- **Allowlist de rutas, no denylist.** Se enumera lo que pasa y el resto es 404.
- **CSRF con tres defensas y no una**: cookie `SameSite=Strict`, un header propio obligatorio en
  todo POST, y chequeo de `Origin`. Cada una falla distinto.
- **Sesiones** en cookie `__Host-rc_session`, guardadas hasheadas en memoria, con vencimiento a las
  2 h de inactividad y 12 h absolutas. Cambiar la contraseña invalida todas de golpe.
- **Contraseñas** con `scrypt` (N=2^15), comparación en tiempo constante, y un hash señuelo cuando
  el email no existe para que el tiempo de respuesta no delate qué cuentas hay. Cero dependencias
  npm nuevas: las dos siguen siendo `express` y `@runonflux/nat-upnp`.
- **Freno de login** por IP (10 fallos en 15 minutos) y por cuenta (demora progresiva hasta 30 s,
  nunca bloqueo: si no, cualquiera podría dejar a un admin afuera de su propia liga a propósito).
- **`POST /api/config` con allowlist de campos**: puertos, binds y direcciones no son editables
  desde el panel en modo portal, porque los administra el portal. El panel esconde esos formularios
  cuando corre ahí, en vez de ofrecer un "Guardar" que no guarda nada.
- **Auditoría con nombre y apellido**: el portal inyecta `X-RC-User` en cada acción, y lo borra si
  viene de afuera. Sin eso, en una liga con varios comisarios el journal diría "alguien kickeó al
  piloto 7".
- **Informe CSV**: las celdas que empiezan con `= + - @` se prefijan con una comilla simple. Un
  piloto con un nombre armado a propósito podía meter una fórmula en el Excel del comisario.
- **Prototype pollution**: `mergeConfigInto` rechaza `__proto__`, `constructor` y `prototype`.

### Retención de datos

Los `events-*.jsonl` guardan nombres y SteamID64 en texto plano. En la PC del admin eso era un
detalle —son sus datos, en su disco—; en un servidor con ligas de terceros, no. En modo portal se
borran a los 90 días y las capturas crudas a los 7. **En modo local no se borra nada**: ahí el
historial es del admin y no se le toca sin preguntar.

### Dos bugs que ya estaban y salieron a la luz

- `validateConfig` **reasignaba** objetos en vez de mutarlos (en `pit.zone`, en los dos `penalty` y
  en cada tipo de infracción). Los motores guardan la referencia, así que después de una validación
  quedaban mirando el objeto viejo y los cambios del panel dejaban de aplicarse en vivo.
- `saveConfig` escribía directo sobre el archivo. Un corte en el momento equivocado dejaba un
  `config.json` truncado y la liga sin configuración. Ahora es `tmp` + `rename`.

### Despliegue

`Dockerfile` y `fly.toml` para Fly.io. Tres cosas de esa plataforma condicionan el archivo entero y
están anotadas ahí: UDP exige una IPv4 dedicada, Fly no reescribe el puerto de los datagramas (así
que `internal_port` tiene que ser igual al externo y cada puerto va declarado uno por uno), y la
app tiene que bindear a `fly-global-services` y no a `0.0.0.0` —con `0.0.0.0`, Linux contesta desde
la dirección equivocada y el servidor de Assetto Corsa nunca ve la respuesta.

Una sola máquina, sin escalado horizontal: el estado vive en el volumen y los workers son hijos de
ese proceso.

### Lo que todavía no se probó

Nada de esto corrió contra un servidor de Assetto Corsa real todavía. El camino completo se validó
de punta a punta con datagramas simulados (portal → worker → panel, y la app del piloto con su
token), pero los supuestos del protocolo anotados en `docs/spike-protocolo.md` siguen sin confirmar
en pista.

## [0.3.1] — 2026-10-23

Primera prueba contra un servidor real de EmperorServers. No se llegó a correr: la puesta en
marcha resultó impracticable antes de eso. El reporte, textual, fue que los pasos 2 y 3 no se
podían hacer, que el asistente no se abrió en el 5, que el 6 "no lo va a saber hacer el usuario" y
que el 8 era "súper técnico". Es exactamente el usuario para el que está escrito el producto, así
que el problema es del producto.

Esta versión ataca la causa concreta. El cambio de fondo —pasar de un `.exe` a un portal web, para
que el admin no descargue nada— está planificado para la 0.4.

### El puerto más difícil de encontrar ya no hay que encontrarlo

Para conectar Race Control hacían falta dos números. El segundo —en qué puerto escucha el servidor
de Assetto Corsa las órdenes que le mandamos— es el peor dato de toda la configuración: vive en el
panel del hosting bajo un nombre que cambió entre versiones, en muchos planes directamente no es
editable, y equivocarlo produce la falla más cara de diagnosticar que tiene el producto. La
telemetría entra perfecta, el panel se pone verde entero, y ni una sola sanción llega nunca.

El servidor ese número lo dice solo, en cada paquete que manda. Ahora lo tomamos de ahí
(`adoptRemotePortIfNeeded` en `server/src/udp/client.ts`), igual que ya se hacía con la dirección.
El admin no toca ningún puerto: pega una línea en su hosting y listo.

Tres detalles que hacen que esto sea seguro y no una adivinanza:

- **Un puerto escrito a mano no se pisa nunca.** `config.acUdp.remotePortSource` distingue el valor
  de fábrica (`default`, se autodetecta), el deducido (`detected`) y el que escribió el admin
  (`manual`). Ese último manda, porque es el único caso en que él sabe más que nosotros: un hosting
  que relaye los datagramas tendría un origen distinto del destino correcto. Borrar el campo y
  guardar vuelve a pedir la detección.
- **Si el servidor hablara desde un puerto distinto cada vez, se detecta y se abandona.** Toda la
  idea se apoya en un supuesto —que el acServer usa un solo socket para el plugin— que solo se
  confirma contra un servidor real. Si fuera falso, adoptar el origen sería adoptar basura nueva en
  cada paquete. En vez de eso se deja de adoptar, se avisa, y el diagnóstico manda a buscar el dato
  real al panel del hosting. Queda anotado como pendiente de pista en `docs/spike-protocolo.md`.
- **El diagnóstico dejó de ofrecer un número que ya caducó.** Antes, ante un desajuste, decía
  "poné 8008". Si el puerto es efímero ese consejo es falso, así que ese caso ahora tiene su propio
  texto.

### La guía nombraba campos que ya no existen

El changelog de Assetto Corsa Server Manager confirma que en la **2.4.8** los campos se
renombraron: "UDP Plugin Local Port" pasó a llamarse **"Listen Address"** y "UDP Plugin Address" a
**"Send Address"**. La guía mandaba a buscar los nombres viejos. Por eso no se encontraban.

La misma versión trae algo que invalida una advertencia que dábamos: *"It is now possible to
specify multiple plugin listeners in the Server Options"*. O sea que Race Control **no desplaza**
los plugins que ya estuvieran configurados. La sección "Ojo: Assetto Corsa admite un solo plugin"
estaba asustando sin motivo, y con ella la idea de que había que desactivar las sanciones
automáticas del propio panel (`custom_cuts_enabled`, `collision_penalties_enabled`) — que, además,
en el plan del usuario no eran editables. Se pueden dejar como estén.

`guia-conexion.html` se reescribió entera: pasó de 4 pasos con dos líneas de configuración a 4
pasos con **un** dato, con los nombres reales de cada panel y una sección nueva sobre la lista de
IPs permitidas, que es otro modo de fallo completamente silencioso.

### El panel pide un dato, no un bloque de configuración

- "Configuración del servidor" muestra ahora solo el **Send Address** (`191.81.189.89:12000`), con
  su botón de copiar. Las dos líneas del `server_cfg.ini` siguen ahí para quien edite el archivo a
  mano, pero plegadas: dejaron de ser lo primero que se ve.
- El paso 3 del asistente de primer arranque, igual.
- En Puertos, el "Puerto del servidor de AC" ahora explica de dónde salió el número que muestra. Sin
  eso, el admin veía un puerto que nunca escribió y no tenía forma de saber si era un valor de
  fábrica a corregir o el bueno de verdad.

Seis tests nuevos, cuatro de ellos con sockets UDP reales sobre loopback en vez de un doble de
prueba: lo que se está verificando es justamente qué trae el `rinfo` de Node, y un mock daría por
cierto el dato que se quiere comprobar. Total: 132.

---

## [0.3] — 2026-10-23

Auditoría completa del proyecto. A partir de acá el versionado pasa a ser de **dos números**
(0.3, 0.4, … 1.0): el tercer número no estaba comunicando nada útil a un admin de liga, que es
quien ve el número en la página de descargas. `server/package.json` se mantiene en `0.3.0` porque
npm exige semver de tres partes, pero ese valor es interno y no se muestra en ningún lado.

Ocho tandas. La primera son cuatro bugs que impedían que el producto funcionara contra un hosting
remoto —el caso de uso para el que fue escrito—: estaban activos en la 0.2.3 y ninguno daba error
visible, el panel mostraba todo en verde mientras nada funcionaba. Las otras siete son el motor de
incidentes, el rediseño del panel en una sola pantalla, la torre de tiempos, los límites de pista,
el catálogo de infracciones configurable, el enlatado, la persistencia con informe de carrera y la
tanda de ajustes sobre el panel ya funcionando.

Las tandas están ordenadas por tema, no cronológicamente, y la primera queda al final: es la que
menos dice sobre qué hace hoy el producto.

---

## Segunda tanda: incidentes en pista y panel nuevo

### El motor no veía nada de lo que genera conflicto en una liga

Hasta acá Race Control detectaba exceso de velocidad y nada más. Los toques entre pilotos, los
choques contra el muro y los trompos —lo que de verdad discute una liga el lunes siguiente— no se
registraban en ningún lado, aunque el paquete que los trae (`CLIENT_EVENT`, opcode 130) **ya
llegaba al backend y se descartaba sin decodificar**.

- `server/src/udp/protocol.ts` decodifica ahora el paquete completo. El orden de lectura importa:
  `other_car_id` existe **solo** cuando el choque es contra otro auto; leerlo siempre desfasaría un
  byte la velocidad de impacto y las dos posiciones, y el bug se vería como números absurdos en vez
  de como un error. Hay un test que arma los dos layouts a mano justamente para fijar eso.
- `server/src/incident/incidentEngine.ts` convierte esos eventos en incidentes con contexto.

Tres cosas que el motor resuelve y que son la razón de que no sea un simple `map()`:

1. **Doble reporte.** Ante un toque, el servidor emite un `CLIENT_EVENT` por **cada** auto
   involucrado. Sin correlacionarlos, la bandeja mostraría cada toque dos veces y señalaría a los
   dos pilotos. Se agrupan los dos que comparten `(car_id, other_car_id)` invertido dentro de 500 ms.
2. **Flood.** Un trompo contra el muro genera decenas de eventos en dos segundos. Se agrupan los
   del mismo involucrado dentro de 3 s en un único incidente que conserva el impacto más fuerte y
   un contador. La clave de agrupación identifica a los *involucrados* (`contact:3,9`), no a un
   auto: agrupar por auto a secas metería en la misma entrada un toque del 3 contra el 9 y otro del
   3 contra el 5 un segundo después, listando mal a las partes.
3. **Contexto perdido.** El paquete trae posiciones pero no dice quién es quién ni a qué velocidad
   iban. Eso se cruza con el `StateTracker` **en el instante del impacto** y se guarda como copia:
   el tracker muta el mismo objeto con cada actualización, así que leerlo al emitir el incidente
   —hasta medio segundo después— daría la velocidad de después del choque, no la del choque.

**Los incidentes no se auto-sancionan.** Van a una bandeja para que decida un comisario. El
servidor sabe que hubo contacto, no quién tuvo la culpa: un `rear-end` puede ser culpa del de
adelante por frenar en seco. La geometría del toque (trompa contra cola / rueda a rueda / frontal)
se deduce cruzando las dos perspectivas y se presenta como un dato que acompaña al incidente, no
como un veredicto. Con una sola perspectiva queda en "sin determinar" en vez de adivinar.

Los umbrales son configurables (`config.incidents`) y existen para que un roce de parrilla o un
piano no llenen la bandeja antes de la primera vuelta.

### El panel: todo en una pantalla

Era una grilla plana de siete tarjetas donde configurar la zona de pit ocupaba el mismo espacio
visual que ver la carrera en vivo, y había que scrollear para ver quién estaba en pista.

- **Sin scroll de página**, al 95% del ancho. Las tablas largas scrollean dentro de su propia caja
  con el encabezado fijo: con 24 pilotos no hay layout que entre, y achicar la fuente hasta que
  entre es peor.
- **Largada y Autos conectados arriba, lado a lado** — son los protagonistas. El mapa abajo,
  tomando todo el alto restante.
- **Red pasó a ser un botón** en la barra, que se pinta verde solo si las dos mitades están bien
  (servidor identificado **y** telemetría entrando). Media conexión es tan inútil como ninguna.
- **El modo de aplicación es un switch siempre visible** en la barra. Antes era un checkbox dentro
  de una tarjeta y se podía correr una carrera entera sin notar que el motor no sancionaba nada.
- **Los botones de guardar se apagan** y se ponen verdes cuando no hay nada que guardar. Se compara
  contra los últimos valores guardados y no contra un flag de "tocado": si el admin cambia un valor
  y lo deja como estaba, el botón se apaga solo.
- **Botones de largada con estado**: "Verde" y "Reset" ya no se pueden apretar cuando el servidor
  los va a ignorar en silencio.
- Las sanciones y la bandeja de incidentes se mudaron a **`/sanciones`**, con router de History API
  y fallback de Express para que recargar esa URL no dé 404.

### Mapa del circuito en vivo

El trazado **se aprende solo**, sin pedirle archivos de pista a nadie: `CAR_UPDATE` ya trae
`posX`/`posZ` en coordenadas reales del mundo junto con la posición normalizada en la vuelta
(`server/src/track/trackLearner.ts`). Se indexa por posición de vuelta y no por orden de llegada,
así el dibujo sale ordenado aunque las muestras lleguen mezcladas de 20 autos repartidos por toda
la pista — cuantos más autos hay, más rápido se completa. Se guarda por circuito y queda para
siempre.

- Render en `<canvas>` con interpolación entre muestras, porque el panel consulta una vez por
  segundo y sin interpolar los autos avanzarían a saltos. Un salto grande (reset a boxes) no se
  interpola: dibujaría el auto cruzando el circuito en línea recta por el medio.
- **Hover** sobre un auto muestra nombre y número. **Click** en un piloto de la tabla lo resalta en
  amarillo en el mapa, y al revés. Es una sola variable de selección para los dos sentidos:
  sincronizar dos estados por separado es la forma segura de que se desincronicen.

### Tabla de pilotos: ping y kick

- **"Señal" pasó a "Ping"**, en milisegundos, medido por la app del piloto en su heartbeat. Honesto
  sobre qué mide: el protocolo UDP de AC **no expone** el ping del piloto al servidor de carrera.
  Esto es el round-trip hacia Race Control. Sirve igual para lo que el admin quiere saber —quién
  tiene conexión inestable— y se etiqueta sin prometer de más.
- **Kick por fila con doble confirmación**: el botón se arma, cambia de color y se desarma solo a
  los 4 s. Expulsar a alguien a mitad de carrera no se deshace y no puede salir de un click fallido
  en una tabla que se actualiza sola. (Un `confirm()` nativo tampoco servía: bloquea el hilo y
  congela el mapa mientras está abierto.)
- El kick manual se ejecuta **siempre, aunque el modo sombra esté activo**. El modo sombra existe
  para que el motor automático no sancione sin supervisión, no para bloquear una orden explícita
  del admin, que por definición ya está supervisada. Queda en el journal como `kick.manual`,
  distinguible del automático.

### Identidad visual

Hasta acá no había ninguna marca: el navegador mostraba el favicon genérico y el panel abría con
texto plano. `brand/icon.svg` es una bandera a cuadros con un arco de señal emitiendo desde la
esquina. Dos elementos y no más, porque a 16 px cualquier tercero se vuelve una mancha: la bandera
comunica "carreras" al instante y el arco comunica "telemetría", que es lo que distingue a esta app
de cualquier otra herramienta de sim racing. La paleta no se inventa, son las variables CSS que el
panel ya definía.

### Tests

El proyecto no tenía ninguno. Al cierre de la 0.3, `npm test` corre **123 casos** con el runner de
Node (sin agregar dependencias) sobre lo que más conviene testear: lógica pura sobre paquetes
decodificados.

- Decodificador de `CLIENT_EVENT`, incluido el contrato de no tumbar el proceso ante un paquete
  truncado — se prueba cortándolo en todas las longitudes posibles.
- Las rarezas de codificación del protocolo: `CAR_INFO` con las cinco cadenas anchas, y
  `NEW_CONNECTION` mezclando anchas (nombre, GUID) con angostas (modelo, skin). Y que en
  `NEW_SESSION` la duración viene **antes** de las vueltas y en minutos: invertir esos dos campos
  no rompe nada visible —da una carrera "a 10 vueltas" sin reloj, que es exactamente lo que parece
  una carrera por vueltas— y por eso necesita un test y no una lectura atenta.
- Motor de incidentes con reloj falso: correlación de las dos perspectivas, clasificación
  geométrica, antiflood, no agrupar toques contra rivales distintos, y que el contexto guardado sea
  el del momento del impacto.
- Aprendizaje del trazado: persistencia entre reinicios, no mezclar circuitos, nombres de pista con
  barras, y descarte de posiciones en (0,0).
- Clasificación en vivo y deducción de marca, incluido que una marca que no está en la biblioteca
  devuelva `null` en vez de un slug optimista.
- Límites de pista: umbral de ruedas, mínimo de duración, reincidencia, ganancia de tiempo medida
  contra la mejor vuelta limpia, validación cruzada contra los cortes del servidor, y que un
  reporte con basura no cuente ni rompa.
- Restauración desde el journal: división por motor, última escritura gana, corte por antigüedad,
  línea final truncada, y que restaurar no vuelva a emitir los avisos de cada sanción.
- Rotación de `raw.bin` y armado del informe de carrera.

---

## Tercera tanda: torre de tiempos en vivo

### "Autos conectados" era una tabla de cuatro columnas

Piloto, velocidad, vuelta y ping no alcanzan para dirigir una carrera. Ahora es una **torre de
tiempos**: posición, logo de marca del auto, velocidad, vueltas, tiempos por sector, última vuelta,
mejor vuelta, paradas en boxes, compuesto, combustible y ping. La mejor vuelta absoluta de la
sesión va en morado y la mejor propia en verde, que es el código de color de cualquier timing de
sim racing y por eso no hay que explicarlo.

La posición se calcula en vivo: por progreso (vueltas + avance en el trazado) en carrera, y por
mejor vuelta en práctica y clasificación. Ordenar una tanda libre por progreso daría un orden sin
ningún significado — lidera el que más vueltas lleva dando, no el más rápido.

Una vuelta con cortes cuenta como última vuelta pero **no** como mejor vuelta. El dato de cortes ya
venía del servidor y se estaba ignorando.

### La mitad de esas columnas no existe en el protocolo de AC

Esto hay que decirlo claro: el UDP de Assetto Corsa **no transporta** tiempos por sector, compuesto,
combustible ni paradas en boxes. `LAP_COMPLETED` trae el tiempo total de la vuelta y los cortes, y
se acabó. La única fuente es la Shared Memory del juego, que corre en la PC de cada piloto.

Así que esas columnas vienen de la app del piloto, por el mismo heartbeat que ya existía — un solo
canal, misma validación, mismo modo de fallo. El intervalo bajó de 5 s a 2 s para que la torre se
sienta en vivo. Un piloto sin la app aparece con todo lo autoritativo (posición, velocidad, vueltas,
tiempos de vuelta) y guiones en el resto: degrada bien, y de paso convierte la app en algo que el
piloto quiere tener instalado en vez de algo que se le impone.

En el cliente, las structs de Shared Memory pasaron a declararse completas con `ctypes` en vez de
calcular offsets a mano. No es cosmético: **el offset de la bandera que había (68) caía dentro del
array `lastTime`** — estaba mal, y estaba mal porque un número suelto no hay forma de revisarlo.
Declarada la struct, los offsets los calcula ctypes y ese error no puede volver a pasar.

Queda pendiente de verificación en pista si `lastSectorTime` es acumulado desde el inicio de la
vuelta o ya viene por sector. Se asume acumulado (el consenso de las implementaciones
comunitarias), con detección del otro caso y descarte de valores absurdos: ante la duda la columna
muestra un guion, nunca un número inventado.

### Logos de marca, de la propia instalación de Assetto Corsa

El logo de cada auto sale de `content/cars/<modelo>/ui/badge.png` del juego instalado en la PC del
admin. Se busca solo (registro de Steam, más `libraryfolders.vdf` para instalaciones en otro
disco) y se puede corregir a mano desde el cajón de reglas.

> **Revertido en la octava tanda.** Obligaba a que el admin tuviera Assetto Corsa instalado en la
> misma PC que el backend, que no es el caso de quien dirige la carrera sin correrla. Se reemplazó
> por una biblioteca de logos empaquetada con la app.

### Layout y barra superior

- El mapa pasó a ocupar **la mitad** del ancho de la torre, al costado, en vez de una fila entera
  abajo.
- La largada pasó de tarjeta cuadrada a **banda horizontal arriba**: el semáforo y sus tres botones
  en una sola fila, un sexto del alto que ocupaban. Va arriba y no abajo porque es lo único de la
  pantalla que es secuencial —se usa una vez, al principio— y dejarla abajo obligaría a bajar la
  vista en el único momento de la carrera en que el admin no puede distraerse.
- Orden de la barra: **Control de carrera** (antes "En pista") → Sanciones → Reglas → **Conexión**
  (antes el botón de "Sin señal"). El switch de modo queda donde estaba.
- "Control de carrera" lleva una **bandera a cuadros que ondea solo con la carrera en curso**. Antes
  había que buscar el semáforo de la tarjeta de largada y leerlo; con el panel en una segunda
  pantalla, eso es justo lo que no se quiere tener que hacer. Respeta `prefers-reduced-motion`: ahí
  se queda quieta y el estado lo comunica el color.
- Los cajones laterales scrollean por dentro, documentado como segunda excepción deliberada a la
  regla de "una sola pantalla" (la primera son las tablas). Cinco secciones de configuración no
  entran en 768 px de alto en ninguna resolución realista, y el cajón es una capa flotante **por
  encima** de la pantalla de carrera, no parte de ella.

---

## Cuarta tanda: límites de pista

### Las salidas de pista no las puede ver el servidor

El UDP de Assetto Corsa no dice si un auto tiene ruedas afuera. Lo único que manda es `cuts` al
cerrar la vuelta: cuántos cortes hizo, sin decir dónde, cuándo ni de qué tamaño. Así que la
detección la hace la app del piloto leyendo `numberOfTyresOut` de la Shared Memory.

Lo que viaja al backend son **transiciones**, no un stream: la salida se encola recién cuando
termina, con cuánto duró y cuántas ruedas llegó a tener afuera. Mandar el valor instantáneo cada
2 segundos no serviría — una salida típica dura menos que eso y caería justo entre dos muestras.
El muestreo es a 4 Hz, que es lo que corresponde a una app corriendo dentro del juego: no debe
competir por CPU con el render.

El umbral (2 o 4 ruedas) lo aplica el **servidor**, no el cliente: el cliente detecta todo desde 2
ruedas y manda el máximo observado. Así, cambiar la regla desde el panel no obliga a que 24 pilotos
actualicen la app.

Configurable desde el cajón de reglas: si se controla o no, cuántas ruedas cuentan, cuántas salidas
antes de avisar, cuánto dura la salida mínima, y si una salida con ganancia de tiempo va directo a
la bandeja. Por defecto: 4 ruedas, 3 salidas, 300 ms. Se avisa a la reincidencia y no a la primera,
que es el modelo de "track limits" de las categorías reales.

### Ganancia de tiempo: contra la mejor vuelta *limpia*

Una salida es un error; una salida en la vuelta más rápida del piloto es otra cosa. La comparación
es contra su mejor vuelta **sin salidas y sin cortes**, no contra su mejor vuelta a secas: si no, la
primera vuelta sucia y rápida sube el listón y tapa todas las siguientes.

### El cliente es editable, así que se contrasta

El cliente es un `.py` en texto plano en la PC del piloto. La defensa no es cifrarlo, es
contrastarlo contra lo que el servidor sí sabe. Si el servidor viene contando cortes que la app del
piloto nunca informó, eso mismo entra en la bandeja como *telemetría inconsistente*.

La comparación es **acumulada por sesión, no vuelta a vuelta**, y esto importa: el heartbeat viaja
cada 2 s, así que una salida justo antes de la línea de meta llega después del `LAP_COMPLETED` y
queda contada en la vuelta siguiente. Vuelta a vuelta, ese desfasaje daría falsos positivos todo el
tiempo. Lo que un desfasaje no puede producir es una diferencia que crece y nunca se cierra — por
eso la tolerancia es de 3 y la cuenta es acumulada.

Un piloto **sin** la app nunca genera este aviso: sin telemetría no hay nada que contrastar, y
reclamarle incoherencia a quien no reporta nada sería acusarlo por no tener la app instalada.

Los contadores están indexados por `driverGuid` y **sobreviven a una desconexión**. Borrarlos al
desconectar convertiría el Alt+F4 en una forma de limpiar el contador de límites de pista.

### `isValidLap` no existe en Assetto Corsa

Es un campo de ACC, no de AC. La página `acpmf_graphics` de AC termina en `mandatoryPitDone` y no
expone validez de vuelta. O sea que `cuts` del servidor no es *una* señal de vuelta invalidada: es
la única que hay, lo cual es justamente lo que hace que valga la pena cruzarla.

### La bandeja ahora tiene cuatro tipos

Toque entre autos, choque en solitario, límites de pista y telemetría inconsistente — en la misma
lista a propósito: para el comisario son todos "algo que revisar", y partirlos en dos lo obligaría a
mirar en dos lados durante la carrera. Los que no son colisión no muestran velocidad de impacto: el
backend manda el campo ausente en vez de un cero, así que el panel omite la línea en lugar de
afirmar "impacto a 0 km/h", que sería un dato que nadie midió.

Como el resto de la bandeja: **reporta, no sanciona**.

---

## Quinta tanda: catálogo de infracciones y presets

### Dos bloques gemelos de velocidad no son un catálogo

La configuración eran dos bloques con la misma forma (largada y pit lane) y, por cada tipo nuevo de
infracción, un `enabled` booleano. Eso dejaba afuera la única decisión que un admin de liga
realmente quiere tomar: no *si* se mira, sino **qué pasa cuando ocurre**.

De ahí `action`, que es el mismo campo en todos los tipos: `No controlar` / `Solo registrar` /
`Mandar a revisar` / `Sancionar solo`.

**La sanción automática solo se ofrece donde el hecho es objetivo.** Hoy eso es un tipo solo:
límites de pista. Contar ruedas afuera no se interpreta. En un toque el servidor sabe que hubo
contacto, **no de quién fue la culpa**: ofrecer "sancionar solo" ahí sería prometer un juicio que
el dato no respalda. La lista de qué tipos lo admiten la manda el backend en `/api/catalog`, no la
duplica el panel: si vive en dos lados, tarde o temprano el panel ofrece una opción que el servidor
va a rechazar.

### Presets por tipo de torneo

Un admin no técnico no tiene forma de saber qué umbral de impacto poner. Elige *Carrera casual*,
*Campeonato* o *Simulación estricta* y todos los números quedan puestos; después puede tocar lo que
quiera, y tocar algo a mano no invalida el preset — es un punto de partida, no un candado.

Cada preset es un **patch** sobre los valores por defecto, no un catálogo completo: así, agregar un
tipo de infracción nuevo no obliga a tocar los tres presets ni deja huecos silenciosos.

---

## Sexta tanda: el enlatado

### El wizard decía que detectaba cosas que eran constantes

El asistente de primer arranque pedía el nombre de la liga y afirmaba que "el resto (puertos, IP
pública) se detecta solo", lo cual era falso para los puertos: eran constantes en el código. Ahora
son cuatro pasos —liga → tipo de torneo → conexión → comprobación en vivo— y el último de verdad
verifica que llegue telemetría antes de dejar pasar.

### "Probar conexión" en castellano llano

Cuatro chequeos en orden, cada uno con qué hacer si falló: tu dirección en internet, señal del
servidor de carrera, órdenes hacia el servidor, y la app de los pilotos. Los dos últimos están
separados a propósito: el servidor puede estar mandando telemetría perfecta mientras ningún piloto
logra alcanzar el puerto de clientes, y antes eso se veía todo verde.

### Puertos ocupados y guía genérica

- Si el 3000 está tomado por otro programa, el arranque se corre al siguiente libre y abre el
  navegador ahí. Antes el panel no abría y el error salía solo por consola.
- La guía dejó de ser "de EmperorServers": el snippet que genera (`UDP_PLUGIN_LOCAL_PORT` /
  `UDP_PLUGIN_ADDRESS`) es estándar de Assetto Corsa y sirve para cualquier hosting. Era solo
  cuestión de nombrarlo y documentarlo como tal.

---

## Séptima tanda: persistencia, informe de carrera y sanciones del comisario

### Las sanciones vivían solo en memoria

Si el proceso se reiniciaba a mitad de carrera, se perdían todas. El journal ya registraba todo en
JSONL; lo que faltaba era reconstruir el estado al arrancar. Ahora se reconstruyen sanciones e
incidentes desde el journal, con corte por antigüedad y descartando lo anterior al último
`NEW_SESSION` —una sanción de la carrera de ayer no tiene por qué revivir hoy—.

**Dos bugs que aparecieron al escribir esto, y que importan más que la función:**

- **El journal escribía con un `WriteStream`.** El buffer de un stream se pierde entero si el
  proceso se corta sin cerrarlo, que es *exactamente* el caso que la restauración existe para
  cubrir. Pasó a escritura sincrónica: son unos pocos eventos por vuelta y el costo no se nota.
- **La rotación de `raw.bin` no rotaba nunca en Windows.** `stream.end()` cierra el archivo de
  forma asincrónica, y renombrar un archivo todavía abierto falla con EBUSY — el error caía en el
  `catch` que existía para no tumbar la carrera por un problema de disco, y la rotación quedaba
  atrapada ahí en silencio. En el único sistema operativo donde corre esto. También pasó a
  descriptor y `closeSync`. Hay tests que verifican que rote, que no parta un registro entre dos
  archivos, que no conserve un historial y que dos rotaciones en el mismo milisegundo no se pisen.

### Informe de carrera descargable

Botón "Descargar informe de carrera" en la vista de sanciones: un CSV con la clasificación, los
segundos de penalización de cada piloto, todas las sanciones y todos los incidentes revisados. Es
un CSV y no un PDF porque lo que el admin hace con esto es pegarlo en la planilla del campeonato.
Separado por `;` y con BOM: Excel en español parte por coma decimal, y sin BOM rompe los acentos
de los nombres de los pilotos en la primera fila.

**Lo que el informe no trae: tiempo total de carrera por piloto.** El UDP de AC no lo transporta —
`LAP_COMPLETED` manda el tiempo de *esa* vuelta y nada más—. Acumular vueltas daría un número
parecido al oficial y distinto, que es la peor clase de dato en un informe que decide un
campeonato. Por eso la clasificación es por progreso y los segundos de penalización van en su
propia columna, para sumarlos sobre el resultado del servidor.

### "Sancionar" en la bandeja no sancionaba

Resolver un incidente como *sancionado* solo cambiaba el estado del incidente. No se le avisaba al
piloto, no quedaba en la tabla de sanciones aplicadas, no se persistía y no sobrevivía a un
reinicio: la decisión del comisario se perdía.

Ahora hay un tercer motor de sanciones (`steward`) con sus propias reglas, separado de las de pit
lane para que cambiar la gracia de pit no altere lo que decide un comisario. Al sancionar se elige
**a quién** —un toque tiene dos pilotos y el servidor no sabe de quién fue la culpa— y **qué**:
penalización de tiempo, Drive-Through, Stop & Go o lastre. La sanción resultante se chatea al
piloto, aparece en la tabla, se persiste y se restaura.

Esto cerró además un pendiente viejo: `timePenaltySeconds` estaba definido desde la 0.1 y no se
usaba en ningún lado. Ahora es el tipo de sanción `TIME`, que es inmediata (no tiene nada que
"cumplir": son segundos al resultado final) y es la que alimenta la columna del informe.

La validación va **antes** de resolver: `resolve()` es irreversible, y un tipo de sanción inválido
dejaría un incidente marcado "sancionado" sin ninguna sanción detrás.

---

## Octava tanda: pedidos sobre el panel ya funcionando

### El auto se ve por su logo, no por su nombre

Un nombre obliga a leer; una forma constante se reconoce de un vistazo, que es para lo que existe
un logo. La columna "Auto" muestra el logo de la marca.

**El logo dejó de salir de la instalación de Assetto Corsa.** La idea anterior (leerlo de
`content/cars/<modelo>/ui/badge.png`) funcionaba, pero obligaba a que el admin tuviera el juego
instalado en la misma PC que el backend —que no es el caso de quien dirige la carrera sin
correrla— y a hurgar en el registro de Steam para encontrarlo. Ahora viene una **biblioteca de 126
SVG empaquetada con la app**, armada con los sets MIT `car-brand-logos` y `car-makes-icons`
(ninguno de los dos alcanza solo: al primero le faltan Lamborghini y Ford, al segundo Pagani,
Lancia y Alpine). Procedencia y cómo actualizarla, en `server/src/api/public/brands/LEEME.md`.

Las marcas que no están —Lancia, Pagani, Praga, KTM, Tatuus y unas cuantas de competición— caen a
un **escudo con el monograma** de la marca en un color derivado del nombre. El backend decide cuál
de las dos cosas va y manda `brandLogo: null` cuando no hay archivo: así el panel dibuja el escudo
de una, en vez de pedir una imagen, esperar el 404 y reemplazarla —que se veía como un parpadeo en
cada fila de auto mod—. RUF y Shelby llevan el logo de la marca sobre la que están construidos.

### "Carrera en curso" se nota

Dada la luz verde, la banda de largada se enciende con un borde verde y un indicador pulsante.
Antes el único cambio era el texto del semáforo, que es exactamente lo que no se ve de reojo
desde una segunda pantalla. La animación respeta `prefers-reduced-motion`.

El botón de reset pasó a llamarse **"Reiniciar largada"** y explica qué hace al pasar el mouse:
vuelve el semáforo a "Esperando" y apaga el control de velocidad de formación, para rearmar una
largada abortada. No borra las sanciones ya emitidas ni toca el servidor de Assetto Corsa.

### El mapa en vivo muestra las condiciones de la sesión

Arriba del trazado: circuito y variante, nombre y tipo de sesión, duración, clima, temperatura de
aire y pista, y agarre. Abajo, el **tiempo restante** en grande, que se pone ámbar sobre el final.

**No hay viento ni hora del juego, y no es un olvido: no existen en Assetto Corsa.** Son campos de
ACC. La `SPageFileGraphic` de AC termina en `mandatoryPitDone`. Poner esas columnas con un "--"
permanente sería peor que no ponerlas: parecería que algo está mal configurado.

### Menos preguntas en el cajón de reglas

Se sacaron las que un admin no sabe cómo responder y que estaban puestas por completitud, no por
necesidad: el umbral de "registrar desde (km/h)" de toques y choques en solitario (sigue en la
config, con su valor por defecto), y el aviso de ganancia de tiempo en salidas de pista.

**Las banderas azules se quitaron por completo**, no se escondieron. Detectar "retención" con el
spline y un contador de segundos produce falsos positivos en cualquier curva lenta con tren de
autos, y un detector que sigue llenando la bandeja sin forma de configurarlo es peor que no
tenerlo. Se borró el vigía, su configuración y sus tests.

### El ejecutable dice "Race Control"

El `.exe` muestra el logo en el Explorador, y SmartScreen y el Firewall dicen "Race Control" en vez
de "node" — que es el momento exacto en el que un admin no técnico desconfía y cierra todo.

El intento de la 0.2.1 corría `rcedit` sobre el `.exe` ya armado por pkg y corrompía su payload
("Pkg: Error reading from file" al arrancar). El diagnóstico era correcto, la conclusión no: **el
problema era el orden, no la herramienta**. Ahora se marca el *binario base de Node* —antes de que
pkg le inyecte nada— y se le dice a pkg que use ese, con `PKG_NODE_PATH`. Como rcedit toca el PE
cuando todavía no hay payload, no hay nada que corromper. Verificado ejecutando el `.exe`
resultante desde una carpeta nueva, que es el escenario que destapó los bugs de la 0.2.1.

El `.ico` multi-resolución (16 a 256 px) se genera de `brand/icon.svg` y se versiona, para que
empaquetar no dependa de tener un rasterizador instalado.

### Los puertos UDP se configuran, y el desajuste se avisa

Un hosting real (EmperorServers) llegó con `udp_plugin_local_port=8008` ya puesto en su panel. Race
Control asumía 11000/12000 **y no tenía dónde cambiarlos**: estaban en la config y en ninguna
pantalla. El resultado habría sido el peor modo de fallo posible — telemetría entrando perfecta,
los cuatro chequeos en verde, y ni una sanción llegando nunca al servidor, sin nada en pantalla que
apuntara a la causa.

Dos cosas, entonces:

- Los dos puertos del lado de Assetto Corsa se editan en **Conexión → Puertos**. El texto para
  pegar en el `server_cfg.ini` se regenera con los valores nuevos, así que las dos puntas siguen
  coincidiendo solas.
- El diagnóstico compara el puerto **desde el que habla** el servidor contra el puerto al que le
  mandamos, y si no coinciden lo dice en rojo con los dos números y las dos formas de arreglarlo.

Esto último se apoya en un supuesto: que el acServer usa un solo socket para el plugin, y entonces
manda desde el mismo puerto que declara en `UDP_PLUGIN_LOCAL_PORT`. Es lo que hacen las tres
implementaciones de referencia, pero no está verificado contra un servidor real — anotado como tal
en `docs/spike-protocolo.md`, con dónde desactivarlo si resulta que no.

### Exigir la app del piloto ahora es una decisión, no un hecho consumado

`presence.enforce` existía en la config desde la primera tanda y **no estaba en ninguna pantalla**:
venía activado y la única forma de apagarlo era editar el `config.json` a mano, que es exactamente
lo que este proyecto existe para evitar. Con el default puesto, un piloto sin la app se iba del
servidor al minuto y el admin no tenía dónde cambiar eso.

Está en **Reglas → App de los pilotos**, junto con el tiempo de espera. Se descubrió revisando la
documentación contra el código: el README prometía que la app era opcional y el código no lo
cumplía. La corrección podía ir de los dos lados; se eligió el que le da la decisión al admin.

---

## Primera tanda: bloqueantes contra un hosting remoto

### El backend le hablaba a sí mismo

`acUdp.remoteHost` estaba fijo en `127.0.0.1` y no era configurable desde ningún lado: ni el
panel, ni el snippet, ni la guía lo tocaban. Contra un servidor en un hosting, **todo** el tráfico
saliente moría en loopback: el chat de penalización, los kicks, `/ballast` y el keepalive que abre
el pinhole de NAT del que depende la estrategia de red `"direct"`. El backend recibía telemetría
perfecta y no podía contestar absolutamente nada.

Esto explica, además, por qué la conectividad "directa" nunca podía funcionar sola: el pinhole se
abre mandando tráfico al servidor, y ese tráfico no salía de la PC.

- **Fix**: el servidor de AC se identifica solo. `adoptRemoteHostIfNeeded()` en
  `server/src/udp/client.ts` toma la dirección de origen del primer datagrama recibido y la adopta
  si la configurada sigue siendo loopback. El admin no tiene que saber la IP de su servidor, que
  era justamente la promesa del README ("ni una IP que tipear").
- Se adopta la dirección pero **no** el puerto de origen: el puerto de comandos es el que el admin
  declaró en `UDP_PLUGIN_LOCAL_PORT`, y ese es el valor autoritativo. El puerto de origen igual se
  registra en el journal, porque sería el dato que explicaría un fallo si alguna versión del
  servidor se comportara distinto. (En la prueba local el origen fue un puerto efímero, lo que
  confirma que adoptarlo a ciegas habría sido frágil.)
- El host detectado se persiste en `config.json`, así el siguiente arranque ya sale configurado.
- El panel ahora muestra **a dónde salen los comandos**, y lo marca en rojo si sigue en loopback
  mientras entra telemetría — el síntoma exacto de este bug. Se agregó también un campo manual
  para hostings que no se identifiquen solos.

### El modo sombra no frenaba los kicks

`PresenceWatchdog` llamaba a `udpClient.kick()` directo, sin pasar por `dispatchOrSuppress` y sin
dejar rastro en el journal. Con el modo sombra activado por defecto, la primera carrera de prueba
—el escenario que el README recomienda explícitamente— expulsaba a todo piloto sin la app
instalada a los 15 segundos. Lo contrario de lo que el panel promete, sin evidencia de qué pasó, y
en el momento de máxima desconfianza hacia la herramienta.

- **Fix**: el watchdog ya no conoce al `udpClient`. Recibe un `dispatchKick` que `index.ts` cablea
  con el mismo `dispatchOrSuppress` que usan las sanciones, así el modo sombra vale también acá y
  todo kick queda en el journal.
- Un solo kick por piloto por conexión. En modo sombra el kick se suprime, así que el piloto sigue
  conectado y la condición volvía a dispararse en cada tick: sin esto, el arreglo anterior habría
  inundado el journal con el mismo evento cada 5 segundos durante toda la carrera.
- Gracia configurable (`presence.graceSeconds`) y subida de 15 s a 60 s. Los 15 s anteriores eran
  **menores** que la ventana de auto-discovery (5 reintentos × 4 s): un piloto que activaba la app
  después de entrar al servidor era expulsado antes de poder recibir la dirección del backend.
- `presence.enforce` permite desactivar el kick por presencia sin apagar el resto del motor.

### Las sanciones de largada nunca se podían cumplir

`PitComplianceTracker` se instanciaba solo con el motor de pit, así que `markServed()` nunca se
llamaba para una sanción de formación. Con el default `penaltyType: "DT"`, un piloto sancionado en
la largada cumplía el Drive-Through correctamente y escalaba a DQ igual al agotar las vueltas de
gracia. El mensaje que recibía —"Tenés N vuelta(s) para cumplirla"— era literalmente falso.

- **Fix**: el tracker recibe ahora la lista de motores. El pit lane es físicamente uno solo: una
  sanción se cumple pasando por ahí, sin importar qué motor la emitió.
- La velocidad legal de pit se pasa explícitamente desde `config.pit`, en vez de leerse del motor
  que emitió la sanción — el límite del pit lane no cambia según por qué te sancionaron.

### El puerto de los pilotos no se abría

El mapeo UPnP del puerto TCP de clientes vivía dentro de la rama de fallo del UDP. El problema es
que el pinhole de NAT que hace entrar la telemetría UDP no abre nada para el TCP entrante de los
pilotos: con el UDP entrando "directo", la función retornaba temprano y ese puerto no se tocaba
nunca. El panel mostraba "directa / recibiendo" en verde mientras ningún piloto podía mandar
heartbeat — y todos terminaban kickeados por el watchdog.

- **Fix**: el puerto de clientes se mapea siempre, antes de cualquier otra cosa.
- El panel separa ahora **"señal del servidor"** de **"pilotos reportando"**. Son dos cosas
  distintas que fallan por separado, y mostrarlas juntas era lo que hacía que el estado diera todo
  verde justo antes de que empezaran los kicks.

### Robustez de config

- `validateConfig` valida puertos y dirección remota, que antes no se validaban.
- Guarda contra un `config.json` con `null` o un escalar donde se espera un objeto: `mergeConfigInto`
  solo recursa cuando ambos lados son objetos, así que lo copiaba tal cual y el arranque moría con
  un `TypeError` al leer un campo anidado.

### Verificación

El host remoto se probó end-to-end simulando un servidor de AC que manda un `NEW_SESSION` desde la
IP de LAN: el backend lo detectó, lo persistió y lo registró en el journal. El cumplimiento de
sanciones de largada y el modo sombra del watchdog se verificaron con un script contra el código
compilado (7 casos, incluido el negativo de pasar por el pit por encima del límite).

Para la segunda tanda, además de los 18 tests: un servidor de AC falso mandando tráfico UDP real
(sesión, tres pilotos, dos vueltas de telemetría, un toque entre autos y un trompo de 15 impactos)
contra el backend corriendo. Resultado: dos incidentes en la bandeja y no dieciséis —el toque
unificado con las dos perspectivas y clasificado como trompa contra cola, el trompo agrupado con su
contador—, el circuito aprendido y guardado en disco, el kick manual ejecutado y los automáticos
suprimidos por el modo sombra. El panel se verificó en Chromium a 1920×1080 y 1366×768: sin scroll
de página en ninguna de las dos vistas, sin errores de consola, el trazado efectivamente dibujado
en el canvas, y la doble confirmación del kick armando y desarmándose sola.

## [0.2.3] — 2026-10-09

Tercer intento sobre el mismo síntoma — esta vez probado con un navegador real (Playwright +
Chromium headless) en vez de solo `curl`, que fue lo que había dejado pasar el bug real dos veces
seguidas.

- **Causa real (por fin)**: el CSS de `#wizard-overlay` le ponía `display: flex` de forma
  incondicional. Esa regla de autor le gana en el cascade a la regla nativa del navegador para
  `[hidden]` (`display: none`), así que el atributo `hidden` se seteaba perfecto desde JS pero el
  modal nunca desaparecía visualmente — los dos fixes anteriores (0.2.1, 0.2.2) eran correctos
  pero no podían arreglar algo que estaba roto en el CSS, no en la lógica.
  **Fix**: `#wizard-overlay[hidden] { display: none; }` (`server/src/api/public/index.html`).
- Verificado con capturas de pantalla reales: wizard se cierra al guardar, se mantiene cerrado
  tras recargar la página, y el resto de los botones del panel (formación, reset, modo sombra,
  guardar reglas) funcionan sin errores de consola.

## [0.2.2] — 2026-10-09

Segundo fix encontrado probando la 0.2.1 real: el modal de primera vez seguía sin cerrar incluso
con el nombre de liga ya guardado correctamente en disco.

- **Causa real**: `firstRun` se calculaba una sola vez al arrancar el proceso (`!fs.existsSync(...)`
  evaluado antes de que existiera el archivo) y quedaba congelado en `true` el resto de la vida
  del proceso — aunque el admin ya hubiera completado el wizard. **Fix**: `isFirstRun()` ahora se
  deriva en vivo de `config.leagueName` (`server/src/config.ts`), recalculado en cada
  `GET /api/state`.
- El frontend (`app.js`) dejó de depender de un flag que se seteaba una sola vez (`wizardShown`):
  ahora el modal se muestra/oculta en cada actualización (1 vez por segundo) según el estado real
  del servidor — si por lo que sea no se cerrara solo, el próximo poll lo corrige.

## [0.2.1] — 2026-10-09

Fix encontrado probando el `.exe` real por primera vez: el wizard de primer arranque (pedir el
nombre de la liga) se quedaba trabado sin cerrar el modal, sin ningún error visible.

- **Causa real**: `config.json` se guardaba al lado del `.exe`. Si el admin lo corre desde
  Descargas (el caso típico, recién bajado del navegador), esa carpeta puede tener permisos de
  escritura restringidos por el antivirus/Windows — el guardado fallaba en silencio y el panel
  nunca se enteraba. **Fix**: `config.json` y `logs/` ahora viven en `%APPDATA%\RaceControl`,
  siempre escribible por el usuario actual sin importar desde dónde se corra el `.exe`
  (`server/src/config.ts`).
- **Manejo de errores end-to-end**: el panel (`app.js`) ahora muestra un aviso visible si un
  guardado falla, en vez de fallar en silencio; el backend (`adminApi.ts`, `clientApi.ts`) nunca
  más devuelve una página de error HTML sin manejar — siempre JSON, para que el panel pueda
  mostrarlo.
- **Se intentó** parchear el `.exe` para que Windows lo identifique como "Race Control" en vez de
  "node" en los diálogos de SmartScreen/Firewall (vía `rcedit`), pero reescribir los recursos del
  `.exe` después de empaquetarlo con `pkg` corrompe su payload interno. Se descartó — en cambio,
  se documentó en `LEEME.txt` que esos avisos son esperables y seguros de aceptar.

## [0.2.0] — 2026-10-09

Puesta a punto para producción: pasar de un prototipo técnico (requería clonar el repo, tener
Node.js instalado, editar JSON a mano y configurar el router) a algo que un admin y pilotos no
técnicos puedan usar sin ayuda. Incluye además un endurecimiento del motor de detección para
acercarlo a la confiabilidad de "Real Penalty", ya que va a sancionar pilotos en vivo.

### Empaquetado y distribución

- **Backend como ejecutable único** (`server/scripts/package.js`, dependencia `@yao-pkg/pkg`):
  `RaceControlServer.exe` no requiere Node.js instalado. `config.json` y `logs/` se resuelven
  junto al `.exe` real (`getConfigDir()` en `server/src/config.ts`), no dentro del snapshot
  empaquetado. Abre el navegador solo al arrancar.
- **Wizard de primer arranque**: en vez de editar `config.json` a mano, el panel pide solo el
  nombre de la liga (`firstRun` en `/api/state`); el resto se autodetecta.
- **Cliente instalable como .zip** (`client-app/scripts/package-client.js`): se reestructuró a
  `client-app/apps/python/RaceControlClient/` (con `ui.json`) para que el .zip reproduzca la
  convención de carpetas de Content Manager y sea instalable arrastrándolo, igual que un mod.

### Red (transparente para admin y piloto)

- **Puerto del panel admin separado** del puerto que usan los pilotos (`server/src/api/clientApi.ts`
  nuevo): el panel queda SIEMPRE en loopback, nunca expuesto a internet; solo se expone/forwardea
  el puerto de telemetría de pilotos.
- **Conectividad en cascada automática** (`server/src/net/connectivity.ts` nuevo): reaprovecha el
  comando saliente que el backend ya le manda al servidor de AC (abre un "pinhole" de NAT en la
  mayoría de los routers caseros sin configuración manual) y, si no alcanza, intenta UPnP
  automáticamente. Si ninguna de las dos funciona, el panel lo indica con los pasos manuales.
  Expuesto en `/api/state` → bloque `network`, con el texto ya armado para pegar en
  `server_cfg.ini` del hosting (`buildEmperorServersSnippet`).
- **Auto-discovery del cliente por chat** (`server/src/udp/announcer.ts` nuevo): al detectar
  `NEW_CONNECTION`, el backend le manda al auto un mensaje de chat dirigido con su propia
  dirección (`RACECONTROL_BACKEND:ip:puerto`). El piloto no configura ninguna IP nunca — el mismo
  .zip sirve para toda la liga/temporada.

### Motor de detección (endurecimiento)

Se identificaron ~30 casos borde sin cubrir (pérdida de paquetes UDP, reconexiones, reinicios a
mitad de carrera, NaN, deriva de config) y se resolvieron los más críticos:

- **Config con fuente única de verdad** (`server/src/config.ts`): se encontró y corrigió una
  deriva real entre los valores default del código (80 km/h, 1 vuelta de gracia) y los del
  `config.json` que se venía generando (120 km/h, 4 vueltas) — eran dos copias de la misma regla
  que podían desincronizarse. Ahora los motores de sanción leen el mismo objeto por referencia
  (`mergeConfigInto` muta en vez de reemplazar), así los cambios del panel se aplican en vivo.
- **Reloj monotónico y debounce** (`server/src/util/clock.ts`, `server/src/state/speedWatcher.ts`):
  el cronómetro de violación de velocidad ahora acumula tiempo entre muestras consecutivas (no
  reloj de pared desde el inicio) y no corta la racha ante un dropout corto por debajo del umbral
  — un paquete UDP perdido o un valor justo en el borde ya no genera falsos positivos/negativos.
- **Identidad de sanciones por `driverGuid`** en vez de `carId` (`server/src/penalty/penaltyEngine.ts`,
  `server/src/state/stateTracker.ts`): una sanción sigue al piloto aunque se reconecte y el
  servidor le asigne otro slot. `CONNECTION_CLOSED` fuera de orden ya no desconecta al ocupante
  nuevo del mismo slot.
- **Máquina de fases explícita** (`server/src/session/phase.ts` nuevo): el monitor de pit-speeding
  ya no se arma antes de que empiece la carrera (antes se activaba siempre, incluida la formación).
- **Robustez de paquetes UDP** (`server/src/udp/protocol.ts`, `server/src/udp/client.ts`):
  `decodePacket` nunca más puede crashear el proceso con un datagrama truncado/malformado; errores
  de socket y de envío se registran en vez de tumbar el proceso sin aviso.
- **Journal de eventos + captura cruda** (`server/src/log/journal.ts` nuevo): todo evento relevante
  (conexión, sanción, error) queda en `logs/events-*.jsonl`; los datagramas crudos quedan en
  `logs/raw.bin` para poder auditar después o reproducirlos (`server/src/sim/replay.ts`).
- **Modo sombra** (`config.shadowMode`, activado por defecto): el motor detecta y registra todo
  sin aplicar sanciones/kicks reales, hasta que el admin confirma manualmente desde el panel que no
  hay falsos positivos.

### Protocolo UDP: bug real encontrado y corregido

Se encontró el ejemplo oficial de Kunos del protocolo (`acRemoteServerUDP_Example`, un proyecto en
C# redistribuido dentro de `joaoubaldo/acudpclient`) y se cruzó contra dos implementaciones
comunitarias independientes (`joaoubaldo/acudpclient` en Python, `flamescape/acsp` en Node.js).

- **Bug encontrado**: el nombre de piloto, el `driverGuid` y los mensajes de chat se leían/escribían
  como UTF-16LE genérico. El formato real (confirmado por las 3 fuentes) es UTF-32LE para esos
  campos ("strings anchas") y ASCII/UTF-8 para modelo/skin de auto y nombre de pista ("strings
  angostas") — `server/src/udp/protocol.ts` ahora distingue `wideString()`/`narrowString()`. Esto
  afectaba la identificación de pilotos (heartbeat/presencia) y el envío de avisos de sanción y del
  auto-discovery — se corrigió sin necesitar un servidor real para encontrarlo.
- Se corrigió además `lapTimeMs` (era `int32`, debe ser `uint32`) y se ajustó el cálculo de
  velocidad para usar solo el plano horizontal (antes incluía la componente vertical, lo que
  sobreestimaba la velocidad en subidas/bajadas).
- `NEW_SESSION`/`SESSION_INFO`/`ERROR` ahora se parsean completos (antes se devolvía el buffer
  crudo sin decodificar). Se agregó re-habilitar el streaming de posiciones (`REALTIMEPOS_INTERVAL`)
  al recibir `NEW_SESSION`, siguiendo el mismo patrón que el ejemplo oficial de Kunos.
- Esto redujo drásticamente lo que queda pendiente de validar con Wireshark contra un servidor real
  — ver `server/docs/spike-protocolo.md` (actualizado, ya no es un paso obligatorio salvo que algo
  no cierre jugando una carrera de prueba).

### Panel admin (rediseño)

- Reescrito completo (`server/src/api/public/index.html` + `app.js` nuevo): estado en vivo (autos,
  velocidad, posición en pista, señal), control de largada, configuración separada en "reglas de
  carrera" (el admin nunca toca campos de red a mano) y zona de pit lane calibrable, estado de red
  con el texto listo para copiar a EmperorServers, interruptor de modo sombra, listado de sanciones.
- **Fix de seguridad**: se corrigió un XSS real (`innerHTML` sin escapar con nombres de piloto) —
  todo el contenido que viene del juego se inserta con `textContent`.

### Cliente del piloto

- **Fix crítico**: el cliente usaba f-strings de Python, no soportadas por el intérprete Python 3.3
  embebido en Content Manager — probablemente no cargaba en el juego real. Reemplazado por
  `.format()`/`%` en todo el archivo.
- Overlay dividido en 3 secciones independientes: sanciones, estado de largada, y bandera de pista
  (nueva — leída directo de la Shared Memory del juego, `Local\acpmf_graphics`, sin pasar por el
  backend; offset pendiente de verificar en una sesión real, ver `client-app/README.md`).
- `BACKEND_URL` pasó de constante hardcodeada a estado dinámico, resuelto por auto-discovery.
- Se consiguió y convirtió el audio de largada (`green_flag.ogg` → `green_green_green.wav`, PCM
  16-bit — `winsound.PlaySound`, lo único disponible en el Python embebido, solo reproduce WAV).

### Documentación

- `server/docs/guia-emperorservers.html`: guía paso a paso para el admin, con el porqué de cada
  campo de `server_cfg.ini`.
- `server/docs/spike-protocolo.md`: checklist de lo que queda por confirmar jugando una carrera de
  prueba real (actualizado tras el hallazgo del protocolo oficial de Kunos).
- READMEs (raíz y `client-app/`) reescritos para reflejar el uso real, no el estado de prototipo.

### Pendiente (documentado, no bloqueante)

- Validar `driverGuid` real y comportamiento de red bajo pérdida de paquetes con un servidor real
  (`server/docs/spike-protocolo.md`).
- Conseguir/confirmar el offset exacto de la bandera en Shared Memory contra una sesión real.
- Corte de pista genérico y distinción de "box propio" en el Stop-and-Go: quedan fuera de este
  alcance (simplificaciones v1 aceptadas).
- Modo de simulación con generador sintético e inyección de fallas: hoy solo existe el replay de
  capturas reales (`server/src/sim/replay.ts`).

## [0.1.0] — 2026-10-05

Scaffolding inicial: largada en movimiento + penalizaciones propias para Assetto Corsa. Instancias
1 y 2 funcionales de punta a punta, protocolo UDP sin validar, sin empaquetado ni guía de
despliegue.
