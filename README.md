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

**El admin no instala nada.** Entra a una dirección web con el usuario y la contraseña que le
pasaron, pega **un renglón** en el panel de su hosting y ya está dirigiendo. Lo único que se
descarga es la app de los pilotos.

1. 🔑 Te pasan la **dirección, un usuario y una contraseña**. Entrás por **"Ingresar"**.
2. 📋 La pantalla te muestra un renglón tipo `203.0.113.5:30000`. Lo pegás en el campo
   **"Send Address"** del panel de tu hosting y reiniciás el servidor de Assetto Corsa.
3. ✅ La pantalla **se pone verde sola** cuando empieza a llegar la telemetría. No hay nada más
   que configurar: el resto lo averigua solo.
4. 🎮 Le pasás `RaceControlClient.zip` a cada piloto, una sola vez para toda la temporada.
5. 🏁 El día de carrera entrás al panel y apretás los botones de largada.

### 🙋 Cómo consigo mi usuario

No hay registro abierto: las cuentas las crea a mano quien opera el servicio. No es por hacerse el
difícil — cada liga ocupa un puerto UDP de un rango chico declarado a mano en el servidor, así que
un formulario público lo agotaría el primer día. Y el acceso va atado a la cuota mensual.

Abrí un [issue](https://github.com/FranQuarnolo/race-control/issues) o escribime con el nombre de
tu liga y un email, y te mando las credenciales.

## 📥 Descargas

| Para | Qué bajar |
|---|---|
| 🏎️ Cada piloto | [**RaceControlClient.zip**](https://github.com/FranQuarnolo/race-control/releases/latest/download/RaceControlClient.zip) |

El admin no baja nada: el panel es una página web.

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

## 🛠️ Para quien opera el servicio

Entrando con la cuenta de operador aparece **`/operador`**: la lista de admins, cuándo entró cada
uno, hasta cuándo pagó, y los botones para dar de alta una liga nueva, generar una contraseña o
desactivar una cuenta. Desactivar **para el worker de esa liga y deja todos sus datos donde
estaban**; reactivar lo vuelve a levantar.

La puesta en marcha completa —desde el `fly launch` hasta la primera liga andando— está en
**[PUESTA-EN-MARCHA.md](PUESTA-EN-MARCHA.md)**.

## 📚 Documentación

| Documento | De qué trata |
|---|---|
| [PUESTA-EN-MARCHA.md](PUESTA-EN-MARCHA.md) | Cómo poner a punto cada cosa y cómo funciona, de punta a punta |
| [docs/portal.md](server/docs/portal.md) | Arquitectura del portal: supervisor, workers, puertos, autenticación |
| [docs/operacion.md](server/docs/operacion.md) | Manual de operación: crear ligas, desplegar, leer logs, restaurar |
| [docs/seguridad.md](server/docs/seguridad.md) | Modelo de amenazas y qué queda explícitamente aceptado |
| [CHANGELOG.md](CHANGELOG.md) | Cada decisión de diseño, con el porqué y no solo el qué |

## 🔧 Para desarrollar

```bash
cd server
npm install
npm run dev      # portal con recarga
npm test         # compila y corre los tests
```

El portal en la máquina propia, con sus cookies sin HTTPS:

```bash
npm run build
RC_DATA_ROOT=./datos RC_PUBLIC_HOST=localhost:8080 RC_PUBLIC_IP=127.0.0.1 \
  RC_INSECURE_COOKIES=1 RC_OPERATOR_EMAIL=yo@ejemplo.com PORT=8080 node dist/portal/index.js
```

La contraseña del operador sale en el log del primer arranque, una sola vez.

Dos ayudas más, que no necesitan un servidor de Assetto Corsa:

```bash
node dist/sim/replay.js   # reproduce una captura cruda contra el motor
node dist/sim/demo.js     # levanta el panel con una carrera inventada, para sacar capturas
```
