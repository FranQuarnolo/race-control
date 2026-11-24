import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { FormationStart, LightState } from "../instances/formationStart";
import { SpeedWatcher } from "../state/speedWatcher";
import { PenaltyEngine, PenaltyRules } from "../penalty/penaltyEngine";
import { StateTracker, CarState } from "../state/stateTracker";
import { AcUdpClient } from "../udp/client";
import { parseConfig } from "../config";

/**
 * Virtual Safety Car (1.48): green → vsc → vscEnding → green (solo), con su propio límite y su
 * propio motor de sanciones. Se arma con un emisor suelto en lugar del StateTracker y un UDP que
 * solo anota el chat: lo que importa es la máquina de estados, no la red.
 */
function reglas(speedThresholdKmh: number): PenaltyRules {
  return {
    speedThresholdKmh,
    toleranceSeconds: 1,
    graceLaps: 3,
    penaltyType: "DT",
    escalation: "DQ",
    ballastKg: 50,
    timePenaltySeconds: 5,
  };
}

function armar(endingSeconds = 0.05) {
  let ahora = 0;
  const reloj = { now: () => ahora };
  const emisor = new EventEmitter();
  const chat: string[] = [];
  const udp = { broadcastChat: (t: string) => chat.push(t) } as unknown as AcUdpClient;
  const tracker = emisor as unknown as StateTracker;
  const formationEngine = new PenaltyEngine(reglas(80));
  const vscEngine = new PenaltyEngine(reglas(60));
  const fs = new FormationStart(udp, new SpeedWatcher(tracker, reglas(80), undefined, reloj), formationEngine, {
    speedWatcher: new SpeedWatcher(tracker, vscEngine.getRules(), undefined, reloj),
    penaltyEngine: vscEngine,
    getEndingSeconds: () => endingSeconds,
  });
  const estados: LightState[] = [];
  fs.on("stateChanged", (s: LightState) => estados.push(s));
  const muestra = (ms: number, speedKmh: number) => {
    ahora = ms;
    emisor.emit("update", { carId: 1, driverGuid: "76561198000000001", speedKmh } as CarState);
  };
  return { fs, chat, estados, muestra, formationEngine, vscEngine };
}

test("el VSC solo se despliega con la carrera en curso", () => {
  const { fs } = armar();
  assert.equal(fs.toggleVsc(), false, "en idle no hay carrera que neutralizar");
  fs.beginFormation();
  assert.equal(fs.toggleVsc(), false, "en la formación ya hay límite");
  fs.triggerGreen();
  assert.equal(fs.toggleVsc(), true);
  assert.equal(fs.getLightState(), "vsc");
});

test("terminar el VSC pasa por VSC ending y el verde llega solo", async () => {
  const { fs, chat, estados } = armar(0.05);
  fs.beginFormation();
  fs.triggerGreen();
  fs.toggleVsc();
  fs.toggleVsc();
  assert.equal(fs.getLightState(), "vscEnding");
  assert.equal(fs.getVscSecondsLeft(), 1, "redondea hacia arriba");
  assert.equal(fs.toggleVsc(), false, "durante el VSC ending el botón no hace nada");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fs.getLightState(), "green");
  assert.equal(fs.getVscSecondsLeft(), null);
  assert.deepEqual(estados, ["formation", "green", "vsc", "vscEnding", "green"]);
  assert.equal(chat.filter((t) => t.includes("VERDE VERDE VERDE")).length, 2, "el verde del VSC es el mismo que el de la largada");
});

test("reiniciar la largada cancela el verde automático del VSC", async () => {
  const { fs } = armar(0.05);
  fs.beginFormation();
  fs.triggerGreen();
  fs.toggleVsc();
  fs.toggleVsc();
  fs.reset();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fs.getLightState(), "idle");
});

test("el exceso con VSC sanciona con la regla del VSC, no con la de la formación", () => {
  const { fs, muestra, formationEngine, vscEngine } = armar();
  fs.beginFormation();
  fs.triggerGreen();
  fs.toggleVsc();
  // 70 km/h: debajo del límite de formación (80), arriba del de VSC (60).
  muestra(0, 70);
  muestra(600, 70);
  muestra(1200, 70);
  assert.equal(formationEngine.getAll().length, 0);
  assert.equal(vscEngine.getAll().length, 1);
  assert.match(vscEngine.getAll()[0].reason, /^VSC: superó 60 km\/h/);
});

test("en el VSC ending ya no se controla la velocidad", () => {
  const { fs, muestra, vscEngine } = armar(5);
  fs.beginFormation();
  fs.triggerGreen();
  fs.toggleVsc();
  fs.toggleVsc();
  muestra(0, 150);
  muestra(600, 150);
  muestra(1200, 150);
  assert.equal(vscEngine.getAll().length, 0);
  fs.reset();
});

test("un config sin VSC lo arma copiando las reglas de la largada", () => {
  const config = parseConfig({ formation: { penalty: { speedThresholdKmh: 95, toleranceSeconds: 7 } } });
  assert.equal(config.vsc.penalty.speedThresholdKmh, 95);
  assert.equal(config.vsc.penalty.toleranceSeconds, 7);
  assert.equal(config.vsc.endingSeconds, 10);
  // Copia y no la misma referencia: cambiar la largada no mueve el VSC.
  config.formation.penalty.speedThresholdKmh = 120;
  assert.equal(config.vsc.penalty.speedThresholdKmh, 95);
});
