import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import { PilotTokenIssuer } from "../security/pilotToken";

function carpeta(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-token-"));
}

const GUID = "76561198000000001";
const OTRO_GUID = "76561198000000002";

test("un token recién emitido acredita al piloto que lo pidió", () => {
  const dir = carpeta();
  const issuer = new PilotTokenIssuer(dir);
  assert.equal(issuer.verify(issuer.issue(GUID)), GUID);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cambiar el guid del token lo invalida: no sirve para hacerse pasar por otro", () => {
  const dir = carpeta();
  const issuer = new PilotTokenIssuer(dir);
  const [kid, , exp, mac] = issuer.issue(GUID).split(".");

  assert.equal(issuer.verify([kid, OTRO_GUID, exp, mac].join(".")), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("estirar el vencimiento también lo invalida", () => {
  const dir = carpeta();
  const issuer = new PilotTokenIssuer(dir);
  const [kid, guid, exp, mac] = issuer.issue(GUID).split(".");

  assert.equal(issuer.verify([kid, guid, String(Number(exp) + 86400), mac].join(".")), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("un token vencido no vale", () => {
  const dir = carpeta();
  const issuer = new PilotTokenIssuer(dir);
  const token = issuer.issue(GUID, Date.now() - 48 * 60 * 60 * 1000);

  assert.equal(issuer.verify(token), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("el token de una liga no vale en otra", () => {
  // Es la propiedad que vuelve seguro tener todas las ligas en el mismo servidor: cada una firma
  // con su propia clave, así que el token de un piloto de la liga A es ruido para la liga B.
  const dirA = carpeta();
  const dirB = carpeta();
  const a = new PilotTokenIssuer(dirA);
  const b = new PilotTokenIssuer(dirB);

  assert.equal(b.verify(a.issue(GUID)), null);
  assert.equal(a.verify(b.issue(GUID)), null);

  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test("la clave se guarda y sobrevive al reinicio del worker", () => {
  const dir = carpeta();
  const token = new PilotTokenIssuer(dir).issue(GUID);

  // Si la clave se regenerara en cada arranque, un reinicio del worker dejaría a todos los
  // pilotos con credenciales muertas en medio de la carrera.
  assert.equal(new PilotTokenIssuer(dir).verify(token), GUID);
  assert.ok(fs.existsSync(path.join(dir, "secrets", "pilot.key")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("basura en el header no rompe nada", () => {
  const dir = carpeta();
  const issuer = new PilotTokenIssuer(dir);
  for (const basura of ["", "sin-puntos", "a.b.c", "a.b.c.d.e", "....", "%%%.%%%.%%%.%%%"]) {
    assert.equal(issuer.verify(basura), null, `"${basura}" no debería validar`);
  }
  assert.equal(issuer.verify(undefined), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
