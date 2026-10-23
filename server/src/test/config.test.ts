import { strict as assert } from "assert";
import { test } from "node:test";
import { applyPresetTo, parseConfig } from "../config";
import { PRESETS } from "../incident/catalog";

test("un config.json vacío arranca con el catálogo por defecto", () => {
  const config = parseConfig({});
  assert.equal(config.infractions.carContact.action, "review");
  assert.equal(config.infractions.trackLimits.minTyresOut, 4);
  assert.equal(config.preset, "");
});

test("un config de una versión anterior se migra al catálogo nuevo", () => {
  const config = parseConfig({
    incidents: { minContactSpeedKmh: 45, minEnvSpeedKmh: 90, trackEnvCollisions: true },
    trackLimits: { enabled: true, minTyresOut: 2, excursionsForIncident: 5, minDurationMs: 400, reviewTimeGain: false },
  });

  assert.equal(config.infractions.carContact.minImpactKmh, 45);
  assert.equal(config.infractions.envCollision.minImpactKmh, 90);
  assert.equal(config.infractions.trackLimits.minTyresOut, 2);
  assert.equal(config.infractions.trackLimits.excursionsForIncident, 5);
  assert.equal(config.infractions.trackLimits.reviewTimeGain, false);
  // Las claves viejas no pueden quedar colgando: confundirían a cualquiera que abra el archivo.
  assert.equal((config as any).incidents, undefined);
  assert.equal((config as any).trackLimits, undefined);
});

test("los booleanos del formato viejo se traducen a la acción equivalente", () => {
  const config = parseConfig({
    incidents: { minContactSpeedKmh: 30, minEnvSpeedKmh: 60, trackEnvCollisions: false },
    trackLimits: { enabled: false, minTyresOut: 4, excursionsForIncident: 3, minDurationMs: 300, reviewTimeGain: true },
  });
  assert.equal(config.infractions.envCollision.action, "ignore");
  assert.equal(config.infractions.trackLimits.action, "ignore");
});

test("'sancionar solo' se degrada a revisión donde el dato no alcanza para culpar a nadie", () => {
  const config = parseConfig({
    infractions: {
      carContact: { action: "penalty", minImpactKmh: 30 },
      envCollision: { action: "penalty", minImpactKmh: 60 },
      trackLimits: { action: "penalty", minTyresOut: 4, excursionsForIncident: 3, minDurationMs: 300, reviewTimeGain: true },
    },
  });
  assert.equal(config.infractions.carContact.action, "review", "el servidor sabe que hubo toque, no de quién fue la culpa");
  assert.equal(config.infractions.envCollision.action, "review");
  assert.equal(config.infractions.trackLimits.action, "penalty", "contar ruedas afuera sí es objetivo");
});

test("una acción inventada vuelve al valor por defecto", () => {
  const config = parseConfig({ infractions: { carContact: { action: "destruir", minImpactKmh: 30 } } });
  assert.equal(config.infractions.carContact.action, "review");
});

test("valores fuera de rango se corrigen en vez de tumbar el arranque", () => {
  const config = parseConfig({
    infractions: {
      trackLimits: { minTyresOut: 3, excursionsForIncident: 0, minDurationMs: -5, reviewTimeGain: "sí" },
      wrongWay: { minSeconds: 999, minSpeedKmh: 0 },
    },
  });
  assert.equal(config.infractions.trackLimits.minTyresOut, 4, "3 ruedas afuera no significa nada");
  assert.equal(config.infractions.trackLimits.excursionsForIncident, 3);
  assert.equal(config.infractions.trackLimits.minDurationMs, 300);
  assert.equal(config.infractions.trackLimits.reviewTimeGain, true);
  assert.equal(config.infractions.wrongWay.minSeconds, 3);
  assert.equal(config.infractions.wrongWay.minSpeedKmh, 40);
});

test("un bloque del catálogo que llega como basura se reemplaza entero", () => {
  const config = parseConfig({ infractions: { trackLimits: null, wrongWay: 7 } });
  assert.equal(config.infractions.trackLimits.minTyresOut, 4);
  assert.equal(config.infractions.wrongWay.minSeconds, 3);
});

test("aplicar un preset deja puestos los umbrales y las sanciones", () => {
  const config = parseConfig({});
  applyPresetTo(config, "estricto");

  assert.equal(config.preset, "estricto");
  assert.equal(config.infractions.carContact.minImpactKmh, 20);
  assert.equal(config.infractions.trackLimits.action, "penalty");
  assert.equal(config.infractions.trackLimits.minTyresOut, 2);
  assert.equal(config.formation.penalty.graceLaps, PRESETS.estricto.penalty.graceLaps);
  assert.equal(config.pit.penalty.toleranceSeconds, PRESETS.estricto.penalty.toleranceSeconds);
});

test("el preset no pisa lo que no menciona", () => {
  const config = parseConfig({ leagueName: "Liga del Sur", http: { adminPort: 4000, clientPort: 4001 } });
  applyPresetTo(config, "casual");
  assert.equal(config.leagueName, "Liga del Sur");
  assert.equal(config.http.adminPort, 4000);
});

test("el preset muta el catálogo en lugar de reemplazarlo", () => {
  // Los motores guardan la referencia a `config.infractions`: si el preset reemplazara el objeto,
  // seguirían leyendo las reglas viejas hasta reiniciar el proceso.
  const config = parseConfig({});
  const catalogRef = config.infractions;
  const trackLimitsRef = config.infractions.trackLimits;
  applyPresetTo(config, "estricto");
  assert.equal(config.infractions, catalogRef);
  assert.equal(config.infractions.trackLimits, trackLimitsRef);
  assert.equal(trackLimitsRef.minTyresOut, 2);
});

test("cambiar de preset vuelve a dejar los valores del nuevo", () => {
  const config = parseConfig({});
  applyPresetTo(config, "estricto");
  applyPresetTo(config, "casual");
  assert.equal(config.preset, "casual");
  assert.equal(config.infractions.trackLimits.action, "log");
  assert.equal(config.infractions.trackLimits.minTyresOut, 4);
});

test("un preset inventado en el archivo no se conserva", () => {
  const config = parseConfig({ preset: "inventado" });
  assert.equal(config.preset, "");
});

test("los dos puertos HTTP nunca quedan en el mismo número", () => {
  // El panel deja editarlos: escribir 3000 en los dos es un error de un solo tipeo, y el síntoma
  // sería que la app directamente no abre la próxima vez.
  const config = parseConfig({ http: { adminPort: 3000, clientPort: 3000 } });
  assert.equal(config.http.adminPort, 3000);
  assert.equal(config.http.clientPort, 3001);
});

test("un puerto fuera de rango vuelve al de fábrica", () => {
  const config = parseConfig({ http: { adminPort: 80, clientPort: 999999 } });
  assert.equal(config.http.adminPort, 3000);
  assert.equal(config.http.clientPort, 3001);
});

test("puertos propios válidos se respetan tal cual", () => {
  const config = parseConfig({ http: { adminPort: 8080, clientPort: 8081 } });
  assert.equal(config.http.adminPort, 8080);
  assert.equal(config.http.clientPort, 8081);
});
