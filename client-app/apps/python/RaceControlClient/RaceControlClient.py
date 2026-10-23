"""
Race Control Client -- app de Content Manager para Assetto Corsa.

Responsabilidades:
  - Descubrir solo la direccion del backend (chat interno, sin configuracion manual).
  - Avisar presencia al backend (heartbeat) mientras la app este activa.
  - Escuchar el estado del semaforo (polling HTTP) y reproducir "green green green" al verde.
  - Escuchar el chat del servidor y mostrar en overlay los avisos de PENALIDAD.
  - Mostrar la bandera de pista actual, leida de la Shared Memory del propio juego.
  - Reportar al backend la telemetria fina que el protocolo UDP de AC NO transporta: tiempos por
    sector, compuesto, combustible, paradas en boxes y ruedas fuera de pista.

Nota: corre dentro del interprete Python embebido de Assetto Corsa, que es Python 3.3 -- NO
soporta f-strings (son de Python 3.6+). Por eso todo el formateo de texto usa .format()/% .
Solo se usa stdlib (urllib, winsound, threading, mmap, ctypes), sin dependencias externas.
"""

import ctypes
import json
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

# Prefijo que manda el backend por chat (SEND_CHAT, dirigido solo a este auto) apenas nos
# conectamos -- asi la app no necesita que nadie le tipee una IP. Ver server/src/udp/announcer.ts.
BACKEND_ANNOUNCE_PREFIX = "RACECONTROL_BACKEND:"
# El anuncio trae dos campos separados por "|": la direccion y la credencial de ESTE piloto.
# Se eligio "|" y no ":" porque la direccion ya puede traer uno (el puerto). Un anuncio sin
# credencial sigue siendo valido: es lo que manda la app corriendo en la PC del admin, donde el
# canal no sale a internet. Ver server/src/security/pilotToken.ts.
BACKEND_ANNOUNCE_SEPARATOR = "|"

app_window = None
label_backend_status = None
label_light = None
label_penalty = None
label_flag = None

backend_url = None  # None hasta que llega el chat de auto-discovery.
backend_token = None  # Credencial firmada que acredita a este piloto. Vence a las 24 h.
last_seen_seq = 0
poll_thread_running = False

# Ultimo snapshot de telemetria leido de la Shared Memory. Lo escribe sharedMemoryLoop y lo lee
# heartbeatLoop -- en Python la asignacion de un dict entero es atomica, asi que alcanza con
# reemplazarlo de una pieza en vez de sincronizar con un lock.
telemetry_snapshot = None


def acMain(ac_version):
    global app_window, label_backend_status, label_light, label_penalty, label_flag, poll_thread_running

    app_window = ac.newApp("Race Control")
    ac.setSize(app_window, 320, 170)
    ac.setTitle(app_window, "Race Control")

    label_backend_status = ac.addLabel(app_window, "Buscando servidor de Race Control...")
    ac.setPosition(label_backend_status, 10, 25)

    label_light = ac.addLabel(app_window, "Semaforo: --")
    ac.setPosition(label_light, 10, 55)

    label_penalty = ac.addLabel(app_window, "")
    ac.setPosition(label_penalty, 10, 85)

    label_flag = ac.addLabel(app_window, "Bandera: --")
    ac.setPosition(label_flag, 10, 130)

    ac.addOnChatMessageListener(app_window, onChatMessage)

    poll_thread_running = True
    threading.Thread(target=heartbeatLoop, daemon=True).start()
    threading.Thread(target=sharedMemoryLoop, daemon=True).start()

    return "Race Control"


def acUpdate(deltaT):
    pass


def onChatMessage(message, author):
    if message.startswith(BACKEND_ANNOUNCE_PREFIX):
        setBackendUrl(message[len(BACKEND_ANNOUNCE_PREFIX):].strip())
        return
    if message.upper().startswith("PENALIDAD"):
        ac.setText(label_penalty, message)


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
    ac.setText(label_backend_status, "Conectado a Race Control")
    ac.log("[RaceControlClient] backend descubierto: {0}".format(backend_url))
    threading.Thread(target=pollLoop, daemon=True).start()


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
    global last_seen_seq
    my_backend_url = backend_url
    while poll_thread_running and backend_url == my_backend_url:
        try:
            with openAuthed("{0}/api/client/poll".format(backend_url)) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            light_event = data.get("lightEvent", {})
            seq = light_event.get("seq", 0)
            state = light_event.get("type", "idle")

            ac.setText(label_light, "Semaforo: {0}".format(state))

            if seq != last_seen_seq:
                last_seen_seq = seq
                if state == "green":
                    playGreenGreenGreen()
        except Exception as e:
            # 401 es el unico error que el piloto puede arreglar solo, y el mensaje tiene que
            # decirle como: la credencial vence a las 24 h y se renueva al volver a entrar al
            # servidor. Sin esto, la app simplemente deja de funcionar sin explicar nada.
            if getattr(e, "code", None) == 401:
                ac.setText(label_backend_status, "Credencial vencida: volve a entrar al servidor")
            ac.log("[RaceControlClient] poll error: {0}".format(e))
        time.sleep(POLL_INTERVAL_SECONDS)


def heartbeatLoop():
    # driverGuid en el protocolo ACSP es el SteamID -- ac.getUserSteamID() es la funcion
    # documentada para obtenerlo del lado cliente (a confirmar firma exacta en la practica).
    try:
        steam_guid = str(ac.getUserSteamID())
    except Exception as e:
        ac.log("[RaceControlClient] no se pudo leer SteamID: {0}".format(e))
        steam_guid = ""

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


def playGreenGreenGreen():
    try:
        import winsound

        if os.path.exists(SOUND_PATH):
            winsound.PlaySound(SOUND_PATH, winsound.SND_FILENAME | winsound.SND_ASYNC)
        else:
            ac.log("[RaceControlClient] no se encontro {0}".format(SOUND_PATH))
    except Exception as e:
        ac.log("[RaceControlClient] error reproduciendo audio: {0}".format(e))


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


FLAG_NAMES = {
    0: "Ninguna",
    1: "Azul",
    2: "Amarilla",
    3: "Negra",
    4: "Blanca",
    5: "A cuadros",
    6: "Penalidad",
}

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
    global telemetry_snapshot

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

            ac.setText(label_flag, "Bandera: {0}".format(FLAG_NAMES.get(graphics.flag, "?")))

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
            sectors.reset()
            # Solo se descarta la salida en curso, no la cola: lo ya detectado sigue siendo
            # valido y se manda igual cuando el backend vuelva.
            excursions.reset()
            time.sleep(5)
            continue
        time.sleep(SHARED_MEMORY_INTERVAL_SECONDS)
