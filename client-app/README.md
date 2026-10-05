# Race Control Client (app de Content Manager)

## Instalación (una vez por piloto)

1. Copiar toda esta carpeta (`RaceControlClient.py` + `sounds/`) dentro de:
   `...\assettocorsa\apps\python\RaceControlClient\`
2. Abrir Content Manager → Settings → General → Python Apps y asegurarse de que esté habilitado.
3. Dentro del juego, abrir el menú de Apps (AC Apps) y activar "Race Control".
4. Editar `BACKEND_URL` en `RaceControlClient.py` con la IP:puerto que te pase el admin de la liga (una sola vez).

## Audio

Falta agregar el archivo `sounds/green_green_green.wav` (no se genera automáticamente) —
el admin de la liga tiene que grabar/conseguir el audio y ponerlo en esa carpeta antes de distribuir
el .zip a los pilotos.

## Qué hace

- Muestra el estado del semáforo y reproduce el audio cuando se pone en verde.
- Muestra en overlay los mensajes de penalización que le manda el servidor.
- Manda un heartbeat al backend cada 5 segundos — si no lo hace, el sistema puede kickear al piloto
  del servidor (la app no es opcional).

## Pendiente de verificar contra la API real de AC (ver plan)

- Nombre/firma exacta de `ac.addOnChatMessageListener` y `ac.getUserSteamID()`.
- Si hace falta, migrar la detección de corte de pista (futuro) a lectura de Shared Memory
  (`numberOfTyresOut`) — no implementado todavía, solo documentado como iteración futura en el plan.
