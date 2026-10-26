# Manual de operación

Esto es para quien opera el servicio, no para el admin de una liga. Él no tiene que leer nada de
acá: entra con un usuario y una contraseña, y pega un renglón.

Si nunca desplegaste esto, empezá por [PUESTA-EN-MARCHA.md](../../PUESTA-EN-MARCHA.md), que va
desde cero. Si querés entender cómo está armado, eso está en [portal.md](portal.md).

## Desplegar por primera vez

```bash
cd server
fly launch --no-deploy        # crea la app; decí que NO al Postgres y al Redis
fly volumes create rc_data --size 3 --region gru
fly ips allocate-v4           # SIN esto el UDP no llega. No es opcional.
```

El `allocate-v4` imprime una IPv4. **Esa IP es el dato que ve cada admin** para pegar en el
"Send Address" de su hosting, así que hay que dársela al portal:

```bash
fly secrets set RC_PUBLIC_IP=<la ipv4 que haya salido>
fly secrets set RC_OPERATOR_EMAIL=vos@ejemplo.com
fly secrets set RC_CONTACT=mailto:vos@ejemplo.com
fly deploy
```

Si `RC_PUBLIC_IP` queda vacío, el portal arranca igual pero avisa en el log: no va a poder
mostrarle a nadie qué pegar.

`RC_CONTACT` es **a dónde te escriben cuando algo no se puede resolver desde el panel**. Aparece en
seis pantallas: la recuperación de contraseña, el alta de liga, la cuenta desactivada, el cierre de
la landing y dos chequeos del diagnóstico. Acepta `mailto:`, `https:` y `http:` —un link de Discord
o de Telegram sirve igual que un mail— y rechaza cualquier otro esquema.

Sin configurar no es fatal: cada pantalla cae a "pedísela a quien te dio el acceso", que sigue
siendo verdad. Pero el botón principal de la landing no aparece y la pantalla de ingreso deja de
ofrecer recuperación de contraseña, así que el portal lo avisa en el log del arranque.

`RC_OPERATOR_EMAIL` crea tu cuenta en el primer arranque y **escribe la contraseña en el log una
sola vez**. Hay que ir a buscarla ahí:

```bash
fly logs | grep -A3 "Cuenta de operador creada"
```

Guardala donde guardes tus contraseñas. No se vuelve a mostrar, y si se pierde hay que parar el
portal y usar el CLI. Se puede fijar de antemano con `RC_OPERATOR_PASSWORD`, que evita el paso del
log pero deja la contraseña guardada en los secrets de Fly.

### Comprobar que quedó bien

```bash
fly logs                      # tiene que decir "escuchando en :8080"
fly ips list                  # tiene que haber una v4 de tipo "dedicated"
curl -I https://race-control.fly.dev/
```

Y la prueba que de verdad importa, porque el HTTP puede andar perfecto con el UDP roto:

```bash
# desde cualquier máquina, contra el puerto de una liga ya creada
printf 'x' | nc -u -w1 <la-ipv4> 30000
fly logs                      # el worker de esa liga tiene que registrar que entró algo
```

## El día a día: el panel de operador

Entrá a `https://race-control.fly.dev/login` con tu cuenta de operador y vas a caer en
**`/operador`**. Todo lo de abajo se hace desde ahí.

Arriba hay cuatro números: ligas activas, cuántas tienen la cuota vencida, cuántas vencen esta
semana y **cuántos lugares libres quedan** — ese último es el cupo de puertos UDP, y conviene
mirarlo antes de prometerle una liga a alguien.

| Qué | Cómo |
|---|---|
| Dar de alta una liga y su admin | "Dar de alta una liga". Pide nombre, email y, opcional, hasta cuándo pagó. Devuelve la contraseña **una sola vez**, con un botón para copiar los tres datos juntos |
| Corregir el nombre, la dirección, el email o la contraseña | "Editar" — ver abajo |
| Ver quién entró y cuándo | La columna "Último ingreso" |
| Marcar que pagó | "Cobré": suma un mes desde donde venía, o desde hoy si estaba vencida |
| Cortarle el acceso | "Desactivar". Para sus ligas y le cierra el paso al panel |
| Contraseña nueva | "Clave nueva" |
| Entrar al panel de esa liga | El nombre de la liga es un enlace a `/l/<slug>/` |

La tabla viene ordenada por lo que requiere atención: primero lo vencido, después lo que vence en
menos de 7 días, después el resto, y al final lo desactivado.

**Nada vence solo.** Una cuota vencida se pinta en rojo y no hace nada más: dar de baja a alguien
en medio de su campeonato es una decisión tuya, no de un timer.

**Desactivar no borra nada.** Para el worker de cada liga de esa cuenta y deja la carpeta entera
—configuración, sanciones, registros, trazados— donde estaba. Reactivar la vuelve a levantar con
todo adentro. Y una liga de cuenta desactivada **no vuelve sola en un redeploy**: si volviera,
reiniciar el servidor sería la forma de saltearse la baja.

## Editar una liga o su cuenta

El botón **"Editar"** de cada fila abre los cuatro datos que se pueden corregir sin tocar el
volumen por SSH. Se manda solo lo que cambiaste: lo que dejes igual, queda igual.

| Campo | Qué pasa al guardarlo |
|---|---|
| Nombre de la liga | **Reinicia el motor de esa liga.** Son unos segundos sin escuchar telemetría. No lo hagas en mitad de una carrera |
| Dirección (`slug`) | Cambia la URL del panel y la de los pilotos. **El link anterior deja de funcionar**: avisale al admin antes |
| Email del admin | Es con lo que entra. Las sesiones abiertas siguen valiendo; lo que cambia es el login |
| Contraseña nueva | Opcional. Vacío = no se toca. Mínimo 8 caracteres, y al cambiarla **se cierran sus sesiones** |

Lo que el formulario no deja hacer, a propósito: mudar una liga a una dirección que ya ocupa otra,
y ponerle a una cuenta el email de otra. Las dos cosas romperían algo en silencio —un `/l/<slug>/`
ambiguo, un login que elige una de dos cuentas sin criterio— así que cortan con un error.

**El nombre lo manda el portal, siempre.** El worker lo copia a su `config.json` cada vez que
arranca, y por eso hay que reiniciarlo para que el cambio se vea arriba a la izquierda en el panel.
Del lado del admin ese campo es de solo lectura: si pudiera editarlo, su cambio duraría hasta el
próximo reinicio y después volvería solo.

Una liga de una cuenta desactivada **no se enciende por renombrarla**: el reinicio solo ocurre si
estaba corriendo.

## El CLI: lo mismo, con el portal apagado

`portal/cli.ts` hace exactamente lo que el panel, para cuando el panel no se puede abrir (perdiste
la contraseña de operador, o algo no arranca):

```bash
fly machines stop <id>        # imprescindible, ver abajo
fly ssh console
cd /app
node dist/portal/cli.js ligas                                        # lectura, siempre disponible
node dist/portal/cli.js crear-liga --nombre "Fast Sim" --email admin@liga.com
node dist/portal/cli.js clave --email admin@liga.com
node dist/portal/cli.js baja  --email admin@liga.com
node dist/portal/cli.js alta  --email admin@liga.com --pago 2026-12-31
```

Los comandos que escriben **se niegan a correr con el portal vivo** y te dicen que lo hagas desde
`/operador`. No es prudencia excesiva: el portal tiene todo `portal.json` en memoria y lo reescribe
entero cada vez que algo cambia, así que su primer guardado borraría el cambio del CLI sin que
nadie se entere. Lo detecta con el `portal.pid` del volumen.

El slug sale del nombre (`Fast Sim League` → `fast-sim-league`). Para elegirlo a mano: `--slug fsl`.

## Alguien perdió la contraseña

Desde `/operador` → el admin → "Generar contraseña". Sale una nueva, se la pasás, y **todas sus
sesiones abiertas se cierran**. Es a propósito: si alguien entró a la cuenta, cambiar la clave
tiene que echarlo.

Nadie —vos tampoco— tipea nunca la contraseña de otro. El campo para elegirla a mano existe, pero
lo normal es dejar que la genere el portal.

## Una liga no arranca

En `/operador` aparece con su estado y el último error. En el log:

```bash
fly logs | grep "liga:"
```

Los dos casos frecuentes:

- **`EADDRINUSE`**: el puerto que el portal le asignó está tomado. No se reintenta, porque
  reintentar no lo arregla. Suele ser un worker zombi de un despliegue anterior: `fly apps restart`.
- **Cinco caídas seguidas**: la liga queda en `failed` y el supervisor deja de insistir. Hay que
  mirar el log para saber por qué y después reiniciar la app.

## Ampliar el rango de puertos UDP

Cada liga ocupa un puerto UDP de un rango declarado a mano. Cuando se acaba, el alta falla con un
error explícito. Ampliarlo son **dos cambios, y hacen falta los dos**:

1. En `fly.toml`, subir `RC_UDP_TO` **y** agregar un bloque `[[services]]` por cada puerto nuevo.
   Sin el bloque, Fly no publica el puerto y la liga queda sorda sin decir nada.
2. `fly deploy`.

No hay forma de publicar un rango: Fly no reescribe el puerto de los datagramas UDP, así que cada
uno va declarado individualmente con `internal_port` igual al externo.

El panel de operador muestra cuántos puertos quedan libres, justamente para que esto no te agarre
de sorpresa un viernes a la noche.

## Logs y datos

Todo cuelga del volumen en `/data`:

```bash
fly ssh console
ls /data/leagues/                                  # una carpeta por liga
tail -f /data/leagues/<id>/logs/events-*.jsonl     # el journal en vivo
```

El journal (`events-*.jsonl`) es un JSON por línea y es la respuesta a "¿por qué se sancionó a este
piloto?". Ahí adentro también están las acciones del panel con el email de quien las hizo
(`audit.action`).

**Retención**: los `events-*.jsonl` se borran a los 90 días y las capturas crudas archivadas a los
7. Corre al arrancar cada worker y una vez por día.

## Backup y restauración

Los snapshots del volumen son automáticos y se guardan 14 días (`scheduled_snapshots` en
`fly.toml`).

```bash
fly volumes snapshots list <volume-id>
fly volumes snapshots create <volume-id>        # uno a mano, antes de algo riesgoso
```

Para restaurar se crea un volumen nuevo desde el snapshot y se reemplaza el de la máquina:

```bash
fly volumes create rc_data --snapshot-id <snapshot-id> --size 3 --region gru
```

Para bajar una copia sin pasar por snapshots: `fly ssh sftp get /data/portal.json`. Ese archivo
solo tiene las cuentas y las ligas; los datos de carrera están en `leagues/`.

## Rotar la clave de tokens de una liga

Cada liga firma los tokens de sus pilotos con `/data/leagues/<id>/secrets/pilot.key`. Si hiciera
falta cambiarla:

```bash
fly ssh console
rm /data/leagues/<id>/secrets/pilot.key
fly apps restart
```

Se genera una nueva sola. **Los tokens viejos dejan de valer en el acto**, así que los pilotos que
estén conectados van a ver "Credencial vencida" hasta que salgan y vuelvan a entrar al servidor.
No hacerlo en medio de una carrera.

## Correr el portal en la máquina propia

Para desarrollar o para probar algo sin desplegar:

```bash
cd server && npm run build
export RC_DATA_ROOT=./datos RC_PUBLIC_HOST=localhost:8080 RC_PUBLIC_IP=127.0.0.1 \
       RC_INSECURE_COOKIES=1 RC_OPERATOR_EMAIL=yo@ejemplo.com \
       RC_CONTACT=mailto:yo@ejemplo.com
PORT=8080 node dist/portal/index.js
```

La contraseña de operador sale en la consola del primer arranque. Después, `/operador` en el
navegador y todo lo demás es igual que en producción.

`RC_INSECURE_COOKIES=1` desactiva el prefijo `__Host-`, la marca `Secure` y la redirección a
HTTPS, que sin certificado harían imposible entrar. **Nunca en producción.**

Para ver el panel con una carrera adentro sin tener un servidor de Assetto Corsa:

```bash
node dist/sim/demo.js      # http://127.0.0.1:3900 — es de donde salen las capturas de la landing
```

## Variables de entorno

| Variable | Default | Para qué |
|---|---|---|
| `PORT` | 8080 | Donde escucha el portal |
| `RC_DATA_ROOT` | `/data` | Raíz de datos |
| `RC_PUBLIC_HOST` | `localhost:8080` | Host público, sin esquema ni barra final |
| `RC_PUBLIC_IP` | *(vacío)* | La IPv4 dedicada. Es lo que el admin pega en su hosting |
| `RC_OPERATOR_EMAIL` | *(sin definir)* | Crea tu cuenta de operador en el arranque si no existe |
| `RC_OPERATOR_PASSWORD` | *(sin definir)* | Fija esa contraseña en vez de generarla y loguearla |
| `RC_CONTACT` | *(vacío)* | A dónde te escriben. `mailto:`, `https:` o `http:`; otro esquema se ignora |
| `RC_UDP_BIND` | *(ninguno)* | `fly-global-services` en Fly. Ver abajo |
| `RC_UDP_FROM` / `RC_UDP_TO` | 30000 / 30019 | Rango de puertos UDP. En `fly.toml` va hasta 30009 |
| `RC_LOOPBACK_FROM` | 41000 | Desde dónde se asignan los puertos internos |
| `RC_INSECURE_COOKIES` | *(sin definir)* | `1` para desarrollo sin HTTPS |

Sobre `RC_UDP_BIND`: en Fly, un socket UDP tiene que bindear a `fly-global-services` y **no** a
`0.0.0.0`. Con `0.0.0.0`, Linux elige por su cuenta la dirección de origen de la respuesta y
contesta desde la equivocada, así que el servidor de Assetto Corsa nunca la ve y parece que Race
Control no está. Es un modo de fallo completamente silencioso.
