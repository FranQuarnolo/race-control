import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import { parseConfig } from "../config";
import { createRaceControl, RaceControl } from "../core/raceControl";

/**
 * El exceso de velocidad llega a la bandeja, no solo a la hoja de sanciones.
 *
 * Hasta la 1.2 los dos monitores de velocidad emitían un evento `violation` que **no escuchaba
 * nadie**. No fallaba: el piloto recibía su Drive-Through y la sanción aparecía en su tabla. Lo
 * que no pasaba es que el comisario pudiera ver el patrón — el resumen de un piloto decía "0
 * incidentes" con tres excesos en pit lane encima.
 *
 * Es la familia de bugs de siempre de este proyecto, y por eso el test entra por la punta real:
 * se levanta el motor entero y se le empujan posiciones, en vez de probar el monitor suelto. El
 * cable vive en `raceControl.ts`, así que un monitor perfecto con el cable cortado pasaría
 * cualquier test de unidad.
 */

function levantarMotor(sufijo: string, puertoUdp: number, puertoAdmin: number) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `rc-speed-${sufijo}-`));
  const config = parseConfig({
    leagueName: "Liga de prueba",
    http: { adminPort: puertoAdmin, clientPort: puertoAdmin + 1, publicHost: "203.0.113.5" },
    acUdp: { localPort: puertoUdp, remoteHost: "127.0.0.1", remotePort: puertoUdp + 500, remotePortSource: "manual" },
    // El modo sombra apagado para que la sanción se emita de verdad: lo que se verifica es que el
    // incidente y la sanción conviven, no que uno reemplace al otro.
    shadowMode: false,
  });
  // La tolerancia se escribe acá y no en el `parseConfig` porque el validador la clampea a >0 y
  // nos devolvería los 5 segundos de fábrica: un test que espera cinco segundos reales es un test
  // que alguien termina borrando. Se muta la referencia viva, que es lo mismo que hace el panel.
  config.formation.penalty.toleranceSeconds = 0.02;
  config.pit.penalty.toleranceSeconds = 0.02;
  config.formation.penalty.speedThresholdKmh = 80;
  config.pit.penalty.speedThresholdKmh = 60;
  return { config, dataDir, puertoAdmin };
}

async function conMotor(
  sufijo: string,
  puertoUdp: number,
  puertoAdmin: number,
  cuerpo: (rc: RaceControl, config: ReturnType<typeof parseConfig>) => Promise<void>
): Promise<void> {
  const { config, dataDir } = levantarMotor(sufijo, puertoUdp, puertoAdmin);
  const rc = await createRaceControl({
    config,
    dataDir,
    ports: { adminPort: puertoAdmin, clientPort: puertoAdmin + 1 },
  });
  try {
    await cuerpo(rc, config);
  } finally {
    rc.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function conectar(rc: RaceControl, carId: number, nombre: string): string {
  const driverGuid = String(76561190000000000n + BigInt(carId));
  rc.stateTracker.onNewConnection({
    carId,
    driverName: nombre,
    driverGuid,
    carModel: "ks_ferrari_488_gt3",
    carSkin: "default",
  } as never);
  return driverGuid;
}

/** Dos muestras separadas en el tiempo: el watcher acumula el hueco ENTRE muestras, así que con
 * una sola nunca llega a la tolerancia por más alta que sea la velocidad. */
async function pasarsePorDosMuestras(rc: RaceControl, carId: number, spline: number, kmh: number): Promise<void> {
  const empujar = () =>
    rc.stateTracker.onCarUpdate({
      carId,
      speedKmh: kmh,
      posX: 0,
      posY: 0,
      posZ: 0,
      normalizedSplinePosition: spline,
    } as never);
  empujar();
  await new Promise((r) => setTimeout(r, 40));
  empujar();
}

test("el exceso en pit lane entra a la bandeja con la velocidad máxima, además de sancionar", async () => {
  await conMotor("pit", 12710, 13710, async (rc) => {
    const guid = conectar(rc, 4, "Lucía Benegas");
    // El monitor de pit solo se arma en carrera: en formación o en idle está apagado a propósito.
    rc.phaseTracker.set("race");

    // 0.98 cae dentro de la zona de pit por defecto (0.97 a 0.995).
    await pasarsePorDosMuestras(rc, 4, 0.98, 95);

    const incidentes = rc.incidentEngine.getAll().filter((i) => i.kind === "pit-speeding");
    assert.equal(incidentes.length, 1, "el exceso en pit lane no llegó a la bandeja");
    const incidente = incidentes[0];
    assert.equal(incidente.parties[0].driverGuid, guid);
    // La máxima del pasaje, no la de ahora: el aviso llega después de la tolerancia, cuando el
    // auto ya viene frenando, y el incidente tiene que decir por qué se lo sancionó.
    assert.equal(Math.round(incidente.parties[0].speedKmh), 95);
    assert.ok(incidente.detail?.includes("95"), "el detalle no dice a cuánto iba: " + incidente.detail);
    assert.ok(incidente.detail?.includes("60"), "el detalle no dice cuál era el límite");

    // Y la sanción sigue saliendo: el incidente la acompaña, no la reemplaza.
    assert.equal(rc.pitPenaltyEngine.getPending(4).length, 1, "dejó de emitirse la sanción de pit lane");
  });
});

test("el exceso en la vuelta de formación entra a la bandeja con su propio tipo", async () => {
  await conMotor("formacion", 12720, 13720, async (rc) => {
    conectar(rc, 7, "Nahuel Ibarra");
    rc.formationStart.beginFormation();

    await pasarsePorDosMuestras(rc, 7, 0.4, 120);

    const incidentes = rc.incidentEngine.getAll();
    assert.equal(incidentes.filter((i) => i.kind === "formation-speeding").length, 1);
    // No se confunde con el de pit: son dos cuentas distintas en el resumen del piloto, y
    // mezclarlas haría que un exceso en la formación figure como uno de pit lane.
    assert.equal(incidentes.filter((i) => i.kind === "pit-speeding").length, 0);
    assert.equal(rc.formationPenaltyEngine.getPending(7).length, 1);
  });
});

test('poner el tipo en "No controlar" lo saca de la bandeja pero no deja de sancionar', async () => {
  await conMotor("ignorado", 12730, 13730, async (rc, config) => {
    // Esta es la distinción que el texto de ayuda del panel promete: la entrada del catálogo
    // gobierna el REGISTRO; el km/h y la tolerancia, que son los que deciden si hay sanción,
    // viven en Pit lane. Si acá se suprimiera también la sanción, habría dos interruptores para
    // lo mismo y el día que se contradigan nadie sabría cuál manda.
    config.infractions.pitSpeeding.action = "ignore";
    conectar(rc, 2, "Diego Sanz");
    rc.phaseTracker.set("race");

    await pasarsePorDosMuestras(rc, 2, 0.98, 110);

    assert.equal(rc.incidentEngine.getAll().filter((i) => i.kind === "pit-speeding").length, 0);
    assert.equal(rc.pitPenaltyEngine.getPending(2).length, 1, "apagar el registro no puede apagar la sanción");
  });
});
