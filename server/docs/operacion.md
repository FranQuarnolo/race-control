# Manual de operación

Esto es para quien opera el servicio, no para el admin de una liga. Él no tiene que leer nada de
acá: entra por un link, elige una contraseña y pega un renglón.

Si querés entender cómo está armado, eso está en [portal.md](portal.md).

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
fly deploy
```

Si `RC_PUBLIC_IP` queda vacío, el portal arranca igual pero avisa en el log: no va a poder
mostrarle a nadie qué pegar.

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

## Crear una liga

```bash
fly ssh console
cd /app && node dist/portal/cli.js crear-liga --nombre "Fast Sim League" --email admin@liga.com
```

Imprime el `Send Address` que va a ver ese admin y un **link de invitación de un solo uso que vence
en 48 h**. Eso es lo único que hay que pasarle.

El slug sale del nombre (`Fast Sim League` → `fast-sim-league`). Para elegirlo a mano:
`--slug fsl`.

```bash
node dist/portal/cli.js ligas                              # qué hay y en qué estado
node dist/portal/cli.js invitar --slug fsl --email otro@liga.com   # sumar un comisario
```

## Alguien perdió la contraseña

No hay reseteo. Se le manda una invitación nueva a su misma liga y elige una contraseña propia:

```bash
node dist/portal/cli.js invitar --slug fsl --email admin@liga.com
```

Al aceptarla, la contraseña vieja deja de valer y **todas sus sesiones abiertas se cierran**. Es a
propósito: si alguien entró a la cuenta, cambiar la clave tiene que echarlo.

Nadie —vos tampoco— tipea nunca la contraseña de otro.

## Una liga no arranca

En el portal aparece "con problemas" y el último error al pasar el mouse por encima. En el log:

```bash
fly logs | grep "liga:"
```

Los dos casos frecuentes:

- **`EADDRINUSE`**: el puerto que el portal le asignó está tomado. No se reintenta, porque
  reintentar no lo arregla. Suele ser un worker zombi de un despliegue anterior: `fly apps restart`.
- **Cinco caídas seguidas**: la liga queda en `failed` y el supervisor deja de insistir. Hay que
  mirar el log para saber por qué y después reiniciar la app.

## Ampliar el rango de puertos UDP

Cada liga ocupa un puerto UDP de un rango declarado a mano. Cuando se acaba, `crear-liga` tira un
error explícito. Ampliarlo son **dos cambios, y hacen falta los dos**:

1. En `fly.toml`, subir `RC_UDP_TO` **y** agregar un bloque `[[services]]` por cada puerto nuevo.
   Sin el bloque, Fly no publica el puerto y la liga queda sorda sin decir nada.
2. `fly deploy`.

No hay forma de publicar un rango: Fly no reescribe el puerto de los datagramas UDP, así que cada
uno va declarado individualmente con `internal_port` igual al externo.

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
7. Corre al arrancar cada worker y una vez por día. En el `.exe` local no corre nunca: ahí el
historial es del admin.

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
export RC_DATA_ROOT=./datos RC_PUBLIC_HOST=localhost:8080 RC_PUBLIC_IP=127.0.0.1 RC_INSECURE_COOKIES=1
node dist/portal/cli.js crear-liga --nombre "Prueba" --email yo@ejemplo.com
PORT=8080 node dist/portal/index.js
```

`RC_INSECURE_COOKIES=1` desactiva el prefijo `__Host-`, la marca `Secure` y la redirección a
HTTPS, que sin certificado harían imposible entrar. **Nunca en producción.**

## Variables de entorno

| Variable | Default | Para qué |
|---|---|---|
| `PORT` | 8080 | Donde escucha el portal |
| `RC_DATA_ROOT` | `/data` | Raíz de datos |
| `RC_PUBLIC_HOST` | `localhost:8080` | Host público, sin esquema ni barra final |
| `RC_PUBLIC_IP` | *(vacío)* | La IPv4 dedicada. Es lo que el admin pega en su hosting |
| `RC_UDP_BIND` | *(ninguno)* | `fly-global-services` en Fly. Ver abajo |
| `RC_UDP_FROM` / `RC_UDP_TO` | 30000 / 30019 | Rango de puertos UDP |
| `RC_LOOPBACK_FROM` | 41000 | Desde dónde se asignan los puertos internos |
| `RC_INSECURE_COOKIES` | *(sin definir)* | `1` para desarrollo sin HTTPS |

Sobre `RC_UDP_BIND`: en Fly, un socket UDP tiene que bindear a `fly-global-services` y **no** a
`0.0.0.0`. Con `0.0.0.0`, Linux elige por su cuenta la dirección de origen de la respuesta y
contesta desde la equivocada, así que el servidor de Assetto Corsa nunca la ve y parece que Race
Control no está. Es un modo de fallo completamente silencioso.
