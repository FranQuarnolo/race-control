# 🏁 Race Control

Sistema propio de carrera para Assetto Corsa — sin depender de mods comerciales:

- 🟢 **Largada en movimiento**: controlada, con detección automática de quien se pasa de velocidad.
- 🚩 **Penalizaciones en tiempo real**: exceso de velocidad en pit lane, Drive-Through, Stop-and-Go,
  con escalado automático si no se cumplen a tiempo.

Pensado para que el **admin** no tenga que instalar nada técnico y el **piloto** no tenga que
configurar absolutamente nada.

## 📥 Descargas

| Para | Qué bajar |
|---|---|
| 🖥️ El admin de la liga | [**RaceControlServer.exe**](https://github.com/FranQuarnolo/race-control/releases/download/v0.2.0/RaceControlServer.exe) |
| 🏎️ Cada piloto | [**RaceControlClient.zip**](https://github.com/FranQuarnolo/race-control/releases/download/v0.2.0/RaceControlClient.zip) |

## 🚦 Forma de uso

1. El admin descarga y abre `RaceControlServer.exe` → se abre un panel en el navegador.
2. El admin pega 2 líneas en el panel de su hosting (el panel se las da ya armadas) y configura
   las reglas de la carrera (velocidad, sanciones).
3. El admin le pasa `RaceControlClient.zip` a cada piloto, una sola vez.
4. Cada piloto arrastra ese .zip a Content Manager — nada más.
5. El día de carrera: el admin abre el panel y usa los botones de largada. Listo. 🏁

## 🖥️ Para el admin de la liga

1. Abrí `RaceControlServer.exe`. Se abre una ventana (no la cierres mientras lo usás) y el panel
   se abre solo en tu navegador.
2. La primera vez te pide el nombre de tu liga — lo demás se configura solo.
3. En la sección **"Red"** del panel vas a ver un texto ya armado para pegar en el panel de tu
   hosting (por ej. EmperorServers). El paso a paso está en `server/docs/guia-emperorservers.html`.
4. Configurá las reglas de carrera (velocidad, tolerancia, sanciones) y la zona de pit lane de tu
   circuito.
5. 🛡️ **Recomendado**: dejá activado el "modo sombra" en las primeras carreras — el sistema
   registra todo pero no sanciona a nadie en serio, así podés revisar que esté funcionando bien
   antes de confiar en él del todo.
6. Repartí `RaceControlClient.zip` a tus pilotos (una vez, les sirve para toda la temporada).
7. El día de carrera: abrí el panel y usá los botones de "Iniciar formación" / "Verde" / "Reset". 🚦

## 🏎️ Para el piloto

1. Abrí Content Manager.
2. Arrastrá `RaceControlClient.zip` a la ventana, como instalarías un mod de auto o pista.
3. Activalo en el juego, en el menú de Apps: "Race Control".

Nada más — ni una IP que tipear, ni un archivo que editar. 🎮

## 📚 Más información

- `server/docs/guia-emperorservers.html` — guía para conectar con tu hosting.
- `client-app/README.md` — instalación y empaquetado del cliente.
- `CHANGELOG.md` — historial de cambios.
