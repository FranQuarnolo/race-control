# 🏁 Race Control

Control de carrera para ligas de **Assetto Corsa**. Entrás a una página con tu usuario, conectás tu
servidor dedicado —el que sea: EmperorServers o cualquier otro hosting— y dirigís la carrera desde
una sola pantalla.

- 🟢 **Largada en movimiento**, controlada automáticamente.
- ⏱️ **Torre de tiempos en vivo** con posiciones, sectores, neumáticos, combustible y ping.
- 🗺️ **Mapa del circuito en tiempo real**, que se dibuja solo a medida que se corre.
- 💥 **Bandeja de incidentes**: toques entre autos, choques contra el muro, salidas de pista y
  contramano, con el contexto de cada uno. **Reporta, no sanciona**: eso lo decidís vos.
- 🚩 **Sanciones** de pit lane y largada automáticas, y las del comisario a un click.
- 📊 **Informe de carrera** descargable al terminar, para pegar en la planilla del campeonato.

## 🚦 Cómo se usa

**El admin no descarga nada.** Entra a una dirección web, pega **un renglón** en el panel de su
hosting y ya está dirigiendo. Lo único que se descarga es la app de los pilotos.

1. 📨 Pedís tu liga y te llega un **link de invitación**. Lo abrís, elegís una contraseña y entrás.
2. 📋 La pantalla te muestra un renglón tipo `203.0.113.5:30000`. Lo pegás en el campo
   **"Send Address"** del panel de tu hosting y reiniciás el servidor de Assetto Corsa.
3. ✅ La pantalla **se pone verde sola** cuando empieza a llegar la telemetría. No hay nada más
   que configurar: el resto lo averigua solo.
4. 🎮 Le pasás `RaceControlClient.zip` a cada piloto, una sola vez para toda la temporada.
5. 🏁 El día de carrera entrás al panel y apretás los botones de largada.

### 🙋 Cómo pido mi liga

El alta es **por invitación**, no por registro abierto. No es para hacerse el difícil: cada liga
ocupa un puerto UDP de un rango chico y declarado a mano en el servidor, así que un formulario
público agotaría el rango el primer día.

Abrí un [issue](https://github.com/FranQuarnolo/race-control/issues) o escribime con el nombre de
tu liga y un email, y te mando el link. Vence a las 48 h y sirve una sola vez.

## 📥 Descargas

| Para | Qué bajar |
|---|---|
| 🏎️ Cada piloto | [**RaceControlClient.zip**](https://github.com/FranQuarnolo/race-control/releases/latest/download/RaceControlClient.zip) |
| 🖥️ El admin, **solo si quiere correrlo en su PC** | [**RaceControlServer.exe**](https://github.com/FranQuarnolo/race-control/releases/latest/download/RaceControlServer.exe) |

## 🏎️ Para el piloto

1. Abrí Content Manager.
2. Arrastrá `RaceControlClient.zip` a la ventana, como instalarías un mod de auto o pista. 📦
3. Activalo en el juego, en el menú de Apps: "Race Control". ✅

Nada más — ni una IP que tipear, ni un archivo que editar. El servidor le manda sola la dirección
y una credencial por el chat del juego apenas entrás. 🎮

> Si alguna vez te aparece **"Credencial vencida: volvé a entrar al servidor"**, es literal: salí y
> volvé a entrar, y la app recibe una credencial nueva. Duran 24 horas.

> De fábrica la app es obligatoria: quien entre sin ella es expulsado al minuto. Se puede apagar
> esa exigencia en **Reglas → App de los pilotos**, y entonces ese piloto aparece en la torre con
> posición, velocidad, vueltas y tiempos —todo lo que manda el servidor— y guiones en sectores,
> neumáticos y combustible. Esos datos solo los tiene el juego en la PC de cada uno.

## 🖥️ Para el admin: qué hay adentro del panel

- **Control de carrera**: los botones de largada, la torre de tiempos y el mapa en vivo.
- **Sanciones**: lo aplicado automáticamente, lo que aplicaste vos, y el botón
  **"Descargar informe de carrera"** — una planilla con la clasificación, los segundos de
  penalización de cada piloto y los incidentes revisados. 📊
- **Reglas**: el tipo de torneo y qué se controla. Cada infracción puede solo registrarse, mandarse
  a revisar o sancionarse sola. 🏎️
- **Conexión**: el renglón para pegar en el hosting, el estado de la señal y un diagnóstico para
  cuando algo no cierra.
- **Modo sombra**: 🛡️ **recomendado para las primeras carreras**. El sistema registra todo pero no
  sanciona a nadie en serio, así podés chequear que funcione antes de confiar en él del todo.

## 💻 Correrlo en tu propia PC

El `.exe` sigue existiendo y hace exactamente lo mismo, para quien prefiera no depender de un
servicio ajeno o no tenga internet estable. La diferencia es que ahí la puesta en marcha sí es
cosa tuya: averiguar tu IP pública, abrir un puerto en el router y dejar una ventana abierta
mientras dura la carrera.

1. Abrí `RaceControlServer.exe`. Windows puede mostrarte un aviso de seguridad la primera vez (es
   normal, la app es nueva) — "Más información" → "Ejecutar de todas formas". ⚠️
2. La primera vez te guía un asistente de 4 pasos y después el panel se abre solo en tu navegador.
3. En **"Conexión"** tenés la dirección ya armada para pegar en tu hosting y el botón
   "Probar ahora".

## 📚 Documentación

| Documento | De qué trata |
|---|---|
| [docs/portal.md](server/docs/portal.md) | Arquitectura del portal: supervisor, workers, puertos, autenticación |
| [docs/operacion.md](server/docs/operacion.md) | Manual de operación: crear ligas, desplegar, leer logs, restaurar |
| [docs/seguridad.md](server/docs/seguridad.md) | Modelo de amenazas y qué queda explícitamente aceptado |
| [CHANGELOG.md](CHANGELOG.md) | Cada decisión de diseño, con el porqué y no solo el qué |

## 🔧 Para desarrollar

```bash
cd server
npm install
npm run dev      # backend local con recarga
npm test         # compila y corre los tests
npm run package  # genera release/RaceControlServer.exe
```

El portal en la máquina propia, con sus cookies sin HTTPS:

```bash
npm run build
RC_DATA_ROOT=./datos RC_PUBLIC_HOST=localhost:8080 RC_PUBLIC_IP=127.0.0.1 \
  RC_INSECURE_COOKIES=1 node dist/portal/cli.js crear-liga --nombre "Mi Liga" --email yo@ejemplo.com
RC_DATA_ROOT=./datos RC_PUBLIC_HOST=localhost:8080 RC_PUBLIC_IP=127.0.0.1 \
  RC_INSECURE_COOKIES=1 PORT=8080 node dist/portal/index.js
```
