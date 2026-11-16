# Pendientes

Lo que ya se investigó, se decidió cómo tiene que ser y todavía no se construyó. Cada entrada dice
qué se averiguó de AC (lo que se puede y lo que no), qué se decidió y por qué, para que quien lo
implemente no tenga que volver a descubrirlo ni a discutirlo.

Cuando algo de acá se implementa, se saca de este archivo y pasa al `CHANGELOG.md` con su versión.

---

## TODO 1 — Pasar a la siguiente sesión desde el panel y el embed

*Investigado el 2026-11-12. No toca la app del piloto: entra en una versión del server sola.*

### Qué se quiere

Un botón **"Siguiente sesión"** en el panel y en el embed que termine la sesión actual y pase a la
que sigue (práctica → qualy → carrera). Es una posibilidad, no el flujo normal: lo habitual es
dejar que las sesiones pasen solas por tiempo, y el botón está para cuando hace falta adelantar.

### Es posible: el protocolo ya lo trae

El protocolo UDP del plugin de AC tiene el comando de fábrica, y `server/src/udp/protocol.ts` ya
declara los opcodes, aunque nada los usa todavía:

- `NEXT_SESSION: 207` — pasa a la sesión siguiente.
- `RESTART_SESSION: 208` — reinicia la actual (no se pidió, pero sale por el mismo camino).

Lo que falta es lo de alrededor: el `encodeNextSession()` en `protocol.ts` (un byte, igual que
`encodeKickUser`), el método en `udp/client.ts`, el endpoint en `adminApi.ts` (y su par del embed)
y el botón. Como alternativa existe el comando de consola `/next_session` por el
`sendAdminCommand` que ya se usa para `/ballast`; se prefiere el opcode porque no depende de que el
servidor interprete texto.

`SET_SESSION_INFO: 205` permite además alargar o acortar la sesión en curso. Queda anotado por si
alguna vez se quiere; no es parte de este TODO.

### Reglas del botón (decididas)

- **En carrera, el botón no aparece.** Saltar una carrera la corta sin bandera a cuadros, y eso
  rompe el cierre de la carrera (informe, sanciones, `finished`). La carrera termina sola, y el
  paso a la sesión siguiente lo hace el propio servidor de AC.
- **En práctica y en qualy, aparece.** Saltar la qualy antes de tiempo arma la grilla con los
  tiempos que haya hasta ese momento — es comportamiento de AC, no se puede cambiar, y es
  justamente lo que se espera de un salto manual.
- **Después de la última sesión el servidor vuelve a la práctica** (si está en `LOOP_MODE`), y ahí
  el botón tiene que volver a estar, para poder cortar esa práctica y saltar a la qualy. Es la
  misma regla de arriba —"si no es carrera, aparece"—, no un caso especial: alcanza con que la
  visibilidad dependa del tipo de sesión actual (`getSessionType()`) y no del índice.
- La etiqueta puede decir a dónde va ("Siguiente: Qualy") con la info de sesión que ya llega por
  UDP (índice actual y cantidad de sesiones). Deseable, no obligatorio.
- Con confirmación, como el resto de las acciones que no se deshacen.

### Antes de construir

Probar el opcode 207 contra el servidor real de la liga, que está en EmperorServers. No está
confirmado si corre el `acServer` original o AssettoServer; los dos deberían aceptarlo, pero es una
prueba de cinco minutos y evita construir sobre una suposición.

---

## TODO 2 — Banderas forzadas por dirección de carrera

*Investigado el 2026-11-12. Toca la app del piloto: sube el `ui.json` y hay que reinstalar el
`.zip`. Conviene que las tres banderas salgan juntas, para que los pilotos reinstalen una sola vez.*

### Qué se quiere

Una botonera en el panel y el embed para **sacar banderas a mano** durante la carrera, además de
las que el juego ya maneja solo (azul, amarilla, verde):

- 🟡 **Amarilla** — sobre todo en la vuelta de formación, para que haga de safety car.
- 🔴 **Roja.**
- ⚫ **Negra**, a un piloto puntual.

### El límite de AC, y por qué no importa acá

La bandera que dibuja el propio juego (la que `RC Banderas` lee de la Shared Memory, campo
`graphics.flag`) la decide cada cliente de AC: **el servidor no tiene forma de forzarla**. Lo que
sí se puede es que la dibuje **nuestra app**, y eso alcanza, porque **la app es obligatoria en la
liga**: el piloto que no la tenga se detecta (el panel ya lo marca con `chip-sin-app`) y se le avisa
por fuera. No se diseña nada para el que no tiene la app.

### Cómo llega al piloto

Por el mismo poll que ya trae el semáforo y el límite de la formación (`/api/client/poll`, cada
1 s): un campo nuevo con la bandera forzada vigente, que la app pone **por encima** de la de la
Shared Memory mientras esté activa. La demora es de hasta ~1 s, lo mismo que el semáforo hoy.

**Sale siempre en `RC Mensajes`**, además de en `RC Banderas`. `RC Mensajes` es la ventana que no
se puede sacar del menú, así que es la que garantiza que la vea todo el mundo. `RC Banderas` sigue
siendo opcional; el piloto que no la habilitó ve el aviso en Mensajes y no el cuadro de color, y
es su elección.

### Qué hace cada una

| Bandera | Alcance | Qué hace |
|---|---|---|
| 🟡 Amarilla / safety car | Todos | Amarilla en la app más un límite de velocidad, reutilizando lo que ya existe de la vuelta de formación (el límite que viaja en el poll y el `speedWatcher` que registra quién se pasa). Detectar adelantamientos bajo amarilla es posible con la posición en pista que ya llega, pero es un trabajo aparte y se puede dejar para después. |
| ⚫ Negra | Un piloto | Se muestra solo a ese auto, con la orden de entrar a boxes. Si no entra en N vueltas, kick, por la misma vía que ya usa la escalada de sanciones (`raceControl.ts`, `penalty.escalated.kick`), así que pasa por el dispatcher y respeta el modo sombra. |
| 🔴 Roja | Todos | **Solo aviso.** Se dibuja, se anuncia y se puede vigilar la velocidad como en la amarilla, pero no frena los autos: AC no tiene forma de detenerlos desde el servidor. Tampoco se puede "pausar y retomar" una carrera; lo único que existe es reiniciar la sesión, y eso pierde las posiciones. |

### Recordatorios para quien lo implemente

- La app corre en **Python 3.3** (ver `CLAUDE.md`): nada de f-strings.
- La bandera forzada se escribe desde el hilo del poll y se dibuja en el render, igual que
  `light_state`: el hilo de fondo deja el dato en una variable y no dibuja.
- Todo lo visual de la app se escribe sin poder verlo; hay que agendar la prueba en pista.
- Subir el `ui.json` y el número de versión del README (fila de descargas).
