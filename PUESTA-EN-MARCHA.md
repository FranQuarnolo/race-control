# Puesta a punto, de cero a una carrera dirigida

Este documento es el mapa completo: qué es cada pieza, quién la pone a punto, en qué orden, y qué
tiene que pasar para saber que quedó bien. Está escrito para vos —quien opera Race Control—, no
para el admin de una liga.

Si solo querés saber qué hace el producto, el [README](README.md) alcanza. Si ya desplegaste y
buscás un comando puntual, está en [docs/operacion.md](server/docs/operacion.md).

---

## 1. Cómo funciona, en un párrafo

Un servidor de Assetto Corsa puede mandarle a un programa externo, por UDP, todo lo que pasa en la
pista: quién entró, a qué velocidad va cada auto, dónde está, quién chocó contra quién, quién cerró
una vuelta. Y acepta órdenes por ese mismo canal: mandar un mensaje al chat, echar a alguien,
ponerle lastre. Race Control es ese programa externo. Se queda escuchando, arma con eso una
pantalla de dirección de carrera, y manda de vuelta las sanciones.

Lo que el UDP **no** transporta —tiempos por sector, neumáticos, combustible, ruedas afuera de
pista— solo existe dentro del juego, en la PC de cada piloto. Por eso hay una app de Content
Manager que lo reporta. Esa app es opcional en el sentido técnico y obligatoria por configuración:
de fábrica, quien no la tiene es expulsado al minuto.

### El recorrido de un dato

```
servidor de Assetto Corsa  ──UDP──►  worker de esa liga  ──►  panel del admin
      (el hosting)                   (un proceso)              (el navegador)
            ▲                              │
            └──────────UDP─────────────────┘   sanciones, chat, kicks

app del piloto  ──HTTP────►  worker de esa liga        sectores, neumáticos, ruedas afuera
  (en el juego)                                        y el ping
```

El portal está adelante de todo eso: resuelve quién sos, a qué liga pertenecés, y hace de
intermediario con el worker que te corresponde. Los datagramas UDP **no** pasan por el portal: cada
worker tiene su propio puerto y los recibe directo.

---

## 2. Las piezas y quién pone a punto cada una

| Pieza | Quién | Cuándo | Cuánto lleva |
|---|---|---|---|
| El servidor (Fly.io, IP dedicada, volumen) | Vos | Una vez | ~20 min |
| La cuenta de operador | El propio portal, en el arranque | Una vez | automático |
| El alta de cada liga | Vos, desde `/operador` | Por cliente | 1 min |
| El pedido al soporte del hosting | El admin de la liga | Una vez por liga | 2 min |
| La app en Content Manager | Cada piloto | Una vez por temporada | 2 min |
| Las reglas del campeonato | El admin | Cuando quiera | — |

Lo importante de esa tabla: **lo único que no podés hacer vos es el cuarto renglón.** La
configuración del plugin UDP vive en el hosting de esa liga, y ahí solo entra quien lo contrató.

---

## 3. Poner a punto el servidor

Hace falta una cuenta de [Fly.io](https://fly.io) con tarjeta cargada (la IPv4 dedicada se cobra
aparte, unos 2 USD al mes) y el `flyctl` instalado.

### 3.1 Crear la app y el volumen

```bash
cd server
fly launch --no-deploy        # decile que NO al Postgres y al Redis
fly volumes create rc_data --size 3 --region gru
```

El `fly.toml` del repo ya trae todo lo demás resuelto: la región, el volumen montado en `/data`,
los snapshots diarios, los diez puertos UDP y el puerto HTTP.

### 3.2 La IPv4 dedicada — el paso que no se puede saltear

```bash
fly ips allocate-v4
```

**Sin esto no llega un solo datagrama.** La IP compartida de Fly no enruta UDP, y el síntoma es
silencio absoluto: el HTTP anda perfecto, el panel abre, todo se ve bien, y la telemetría nunca
aparece. Es el error más caro de diagnosticar de toda la instalación, así que es el primero que
conviene descartar.

El comando imprime una IPv4. Esa IP **es el dato que después ve cada admin** para pegar en su
hosting.

### 3.3 Los tres secretos

```bash
fly secrets set RC_PUBLIC_IP=<la ipv4 que haya salido>
fly secrets set RC_OPERATOR_EMAIL=vos@ejemplo.com
fly secrets set RC_CONTACT=mailto:vos@ejemplo.com
fly deploy
```

- `RC_PUBLIC_IP` es lo que el portal le muestra al admin. Si queda vacío, el portal arranca igual
  pero avisa en el log que no tiene qué mostrarle a nadie.
- `RC_OPERATOR_EMAIL` crea tu cuenta en el primer arranque.
- `RC_CONTACT` es **a dónde te escribe un admin cuando se queda afuera**. Es la dirección que
  aparece en la recuperación de contraseña, en la pantalla de una cuenta desactivada, en el botón
  principal de la landing y en dos chequeos del diagnóstico. Vale un `mailto:` o un link de Discord
  o Telegram (`https://`); cualquier otro esquema se ignora a propósito.

  Sin esto el portal arranca igual y ninguna pantalla queda rota —todas caen a "pedísela a quien te
  dio el acceso", que sigue siendo verdad— pero quien perdió la contraseña no tiene a dónde ir y el
  cierre de la landing se queda sin su botón. Vale los treinta segundos que cuesta ponerlo.

### 3.4 Tu contraseña sale en el log, una sola vez

```bash
fly logs | grep -A3 "Cuenta de operador creada"
```

Guardala donde guardes tus contraseñas. No se vuelve a mostrar: en disco queda solo el hash. Si se
pierde, hay que parar la máquina y regenerarla por CLI.

Si preferís elegirla vos, `fly secrets set RC_OPERATOR_PASSWORD=...` antes del primer arranque. La
contrapartida es que queda guardada en los secrets de Fly.

### 3.5 Comprobar que quedó bien

Tres chequeos, y el tercero es el que importa:

```bash
fly logs                                   # "escuchando en :8080"
fly ips list                               # tiene que haber una v4 "dedicated"
curl -I https://race-control.fly.dev/      # 200
```

```bash
# El de verdad: que entre UDP. Contra el puerto de una liga de prueba, NO de una liga real.
printf 'x' | nc -u -w1 <la-ipv4> 30000
fly logs      # "Servidor de AC detectado en <tu ip>" = el datagrama cruzó. Es la prueba.
```

El HTTP puede estar impecable con el UDP roto. Son dos caminos distintos y fallan por separado.

⚠️ **Hacelo solo contra una liga descartable.** El motor adopta como servidor de Assetto Corsa la
dirección del primer datagrama que le llega, y esa adopción **queda escrita**: después de la prueba,
esa liga apunta a la IP de tu casa y ya no va a adoptar la del servidor real. Es lo correcto —si
adoptara al último que habla, cualquiera podría secuestrar la liga mandando un paquete—, pero
significa que la liga que uses para probar hay que darla de baja y crearla de nuevo antes de
entregársela a nadie.

---

## 4. Dar de alta una liga

Entrá a `https://race-control.fly.dev/login` con tu cuenta de operador. Vas a caer en `/operador`.

1. **"Dar de alta una liga"**: nombre de la liga, email del admin, y —si ya te pagó— hasta cuándo.
2. El portal devuelve **la dirección, el usuario y la contraseña**, con un botón para copiar los
   tres juntos. **Se muestran una sola vez.**
3. Pasáselos por donde ya hablás con esa persona.

Mirá el contador de **lugares libres** antes de prometer una liga nueva: cada una ocupa un puerto
UDP de los diez declarados en `fly.toml`, y cuando se acaban el alta falla. Ampliarlo está en
[operacion.md](server/docs/operacion.md#ampliar-el-rango-de-puertos-udp) y requiere un `fly deploy`.

---

## 5. Lo que hace el admin de la liga

En realidad no le tenés que explicar nada: desde la **1.0**, el cajón de **Conexión** arranca con
el manual escrito adentro y es **un solo paso**. Esto es lo que dice.

1. Entra con el usuario y la contraseña que le pasaste.
2. Toca **"Copiar el mensaje para mi hosting"** y lo pega en el ticket de soporte de su hosting.
   Es el pedido ya escrito en inglés, con la dirección de su liga adentro: que configuren el
   plugin UDP del servidor de Assetto Corsa apuntando ahí.
3. **Cuando le confirmen, reinicia el servidor de Assetto Corsa y entra una vez con el juego.**
   Sin reiniciar no pasa nada, porque el servidor lee su configuración una sola vez, al arrancar.
   Y sin que entre alguien tampoco: el servidor solo habla cuando pasa algo.
4. La pantalla se pone verde sola cuando llega el primer paquete.

Nada de esto le pide su IP, ni puertos, ni abrir nada en su router, ni buscar un campo en un panel.

**Hasta la 0.9 el paso 2 era otro**: copiar la dirección y pegarla él mismo en el campo
**"Send Address"**, dentro de **"Server Options"**. Se sacó porque en los hostings que usamos ese
campo no existe —vienen con los plugins UDP apagados de fábrica y la sección directamente no se
dibuja—, así que el manual lo mandaba a buscar algo que no estaba y el camino real quedaba
escondido como nota al pie. **Si su hosting sí lo muestra**, puede saltearse el ticket: la
dirección completa, con puerto, está en **Conexión → Estado**, en la fila "La dirección de tu
liga". En paneles viejos ese campo se llama `UDP Plugin Address` o `udp_plugin_address` — son el
mismo campo con tres nombres, lo renombraron en Assetto Corsa Server Manager 2.4.8. La guía
completa, con dónde está en cada panel conocido, sigue adentro del producto en
**Conexión → "Ver la guía completa"**.

**Lo que no hay que tocar** es el campo de al lado, "Listen Address". Race Control deduce ese
número solo, del propio tráfico que manda el servidor.

**El nombre de su liga no lo cambia él**: en su panel el campo es de solo lectura y dice que te lo
pida. Lo cambiás vos desde `/operador` → "Editar". Es así porque el motor toma el nombre del portal
cada vez que arranca: si el admin lo editara, su cambio volvería solo en el próximo reinicio.

### Si no encuentra el campo

Es el problema más frecuente después de "no reinicié el servidor", y tiene una causa concreta: en
Assetto Corsa Server Manager el soporte de plugins se apaga entero desde el `config.yml` del panel
(`disable_plugins`), y cuando está apagado **la sección no se dibuja**. No está en otra pestaña: no
está. Ese archivo lo maneja el hosting.

La salida es un ticket al soporte, y desde la **0.7** el admin no lo escribe: en **Conexión**, el
paso 2 tiene un botón, **"Copiar el mensaje para mi hosting"**, que arma el texto completo —en
inglés, porque así contestan— con la dirección de su liga ya adentro y el pedido de autorización de
salida incluido. Lo pega en el ticket y listo. No hay nada que explicarle ni que traducirle.

**Y funciona: está confirmado con EmperorServers el 26/10/2026.** Conviene saber cómo contestan,
porque la respuesta no es la que uno espera:

- **No habilitan el campo: configuran el plugin ellos.** No te devuelven un panel con la sección
  dibujada, te devuelven el plugin ya apuntando a donde les dijiste. El renglón del paso 3 va en el
  ticket, no en ninguna pantalla.
- **Te contestan con la dirección del plugin** (algo como `172.233.26.106:9811`) y con la línea del
  log del servidor que lo confirma. **Esa dirección no se pega en ningún lado.** Es a dónde Race
  Control manda sus comandos, y la deduce sola del primer paquete que recibe: en modo portal el
  panel ni siquiera muestra un campo donde ponerla, a propósito.
- **Dejan un allowlist de una sola IP.** El plugin acepta comandos únicamente desde la IP que
  figura en el ticket, que es la IPv4 dedicada de la app. Esto importa para después: **si esa IP
  alguna vez cambia, hay que volver a abrir un ticket**, porque el plugin va a seguir mandando
  telemetría pero va a descartar en silencio todo lo que Race Control le conteste — chat,
  credenciales de los pilotos, kicks y lastres. Es el modo de falla más engañoso de toda la cadena:
  la pantalla se ve verde y nada de lo que el panel decide llega al juego.

Una vez configurado el plugin, el arranque no es instantáneo y no es un problema: Race Control
necesita **recibir** un paquete antes de poder **mandar** uno, porque hasta ese momento no sabe la
dirección del servidor. Y el servidor de Assetto Corsa solo habla por su cuenta cuando pasa algo:
cambia la sesión o entra alguien. Así que después del ticket hay que **entrar al servidor con el
juego** —o reiniciarlo— para que salga el primer paquete. De ahí en más el keepalive pide la
telemetría cada 20 segundos y la pantalla se pone verde sola.

**Y editar el `server_cfg.ini` a mano no es una alternativa**, aunque el panel lo deje ver: el
Server Manager regenera ese archivo desde su base en cada arranque, así que el cambio se pierde en
el reinicio siguiente — que es el paso justo después. Por eso varios paneles lo muestran en solo
lectura, y por eso Race Control dejó de ofrecer las dos líneas para pegar ahí: era un consejo que
fallaba en silencio.

### Incrustarlo en su propia página (desde la 1.14)

Si el admin ya tiene una página de administración propia (el caso real: `fslmanager.vercel.app`),
no hace falta que use Race Control como producto aparte. En **Conexión**, debajo del manual de
conexión, hay una sección **"Embed externo"** con tres pasos:

1. **Pega la dirección de su página** (ej. `https://fslmanager.vercel.app`) en "Guardar origen".
   Sin esto, el embed no le contesta a nadie — es a propósito.
2. **"Generar/Regenerar token"** arma un token propio de su liga. Regenerar invalida el anterior al
   instante: si alguna vez lo filtra sin querer, no hace falta avisar a nadie, alcanza con tocar ese
   botón de nuevo.
3. **"Copiar código"** le da el `<div>` + `<script>` listo para pegar en su página. Eso es todo lo
   que tiene que tocar del lado de él; no requiere su propio despliegue de nada.

Explicale que ese token **no es una contraseña de las que repartís vos**: vive en el código fuente
de su página, visible para cualquiera que la abra, y por eso el embed solo deja leer el estado de
SU liga, resolver incidentes, aplicar/anular sanciones y controlar la largada — nunca reconfigurar
reglas, ver el SteamID de un piloto ni nada del resto del panel. El mapa, los tiempos y los
neumáticos tampoco están ahí: siguen en el producto completo, al que sigue entrando con su usuario
y contraseña de siempre.

---

## 6. La app de los pilotos

Una vez por temporada, por piloto:

1. Abrir Content Manager.
2. Arrastrar `RaceControlClient.zip` a la ventana, como cualquier mod.
3. Activar las ventanas en el juego: menú de Apps → **RC Mensajes**, **RC Banderas**, **RC
   Largada** y **RC Alerta**.
4. Acomodarlas en pantalla. Esto hay que hacerlo **una sola vez** y conviene hacerlo antes de la
   primera carrera, no durante.

Son entradas separadas desde la **0.8** —cuatro desde la **1.3**— y cada piloto activa las que
quiera:

| Ventana | Qué muestra |
|---|---|
| **RC Mensajes** | De arriba abajo: el estado de la conexión en gris chiquito, el contador de cortes (`CUTS: 3/5`) en amarillo y grande, la sanción pendiente en naranja, y los avisos de dirección de carrera en rojo. |
| **RC Banderas** | Un cuadro de color con la bandera vigente: amarillo (parpadeando), azul, negro, blanco, el tablero de cuadros o el círculo naranja de la de penalidad. Y el verde, los 3 segundos que siguen a la largada. |
| **RC Largada** | Cinco luces. Rojas parpadeando durante la formación, verdes con el aviso sonoro al verde, y después nada. |
| **RC Alerta** | Un marco rojo pulsante, solo cuando falta la credencial. |

**Desde la 1.1 son transparentes y no tienen barra de título.** En reposo no se ve ninguna. Para
moverlas o redimensionarlas, pasales el mouse por encima y el marco vuelve a aparecer.

**Desde la 1.3 eso vale también para RC Banderas**, que hasta la 1.2 mostraba un cuadro verde
siempre que no hubiera bandera. Sonaba razonable —"pista despejada" también es información— y en
pista resultó al revés: el verde estaba el 95% de la carrera, incluida la vuelta de formación
entera. Ahora el verde aparece solo cuando se da el verde, y la amarilla parpadea.

**El contador de cortes** sube en el instante del corte, con una chicharra, sin esperar a que el
piloto cruce meta; el servidor corrige el número en el poll siguiente. Se oculta en cero, así que
desaparece solo después de cada sanción.

**No hace falta tener ninguna abierta para que Race Control funcione.** Alcanza con que la app esté
instalada y activada: el reporte de telemetría y la señal de presencia salen igual. Cerrar una
ventana solo deja de dibujarla.

No hay nada que configurar adentro. Cuando el piloto entra al servidor, Race Control le manda por
el chat del juego —solo a su auto— la dirección a la que reportar y una credencial firmada que
dura 24 horas. La app las lee sola.

Si a alguien le aparece **"Credencial vencida: volvé a entrar al servidor"** —y, desde la 1.3, el
marco rojo de **RC Alerta**—, es literal: sale, vuelve a entrar, y recibe una nueva. El marco se
apaga solo en cuanto la credencial nueva funciona.

**Al que le falta la app se le avisa antes de echarlo.** Con "Exigir que todos la tengan" activado
(Reglas → App de los pilotos), el piloto recibe dos mensajes por el chat del servidor —a los 45 y
a los 15 segundos del final de la espera— con la cuenta regresiva, y recién después el kick. En
modo sombra no sale ninguno de los dos: anunciar una desconexión que no va a pasar es peor que no
avisar nada.

**El límite, para que no sorprenda:** a quien **no tiene la app instalada** no se le puede dibujar
nada dentro del juego, porque el overlay *es* la app. El chat del servidor y después el kick son
los dos únicos canales que le llegan. El marco rojo solo lo ve quien ya la tiene corriendo.

---

## 7. El día de carrera

El admin abre el panel y lo deja en una segunda pantalla. De arriba a abajo:

- **La banda de largada**: iniciar formación, verde, reiniciar. El semáforo se pone en verde con
  aviso sonoro para todos los pilotos que tengan la app. Desde la **0.8** se atenúa y se
  deshabilita en práctica y clasificación, porque la largada es cosa de la carrera. "Reiniciar"
  queda siempre disponible: es la salida de emergencia.
- **La torre de tiempos**: posición, auto, velocidad, vueltas (`Laps`), última y mejor vuelta,
  paradas, compuesto, combustible y ping. Un click en un piloto lo resalta en el mapa; los tres
  puntitos del final de la fila abren el kick, que pide confirmación. **PIT** aparece tanto en la
  columna de velocidad como en la de paradas cuando el auto está en el pit lane.

  Desde la **1.1** no están las columnas **Fuera** ni **Sectores**: los cortes se cuentan por
  piloto en la bandeja de incidentes, que es donde se los juzga, y los sectores no estaban
  llegando bien —una columna que muestra guiones es peor que no tenerla—.

  Desde la **1.2** la torre es de **toda la jornada**: el que apareció en práctica sigue en la
  tabla en clasificación y en carrera. Si se desconecta, su fila queda en gris con sus tiempos y
  sin posición; si vuelve —aunque el servidor le dé otro slot— recupera su fila. Los tiempos y las
  vueltas se resetean con cada sesión, como siempre. Al terminar la carrera aparece
  **"Posiciones finales"** en el título de la torre: es el mismo informe que la pestaña Sanciones,
  a mano cuando hace falta.

  Tres de esas columnas —Box, Neum. y Comb.— y el ping **solo las puede llenar la app del
  piloto**: son datos de la Shared Memory del juego y el protocolo UDP del servidor no los
  transporta. Si ningún piloto la tiene, la columna de Ping no se muestra y al lado del título
  aparece una chapa gris que dice **"ningún piloto con la app"**; clickearla abre el diagnóstico.
- **El mapa en vivo**: el circuito viene dibujado. Desde la **0.8** los trazados viajan con Race
  Control, así que el mapa sale completo apenas el servidor dice en qué pista está, sin esperar a
  que nadie dé vueltas. Al lado del reloj hay una chapa grande que dice **P**, **Q** o **R** según
  el tipo de sesión —gris, ámbar o verde: el color dice cuánto pesa la sesión—. Desde la **1.2**
  cada auto del mapa se pinta del color de su marca (Ferrari rojo, BMW azul, Porsche celeste y así
  con el resto); el seleccionado sigue en blanco y el que perdió telemetría, hueco. Una pista mod
  que no esté en el catálogo se sigue aprendiendo de la telemetría, como antes, y el cartel lo
  aclara.
- **Incidentes**: los hechos de la carrera agrupados por piloto, con un contador por tipo —Cuts,
  Choques y, desde la **1.3**, **Pit** y **Largada** para los excesos de velocidad—. Los dos
  nuevos van aparte y no adentro de "Otros" porque son hechos medidos: mezclarlos con una
  desconexión perdería el dato. Qué se registra de cada tipo se elige en Reglas; **cuánto cuesta**
  pasarse de velocidad se sigue configurando en las secciones de Pit lane y de Largada, que es
  donde están los km/h y la tolerancia.
- **Sanciones**: lo que se aplicó solo y lo que aplicó el comisario, más "Descargar informe de
  carrera" al terminar.
- **Reglas**: qué se controla en pista y, arriba de todo, los **perfiles de carrera**. Un perfil
  guarda el reglamento completo con el nombre que la liga use para hablar de él, y cargarlo lo
  repone entero. No toca nada de la conexión: elegir un perfil no puede desconfigurar el servidor.

**Para las primeras carreras, dejá el modo sombra prendido.** Registra todo y no sanciona a nadie
de verdad: sirve para mirar un fin de semana entero qué habría hecho el motor antes de confiarle el
campeonato. El kick manual del admin se ejecuta igual, porque es una orden explícita y ya está
supervisada.

El switch está en **Conexión → "Modo de funcionamiento"** (desde la 0.7; antes estaba en la barra
de arriba).

**Ojo con esto al operar.** Entre la 0.7 y la 0.9 la barra mostraba un cartel ámbar mientras el
modo estuviera activo; en la **1.0** se sacó y el modo quedó entero adentro del cajón. O sea que
ahora **un panel en sombra y uno sancionando de verdad se ven exactamente igual**: las sanciones
se anotan, nadie las cobra, y no hay nada en pantalla que lo diga. Si vas a dejar una liga en
sombra, anotalo donde lo vayas a volver a leer, y chequealo en el cajón antes de la primera fecha
que cuente para el campeonato.

---

## 8. El mes a mes

Las acciones de cada fila están en el menú **⋮** de `/operador`.

| Cuándo | Qué |
|---|---|
| Cuando alguien paga | "Cobré": suma un mes desde donde venía |
| Cuando alguien no paga | "Desactivar". Para su liga y le corta el acceso. **No borra nada** |
| Cuando vuelve a pagar | "Reactivar". La liga arranca con todo adentro |
| Si pierde la contraseña | "Clave nueva". Se le cierran todas las sesiones abiertas |
| Si hay que corregir algo | "Editar": nombre de la liga, dirección, email y contraseña. Ver abajo |
| Si hay que ver qué corrió | "Ver historial": una fila por sesión, con el detalle y la opción de borrarla |
| Antes de algo riesgoso | `fly volumes snapshots create <volume-id>` |

"Editar" manda solo lo que cambiaste. Dos de los cuatro campos tienen consecuencias y
el panel las avisa antes de guardar: cambiar el **nombre** reinicia el motor de esa liga —unos
segundos sin telemetría, así que no lo hagas en mitad de una carrera— y cambiar la **dirección**
mata el link anterior, el del panel y el de los pilotos. El email y la contraseña no reinician
nada; la contraseña, además, se puede dejar vacía para no tocarla.

La tabla del panel viene ordenada por lo que requiere atención: primero lo vencido, después lo que
vence esta semana. **Nada se da de baja solo**: una cuota vencida se pinta en rojo y espera tu
decisión, porque cortarle la liga a alguien a mitad de campeonato no es algo que deba hacer un
temporizador.

### Publicar una versión nueva

```bash
cd server
npm test                     # tiene que dar todo verde antes de tocar producción
fly deploy
```

El despliegue reinicia la máquina, así que reinicia todos los workers. Las sanciones y los
incidentes se reconstruyen solos desde el journal al arrancar, pero **no se despliega en medio de
una carrera**: hay unos segundos en los que no se escucha telemetría.

### Poner las capturas en la landing

La página pública tiene cuatro huecos grises donde van las fotos del panel. Para llenarlos:

1. Dejar los PNG en `server/src/portal/public/capturas/` con estos nombres:

   | Archivo | Dónde sale | Proporción |
   |---|---|---|
   | `control-de-carrera.png` | arriba de todo y en la sección "Control de carrera" | 2880 × 1400 |
   | `sanciones.png` | sección "Incidentes y sanciones" | 2880 × 1400 |
   | `reglas.png` | sección "Reglas" | 2880 × 1580 |
   | `conexion.png` | sección "La app de los pilotos" | 2880 × 1120 |

2. En `server/src/portal/public/index.html`, cambiar cada `<div class="sin-imagen">` por el `<img>`
   correspondiente. El `aspect-ratio` que tiene hoy el hueco es la proporción que espera esa foto,
   así que si la captura respeta esa medida la página no se mueve ni un pixel.

3. `npm run build` y `fly deploy`.

La proporción no tiene que ser exacta al pixel —las medidas de la tabla son el tamaño con el que se
tomaron las originales— pero cuanto más cerca, menos se recorta. El atajo para sacarlas: `node
dist/sim/demo.js` levanta el panel con una carrera inventada adentro, en
[http://127.0.0.1:3900](http://127.0.0.1:3900), sin necesidad de Assetto Corsa.

---

## 9. Cuando algo no anda

| Síntoma | Causa más probable | Dónde mirar |
|---|---|---|
| La pantalla de conexión nunca se pone verde | No reinició el servidor de AC después de que el hosting lo configuró | Es la causa número uno. Preguntarlo antes que nada |
| El soporte del hosting dice que ya está y sigue en rojo | Lo configuraron pero no reiniciaron el servidor de AC, o nadie entró nunca con el juego | El servidor lee su configuración al arrancar, y solo habla cuando pasa algo. Ver §5 |
| Ninguna liga recibe nada, nunca | Falta la IPv4 dedicada | `fly ips list`: tiene que decir "dedicated" |
| Una liga sí y otra no | El puerto UDP de esa liga no está declarado en `fly.toml` | El bloque `[[services]]` de ese puerto |
| Entra telemetría pero las sanciones no llegan | Se bindeó a `0.0.0.0` en vez de `fly-global-services` | `RC_UDP_BIND` |
| Todo verde y el servidor igual descarta | El hosting tiene allowlist de IPs para el plugin UDP | Agregar la IP del servidor a esa lista. Falla en silencio |
| Una liga aparece "con problemas" | `EADDRINUSE` (worker zombi) o cinco caídas seguidas | `fly logs \| grep "liga:"` |
| Un piloto no aparece con sus sectores | No tiene la app, o le venció la credencial | Que salga y vuelva a entrar al servidor |
| **Nadie** tiene sectores, neumáticos ni combustible | Ningún piloto tiene la app reportando. El panel lo dice con la chapa "ningún piloto con la app" | Primero confirmar que la app está instalada; si está, es que no llega el anuncio por chat — revisar "Órdenes hacia el servidor" en el diagnóstico |
| El admin no puede entrar | Cuenta desactivada, o la contraseña vieja tras un reset | La columna de estado en `/operador` |

Adentro del panel hay un diagnóstico propio: **Conexión → "¿Algo anda mal?" → "Revisar ahora"**.
Chequea las cuatro cosas que tienen que funcionar y dice qué hacer con la que falle.

Si nada de eso alcanza, el journal de cada liga es un JSON por línea y responde la pregunta difícil
("¿por qué se sancionó a este piloto?"):

```bash
fly ssh console
tail -f /data/leagues/<id>/logs/events-*.jsonl
```

---

## 10. Probarlo entero sin Fly y sin Assetto Corsa

Para desarrollar, o para mostrarle el producto a alguien sin tocar producción.

```bash
cd server
npm install
npm run build    # compila TypeScript y copia los estáticos a dist/
npm run dev      # lo mismo pero recargando solo al guardar
npm test         # compila y corre los tests
```

**El portal completo, en tu máquina:**

```bash
export RC_DATA_ROOT=./datos RC_PUBLIC_HOST=localhost:8080 RC_PUBLIC_IP=127.0.0.1 \
       RC_INSECURE_COOKIES=1 RC_OPERATOR_EMAIL=yo@ejemplo.com \
       RC_CONTACT=mailto:yo@ejemplo.com
PORT=8080 node dist/portal/index.js
```

La contraseña sale en la consola. Después, `http://localhost:8080/operador` y todo igual que en
producción. `RC_INSECURE_COOKIES=1` apaga el prefijo `__Host-`, la marca `Secure` y la redirección
a HTTPS, que sin certificado harían imposible entrar: **nunca en producción**.

**El panel con una carrera adentro**, sin servidor de Assetto Corsa:

```bash
node dist/sim/demo.js        # http://127.0.0.1:3900
```

Diez pilotos, un circuito, incidentes en la bandeja y sanciones en curso. De ahí salen las capturas
de la landing, y por eso está versionado: cuando el panel cambie, se vuelve a correr y las imágenes
quedan al día.

**Reproducir tráfico real capturado:**

```bash
node dist/sim/replay.js      # relee un raw.bin contra el motor
```

---

## 11. A dónde seguir

| Si querés… | Leé |
|---|---|
| Entender cómo está armado por dentro | [docs/portal.md](server/docs/portal.md) |
| Un comando de operación puntual | [docs/operacion.md](server/docs/operacion.md) |
| Saber qué ataques resiste y cuáles no | [docs/seguridad.md](server/docs/seguridad.md) |
| Lo que falta confirmar contra un servidor real | [docs/spike-protocolo.md](server/docs/spike-protocolo.md) |
| El porqué de cada decisión | [CHANGELOG.md](CHANGELOG.md) |
| Cómo funciona la app de los pilotos | [client-app/README.md](client-app/README.md) |
| Lo que todavía falta hacer o decidir | [13. Pendientes conocidos](#13-pendientes-conocidos) |

---

## 12. Lo que todavía no se probó

Vale la pena decirlo acá y no al final de un documento que nadie lee: **nada de esto corrió contra
un servidor de Assetto Corsa real todavía**. El camino completo se validó de punta a punta con
datagramas simulados —portal, worker, panel, y la app del piloto con su token—, pero los supuestos
del protocolo que todavía no se confirmaron en pista están enumerados, uno por uno y con qué hacer
si fallan, en [docs/spike-protocolo.md](server/docs/spike-protocolo.md).

El más importante de todos: que los datagramas del hosting efectivamente lleguen al puerto UDP de
Fly. Todo lo demás depende de eso.

---

## 13. Pendientes conocidos

Salieron de la auditoría completa del producto que se hizo en la 0.6. Lo que esa auditoría encontró
y se arregló está en el [CHANGELOG](CHANGELOG.md#06--2026-10-26); acá queda lo que **no** se arregló,
porque depende de una decisión o de algo que no está en el código.

### Lo que falta hacer una vez

| Qué | Dónde se hace | Qué pasa si no se hace |
|---|---|---|
| ~~Poner `RC_CONTACT`~~ | [3.3 Los tres secretos](#33-los-tres-secretos) | **Hecho el 26/10/2026**: quedó `quarnolofrancisco@gmail.com` en producción |
| ~~Generar el catálogo de trazados~~ | `server/scripts/build-track-catalog.js` | **Hecho el 26/10/2026**: 198 circuitos en `server/src/track/catalog/` |
| Las cuatro capturas de la landing | [Poner las capturas en la landing](#poner-las-capturas-en-la-landing) | La página pública muestra cuatro rectángulos grises justo donde promete "mirá qué clara es la pantalla". **Es el pendiente más urgente de esta lista.** |
| El video del README | comentario al pie de [README.md](README.md) | Nada se rompe; el `<img>` está comentado a propósito para que no quede una imagen rota |

Para **sumar circuitos** al catálogo más adelante alcanza con volver a correr el generador en una
PC que los tenga instalados. Si el juego está en otra máquina —que es lo normal— no hay que copiar
`content\tracks` entero ni instalar Node allá: se lleva `server/scripts/recolectar-trazados.ps1`,
botón derecho → *Ejecutar con PowerShell*, y deja un zip de pocos MB con lo único que el generador
lee. Está explicado en [server/src/track/catalog/README.md](server/src/track/catalog/README.md).

Y si una liga corre un mod que no está en el catálogo, **no hay que hacer nada urgente**: Race
Control vuelve solo al aprendizaje por telemetría y el panel lo dice. Los tres caminos para
arreglarlo bien están en
[operacion.md](server/docs/operacion.md#una-liga-corre-un-circuito-que-no-está-en-el-catálogo).

Las capturas conviene sacarlas ahora y no antes: el panel de la 0.8 ya tiene la columna de intervalo,
la zona de pit en ámbar, el botón de anular y la tabla con los anchos arreglados, así que lo que se
fotografíe hoy va a seguir siendo cierto por un buen rato. El atajo para sacarlas sin Assetto Corsa
está en la sección que linkea la tabla.

### Dos decisiones abiertas

**Qué hace el panel en un teléfono.** `html, body { overflow: hidden }` es deliberado y está bien
razonado para un monitor: todo entra en una pantalla y nada scrollea. En un teléfono significa que la
mitad del panel es inalcanzable y no hay forma de llegar a ella. No hace falta un panel móvil
completo, pero sí elegir una de dos: una vista reducida para mirar la carrera desde el celular, o un
cartel honesto que diga que esto se usa en una computadora. **Hoy no es ninguna de las dos**, que es
la única opción que está mal.

**Teclado y foco en los cajones.** Reglas y Conexión se declaran `aria-modal="true"` pero no atrapan
el foco, no lo devuelven al cerrar y no inertizan el fondo: con Tab se sale del diálogo hacia la
página de atrás. Las filas de la torre tampoco son alcanzables por teclado, así que seleccionar un
auto exige mouse. Está acotado a `app.js` y conviene hacerlo en el mismo viaje que la decisión de
arriba, porque las dos tocan el mismo archivo.
