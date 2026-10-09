"""
Race Control Client -- app de Content Manager para Assetto Corsa.

Responsabilidades:
  - Descubrir solo la direccion del backend (chat interno, sin configuracion manual).
  - Avisar presencia al backend (heartbeat) mientras la app este activa.
  - Escuchar el estado del semaforo (polling HTTP) y reproducir "green green green" al verde.
  - Escuchar el chat del servidor y mostrar en overlay los avisos de PENALIDAD.
  - Mostrar la bandera de pista actual, leida de la Shared Memory del propio juego.

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
HEARTBEAT_INTERVAL_SECONDS = 5.0
SOUND_PATH = os.path.join(os.path.dirname(__file__), "sounds", "green_green_green.wav")

# Prefijo que manda el backend por chat (SEND_CHAT, dirigido solo a este auto) apenas nos
# conectamos -- asi la app no necesita que nadie le tipee una IP. Ver server/src/udp/announcer.ts.
BACKEND_ANNOUNCE_PREFIX = "RACECONTROL_BACKEND:"

app_window = None
label_backend_status = None
label_light = None
label_penalty = None
label_flag = None

backend_url = None  # None hasta que llega el chat de auto-discovery.
last_seen_seq = 0
poll_thread_running = False


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
    threading.Thread(target=flagLoop, daemon=True).start()

    return "Race Control"


def acUpdate(deltaT):
    pass


def onChatMessage(message, author):
    if message.startswith(BACKEND_ANNOUNCE_PREFIX):
        setBackendUrl(message[len(BACKEND_ANNOUNCE_PREFIX):].strip())
        return
    if message.upper().startswith("PENALIDAD"):
        ac.setText(label_penalty, message)


def setBackendUrl(address):
    global backend_url, poll_thread_running
    url = "http://{0}".format(address)
    if url == backend_url:
        return
    backend_url = url
    ac.setText(label_backend_status, "Conectado a Race Control")
    ac.log("[RaceControlClient] backend descubierto: {0}".format(backend_url))
    threading.Thread(target=pollLoop, daemon=True).start()


def pollLoop():
    global last_seen_seq
    my_backend_url = backend_url
    while poll_thread_running and backend_url == my_backend_url:
        try:
            with urllib.request.urlopen("{0}/api/client/poll".format(backend_url), timeout=2) as resp:
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

    body = json.dumps({"steamGuid": steam_guid}).encode("utf-8")
    while poll_thread_running:
        if backend_url:
            try:
                req = urllib.request.Request(
                    "{0}/api/client/heartbeat".format(backend_url),
                    data=body,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=2)
            except Exception as e:
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


# --- Bandera de pista: se lee directo de la Shared Memory del juego, no pasa por el backend. ---
# PENDIENTE DE SPIKE: el offset de "flag" dentro de SPageFileGraphic no esta verificado contra
# una sesion real todavia -- confirmar antes de confiar en este valor (ver docs/spike-protocolo.md).
FLAG_NAMES = {
    0: "Ninguna",
    1: "Azul",
    2: "Amarilla",
    3: "Negra",
    4: "Blanca",
    5: "A cuadros",
    6: "Penalidad",
}

# Offset en bytes del campo "flag" (int32) dentro de SPageFileGraphic, dentro del mapeo
# "Local\\acpmf_graphics". Tomado de referencias comunitarias (mdjarv/assettocorsasharedmemory),
# no de documentacion oficial -- es el valor que hay que confirmar en el spike.
GRAPHICS_FLAG_OFFSET = 68


def flagLoop():
    shm = None
    while poll_thread_running:
        try:
            if shm is None:
                shm = mmap.mmap(-1, 4096, tagname="Local\\acpmf_graphics", access=mmap.ACCESS_READ)
            shm.seek(GRAPHICS_FLAG_OFFSET)
            raw = shm.read(4)
            flag_value = ctypes.c_int32.from_buffer_copy(raw).value
            ac.setText(label_flag, "Bandera: {0}".format(FLAG_NAMES.get(flag_value, "?")))
        except Exception as e:
            ac.log("[RaceControlClient] no se pudo leer la bandera de Shared Memory: {0}".format(e))
            shm = None
            time.sleep(5)
            continue
        time.sleep(0.5)
