import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import {
  applyProfile,
  deleteProfile,
  mergeConfigInto,
  parseConfig,
  rulesFingerprint,
  saveProfile,
  setConfigDir,
  snapshotRules,
  validateConfig,
} from "../config";

/** Los perfiles se guardan en disco, así que estos tests necesitan una carpeta propia: sin esto
 * le pisarían el `config.json` real a quien esté desarrollando. */
function enCarpetaPropia(): void {
  setConfigDir(fs.mkdtempSync(path.join(os.tmpdir(), "rc-config-test-")));
}

test("un config.json vacío arranca con el catálogo por defecto", () => {
  const config = parseConfig({});
  assert.equal(config.infractions.carContact.action, "review");
  assert.equal(config.infractions.trackLimits.minTyresOut, 4);
  assert.deepEqual(config.ruleProfiles, []);
  assert.equal(config.activeProfileId, "");
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

test("un perfil guarda el reglamento entero y volver a cargarlo lo repone", () => {
  enCarpetaPropia();
  const config = parseConfig({});
  config.infractions.trackLimits.action = "penalty";
  config.infractions.trackLimits.minTyresOut = 2;
  config.pit.stopGoSeconds = 45;
  config.formation.penalty.graceLaps = 1;
  const guardado = saveProfile(config, "Endurance");
  assert.ok(!("error" in guardado), "no se pudo guardar el perfil");

  // El admin cambia las reglas para otra fecha...
  config.infractions.trackLimits.action = "log";
  config.infractions.trackLimits.minTyresOut = 4;
  config.pit.stopGoSeconds = 20;
  config.formation.penalty.graceLaps = 5;

  // ...y vuelve al perfil de la anterior.
  const aplicado = applyProfile(config, (guardado as any).id);
  assert.ok(!("error" in aplicado));
  assert.equal(config.infractions.trackLimits.action, "penalty");
  assert.equal(config.infractions.trackLimits.minTyresOut, 2);
  assert.equal(config.pit.stopGoSeconds, 45);
  assert.equal(config.formation.penalty.graceLaps, 1);
  assert.equal(config.activeProfileId, (guardado as any).id);
});

test("cargar un perfil no toca la instalación", () => {
  // Es la razón por la que un perfil guarda un subconjunto y no la config entera: si cargar
  // "Endurance" pudiera cambiar un puerto o la dirección pública, nadie lo apretaría nunca.
  enCarpetaPropia();
  const config = parseConfig({ leagueName: "Liga del Sur", http: { adminPort: 4000, clientPort: 4001 } });
  const guardado = saveProfile(config, "Base") as any;
  config.leagueName = "Otra cosa";
  config.http.adminPort = 4000;
  applyProfile(config, guardado.id);
  assert.equal(config.leagueName, "Otra cosa", "el perfil no puede renombrar la liga");
  assert.equal(config.http.adminPort, 4000);
  assert.equal(config.shadowMode, true, "ni prender o apagar el modo sombra");
});

test("cargar un perfil muta el catálogo en lugar de reemplazarlo", () => {
  // Los motores guardan la referencia a `config.infractions`: si el perfil reemplazara el objeto,
  // seguirían leyendo las reglas viejas hasta reiniciar el proceso. El panel diría "cargado" y en
  // pista no cambiaría nada.
  enCarpetaPropia();
  const config = parseConfig({});
  config.infractions.trackLimits.minTyresOut = 2;
  const guardado = saveProfile(config, "Estricto") as any;
  config.infractions.trackLimits.minTyresOut = 4;

  const catalogRef = config.infractions;
  const trackLimitsRef = config.infractions.trackLimits;
  const penaltyRef = config.formation.penalty;
  applyProfile(config, guardado.id);
  assert.equal(config.infractions, catalogRef);
  assert.equal(config.infractions.trackLimits, trackLimitsRef);
  assert.equal(config.formation.penalty, penaltyRef);
  assert.equal(trackLimitsRef.minTyresOut, 2);
});

test("no se pueden guardar dos perfiles con el mismo nombre", () => {
  enCarpetaPropia();
  const config = parseConfig({});
  saveProfile(config, "Endurance");
  config.pit.stopGoSeconds = 45; // para que el choque sea por nombre y no por contenido

  const repetido = saveProfile(config, "  endurance ");
  assert.ok("error" in repetido, "se guardó un segundo perfil con el mismo nombre");
  assert.match((repetido as any).error, /Endurance/, "el aviso tiene que decir cuál es");
  assert.equal(config.ruleProfiles.length, 1);
});

test("un perfil con las mismas reglas que otro no se guarda, y el aviso dice cuál es", () => {
  enCarpetaPropia();
  const config = parseConfig({});
  saveProfile(config, "4Fun");

  const igual = saveProfile(config, "Amistosa");
  assert.ok("error" in igual);
  assert.match((igual as any).error, /4Fun/);
  assert.equal(config.ruleProfiles.length, 1);
});

test("la firma de las reglas no depende del orden de las claves", () => {
  // Sin ordenar, dos reglamentos idénticos armados por caminos distintos —uno a mano, otro
  // cargado de un perfil— darían firmas distintas y la validación de contenido repetido no
  // detectaría nada. Es el modo de falla peor: la validación existe y no hace nada.
  const a = snapshotRules(parseConfig({}));
  const b = snapshotRules(parseConfig({}));
  const desordenado = JSON.parse(JSON.stringify({ presence: b.presence, pit: b.pit, formation: b.formation, infractions: b.infractions }));
  assert.equal(rulesFingerprint(a), rulesFingerprint(desordenado));
});

test("borrar un perfil no cambia el reglamento que está corriendo", () => {
  enCarpetaPropia();
  const config = parseConfig({});
  config.pit.stopGoSeconds = 45;
  const guardado = saveProfile(config, "Endurance") as any;
  deleteProfile(config, guardado.id);
  assert.equal(config.ruleProfiles.length, 0);
  assert.equal(config.activeProfileId, "");
  assert.equal(config.pit.stopGoSeconds, 45, "borrar una fila de una lista no puede cambiar una carrera en curso");
});

test("el modo de torneo de una versión anterior se descarta sin dejar restos", () => {
  // Los tres presets desaparecieron en la 1.2. La clave tiene que irse del archivo: si quedara,
  // estaría al lado de los perfiles sin hacer nada y confundiendo a cualquiera que lo abra.
  const config = parseConfig({ preset: "estricto" }) as any;
  assert.equal(config.preset, undefined);
  assert.deepEqual(config.ruleProfiles, []);
});

test("un perfil corrupto en el archivo no tumba el arranque", () => {
  const config = parseConfig({
    ruleProfiles: [
      { id: "ok", name: "Bueno", createdAt: "2026-01-01T00:00:00.000Z", rules: { pit: { stopGoSeconds: 45 } } },
      { id: "", name: "Sin id" },
      "basura",
      { id: "x", name: "   " },
      { id: "ok", name: "Id repetido" },
    ],
    activeProfileId: "fantasma",
  });
  assert.equal(config.ruleProfiles.length, 1);
  assert.equal(config.ruleProfiles[0].name, "Bueno");
  assert.equal(config.ruleProfiles[0].rules.pit.stopGoSeconds, 45);
  assert.equal(config.ruleProfiles[0].rules.infractions.trackLimits.minTyresOut, 4, "los huecos se completan con los valores de fábrica");
  assert.equal(config.activeProfileId, "", "el perfil activo apuntaba a uno que no existe");
});

test("un perfil no puede meter por la ventana un valor que el panel no deja escribir", () => {
  const config = parseConfig({
    ruleProfiles: [
      {
        id: "p1",
        name: "Trucho",
        createdAt: "2026-01-01T00:00:00.000Z",
        // "Sancionar solo" no se admite en toques: el servidor sabe que hubo contacto, no quién
        // tuvo la culpa. Y 3 ruedas afuera no es un criterio que exista.
        rules: { infractions: { carContact: { action: "penalty" }, trackLimits: { minTyresOut: 3 } } },
      },
    ],
  });
  assert.equal(config.ruleProfiles[0].rules.infractions.carContact.action, "review");
  assert.equal(config.ruleProfiles[0].rules.infractions.trackLimits.minTyresOut, 4);
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

// --- Mutación in place: lo que hace que tocar una regla en el panel se aplique en vivo --------
//
// Los motores guardan la referencia al sub-objeto de config (`PitSpeedMonitor` se queda con
// `config.pit.zone`, `TrackLimitsTracker` con `config.infractions.trackLimits`). Si la validación
// reemplaza el objeto en vez de corregirlo, el motor sigue leyendo el viejo: el panel dice
// "guardado" y en pista no cambia nada. Es un bug silencioso, por eso se fija con tests.

test("corregir una zona de pit inválida no reemplaza el objeto que miran los motores", () => {
  const config = parseConfig({});
  const zone = config.pit.zone;
  (zone as unknown as Record<string, unknown>).splineStart = "casi al final";

  validateConfig(config);

  assert.equal(config.pit.zone, zone, "PitSpeedMonitor quedaría mirando el objeto viejo");
  assert.equal(zone.splineStart, 0.97);
  assert.equal(zone.splineEnd, 0.995);
});

test("reponer una infracción rota no reemplaza el objeto que mira el tracker", () => {
  const config = parseConfig({});
  const infractions = config.infractions;
  (infractions as unknown as Record<string, unknown>).trackLimits = null;

  validateConfig(config);

  assert.equal(config.infractions, infractions);
  assert.equal(config.infractions.trackLimits.minTyresOut, 4);
});

// --- Prototype pollution ----------------------------------------------------------------------
//
// Mientras el panel vivía en loopback esto era teórico. Con el portal, el cuerpo de un
// POST /api/config llega de internet, y una sola clave `__proto__` le inyecta propiedades a todos
// los objetos del proceso: a partir de ahí cualquier `if (obj.loQueSea)` da verdadero.

test("una clave __proto__ en el config no envenena Object.prototype", () => {
  const raw = JSON.parse('{"leagueName":"Liga","__proto__":{"colado":"si"}}');
  const config = parseConfig(raw);

  assert.equal(config.leagueName, "Liga");
  assert.equal(({} as Record<string, unknown>).colado, undefined);
  assert.equal((config as unknown as Record<string, unknown>).colado, undefined);
});

test("mergeConfigInto ignora constructor y prototype", () => {
  const target: Record<string, unknown> = { ok: 1 };
  mergeConfigInto(target, JSON.parse('{"constructor":{"x":1},"prototype":{"y":2},"ok":2}'));

  assert.equal(target.ok, 2);
  assert.equal(target.constructor, Object);
});
