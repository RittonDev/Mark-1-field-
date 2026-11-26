// Sonda de lib/dateField.ts (o campo de data, components/forms/DateField.tsx): quando o calendário do iPhone fecha.
// Dados fictícios. Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { URL } from "node:url";
import { isDayTap } from "../src/lib/dateField.ts";

describe("isDayTap (calendário do iPhone)", () => {
  it("toque num dia do mês à vista: fecha", () => {
    assert.equal(isDayTap("1996-11-26", "1996-11-03"), true);
    assert.equal(isDayTap("2026-11-26", "2026-11-30"), true);
  });

  it("trocar o mês ou o ano pelo cabeçalho (o mesmo dia em outro mês): não fecha", () => {
    assert.equal(isDayTap("1996-11-26", "1990-11-26"), false);
    assert.equal(isDayTap("1996-11-26", "1996-05-26"), false);
    assert.equal(isDayTap("1990-11-26", "1990-05-26"), false);
  });

  it("o mesmo dia não é toque; dia de outro mês (setas e toque) fica aberto até o OK", () => {
    assert.equal(isDayTap("1996-11-26", "1996-11-26"), false);
    assert.equal(isDayTap("2026-11-26", "2026-12-05"), false);
  });

  it("o nascimento: do calendário que abre 30 anos atrás até o dia certo", () => {
    // Abre em 26/11/1996; troca o ano para 1990 e o mês para maio pelo cabeçalho; toca no dia 3.
    let shown = "1996-11-26";
    const steps = ["1990-11-26", "1990-05-26", "1990-05-03"];
    const closes = steps.map((next) => {
      const close = isDayTap(shown, next);
      shown = next;
      return close;
    });
    assert.deepEqual(closes, [false, false, true]);
    assert.equal(shown, "1990-05-03");
  });
});

it("lib/dateField.ts é puro e sem import", () => {
  const source = readFileSync(new URL("../src/lib/dateField.ts", import.meta.url), "utf8");
  assert.equal(/^import /m.test(source), false);
});
