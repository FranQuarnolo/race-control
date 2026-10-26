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

**Actualización del 26/10/2026 — el plugin ya está configurado del lado del hosting.** El soporte de
EmperorServers configuró el plugin UDP a pedido, y la línea de log que mandaron resuelve dos cosas de
esta lista sin necesidad de capturar nada:

```
UDP Plugin Started: Listening on: 0.0.0.0:9811, sending to: 137.66.7.90:30000
```

- **El relay de ACSM no es un problema.** El plugin escucha y manda desde el mismo proceso, en el
  mismo host que el servidor de Assetto Corsa, así que la IP de origen que va a ver el worker es la
  del servidor. La fila "Si ACSM relaya los datagramas" queda resuelta.
- **El allowlist existe y ya está puesto**, con la IPv4 dedicada de la app como única IP autorizada
  a mandarle comandos al plugin. La fila "Lista de IPs permitidas" deja de ser un riesgo de arranque
  y pasa a ser un riesgo de mantenimiento: si esa IP cambia, hay que volver a pedir el cambio por
  ticket.
- **El puerto de origen sigue sin confirmarse.** Que escuche en `9811` hace *probable* que mande
  desde `9811` —es un solo socket— pero probable no es confirmado, y es justo el supuesto que la
  fila de abajo marca como el más importante. Se sabe en el primer paquete real.

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
| Reinicio a mitad de carrera | Con una sanción emitida, reiniciá el worker de esa liga (desactivar y reactivar la cuenta desde `/operador` alcanza) | Las sanciones e incidentes tienen que seguir ahí. Si no, revisar la lectura del journal en el arranque |
| Logos de marca | Mirá la columna "Auto" con una parrilla variada | Lo esperable es logo en las marcas conocidas y escudo con monograma en el resto. Un hueco vacío sí es un bug |
| **Puerto de origen del servidor** | Sin tocar ningún puerto a mano, "Órdenes hacia el servidor" tiene que dar **verde**, y en Conexión → Puertos el "Puerto del servidor de AC" tiene que mostrar el mismo número que el **Listen Address** del panel del hosting, con la leyenda "nos lo dijo tu servidor solo" | **Es el supuesto más importante de toda la puesta en marcha, y no está verificado.** Se asume que el acServer usa un solo socket para el plugin y entonces manda desde el mismo puerto en el que escucha. Si en realidad manda desde un puerto efímero, el panel va a mostrar un número raro (típicamente >32768) y va a aparecer el aviso de "nos habla desde un puerto distinto cada vez". En ese caso hay que sacar la adopción (`adoptRemotePortIfNeeded` en `udp/client.ts`) y volver a pedir el dato a mano |
| **Varios plugins a la vez** | Con Race Control agregado como listener adicional, lo que ya tenías (Real Penalty, sTracker, un bot) tiene que seguir funcionando | Confirmado en el changelog de Assetto Corsa Server Manager 2.4.8, no en pista. Si al agregar Race Control se cae el otro plugin, es que tu panel es anterior a esa versión y el campo es uno solo |
| **Lista de IPs permitidas** | Si tu panel tiene allowlist para el plugin UDP y tu IP no está, no llega **nada** y el síntoma es idéntico a no haber configurado el Send Address | Agregá tu IP pública a la lista. Es un modo de fallo totalmente silencioso: el servidor descarta los paquetes sin avisar |

## Lo que agregó la 0.4 y hay que confirmar en pista

La 0.4 movió el motor a un servidor público. Eso cierra algunos riesgos de la lista de arriba
—la IP ya no es dinámica, no hay router que abrir— y abre otros que **solo se ven contra un
servidor real**.

| Punto | Cómo confirmarlo | Si falla |
|---|---|---|
| **Que lleguen los datagramas a Fly** | Después de pegar el Send Address y reiniciar el servidor de AC, la pantalla de puesta en marcha tiene que ponerse verde sola | **Es el supuesto que sostiene todo el despliegue.** Lo más probable si no llega: falta la IPv4 dedicada (`fly ips allocate-v4`), o el puerto UDP de esa liga no está declarado en `fly.toml`. El síntoma de los dos es idéntico: silencio total |
| **`fly-global-services`** | Si la telemetría entra pero las sanciones, los kicks y el chat nunca llegan al piloto | Es exactamente el síntoma de haber bindeado a `0.0.0.0`: Linux contesta desde la dirección equivocada y el servidor de AC descarta la respuesta. Revisar `RC_UDP_BIND` |
| **Si ACSM relaya los datagramas** | Mirar qué IP de origen registra el worker contra la IP real del servidor de Assetto Corsa | Si el origen es el panel de ACSM y no el servidor, cualquier allowlist por IP bloquearía todo. Afecta a la lista de IPs permitidas del hosting, no a Race Control |
| **El header `Authorization` en Python 3.3** | Un piloto real entra al servidor y la app conecta sin mostrar "Credencial vencida" | Si `urllib.request` del intérprete embebido no manda el header tal cual, hay que pasar el token por la query string. Se probó contra el worker con `curl`, no con el Python de Assetto Corsa |
| **El anuncio por chat con el token** | El piloto entra y la app arranca sola, sin tipear nada | El mensaje ahora lleva `<dirección>|<token>` y es más largo. El límite del chat ACSP son 255 caracteres y entra holgado, pero si el token se cortara la app no conectaría nunca |
| **El panel bajo un prefijo de ruta** | Entrar a `/l/<liga>/`, recorrer las cuatro secciones y recargar en cada una | Si alguna pantalla pide un archivo de `/` en vez de `/l/<liga>/`, falta un lugar donde `BASE` no se está anteponiendo en `app.js` |
| **Memoria por liga** | `fly ssh console` → `ps aux` con 2 o 3 ligas corriendo | Las "decenas de MB por worker" son una estimación, nunca medida. Si cada uno come mucho más, hay que subir la memoria de la máquina en `fly.toml` o bajar el tope de ligas |

### Lo que la 0.4 sí dejó verificado, pero con datagramas simulados

No reemplaza la prueba en pista: confirma que el camino existe, no que el protocolo real encaja.

- El camino completo portal → worker → panel, con una liga creada por el CLI y aceptada por HTTP.
- La pantalla de puesta en marcha pasando a verde al recibir el primer datagrama en el puerto UDP
  de la liga.
- El canal de pilotos a través del proxy: sin token da 401, con token da 200, y con el guid de otro
  en el cuerpo da 403.

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
