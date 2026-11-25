# Race Control Client (app de Content Manager)

## Instalación (una vez por piloto, cero configuración)

1. Abrir Content Manager.
2. Arrastrar `RaceControlClient.zip` (se lo pasa el admin de la liga, o se baja del release) a la
   ventana de Content Manager, como se instala cualquier mod de auto/pista.
3. Activar las ventanas dentro del juego: menú de Apps (AC Apps) → **RC Mensajes**, **RC Banderas**,
   **RC Largada** y **RC Alerta**. Son cuatro entradas separadas y se activan las que uno quiera —
   aunque conviene tener las cuatro: en reposo ninguna ocupa pantalla.
4. Acomodarlas en pantalla. La primera vez ya aparecen separadas, cada una en un lugar distinto de
   la pantalla (desde la 1.4); después de eso, el juego recuerda dónde las dejaste. Para fijarlas
   ahí y que no se muevan sin querer, click derecho arriba a la izquierda de la ventana → "Pin
   window" — es una función de Content Manager / Custom Shaders Patch, igual que en cualquier otra
   app.

No hay ningún archivo que editar ni ninguna IP que tipear: la app descubre sola a qué backend
reportar apenas el piloto se conecta al servidor (ver "Auto-discovery" abajo).

> **Si ya la tenías instalada de una versión anterior a la 1.4, hay que reinstalarla.** Arrastrá el
> `.zip` nuevo igual que la primera vez: pisa lo que había sin dejar restos. El `ui.json` dice la
> versión instalada, así que se puede verificar desde el listado de apps del juego.

## Las cuatro ventanas

| Ventana | Qué muestra |
|---|---|
| **RC Mensajes** | De arriba abajo: el estado de la conexión en gris chiquito, el contador de cortes (`CUTS: 3/5`) en celeste y grande, la sanción que falta cumplir en naranja, y abajo los avisos de dirección de carrera en rojo. |
| **RC Banderas** | Un cuadro con el color de la bandera vigente, leída de la memoria del propio juego. |
| **RC Largada** | Cinco luces: rojas parpadeando en la formación, verdes con el audio al verde. Durante la formación, debajo de las luces aparecen "VUELTA DE FORMACION" y el límite de velocidad configurado en el panel; si el piloto se pasa, "BAJA LA VELOCIDAD: N" con los segundos de gracia que le quedan. Con **VSC** (servidor 1.48): "VSC", su límite y la misma cuenta; al terminar, "VSC ENDING" y "Verde en N s". Mientras dure el VSC, RC Banderas muestra amarilla parpadeando. |
| **RC Alerta** | Un marco rojo pulsante, solo si falta la credencial. Ver "Si aparece el marco rojo". |

Son apps independientes a propósito: hasta la 0.7 era una sola ventana con todo apilado, así que
el piloto que solo quería ver las banderas tenía que aguantar el resto ocupando pantalla.

### Desde la 1.1 son overlays, no ventanas

No tienen fondo, ni borde, ni barra de título, ni ícono. En reposo no se ve **ninguna**: lo que no
está pasando no ocupa un pixel. Para moverlas o redimensionarlas, pasales el mouse por encima y el
marco reaparece.

Los colores de la bandera son los del juego: amarillo, azul, negro, blanco, el tablero de cuadros
de la final y un círculo naranja sobre negro para la de penalidad. Las dos últimas se dibujan
distinto porque un color plano no alcanza: la de penalidad es negra igual que la negra a secas, y
sin el círculo serían indistinguibles.

**El semáforo** arranca invisible. Cuando el admin aprieta "Iniciar formación" aparecen las cinco
luces parpadeando en rojo; al "Verde" pasan a verde y suena el audio; tres segundos después
desaparecen.

**Todas comparten los mismos hilos de fondo.** Cerrar una ventana —o no abrir ninguna— no apaga
el heartbeat ni el reporte de telemetría: solo deja de dibujar. Alcanza con tener la app instalada
y activada en Content Manager.

Los avisos de **RC Mensajes** se borran solos a los 25 segundos y se muestran como máximo tres a
la vez, los más nuevos abajo. El contador de cortes y la sanción pendiente **no** son avisos y no
se borran: están mientras sean ciertos.

### Desde la 1.3, la bandera verde ya no está siempre

Hasta la 1.2 **RC Banderas** mostraba un cuadro verde cada vez que no había ninguna bandera, con
el argumento de que "pista despejada" también es información. En pista resultó al revés: el verde
estaba el 95% de la carrera —incluida la vuelta de formación entera, donde significa lo contrario
de lo que pasa— así que no informaba nada.

Ahora:

- **Sin bandera, no se dibuja nada.** Igual que el semáforo.
- **El verde aparece solo cuando se da el verde**, los mismos 3 segundos que las luces.
- **La amarilla parpadea.** Es la única que pide levantar el pie ya mismo, y un cuadro quieto en
  visión periférica no se distingue del que ya estaba.

La pregunta que el verde fijo intentaba contestar —"¿se colgó la app?"— la contestan ahora el
renglón de estado de **RC Mensajes** y el marco de **RC Alerta**.

### El contador de cortes

`CUTS: 3/5` arriba de todo, en celeste (amarillo hasta la 1.10): cuántas vueltas invalidó el servidor por irse de pista y
cuántas hacen falta para la sanción. Se oculta en cero, así que después de una sanción —cuando la
cuenta se reinicia— desaparece hasta el corte siguiente.

Sube **en el instante del corte**, con una chicharra corta, sin esperar al servidor: el dato
autoritativo recién llega cuando el piloto cruza meta, hasta un minuto y medio más tarde. El
servidor corrige el número en el siguiente poll, así que si la app contó de más (o de menos) se
acomoda solo.

Debajo, en naranja, la sanción que falta cumplir y las vueltas de gracia que quedan. Esa línea
sigue al piloto aunque se reconecte y el servidor le dé otro número de auto.

### Qué versión tiene cada piloto

Desde la 1.11, debajo de "Buscando servidor de Race Control..." y de "Conectado a Race Control"
aparece `App del piloto 1.11`. La app también le manda la versión al servidor, y en el embed se ve
pasando el mouse por el punto verde de la columna App.

Si el servidor tiene anotada una versión más nueva que la del piloto, la app avisa una vez por
conexión, durante 30 segundos: "Hay una versión nueva de la app: reinstalá el .zip". Las apps
anteriores a la 1.11 no mandan la versión ni reciben el aviso: en el embed figuran como
"anterior a la 1.11".

### Si aparece el marco rojo

**RC Alerta** significa una sola cosa: la app está corriendo pero el servidor no la reconoce —se
perdió el mensaje de chat que trae la credencial, o venció (duran 24 h)—. Mientras tanto no llegan
avisos, no se reporta telemetría, y si el admin tiene activado "Exigir que todos la tengan" el
piloto va a ser desconectado.

**Se arregla volviendo a entrar al servidor.** El marco se apaga solo en cuanto la credencial
nueva funciona.

### La vuelta invalidada la avisa la app, no el servidor

Desde la 1.1, `VUELTA INVALIDADA` aparece **en el instante del corte**. Antes lo mandaba el
backend, que se entera recién cuando el piloto cruza meta: el aviso llegaba una vuelta tarde,
cuando ya la había manejado entera apretando para nada.

La app lo lee de `acsys.CS.LapInvalidated`, que es el propio juego diciendo que la vuelta en curso
ya no vale. No dice el número de vuelta —uno sabe en cuál está— y no aparece al salir de boxes,
aunque la out lap nazca invalidada.

Desde la 1.11 sale en **amarillo y dura 8 segundos**, no en rojo durante 25 como los avisos de
dirección de carrera: no es una sanción, y el corte ya queda anotado en el contador.

Esto es **solo el aviso al piloto**. El corte se sigue registrando en la bandeja de incidentes del
comisario exactamente igual que antes.

## Qué hace

- Descubre sola la dirección del backend (mensaje de chat interno que manda el servidor al
  conectarse). El piloto lo ve en el chat como una línea que empieza con `RACECONTROL_BACKEND:`:
  es normal, la app no tiene forma de ocultar un mensaje de chat. Que aparezca prueba que el
  servidor lo reconoció, no que la app esté andando.
- Muestra el estado del semáforo y reproduce el audio cuando se pone en verde.
- Muestra los avisos de dirección de carrera. Llegan por **dos** canales: la pizarra del servidor
  (`/api/client/poll`) y el chat del juego. Los dos y no uno porque el chat le llega al piloto
  aunque el token esté vencido o el backend caído, y es además lo único que ve quien no tiene la
  app. Un aviso que llega por los dos lados se muestra una sola vez.
- Avisa la vuelta invalidada por su cuenta, sin pasar por el servidor, en el momento del corte.
- Muestra la bandera de pista actual (leída directo de la Shared Memory del juego, no depende del
  servidor).
- Manda un heartbeat al backend cada 2 segundos. Si el admin dejó activado "Exigir que todos la
  tengan" (Reglas → App de los pilotos, que viene activado), el piloto que no la tenga es
  expulsado del servidor pasado el tiempo de espera — con dos avisos previos por el chat del
  servidor, a los 45 y a los 15 segundos del final.
- Reporta en ese mismo heartbeat la telemetría que el protocolo UDP de Assetto Corsa **no**
  transporta y que solo existe dentro del juego: tiempos por sector, compuesto, combustible,
  paradas en boxes y salidas de pista. Es lo que llena la torre de tiempos del panel; un piloto
  sin la app aparece ahí con guiones en esas columnas.
- Las ventanas son apps normales de Content Manager: el piloto las puede mover y redimensionar
  como cualquier otra, aunque desde la 1.1 el marco solo aparezca al pasarles el mouse por encima.

## Si no aparece en el menú del juego

Si la app está activada en Content Manager y aun así ninguna de las ventanas figura en la barra de
apps, buscá `RaceControlClient` en `Documentos\Assetto Corsa\logs\log.txt`:

- **`ERROR LOADING MODULE`**: el juego la encontró pero no pudo importarla. Hasta la 1.8 la causa
  era la falta de `_ctypes.pyd`/`_socket.pyd`, que la app tomaba prestados de otras apps
  instaladas (ver abajo). Desde la 1.9 los trae en `stdlib64/`: si pasa con la 1.9, revisá que esa
  carpeta haya quedado con sus cuatro `.pyd` después de instalar (un antivirus puede
  ponerlos en cuarentena).
- **No figura**: el juego ni la intentó cargar. Revisá `Documentos\Assetto Corsa\cfg\python.ini`:
  tiene que tener `[RACECONTROLCLIENT]` con `ACTIVE=1`. Se cambia desde CM (Configuración →
  Assetto Corsa → Apps), no a mano: CM reescribe ese archivo cada vez que arranca una sesión.

### Los `.pyd` de `stdlib64/` (desde la 1.9)

El Python 3.3 embebido de Assetto Corsa no trae las extensiones nativas de la stdlib. La app usa
cuatro: `_ctypes.pyd` (Shared Memory), `_socket.pyd` (red), `unicodedata.pyd` (la resolución DNS
la necesita) y `winsound.pyd` (audios). Hasta la 1.8 no los traía y funcionaba igual, pero solo
porque todas las apps de Python comparten un intérprete y alguna otra cargada antes —Helicorsa,
CrewChief— dejaba los suyos en `sys.path`. Un piloto que desinstaló esas apps se quedó sin Race
Control, sin que la app hubiera cambiado.

Salen del instalador oficial **Python 3.3.5 de 64 bits** de python.org (firmado por la Python
Software Foundation, licencia PSF): tienen que ser de esa versión exacta y de 64 bits, igual que
el `python33.dll` del juego. Para extraerlos sin instalar Python:

```
msiexec /a python-3.3.5.amd64.msi /qn TARGETDIR=C:\temp\py335
```

y copiar los cuatro desde `C:\temp\py335\DLLs\`. El empaquetador se niega a armar el `.zip` si
falta alguno.

Si aun así uno no carga, la app no desaparece: las ventanas salen igual, se pierde solo esa
función, y el renglón de estado de **RC Mensajes** dice "Falta un componente de la app".

## Qué protege el test `server/src/test/clientApp.test.ts`

Este archivo no lo compila nadie: corre dentro del Python **3.3** embebido de Assetto Corsa y la
primera vez que se ejecuta es en la PC de un piloto. Un error de sintaxis no da error — la app
simplemente no aparece en el menú del juego.

Por eso hay un test del lado del servidor que lee este `.py` y verifica cuatro cosas: que traiga sus `.pyd` y los cargue antes de importarlos,
que no use sintaxis posterior a 3.3 (f-strings, `:=`, `async`), que no importe nada fuera de la stdlib que
ese intérprete tiene, y que **toda** ventana creada con `ac.newApp` pase por `ocultarChrome`. Lo
último es para que una ventana agregada el año que viene no vuelva a salir como un recuadro negro
tapando el parabrisas.

## Empaquetado (lo hace quien publica Race Control, una vez por versión)

1. Conseguir/grabar `apps/python/RaceControlClient/sounds/green_green_green.wav` (un audio corto
   tipo "green green green", libre de derechos) — no se genera automáticamente.
2. Correr `node scripts/package-client.js` desde esta carpeta. Genera
   `release/RaceControlClient.zip`, listo para repartir a todos los pilotos de la liga.
3. Ese mismo .zip sirve para toda la liga/temporada — no hay que regenerarlo por piloto ni por
   servidor, porque no tiene ninguna IP adentro.

## Auto-discovery (cómo sabe a dónde reportar sin que nadie le diga nada)

Apenas el servidor de Assetto Corsa detecta que este piloto se conectó, el backend de Race
Control le manda (por el chat interno del juego, dirigido solo a ese auto) un mensaje con el
prefijo `RACECONTROL_BACKEND:`. La app ya está escuchando el chat y lo captura sola. Ver
`server/src/udp/announcer.ts`.

Desde la 0.4 ese mensaje lleva **dos** datos separados por `|`:

```
RACECONTROL_BACKEND:<dirección>|<token>
```

- La **dirección** puede traer un prefijo de ruta (`race-control.fly.dev/l/mi-liga`) además de la
  forma vieja `ip:puerto`. No hizo falta cambiar nada del ruteo para eso: la app ya armaba su URL
  como `http://` + lo que le digan + `/api/client/...`, y un prefijo entra ahí sin que se entere.
- El **token** es la credencial de ese piloto, y va en `Authorization: Bearer` en el poll y en el
  heartbeat. Dura 24 horas y cada vez que el piloto entra al servidor recibe uno nuevo.

El separador es `|` y no `:` porque la dirección ya trae dos puntos cuando lleva puerto.

### "Credencial vencida: volvé a entrar al servidor"

Es lo que muestra la app cuando el backend le contesta 401. Es literal: el piloto sale y vuelve a
entrar, el chat le manda un token nuevo y sigue andando.

Pasa si estuvo más de 24 h sin salir del servidor, o si el operador rotó la clave de la liga.

## Pendiente de verificar contra la API real de AC (ver docs/spike-protocolo.md)

- Nombre/firma exacta de `ac.addOnChatMessageListener` y `ac.getUserSteamID()`.
- Si `lastSectorTime` es acumulado desde el inicio de la vuelta (y los sectores salen por
  diferencia) o ya viene por sector. Se asume acumulado, con detección del otro caso y descarte de
  valores absurdos: ante la duda la columna del panel muestra un guion, nunca un número inventado.

Los offsets de Shared Memory ya **no** están en esta lista: las páginas `acpmf_physics` y
`acpmf_graphics` se declaran como structs completas de `ctypes` y los offsets los calcula él. El
offset de la bandera que había antes a mano (68) caía dentro del array `lastTime` — era un número
suelto, y un número suelto no hay forma de revisarlo.
