import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  adoptLeagueProfiles,
  applyProfile,
  parseConfig,
  saveProfile,
  setConfigDir,
  setLeagueProfilesFile,
  syncLeagueProfiles,
} from "../config";

/**
 * Perfiles de reglas compartidos por la liga (1.49). El bug: cada servidor guardaba los suyos en
 * su config.json, y un perfil creado en el panel de un servidor no aparecía en el de otro. Lo que
 * se reportó fue "el deploy me borra los perfiles".
 *
 * Dos servidores de la misma liga se simulan con dos configs y dos carpetas, cambiando
 * `setConfigDir` entre uno y otro igual que lo haría cada worker en su proceso.
 */
function carpeta(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-perfiles-"));
}

test("un perfil guardado en un servidor aparece en otro de la misma liga", (t) => {
  const liga = path.join(carpeta(), "perfiles.json");
  const dirA = carpeta();
  const dirB = carpeta();
  t.after(() => {
    setLeagueProfilesFile(null);
    setConfigDir(path.join(__dirname, ".."));
  });
  setLeagueProfilesFile(liga);

  setConfigDir(dirA);
  const a = parseConfig({});
  adoptLeagueProfiles(a);
  setConfigDir(dirB);
  const b = parseConfig({});
  adoptLeagueProfiles(b);

  setConfigDir(dirA);
  const creado = saveProfile(a, "Endurance");
  assert.ok(!("error" in creado));

  setConfigDir(dirB);
  syncLeagueProfiles(b);
  assert.deepEqual(b.ruleProfiles.map((p) => p.name), ["Endurance"]);
  assert.equal(b.activeProfileId, "", "el perfil activo sigue siendo de cada servidor");
  assert.ok(!("error" in applyProfile(b, b.ruleProfiles[0].id)));
});

test("al migrar, los perfiles de cada servidor se juntan sin duplicar nombres ni chocar ids", (t) => {
  const liga = path.join(carpeta(), "perfiles.json");
  t.after(() => {
    setLeagueProfilesFile(null);
    setConfigDir(path.join(__dirname, ".."));
  });
  setLeagueProfilesFile(liga);
  const perfil = (id: string, name: string) => ({ id, name, createdAt: "2026-11-01T00:00:00.000Z", rules: {} });

  setConfigDir(carpeta());
  const a = parseConfig({ ruleProfiles: [perfil("perfil-1", "Endurance")] });
  adoptLeagueProfiles(a);

  setConfigDir(carpeta());
  const b = parseConfig({
    ruleProfiles: [perfil("perfil-1", "endurance "), perfil("perfil-2", "Sprint")],
    activeProfileId: "perfil-2",
  });
  adoptLeagueProfiles(b);

  assert.deepEqual(b.ruleProfiles.map((p) => p.name), ["Endurance", "Sprint"]);
  const ids = b.ruleProfiles.map((p) => p.id);
  assert.equal(new Set(ids).size, 2);
  assert.equal(b.ruleProfiles.find((p) => p.id === b.activeProfileId)?.name, "Sprint");
});
