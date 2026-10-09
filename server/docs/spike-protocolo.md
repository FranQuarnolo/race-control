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
