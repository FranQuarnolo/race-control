# 🏁 Race Control

Control de carrera para ligas de **Assetto Corsa**. Lo abre el admin en su PC, se conecta a su
servidor dedicado —el que sea: EmperorServers o cualquier otro hosting— y dirige la carrera desde
una sola pantalla.

- 🟢 **Largada en movimiento**, controlada automáticamente.
- ⏱️ **Torre de tiempos en vivo** con posiciones, sectores, neumáticos, combustible y ping.
- 🗺️ **Mapa del circuito en tiempo real**, que se dibuja solo a medida que se corre.
- 💥 **Bandeja de incidentes**: toques entre autos, choques contra el muro, salidas de pista y
  contramano, con el contexto de cada uno. **Reporta, no sanciona**: eso lo decidís vos.
- 🚩 **Sanciones** de pit lane y largada automáticas, y las del comisario a un click.
- 📊 **Informe de carrera** descargable al terminar, para pegar en la planilla del campeonato.

## 📥 Descargas

| Para | Qué bajar |
|---|---|
| 🖥️ El admin de la liga | [**RaceControlServer.exe**](https://github.com/FranQuarnolo/race-control/releases/latest/download/RaceControlServer.exe) |
| 🏎️ Cada piloto | [**RaceControlClient.zip**](https://github.com/FranQuarnolo/race-control/releases/latest/download/RaceControlClient.zip) |

## 🚦 Forma de uso

1. 🖥️ El admin descarga y abre `RaceControlServer.exe` — se abre un panel en el navegador.
2. 🔌 El admin copia una dirección que el panel le da lista, y la pega en el campo
   **"Send Address"** de su hosting. Es el único dato.
3. 🎮 El admin le pasa `RaceControlClient.zip` a cada piloto, una sola vez.
4. 📥 Cada piloto arrastra ese .zip a Content Manager — nada más que hacer.
5. 🏁 El día de carrera: el admin abre el panel y aprieta los botones de largada. ¡Listo!

## 🖥️ Para el admin de la liga

1. Abrí `RaceControlServer.exe`. Se abre una ventana (no la cierres mientras lo usás) y el panel
   se abre solo en tu navegador. 🪟
2. ⚠️ Windows puede mostrarte un aviso de seguridad la primera vez (es normal, la app es nueva) —
   elegí "Más información" → "Ejecutar de todas formas".
3. La primera vez te guía un asistente de 4 pasos: nombre de la liga, tipo de torneo, conexión con
   tu servidor, y una comprobación en vivo de que los datos están llegando. ✅
4. En **"Conexión"** (arriba a la derecha) tenés la dirección ya armada para pegar en el campo
   **"Send Address"** de tu hosting (en paneles viejos se llama `UDP_PLUGIN_ADDRESS`), un botón
   "Probar ahora" que te dice qué falta, y la guía. Es el único dato que hay que mover a mano: el
   resto lo averigua solo. 📋
5. En **"Reglas"** elegís el tipo de torneo y ajustás qué se controla y qué pasa con cada cosa:
   solo registrar, mandar a revisar o sancionar. 🏎️
6. 🛡️ **Recomendado**: dejá activado el "modo sombra" en las primeras carreras — el sistema
   registra todo pero no sanciona a nadie en serio todavía, así podés chequear que esté
   funcionando bien antes de confiar en él del todo.
7. 📤 Repartí `RaceControlClient.zip` a tus pilotos — una sola vez, les sirve para toda la temporada.
8. 🚦 El día de carrera: abrí el panel y usá los botones de "Iniciar formación" / "Verde".
9. 📊 Al terminar, en **"Sanciones"** tenés "Descargar informe de carrera": una planilla con la
   clasificación, los segundos de penalización de cada piloto y los incidentes revisados.

## 🏎️ Para el piloto

1. Abrí Content Manager.
2. Arrastrá `RaceControlClient.zip` a la ventana, como instalarías un mod de auto o pista. 📦
3. Activalo en el juego, en el menú de Apps: "Race Control". ✅

Nada más — ni una IP que tipear, ni un archivo que editar. 🎮

> De fábrica la app es obligatoria: quien entre sin ella es expulsado al minuto. Se puede apagar
> esa exigencia en **Reglas → App de los pilotos**, y entonces ese piloto aparece en la torre con
> posición, velocidad, vueltas y tiempos —todo lo que manda el servidor— y guiones en sectores,
> neumáticos y combustible. Esos datos solo los tiene el juego en la PC de cada uno.

## 🔧 Para desarrollar

```bash
cd server
npm install
npm run dev      # backend con recarga
npm test         # compila y corre los tests
npm run package  # genera release/RaceControlServer.exe
```

El detalle de cada decisión de diseño está en [CHANGELOG.md](CHANGELOG.md) — cada entrada explica
el porqué, no solo el qué.
