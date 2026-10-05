# Race Control — largada en movimiento + penalizaciones propias para Assetto Corsa

Ver el diseño completo y las decisiones tomadas en el plan:
`C:\Users\quarn\.claude\plans\es-muy-complicado-programar-joyful-creek.md`

## Estructura

```
race-control/
  server/       Backend Node.js/TypeScript — habla el protocolo UDP del servidor dedicado (ACSP)
  client-app/   App Python de Content Manager, obligatoria para cada piloto
  shared/       Config de referencia (zona de pit lane por circuito)
```

## Cómo correrlo (desarrollo/pruebas)

```
cd server
npm install
npm run build
npm start
```

Esto levanta el panel admin en `http://localhost:3000` y abre un socket UDP local (puerto configurable
en `server/config.json`, que se genera solo la primera vez que corrés `npm start`).

## Puesta en producción con un hosting externo (ej. EmperorServers)

1. Corré `race-control-server` en tu PC (con el puerto UDP forwardeado en el router) o en un VPS propio
   — **no** dentro del hosting del servidor de AC.
2. En el panel de tu hosting, editá `server_cfg.ini` y agregá/ajustá:
   ```
   UDP_PLUGIN_LOCAL_PORT=<el remotePort de tu config.json, el que escucha tu backend>
   UDP_PLUGIN_ADDRESS=<IP pública de tu PC o VPS>:<puerto local de tu backend, acUdp.localPort>
   ```
   (Confirmá los nombres exactos de estas claves en el panel/documentación de tu host — es el único
   paso específico de cada hosting que no se puede resolver desde acá.)
3. Repartí a los pilotos la carpeta `client-app/` (ver `client-app/README.md` para instalación).
4. El día de carrera: abrís `http://localhost:3000` (o la IP de tu VPS) y usás el botón de largada.

## Estado de la implementación

- ✅ Protocolo UDP (parseo de telemetría + comandos admin) — **sin validar aún contra un servidor real**,
  ver disclaimer en `server/src/udp/protocol.ts`. Antes de usar en una carrera real hay que hacer el
  "spike de protocolo" del plan: capturar paquetes con Wireshark y confirmar los campos.
- ✅ Instancia 1 (largada en movimiento) de punta a punta.
- ✅ Instancia 2 (pit-speeding en carrera + cumplimiento de DT/SG por vueltas de gracia).
- ✅ Kick automático si un piloto no tiene la app cliente corriendo (heartbeat).
- ⬜ Corte de pista genérico (track limits fuera de pit lane) — necesita splines por circuito,
  queda para una iteración futura según lo acordado en el plan.
- ⬜ Empaquetado del backend como ejecutable único (hoy requiere Node.js instalado para correrlo).

## Calibración por circuito

La zona de pit lane se define en `server/config.json` → `pit.zone` como un rango de
`normalizedSplinePosition` (0 a 1). El panel admin muestra ese valor en vivo por auto para poder
calibrarlo manejando por pit lane — ver `shared/tracks/example-pit-zone.json`.
