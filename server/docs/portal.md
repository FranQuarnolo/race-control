# Arquitectura del portal

Cómo está armado Race Control cuando corre como servicio multi-liga. Si buscás cómo operarlo
—crear una liga, desplegar, leer logs— eso está en [operacion.md](operacion.md). Si buscás qué
ataques resiste y cuáles no, en [seguridad.md](seguridad.md).

## El dibujo

```
                internet
                   │
        ┌──────────┴──────────┐
        │  80/443 (TCP)       │  30000-30009 (UDP, uno por liga)
        │                     │
        ▼                     ▼
┌───────────────────┐   ┌─────────────────────────────┐
│  portal/index.ts  │   │  servidores de Assetto Corsa│
│  (un proceso)     │   │  de cada liga               │
│                   │   └─────────────────────────────┘
│  · sesiones       │                 │
│  · membresías     │                 │ los datagramas entran directo
│  · supervisor     │                 │ al worker, sin pasar por el portal
└─────────┬─────────┘                 │
          │ proxy por loopback        │
          ▼                           ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │ worker liga A│  │ worker liga B│  │ worker liga C│
   │ 41000 panel  │  │ 41002 panel  │  │ 41004 panel  │
   │ 41001 pilotos│  │ 41003 pilotos│  │ 41005 pilotos│
   │ 30000 UDP    │  │ 30001 UDP    │  │ 30002 UDP    │
   └──────────────┘  └──────────────┘  └──────────────┘
```

Lo importante de ese dibujo: **el UDP no pasa por el portal**. Cada worker bindea su propio puerto
y recibe los datagramas de su servidor de Assetto Corsa directamente. El portal solo intermedia
HTTP.

## Por qué un proceso por liga

Se evaluó la alternativa —refactorizar el estado interno para que fuera multi-liga dentro de un
proceso— y perdió por dos motivos que deciden solos:

1. **Hay estado global por construcción.** El `StateTracker` está indexado por `carId`, que en
   Assetto Corsa es un número de 0 a 23 por servidor. El auto 7 de una liga y el auto 7 de otra son
   el mismo índice. También el circuito que se aprende y el tipo de sesión en curso.
2. **Un `uncaughtException` llamaba a `process.exit`.** En un proceso compartido, un bug de una
   liga mataría todas las carreras en curso a la vez.

El costo son unas decenas de MB por liga. Se paga.

## Las piezas

| Archivo | Qué hace |
|---|---|
| `portal/index.ts` | Entry. Crea la cuenta de operador si falta, levanta el HTTP, arranca el supervisor, maneja las señales |
| `portal/server.ts` | Todo el Express: sesiones, CSRF, API del portal, API del operador, ruteo a las ligas |
| `portal/supervisor.ts` | Forkea un worker por liga y lo mantiene vivo |
| `portal/store.ts` | Cuentas, ligas y membresías en un JSON atómico |
| `portal/auth.ts` | Hash de contraseñas, sesiones, frenos de login |
| `portal/proxy.ts` | Reenvío HTTP al worker, sin tocar el cuerpo del request |
| `portal/cli.ts` | Los mismos comandos del panel de operador, para cuando el portal está apagado |
| `worker/leagueWorker.ts` | Entry del hijo. Recibe su configuración por IPC y arma el motor |
| `worker/messages.ts` | El contrato de esa IPC |
| `core/raceControl.ts` | El motor de una liga, parametrizado |

## El motor no sabe que hay un portal

`createRaceControl(options)` arma todo el backend de **una** liga y recibe por argumento lo que
antes leía de módulo:

```ts
createRaceControl({
  config,                      // el AppConfig ya cargado
  dataDir,                     // config.json, logs/, tracks/, secrets/ cuelgan de acá
  ports,                       // los que le asignó el supervisor; los tests los omiten
  udpBindAddress,              // "fly-global-services" en Fly
  clientBase,                  // lo que se le anuncia al piloto por chat
})
```

No hay un parámetro de "modo": hay un solo camino de código. El motor no detecta la red, no abre
puertos en ningún router y no elige dónde escuchar — todo eso se lo dan hecho. El panel que sirve
tampoco ofrece editar puertos ni direcciones, porque los administra el portal.

El `stop()` que devuelve cierra los timers, el socket UDP, el journal y la captura cruda. Existe
porque sin él no se puede tener más de una instancia en un proceso, y eso es justo lo que los
tests necesitan para poder probar que dos ligas no se pisan (`test/core.test.ts`).

## Puertos

| Rango | Para qué | Expuesto |
|---|---|---|
| 80, 443 | El portal y todos los paneles | sí |
| 30000-30009 | UDP, uno por liga | sí |
| 41000+ | Panel y canal de pilotos de cada worker | **no**, solo loopback |

Los workers escuchan en `127.0.0.1` a propósito: un worker alcanzable desde afuera sería el panel
de una liga ajena abierto sin contraseña.

El rango UDP es chico y está declarado a mano en `fly.toml` (Fly no publica rangos). Por eso el
alta de ligas la hace el operador a mano: un formulario público lo agotaría el primer día.
`assignPorts`
tira un error explícito cuando se acaba.

## El ruteo

```
/                       → la landing pública: qué hace el producto, con capturas del panel
/login                  → formulario. Es la única puerta: no hay registro
/mis-ligas              → a dónde cae un admin después de entrar
/conectar/<slug>        → la pantalla de puesta en marcha de una liga
/operador               → el panel de quien vende el servicio
/api/portal/*           → la API del portal (sesión)
/api/operador/*         → la API del operador (sesión + rol `operador`)
/l/<slug>/api/client/*  → al worker, puerto de pilotos, SIN sesión
/l/<slug>/*             → al worker, puerto del panel, CON sesión y membresía
cualquier otra cosa     → 404
```

Es una allowlist: se enumera lo que pasa y el resto es 404.

`/api/operador/*` contesta **404 y no 403** a quien no tiene el rol. Para un admin común esa
sección directamente no existe, y no hay nada en el producto que insinúe que está ahí.

El canal de pilotos es el único que viaja sin sesión, porque lo consume la app dentro del juego,
que no puede tener una. No queda abierto: el worker exige ahí un token firmado. El portal lo deja
pasar y es el worker el que decide.

### Por qué rutas y no subdominios

Un subdominio por liga (`mi-liga.race-control.x`) hubiera dejado el panel intacto: cada liga
tendría su propio origen y todas las rutas absolutas del panel seguirían funcionando. Pero exige un
certificado wildcard, y eso exige un dominio propio. Con `*.fly.dev` no hay sub-subdominios.

El costo de ir por rutas fue que el panel tuvo que aprender a vivir bajo un prefijo: `BASE` en
`app.js` se deduce de la propia URL y se antepone a cada fetch y a cada navegación. El cliente
Python no necesitó ningún cambio de ruteo, porque ya armaba su URL como
`http://<lo que le digan>/api/client/...` y un prefijo entra ahí sin que se entere.

## El supervisor

- Forkea con `child_process.fork` y manda la configuración **por IPC**, no por argv: en argv
  quedaría visible en la lista de procesos de la máquina.
- Backoff creciente al caer: 1 s, 2 s, 4 s… tope 60 s.
- El contador de caídas se reinicia tras 5 minutos estable. Una caída aislada no es un bucle.
- Tras 5 caídas seguidas la liga queda en `failed` y **se deja de reintentar**. El estado se ve en
  el portal con el último error. Que alguien se entere es parte del diseño: reintentar para
  siempre quema la máquina y llena el disco.
- `EADDRINUSE` es `failed` directo: el puerto se lo asignó el portal, así que si está tomado es un
  error de configuración y no una caída.
- Una cuenta desactivada tiene sus ligas paradas. El supervisor no las levanta al arrancar y no
  las reintenta: no están caídas, están apagadas a propósito.

## Cuentas, roles y cuota

```
users:    { id, email, pwHash, role: "operador" | "admin", active,
            paidUntil, lastLoginAt, note, sessionsVersion, createdAt }
leagues:  { id, slug, name, udpPort, clientPort, adminPort, status, lastError, ownerId }
```

- **`role`** separa a quien vende el servicio de quien dirige una liga. La cuenta de operador no la
  crea nadie a mano: el portal la genera en el arranque si `RC_OPERATOR_EMAIL` está puesto y no
  existe todavía, e imprime la contraseña en el log una sola vez.
- **`active`** es el interruptor de la suscripción. En `false`, el supervisor **para el worker** de
  cada liga de esa cuenta y el login deja de andar. Los datos no se tocan: la carpeta con su
  configuración, sus sanciones y sus registros queda intacta, y reactivar vuelve a levantar todo.
- **`paidUntil`** es una fecha escrita a mano. No hay pasarela de pago ni cobro automático: el
  operador cobra por donde quiera y después anota hasta cuándo. `subscriptionOf()` deriva de esa
  fecha el estado que se ve en la tabla (`al-día`, `por-vencer` a 7 días, `vencido`, `sin-cuota`).
  **Vencido no desactiva solo**: dar de baja a alguien en medio de su campeonato tiene que ser una
  decisión, no un `setInterval`.

## El alta, de punta a punta

1. En `/operador`, "Dar de alta": nombre de la liga, email y —si querés— hasta cuándo pagó. La
   contraseña la genera el portal y **se muestra una sola vez**.
2. Le pasás esos tres datos al admin: la dirección, su email y esa contraseña.
3. Entra por `/login` y cae en la pantalla de conexión de su liga, que le muestra el `Send Address`
   ya armado y le pregunta al worker cada 2 segundos si llegó algo.
4. Cuando llega, se pone verde y lo manda al panel.

No se le pide la IP, ni puertos, ni el tipo de torneo. Eso arranca en *Campeonato* y se cambia
después desde Reglas, donde ya vive.

Lo mismo está en `portal/cli.ts`, para cuando el portal no está levantado. Los comandos que
escriben se niegan a correr con el portal vivo, y el motivo es concreto: el portal tiene todo
`portal.json` en memoria y lo reescribe entero cada vez que algo cambia, así que el primer guardado
después borraría lo que hubiera hecho el CLI. Se detecta con `portal.pid` + `process.kill(pid, 0)`.

## El estado en disco

```
/data/
  portal.json              cuentas, ligas y membresías (modo 0600)
  portal.pid               el PID del portal vivo, para que el CLI no escriba a la vez
  leagues/<id>/
    config.json            la configuración de esa liga
    secrets/pilot.key      32 bytes, la clave con la que firma los tokens de sus pilotos
    logs/
      events-*.jsonl       el journal: incidentes, sanciones, auditoría (90 días)
      raw.bin, raw-*.bin   captura cruda de datagramas (7 días los archivados)
    tracks/                los trazados aprendidos
```

Cada liga es una carpeta y nada más que una carpeta: no hay índice que mantener en sincronía ni
estado de carrera fuera de ahí. Mover una liga de una máquina a otra es copiar el directorio.

`portal.json` se escribe con `tmp` + `rename`, y si alguna vez queda ilegible se renombra a
`.corrupto-<timestamp>` en vez de pisarse. Ahí adentro están las cuentas de todas las ligas.

## Lo que no escala y se sabe

- **Una sola máquina.** Dos tendrían dos `portal.json` divergentes y dos juegos de workers. No
  escalar horizontalmente.
- **Una liga, un servidor de Assetto Corsa.** Es un supuesto. Si una liga corriera dos servidores a
  la vez, el `StateTracker` indexado por `carId` los mezclaría, y un proceso por liga no lo
  resuelve.
- **El portal no se cae por un error no controlado**, a diferencia de los workers: adentro suyo
  están las sesiones de todas las ligas. Registra y sigue.
