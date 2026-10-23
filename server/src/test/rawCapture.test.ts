import { strict as assert } from "assert";
import { test } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RawCapture } from "../log/journal";

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
