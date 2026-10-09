# 🏁 Race Control

- 🟢 **Largada en movimiento**, controlada automáticamente.
- 🚩 **Penalizaciones en tiempo real**: exceso de velocidad en pit lane y cumplimiento de
  sanciones, con escalado automático si no se cumplen a tiempo.

## 📥 Descargas

| Para | Qué bajar |
|---|---|
| 🖥️ El admin de la liga | [**RaceControlServer.exe**](https://github.com/FranQuarnolo/race-control/releases/download/v0.2.2/RaceControlServer.exe) |
| 🏎️ Cada piloto | [**RaceControlClient.zip**](https://github.com/FranQuarnolo/race-control/releases/download/v0.2.2/RaceControlClient.zip) |

## 🚦 Forma de uso

1. 🖥️ El admin descarga y abre `RaceControlServer.exe` — se abre un panel en el navegador.
2. 🔌 El admin copia un texto que el panel le da listo, y lo pega en su hosting.
3. 🎮 El admin le pasa `RaceControlClient.zip` a cada piloto, una sola vez.
4. 📥 Cada piloto arrastra ese .zip a Content Manager — nada más que hacer.
5. 🏁 El día de carrera: el admin abre el panel y aprieta los botones de largada. ¡Listo!

## 🖥️ Para el admin de la liga

1. Abrí `RaceControlServer.exe`. Se abre una ventana (no la cierres mientras lo usás) y el panel
   se abre solo en tu navegador. 🪟
2. ⚠️ Windows puede mostrarte un aviso de seguridad la primera vez (es normal, la app es nueva) —
   elegí "Más información" → "Ejecutar de todas formas".
3. La primera vez te pide el nombre de tu liga — lo demás se configura solo. ✅
4. En la sección **"Red"** del panel vas a ver un texto ya armado para pegar en el panel de tu
   hosting (por ej. EmperorServers). 📋
5. Configurá las reglas de tu carrera (velocidad, sanciones) desde el panel. 🏎️
6. 🛡️ **Recomendado**: dejá activado el "modo sombra" en las primeras carreras — el sistema
   registra todo pero no sanciona a nadie en serio todavía, así podés chequear que esté
   funcionando bien antes de confiar en él del todo.
7. 📤 Repartí `RaceControlClient.zip` a tus pilotos — una sola vez, les sirve para toda la temporada.
8. 🚦 El día de carrera: abrí el panel y usá los botones de "Iniciar formación" / "Verde" / "Reset".

## 🏎️ Para el piloto

1. Abrí Content Manager.
2. Arrastrá `RaceControlClient.zip` a la ventana, como instalarías un mod de auto o pista. 📦
3. Activalo en el juego, en el menú de Apps: "Race Control". ✅

Nada más — ni una IP que tipear, ni un archivo que editar. 🎮
