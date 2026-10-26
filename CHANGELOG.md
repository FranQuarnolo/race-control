# Changelog

Todas las fechas en hora local (Argentina). Formato libre, pensado para trazabilidad de decisiones,
no solo de código — cada entrada explica el porqué, no solo el qué.

## [0.5] — 2026-10-23

Race Control deja de ser un programa que se baja y pasa a ser un servicio al que se entra. No hay
más `.exe`, no hay más invitaciones por link, y hay una landing que explica el producto antes de
pedirle nada a nadie.

### El `.exe` se fue entero

No se dejó de recomendar: se borró. `src/index.ts`, `scripts/package.js`, el `.ico`, la carpeta
`release/`, el script `npm run package` y la fila de descarga del README.

Con él se fueron las dos piezas que existían **solo** para que funcionara en la PC de una persona:
el mapeo de puertos por **UPnP** y la **detección de IP pública** contra servicios externos. Eso
elimina la última dependencia npm que no era `express` (`@runonflux/nat-upnp`) y deja
`net/connectivity.ts` en lo único que sigue siendo cierto en un servidor: mandar un keepalive y
contar si entran datagramas.

El motor también perdió el parámetro `mode`. Mientras hubo dos destinos había dos comportamientos
—el token del piloto obligatorio acá y opcional allá, la retención sí acá y no allá, formularios
que aparecían en un lado y no en el otro— y cada uno era un camino de código que alguien tenía que
acordarse de probar. Ahora hay uno.

Lo que esto arregla sin pedir permiso: la guía de conexión dejó de tener una sección sobre abrir
puertos en el router, y los cuatro textos del diagnóstico dejaron de mandar a revisar cosas que en
un servidor no existen.

### Las cuentas las crea el operador, una por una

El alta por link de invitación se cambió entera. El motivo es el modelo de negocio: no se invita a
nadie, se le vende. Quien paga la cuota recibe un usuario y una contraseña; quien deja de pagar se
queda sin acceso.

Hay un **panel de operador** en `/operador`, detrás de su propio rol:

- La lista de admins ordenada por lo que requiere atención: primero las cuotas vencidas, después
  las que vencen esta semana, después el resto, y al final lo desactivado.
- Alta de liga y cuenta en un paso, con la contraseña generada por el portal y mostrada **una sola
  vez** —en disco solo queda el hash—, con un botón para copiar los tres datos que hay que pasarle
  al admin.
- "Cobré" suma un mes desde donde venía la cuota, o desde hoy si ya estaba vencida.
- Desactivar **para el worker de esa liga y no toca un solo archivo**. La alternativa —borrar
  datos— convertiría un atraso en el pago en la pérdida del historial de un campeonato.
- Cuántos lugares libres quedan. Cada liga ocupa un puerto UDP de un rango declarado a mano en
  `fly.toml`, así que el cupo es real y conviene verlo venir.

**Nada vence solo**: una cuota vencida se pinta en rojo y espera. Dar de baja a alguien en medio de
su campeonato es una decisión, no un `setInterval`.

Tres detalles que no se ven pero deciden el diseño:

- `/api/operador/*` contesta **404 y no 403** a quien no tiene el rol. Para un admin común esa
  sección no existe.
- Una liga de cuenta desactivada **no vuelve sola en un redeploy**. Si volviera, reiniciar el
  servidor sería la forma de saltearse la baja.
- El CLI sigue existiendo con los mismos comandos, pero **se niega a correr con el portal vivo**:
  el portal tiene todo `portal.json` en memoria y lo reescribe entero, así que su primer guardado
  borraría el cambio del CLI sin que nadie se entere. Se detecta con un `portal.pid` en el volumen.

La cuenta de operador no se crea a mano: el portal la genera en el arranque si `RC_OPERATOR_EMAIL`
está puesto, y escribe la contraseña en el log una sola vez. Hacerlo por CLI no servía —el CLI y el
portal escriben el mismo archivo— y dejarlo para después significaba un panel de operador al que no
se podía entrar.

### Una landing que muestra el producto

Antes, la raíz era un formulario de login. Ahora es una página que explica sección por sección qué
hace Race Control, con el botón de "Ingresar" donde corresponde.

**Los cuatro lugares de captura salen con el hueco puesto**, a la espera de las fotos definitivas.
El hueco no es un `<div>` vacío: lleva el `aspect-ratio` exacto de la imagen que va a ir ahí, así
la página ya tiene hoy la altura final y no se reacomoda sola el día que se suban. Cómo llenarlos
está en `PUESTA-EN-MARCHA.md`.

**Cuando se saquen, van a ser el panel de verdad.** Para eso existe `src/sim/demo.ts`: levanta el
panel completo con una carrera inventada —diez pilotos GT3, un trazado sintético, seis incidentes
en la bandeja, tres sanciones en curso— y de ahí sale cada imagen, sin necesidad de un servidor de
Assetto Corsa. No es un script descartable: está versionado para que, cuando el panel cambie, las
capturas se puedan rehacer en un comando.

Dos cosas que hubo que resolver para que la foto no mienta:

- Un pinger UDP real bindeado al puerto que la config declara como el del servidor de AC, para que
  el indicador de señal diga "recibiendo" porque **entran paquetes**, y no porque se trucó una
  variable. Bindeado y no efímero: si cada datagrama saliera de un puerto distinto, el motor
  concluiría —con razón— que el servidor no tiene puerto fijo y el diagnóstico se pondría en rojo.
- Las posiciones de los autos están congeladas. Moviéndolos, la torre se reordenaba entre capturas
  y en cuanto el líder cruzaba la meta pasaba a figurar último.

De paso, los cajones de Conexión y Reglas aceptan ahora un ancla (`#conexion`, `#reglas`) y se
abren solos. Nació para poder fotografiarlos, pero sirve para que un aviso enlace directo a donde
se arregla el problema.

El pie quedó en la mitad de alto y con el aviso de derechos —el año lo escribe el JS, para que no
haya una fecha a mano que quede vieja el 1 de enero sin que nadie se entere—. Perdió el botón de
"Ingresar", que era el tercero de la misma página. Y la página, que es larga, tiene ahora una
flecha de volver arriba que aparece recién pasada la pantalla y media: antes de eso no hay nada
arriba a donde volver y el botón solo taparía contenido.

### Salir de la sesión, desde donde sea que estés

Las tres pantallas con sesión tienen ahora su botón: el panel de operador, la lista de ligas y
—esta es la que faltaba— el panel de la liga, que era justamente donde el admin pasa toda la
carrera. Sin él, cerrar sesión era borrar la cookie a mano o esperar a que venciera, y en una PC
compartida en un evento eso no es un detalle.

El botón del panel de liga tiene una particularidad: **no pasa por el helper `api()`**. La sesión
vive en el portal, no en el worker, y `api()` antepone el prefijo `/l/<slug>` que se proxea al
worker —que no sabe nada de cookies—. Va con la ruta absoluta y el header `X-RC-Request` a mano.
Y solo aparece si el panel se abrió desde el portal: abierto directo contra el puerto del worker
no hay sesión que cerrar y el botón mentiría.

### El acento pasa de celeste a dorado

`--accent` era `#3fa9f5` en las tres hojas de estilo y ahora es `#f0b429`. El cambio arrastró algo
que no era opcional: el amarillo de aviso (`--yellow`, `#e0b84b`) quedaba a un paso del dorado
nuevo, y son **dos cosas distintas** —uno es "esto es un link / esto es el acento", el otro es
"prestá atención"—. Si se parecen, el aviso deja de avisar. El amarillo de aviso pasó entonces a
ámbar (`#ef8e3c`): sigue leyéndose como precaución y ya no se confunde con el acento.

El mapa del circuito tuvo el mismo problema en chico. El auto seleccionado era amarillo sobre una
parrilla celeste; con la parrilla dorada se habría perdido adentro. Ahora el seleccionado es
blanco —el color de más contraste del mapa, que es lo que le corresponde a lo que está
seleccionado— y el hover es un dorado claro: un escalón del mismo color, no un color nuevo.

### El ícono es un semáforo de largada

`brand/icon.svg` —y su copia en el panel— dejó de ser una bandera a cuadros. La bandera dice
"automovilismo", que es lo que dicen todas las demás; el semáforo dice lo que hace **este**
producto, que es dar la largada y decidir si la carrera está en verde.

Son cuatro lámparas y no diez por la misma razón de siempre: a 16 px en la pestaña del navegador
cada una mide menos de 4 px, y lo único que sobrevive a ese tamaño son las dos manchas de color
—rojo arriba, verde abajo—. Cinco luces en fila, o un damero de 4x4, se vuelven un gris sin forma.

El primer intento tenía las lámparas chicas sobre un panel oscuro. En la barra del panel —que ya
es oscura— el ícono se perdía contra el fondo. Ahora las lámparas ocupan casi todo el cuadro y lo
que queda del cuerpo del semáforo es apenas la junta entre ellas.

**Y el ícono además estaba roto de verdad, por otra razón.** Uno de sus comentarios citaba dos
variables CSS escribiéndolas con su prefijo de dos guiones. Un comentario XML **no puede contener
dos guiones seguidos**: el archivo dejaba de ser XML bien formado y el navegador no dibujaba nada,
el ícono de imagen rota.

Lo que lo hace valer una entrada propia es lo bien que se esconde. El archivo existe, el servidor
contesta 200 con el `content-type` correcto, el contenido se ve perfecto en el editor y el único
síntoma es un dibujito roto indistinguible de un 404. Se diagnosticó mal dos veces —primero como
problema de ruta, después como problema de contraste— antes de pensar en el parser.

Queda cubierto: `test/assets.test.ts` valida **todos** los SVG que se sirven, los dos del ícono y
los ~130 logos de marca. Ahí el mismo error sería aún más invisible, porque un logo roto en la
tabla de pilotos no lo reporta nadie.

### El operador edita la liga y la cuenta desde la tabla

Faltaba lo más obvio: dar de alta una liga se podía, corregirla no. Si el nombre venía con un
error de tipeo, o el admin cambiaba de email, había que editar el `portal.json` a mano por SSH.

Cada fila tiene ahora un botón **Editar** con los cuatro datos que importan: nombre de la liga,
dirección (`/l/<slug>/`), email del admin y contraseña nueva. Se manda solo lo que cambió, y los
dos cambios con consecuencias las avisan antes de guardar: renombrar reinicia el motor —unos
segundos sin escuchar telemetría— y cambiar la dirección deja muerto el link anterior.

La contraseña dejó de ser siempre generada: el operador puede escribir una, o dejar el campo vacío
y que no se toque. Sigue sin guardarse en claro en ningún lado.

Debajo hay una decisión que venía postergada: **el nombre de la liga tenía dos dueños**. El portal
guardaba `League.name` —lo que se ve en la tabla y en la factura— y el worker guardaba su propio
`config.leagueName` —lo que se ve arriba a la izquierda en el panel—, y cada uno se editaba en un
lado distinto. Ahora manda el portal: el worker lo toma al arrancar y `POST /api/config` descarta
`leagueName` como descarta los puertos. En el panel del admin el campo quedó de solo lectura, y el
paso 1 del asistente dejó de pedir el nombre para pasar a confirmarlo.

### Un campo para copiar, no un bloque de texto

En "Configuración del servidor", el Send Address pasó de ser un `<pre>` a un input de solo lectura
con el botón de copiar **adentro**. El gesto de copiar queda donde está el dato, y un click en el
campo lo selecciona entero.

### Se dejó de recomendar editar el `server_cfg.ini`

Salió de una prueba contra un hosting real (EmperorServers): el admin no encontraba el "Send
Address" por ningún lado, y el `server_cfg.ini` el panel se lo dejaba **ver pero no editar**.

Las dos cosas tienen la misma causa y ninguna era un problema de ese hosting en particular:

- Los paneles tipo Assetto Corsa Server Manager **regeneran** el `server_cfg.ini` desde su propia
  base cada vez que arranca el servidor. Lo que se edite a mano se pierde en el próximo arranque,
  que es exactamente el paso siguiente de la guía. Por eso lo muestran en solo lectura: ese
  archivo es una salida, no una entrada.
- La sección de plugins del Server Manager **se puede apagar entera** desde su `config.yml`
  (`disable_plugins`), y apagada no se dibuja. Al admin le parece que el campo no existe, y en su
  pantalla efectivamente no existe. El archivo lo maneja el hosting, así que la única salida es un
  ticket al soporte.

Entonces: se borró `buildServerSnippet` y el campo `serverSnippet` de `/api/state`, y con ellos el
bloque "Si editás el `server_cfg.ini` a mano" del panel. Dar una instrucción que el panel deshace
sin avisar es peor que no darla — el admin cree que conectó la liga y se entera el día de carrera.

En su lugar, donde estaba ese bloque hay ahora un desplegable **"No encuentro el campo Send
Address"** con la causa real y qué pedir. La guía de conexión suma una sección propia con el texto
del ticket listo para copiar, y el camino del campo quedó completo en todos lados: **Server
Options → sección de plugins UDP → "Send Address"**, y no solo "buscá Send Address".

### Versión y limpieza

`0.5` en el panel y en `/api/state`, `0.5.0` en `package.json`. La única dependencia de producción
que queda es `express`.

## [0.4] — 2026-10-23

El admin ya no descarga nada. Race Control pasa de ser un `.exe` que corre en la PC de una persona
a un **portal web multi-liga**: se entra con usuario y contraseña, se pega un renglón en el panel
del hosting, y eso es toda la puesta en marcha.

El `.exe` sigue existiendo y hace exactamente lo mismo. No es una versión degradada ni un modo de
compatibilidad: es el mismo motor con `mode: "local"`.

### Por qué

La 0.3.1 arregló cada paso difícil de la configuración por separado y aun así la secuencia completa
seguía siendo impracticable: bajar un ejecutable que SmartScreen marca, convivir con una ventana de
cmd abierta toda la carrera, entrar a un `localhost:3000` que parece un error, averiguar la IP
pública propia, abrir un puerto en el router y esperar que la IP dinámica no cambie en el medio.
Ninguno de esos pasos es el producto. Todos desaparecen cuando el motor corre en un servidor que ya
tiene IP fija, puertos abiertos y un certificado válido.

Lo único que no se puede eliminar es apuntar el servidor de Assetto Corsa a Race Control: ese dato
solo lo puede poner quien tiene acceso al panel del hosting. Lo que sí se pudo es reducirlo a
copiar y pegar un renglón que el portal muestra ya armado.

### Un proceso por liga

El portal no atiende varias ligas dentro del mismo proceso, y no por comodidad. Hay estado que es
global por construcción —el `StateTracker` indexado por `carId`, el circuito que se aprende, el
tipo de sesión— y un `uncaughtException` llamaba a `process.exit`. En un proceso compartido, un
`carId` de una liga pisaría al de otra y cualquier falla se llevaría puestas a todas las carreras
en curso a la vez. El precio son unas decenas de MB por liga y se paga.

De ahí sale el resto de la arquitectura:

- **`core/raceControl.ts`**: todo el backend extraído del entry, parametrizable. Recibe su carpeta
  de datos, sus puertos y su modo por argumento, y tiene un `stop()` que cierra los timers, el
  socket y los archivos. Sin eso no se pueden tener dos instancias en un proceso, que es lo que los
  tests necesitan para poder probar el aislamiento entre ligas.
- **`portal/supervisor.ts`**: levanta un hijo por liga y lo mantiene vivo con backoff creciente
  (1 s, 2 s, 4 s… tope 60 s). El contador se reinicia tras cinco minutos estable, y después de
  cinco caídas seguidas la liga queda en `failed` y se avisa en el portal. Reintentar para siempre
  quema la máquina y llena el disco; no reintentar deja la carrera muerta.
- **`portal/store.ts`**: cuentas, ligas, membresías e invitaciones en un JSON con escritura
  atómica. No es una base de datos y no hace falta que lo sea: escribe un solo proceso y la escala
  es de decenas de ligas. `node:sqlite` sigue siendo experimental en Node 22.

### Rutas en vez de subdominios

Cada liga vive en `race-control.fly.dev/l/<liga>/`. La alternativa era un subdominio por liga, que
hubiera dejado el panel intacto —todas sus rutas absolutas seguirían funcionando—, pero exige un
certificado wildcard y un dominio propio. Con `*.fly.dev` no hay sub-subdominios, así que arrancar
sin pagar un dominio obliga a rutas.

El costo fue real pero acotado: el panel aprendió a vivir bajo un prefijo (`BASE` en `app.js`, que
se deduce de la propia URL). El cliente Python no necesitó un solo cambio de ruteo, porque ya
armaba su URL como `http://<lo que le digan>/api/client/...` y un prefijo entra ahí sin que se
entere.

### El canal de los pilotos ahora está firmado

Hasta acá ese canal no tenía ninguna autenticación: cualquiera que supiera un SteamID podía mandar
telemetría en nombre de otro. En loopback no importaba —había que estar en la misma PC—; expuesto a
internet, sí.

Cada liga firma un token por piloto con su propia clave de 32 bytes (`security/pilotToken.ts`). El
`steamGuid` va dentro de la firma, así que un piloto no puede usar su token para hacerse pasar por
otro, y el token de una liga es ruido en otra. Viaja por el mismo chat del juego que ya le
anunciaba la dirección al auto, que es el único canal que Assetto Corsa ofrece para decirle algo a
una persona y no a toda la parrilla.

**El token es obligatorio en el portal y opcional en el `.exe`.** No es un descuido: exigirlo
también en local dejaría afuera, en plena carrera y sin ningún mensaje que lo explique, a todos los
pilotos que todavía tengan la app de la 0.3. Local lo emite igual y lo usa si llega; lo que no hace
es rechazar a quien no lo tenga.

Lo que este esquema **no** resuelve, y se asume: el token viaja en claro, porque la app corre en el
Python 3.3 embebido de Assetto Corsa y ahí no hay HTTPS utilizable (`ssl.create_default_context`
llegó en 3.4, la verificación de certificados por defecto en 3.4.3, y no lee el almacén de
Windows). Quien esté en la red de un piloto puede capturar su token y falsificar su presencia y su
telemetría por 24 h. No da acceso al panel ni a otra liga. Está escrito en `docs/seguridad.md`.

### Endurecimiento del panel, que ahora sale a internet

El panel vivía en `127.0.0.1` y eso permitía no pensar en nada de esto:

- **Allowlist de rutas, no denylist.** Se enumera lo que pasa y el resto es 404.
- **CSRF con tres defensas y no una**: cookie `SameSite=Strict`, un header propio obligatorio en
  todo POST, y chequeo de `Origin`. Cada una falla distinto.
- **Sesiones** en cookie `__Host-rc_session`, guardadas hasheadas en memoria, con vencimiento a las
  2 h de inactividad y 12 h absolutas. Cambiar la contraseña invalida todas de golpe.
- **Contraseñas** con `scrypt` (N=2^15), comparación en tiempo constante, y un hash señuelo cuando
  el email no existe para que el tiempo de respuesta no delate qué cuentas hay. Cero dependencias
  npm nuevas: las dos siguen siendo `express` y `@runonflux/nat-upnp`.
- **Freno de login** por IP (10 fallos en 15 minutos) y por cuenta (demora progresiva hasta 30 s,
  nunca bloqueo: si no, cualquiera podría dejar a un admin afuera de su propia liga a propósito).
- **`POST /api/config` con allowlist de campos**: puertos, binds y direcciones no son editables
  desde el panel en modo portal, porque los administra el portal. El panel esconde esos formularios
  cuando corre ahí, en vez de ofrecer un "Guardar" que no guarda nada.
- **Auditoría con nombre y apellido**: el portal inyecta `X-RC-User` en cada acción, y lo borra si
  viene de afuera. Sin eso, en una liga con varios comisarios el journal diría "alguien kickeó al
  piloto 7".
- **Informe CSV**: las celdas que empiezan con `= + - @` se prefijan con una comilla simple. Un
  piloto con un nombre armado a propósito podía meter una fórmula en el Excel del comisario.
- **Prototype pollution**: `mergeConfigInto` rechaza `__proto__`, `constructor` y `prototype`.

### Retención de datos

Los `events-*.jsonl` guardan nombres y SteamID64 en texto plano. En la PC del admin eso era un
detalle —son sus datos, en su disco—; en un servidor con ligas de terceros, no. En modo portal se
borran a los 90 días y las capturas crudas a los 7. **En modo local no se borra nada**: ahí el
historial es del admin y no se le toca sin preguntar.

### Dos bugs que ya estaban y salieron a la luz

- `validateConfig` **reasignaba** objetos en vez de mutarlos (en `pit.zone`, en los dos `penalty` y
  en cada tipo de infracción). Los motores guardan la referencia, así que después de una validación
  quedaban mirando el objeto viejo y los cambios del panel dejaban de aplicarse en vivo.
- `saveConfig` escribía directo sobre el archivo. Un corte en el momento equivocado dejaba un
  `config.json` truncado y la liga sin configuración. Ahora es `tmp` + `rename`.

### Despliegue

`Dockerfile` y `fly.toml` para Fly.io. Tres cosas de esa plataforma condicionan el archivo entero y
están anotadas ahí: UDP exige una IPv4 dedicada, Fly no reescribe el puerto de los datagramas (así
que `internal_port` tiene que ser igual al externo y cada puerto va declarado uno por uno), y la
app tiene que bindear a `fly-global-services` y no a `0.0.0.0` —con `0.0.0.0`, Linux contesta desde
la dirección equivocada y el servidor de Assetto Corsa nunca ve la respuesta.

Una sola máquina, sin escalado horizontal: el estado vive en el volumen y los workers son hijos de
ese proceso.

### Lo que todavía no se probó

Nada de esto corrió contra un servidor de Assetto Corsa real todavía. El camino completo se validó
de punta a punta con datagramas simulados (portal → worker → panel, y la app del piloto con su
token), pero los supuestos del protocolo anotados en `docs/spike-protocolo.md` siguen sin confirmar
en pista.

## [0.3.1] — 2026-10-23

Primera prueba contra un servidor real de EmperorServers. No se llegó a correr: la puesta en
marcha resultó impracticable antes de eso. El reporte, textual, fue que los pasos 2 y 3 no se
podían hacer, que el asistente no se abrió en el 5, que el 6 "no lo va a saber hacer el usuario" y
que el 8 era "súper técnico". Es exactamente el usuario para el que está escrito el producto, así
que el problema es del producto.

Esta versión ataca la causa concreta. El cambio de fondo —pasar de un `.exe` a un portal web, para
que el admin no descargue nada— está planificado para la 0.4.

### El puerto más difícil de encontrar ya no hay que encontrarlo

Para conectar Race Control hacían falta dos números. El segundo —en qué puerto escucha el servidor
de Assetto Corsa las órdenes que le mandamos— es el peor dato de toda la configuración: vive en el
panel del hosting bajo un nombre que cambió entre versiones, en muchos planes directamente no es
editable, y equivocarlo produce la falla más cara de diagnosticar que tiene el producto. La
telemetría entra perfecta, el panel se pone verde entero, y ni una sola sanción llega nunca.

El servidor ese número lo dice solo, en cada paquete que manda. Ahora lo tomamos de ahí
(`adoptRemotePortIfNeeded` en `server/src/udp/client.ts`), igual que ya se hacía con la dirección.
El admin no toca ningún puerto: pega una línea en su hosting y listo.

Tres detalles que hacen que esto sea seguro y no una adivinanza:

- **Un puerto escrito a mano no se pisa nunca.** `config.acUdp.remotePortSource` distingue el valor
  de fábrica (`default`, se autodetecta), el deducido (`detected`) y el que escribió el admin
  (`manual`). Ese último manda, porque es el único caso en que él sabe más que nosotros: un hosting
  que relaye los datagramas tendría un origen distinto del destino correcto. Borrar el campo y
  guardar vuelve a pedir la detección.
- **Si el servidor hablara desde un puerto distinto cada vez, se detecta y se abandona.** Toda la
  idea se apoya en un supuesto —que el acServer usa un solo socket para el plugin— que solo se
  confirma contra un servidor real. Si fuera falso, adoptar el origen sería adoptar basura nueva en
  cada paquete. En vez de eso se deja de adoptar, se avisa, y el diagnóstico manda a buscar el dato
  real al panel del hosting. Queda anotado como pendiente de pista en `docs/spike-protocolo.md`.
- **El diagnóstico dejó de ofrecer un número que ya caducó.** Antes, ante un desajuste, decía
  "poné 8008". Si el puerto es efímero ese consejo es falso, así que ese caso ahora tiene su propio
  texto.

### La guía nombraba campos que ya no existen

El changelog de Assetto Corsa Server Manager confirma que en la **2.4.8** los campos se
renombraron: "UDP Plugin Local Port" pasó a llamarse **"Listen Address"** y "UDP Plugin Address" a
**"Send Address"**. La guía mandaba a buscar los nombres viejos. Por eso no se encontraban.

La misma versión trae algo que invalida una advertencia que dábamos: *"It is now possible to
specify multiple plugin listeners in the Server Options"*. O sea que Race Control **no desplaza**
los plugins que ya estuvieran configurados. La sección "Ojo: Assetto Corsa admite un solo plugin"
estaba asustando sin motivo, y con ella la idea de que había que desactivar las sanciones
automáticas del propio panel (`custom_cuts_enabled`, `collision_penalties_enabled`) — que, además,
en el plan del usuario no eran editables. Se pueden dejar como estén.

`guia-conexion.html` se reescribió entera: pasó de 4 pasos con dos líneas de configuración a 4
pasos con **un** dato, con los nombres reales de cada panel y una sección nueva sobre la lista de
IPs permitidas, que es otro modo de fallo completamente silencioso.

### El panel pide un dato, no un bloque de configuración

- "Configuración del servidor" muestra ahora solo el **Send Address** (`191.81.189.89:12000`), con
  su botón de copiar. Las dos líneas del `server_cfg.ini` siguen ahí para quien edite el archivo a
  mano, pero plegadas: dejaron de ser lo primero que se ve.
- El paso 3 del asistente de primer arranque, igual.
- En Puertos, el "Puerto del servidor de AC" ahora explica de dónde salió el número que muestra. Sin
  eso, el admin veía un puerto que nunca escribió y no tenía forma de saber si era un valor de
  fábrica a corregir o el bueno de verdad.

Seis tests nuevos, cuatro de ellos con sockets UDP reales sobre loopback en vez de un doble de
prueba: lo que se está verificando es justamente qué trae el `rinfo` de Node, y un mock daría por
cierto el dato que se quiere comprobar. Total: 132.

---

## [0.3] — 2026-10-23

Auditoría completa del proyecto. A partir de acá el versionado pasa a ser de **dos números**
(0.3, 0.4, … 1.0): el tercer número no estaba comunicando nada útil a un admin de liga, que es
quien ve el número en la página de descargas. `server/package.json` se mantiene en `0.3.0` porque
npm exige semver de tres partes, pero ese valor es interno y no se muestra en ningún lado.

Ocho tandas. La primera son cuatro bugs que impedían que el producto funcionara contra un hosting
remoto —el caso de uso para el que fue escrito—: estaban activos en la 0.2.3 y ninguno daba error
visible, el panel mostraba todo en verde mientras nada funcionaba. Las otras siete son el motor de
incidentes, el rediseño del panel en una sola pantalla, la torre de tiempos, los límites de pista,
el catálogo de infracciones configurable, el enlatado, la persistencia con informe de carrera y la
tanda de ajustes sobre el panel ya funcionando.

Las tandas están ordenadas por tema, no cronológicamente, y la primera queda al final: es la que
menos dice sobre qué hace hoy el producto.

---

## Segunda tanda: incidentes en pista y panel nuevo

### El motor no veía nada de lo que genera conflicto en una liga

Hasta acá Race Control detectaba exceso de velocidad y nada más. Los toques entre pilotos, los
choques contra el muro y los trompos —lo que de verdad discute una liga el lunes siguiente— no se
registraban en ningún lado, aunque el paquete que los trae (`CLIENT_EVENT`, opcode 130) **ya
llegaba al backend y se descartaba sin decodificar**.

- `server/src/udp/protocol.ts` decodifica ahora el paquete completo. El orden de lectura importa:
  `other_car_id` existe **solo** cuando el choque es contra otro auto; leerlo siempre desfasaría un
  byte la velocidad de impacto y las dos posiciones, y el bug se vería como números absurdos en vez
  de como un error. Hay un test que arma los dos layouts a mano justamente para fijar eso.
- `server/src/incident/incidentEngine.ts` convierte esos eventos en incidentes con contexto.

Tres cosas que el motor resuelve y que son la razón de que no sea un simple `map()`:

1. **Doble reporte.** Ante un toque, el servidor emite un `CLIENT_EVENT` por **cada** auto
   involucrado. Sin correlacionarlos, la bandeja mostraría cada toque dos veces y señalaría a los
   dos pilotos. Se agrupan los dos que comparten `(car_id, other_car_id)` invertido dentro de 500 ms.
2. **Flood.** Un trompo contra el muro genera decenas de eventos en dos segundos. Se agrupan los
   del mismo involucrado dentro de 3 s en un único incidente que conserva el impacto más fuerte y
   un contador. La clave de agrupación identifica a los *involucrados* (`contact:3,9`), no a un
   auto: agrupar por auto a secas metería en la misma entrada un toque del 3 contra el 9 y otro del
   3 contra el 5 un segundo después, listando mal a las partes.
3. **Contexto perdido.** El paquete trae posiciones pero no dice quién es quién ni a qué velocidad
   iban. Eso se cruza con el `StateTracker` **en el instante del impacto** y se guarda como copia:
   el tracker muta el mismo objeto con cada actualización, así que leerlo al emitir el incidente
   —hasta medio segundo después— daría la velocidad de después del choque, no la del choque.

**Los incidentes no se auto-sancionan.** Van a una bandeja para que decida un comisario. El
servidor sabe que hubo contacto, no quién tuvo la culpa: un `rear-end` puede ser culpa del de
adelante por frenar en seco. La geometría del toque (trompa contra cola / rueda a rueda / frontal)
se deduce cruzando las dos perspectivas y se presenta como un dato que acompaña al incidente, no
como un veredicto. Con una sola perspectiva queda en "sin determinar" en vez de adivinar.

Los umbrales son configurables (`config.incidents`) y existen para que un roce de parrilla o un
piano no llenen la bandeja antes de la primera vuelta.

### El panel: todo en una pantalla

Era una grilla plana de siete tarjetas donde configurar la zona de pit ocupaba el mismo espacio
visual que ver la carrera en vivo, y había que scrollear para ver quién estaba en pista.

- **Sin scroll de página**, al 95% del ancho. Las tablas largas scrollean dentro de su propia caja
  con el encabezado fijo: con 24 pilotos no hay layout que entre, y achicar la fuente hasta que
  entre es peor.
- **Largada y Autos conectados arriba, lado a lado** — son los protagonistas. El mapa abajo,
  tomando todo el alto restante.
- **Red pasó a ser un botón** en la barra, que se pinta verde solo si las dos mitades están bien
  (servidor identificado **y** telemetría entrando). Media conexión es tan inútil como ninguna.
- **El modo de aplicación es un switch siempre visible** en la barra. Antes era un checkbox dentro
  de una tarjeta y se podía correr una carrera entera sin notar que el motor no sancionaba nada.
- **Los botones de guardar se apagan** y se ponen verdes cuando no hay nada que guardar. Se compara
  contra los últimos valores guardados y no contra un flag de "tocado": si el admin cambia un valor
  y lo deja como estaba, el botón se apaga solo.
- **Botones de largada con estado**: "Verde" y "Reset" ya no se pueden apretar cuando el servidor
  los va a ignorar en silencio.
- Las sanciones y la bandeja de incidentes se mudaron a **`/sanciones`**, con router de History API
  y fallback de Express para que recargar esa URL no dé 404.

### Mapa del circuito en vivo

El trazado **se aprende solo**, sin pedirle archivos de pista a nadie: `CAR_UPDATE` ya trae
`posX`/`posZ` en coordenadas reales del mundo junto con la posición normalizada en la vuelta
(`server/src/track/trackLearner.ts`). Se indexa por posición de vuelta y no por orden de llegada,
así el dibujo sale ordenado aunque las muestras lleguen mezcladas de 20 autos repartidos por toda
la pista — cuantos más autos hay, más rápido se completa. Se guarda por circuito y queda para
siempre.

- Render en `<canvas>` con interpolación entre muestras, porque el panel consulta una vez por
  segundo y sin interpolar los autos avanzarían a saltos. Un salto grande (reset a boxes) no se
  interpola: dibujaría el auto cruzando el circuito en línea recta por el medio.
- **Hover** sobre un auto muestra nombre y número. **Click** en un piloto de la tabla lo resalta en
  amarillo en el mapa, y al revés. Es una sola variable de selección para los dos sentidos:
  sincronizar dos estados por separado es la forma segura de que se desincronicen.

### Tabla de pilotos: ping y kick

- **"Señal" pasó a "Ping"**, en milisegundos, medido por la app del piloto en su heartbeat. Honesto
  sobre qué mide: el protocolo UDP de AC **no expone** el ping del piloto al servidor de carrera.
  Esto es el round-trip hacia Race Control. Sirve igual para lo que el admin quiere saber —quién
  tiene conexión inestable— y se etiqueta sin prometer de más.
- **Kick por fila con doble confirmación**: el botón se arma, cambia de color y se desarma solo a
  los 4 s. Expulsar a alguien a mitad de carrera no se deshace y no puede salir de un click fallido
  en una tabla que se actualiza sola. (Un `confirm()` nativo tampoco servía: bloquea el hilo y
  congela el mapa mientras está abierto.)
- El kick manual se ejecuta **siempre, aunque el modo sombra esté activo**. El modo sombra existe
  para que el motor automático no sancione sin supervisión, no para bloquear una orden explícita
  del admin, que por definición ya está supervisada. Queda en el journal como `kick.manual`,
  distinguible del automático.

### Identidad visual

Hasta acá no había ninguna marca: el navegador mostraba el favicon genérico y el panel abría con
texto plano. `brand/icon.svg` es una bandera a cuadros con un arco de señal emitiendo desde la
esquina. Dos elementos y no más, porque a 16 px cualquier tercero se vuelve una mancha: la bandera
comunica "carreras" al instante y el arco comunica "telemetría", que es lo que distingue a esta app
de cualquier otra herramienta de sim racing. La paleta no se inventa, son las variables CSS que el
panel ya definía.

### Tests

El proyecto no tenía ninguno. Al cierre de la 0.3, `npm test` corre **123 casos** con el runner de
Node (sin agregar dependencias) sobre lo que más conviene testear: lógica pura sobre paquetes
decodificados.

- Decodificador de `CLIENT_EVENT`, incluido el contrato de no tumbar el proceso ante un paquete
  truncado — se prueba cortándolo en todas las longitudes posibles.
- Las rarezas de codificación del protocolo: `CAR_INFO` con las cinco cadenas anchas, y
  `NEW_CONNECTION` mezclando anchas (nombre, GUID) con angostas (modelo, skin). Y que en
  `NEW_SESSION` la duración viene **antes** de las vueltas y en minutos: invertir esos dos campos
  no rompe nada visible —da una carrera "a 10 vueltas" sin reloj, que es exactamente lo que parece
  una carrera por vueltas— y por eso necesita un test y no una lectura atenta.
- Motor de incidentes con reloj falso: correlación de las dos perspectivas, clasificación
  geométrica, antiflood, no agrupar toques contra rivales distintos, y que el contexto guardado sea
  el del momento del impacto.
- Aprendizaje del trazado: persistencia entre reinicios, no mezclar circuitos, nombres de pista con
  barras, y descarte de posiciones en (0,0).
- Clasificación en vivo y deducción de marca, incluido que una marca que no está en la biblioteca
  devuelva `null` en vez de un slug optimista.
- Límites de pista: umbral de ruedas, mínimo de duración, reincidencia, ganancia de tiempo medida
  contra la mejor vuelta limpia, validación cruzada contra los cortes del servidor, y que un
  reporte con basura no cuente ni rompa.
- Restauración desde el journal: división por motor, última escritura gana, corte por antigüedad,
  línea final truncada, y que restaurar no vuelva a emitir los avisos de cada sanción.
- Rotación de `raw.bin` y armado del informe de carrera.

---

## Tercera tanda: torre de tiempos en vivo

### "Autos conectados" era una tabla de cuatro columnas

Piloto, velocidad, vuelta y ping no alcanzan para dirigir una carrera. Ahora es una **torre de
tiempos**: posición, logo de marca del auto, velocidad, vueltas, tiempos por sector, última vuelta,
mejor vuelta, paradas en boxes, compuesto, combustible y ping. La mejor vuelta absoluta de la
sesión va en morado y la mejor propia en verde, que es el código de color de cualquier timing de
sim racing y por eso no hay que explicarlo.

La posición se calcula en vivo: por progreso (vueltas + avance en el trazado) en carrera, y por
mejor vuelta en práctica y clasificación. Ordenar una tanda libre por progreso daría un orden sin
ningún significado — lidera el que más vueltas lleva dando, no el más rápido.

Una vuelta con cortes cuenta como última vuelta pero **no** como mejor vuelta. El dato de cortes ya
venía del servidor y se estaba ignorando.

### La mitad de esas columnas no existe en el protocolo de AC

Esto hay que decirlo claro: el UDP de Assetto Corsa **no transporta** tiempos por sector, compuesto,
combustible ni paradas en boxes. `LAP_COMPLETED` trae el tiempo total de la vuelta y los cortes, y
se acabó. La única fuente es la Shared Memory del juego, que corre en la PC de cada piloto.

Así que esas columnas vienen de la app del piloto, por el mismo heartbeat que ya existía — un solo
canal, misma validación, mismo modo de fallo. El intervalo bajó de 5 s a 2 s para que la torre se
sienta en vivo. Un piloto sin la app aparece con todo lo autoritativo (posición, velocidad, vueltas,
tiempos de vuelta) y guiones en el resto: degrada bien, y de paso convierte la app en algo que el
piloto quiere tener instalado en vez de algo que se le impone.

En el cliente, las structs de Shared Memory pasaron a declararse completas con `ctypes` en vez de
calcular offsets a mano. No es cosmético: **el offset de la bandera que había (68) caía dentro del
array `lastTime`** — estaba mal, y estaba mal porque un número suelto no hay forma de revisarlo.
Declarada la struct, los offsets los calcula ctypes y ese error no puede volver a pasar.

Queda pendiente de verificación en pista si `lastSectorTime` es acumulado desde el inicio de la
vuelta o ya viene por sector. Se asume acumulado (el consenso de las implementaciones
comunitarias), con detección del otro caso y descarte de valores absurdos: ante la duda la columna
muestra un guion, nunca un número inventado.

### Logos de marca, de la propia instalación de Assetto Corsa

El logo de cada auto sale de `content/cars/<modelo>/ui/badge.png` del juego instalado en la PC del
admin. Se busca solo (registro de Steam, más `libraryfolders.vdf` para instalaciones en otro
disco) y se puede corregir a mano desde el cajón de reglas.

> **Revertido en la octava tanda.** Obligaba a que el admin tuviera Assetto Corsa instalado en la
> misma PC que el backend, que no es el caso de quien dirige la carrera sin correrla. Se reemplazó
> por una biblioteca de logos empaquetada con la app.

### Layout y barra superior

- El mapa pasó a ocupar **la mitad** del ancho de la torre, al costado, en vez de una fila entera
  abajo.
- La largada pasó de tarjeta cuadrada a **banda horizontal arriba**: el semáforo y sus tres botones
  en una sola fila, un sexto del alto que ocupaban. Va arriba y no abajo porque es lo único de la
  pantalla que es secuencial —se usa una vez, al principio— y dejarla abajo obligaría a bajar la
  vista en el único momento de la carrera en que el admin no puede distraerse.
- Orden de la barra: **Control de carrera** (antes "En pista") → Sanciones → Reglas → **Conexión**
  (antes el botón de "Sin señal"). El switch de modo queda donde estaba.
- "Control de carrera" lleva una **bandera a cuadros que ondea solo con la carrera en curso**. Antes
  había que buscar el semáforo de la tarjeta de largada y leerlo; con el panel en una segunda
  pantalla, eso es justo lo que no se quiere tener que hacer. Respeta `prefers-reduced-motion`: ahí
  se queda quieta y el estado lo comunica el color.
- Los cajones laterales scrollean por dentro, documentado como segunda excepción deliberada a la
  regla de "una sola pantalla" (la primera son las tablas). Cinco secciones de configuración no
  entran en 768 px de alto en ninguna resolución realista, y el cajón es una capa flotante **por
  encima** de la pantalla de carrera, no parte de ella.

---

## Cuarta tanda: límites de pista

### Las salidas de pista no las puede ver el servidor

El UDP de Assetto Corsa no dice si un auto tiene ruedas afuera. Lo único que manda es `cuts` al
cerrar la vuelta: cuántos cortes hizo, sin decir dónde, cuándo ni de qué tamaño. Así que la
detección la hace la app del piloto leyendo `numberOfTyresOut` de la Shared Memory.

Lo que viaja al backend son **transiciones**, no un stream: la salida se encola recién cuando
termina, con cuánto duró y cuántas ruedas llegó a tener afuera. Mandar el valor instantáneo cada
2 segundos no serviría — una salida típica dura menos que eso y caería justo entre dos muestras.
El muestreo es a 4 Hz, que es lo que corresponde a una app corriendo dentro del juego: no debe
competir por CPU con el render.

El umbral (2 o 4 ruedas) lo aplica el **servidor**, no el cliente: el cliente detecta todo desde 2
ruedas y manda el máximo observado. Así, cambiar la regla desde el panel no obliga a que 24 pilotos
actualicen la app.

Configurable desde el cajón de reglas: si se controla o no, cuántas ruedas cuentan, cuántas salidas
antes de avisar, cuánto dura la salida mínima, y si una salida con ganancia de tiempo va directo a
la bandeja. Por defecto: 4 ruedas, 3 salidas, 300 ms. Se avisa a la reincidencia y no a la primera,
que es el modelo de "track limits" de las categorías reales.

### Ganancia de tiempo: contra la mejor vuelta *limpia*

Una salida es un error; una salida en la vuelta más rápida del piloto es otra cosa. La comparación
es contra su mejor vuelta **sin salidas y sin cortes**, no contra su mejor vuelta a secas: si no, la
primera vuelta sucia y rápida sube el listón y tapa todas las siguientes.

### El cliente es editable, así que se contrasta

El cliente es un `.py` en texto plano en la PC del piloto. La defensa no es cifrarlo, es
contrastarlo contra lo que el servidor sí sabe. Si el servidor viene contando cortes que la app del
piloto nunca informó, eso mismo entra en la bandeja como *telemetría inconsistente*.

La comparación es **acumulada por sesión, no vuelta a vuelta**, y esto importa: el heartbeat viaja
cada 2 s, así que una salida justo antes de la línea de meta llega después del `LAP_COMPLETED` y
queda contada en la vuelta siguiente. Vuelta a vuelta, ese desfasaje daría falsos positivos todo el
tiempo. Lo que un desfasaje no puede producir es una diferencia que crece y nunca se cierra — por
eso la tolerancia es de 3 y la cuenta es acumulada.

Un piloto **sin** la app nunca genera este aviso: sin telemetría no hay nada que contrastar, y
reclamarle incoherencia a quien no reporta nada sería acusarlo por no tener la app instalada.

Los contadores están indexados por `driverGuid` y **sobreviven a una desconexión**. Borrarlos al
desconectar convertiría el Alt+F4 en una forma de limpiar el contador de límites de pista.

### `isValidLap` no existe en Assetto Corsa

Es un campo de ACC, no de AC. La página `acpmf_graphics` de AC termina en `mandatoryPitDone` y no
expone validez de vuelta. O sea que `cuts` del servidor no es *una* señal de vuelta invalidada: es
la única que hay, lo cual es justamente lo que hace que valga la pena cruzarla.

### La bandeja ahora tiene cuatro tipos

Toque entre autos, choque en solitario, límites de pista y telemetría inconsistente — en la misma
lista a propósito: para el comisario son todos "algo que revisar", y partirlos en dos lo obligaría a
mirar en dos lados durante la carrera. Los que no son colisión no muestran velocidad de impacto: el
backend manda el campo ausente en vez de un cero, así que el panel omite la línea en lugar de
afirmar "impacto a 0 km/h", que sería un dato que nadie midió.

Como el resto de la bandeja: **reporta, no sanciona**.

---

## Quinta tanda: catálogo de infracciones y presets

### Dos bloques gemelos de velocidad no son un catálogo

La configuración eran dos bloques con la misma forma (largada y pit lane) y, por cada tipo nuevo de
infracción, un `enabled` booleano. Eso dejaba afuera la única decisión que un admin de liga
realmente quiere tomar: no *si* se mira, sino **qué pasa cuando ocurre**.

De ahí `action`, que es el mismo campo en todos los tipos: `No controlar` / `Solo registrar` /
`Mandar a revisar` / `Sancionar solo`.

**La sanción automática solo se ofrece donde el hecho es objetivo.** Hoy eso es un tipo solo:
límites de pista. Contar ruedas afuera no se interpreta. En un toque el servidor sabe que hubo
contacto, **no de quién fue la culpa**: ofrecer "sancionar solo" ahí sería prometer un juicio que
el dato no respalda. La lista de qué tipos lo admiten la manda el backend en `/api/catalog`, no la
duplica el panel: si vive en dos lados, tarde o temprano el panel ofrece una opción que el servidor
va a rechazar.

### Presets por tipo de torneo

Un admin no técnico no tiene forma de saber qué umbral de impacto poner. Elige *Carrera casual*,
*Campeonato* o *Simulación estricta* y todos los números quedan puestos; después puede tocar lo que
quiera, y tocar algo a mano no invalida el preset — es un punto de partida, no un candado.

Cada preset es un **patch** sobre los valores por defecto, no un catálogo completo: así, agregar un
tipo de infracción nuevo no obliga a tocar los tres presets ni deja huecos silenciosos.

---

## Sexta tanda: el enlatado

### El wizard decía que detectaba cosas que eran constantes

El asistente de primer arranque pedía el nombre de la liga y afirmaba que "el resto (puertos, IP
pública) se detecta solo", lo cual era falso para los puertos: eran constantes en el código. Ahora
son cuatro pasos —liga → tipo de torneo → conexión → comprobación en vivo— y el último de verdad
verifica que llegue telemetría antes de dejar pasar.

### "Probar conexión" en castellano llano

Cuatro chequeos en orden, cada uno con qué hacer si falló: tu dirección en internet, señal del
servidor de carrera, órdenes hacia el servidor, y la app de los pilotos. Los dos últimos están
separados a propósito: el servidor puede estar mandando telemetría perfecta mientras ningún piloto
logra alcanzar el puerto de clientes, y antes eso se veía todo verde.

### Puertos ocupados y guía genérica

- Si el 3000 está tomado por otro programa, el arranque se corre al siguiente libre y abre el
  navegador ahí. Antes el panel no abría y el error salía solo por consola.
- La guía dejó de ser "de EmperorServers": el snippet que genera (`UDP_PLUGIN_LOCAL_PORT` /
  `UDP_PLUGIN_ADDRESS`) es estándar de Assetto Corsa y sirve para cualquier hosting. Era solo
  cuestión de nombrarlo y documentarlo como tal.

---

## Séptima tanda: persistencia, informe de carrera y sanciones del comisario

### Las sanciones vivían solo en memoria

Si el proceso se reiniciaba a mitad de carrera, se perdían todas. El journal ya registraba todo en
JSONL; lo que faltaba era reconstruir el estado al arrancar. Ahora se reconstruyen sanciones e
incidentes desde el journal, con corte por antigüedad y descartando lo anterior al último
`NEW_SESSION` —una sanción de la carrera de ayer no tiene por qué revivir hoy—.

**Dos bugs que aparecieron al escribir esto, y que importan más que la función:**

- **El journal escribía con un `WriteStream`.** El buffer de un stream se pierde entero si el
  proceso se corta sin cerrarlo, que es *exactamente* el caso que la restauración existe para
  cubrir. Pasó a escritura sincrónica: son unos pocos eventos por vuelta y el costo no se nota.
- **La rotación de `raw.bin` no rotaba nunca en Windows.** `stream.end()` cierra el archivo de
  forma asincrónica, y renombrar un archivo todavía abierto falla con EBUSY — el error caía en el
  `catch` que existía para no tumbar la carrera por un problema de disco, y la rotación quedaba
  atrapada ahí en silencio. En el único sistema operativo donde corre esto. También pasó a
  descriptor y `closeSync`. Hay tests que verifican que rote, que no parta un registro entre dos
  archivos, que no conserve un historial y que dos rotaciones en el mismo milisegundo no se pisen.

### Informe de carrera descargable

Botón "Descargar informe de carrera" en la vista de sanciones: un CSV con la clasificación, los
segundos de penalización de cada piloto, todas las sanciones y todos los incidentes revisados. Es
un CSV y no un PDF porque lo que el admin hace con esto es pegarlo en la planilla del campeonato.
Separado por `;` y con BOM: Excel en español parte por coma decimal, y sin BOM rompe los acentos
de los nombres de los pilotos en la primera fila.

**Lo que el informe no trae: tiempo total de carrera por piloto.** El UDP de AC no lo transporta —
`LAP_COMPLETED` manda el tiempo de *esa* vuelta y nada más—. Acumular vueltas daría un número
parecido al oficial y distinto, que es la peor clase de dato en un informe que decide un
campeonato. Por eso la clasificación es por progreso y los segundos de penalización van en su
propia columna, para sumarlos sobre el resultado del servidor.

### "Sancionar" en la bandeja no sancionaba

Resolver un incidente como *sancionado* solo cambiaba el estado del incidente. No se le avisaba al
piloto, no quedaba en la tabla de sanciones aplicadas, no se persistía y no sobrevivía a un
reinicio: la decisión del comisario se perdía.

Ahora hay un tercer motor de sanciones (`steward`) con sus propias reglas, separado de las de pit
lane para que cambiar la gracia de pit no altere lo que decide un comisario. Al sancionar se elige
**a quién** —un toque tiene dos pilotos y el servidor no sabe de quién fue la culpa— y **qué**:
penalización de tiempo, Drive-Through, Stop & Go o lastre. La sanción resultante se chatea al
piloto, aparece en la tabla, se persiste y se restaura.

Esto cerró además un pendiente viejo: `timePenaltySeconds` estaba definido desde la 0.1 y no se
usaba en ningún lado. Ahora es el tipo de sanción `TIME`, que es inmediata (no tiene nada que
"cumplir": son segundos al resultado final) y es la que alimenta la columna del informe.

La validación va **antes** de resolver: `resolve()` es irreversible, y un tipo de sanción inválido
dejaría un incidente marcado "sancionado" sin ninguna sanción detrás.

---

## Octava tanda: pedidos sobre el panel ya funcionando

### El auto se ve por su logo, no por su nombre

Un nombre obliga a leer; una forma constante se reconoce de un vistazo, que es para lo que existe
un logo. La columna "Auto" muestra el logo de la marca.

**El logo dejó de salir de la instalación de Assetto Corsa.** La idea anterior (leerlo de
`content/cars/<modelo>/ui/badge.png`) funcionaba, pero obligaba a que el admin tuviera el juego
instalado en la misma PC que el backend —que no es el caso de quien dirige la carrera sin
correrla— y a hurgar en el registro de Steam para encontrarlo. Ahora viene una **biblioteca de 126
SVG empaquetada con la app**, armada con los sets MIT `car-brand-logos` y `car-makes-icons`
(ninguno de los dos alcanza solo: al primero le faltan Lamborghini y Ford, al segundo Pagani,
Lancia y Alpine). Procedencia y cómo actualizarla, en `server/src/api/public/brands/LEEME.md`.

Las marcas que no están —Lancia, Pagani, Praga, KTM, Tatuus y unas cuantas de competición— caen a
un **escudo con el monograma** de la marca en un color derivado del nombre. El backend decide cuál
de las dos cosas va y manda `brandLogo: null` cuando no hay archivo: así el panel dibuja el escudo
de una, en vez de pedir una imagen, esperar el 404 y reemplazarla —que se veía como un parpadeo en
cada fila de auto mod—. RUF y Shelby llevan el logo de la marca sobre la que están construidos.

### "Carrera en curso" se nota

Dada la luz verde, la banda de largada se enciende con un borde verde y un indicador pulsante.
Antes el único cambio era el texto del semáforo, que es exactamente lo que no se ve de reojo
desde una segunda pantalla. La animación respeta `prefers-reduced-motion`.

El botón de reset pasó a llamarse **"Reiniciar largada"** y explica qué hace al pasar el mouse:
vuelve el semáforo a "Esperando" y apaga el control de velocidad de formación, para rearmar una
largada abortada. No borra las sanciones ya emitidas ni toca el servidor de Assetto Corsa.

### El mapa en vivo muestra las condiciones de la sesión

Arriba del trazado: circuito y variante, nombre y tipo de sesión, duración, clima, temperatura de
aire y pista, y agarre. Abajo, el **tiempo restante** en grande, que se pone ámbar sobre el final.

**No hay viento ni hora del juego, y no es un olvido: no existen en Assetto Corsa.** Son campos de
ACC. La `SPageFileGraphic` de AC termina en `mandatoryPitDone`. Poner esas columnas con un "--"
permanente sería peor que no ponerlas: parecería que algo está mal configurado.

### Menos preguntas en el cajón de reglas

Se sacaron las que un admin no sabe cómo responder y que estaban puestas por completitud, no por
necesidad: el umbral de "registrar desde (km/h)" de toques y choques en solitario (sigue en la
config, con su valor por defecto), y el aviso de ganancia de tiempo en salidas de pista.

**Las banderas azules se quitaron por completo**, no se escondieron. Detectar "retención" con el
spline y un contador de segundos produce falsos positivos en cualquier curva lenta con tren de
autos, y un detector que sigue llenando la bandeja sin forma de configurarlo es peor que no
tenerlo. Se borró el vigía, su configuración y sus tests.

### El ejecutable dice "Race Control"

El `.exe` muestra el logo en el Explorador, y SmartScreen y el Firewall dicen "Race Control" en vez
de "node" — que es el momento exacto en el que un admin no técnico desconfía y cierra todo.

El intento de la 0.2.1 corría `rcedit` sobre el `.exe` ya armado por pkg y corrompía su payload
("Pkg: Error reading from file" al arrancar). El diagnóstico era correcto, la conclusión no: **el
problema era el orden, no la herramienta**. Ahora se marca el *binario base de Node* —antes de que
pkg le inyecte nada— y se le dice a pkg que use ese, con `PKG_NODE_PATH`. Como rcedit toca el PE
cuando todavía no hay payload, no hay nada que corromper. Verificado ejecutando el `.exe`
resultante desde una carpeta nueva, que es el escenario que destapó los bugs de la 0.2.1.

El `.ico` multi-resolución (16 a 256 px) se genera de `brand/icon.svg` y se versiona, para que
empaquetar no dependa de tener un rasterizador instalado.

### Los puertos UDP se configuran, y el desajuste se avisa

Un hosting real (EmperorServers) llegó con `udp_plugin_local_port=8008` ya puesto en su panel. Race
Control asumía 11000/12000 **y no tenía dónde cambiarlos**: estaban en la config y en ninguna
pantalla. El resultado habría sido el peor modo de fallo posible — telemetría entrando perfecta,
los cuatro chequeos en verde, y ni una sanción llegando nunca al servidor, sin nada en pantalla que
apuntara a la causa.

Dos cosas, entonces:

- Los dos puertos del lado de Assetto Corsa se editan en **Conexión → Puertos**. El texto para
  pegar en el `server_cfg.ini` se regenera con los valores nuevos, así que las dos puntas siguen
  coincidiendo solas.
- El diagnóstico compara el puerto **desde el que habla** el servidor contra el puerto al que le
  mandamos, y si no coinciden lo dice en rojo con los dos números y las dos formas de arreglarlo.

Esto último se apoya en un supuesto: que el acServer usa un solo socket para el plugin, y entonces
manda desde el mismo puerto que declara en `UDP_PLUGIN_LOCAL_PORT`. Es lo que hacen las tres
implementaciones de referencia, pero no está verificado contra un servidor real — anotado como tal
en `docs/spike-protocolo.md`, con dónde desactivarlo si resulta que no.

### Exigir la app del piloto ahora es una decisión, no un hecho consumado

`presence.enforce` existía en la config desde la primera tanda y **no estaba en ninguna pantalla**:
venía activado y la única forma de apagarlo era editar el `config.json` a mano, que es exactamente
lo que este proyecto existe para evitar. Con el default puesto, un piloto sin la app se iba del
servidor al minuto y el admin no tenía dónde cambiar eso.

Está en **Reglas → App de los pilotos**, junto con el tiempo de espera. Se descubrió revisando la
documentación contra el código: el README prometía que la app era opcional y el código no lo
cumplía. La corrección podía ir de los dos lados; se eligió el que le da la decisión al admin.

---

## Primera tanda: bloqueantes contra un hosting remoto

### El backend le hablaba a sí mismo

`acUdp.remoteHost` estaba fijo en `127.0.0.1` y no era configurable desde ningún lado: ni el
panel, ni el snippet, ni la guía lo tocaban. Contra un servidor en un hosting, **todo** el tráfico
saliente moría en loopback: el chat de penalización, los kicks, `/ballast` y el keepalive que abre
el pinhole de NAT del que depende la estrategia de red `"direct"`. El backend recibía telemetría
perfecta y no podía contestar absolutamente nada.

Esto explica, además, por qué la conectividad "directa" nunca podía funcionar sola: el pinhole se
abre mandando tráfico al servidor, y ese tráfico no salía de la PC.

- **Fix**: el servidor de AC se identifica solo. `adoptRemoteHostIfNeeded()` en
  `server/src/udp/client.ts` toma la dirección de origen del primer datagrama recibido y la adopta
  si la configurada sigue siendo loopback. El admin no tiene que saber la IP de su servidor, que
  era justamente la promesa del README ("ni una IP que tipear").
- Se adopta la dirección pero **no** el puerto de origen: el puerto de comandos es el que el admin
  declaró en `UDP_PLUGIN_LOCAL_PORT`, y ese es el valor autoritativo. El puerto de origen igual se
  registra en el journal, porque sería el dato que explicaría un fallo si alguna versión del
  servidor se comportara distinto. (En la prueba local el origen fue un puerto efímero, lo que
  confirma que adoptarlo a ciegas habría sido frágil.)
- El host detectado se persiste en `config.json`, así el siguiente arranque ya sale configurado.
- El panel ahora muestra **a dónde salen los comandos**, y lo marca en rojo si sigue en loopback
  mientras entra telemetría — el síntoma exacto de este bug. Se agregó también un campo manual
  para hostings que no se identifiquen solos.

### El modo sombra no frenaba los kicks

`PresenceWatchdog` llamaba a `udpClient.kick()` directo, sin pasar por `dispatchOrSuppress` y sin
dejar rastro en el journal. Con el modo sombra activado por defecto, la primera carrera de prueba
—el escenario que el README recomienda explícitamente— expulsaba a todo piloto sin la app
instalada a los 15 segundos. Lo contrario de lo que el panel promete, sin evidencia de qué pasó, y
en el momento de máxima desconfianza hacia la herramienta.

- **Fix**: el watchdog ya no conoce al `udpClient`. Recibe un `dispatchKick` que `index.ts` cablea
  con el mismo `dispatchOrSuppress` que usan las sanciones, así el modo sombra vale también acá y
  todo kick queda en el journal.
- Un solo kick por piloto por conexión. En modo sombra el kick se suprime, así que el piloto sigue
  conectado y la condición volvía a dispararse en cada tick: sin esto, el arreglo anterior habría
  inundado el journal con el mismo evento cada 5 segundos durante toda la carrera.
- Gracia configurable (`presence.graceSeconds`) y subida de 15 s a 60 s. Los 15 s anteriores eran
  **menores** que la ventana de auto-discovery (5 reintentos × 4 s): un piloto que activaba la app
  después de entrar al servidor era expulsado antes de poder recibir la dirección del backend.
- `presence.enforce` permite desactivar el kick por presencia sin apagar el resto del motor.

### Las sanciones de largada nunca se podían cumplir

`PitComplianceTracker` se instanciaba solo con el motor de pit, así que `markServed()` nunca se
llamaba para una sanción de formación. Con el default `penaltyType: "DT"`, un piloto sancionado en
la largada cumplía el Drive-Through correctamente y escalaba a DQ igual al agotar las vueltas de
gracia. El mensaje que recibía —"Tenés N vuelta(s) para cumplirla"— era literalmente falso.

- **Fix**: el tracker recibe ahora la lista de motores. El pit lane es físicamente uno solo: una
  sanción se cumple pasando por ahí, sin importar qué motor la emitió.
- La velocidad legal de pit se pasa explícitamente desde `config.pit`, en vez de leerse del motor
  que emitió la sanción — el límite del pit lane no cambia según por qué te sancionaron.

### El puerto de los pilotos no se abría

El mapeo UPnP del puerto TCP de clientes vivía dentro de la rama de fallo del UDP. El problema es
que el pinhole de NAT que hace entrar la telemetría UDP no abre nada para el TCP entrante de los
pilotos: con el UDP entrando "directo", la función retornaba temprano y ese puerto no se tocaba
nunca. El panel mostraba "directa / recibiendo" en verde mientras ningún piloto podía mandar
heartbeat — y todos terminaban kickeados por el watchdog.

- **Fix**: el puerto de clientes se mapea siempre, antes de cualquier otra cosa.
- El panel separa ahora **"señal del servidor"** de **"pilotos reportando"**. Son dos cosas
  distintas que fallan por separado, y mostrarlas juntas era lo que hacía que el estado diera todo
  verde justo antes de que empezaran los kicks.

### Robustez de config

- `validateConfig` valida puertos y dirección remota, que antes no se validaban.
- Guarda contra un `config.json` con `null` o un escalar donde se espera un objeto: `mergeConfigInto`
  solo recursa cuando ambos lados son objetos, así que lo copiaba tal cual y el arranque moría con
  un `TypeError` al leer un campo anidado.

### Verificación

El host remoto se probó end-to-end simulando un servidor de AC que manda un `NEW_SESSION` desde la
IP de LAN: el backend lo detectó, lo persistió y lo registró en el journal. El cumplimiento de
sanciones de largada y el modo sombra del watchdog se verificaron con un script contra el código
compilado (7 casos, incluido el negativo de pasar por el pit por encima del límite).

Para la segunda tanda, además de los 18 tests: un servidor de AC falso mandando tráfico UDP real
(sesión, tres pilotos, dos vueltas de telemetría, un toque entre autos y un trompo de 15 impactos)
contra el backend corriendo. Resultado: dos incidentes en la bandeja y no dieciséis —el toque
unificado con las dos perspectivas y clasificado como trompa contra cola, el trompo agrupado con su
contador—, el circuito aprendido y guardado en disco, el kick manual ejecutado y los automáticos
suprimidos por el modo sombra. El panel se verificó en Chromium a 1920×1080 y 1366×768: sin scroll
de página en ninguna de las dos vistas, sin errores de consola, el trazado efectivamente dibujado
en el canvas, y la doble confirmación del kick armando y desarmándose sola.

## [0.2.3] — 2026-10-09

Tercer intento sobre el mismo síntoma — esta vez probado con un navegador real (Playwright +
Chromium headless) en vez de solo `curl`, que fue lo que había dejado pasar el bug real dos veces
seguidas.

- **Causa real (por fin)**: el CSS de `#wizard-overlay` le ponía `display: flex` de forma
  incondicional. Esa regla de autor le gana en el cascade a la regla nativa del navegador para
  `[hidden]` (`display: none`), así que el atributo `hidden` se seteaba perfecto desde JS pero el
  modal nunca desaparecía visualmente — los dos fixes anteriores (0.2.1, 0.2.2) eran correctos
  pero no podían arreglar algo que estaba roto en el CSS, no en la lógica.
  **Fix**: `#wizard-overlay[hidden] { display: none; }` (`server/src/api/public/index.html`).
- Verificado con capturas de pantalla reales: wizard se cierra al guardar, se mantiene cerrado
  tras recargar la página, y el resto de los botones del panel (formación, reset, modo sombra,
  guardar reglas) funcionan sin errores de consola.

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
