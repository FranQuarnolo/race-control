# Race Control Client (app de Content Manager)

## Instalación (una vez por piloto, cero configuración)

1. Abrir Content Manager.
2. Arrastrar `RaceControlClient.zip` (se lo pasa el admin de la liga, o se baja del release) a la
   ventana de Content Manager, como se instala cualquier mod de auto/pista.
3. Activar la app dentro del juego: menú de Apps (AC Apps) → "Race Control".

No hay ningún archivo que editar ni ninguna IP que tipear: la app descubre sola a qué backend
reportar apenas el piloto se conecta al servidor (ver "Auto-discovery" abajo).

## Qué hace

- Descubre sola la dirección del backend (mensaje de chat interno que manda el servidor al
  conectarse, invisible para el uso normal del piloto).
- Muestra el estado del semáforo y reproduce el audio cuando se pone en verde.
- Muestra en un overlay separado los avisos de sanción (PENALIDAD) que le manda el servidor.
- Muestra en otro overlay la bandera de pista actual (leída directo de la Shared Memory del
  juego, no depende del servidor).
- Manda un heartbeat al backend cada 2 segundos. Si el admin dejó activado "Exigir que todos la
  tengan" (Reglas → App de los pilotos, que viene activado), el piloto que no la tenga es
  expulsado del servidor pasado el tiempo de espera.
- Reporta en ese mismo heartbeat la telemetría que el protocolo UDP de Assetto Corsa **no**
  transporta y que solo existe dentro del juego: tiempos por sector, compuesto, combustible,
  paradas en boxes y salidas de pista. Es lo que llena la torre de tiempos del panel; un piloto
  sin la app aparece ahí con guiones en esas columnas.
- La ventana es una app normal de Content Manager: el piloto la puede mover/redimensionar como
  cualquier otra.

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
