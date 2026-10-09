# Race Control — largada en movimiento + penalizaciones propias para Assetto Corsa

Sistema propio (sin depender de mods comerciales) para dos cosas:

1. **Largada en movimiento**: el admin aprieta un botón, se dispara el semáforo del juego y,
   desde ahí hasta el verde, se controla que nadie supere el límite de velocidad de formación.
2. **Penalizaciones en tiempo real durante la carrera**, al estilo "Real Penalty": exceso de
   velocidad en pit lane, cumplimiento de Drive-Through/Stop-and-Go, escalado a DQ o penalización
   de tiempo si no se cumple a tiempo.

Pensado para que el **admin** no necesite instalar nada técnico (Node, git) y el **piloto** no
necesite configurar absolutamente nada.

## Para el admin de la liga (uso en producción)

1. Descargá `RaceControlServer.exe` (lo genera `npm run package` en `server/`, ver más abajo) y
   ponelo en una carpeta cualquiera de tu PC — no hace falta instalar nada más.
2. Doble click. Se abre una ventana de consola (no la cierres mientras lo uses) y el panel se
   abre solo en tu navegador, en `http://localhost:3000`.
3. La primera vez te va a pedir solo el nombre de tu liga. Todo lo demás (puertos, IP pública,
   intento de abrir el puerto en tu router) se resuelve solo.
4. En la sección **"Red"** del panel vas a encontrar, ya armado, el texto para pegar en el panel
   de tu hosting (ej. EmperorServers). Ver **`server/docs/guia-emperorservers.html`** para el
   paso a paso de dónde pegarlo y por qué.
5. Repartí a tus pilotos el .zip del cliente (ver más abajo) — una sola vez, les sirve para toda
   la temporada.
6. Configurá en el panel las reglas de carrera (umbral de velocidad, tolerancia, vueltas de
   gracia, tipo de sanción) y la zona de pit lane de cada circuito.
7. **Las primeras carreras, dejá activado el "modo sombra"** (interruptor en el panel): el
   sistema detecta y registra todo, pero no aplica sanciones/kicks reales — así podés comparar
   contra tu propio criterio antes de confiar en la aplicación automática.
8. El día de carrera: abrís el .exe y usás los botones de "Iniciar formación" / "Verde" / "Reset".

No hace falta clonar este repositorio ni tener Node.js instalado para usarlo — eso solo hace
falta si vas a modificar el código (ver "Desarrollo" abajo).

## Para el piloto

1. Abrí Content Manager.
2. Arrastrá `RaceControlClient.zip` (te lo pasa el admin de tu liga) a la ventana de Content
   Manager, como instalarías cualquier mod de auto o pista.
3. Activá la app dentro del juego, en el menú de Apps (AC Apps): "Race Control".

Nada más. No hay ninguna IP que tipear ni archivo que editar — la app descubre sola a qué
servidor reportar apenas te conectás a la carrera. Vas a ver 3 avisos en pantalla: sanciones,
estado de la largada, y la bandera de pista actual.

## Estructura

```
race-control/
  server/       Backend Node.js/TypeScript — habla el protocolo UDP del servidor dedicado (ACSP),
                sirve el panel admin, y se empaqueta como RaceControlServer.exe
  client-app/   App Python de Content Manager (apps/python/RaceControlClient/), empaquetable como
                .zip instalable arrastrando a Content Manager
  shared/       Config de referencia (zona de pit lane por circuito)
```

## Desarrollo (si vas a tocar el código)

```
cd server
npm install
npm run build
npm start
```

Esto levanta el panel admin en `http://localhost:3000` (loopback) y los endpoints del cliente en
`http://localhost:3001` (el que se expone/forwardea), con un socket UDP local en el puerto que
diga `server/config.json` (se genera solo en el primer arranque).

Para generar el ejecutable distribuible:

```
cd server
npm run package
```

Deja todo listo en `server/release/` (`RaceControlServer.exe`, `LEEME.txt`, y una copia de
`server/docs/`).

Para armar el .zip del cliente (una vez que tengas el audio de largada en
`client-app/apps/python/RaceControlClient/sounds/green_green_green.wav`):

```
cd client-app
node scripts/package-client.js
```

Deja el resultado en `client-app/release/RaceControlClient.zip`.

## Red: por qué no hace falta tocar el router (la mayoría de las veces)

El backend necesita recibir la telemetría que el servidor de Assetto Corsa le manda. En vez de
pedirle al admin que configure manualmente el forwarding de su router, el sistema prueba en
cascada, automáticamente, al arrancar:

1. Aprovechar que el backend ya le manda un comando al servidor de AC — eso suele alcanzar para
   que la mayoría de los routers caseros dejen pasar la respuesta sin configuración manual.
2. Si no, intenta abrir el puerto solo vía UPnP.
3. Si tampoco, el panel te avisa con los pasos manuales (o te sugiere mudar el backend a una VPS
   barata, si tu proveedor de internet usa IP compartida/CGNAT).

El panel admin (loopback) nunca se expone a internet — solo el puerto que usan los pilotos para
reportar presencia y recibir el estado del semáforo.

## Estado de la implementación

- ✅ Protocolo UDP (parseo de telemetría + comandos admin), validado contra el ejemplo oficial de
  Kunos y dos implementaciones de referencia independientes — ver el encabezado de
  `server/src/udp/protocol.ts` y `server/docs/spike-protocolo.md` para lo que todavía conviene
  confirmar jugando una carrera de prueba real (ya no requiere Wireshark salvo que algo no cierre).
- ✅ Instancia 1 (largada en movimiento) y 2 (pit-speeding + cumplimiento de DT/SG) de punta a punta.
- ✅ Motor de detección endurecido: identidad de sanciones por piloto (sobrevive reconexiones),
  reloj monotónico y debounce ante pérdida de paquetes UDP, journal de eventos + captura cruda
  para auditoría, modo sombra.
- ✅ Empaquetado como `.exe` único (sin requerir Node instalado) con wizard de primer arranque.
- ✅ Red automática (sin forwarding manual en la mayoría de los casos) y puerto admin aislado.
- ✅ Cliente instalable arrastrando un .zip a Content Manager, sin configuración (auto-discovery
  por chat), con overlay de 3 avisos (sanciones, largada, bandera de pista).
- ⬜ Corte de pista genérico (track limits fuera de pit lane) — necesita splines por circuito,
  queda para una iteración futura.
- ⬜ Distinción de "box propio" en el Stop-and-Go (simplificación v1 aceptada: cualquier parada en
  pit lane cumple la sanción).
- ⬜ Modo de simulación completo con generador sintético e inyección de fallas — hoy solo existe
  el replay de capturas reales (`server/src/sim/replay.ts`).

Ver `CHANGELOG.md` para el detalle de cada cambio.

## Calibración por circuito

La zona de pit lane se define en el panel admin (sección "Reglas de pit lane") como un rango de
`normalizedSplinePosition` (0 a 1). La tabla de autos conectados muestra ese valor en vivo por
auto para poder calibrarlo manejando por pit lane — ver también `shared/tracks/example-pit-zone.json`
como referencia de formato (hoy es solo documentación; la carga real es vía el panel).

## Documentación adicional

- `server/docs/guia-emperorservers.html` — paso a paso para conectar con un hosting externo.
- `server/docs/spike-protocolo.md` — qué confirmar jugando una carrera de prueba real.
- `client-app/README.md` — instalación y empaquetado del cliente.
- `CHANGELOG.md` — historial de cambios y decisiones.
