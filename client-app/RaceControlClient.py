"""
Race Control Client — app de Content Manager para Assetto Corsa.

Responsabilidades:
  - Avisar presencia al backend (heartbeat) mientras la app esté activa.
  - Escuchar el estado del semáforo (polling HTTP) y reproducir "green green green" al verde.
  - Escuchar el chat del servidor y mostrar en overlay los mensajes de PENALIDAD que le llegan.

Requiere editar BACKEND_URL abajo una sola vez por liga/servidor (ver README de distribución).

Nota: corre dentro del intérprete Python embebido de Assetto Corsa (no es un Python de sistema
normal) — por eso solo usa stdlib (urllib, winsound, threading), sin dependencias externas.
"""

import json
import os
import threading
import time
import urllib.request

import ac
import acsys

BACKEND_URL = "http://127.0.0.1:3000"  # Configurar la IP:puerto del backend de la liga.
POLL_INTERVAL_SECONDS = 1.0
HEARTBEAT_INTERVAL_SECONDS = 5.0
SOUND_PATH = os.path.join(os.path.dirname(__file__), "sounds", "green_green_green.wav")

app_window = None
label_light = None
label_penalty = None
last_seen_seq = 0
poll_thread_running = False


def acMain(ac_version):
    global app_window, label_light, label_penalty, poll_thread_running

    app_window = ac.newApp("Race Control")
    ac.setSize(app_window, 320, 120)
    ac.setTitle(app_window, "Race Control")

    label_light = ac.addLabel(app_window, "Semáforo: esperando...")
    ac.setPosition(label_light, 10, 30)

    label_penalty = ac.addLabel(app_window, "")
    ac.setPosition(label_penalty, 10, 60)

    ac.addOnChatMessageListener(app_window, onChatMessage)

    poll_thread_running = True
    threading.Thread(target=pollLoop, daemon=True).start()
    threading.Thread(target=heartbeatLoop, daemon=True).start()

    return "Race Control"


def acUpdate(deltaT):
    pass


def onChatMessage(message, author):
    # El backend manda "PENALIDAD: <motivo>. Tenés N vuelta(s) para cumplirla." vía sendChatToCar.
    if message.upper().startswith("PENALIDAD"):
        ac.setText(label_penalty, message)


def pollLoop():
    global last_seen_seq
    while poll_thread_running:
        try:
            with urllib.request.urlopen(f"{BACKEND_URL}/api/client/poll", timeout=2) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            light_event = data.get("lightEvent", {})
            seq = light_event.get("seq", 0)
            state = light_event.get("type", "idle")

            ac.setText(label_light, f"Semáforo: {state}")

            if seq != last_seen_seq:
                last_seen_seq = seq
                if state == "green":
                    playGreenGreenGreen()
        except Exception as e:
            ac.log(f"[RaceControlClient] poll error: {e}")
        time.sleep(POLL_INTERVAL_SECONDS)


def heartbeatLoop():
    # driverGuid en el protocolo ACSP es el SteamID — ac.getUserSteamID() es la función
    # documentada para obtenerlo del lado cliente (a confirmar firma exacta en la práctica).
    try:
        steam_guid = str(ac.getUserSteamID())
    except Exception as e:
        ac.log(f"[RaceControlClient] no se pudo leer SteamID: {e}")
        steam_guid = ""

    body = json.dumps({"steamGuid": steam_guid}).encode("utf-8")
    while poll_thread_running:
        try:
            req = urllib.request.Request(
                f"{BACKEND_URL}/api/client/heartbeat",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=2)
        except Exception as e:
            ac.log(f"[RaceControlClient] heartbeat error: {e}")
        time.sleep(HEARTBEAT_INTERVAL_SECONDS)


def playGreenGreenGreen():
    try:
        import winsound

        if os.path.exists(SOUND_PATH):
            winsound.PlaySound(SOUND_PATH, winsound.SND_FILENAME | winsound.SND_ASYNC)
        else:
            ac.log(f"[RaceControlClient] no se encontró {SOUND_PATH}")
    except Exception as e:
        ac.log(f"[RaceControlClient] error reproduciendo audio: {e}")
