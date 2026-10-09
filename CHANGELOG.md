# Changelog

Todas las fechas en hora local (Argentina). Formato libre, pensado para trazabilidad de decisiones,
no solo de código — cada entrada explica el porqué, no solo el qué.

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
