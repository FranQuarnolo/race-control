# Race Control Client (app de Content Manager)

## Instalación (una vez por piloto, cero configuración)

1. Abrir Content Manager.
2. Arrastrar `RaceControlClient.zip` (lo arma el admin de la liga, ver "Empaquetado" abajo) a la
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
- Manda un heartbeat al backend cada 5 segundos — si no lo hace, el sistema puede kickear al
  piloto del servidor (la app no es opcional).
- La ventana es una app normal de Content Manager: el piloto la puede mover/redimensionar como
  cualquier otra.

## Empaquetado (lo hace el admin de la liga, una vez)

1. Conseguir/grabar `apps/python/RaceControlClient/sounds/green_green_green.wav` (un audio corto
   tipo "green green green", libre de derechos) — no se genera automáticamente.
2. Correr `node scripts/package-client.js` desde esta carpeta. Genera
   `release/RaceControlClient.zip`, listo para repartir a todos los pilotos de la liga.
3. Ese mismo .zip sirve para toda la liga/temporada — no hay que regenerarlo por piloto ni por
   servidor, porque no tiene ninguna IP adentro.

## Auto-discovery (cómo sabe a dónde reportar sin que nadie le diga nada)

Apenas el servidor de Assetto Corsa detecta que este piloto se conectó, el backend de Race
Control le manda (por el chat interno del juego, dirigido solo a ese auto) un mensaje con el
prefijo `RACECONTROL_BACKEND:<ip>:<puerto>`. La app ya está escuchando el chat y lo captura sola.
Ver `server/src/udp/announcer.ts`.

## Pendiente de verificar contra la API real de AC (ver docs/spike-protocolo.md)

- Nombre/firma exacta de `ac.addOnChatMessageListener` y `ac.getUserSteamID()`.
- Offset exacto del campo `flag` dentro de la Shared Memory (`Local\acpmf_graphics`) que usa el
  overlay de bandera de pista — tomado de referencias comunitarias, no confirmado todavía.
- Si hace falta, migrar la detección de corte de pista (futuro) a lectura de Shared Memory
  (`numberOfTyresOut`) — no implementado todavía, solo documentado como iteración futura en el plan.
