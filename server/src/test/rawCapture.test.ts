import { strict as assert } from "assert";
import { test } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RawCapture, pruneOldLogs } from "../log/journal";

/**
 * Rotación de `raw.bin`.
 *
 * Lo que se está protegiendo acá es el disco del admin: la captura cruda crece a ~40 MB por hora
 * de carrera con 24 autos, y antes no tenía techo. Un admin que deja el backend abierto una
 * temporada entera se quedaba sin espacio sin entender por qué.
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-raw-"));
}

/** Tamaño de un registro: 8 bytes de marca de tiempo + 2 de largo + el datagrama. */
const RECORD = (payload: number) => 10 + payload;

function archived(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((n) => /^raw-.+\.bin$/.test(n))
    .sort();
}

test("al pasarse del tamaño, archiva y empieza uno nuevo", () => {
  const dir = tempDir();
  const capture = new RawCapture(dir, () => 1000, { rotateBytes: RECORD(10) * 3 });
  for (let i = 0; i < 4; i++) capture.record(Buffer.alloc(10, i));
  capture.close();

  assert.equal(archived(dir).length, 1, "no archivó el lleno");
  assert.equal(fs.statSync(path.join(dir, "raw.bin")).size, RECORD(10), "el nuevo no arrancó vacío");
  assert.equal(fs.statSync(path.join(dir, archived(dir)[0])).size, RECORD(10) * 3);
});

test("nunca parte un registro entre dos archivos", () => {
  // Un registro cortado al medio no lo puede leer el replay, y el replay es la única forma de
  // reprocesar una carrera real cuando se corrige el decodificador.
  const dir = tempDir();
  const capture = new RawCapture(dir, () => 1000, { rotateBytes: RECORD(10) * 2 + 3 });
  for (let i = 0; i < 5; i++) capture.record(Buffer.alloc(10, i));
  capture.close();

  for (const name of [...archived(dir), "raw.bin"]) {
    const buf = fs.readFileSync(path.join(dir, name));
    let offset = 0;
    while (offset < buf.length) {
      assert.ok(offset + 10 <= buf.length, `${name}: cabecera cortada en ${offset}`);
      const len = buf.readUInt16LE(offset + 8);
      offset += 10 + len;
      assert.ok(offset <= buf.length, `${name}: datagrama cortado`);
    }
    assert.equal(offset, buf.length, `${name}: sobraron bytes sueltos`);
  }
});

test("solo se conservan los últimos archivos, no un historial", () => {
  const dir = tempDir();
  const capture = new RawCapture(dir, () => 1000, { rotateBytes: RECORD(10), keepFiles: 2 });
  for (let i = 0; i < 6; i++) capture.record(Buffer.alloc(10, i));
  capture.close();
  assert.equal(archived(dir).length, 2);
});

test("dos rotaciones en el mismo milisegundo no se pisan", () => {
  // El nombre del archivado sale de la hora en ISO: sin desempate, la segunda rotación renombra
  // encima de la primera y la captura anterior desaparece en silencio.
  const dir = tempDir();
  const capture = new RawCapture(dir, () => 1000, { rotateBytes: RECORD(10), keepFiles: 10 });
  for (let i = 0; i < 4; i++) capture.record(Buffer.alloc(10, i));
  capture.close();
  assert.equal(archived(dir).length, 3);
  assert.equal(new Set(archived(dir)).size, 3, "hay nombres repetidos");
});

test("un reinicio no reinicia el contador de tamaño", () => {
  // Si cada arranque volviera a contar desde cero, el archivo crecería sin techo igual: un admin
  // que abre y cierra el backend entre tandas nunca llegaría a rotar.
  const dir = tempDir();
  const first = new RawCapture(dir, () => 1000, { rotateBytes: RECORD(10) * 3 });
  for (let i = 0; i < 3; i++) first.record(Buffer.alloc(10, i));
  first.close();

  const second = new RawCapture(dir, () => 1000, { rotateBytes: RECORD(10) * 3 });
  second.record(Buffer.alloc(10, 9));
  second.close();

  assert.equal(archived(dir).length, 1, "el reinicio volvió a contar desde cero");
});

// --- Retención de logs ---------------------------------------------------------------------------

/** Escribe un archivo y le pone la fecha de modificación que haga falta para la prueba. */
function conEdad(dir: string, nombre: string, diasAtras: number): string {
  const file = path.join(dir, nombre);
  fs.writeFileSync(file, "x");
  const cuando = new Date(Date.now() - diasAtras * 24 * 60 * 60 * 1000);
  fs.utimesSync(file, cuando, cuando);
  return file;
}

test("la retención borra los eventos viejos y deja los recientes", () => {
  const dir = tempDir();
  conEdad(dir, "events-viejo.jsonl", 120);
  conEdad(dir, "events-reciente.jsonl", 10);

  assert.equal(pruneOldLogs(dir, { eventsDays: 90, rawDays: 7 }), 1);
  assert.ok(!fs.existsSync(path.join(dir, "events-viejo.jsonl")));
  assert.ok(fs.existsSync(path.join(dir, "events-reciente.jsonl")));
});

test("la captura cruda se borra mucho antes que los eventos", () => {
  // Son dos plazos distintos a propósito: el journal es la prueba de por qué se sancionó a
  // alguien y tiene que durar una temporada; el binario crudo es diagnóstico y pesa 40 MB por hora.
  const dir = tempDir();
  conEdad(dir, "raw-viejo.bin", 30);
  conEdad(dir, "events-del-mismo-dia.jsonl", 30);

  assert.equal(pruneOldLogs(dir, { eventsDays: 90, rawDays: 7 }), 1);
  assert.ok(!fs.existsSync(path.join(dir, "raw-viejo.bin")));
  assert.ok(fs.existsSync(path.join(dir, "events-del-mismo-dia.jsonl")));
});

test("la retención no toca nada que no sea un log nuestro", () => {
  // La carpeta de datos de una liga tiene más cosas adentro. Un barrido por antigüedad que se
  // lleve puesto el config.json o una clave es un desastre silencioso.
  const dir = tempDir();
  conEdad(dir, "raw.bin", 365);
  conEdad(dir, "config.json", 365);
  conEdad(dir, "pilot.key", 365);

  assert.equal(pruneOldLogs(dir, { eventsDays: 1, rawDays: 1 }), 0);
  assert.equal(fs.readdirSync(dir).length, 3);
});

test("una carpeta que no existe no es un error", () => {
  assert.equal(pruneOldLogs(path.join(tempDir(), "no-existe"), { eventsDays: 90, rawDays: 7 }), 0);
});
