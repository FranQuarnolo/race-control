import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import { EmbedTokenIssuer } from "../security/embedToken";

/**
 * Calcado de `pilotToken.test.ts`: misma firma HMAC sin estado, pero acá lo que identifica al
 * token no es un piloto sino una VERSIÓN. Regenerar el token del embed es, ni más ni menos, subir
 * ese número — por eso el test central de este archivo es que la versión vieja deja de validar.
 */

function carpeta(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-embed-token-"));
}

test("un token recién emitido vale contra la versión vigente", () => {
  const dir = carpeta();
  const issuer = new EmbedTokenIssuer(dir);
  assert.equal(issuer.verify(issuer.issue(1), 1), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("regenerar (subir la versión) invalida el token viejo al instante", () => {
  // Es la propiedad que hace útil al botón "Regenerar": no hace falta rotar la clave de firma,
  // alcanza con que la versión vigente ya no sea la que el token viejo trae adentro.
  const dir = carpeta();
  const issuer = new EmbedTokenIssuer(dir);
  const tokenViejo = issuer.issue(1);
  assert.equal(issuer.verify(tokenViejo, 1), true);
  assert.equal(issuer.verify(tokenViejo, 2), false, "el token de la versión 1 no puede valer para la 2");
});

test("manipular la versión en el token no sirve para adelantarla", () => {
  const dir = carpeta();
  const issuer = new EmbedTokenIssuer(dir);
  const [kid, , firma] = issuer.issue(1).split(".");
  const adulterado = [kid, "2", firma].join(".");
  assert.equal(issuer.verify(adulterado, 2), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("el token de una liga no vale en otra", () => {
  // Cada liga firma con su propia clave: el token del embed de una no es ruido válido para otra,
  // aunque las dos estén en el mismo servidor y ambas vayan por la versión 1.
  const dirA = carpeta();
  const dirB = carpeta();
  const a = new EmbedTokenIssuer(dirA);
  const b = new EmbedTokenIssuer(dirB);

  assert.equal(b.verify(a.issue(1), 1), false);
  assert.equal(a.verify(b.issue(1), 1), false);

  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test("la clave se guarda y sobrevive al reinicio del worker", () => {
  const dir = carpeta();
  const token = new EmbedTokenIssuer(dir).issue(1);

  // Si la clave se regenerara en cada arranque, reiniciar el worker invalidaría de golpe el
  // snippet ya pegado en la página del admin, sin que nadie haya tocado "Regenerar".
  assert.equal(new EmbedTokenIssuer(dir).verify(token, 1), true);
  assert.ok(fs.existsSync(path.join(dir, "secrets", "embed.key")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("basura en el header no rompe nada", () => {
  const dir = carpeta();
  const issuer = new EmbedTokenIssuer(dir);
  for (const basura of ["", "sin-puntos", "a.b", "a.b.c.d", "....", "%%%.%%%.%%%"]) {
    assert.equal(issuer.verify(basura, 1), false, `"${basura}" no debería validar`);
  }
  assert.equal(issuer.verify(undefined, 1), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
