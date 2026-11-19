// Espelho: lib/types.ts, lib/constants.ts e lib/workflow.ts da web e do app são o mesmo arquivo, byte a byte (pega a
// cópia esquecida). Sem a pasta do app (contêiner só da web), pula: confira com cmp. Sem dependência nova: node:test.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const FILES = ["types.ts", "constants.ts", "workflow.ts"];
const WEB = new URL("../src/lib/", import.meta.url);
const APP = new URL("../../mobile/src/lib/", import.meta.url);

/** A primeira linha diferente (1 em diante), para achar a cópia esquecida. */
function firstDifferentLine(a, b) {
  const x = a.toString("utf8").split("\n");
  const y = b.toString("utf8").split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return i + 1;
  return 0;
}

describe("espelho de lib/ entre a web e o app", () => {
  if (!existsSync(APP)) {
    it.skip("pasta mobile ausente: rode o cmp");
    return;
  }
  for (const file of FILES) {
    it(`${file} igual nas duas cópias`, () => {
      const web = readFileSync(new URL(file, WEB));
      const app = readFileSync(new URL(file, APP));
      assert.ok(
        web.equals(app),
        `frontend/src/lib/${file} e mobile/src/lib/${file} diferem (linha ${firstDifferentLine(web, app)}): copie a da web para o app`,
      );
    });
  }
});
