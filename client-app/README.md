# Race Control Client (app de Content Manager)

## Instalación (una vez por piloto, cero configuración)

1. Abrir Content Manager.
2. Arrastrar `RaceControlClient.zip` (se lo pasa el admin de la liga, o se baja del release) a la
   ventana de Content Manager, como se instala cualquier mod de auto/pista.
3. Activar las ventanas dentro del juego: menú de Apps (AC Apps) → **RC Mensajes**, **RC Banderas**
   y **RC Largada**. Son tres entradas separadas y se activan las que uno quiera.
4. Acomodarlas en pantalla. Una sola vez, y mejor antes de la primera carrera.

No hay ningún archivo que editar ni ninguna IP que tipear: la app descubre sola a qué backend
reportar apenas el piloto se conecta al servidor (ver "Auto-discovery" abajo).

> **Si ya la tenías instalada de una versión anterior a la 1.1, hay que reinstalarla.** Arrastrá el
> `.zip` nuevo igual que la primera vez: pisa lo que había sin dejar restos. El `ui.json` dice la
> versión instalada, así que se puede verificar desde el listado de apps del juego.

## Las tres ventanas

| Ventana | Qué muestra |
|---|---|
| **RC Mensajes** | Los avisos de dirección de carrera —sanciones, vueltas invalidadas, sanciones anuladas— en rojo y en letra grande. Arriba, en gris chiquito, el estado de la conexión con Race Control. |
| **RC Banderas** | Un cuadro con el color de la bandera vigente, leída de la memoria del propio juego. |
| **RC Largada** | Cinco luces: rojas parpadeando en la formación, verdes con el audio al verde. |

Son tres apps independientes a propósito: hasta la 0.7 era una sola ventana con todo apilado, así
que el piloto que solo quería ver las banderas tenía que aguantar el resto ocupando pantalla.

### Desde la 1.1 son overlays, no ventanas

No tienen fondo, ni borde, ni barra de título, ni ícono. En reposo **RC Largada** no se ve en
absoluto y **RC Mensajes** queda vacía: lo que no está pasando no ocupa un pixel. Para moverlas o
redimensionarlas, pasales el mouse por encima y el marco reaparece.

La excepción es **RC Banderas**, que siempre muestra algo —verde cuando no hay bandera—. Es
deliberado: "pista despejada" también es información, y un cuadro que desaparece cuando no pasa
nada dejaría sin saber si no hay bandera o si la app se colgó.

Los colores son los del juego: verde (ninguna), amarillo, azul, negro, blanco, el tablero de
cuadros de la final y un círculo naranja sobre negro para la de penalidad. Las dos últimas se
dibujan distinto porque un color plano no alcanza: la de penalidad es negra igual que la negra a
secas, y sin el círculo serían indistinguibles.

**El semáforo** arranca invisible. Cuando el admin aprieta "Iniciar formación" aparecen las cinco
luces parpadeando en rojo; al "Verde" pasan a verde y suena el audio; tres segundos después
desaparecen.

**Las tres comparten los mismos hilos de fondo.** Cerrar una ventana —o no abrir ninguna— no apaga
el heartbeat ni el reporte de telemetría: solo deja de dibujar. Alcanza con tener la app instalada
y activada en Content Manager.

Los avisos de **RC Mensajes** se borran solos a los 25 segundos y se muestran como máximo tres a
la vez, los más nuevos abajo.

### La vuelta invalidada la avisa la app, no el servidor

Desde la 1.1, `VUELTA INVALIDADA` aparece **en el instante del corte**. Antes lo mandaba el
backend, que se entera recién cuando el piloto cruza meta: el aviso llegaba una vuelta tarde,
cuando ya la había manejado entera apretando para nada.

La app lo lee de `acsys.CS.LapInvalidated`, que es el propio juego diciendo que la vuelta en curso
ya no vale. No dice el número de vuelta —uno sabe en cuál está— y no aparece al salir de boxes,
aunque la out lap nazca invalidada.

Esto es **solo el aviso al piloto**. El corte se sigue registrando en la bandeja de incidentes del
comisario exactamente igual que antes.

## Qué hace

- Descubre sola la dirección del backend (mensaje de chat interno que manda el servidor al
  conectarse, invisible para el uso normal del piloto).
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
  expulsado del servidor pasado el tiempo de espera.
- Reporta en ese mismo heartbeat la telemetría que el protocolo UDP de Assetto Corsa **no**
  transporta y que solo existe dentro del juego: tiempos por sector, compuesto, combustible,
  paradas en boxes y salidas de pista. Es lo que llena la torre de tiempos del panel; un piloto
  sin la app aparece ahí con guiones en esas columnas.
- Las ventanas son apps normales de Content Manager: el piloto las puede mover y redimensionar
  como cualquier otra, aunque desde la 1.1 el marco solo aparezca al pasarles el mouse por encima.

## Qué protege el test `server/src/test/clientApp.test.ts`

Este archivo no lo compila nadie: corre dentro del Python **3.3** embebido de Assetto Corsa y la
primera vez que se ejecuta es en la PC de un piloto. Un error de sintaxis no da error — la app
simplemente no aparece en el menú del juego.

Por eso hay un test del lado del servidor que lee este `.py` y verifica tres cosas: que no use
sintaxis posterior a 3.3 (f-strings, `:=`, `async`), que no importe nada fuera de la stdlib que
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
