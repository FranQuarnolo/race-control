# Modelo de amenazas

Qué protege Race Control, qué no, y qué queda explícitamente aceptado. La arquitectura está en
[portal.md](portal.md); la operación, en [operacion.md](operacion.md).

Hasta la 0.3 todo esto era innecesario: el panel vivía en `127.0.0.1` y para llegar a él había que
estar en la misma PC. Desde la 0.4 el mismo código atiende a ligas de terceros en un servidor
público.

## Quiénes son los actores

| Actor | Qué puede hacer legítimamente |
|---|---|
| **Operador** (vos) | Todo. Tiene acceso al servidor y al volumen |
| **Admin de liga** | Dirigir su liga: largadas, sanciones, kicks, reglas, informe |
| **Piloto** | Mandar su propia telemetría y presencia. Nada más |
| **Anónimo** | Ver la landing y pedir un login |

Y los que no son actores legítimos: alguien que conoce el slug de una liga ajena, alguien en la red
de un piloto, y un piloto que quiere sabotear a otro.

## Lo que sí está cubierto

### Una sesión válida no alcanza

Tiene que ser válida **para esa liga**. El portal verifica membresía en cada request a
`/l/<slug>/`, y el worker de cada liga es un proceso aparte que escucha solo en loopback. Un admin
de la liga A pidiendo la liga B recibe 403, no datos de nadie. Hay un test para eso
(`test/portal.test.ts`).

### Contraseñas

`scrypt` con N=2^15, r=8, p=1 y salt de 16 bytes. Comparación con `timingSafeEqual`. El formato
guardado es autodescriptivo (`scrypt$N$r$p$salt$hash`) para poder subir el costo más adelante sin
romper las cuentas existentes.

Cuando el email no existe se verifica igual contra un **hash señuelo**, para que el tiempo de
respuesta no delate qué cuentas hay. El señuelo se calcula al arrancar: si se calculara en el
primer login fallido, ese primer intento tardaría distinto y delataría justo lo que esconde.

### Frenos de login

- **Por IP**: 10 fallos en 15 minutos y queda bloqueada.
- **Por cuenta**: demora progresiva (1 s, 2 s, 4 s… tope 30 s), **nunca bloqueo**. Un bloqueo por
  cuenta permitiría dejar a un admin afuera de su propia liga a propósito, que es un ataque más
  fácil y más dañino que el que estaría previniendo.

La demora por cuenta se paga **antes** de contestar, para que no se pueda medir si la cuenta
existe.

### Sesiones

Cookie `__Host-rc_session`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, sin `Domain`. El
prefijo `__Host-` es la variante que un subdominio comprometido no puede sobrescribir.

El token es aleatorio de 32 bytes y en memoria se guarda **hasheado**. Vence a las 2 h de
inactividad y a las 12 h absolutas. Cambiar la contraseña incrementa `sessionsVersion` e invalida
todas de golpe: si el motivo del cambio es "alguien entró a mi cuenta", no sirve de nada si el
intruso sigue adentro.

### CSRF

Tres defensas, no una, porque cada una falla distinto:

1. Cookie `SameSite=Strict` — no la respetan los navegadores viejos.
2. Header `X-RC-Request: 1` obligatorio en todo POST — un `<form>` cruzado no puede agregar
   headers, pero un `fetch` con CORS mal configurado sí.
3. Chequeo de `Origin` — no llega en algunos clientes.

### Lo que el panel no puede tocar en modo portal

`POST /api/config` filtra puertos, binds y direcciones (`stripManagedFields`). Los administra el
portal. El panel además esconde esos formularios, en vez de ofrecer un "Guardar" que no guarda.

### Auditoría con nombre

El portal inyecta `X-RC-User` con el email de quien pidió, y **lo borra si viene de afuera**. Sin
eso, cualquiera firmaría sus acciones con el nombre de otro y la auditoría dejaría de servir justo
para lo que existe. En una liga con varios comisarios, el journal tiene que poder decir quién
kickeó a quién.

### El canal de pilotos

Cada liga firma los tokens de sus pilotos con su propia clave de 32 bytes:

```
token = <kid>.<steamGuid>.<vencimiento>.<firma>
firma = HMAC-SHA256(clave[kid], "rc1|" + steamGuid + "|" + vencimiento)
```

De ahí salen tres propiedades, y hay un test para cada una:

- El `steamGuid` va **dentro** de la firma: un piloto no puede usar su token para hacerse pasar por
  otro.
- Cada liga tiene su clave: el token de la liga A es ruido en la B.
- El `kid` permite rotar la clave con solape, sin dejar a nadie afuera en medio de una carrera.

Vence a las 24 h. La clave se guarda en `secrets/pilot.key` con modo 0600 y **nunca sale del
servidor**. La autenticación corre **antes** del parser de JSON: parsear primero significaría
procesar 10 KB de cuerpo de cualquiera que descubra el puerto.

El freno por IP de ese canal cuenta **solo los fallos de autenticación**, no el volumen: varios
pilotos pueden compartir una salida a internet (una LAN party, el CGNAT de un proveedor) y limitar
por requests los echaría a todos.

### Inyecciones

- **Prototype pollution**: `mergeConfigInto` rechaza `__proto__`, `constructor` y `prototype`. Hay
  un test que verifica que `Object.prototype` queda intacto.
- **Fórmulas en el CSV**: las celdas que empiezan con `= + - @` se prefijan con comilla simple. Un
  piloto con un nombre armado a propósito podía meter una fórmula en el Excel del comisario.
- **XSS**: todo texto ajeno se inserta con `textContent`, nunca con `innerHTML`. Más una CSP con
  `script-src 'self'` y `frame-ancestors 'none'`.
- **Path traversal en el slug**: `/^[a-z0-9][a-z0-9-]{1,39}$/`, y lo que no matchea es 404.

## Lo que NO está cubierto, y se acepta

### El token del piloto viaja en claro

Es la decisión más incómoda de esta versión y no hay forma de evitarla hoy.

La app del piloto corre en el **Python 3.3 embebido de Assetto Corsa**. Ahí
`ssl.create_default_context` no existe (llegó en 3.4), la verificación de certificados por defecto
tampoco (3.4.3), no lee el almacén de certificados de Windows, y ni siquiera está confirmado que el
intérprete traiga el módulo `ssl`. Ese canal no puede ir por HTTPS, punto.

Entonces `/l/<liga>/api/client/*` es el único recorrido que queda exento de la redirección a HTTPS.

**Consecuencia concreta:** quien esté en la red de un piloto puede capturar su token y, durante
24 h, falsificar la presencia y la telemetría **de ese piloto**. No da acceso al panel, ni a otra
liga, ni a los datos de nadie más.

Si alguna vez se confirma que el intérprete trae `ssl`, se puede agregar HTTPS con la huella del
certificado entregada por el mismo chat. Queda anotado, no planificado.

### La telemetría del cliente nunca es autoritativa

Ningún esquema de autenticación arregla esto: el piloto es dueño de su PC y la app es un `.py`
editable. Puede mandar lo que quiera en nombre propio.

Por eso **los límites de pista que reporta la app se contrastan contra los `cuts` que cuenta el
servidor de Assetto Corsa**, que es el que no miente. Y por eso el ping que muestra el panel se
filtra por plausibilidad antes de mostrarse: es un dato informativo, no una fuente de verdad.

La regla general: todo lo que decide una sanción sale del servidor. Lo que sale del cliente es
contexto.

### El operador ve todo

Quien tiene acceso al servidor ve los nombres, los SteamID64 y los incidentes de todas las ligas, y
puede leer las claves de tokens de todas. No hay cifrado en reposo ni separación de privilegios
entre ligas: todos los workers corren con el mismo usuario.

Es un servicio operado por una persona para ligas conocidas, y está dicho acá para que nadie
suponga otra cosa.

### Un `uncaughtException` del portal no lo tumba

Se registra y sigue. Adentro suyo están las sesiones de todas las ligas y cortarlo por un bug de
una ruta es el peor cambio posible. La contrapartida es que puede quedar en un estado raro sin que
nadie se entere. Los workers sí mueren y reinician, porque ahí morir es barato.

### No hay 2FA, ni verificación de email, ni recuperación automática

El alta es por invitación tuya y las ligas son conocidas. Agregar email transaccional es otra
pieza para operar. La recuperación es manual: una invitación nueva.

## Datos personales

Los `events-*.jsonl` guardan nombres y SteamID64 en texto plano.

| Dato | Dónde | Retención |
|---|---|---|
| Nombres, SteamID64, incidentes, sanciones | `events-*.jsonl` | 90 días |
| Paquetes UDP crudos | `raw-*.bin` archivados | 7 días |
| Email y hash de cuentas | `portal.json` | mientras exista la cuenta |
| Acciones del panel con su autor | `events-*.jsonl` (`audit.action`) | 90 días |
| Tokens de piloto | solo en memoria | nunca en disco ni en logs |

La retención corre **solo en modo portal**. En el `.exe` no se borra nada: ahí el disco es del
admin y los datos son de su propia liga.

Pendientes reconocidos: no hay un comando para borrar a un piloto a pedido, ni un aviso de
privacidad en la landing ni en el texto de invitación. Régimen aplicable: Ley 25.326. Esto no es
asesoramiento legal.

## Si encontrás algo

Abrí un issue en el repositorio. Si es algo que no conviene publicar, escribime directo.
