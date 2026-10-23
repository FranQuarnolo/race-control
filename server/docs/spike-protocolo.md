# Spike de protocolo: validar `protocol.ts` contra un servidor real

**Actualización:** gran parte de este checklist ya no hace falta. Se encontró el **ejemplo
oficial de Kunos** del protocolo (`acRemoteServerUDP_Example`, un proyecto en C#, incluido como
referencia dentro del repo `joaoubaldo/acudpclient`), y se cruzó además contra dos
implementaciones comunitarias independientes (`joaoubaldo/acudpclient` en Python,
`flamescape/acsp` en Node.js). Las tres coinciden exactamente en opcodes, orden de campos y
tamaños — incluido un bug real que tenía nuestro código (los strings anchas como el nombre del
piloto, el GUID y los mensajes de chat se leían/escribían como UTF-16LE cuando en realidad son
UTF-32LE; ya está corregido en `protocol.ts`). Esto reemplaza la necesidad de confirmar esos
puntos con Wireshark — quedan confirmados por código, no por captura.

**Lo que SIGUE pendiente** (esto sí depende de observar un servidor real en funcionamiento, no de
leer código — ningún agente de IA puede resolverlo):

## Qué necesitás

- Un servidor dedicado de Assetto Corsa de prueba (puede ser en tu PC), con una pista cualquiera.
- Content Manager en 1-2 PCs (puede ser la misma PC con 2 perfiles, o un amigo de la liga).
- Wireshark es **opcional** ahora — solo hace falta si algo de la lista de abajo no se comporta
  como se espera y querés ver el tráfico crudo para entender por qué.

## Qué confirmar jugando una carrera de prueba (sin Wireshark)

| Punto | Cómo confirmarlo | Si falla |
|---|---|---|
| Velocidad | Compará el número que muestra el panel contra el velocímetro del juego, a ~80 y ~200 km/h | Si difiere mucho en subidas/bajadas, revisar el cálculo de velocidad en `protocol.ts` (hoy asume que la "Y" es el eje vertical) |
| Posición en pista | El panel no debería marcar a nadie "fuera de rango" andando normal | Revisar la validación de `normalizedSplinePosition` en `stateTracker.ts` |
| Nombre de piloto con tildes/ñ | Conectate con un nombre de Steam que tenga acentos y confirmá que se ve bien en el panel | Ya se probó en código (ver prueba de ida y vuelta en el historial de cambios), pero confirmar con el juego real nunca está de más |
| `driverGuid` | Mirá en los logs (`logs/events-*.jsonl`, evento `car.connected`) qué pinta tiene el GUID real | Si no son puramente números, ajustar `STEAM_GUID_PATTERN` en `server/src/api/clientApi.ts` |
| Vueltas de gracia | Completá una vuelta con una sanción pendiente y confirmá que el contador baja. Probá también si pasar por pit/la vuelta de formación hacen bajar el contador | Define si hace falta ajustar cuándo se descuenta la gracia en `penaltyEngine.ts` |
| Chat / sanciones | Confirmá que el mensaje de "PENALIDAD..." llega completo al piloto sancionado, sin cortarse | — |
| Kick | Provocá un kick (ej. dejando la app cliente cerrada) y confirmá que el piloto es desconectado | — |
| `/ballast` | Confirmá que ese comando existe en tu versión de servidor y que aplica el lastre | Ajustar el comando en `index.ts` si tu versión usa otra sintaxis |
| Varios autos a la vez | Jugá con 5-10 autos si podés conseguirlos | Si ves comportamiento raro con muchos autos, ahí sí conviene usar Wireshark para ver si se están perdiendo paquetes |

## Lo que agregó la 0.3 y hay que confirmar en pista

| Punto | Cómo confirmarlo | Si falla |
|---|---|---|
| Toque entre autos | Chocate a propósito con otro auto. En `/sanciones` tiene que aparecer **un solo** incidente con los dos pilotos, no dos | Si aparecen dos, la ventana de correlación (500 ms) quedó corta para tu latencia: `CONTACT_WINDOW_MS` en `incidentEngine.ts` |
| Geometría del toque | Embestí a alguien de atrás y mirá si dice "trompa contra cola" | Si sale al revés, el eje longitudinal de `rel_pos` tiene el signo invertido en `protocol.ts` |
| Antiflood | Trompeá contra el muro. Tiene que salir **un** incidente con un contador de impactos, no treinta | Subir la ventana de agrupación (3 s) |
| Reloj de la sesión | El "RESTAN" del mapa tiene que coincidir con el reloj del juego, ±2 s | Si arranca en `--:--` con una carrera por tiempo, revisar el orden de campos de `NEW_SESSION`: la duración viene **antes** de las vueltas y en minutos |
| Tiempos por sector | Con la app instalada, los tres sectores de la torre tienen que coincidir con los del juego | **Esto es lo más incierto de la 0.3.** Se asume que `lastSectorTime` es acumulado desde el inicio de la vuelta y los sectores son diferencias. Si los números salen absurdos, es al revés: ya viene por sector. Está en `RaceControlClient.py` |
| Límites de pista | Cortá una curva con las cuatro ruedas, tres veces | Si no cuenta, revisar `numberOfTyresOut` de la Shared Memory; si cuenta de más, subir `minDurationMs` |
| Telemetría inconsistente | No debería aparecer nunca con la app funcionando bien | Si aparece sola, la tolerancia (3 cortes acumulados) quedó corta para el desfasaje del heartbeat |
| Sanción del comisario | Sancioná un incidente desde la bandeja con "+10s" | El piloto tiene que recibir el chat, y la sanción tiene que aparecer en la tabla y en el informe |
| Informe de carrera | Descargalo al terminar y abrilo con Excel | Si los acentos salen rotos o todo cae en una columna, revisar el BOM y el separador en `raceReport.ts` |
| Reinicio a mitad de carrera | Cerrá el `.exe` con una sanción emitida y volvé a abrirlo | Las sanciones e incidentes tienen que seguir ahí. Si no, revisar la lectura del journal en el arranque |
| Logos de marca | Mirá la columna "Auto" con una parrilla variada | Lo esperable es logo en las marcas conocidas y escudo con monograma en el resto. Un hueco vacío sí es un bug |

## Si algo no cierra: ahí sí, Wireshark

1. Instalá [Wireshark](https://www.wireshark.org/) con Npcap (en Windows, tildar "Adapter for
   loopback traffic capture" si el backend corre en la misma PC que el servidor).
2. Filtrá por `udp.port == 11000 || udp.port == 12000` (ajustá a tus puertos reales) y capturá
   mientras reproducís el problema.
3. Guardá la captura como `spike.pcapng` y compará los bytes reales contra `protocol.ts` — el
   archivo tiene comentarios indicando qué representa cada campo.

## Al terminar

Anotá en este mismo archivo qué confirmaste (sobre todo el formato real de `driverGuid`), para
que quede de referencia para la próxima vez que cambie la versión del servidor.
