"""
Race Control Client -- app de Content Manager para Assetto Corsa.

Responsabilidades:
  - Descubrir solo la direccion del backend (chat interno, sin configuracion manual).
  - Avisar presencia al backend (heartbeat) mientras la app este activa.
  - Escuchar el estado del semaforo (polling HTTP) y reproducir "green green green" al verde.
  - Mostrar los avisos de direccion de carrera: sanciones, vueltas invalidadas, anulaciones.
  - Mostrar el contador de cortes y la sancion pendiente, que son estado y no avisos.
  - Mostrar la bandera de pista actual, leida de la Shared Memory del propio juego.
  - Reportar al backend la telemetria fina que el protocolo UDP de AC NO transporta: tiempos por
    sector, compuesto, combustible, paradas en boxes y ruedas fuera de pista.

---

TRES VENTANAS, NO UNA (desde la 0.8)

Hasta la 0.7 todo esto vivia en una sola ventana "Race Control" con cuatro etiquetas apiladas.
Tenia dos problemas, y los dos son del piloto y no del codigo: en el menu de apps del juego
aparecia una sola entrada, asi que no se podia elegir ver las banderas y no el resto; y la ventana
ocupaba lugar en pantalla incluso cuando lo unico que interesaba era el semaforo de la largada.

Ahora son tres apps independientes, cada una con su entrada en el menu del juego:

  - RC Mensajes  -- avisos de direccion de carrera, al estilo RealPenalty
  - RC Banderas  -- la bandera de pista vigente
  - RC Largada   -- el semaforo de la largada en movimiento
  - RC Alerta    -- el marco rojo de "falta la credencial" (desde la 1.3)

Todas comparten los mismos hilos de fondo (hay UNO de cada cosa, no cuatro): cerrar o no abrir una
ventana no apaga nada, solo deja de dibujar. Por eso los hilos arrancan en acMain y no al abrirse
cada ventana -- el heartbeat tiene que seguir saliendo aunque el piloto no tenga ninguna abierta,
o el watchdog de presencia lo daria por desconectado.

---

SIN CHROME, Y DIBUJADAS A MANO (desde la 1.1)

La 1.0 se probo en pista y la conclusion fue una sola: tres recuadros negros con titulo tapando
el parabrisas es peor que no tener nada. Un overlay de carrera no es una ventana, es informacion
flotando sobre la pista -- y lo que no esta pasando ahora mismo no tiene que ocupar un pixel.

De ahi los dos cambios de esta version:

  - Las tres ventanas van sin fondo, sin borde, sin titulo y sin icono (ver `ocultarChrome`). El
    juego igual las deja mover y redimensionar; el chrome reaparece solo mientras el mouse esta
    encima, que es justo cuando hace falta.
  - Banderas y Largada dejaron de ser texto. Una bandera es un color y un semaforo son cinco
    luces: leerlos como palabra obliga a decodificar algo que el ojo ya sabe reconocer, y a 200
    km/h eso es tiempo que no hay. Se dibujan con `ac.glQuad` en un render callback, sin assets.

El corolario de no tener fondo es que en reposo no se ve NADA: sin bandera no hay bandera y el
semaforo en idle es literalmente transparente. Desde la 1.3 eso vale tambien para el cuadro verde,
que hasta la 1.2 era la excepcion y estaba prendido toda la carrera -- ver FLAG_COLORS.

---

DOS RENGLONES FIJOS ARRIBA DE LA COLA (desde la 1.3)

"RC Mensajes" era solo una cola: tres lineas que aparecen, duran 25 segundos y se van. Eso sirve
para un hecho ("vuelta invalidada") y no sirve para una situacion ("llevas 3 de 5 cortes"), que es
cierta hasta que deje de serlo y no durante 25 segundos.

Arriba de la cola hay ahora dos renglones que son ESTADO, no aviso:

  - `CUTS: 3/5` en amarillo y grande. Se oculta en cero.
  - La sancion pendiente en naranja, con las vueltas de gracia que quedan.

Los dos salen del campo `status` que el poll trae en cada respuesta -- no de la cola de avisos, a
proposito: la cola entrega cada cosa una sola vez, y una app que se reabre a mitad de carrera
arrancaria sin saber cuantos cortes lleva. Ver `applyServerStatus` y clientApi.ts.

El contador ademas suma solo, en el instante del corte, sin esperar al servidor: el juego invalida
la vuelta en el mismo frame y el dato autoritativo del servidor no llega hasta que el piloto cruza
meta. Ver el comentario largo arriba de `countCutLocally`.

---

CUATRO COSAS DE LA PRIMERA CARRERA DE PRUEBA (desde la 1.4 de esta app / 1.7 del servidor)

Primer uso real en modo carrera completo, y dejo cuatro observaciones puntuales:

  - **Las ventanas aparecian apiladas.** Sin una posicion propia, AC crea las apps nuevas una
    encima de la otra en el mismo origen, y "RC Largada" (chica) quedaba enterrada debajo de "RC
    Mensajes" (mucho mas grande) -- invisible para quien recien instala, aunque "funcionaba"
    perfecto. Ver `posicionarVentanasDeFabrica`: les da una posicion de fabrica bien separada,
    pero SOLO la primera vez, para no deshacerle el acomodo a nadie que ya las movio.
  - **El semaforo se veia pixelado.** `drawDisc` armaba cada luz con doce franjas; de cerca se
    notaba el escalonado. Ahora son veintiocho, al mismo costo de nada (ver el comentario de
    `drawDisc`).
  - **La vuelta de formacion no decia a que velocidad ir.** Debajo de las luces, mientras el
    semaforo esta en rojo parpadeando, aparecen dos renglones nuevos: "VUELTA DE FORMACION" y el
    limite de velocidad configurado en el panel (`formationSpeedLimitKmh` del poll). Mismo
    criterio que CUTS y la sancion pendiente: es estado, no un aviso que vence.
  - **El click derecho para fijar una ventana en su lugar** es una funcion de Content Manager /
    Custom Shaders Patch (click derecho arriba a la izquierda de la ventana, "Pin window"), no
    algo que esta app controle -- la API de Python de AC no expone eventos de click derecho ni
    una forma de bloquear una ventana desde el script. Ya funciona igual en las tres, una vez que
    se las encuentra en pantalla, que era justo el primer problema de esta lista.

---

Nota: corre dentro del interprete Python embebido de Assetto Corsa, que es Python 3.3 -- NO
soporta f-strings (son de Python 3.6+). Por eso todo el formateo de texto usa .format()/% .
Solo se usa stdlib (urllib, winsound, threading, mmap, ctypes), sin dependencias externas.
"""

import ctypes
import json
import math
import mmap
import os
import threading
import time
import urllib.request

import ac
import acsys

POLL_INTERVAL_SECONDS = 1.0
# Baja de 5 s a 2 s: la torre de tiempos del panel se alimenta de este mismo POST, y a 5 s la
# velocidad y el combustible se ven a los saltos. Con 24 pilotos son 12 req/s contra un Express
# local, que no es carga para nadie. La gracia del watchdog (60 s) tolera de sobra varios fallos.
HEARTBEAT_INTERVAL_SECONDS = 2.0
SHARED_MEMORY_INTERVAL_SECONDS = 0.25
SOUND_PATH = os.path.join(os.path.dirname(__file__), "sounds", "green_green_green.wav")
# Los otros tres avisos de la formacion, locutados por la misma voz que "green_green_green": arrancan
# apenas el semaforo pasa a "formation" (01), y los otros dos se programan desde ESE instante -- no
# uno despues del otro -- con `threading.Timer` (ver `startFormationAudioSequence`).
ROLLING_START_SOUND_PATH = os.path.join(os.path.dirname(__file__), "sounds", "rolling_start.wav")
STAY_BEHIND_SOUND_PATH = os.path.join(os.path.dirname(__file__), "sounds", "stay_behind.wav")
NO_OVERTAKING_SOUND_PATH = os.path.join(os.path.dirname(__file__), "sounds", "no_overtaking.wav")
FORMATION_STAY_BEHIND_DELAY_SECONDS = 10.0
FORMATION_NO_OVERTAKING_DELAY_SECONDS = 40.0
# Marca en disco de que ya se pusieron las posiciones de fabrica de las ventanas (ver
# `posicionarVentanasDeFabrica`). Vive al lado del script y no en una carpeta de AC porque es un
# dato de la instalacion, no de una partida: tiene que sobrevivir a reinstalar el juego y no tiene
# que ver con el circuito ni con el auto.
FIRST_RUN_MARKER_PATH = os.path.join(os.path.dirname(__file__), "ventanas_posicionadas.flag")
# La chicharra del corte. Dos bips cortos y ascendentes, de 220 ms en total: suena en el instante
# del corte, con el auto todavia fuera de pista, y ahi lo ultimo que hace falta es un sonido que
# tape el del motor medio segundo.
CUT_SOUND_PATH = os.path.join(os.path.dirname(__file__), "sounds", "cut_warning.wav")

# Prefijo que manda el backend por chat (SEND_CHAT, dirigido solo a este auto) apenas nos
# conectamos -- asi la app no necesita que nadie le tipee una IP. Ver server/src/udp/announcer.ts.
BACKEND_ANNOUNCE_PREFIX = "RACECONTROL_BACKEND:"
# El anuncio trae dos campos separados por "|": la direccion y la credencial de ESTE piloto.
# Se eligio "|" y no ":" porque la direccion ya puede traer uno (el puerto). Un anuncio sin
# credencial sigue siendo valido: es lo que manda la app corriendo en la PC del admin, donde el
# canal no sale a internet. Ver server/src/security/pilotToken.ts.
BACKEND_ANNOUNCE_SEPARATOR = "|"

# Cuantas lineas de aviso entran en la ventana de mensajes, y cuanto se quedan en pantalla.
#
# Eran cuatro hasta la 1.0 y ahora son tres: la letra paso de 14 a 20 px porque a cuatro lineas
# chiquitas no las lee nadie en movimiento, y sin bajar una linea la ventana quedaba mas alta que
# antes en vez de mas finita. Tres avisos simultaneos en pista son muchisimos -- lo normal es uno.
#
# Los 25 segundos siguen igual: un aviso tiene que seguir visible despues de la curva en la que uno
# estaba cuando aparecio. Pasado ese tiempo se va solo -- un aviso viejo que no se borra nunca
# termina siendo indistinguible de uno nuevo, que es el modo de fallo de este tipo de overlay.
MESSAGE_LINES = 3
MESSAGE_TTL_SECONDS = 25.0

# Rojo de los avisos y gris del renglon de estado. El rojo es el mismo que usa el panel para las
# sanciones; el gris del estado es deliberadamente apagado y en letra chica, porque "conectado" es
# una tranquilidad y no una noticia: no tiene que competir con un aviso de direccion de carrera.
MESSAGE_COLOR = (1.0, 0.18, 0.18, 1.0)
STATUS_COLOR = (0.72, 0.74, 0.78, 1.0)
MESSAGE_FONT_SIZE = 20
STATUS_FONT_SIZE = 13

# Los dos renglones fijos de la 1.3: el contador de cortes y la sancion que falta cumplir.
#
# "Fijos" quiere decir que NO pasan por la cola de avisos y no vencen. La cola existe para cosas
# que ocurren una vez ("vuelta invalidada", "sancion anulada") y se van a los 25 segundos; estos
# dos son estado, y mientras sean ciertos tienen que estar en pantalla. Mezclarlos con la cola
# tenia dos problemas: el contador se iba solo a los 25 segundos justo cuando mas importa, y
# ocupaba una de las tres lineas de avisos, asi que un corte tapaba la sancion que lo causo.
#
# El amarillo del contador es el de la bandera amarilla, y es el color de "cuidado, todavia no
# pasa nada". La sancion pendiente va en naranja: ya pasa algo, pero no es rojo porque el rojo es
# del aviso que acaba de llegar, y un renglon permanente en rojo deja de leerse a los dos minutos.
CUTS_COLOR = (1.0, 0.82, 0.10, 1.0)
PENDING_COLOR = (1.0, 0.52, 0.05, 1.0)
CUTS_FONT_SIZE = 24
PENDING_FONT_SIZE = 17

# Cuanto dura en pantalla un estado que no es un problema (el "Conectado a Race Control").
#
# Antes se escribia una vez y no se borraba nunca, asi que quedaba toda la carrera ocupando el
# renglon de arriba para informar algo que ya habia pasado. Los estados que SI son un problema
# --que no aparezca el backend, que venza la credencial-- se ponen sin vencimiento y se quedan:
# ahi el cartel es la unica pista que tiene el piloto de por que la app no hace nada.
STATUS_TTL_SECONDS = 8.0

# El aviso de vuelta invalidada lo arma la app, no el servidor. Ver `checkLapInvalidated`.
LAP_INVALIDATED_TEXT = "VUELTA INVALIDADA"

window_messages = None
window_flags = None
window_lights = None
window_alert = None

label_backend_status = None
label_cuts = None
label_pending = None
label_alert = None
label_formation_lap = None
label_formation_limit = None
label_messages = []

backend_url = None  # None hasta que llega el chat de auto-discovery.
backend_token = None  # Credencial firmada que acredita a este piloto. Vence a las 24 h.
last_seen_seq = 0
# Ultimo aviso de la pizarra del servidor que ya se mostro. Viaja en cada poll para que el servidor
# no tenga que recordar que le entrego a quien. Ver server/src/instances/pilotMessages.ts.
last_message_seq = 0
steam_guid = ""
poll_thread_running = False

# Ultimo snapshot de telemetria leido de la Shared Memory. Lo escribe sharedMemoryLoop y lo lee
# heartbeatLoop -- en Python la asignacion de un dict entero es atomica, asi que alcanza con
# reemplazarlo de una pieza en vez de sincronizar con un lock.
telemetry_snapshot = None


def ocultarChrome(window):
    """Deja una ventana sin fondo, sin borde, sin titulo y sin icono.

    Son cuatro llamadas y no una porque en Assetto Corsa el "chrome" de una app son cuatro cosas
    separadas, y dejarse una afuera se nota: sin `drawBorder` queda el marco flotando alrededor de
    la nada, y sin `setIconPosition` queda el iconito de la app colgado arriba a la izquierda sin
    ventana que lo sostenga. El icono no se puede ocultar, solo mover -- de ahi el -10000, que es
    el modismo que usa toda app de AC para sacarlo de pantalla.

    Lo que esto NO hace es volver la ventana intangible: el juego la sigue dejando mover y
    redimensionar, y le vuelve a dibujar el fondo mientras el mouse esta encima. Eso es a
    proposito y es lo que permite acomodarlas la primera vez.
    """
    ac.setBackgroundOpacity(window, 0)
    ac.drawBorder(window, 0)
    ac.setTitle(window, "")
    ac.setIconPosition(window, 0, -10000)


def posicionarVentanasDeFabrica(ventanas):
    """Les da a las ventanas una posicion de fabrica bien separada, pero SOLO la primera vez que
    la app corre en esta instalacion.

    El bug que esto arregla: Assetto Corsa crea las apps nuevas apiladas en el mismo origen de
    pantalla, y sin un `setPosition` propio ahi se quedan. "RC Mensajes" (460x158) es mas grande
    que "RC Largada" (bastante mas chica) y la tapaba por completo -- por eso alguien que recien
    instala la app encuentra las banderas y los mensajes (se asoman del apilado) pero no el
    semaforo, que queda enterrado debajo de la ventana de mensajes sin que se note que esta ahi.

    Hacerlo una sola vez y no en cada arranque es la otra mitad del arreglo: el piloto las mueve a
    gusto despues de la primera vez, y AC ya se encarga de recordar donde las dejo. Si este
    codigo corriera en cada `acMain` les devolveria la posicion de fabrica en cada sesion,
    deshaciendole el acomodo a cualquiera.
    """
    if os.path.exists(FIRST_RUN_MARKER_PATH):
        return
    for window, x, y in ventanas:
        ac.setPosition(window, x, y)
    try:
        with open(FIRST_RUN_MARKER_PATH, "w") as f:
            f.write("1")
    except Exception as e:
        # Si no se pudo escribir la marca, la proxima vez se vuelven a acomodar solas -- es
        # molesto pero no rompe nada, y preferible a no haber podido separarlas la primera vez.
        ac.log("[RaceControlClient] no se pudo guardar la marca de posiciones iniciales: {0}".format(e))


def acMain(ac_version):
    global window_messages, window_flags, window_lights, window_alert
    global label_backend_status, label_cuts, label_pending, label_alert, label_messages
    global label_formation_lap, label_formation_limit
    global steam_guid, poll_thread_running

    # ---------------------------------------------------------------- RC Mensajes
    #
    # El orden de arriba a abajo no es casual: lo permanente arriba, lo que pasa abajo. El estado
    # de conexion (chiquito y gris) es lo menos urgente y por eso encabeza; despues los dos
    # renglones fijos, que son los que el piloto va a mirar de reojo toda la carrera; y al final
    # la cola de avisos, que es lo que cambia. Si la cola fuera arriba, cada aviso empujaria el
    # contador a otra posicion de la pantalla y habria que buscarlo cada vez.
    #
    # La ventana es mas alta que en la 1.1 (de 104 a 158) y eso no ocupa pantalla de mas: sin
    # fondo, un renglon vacio no se ve. Lo que crecio es el espacio reservado, no lo dibujado.
    window_messages = ac.newApp("RC Mensajes")
    ac.setSize(window_messages, 460, 158)
    ocultarChrome(window_messages)

    label_backend_status = ac.addLabel(window_messages, "Buscando servidor de Race Control...")
    ac.setPosition(label_backend_status, 6, 2)
    ac.setFontSize(label_backend_status, STATUS_FONT_SIZE)
    ac.setFontColor(label_backend_status, *STATUS_COLOR)

    label_cuts = ac.addLabel(window_messages, "")
    ac.setPosition(label_cuts, 6, 18)
    ac.setFontSize(label_cuts, CUTS_FONT_SIZE)
    ac.setFontColor(label_cuts, *CUTS_COLOR)

    label_pending = ac.addLabel(window_messages, "")
    ac.setPosition(label_pending, 6, 48)
    ac.setFontSize(label_pending, PENDING_FONT_SIZE)
    ac.setFontColor(label_pending, *PENDING_COLOR)

    label_messages = []
    for i in range(MESSAGE_LINES):
        label = ac.addLabel(window_messages, "")
        ac.setPosition(label, 6, 74 + i * 26)
        ac.setFontSize(label, MESSAGE_FONT_SIZE)
        ac.setFontColor(label, *MESSAGE_COLOR)
        label_messages.append(label)

    # ---------------------------------------------------------------- RC Banderas
    # Cuadrada y chica: lo unico que tiene adentro es un cuadrado de color, asi que el tamano de la
    # ventana ES el tamano del indicador. Sin etiquetas -- el dibujo entero lo hace renderFlag.
    window_flags = ac.newApp("RC Banderas")
    ac.setSize(window_flags, FLAG_WINDOW_SIZE, FLAG_WINDOW_SIZE)
    ocultarChrome(window_flags)
    ac.addRenderCallback(window_flags, renderFlag)

    # ---------------------------------------------------------------- RC Largada
    window_lights = ac.newApp("RC Largada")
    ac.setSize(window_lights, LIGHTS_WINDOW_WIDTH, LIGHTS_WINDOW_HEIGHT)
    ocultarChrome(window_lights)
    ac.addRenderCallback(window_lights, renderLights)

    # Los dos renglones de la vuelta de formacion, debajo de las luces. Arrancan vacios -- ver
    # `renderFormationLines` -- y solo tienen texto mientras el semaforo esta en rojo parpadeando.
    label_formation_lap = ac.addLabel(window_lights, "")
    ac.setPosition(label_formation_lap, 6, LIGHTS_ROW_HEIGHT + 2)
    ac.setFontSize(label_formation_lap, FORMATION_LAP_FONT_SIZE)
    ac.setFontColor(label_formation_lap, *FORMATION_LAP_COLOR)

    label_formation_limit = ac.addLabel(window_lights, "")
    ac.setPosition(label_formation_limit, 6, LIGHTS_ROW_HEIGHT + 24)
    ac.setFontSize(label_formation_limit, FORMATION_LIMIT_FONT_SIZE)
    ac.setFontColor(label_formation_limit, *FORMATION_LIMIT_COLOR)

    # ---------------------------------------------------------------- RC Alerta
    # Invisible mientras todo este bien, que es el 99% del tiempo. Ver el bloque de comentarios de
    # ALERT_WINDOW_WIDTH para por que es un marco y no un fondo.
    window_alert = ac.newApp("RC Alerta")
    ac.setSize(window_alert, ALERT_WINDOW_WIDTH, ALERT_WINDOW_HEIGHT)
    ocultarChrome(window_alert)
    label_alert = ac.addLabel(window_alert, "")
    ac.setPosition(label_alert, ALERT_BORDER + 12, ALERT_WINDOW_HEIGHT / 2 - 12)
    ac.setFontSize(label_alert, ALERT_FONT_SIZE)
    ac.setFontColor(label_alert, *ALERT_TEXT_COLOR)
    ac.addRenderCallback(window_alert, renderAlert)

    # Ver `posicionarVentanasDeFabrica`: separa las cuatro ventanas la primera vez que la app
    # corre, para que ninguna quede tapada por otra. Despues de esta vez, AC recuerda donde las
    # dejo el piloto y este llamado no hace nada.
    posicionarVentanasDeFabrica([
        (window_messages, 40, 40),
        (window_flags, 540, 40),
        (window_lights, 40, 220),
        (window_alert, 40, 340),
    ])

    # El listener del chat va en una sola ventana: el juego lo entrega una vez por listener
    # registrado, asi que ponerlo en las tres mostraria cada anuncio por triplicado.
    ac.addOnChatMessageListener(window_messages, onChatMessage)

    # El SteamID se resuelve una sola vez y antes de arrancar los hilos: lo necesitan los dos
    # (el heartbeat para identificarse, el poll para pedir SUS avisos y no los de otro).
    steam_guid = readSteamGuid()

    poll_thread_running = True
    threading.Thread(target=heartbeatLoop, daemon=True).start()
    threading.Thread(target=sharedMemoryLoop, daemon=True).start()

    return "RC Mensajes"


def acUpdate(deltaT):
    # El vencimiento de los avisos se hace aca y no en el hilo del poll a proposito: un aviso tiene
    # que desaparecer a los 25 segundos aunque el backend se haya caido y el poll este fallando.
    expireMessages()
    expireStatus()
    # Y la invalidacion se mira aca porque `ac.getCarState` solo contesta en el hilo del juego.
    checkLapInvalidated()


def readSteamGuid():
    # driverGuid en el protocolo ACSP es el SteamID -- ac.getUserSteamID() es la funcion
    # documentada para obtenerlo del lado cliente.
    try:
        return str(ac.getUserSteamID())
    except Exception as e:
        ac.log("[RaceControlClient] no se pudo leer SteamID: {0}".format(e))
        return ""


def onChatMessage(message, author):
    if message.startswith(BACKEND_ANNOUNCE_PREFIX):
        setBackendUrl(message[len(BACKEND_ANNOUNCE_PREFIX):].strip())
        return
    # El chat sigue siendo un camino valido hacia la ventana de mensajes y no un resto del diseno
    # viejo: le llega al piloto aunque la pizarra del servidor no haya podido entregarle nada
    # --token vencido, backend caido, app recien abierta-- y es la unica via que no depende de que
    # el poll funcione. Si llega por los dos lados, showMessage descarta el duplicado.
    upper = message.upper()
    if upper.startswith("PENALIDAD") or upper.startswith("SANCION") or upper.startswith("SANCIÓN"):
        showMessage(message)


def setBackendUrl(announce):
    global backend_url, backend_token, poll_thread_running
    parts = announce.split(BACKEND_ANNOUNCE_SEPARATOR, 1)
    url = "http://{0}".format(parts[0].strip())
    token = parts[1].strip() if len(parts) > 1 else None

    # La credencial se renueva sola: el servidor reanuncia cada vez que el piloto entra, y cada
    # anuncio trae una nueva. Por eso se guarda aunque la direccion no haya cambiado -- si no, un
    # token vencido no se reemplazaria nunca hasta reiniciar el juego.
    backend_token = token
    if url == backend_url:
        return
    backend_url = url
    setStatus("Conectado a Race Control", STATUS_TTL_SECONDS)
    ac.log("[RaceControlClient] backend descubierto: {0}".format(backend_url))
    threading.Thread(target=pollLoop, daemon=True).start()


# =============================================================================================
# Renglon de estado
#
# Una sola linea arriba de los avisos, para lo que le pasa a la APP y no a la carrera. Son tres
# textos en toda su vida: buscando, conectado, credencial vencida.
# =============================================================================================

status_until = None  # None = el estado actual no vence


def setStatus(text, ttl=None):
    """Escribe el renglon de estado. Con `ttl`, se borra solo a los tantos segundos."""
    global status_until
    ac.setText(label_backend_status, text)
    status_until = (time.time() + ttl) if ttl else None


def expireStatus():
    global status_until
    if status_until is not None and time.time() >= status_until:
        status_until = None
        ac.setText(label_backend_status, "")


# =============================================================================================
# Ventana de mensajes
#
# Los avisos llegan por dos caminos (la pizarra del servidor y el chat) y se muestran en uno solo.
# El lock esta porque los dos caminos corren en hilos distintos: el chat lo entrega el juego en el
# hilo principal y la pizarra la trae el hilo del poll. Sin el lock, dos avisos simultaneos pueden
# dejar la lista a medio escribir.
# =============================================================================================

messages = []  # [{"text": str, "at": float}], del mas viejo al mas nuevo
messages_lock = threading.Lock()


def showMessage(text):
    """Pone un aviso en la ventana de mensajes. Repetido seguido, no se duplica."""
    text = (text or "").strip()
    if not text:
        return
    now = time.time()
    with messages_lock:
        # El mismo aviso puede llegar por la pizarra y por el chat -- son dos canales a proposito.
        # Repetir la linea no agrega informacion y gasta una de las cuatro que hay.
        for existing in messages:
            if existing["text"] == text:
                existing["at"] = now
                break
        else:
            messages.append({"text": text, "at": now})
            if len(messages) > MESSAGE_LINES:
                del messages[0:len(messages) - MESSAGE_LINES]
    renderMessages()


def expireMessages():
    cutoff = time.time() - MESSAGE_TTL_SECONDS
    with messages_lock:
        vivos = [m for m in messages if m["at"] > cutoff]
        if len(vivos) == len(messages):
            return
        messages[:] = vivos
    renderMessages()


def renderMessages():
    with messages_lock:
        textos = [m["text"] for m in messages]
    for i in range(len(label_messages)):
        ac.setText(label_messages[i], textos[i] if i < len(textos) else "")


# =============================================================================================
# Vuelta invalidada
#
# Esto lo decide la app y no el servidor, y es un cambio de la 1.1 que vale la pena explicar.
#
# El backend se entera de que una vuelta fue invalidada cuando Assetto Corsa le manda el
# LAP_COMPLETED, o sea al cruzar meta. Para el comisario eso esta perfecto -- lo que juzga es la
# vuelta cerrada. Para el piloto no sirve: se entera de que la vuelta no valia un minuto y medio
# despues de haberla arruinado, cuando ya la manejo entera apretando.
#
# El juego, en cambio, invalida la vuelta en el instante del corte, y lo publica en
# `acsys.CS.LapInvalidated`. Como la app corre adentro del juego, puede leerlo y avisar ahi mismo.
# Por eso el servidor ya no empuja ese aviso a la pizarra (ver raceControl.ts): llegaria tarde y
# repetido. Lo que el servidor sigue haciendo igual es anotar el corte en la bandeja de incidentes,
# que es lo unico para lo que importa su version.
#
# Dos sutilezas que cuestan un bug cada una si se omiten:
#
#   - Se avisa por FLANCO (0 -> 1), no por estado. Leido cada frame, el estado da sesenta avisos
#     por segundo durante toda la vuelta.
#   - En el pit lane no se avisa. La out lap nace invalidada siempre, asi que sin este filtro cada
#     salida de boxes arrancaria con un cartel rojo que no corresponde a ningun error del piloto.
#     El flanco igual se consume, para que el aviso no aparezca al pisar la pista.
# =============================================================================================

lap_invalidated = False
lap_invalidated_supported = True


def checkLapInvalidated():
    global lap_invalidated, lap_invalidated_supported
    if not lap_invalidated_supported:
        return
    try:
        invalid = ac.getCarState(0, acsys.CS.LapInvalidated) != 0
        in_pit_lane = ac.getCarState(0, acsys.CS.IsCarInPitline) != 0
    except Exception as e:
        # Se apaga en vez de reintentar: esto corre una vez por frame y un log por frame llena el
        # archivo del juego en minutos. Si la constante no existiera en esta version de AC, el
        # piloto pierde el aviso inmediato pero la app sigue funcionando entera.
        lap_invalidated_supported = False
        ac.log("[RaceControlClient] LapInvalidated no disponible, aviso inmediato apagado: {0}".format(e))
        return

    if invalid and not lap_invalidated and not in_pit_lane:
        showMessage(LAP_INVALIDATED_TEXT)
        # El corte se suma AHORA, no cuando el servidor lo confirme. Ver `countCutLocally`.
        countCutLocally()
        playCutWarning()
    lap_invalidated = invalid


# =============================================================================================
# El contador de cortes y la sancion pendiente
#
# Los dos renglones fijos. Lo que los hace distintos de un aviso es que son ESTADO: valen mientras
# sean ciertos, no durante 25 segundos.
#
# El contador suma por los dos lados, y hace falta que sea asi:
#
#   - La APP lo adelanta. El juego invalida la vuelta en el instante del corte y la app lo lee del
#     mismo frame (`checkLapInvalidated`). Sumar ahi es lo unico que da un aviso inmediato.
#   - El SERVIDOR lo corrige. El dato autoritativo es el `cuts` del LAP_COMPLETED, que no llega
#     hasta que el piloto cruza meta -- hasta un minuto y medio despues. Tambien es el unico que
#     sabe cuando la cuenta se reinicia, porque la sancion la decide el.
#
# De ahi los dos numeros: `cuts_server` es lo ultimo que dijo el servidor y `cuts_local_extra` son
# los cortes que la app vio desde entonces. Lo que se muestra es la suma. Cuando el servidor
# cambia su numero --porque conto la vuelta, o porque sanciono y reinicio-- el extra vuelve a cero:
# el servidor ya los tiene contados y dejarlos sumaria dos veces el mismo corte.
#
# Mostrar `max()` de los dos en vez de la suma seria el bug obvio: dos cortes en la misma vuelta
# mostrarian 1, porque el servidor sigue en el valor de la vuelta anterior.
# =============================================================================================

cuts_server = 0
cuts_limit = 0
cuts_local_extra = 0
pending_penalty_text = None


def countCutLocally():
    global cuts_local_extra
    cuts_local_extra += 1
    renderCuts()


def applyServerStatus(status):
    """Aplica el estado que trajo el poll. Lo llama el hilo del poll, no el del juego."""
    global cuts_server, cuts_limit, cuts_local_extra, pending_penalty_text
    if not isinstance(status, dict):
        return
    nuevo = int(status.get("cuts", 0) or 0)
    cuts_limit = int(status.get("cutsLimit", 0) or 0)
    if nuevo != cuts_server:
        cuts_server = nuevo
        cuts_local_extra = 0
    penalty = status.get("penalty") or None
    if penalty != pending_penalty_text:
        pending_penalty_text = penalty
        ac.setText(label_pending, penalty if penalty else "")
    renderCuts()


def renderCuts():
    # Sin limite configurado no se dibuja nada: "CUTS: 2/0" no significa nada, y es lo que se
    # veria mientras el backend todavia no contesto.
    if cuts_limit <= 0:
        ac.setText(label_cuts, "")
        return
    total = cuts_server + cuts_local_extra
    # En cero se oculta, que es lo que pasa justo despues de una sancion: la cuenta arranca de
    # nuevo y un "CUTS: 0/5" permanente seria un cartel que no dice nada ocupando el renglon mas
    # visible de la pantalla.
    ac.setText(label_cuts, "CUTS: {0}/{1}".format(total, cuts_limit) if total > 0 else "")


def playCutWarning():
    playWav(CUT_SOUND_PATH)


def authHeaders():
    """Cabeceras de autenticacion, vacias si todavia no hay credencial."""
    if backend_token:
        return {"Authorization": "Bearer {0}".format(backend_token)}
    return {}


def openAuthed(url, data=None, timeout=2):
    """urlopen con la credencial puesta. urllib de Python 3.3 ya manda los headers tal cual."""
    headers = authHeaders()
    if data is None:
        return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)
    headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    return urllib.request.urlopen(req, timeout=timeout)


def pollLoop():
    global last_seen_seq, last_message_seq
    my_backend_url = backend_url
    while poll_thread_running and backend_url == my_backend_url:
        try:
            # `since` y `guid` van en la URL porque esto es un GET: el servidor devuelve solo los
            # avisos posteriores al ultimo que se mostro. Sin `since` mandaria los mismos una y
            # otra vez; sin `guid` no sabria de quien son (con token lo saca del token e ignora
            # este, que es lo que corresponde -- ver clientApi.ts).
            url = "{0}/api/client/poll?since={1}&guid={2}".format(backend_url, last_message_seq, steam_guid)
            with openAuthed(url) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            light_event = data.get("lightEvent", {})
            seq = light_event.get("seq", 0)
            state = light_event.get("type", "idle")

            # El poll contesto: la credencial vale. Es el unico lugar donde se apaga la alerta, y
            # tiene que estar aca arriba -- el piloto vuelve a entrar al servidor, le llega el
            # anuncio con el token nuevo, y el marco rojo se va solo sin que tenga que hacer nada
            # mas. Apagarla al recibir el anuncio seria apagarla antes de saber si el token sirve.
            setAlert(False)

            setLightState(state)
            # El estado va siempre, aunque no haya avisos nuevos: es lo que corrige el contador
            # que la app viene adelantando sola. Ver `applyServerStatus`.
            applyServerStatus(data.get("status", {}))
            applyFormationSpeedLimit(data.get("formationSpeedLimitKmh"))

            for message in data.get("messages", []):
                showMessage(message.get("text", ""))
                # El maximo y no el ultimo: si alguna vez llegaran desordenados, quedarse con el
                # ultimo haria que los anteriores se volvieran a pedir para siempre.
                last_message_seq = max(last_message_seq, message.get("seq", 0))

            if seq != last_seen_seq:
                last_seen_seq = seq
                if state == "formation":
                    startFormationAudioSequence()
                else:
                    # Si el semaforo pasa a verde antes de los 40 s (el admin puede darlo cuando
                    # quiera) o la largada se reinicia a mitad de formacion, lo que haya quedado
                    # programado no tiene que sonar fuera de lugar.
                    cancelFormationAudioSequence()
                    if state == "green":
                        playGreenGreenGreen()
        except Exception as e:
            # 401 es el unico error que el piloto puede arreglar solo, y el mensaje tiene que
            # decirle como: la credencial vence a las 24 h y se renueva al volver a entrar al
            # servidor. Sin esto, la app simplemente deja de funcionar sin explicar nada.
            if getattr(e, "code", None) == 401:
                # Sin vencimiento a proposito: es un problema que sigue estando hasta que el
                # piloto haga algo, y un cartel que se borra solo lo dejaria sin saber por que
                # la app dejo de avisarle cosas.
                setStatus("Credencial vencida: volve a entrar al servidor")
                # Y el marco rojo, porque el renglon gris de 13 px no alcanza: sin credencial el
                # watchdog de presencia lo va a desconectar, y entre que empieza a fallar y que lo
                # echan puede pasar un minuto entero sin que el piloto mire esa linea.
                setAlert(True)
            ac.log("[RaceControlClient] poll error: {0}".format(e))
        time.sleep(POLL_INTERVAL_SECONDS)


def heartbeatLoop():
    # Round-trip del heartbeat anterior. Se manda en el siguiente porque recien se conoce DESPUES
    # de que la request vuelve. Es un ping real de la conexion de este piloto, pero hacia Race
    # Control, no hacia el servidor de AC: el protocolo UDP de AC no expone el ping al servidor
    # de carrera. Sirve para lo que el admin quiere saber -- quien tiene conexion inestable.
    last_ping_ms = None

    while poll_thread_running:
        if backend_url:
            # Se saca la cola ANTES de armar el payload y se devuelve si el POST falla. Al reves
            # (vaciarla despues de mandar) se perderian las salidas que ocurran mientras la
            # request esta en vuelo, que son justo las de los dos segundos mas recientes.
            sending = excursions.take()
            try:
                payload = {"steamGuid": steam_guid}
                if last_ping_ms is not None:
                    payload["pingMs"] = last_ping_ms
                snapshot = telemetry_snapshot
                if snapshot is not None:
                    payload["telemetry"] = snapshot
                if sending:
                    payload["excursions"] = sending
                started = time.perf_counter()
                openAuthed(
                    "{0}/api/client/heartbeat".format(backend_url),
                    data=json.dumps(payload).encode("utf-8"),
                )
                last_ping_ms = int(round((time.perf_counter() - started) * 1000))
            except Exception as e:
                # Una request fallida no deja un ping valido -- mejor no reportar nada que
                # reportar el del intento anterior como si fuera actual.
                last_ping_ms = None
                if sending:
                    excursions.restore(sending)
                ac.log("[RaceControlClient] heartbeat error: {0}".format(e))
        time.sleep(HEARTBEAT_INTERVAL_SECONDS)


def playWav(path):
    """Reproduce un .wav sin bloquear. `winsound` es de Windows, que es donde corre AC."""
    try:
        import winsound

        if os.path.exists(path):
            # ASYNC es obligatorio: esto lo puede llamar el hilo del juego desde
            # `checkLapInvalidated`, y sin ASYNC el frame se clavaria lo que dure el sonido.
            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
        else:
            ac.log("[RaceControlClient] no se encontro {0}".format(path))
    except Exception as e:
        ac.log("[RaceControlClient] error reproduciendo audio: {0}".format(e))


def playGreenGreenGreen():
    playWav(SOUND_PATH)


# Los `threading.Timer` pendientes de la formacion en curso. Python 3.3 no tiene asyncio: un Timer
# es la unica forma de "sonar esto en N segundos" sin bloquear el hilo del juego. Van en una lista
# aparte (no una variable sola) porque son dos al mismo tiempo, y los dos tienen que poder
# cancelarse juntos si la largada se reinicia o el semaforo pasa a verde antes de los 40 s --
# nada garantiza que la formacion dure eso: el admin puede dar verde cuando quiera.
formation_audio_timers = []


def cancelFormationAudioSequence():
    global formation_audio_timers
    for timer in formation_audio_timers:
        timer.cancel()
    formation_audio_timers = []


def startFormationAudioSequence():
    """Rolling start apenas arranca la formacion, stay behind a los 10 s y no overtaking a los
    40 s -- los tres tiempos contados desde este instante, no uno despues del otro."""
    # Sin este `global` la asignacion de mas abajo crea una variable local: la lista de arriba
    # (la que lee `cancelFormationAudioSequence`) se queda vacia para siempre despues de la
    # primera formacion, y reiniciar la largada "cancela" una lista sin nada adentro. Los timers
    # de verdad quedan sueltos sonando igual.
    global formation_audio_timers
    cancelFormationAudioSequence()
    playWav(ROLLING_START_SOUND_PATH)
    stay_behind_timer = threading.Timer(FORMATION_STAY_BEHIND_DELAY_SECONDS, playWav, args=(STAY_BEHIND_SOUND_PATH,))
    no_overtaking_timer = threading.Timer(FORMATION_NO_OVERTAKING_DELAY_SECONDS, playWav, args=(NO_OVERTAKING_SOUND_PATH,))
    # Daemon: si el juego cierra con un timer todavia esperando, que no lo retenga.
    stay_behind_timer.daemon = True
    no_overtaking_timer.daemon = True
    stay_behind_timer.start()
    no_overtaking_timer.start()
    formation_audio_timers = [stay_behind_timer, no_overtaking_timer]


# =============================================================================================
# Lo que se dibuja: la bandera y el semaforo
#
# Las dos ventanas son graficas y no texto, y la razon es la misma para las dos: el piloto las mira
# de reojo a doscientos por hora. "Semaforo: formation" obliga a leer una palabra en ingles y
# traducirla; cinco luces rojas parpadeando no obligan a nada. Igual con la bandera.
#
# Se dibuja con `ac.glQuad`, que es lo unico que hay: rectangulos de un color plano. No hay
# circulos ni texturas ni imagenes, asi que los discos del semaforo se arman por franjas (ver
# `drawDisc`). La ventaja de no usar imagenes es que no hay un asset mas que empaquetar, que se
# pueda perder al instalar, ni que haya que escalar a la resolucion de cada uno.
#
# Todo esto corre en el hilo del juego, una vez por frame y solo si la ventana esta abierta. Los
# hilos de fondo nunca dibujan: dejan el dato en una variable y se van. De ahi que `current_flag`
# y `light_state` sean globales sueltas y no haya lock -- en Python asignar un entero o un string
# es atomico, y un frame tarde o temprano es irrelevante a 60 fps.
# =============================================================================================

FLAG_WINDOW_SIZE = 64
LIGHTS_WINDOW_WIDTH = 260
# La fila de luces ocupa siempre los mismos 46 px de arriba (es el alto que tenia la ventana
# entera hasta la 1.6). Lo que crecio es el espacio reservado debajo, para "VUELTA DE FORMACION"
# y el limite de velocidad -- pedido explicito de la prueba en pista, para que durante la
# formacion se sepa a que velocidad ir sin tener que adivinarla ni buscarla en otro lado.
LIGHTS_ROW_HEIGHT = 46
LIGHTS_WINDOW_HEIGHT = LIGHTS_ROW_HEIGHT + 48

# ---------------------------------------------------------------------------------------------
# La alerta de credencial (1.3)
#
# El caso que cubre: la app esta instalada y corriendo, pero el servidor no la acredita --porque
# el anuncio del chat se perdio, o porque la credencial vencio a las 24 h-- y entonces el poll
# devuelve 401. Desde afuera la app se ve igual de prendida que siempre: no avisa nada, no suena
# nada, y el piloto se entera cuando el watchdog de presencia lo desconecta.
#
# Dos cosas que conviene tener escritas, porque las dos se pidieron de otra forma:
#
#   1. **No es a pantalla completa.** Una app de Assetto Corsa dibuja dentro de su ventana; no
#      hay una superficie "toda la pantalla" a la que se pueda acceder. Lo que si se puede es un
#      marco rojo grueso pulsando alrededor del texto, que es lo que hace RealPenalty y lo que de
#      verdad se ve de reojo.
#   2. **Es un marco y no un relleno.** El relleno lo dibuja el render callback, que corre DESPUES
#      de las etiquetas de la ventana: un rectangulo rojo del tamano de la ventana taparia su
#      propio texto. El marco deja el centro libre.
#
# Y el limite de fondo: a quien no tiene la app instalada no se le puede dibujar NADA dentro del
# juego, porque el overlay es la app. A ese piloto solo le llega el chat del servidor y despues
# el kick. Ver server/src/presence/presenceWatchdog.ts.
ALERT_WINDOW_WIDTH = 520
ALERT_WINDOW_HEIGHT = 92
ALERT_BORDER = 10.0
ALERT_COLOR = (0.92, 0.07, 0.07, 1.0)
ALERT_TEXT_COLOR = (1.0, 0.92, 0.92, 1.0)
ALERT_FONT_SIZE = 19
# Un pulso lento, de segundo y medio: lo bastante como para que el ojo lo agarre en periferia y no
# tan rapido como para volverse un estrobo delante de alguien que esta manejando.
ALERT_PULSE_SECONDS = 1.5
ALERT_ALPHA_MIN = 0.30
ALERT_ALPHA_MAX = 1.00
ALERT_TEXT = "FALTA LA CREDENCIAL - VOLVE A ENTRAR AL SERVIDOR"

LIGHTS_COUNT = 5
LIGHT_RADIUS = 13.0
LIGHT_SPACING = 32.0
# Medio segundo prendida, medio apagada. Es el ritmo del semaforo de verdad y, mas importante, es
# lento como para que se note en vision periferica sin convertirse en un estrobo.
LIGHTS_BLINK_SECONDS = 0.5
# Cuanto se quedan las luces verdes antes de desaparecer. Pedido explicito: tres segundos y chau.
LIGHTS_GREEN_HOLD_SECONDS = 3.0

LIGHT_RED = (0.95, 0.12, 0.12, 1.0)
LIGHT_GREEN = (0.10, 0.85, 0.25, 1.0)
# Carcasa: el disco oscuro de atras. No es decoracion -- sin el, una luz roja sobre el rojo de un
# auto adelante o el verde sobre el pasto de la escapatoria se pierden.
LIGHT_HOUSING = (0.04, 0.04, 0.05, 0.85)

# Los dos renglones debajo de las luces, visibles solo durante la formacion (semaforo en rojo
# parpadeando). Mismo criterio que CUTS/la sancion pendiente en RC Mensajes: es ESTADO, asi que se
# prende y se apaga solo, sin pasar por la cola de avisos ni vencer a los 25 segundos.
#
# El limite de velocidad sale de `formationSpeedLimitKmh` en cada poll -- es la misma regla que el
# admin carga en el panel para sancionar el exceso en la vuelta de formacion (ver
# `config.formation.penalty.speedThresholdKmh` en el servidor), asi que lo que ve el piloto es
# siempre el numero por el que lo pueden sancionar, no uno fijo en este archivo.
#
# Sin tildes, como el resto de los textos de esta app: el renderizado de texto de AC no las trae
# bien y salen como un caracter roto (ver ALERT_TEXT, LAP_INVALIDATED_TEXT).
FORMATION_LAP_TEXT = "VUELTA DE FORMACION"
FORMATION_LAP_COLOR = (1.00, 0.85, 0.05, 1.0)
FORMATION_LIMIT_COLOR = (0.92, 0.93, 0.96, 1.0)
FORMATION_LAP_FONT_SIZE = 16
FORMATION_LIMIT_FONT_SIZE = 14

# El color de cada bandera del juego. Las claves son los valores de `graphics.flag` de la Shared
# Memory: 0 ninguna, 1 azul, 2 amarilla, 3 negra, 4 blanca, 5 a cuadros, 6 penalidad.
#
# El 5 (a cuadros) y el 6 (penalidad) no son un color plano y se dibujan aparte.
#
# EL 0 YA NO ES "PISTA DESPEJADA" (cambio de la 1.3)
#
# Hasta la 1.2 el 0 pintaba verde fijo, con el argumento de que "pista despejada" tambien es
# informacion y de que un cuadro que desaparece deja al piloto sin saber si no hay bandera o si
# la app se colgo. La prueba en pista lo desarmo: el 0 es el valor del 95% de una carrera, asi que
# el cuadro verde estaba SIEMPRE -- incluido todo el largo de la vuelta de formacion, donde un
# verde es exactamente lo contrario de lo que pasa. Un indicador que esta prendido siempre no
# informa nada y ademas miente en el unico momento en que mirarlo importa.
#
# Ahora el verde aparece solo cuando se DA el verde, los mismos 3 segundos que las luces (ver
# `enVerdeDeLargada`), y eso obliga a que esta ventana mire tambien el semaforo que trae el poll y
# no solo la Shared Memory: el juego no tiene ninguna bandera para "arranco la carrera".
#
# Y la duda que resolvia el verde fijo --"se colgo la app?"-- la contestan ahora el renglon de
# estado de RC Mensajes y el marco de RC Alerta, que es donde corresponde.
FLAG_COLORS = {
    0: (0.10, 0.80, 0.25, 1.0),  # el verde de la largada, no "pista despejada"
    1: (0.15, 0.45, 1.00, 1.0),
    2: (1.00, 0.85, 0.05, 1.0),
    3: (0.06, 0.06, 0.07, 1.0),
    4: (0.95, 0.95, 0.95, 1.0),
}
FLAG_BORDER = (0.0, 0.0, 0.0, 0.70)
FLAG_PENALTY_DOT = (1.00, 0.45, 0.00, 1.0)
CHECKER_CELLS = 4
# La amarilla parpadea y las demas no. Es la unica que pide una reaccion inmediata --hay algo en
# la pista, ahora, y hay que levantar el pie-- y un cuadro quieto en vision periferica no se
# distingue del que ya estaba. Mismo ritmo que el semaforo, por la misma razon: lento como para
# que se note sin convertirse en un estrobo.
FLAG_BLINK_SECONDS = LIGHTS_BLINK_SECONDS
FLAG_YELLOW = 2

current_flag = 0  # Lo escribe sharedMemoryLoop. 0 = sin bandera.

light_state = "idle"
light_green_at = None  # Cuando paso a verde, para apagarlo a los 3 segundos.
formation_speed_limit_kmh = None  # Lo ultimo que informo el poll. None hasta el primer poll.


def setLightState(state):
    """Guarda el estado del semaforo que trajo el poll. No dibuja: de eso se ocupa renderLights."""
    global light_state, light_green_at
    if state == light_state:
        return
    light_state = state
    light_green_at = time.time() if state == "green" else None
    renderFormationLines()


def applyFormationSpeedLimit(value):
    """Guarda el limite de velocidad de la formacion que trajo el poll y actualiza el renglon.

    Separado de `setLightState` porque son dos cosas que cambian en momentos distintos: el estado
    cambia en la transicion a formacion, pero el admin puede cambiar el limite en el panel DURANTE
    la formacion -- y ahi tiene que actualizarse sin esperar a que el semaforo cambie de estado.
    """
    global formation_speed_limit_kmh
    try:
        value = int(value)
    except (TypeError, ValueError):
        value = None
    if value == formation_speed_limit_kmh:
        return
    formation_speed_limit_kmh = value
    renderFormationLines()


def renderFormationLines():
    """Escribe (o borra) los dos renglones debajo de las luces. Estado, no aviso: ver el bloque de
    comentarios de FORMATION_LAP_TEXT."""
    if light_state != "formation":
        ac.setText(label_formation_lap, "")
        ac.setText(label_formation_limit, "")
        return
    ac.setText(label_formation_lap, FORMATION_LAP_TEXT)
    if formation_speed_limit_kmh and formation_speed_limit_kmh > 0:
        ac.setText(label_formation_limit, "Limite de velocidad: {0} km/h".format(formation_speed_limit_kmh))
    else:
        ac.setText(label_formation_limit, "")


def drawDisc(cx, cy, radius, color, strips=28):
    """Dibuja un disco apilando franjas horizontales, porque `glQuad` es lo unico que hay.

    El ancho de cada franja sale del circulo: media cuerda = sqrt(r^2 - dy^2). Antes eran doce
    franjas, y en la prueba en pista el semaforo se vio pixelado -- doce escalones en un radio de
    trece pixeles alcanzaban para notarse de cerca, aunque anduvieran bien a distancia. Con
    veintiocho el escalonado deja de distinguirse de la curva, y el costo sigue siendo nada: dos
    discos por luz (carcasa + luz) por cinco luces son diez discos, menos de trescientos
    rectangulos por frame.
    """
    ac.glColor4f(*color)
    height = (2.0 * radius) / strips
    for i in range(strips):
        dy = -radius + height * (i + 0.5)
        half = math.sqrt(max(0.0, radius * radius - dy * dy))
        if half <= 0.0:
            continue
        ac.glQuad(cx - half, cy - radius + height * i, half * 2.0, height)


def enVerdeDeLargada():
    """Los 3 segundos de verde que siguen a la largada. Lo miran el semaforo y la bandera."""
    if light_state != "green" or light_green_at is None:
        return False
    return (time.time() - light_green_at) <= LIGHTS_GREEN_HOLD_SECONDS


def renderFlag(deltaT):
    flag = current_flag

    # Sin bandera no se dibuja nada, con una sola excepcion: el verde de la largada, que no sale
    # de la Shared Memory sino del semaforo del poll. En la vuelta de formacion `light_state` es
    # "formation", asi que esto tambien es lo que deja la ventana invisible durante la formacion
    # -- que era el sintoma concreto: salir detras del pace car con un cuadro verde al lado.
    if flag == 0 and not enVerdeDeLargada():
        return

    # La amarilla es la unica que parpadea. Mitad del ciclo apagada, igual que el semaforo.
    if flag == FLAG_YELLOW and int(time.time() / FLAG_BLINK_SECONDS) % 2 != 0:
        return

    size = FLAG_WINDOW_SIZE
    inner = size - 12.0
    x = 6.0
    y = 6.0

    # Marco oscuro primero: la bandera blanca sobre un cielo claro seria un cuadrado invisible.
    ac.glColor4f(*FLAG_BORDER)
    ac.glQuad(x - 2.0, y - 2.0, inner + 4.0, inner + 4.0)

    if flag == 5:
        drawChecker(x, y, inner)
        return

    color = FLAG_COLORS.get(flag if flag != 6 else 3, FLAG_COLORS[0])
    ac.glColor4f(*color)
    ac.glQuad(x, y, inner, inner)

    if flag == 6:
        # Bandera negra con circulo naranja: la de "pasa por boxes". Es negra igual que la 3, y lo
        # unico que las distingue es el circulo -- sin el, dos sanciones muy distintas se verian
        # identicas.
        drawDisc(x + inner / 2.0, y + inner / 2.0, inner / 4.0, FLAG_PENALTY_DOT)


def drawChecker(x, y, inner):
    """El tablero de la bandera a cuadros. Un color plano no alcanza: es LA bandera reconocible."""
    cell = inner / CHECKER_CELLS
    for row in range(CHECKER_CELLS):
        for col in range(CHECKER_CELLS):
            if (row + col) % 2 == 0:
                ac.glColor4f(0.95, 0.95, 0.95, 1.0)
            else:
                ac.glColor4f(0.06, 0.06, 0.07, 1.0)
            ac.glQuad(x + col * cell, y + row * cell, cell, cell)


alert_active = False


def setAlert(active):
    """Prende o apaga la alerta de credencial. Lo llama el hilo del poll; no dibuja nada."""
    global alert_active
    if active == alert_active:
        return
    alert_active = active
    # El texto se escribe una sola vez, al cambiar de estado, y no una vez por frame: `ac.setText`
    # en el render callback es trabajo inutil sesenta veces por segundo.
    ac.setText(label_alert, ALERT_TEXT if active else "")


def renderAlert(deltaT):
    if not alert_active:
        return  # Sin alerta la ventana es un vidrio, igual que las otras dos.

    # Triangular y no cuadrada: sube y baja en vez de prenderse y apagarse. Un parpadeo duro a
    # pantalla entera es agresivo de mas para algo que el piloto va a tener puesto varias vueltas.
    fase = (time.time() % ALERT_PULSE_SECONDS) / ALERT_PULSE_SECONDS
    pulso = 1.0 - abs(fase * 2.0 - 1.0)
    alpha = ALERT_ALPHA_MIN + (ALERT_ALPHA_MAX - ALERT_ALPHA_MIN) * pulso
    ac.glColor4f(ALERT_COLOR[0], ALERT_COLOR[1], ALERT_COLOR[2], alpha)

    w = float(ALERT_WINDOW_WIDTH)
    h = float(ALERT_WINDOW_HEIGHT)
    b = ALERT_BORDER
    ac.glQuad(0.0, 0.0, w, b)              # arriba
    ac.glQuad(0.0, h - b, w, b)            # abajo
    ac.glQuad(0.0, b, b, h - 2.0 * b)      # izquierda
    ac.glQuad(w - b, b, b, h - 2.0 * b)    # derecha


def renderLights(deltaT):
    if light_state == "formation":
        if int(time.time() / LIGHTS_BLINK_SECONDS) % 2 != 0:
            return  # Mitad del ciclo apagadas: eso es el parpadeo.
        color = LIGHT_RED
    elif light_state == "green":
        # El apagado lo decide el render y no un timer: un timer mas es un hilo mas que sincronizar
        # con el poll, y aca alcanza con mirar el reloj una vez por frame.
        if not enVerdeDeLargada():
            return
        color = LIGHT_GREEN
    else:
        return  # idle: no se dibuja nada, la ventana es un vidrio.

    cy = LIGHTS_ROW_HEIGHT / 2.0
    first = (LIGHTS_WINDOW_WIDTH - (LIGHTS_COUNT - 1) * LIGHT_SPACING) / 2.0
    for i in range(LIGHTS_COUNT):
        cx = first + i * LIGHT_SPACING
        drawDisc(cx, cy, LIGHT_RADIUS + 2.0, LIGHT_HOUSING)
        drawDisc(cx, cy, LIGHT_RADIUS, color)


# =============================================================================================
# Shared Memory del juego
#
# Aca esta TODO lo que el protocolo UDP de Assetto Corsa no transporta: tiempos por sector,
# compuesto, combustible, paradas en boxes y ruedas fuera de pista. El servidor dedicado
# simplemente no manda nada de eso -- LAP_COMPLETED trae el tiempo total de la vuelta y los
# cortes, y se acabo. La unica fuente es el proceso del juego, o sea esta PC.
#
# Las structs se declaran completas con ctypes en vez de calcular offsets a mano. No es cosmetico:
# la version anterior leia la bandera del offset 68, que cae DENTRO del array lastTime -- estaba
# mal, y estaba mal porque un numero suelto no hay forma de revisarlo. Declarada la struct, los
# offsets los calcula ctypes y ese tipo de error no puede volver a pasar.
#
# Layout segun SharedFileOut.h de Kunos (Assetto Corsa, no ACC). wchar_t en Windows son 2 bytes.
#
# Las dos structs estan truncadas a proposito en el ultimo campo que nos interesa (physics.abs,
# graphics.mandatoryPitDone): el juego publica paginas mas grandes, y se mapea solo el prefijo que
# se lee. Declarar campos que no se usan solo agrega superficie para equivocarse.
# =============================================================================================


class SPageFilePhysics(ctypes.Structure):
    _pack_ = 4
    _fields_ = [
        ("packetId", ctypes.c_int32),
        ("gas", ctypes.c_float),
        ("brake", ctypes.c_float),
        ("fuel", ctypes.c_float),
        ("gear", ctypes.c_int32),
        ("rpms", ctypes.c_int32),
        ("steerAngle", ctypes.c_float),
        ("speedKmh", ctypes.c_float),
        ("velocity", ctypes.c_float * 3),
        ("accG", ctypes.c_float * 3),
        ("wheelSlip", ctypes.c_float * 4),
        ("wheelLoad", ctypes.c_float * 4),
        ("wheelsPressure", ctypes.c_float * 4),
        ("wheelAngularSpeed", ctypes.c_float * 4),
        ("tyreWear", ctypes.c_float * 4),
        ("tyreDirtyLevel", ctypes.c_float * 4),
        ("tyreCoreTemperature", ctypes.c_float * 4),
        ("camberRAD", ctypes.c_float * 4),
        ("suspensionTravel", ctypes.c_float * 4),
        ("drs", ctypes.c_float),
        ("tc", ctypes.c_float),
        ("heading", ctypes.c_float),
        ("pitch", ctypes.c_float),
        ("roll", ctypes.c_float),
        ("cgHeight", ctypes.c_float),
        ("carDamage", ctypes.c_float * 5),
        ("numberOfTyresOut", ctypes.c_int32),
        ("pitLimiterOn", ctypes.c_int32),
        ("abs", ctypes.c_float),
    ]


class SPageFileGraphic(ctypes.Structure):
    _pack_ = 4
    _fields_ = [
        ("packetId", ctypes.c_int32),
        ("status", ctypes.c_int32),
        ("session", ctypes.c_int32),
        ("currentTime", ctypes.c_wchar * 15),
        ("lastTime", ctypes.c_wchar * 15),
        ("bestTime", ctypes.c_wchar * 15),
        ("split", ctypes.c_wchar * 15),
        ("completedLaps", ctypes.c_int32),
        ("position", ctypes.c_int32),
        ("iCurrentTime", ctypes.c_int32),
        ("iLastTime", ctypes.c_int32),
        ("iBestTime", ctypes.c_int32),
        ("sessionTimeLeft", ctypes.c_float),
        ("distanceTraveled", ctypes.c_float),
        ("isInPit", ctypes.c_int32),
        ("currentSectorIndex", ctypes.c_int32),
        ("lastSectorTime", ctypes.c_int32),
        ("numberOfLaps", ctypes.c_int32),
        ("tyreCompound", ctypes.c_wchar * 33),
        ("replayTimeMultiplier", ctypes.c_float),
        ("normalizedCarPosition", ctypes.c_float),
        ("carCoordinates", ctypes.c_float * 3),
        ("penaltyTime", ctypes.c_float),
        ("flag", ctypes.c_int32),
        ("idealLineOn", ctypes.c_int32),
        ("isInPitLane", ctypes.c_int32),
        ("surfaceGrip", ctypes.c_float),
        ("mandatoryPitDone", ctypes.c_int32),
    ]


MAX_PLAUSIBLE_SECTOR_MS = 600000

# A partir de cuantas ruedas afuera se empieza a cronometrar una salida. Es deliberadamente el
# criterio MAS laxo: el umbral real (2 o 4 ruedas) lo decide el admin en el panel y lo aplica el
# backend. El cliente manda el maximo de ruedas que llego a tener afuera y deja que el servidor
# decida si cuenta -- asi cambiar la regla no obliga a que 24 pilotos actualicen la app.
EXCURSION_MIN_TYRES = 2

# Tope de salidas en cola. El backend puede estar caido o el piloto todavia no haberlo descubierto;
# sin tope la lista crece sin limite durante toda la carrera. Se descartan las mas viejas.
MAX_PENDING_EXCURSIONS = 20


class SectorTracker(object):
    """Arma los tiempos por sector a partir de currentSectorIndex / lastSectorTime.

    El juego no entrega los tres sectores juntos: entrega el indice del sector que se esta
    corriendo y el tiempo del que acaba de cerrar. Hay que ir acumulandolos y recien al cerrar la
    vuelta se tiene el juego completo.

    PENDIENTE DE VERIFICACION EN PISTA: se asume que lastSectorTime es ACUMULADO desde el inicio
    de la vuelta (el split), que es lo que asumen las implementaciones comunitarias, y los
    sectores salen por diferencia. Si en realidad viniera ya por sector, el segundo split seria
    menor que el primero en cualquier circuito con S2 corto -- eso se detecta abajo y se cambia de
    criterio. Si no se detecta, los valores absurdos se descartan y la columna muestra un guion:
    nunca se inventa un numero.
    """

    def __init__(self):
        self.splits = []
        self.last_index = None
        self.sectors = []

    def update(self, graphics):
        index = graphics.currentSectorIndex
        if self.last_index is None:
            self.last_index = index
            return

        if index == self.last_index:
            return

        if index < self.last_index:
            # Volvio a sector 0: cerro la vuelta. El tiempo total sale de iLastTime, que es mas
            # confiable que lastSectorTime justo en el cruce de meta.
            self.splits.append(graphics.iLastTime)
            self.sectors = self._derive(self.splits)
            self.splits = []
        else:
            self.splits.append(graphics.lastSectorTime)

        self.last_index = index

    def _derive(self, splits):
        if len(splits) < 2:
            return []

        # Si el segundo "acumulado" es menor que el primero, no son acumulados: ya vienen por
        # sector y no hay nada que restar (salvo el ultimo, que es el total de la vuelta).
        cumulative = splits[1] >= splits[0]
        if not cumulative:
            values = splits[:-1]
            total = splits[-1]
            values.append(total - sum(splits[:-1]))
        else:
            values = []
            previous = 0
            for split in splits:
                values.append(split - previous)
                previous = split

        return [v if (v > 0 and v < MAX_PLAUSIBLE_SECTOR_MS) else None for v in values]

    def reset(self):
        self.splits = []
        self.last_index = None
        self.sectors = []


class ExcursionTracker(object):
    """Detecta salidas de pista y las encola para el proximo heartbeat.

    Reporta TRANSICIONES, no un stream: la salida se encola recien cuando termina, con cuanto
    duro y cuantas ruedas llego a tener afuera. Mandar el valor instantaneo cada 2 segundos no
    serviria -- una salida tipica dura menos que eso y caeria justo entre dos muestras.

    El muestreo es a 4 Hz (SHARED_MEMORY_INTERVAL_SECONDS), que es lo que corresponde a una app
    corriendo dentro del juego: no debe competir por CPU con el render. La contra es que una
    pisada de menos de 250 ms puede pasar desapercibida, lo cual es aceptable -- esas son
    exactamente las que el backend descarta igual por minDurationMs.
    """

    def __init__(self):
        self.pending = []
        self.lock = threading.Lock()
        self.active = None

    def update(self, physics, graphics):
        # En el pit lane no se mide: la entrada y la salida de boxes cruzan lineas pintadas y
        # superficies que el juego reporta como fuera de pista, y eso no es una salida de pista.
        if graphics.isInPitLane != 0:
            self.active = None
            return

        tyres_out = physics.numberOfTyresOut
        now = time.time()

        if tyres_out >= EXCURSION_MIN_TYRES:
            if self.active is None:
                self.active = {
                    "startedAt": now,
                    "maxTyresOut": tyres_out,
                    "splinePosition": graphics.normalizedCarPosition,
                    "lap": graphics.completedLaps,
                    "sector": graphics.currentSectorIndex,
                }
            elif tyres_out > self.active["maxTyresOut"]:
                self.active["maxTyresOut"] = tyres_out
            return

        if self.active is None:
            return

        excursion = self.active
        self.active = None
        self.enqueue({
            "maxTyresOut": excursion["maxTyresOut"],
            "durationMs": int(round((now - excursion["startedAt"]) * 1000)),
            "splinePosition": round(excursion["splinePosition"], 4),
            "lap": excursion["lap"],
            "sector": excursion["sector"],
        })

    def enqueue(self, excursion):
        with self.lock:
            self.pending.append(excursion)
            if len(self.pending) > MAX_PENDING_EXCURSIONS:
                del self.pending[0:len(self.pending) - MAX_PENDING_EXCURSIONS]

    def take(self):
        """Saca la cola entera. Si el POST falla, el llamador la devuelve con restore()."""
        with self.lock:
            taken = self.pending
            self.pending = []
        return taken

    def restore(self, excursions):
        with self.lock:
            self.pending = excursions + self.pending
            if len(self.pending) > MAX_PENDING_EXCURSIONS:
                del self.pending[0:len(self.pending) - MAX_PENDING_EXCURSIONS]

    def reset(self):
        self.active = None


excursions = ExcursionTracker()


def sharedMemoryLoop():
    """Lee las dos paginas de Shared Memory y arma el snapshot que viaja en el heartbeat."""
    global telemetry_snapshot, current_flag

    physics_shm = None
    graphics_shm = None
    physics_size = ctypes.sizeof(SPageFilePhysics)
    graphics_size = ctypes.sizeof(SPageFileGraphic)

    sectors = SectorTracker()
    pit_stops = 0
    was_in_pit = False

    while poll_thread_running:
        try:
            if physics_shm is None:
                physics_shm = mmap.mmap(-1, physics_size, tagname="Local\\acpmf_physics", access=mmap.ACCESS_READ)
            if graphics_shm is None:
                graphics_shm = mmap.mmap(-1, graphics_size, tagname="Local\\acpmf_graphics", access=mmap.ACCESS_READ)

            physics_shm.seek(0)
            physics = SPageFilePhysics.from_buffer_copy(physics_shm.read(physics_size))
            graphics_shm.seek(0)
            graphics = SPageFileGraphic.from_buffer_copy(graphics_shm.read(graphics_size))

            # Solo se deja el dato: el cuadro lo dibuja renderFlag en el hilo del juego.
            current_flag = graphics.flag

            sectors.update(graphics)
            excursions.update(physics, graphics)

            # Una parada se cuenta en el flanco de entrada al box, no mientras se esta adentro:
            # si no, un auto detenido 20 segundos sumaria una parada por cada lectura.
            in_pit = graphics.isInPit != 0
            if in_pit and not was_in_pit:
                pit_stops += 1
            was_in_pit = in_pit

            telemetry_snapshot = {
                "sectors": sectors.sectors,
                "currentSector": graphics.currentSectorIndex,
                "tyreCompound": graphics.tyreCompound.strip(),
                "fuelLiters": round(physics.fuel, 1),
                "pitStops": pit_stops,
                "inPitLane": graphics.isInPitLane != 0,
                "tyresOut": physics.numberOfTyresOut,
                # Lo unico de este bloque que NO es del piloto sino de la pista. Viaja por aca
                # porque la app es la unica que lo ve: el UDP del servidor no lo manda. El panel
                # lo muestra una sola vez, en la banda del mapa, no por fila de la torre.
                "surfaceGrip": round(graphics.surfaceGrip, 4),
            }
        except Exception as e:
            # El juego todavia no abrio las paginas (menu principal, carga de sesion) o se cerro.
            # No es un error del que haya que avisar al piloto: se reintenta y listo.
            ac.log("[RaceControlClient] Shared Memory no disponible: {0}".format(e))
            physics_shm = None
            graphics_shm = None
            telemetry_snapshot = None
            # Vuelve a "sin bandera" en vez de quedarse con la ultima leida: si el juego dejo de
            # publicar, un cuadro amarillo congelado estaria afirmando algo que ya no sabemos.
            current_flag = 0
            sectors.reset()
            # Solo se descarta la salida en curso, no la cola: lo ya detectado sigue siendo
            # valido y se manda igual cuando el backend vuelva.
            excursions.reset()
            time.sleep(5)
            continue
        time.sleep(SHARED_MEMORY_INTERVAL_SECONDS)
