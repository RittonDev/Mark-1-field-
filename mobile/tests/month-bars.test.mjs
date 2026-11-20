// Sonda das contas do gráfico das Estatísticas (src/lib/monthBars.ts): eixo, barras, faixas do sistema antigo, rótulos
// dos meses e as frases da leitura. O módulo é puro e sem import, para rodar direto no Node. Sem dependência nova:
// node:test. Na pasta mobile:
// node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  axisLabelsShown,
  axisTicks,
  barPath,
  barRects,
  barWidth,
  countText,
  formatCount,
  legacyRuns,
  monthReadout,
  stepSelection,
  totalReadout,
} from "../src/lib/monthBars.ts";

const SERVICES = { one: "atendimento", many: "atendimentos", none: "Nenhum atendimento" };
const REWORKS = { one: "retorno", many: "retornos", none: "Nenhum retorno" };
const text = (readout) => `${readout.strong}${readout.rest}`;

describe("eixo e barras", () => {
  it("axisTicks: 0, o passo e o dobro, com o dobro cobrindo o maior valor", () => {
    assert.deepEqual(axisTicks(0), [0, 1, 2]);
    assert.deepEqual(axisTicks(1), [0, 1, 2]);
    assert.deepEqual(axisTicks(3), [0, 2, 4]);
    assert.deepEqual(axisTicks(18), [0, 10, 20]);
    assert.deepEqual(axisTicks(20), [0, 10, 20]);
    assert.deepEqual(axisTicks(41), [0, 25, 50]);
    assert.deepEqual(axisTicks(1200), [0, 1000, 2000]);
    assert.deepEqual(axisTicks(Number.NaN), [0, 1, 2]);
  });

  it("barWidth: 55% da faixa, entre 6 e 16", () => {
    assert.equal(barWidth(22), 12);
    assert.equal(barWidth(8), 6);
    assert.equal(barWidth(40), 16);
  });

  it("barRects: sem barra no zero e no sem medição; mínimo de 3; centradas na faixa e apoiadas na base", () => {
    const plotLeft = 32;
    const plotWidth = 264;
    const plotTop = 16;
    const plotHeight = 112;
    const values = [null, 0, 1, 2000, 500, 3, 7, 0, 12, 1999, null, 40];
    const bars = barRects(values, plotLeft, plotWidth, plotTop, plotHeight, 2000);
    const slot = plotWidth / values.length;
    assert.equal(bars.length, 12);
    assert.equal(bars[0], null);
    assert.equal(bars[1], null);
    assert.equal(bars[10], null);
    assert.equal(bars[2].height, 3);
    assert.equal(bars[3].height, plotHeight);
    assert.equal(bars[3].y, plotTop);
    bars.forEach((bar, index) => {
      if (!bar) return;
      assert.ok(Math.abs(bar.y + bar.height - (plotTop + plotHeight)) < 1e-9, `base da barra ${index}`);
      const center = bar.x + bar.width / 2;
      assert.ok(Math.abs(center - (plotLeft + index * slot + slot / 2)) < 1e-9, `centro da barra ${index}`);
      assert.equal(bar.width, barWidth(slot));
    });
  });

  it("barPath: começa e termina na base (reta) e arredonda o topo com raio até 4", () => {
    for (const rect of [
      { x: 10, y: 20, width: 12, height: 50 },
      { x: 10, y: 67, width: 12, height: 3 },
    ]) {
      const d = barPath(rect);
      const base = rect.y + rect.height;
      assert.ok(d.startsWith(`M ${rect.x} ${base} `), d);
      assert.ok(d.endsWith(`V ${base} Z`), d);
      const radii = [...d.matchAll(/A (\S+) (\S+) /g)].map((match) => Number(match[1]));
      assert.equal(radii.length, 2);
      for (const r of radii) assert.ok(r > 0 && r <= 4 && r <= rect.height, `raio ${r}`);
    }
  });

  it("legacyRuns: uma faixa por sequência de meses do sistema antigo", () => {
    assert.deepEqual(legacyRuns([true, true, false, true]), [
      [0, 1],
      [3, 3],
    ]);
    assert.deepEqual(legacyRuns([false, false]), []);
    assert.deepEqual(legacyRuns(Array(12).fill(true)), [[0, 11]]);
  });

  it("axisLabelsShown: todos quando cabem; senão um sim e um não, a partir do mês atual", () => {
    assert.deepEqual(axisLabelsShown(12, 22, 19), Array(12).fill(true));
    const shown = axisLabelsShown(12, 22, 26);
    const indexes = shown.flatMap((on, index) => (on ? [index] : []));
    assert.deepEqual(indexes, [1, 3, 5, 7, 9, 11]);
    assert.equal(shown[11], true);
  });
});

describe("leitura do gráfico", () => {
  it("countText: plural, ponto de milhar e o Nenhum", () => {
    assert.equal(countText(1, REWORKS), "1 retorno");
    assert.equal(countText(3, REWORKS), "3 retornos");
    assert.equal(countText(0, REWORKS), "Nenhum retorno");
    assert.equal(countText(1284, SERVICES), "1.284 atendimentos");
    assert.equal(formatCount(1000), "1.000");
  });

  it("totalReadout: a soma dos meses medidos, o Nenhum e o sem medição", () => {
    const services = [10, 12, 9, 15, 11, 13, 14, 12, 10, 11, 14, 12];
    assert.equal(services.reduce((sum, value) => sum + value, 0), 143);
    assert.deepEqual(totalReadout(services, SERVICES), { strong: "143", rest: " atendimentos em 12 meses" });
    assert.equal(text(totalReadout(Array(12).fill(0), REWORKS)), "Nenhum retorno em 12 meses");
    assert.equal(text(totalReadout([null, null, 1, 0], REWORKS)), "1 retorno em 4 meses");
    assert.equal(text(totalReadout(Array(12).fill(null), REWORKS)), "Sem medição nos 12 meses (sistema antigo)");
  });

  it("monthReadout: o mês por extenso, com o até hoje e o sistema antigo", () => {
    assert.equal(text(monthReadout(18, SERVICES, "outubro de 2026", false)), "18 atendimentos · outubro de 2026");
    assert.equal(text(monthReadout(4, SERVICES, "novembro de 2026", true)), "4 atendimentos · novembro de 2026, até hoje");
    assert.equal(text(monthReadout(0, REWORKS, "outubro de 2026", false)), "Nenhum retorno · outubro de 2026");
    assert.equal(text(monthReadout(null, REWORKS, "outubro de 2026", false)), "Sem medição · outubro de 2026 (sistema antigo)");
    assert.deepEqual(monthReadout(1, REWORKS, "outubro de 2026", false), { strong: "1", rest: " retorno · outubro de 2026" });
  });

  it("stepSelection: sem escolha começa no mês atual; não passa das pontas", () => {
    assert.equal(stepSelection(null, 12, 1), 11);
    assert.equal(stepSelection(null, 12, -1), 11);
    assert.equal(stepSelection(0, 12, -1), 0);
    assert.equal(stepSelection(11, 12, 1), 11);
    assert.equal(stepSelection(5, 12, 1), 6);
    assert.equal(stepSelection(5, 12, -1), 4);
  });
});

describe("módulo puro", () => {
  it("monthBars.ts não importa nada (roda direto no Node)", () => {
    const source = readFileSync(new URL("../src/lib/monthBars.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.doesNotMatch(source, /\brequire\(/);
  });
});
