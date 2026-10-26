import { strict as assert } from "assert";
import { test } from "node:test";
import { buildReport, formatLap, reportFileName, toCsv } from "../report/raceReport";
import { Penalty } from "../penalty/penaltyEngine";
import { CarState } from "../state/stateTracker";
import { Incident } from "../incident/incidentEngine";

const SESSION_RACE = 3;

function car(over: Partial<CarState> & { carId: number }): CarState {
  return {
    driverName: "Piloto " + over.carId,
    driverGuid: "guid-" + over.carId,
    carModel: "ks_ferrari_488_gt3",
    connected: true,
    speedKmh: 0,
    posX: 0,
    posY: 0,
    posZ: 0,
    normalizedSplinePosition: 0,
    lapCount: 0,
    lastUpdate: 1,
    lastLapMs: null,
    bestLapMs: null,
    ...over,
  };
}

function penalty(over: Partial<Penalty> & { id: string; driverGuid: string }): Penalty {
  return {
    carId: 0,
    reason: "motivo",
    type: "DT",
    status: "servingWindow",
    graceLapsRemaining: 3,
    createdAt: 1000,
    ...over,
  } as Penalty;
}

function report(opts: {
  cars: CarState[];
  penalties?: Array<[string, Penalty[]]>;
  incidents?: Incident[];
}) {
  return buildReport({
    leagueName: "Liga de prueba",
    version: "0.3",
    cars: opts.cars,
    sessionType: SESSION_RACE,
    session: {
      track: "ks_barcelona",
      trackConfig: "layout_gp",
      name: "Carrera",
      sessionType: SESSION_RACE,
    } as any,
    penaltiesByEngine: opts.penalties || [],
    incidents: opts.incidents || [],
    now: Date.UTC(2026, 9, 22, 20, 30),
  });
}

test("la clasificación ordena por progreso y pone al fondo a quien abandonó", () => {
  // Quien se fue puede tener una posición por progreso buenísima —se fue puntero— pero el resto
  // siguió corriendo. Mezclarlo con los que terminaron da una tabla que miente.
  const r = report({
    cars: [
      car({ carId: 1, lapCount: 10, normalizedSplinePosition: 0.2 }),
      car({ carId: 2, lapCount: 12, normalizedSplinePosition: 0.9, connected: false }),
      car({ carId: 3, lapCount: 11, normalizedSplinePosition: 0.1 }),
    ],
  });
  assert.deepEqual(
    r.classification.map((row) => row.driverName),
    ["Piloto 3", "Piloto 1", "Piloto 2"]
  );
  assert.equal(r.classification[2].finished, false);
});

test("los segundos de penalización se suman por piloto", () => {
  const r = report({
    cars: [car({ carId: 1 })],
    penalties: [
      [
        "steward",
        [
          penalty({ id: "P1", driverGuid: "guid-1", type: "TIME", timePenaltySeconds: 5, status: "served" }),
          penalty({ id: "P2", driverGuid: "guid-1", type: "TIME", timePenaltySeconds: 10, status: "served" }),
          penalty({ id: "P3", driverGuid: "guid-1", type: "DT" }),
        ],
      ],
    ],
  });
  assert.equal(r.classification[0].timePenaltySeconds, 15);
  // El DT sin cumplir se cuenta aparte: no son segundos, es algo que el admin tiene que decidir.
  assert.equal(r.classification[0].unservedPenalties, 1);
});

test("una sanción escalada a DQ marca al piloto como descalificado", () => {
  const r = report({
    cars: [car({ carId: 1 })],
    penalties: [["pit", [penalty({ id: "P1", driverGuid: "guid-1", status: "escalated", escalatedTo: "DQ" })]]],
  });
  assert.equal(r.classification[0].disqualified, true);
});

/**
 * La mitad que importa de poder anular.
 *
 * Si los segundos de una sanción anulada siguieran sumando en el informe, el botón solo cambiaría
 * una etiqueta en la pantalla: el piloto igual perdería el puesto en la planilla del campeonato,
 * que es el único lugar donde la sanción tiene consecuencias de verdad.
 */
test("una sanción anulada no suma al resultado, pero sigue escrita en el informe", () => {
  const r = report({
    cars: [car({ carId: 1 })],
    penalties: [
      [
        "steward",
        [
          penalty({ id: "P1", driverGuid: "guid-1", type: "TIME", timePenaltySeconds: 5, status: "served" }),
          penalty({
            id: "P2",
            driverGuid: "guid-1",
            type: "TIME",
            timePenaltySeconds: 30,
            status: "revoked",
            revokedFrom: "served",
            revokedAt: 2000,
          }),
          penalty({ id: "P3", driverGuid: "guid-1", type: "DT", status: "revoked", revokedFrom: "servingWindow" }),
        ],
      ],
    ],
  });
  assert.equal(r.classification[0].timePenaltySeconds, 5);
  // La DT anulada tampoco queda como deuda: no hay nada que el admin tenga que decidir sobre ella.
  assert.equal(r.classification[0].unservedPenalties, 0);
  // Y las tres siguen en la lista, que es lo que permite auditar la corrección.
  assert.equal(r.penalties.length, 3);
  assert.equal(r.penalties.filter((p) => p.status === "Anulada").length, 2);
});

test("un DQ anulado deja de descalificar", () => {
  // Es el caso en que el registro y la realidad no coinciden: el kick ya se ejecutó. Lo que la
  // clasificación tiene que reflejar es la decisión final del comisario, no el kick.
  const r = report({
    cars: [car({ carId: 1 })],
    penalties: [
      [
        "pit",
        [penalty({ id: "P1", driverGuid: "guid-1", status: "revoked", revokedFrom: "escalated", escalatedTo: "DQ" })],
      ],
    ],
  });
  assert.equal(r.classification[0].disqualified, false);
});

test("el circuito y la variante se muestran como los lee una persona", () => {
  const r = report({ cars: [car({ carId: 1 })] });
  assert.equal(r.track, "Barcelona · GP");
});

test("el informe no inventa un tiempo total de carrera", () => {
  // El UDP de AC no lo transporta. Si apareciera una columna de tiempo total, sería un número
  // calculado por nosotros con pinta de oficial, que es exactamente lo que no queremos.
  const csv = toCsv(report({ cars: [car({ carId: 1, lapCount: 5, bestLapMs: 93402 })] }));
  assert.ok(!/tiempo total/i.test(csv));
  assert.ok(csv.includes("1:33.402"), "falta la mejor vuelta");
});

test("el CSV separa con punto y coma y escapa lo que lo rompería", () => {
  // Excel en español parte por `;`. Con comas, todo el informe cae en una sola columna.
  const csv = toCsv(
    report({
      cars: [car({ carId: 1 })],
      penalties: [["steward", [penalty({ id: "P1", driverGuid: "guid-1", reason: 'Toque; "fuerte"' })]]],
    })
  );
  assert.ok(csv.includes(';"Toque; ""fuerte"""'), "el motivo con punto y coma no quedó escapado:\n" + csv);
  assert.ok(csv.startsWith("﻿"), "falta el BOM: Excel rompe los acentos sin él");
  assert.ok(csv.includes("\r\n"), "los saltos de línea tienen que ser CRLF");
});

test("sin sanciones ni incidentes el informe lo dice en vez de quedar vacío", () => {
  const csv = toCsv(report({ cars: [car({ carId: 1 })] }));
  assert.ok(csv.includes("Sin sanciones."));
  assert.ok(csv.includes("Sin incidentes."));
});

test("el nombre del archivo no tiene caracteres que Windows rechace", () => {
  const name = reportFileName(report({ cars: [car({ carId: 1 })] }));
  assert.ok(/^informe-barcelona-2026-10-22-20-30\.csv$/.test(name), name);
  assert.ok(!/[\\/:*?"<>|]/.test(name));
});

test("formatLap deja vacío lo que no es un tiempo", () => {
  assert.equal(formatLap(null), "");
  assert.equal(formatLap(0), "");
  assert.equal(formatLap(93402), "1:33.402");
  assert.equal(formatLap(3723001), "62:03.001");
});
