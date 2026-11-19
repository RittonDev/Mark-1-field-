// Patente (a medalha do elo) e os meses dos gráficos, de lib/constants.ts (a mesma cópia do app): cores com contraste
// WCAG medido aqui, paths dentro do viewBox e o emblema que cresce com a faixa. Sem dependência nova: node:test com o
// type stripping do Node 22. Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as C from "../src/lib/constants.ts";

const TIERS = ["bronze", "silver", "gold", "diamond"];
const KINDS = ["none", ...TIERS];
const THEMES = ["light", "dark"];
/** A superfície, o canvas e o fundo dos selos de cada tema. */
const BACKGROUNDS = { light: ["#FFFFFF", "#F4F5F7", "#F9FAFB"], dark: ["#141519", "#1A1C20", "#0D0E11"] };

/** Luminância relativa (WCAG 2.x) de uma cor #RRGGBB. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste WCAG entre duas cores (de 1 a 21). */
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const colors = (kind, theme) => C.LEVEL_MEDAL_COLOR[kind][theme];

describe("cores da medalha", () => {
  it("toda faixa (e o sem elo) tem as cores em #RRGGBB nos dois temas", () => {
    assert.deepEqual(Object.keys(C.LEVEL_MEDAL_COLOR), KINDS);
    assert.deepEqual(C.LEVEL_TIER_ORDER, TIERS);
    for (const kind of KINDS) {
      for (const theme of THEMES) {
        const c = colors(kind, theme);
        assert.equal(c.rim.length, 2);
        assert.equal(c.face.length, 2);
        for (const color of [...c.rim, ...c.face, c.emblem, c.outline, c.edge]) {
          assert.match(color, /^#[0-9A-F]{6}$/i, `${kind}/${theme}`);
        }
      }
    }
  });

  it("a silhueta se separa da superfície, do canvas e do fundo dos selos (3:1 ou mais) nas 4 faixas", () => {
    for (const tier of TIERS) {
      for (const theme of THEMES) {
        for (const bg of BACKGROUNDS[theme]) {
          const ratio = contrast(colors(tier, theme).outline, bg);
          assert.ok(ratio >= 3, `${tier}/${theme} contra ${bg}: ${ratio.toFixed(2)}`);
        }
      }
    }
  });

  it("o emblema se lê na face, em cima e embaixo (4:1 ou mais)", () => {
    for (const tier of TIERS) {
      for (const theme of THEMES) {
        const c = colors(tier, theme);
        for (const face of c.face) {
          const ratio = contrast(c.emblem, face);
          assert.ok(ratio >= 4, `${tier}/${theme} contra ${face}: ${ratio.toFixed(2)}`);
        }
      }
    }
  });

  it("sem elo, a medalha fica apagada de propósito (abaixo de 3:1)", () => {
    for (const theme of THEMES) {
      for (const bg of BACKGROUNDS[theme]) {
        const ratio = contrast(colors("none", theme).outline, bg);
        assert.ok(ratio < 3, `none/${theme} contra ${bg}: ${ratio.toFixed(2)}`);
      }
    }
  });

  it("o relevo é translúcido e o nome é Ouro, nunca Gold", () => {
    for (const theme of THEMES) {
      const { sheen, shade } = C.LEVEL_MEDAL_RELIEF[theme];
      for (const opacity of [sheen, shade]) assert.ok(opacity > 0 && opacity < 1, `${theme}: ${opacity}`);
    }
    assert.deepEqual(
      TIERS.map((tier) => C.LEVEL_TIER[tier].label),
      ["Bronze", "Prata", "Ouro", "Diamante"],
    );
    assert.equal(C.LEVEL_NONE_LABEL, "Sem elo");
    assert.equal(C.LEVEL_NONE_LABEL.toUpperCase(), "SEM ELO");
  });
});

describe("desenho da medalha", () => {
  const emblems = KINDS.map((kind) => C.LEVEL_MEDAL_EMBLEM[kind]);
  const paths = [
    C.LEVEL_MEDAL_RIM_PATH,
    C.LEVEL_MEDAL_FACE_PATH,
    C.LEVEL_MEDAL_SHEEN_PATH,
    C.LEVEL_MEDAL_SHADE_PATH,
    ...emblems.flatMap((e) => [...e.strokes, ...e.fills, ...e.facets]),
  ];

  it("os paths usam coordenadas absolutas dentro do viewBox 48x48", () => {
    assert.equal(C.LEVEL_MEDAL_VIEWBOX, "0 0 48 48");
    for (const d of paths) {
      assert.match(d, /^M[\d.\sMLHVQZ-]+$/, d);
      for (const n of d.match(/-?(?:\d+\.?\d*|\.\d+)/g)) {
        const value = Number(n);
        assert.ok(value >= 0 && value <= 48, `${n} em ${d}`);
      }
    }
  });

  it("o emblema cresce com a faixa: 1, 2 e 3 divisas e a pedra do Diamante", () => {
    const strokes = (kind) => C.LEVEL_MEDAL_EMBLEM[kind].strokes.length;
    assert.ok(strokes("bronze") === 1 && strokes("silver") === 2 && strokes("gold") === 3);
    assert.ok(C.LEVEL_MEDAL_EMBLEM.diamond.fills.length > 0);
    assert.deepEqual(C.LEVEL_MEDAL_EMBLEM.none, { strokes: ["M19 24H29"], fills: [], facets: [] });
    for (const kind of ["none", "bronze", "silver", "gold"]) {
      assert.deepEqual(C.LEVEL_MEDAL_EMBLEM[kind].fills, [], kind);
      assert.deepEqual(C.LEVEL_MEDAL_EMBLEM[kind].facets, [], kind);
    }
  });

  it("chip e listas saem lisos; Perfil, comemoração e Meu elo, com relevo", () => {
    const { chip, list, profile, celebrate, hero } = C.LEVEL_MEDAL_SIZE;
    for (const size of [chip, list]) assert.ok(size < C.LEVEL_MEDAL_FLAT_BELOW, `${size}`);
    for (const size of [profile, celebrate, hero]) assert.ok(size >= C.LEVEL_MEDAL_FLAT_BELOW, `${size}`);
    assert.ok(C.LEVEL_MEDAL_STROKE > C.LEVEL_MEDAL_FACET_STROKE);
  });

  it("o degradê é uma escolha do dono (boolean)", () => {
    assert.equal(typeof C.LEVEL_MEDAL_GRADIENT, "boolean");
  });

  it("o brasão antigo saiu: só a medalha", () => {
    const left = ["LEVEL_SHIELD_PATH", "LEVEL_MARKS", "LEVEL_MARK_COLOR"].filter((name) => name in C);
    for (const tier of TIERS) if ("cssVar" in C.LEVEL_TIER[tier]) left.push(`LEVEL_TIER.${tier}.cssVar`);
    assert.deepEqual(left, []);
  });
});

describe("meses dos gráficos e do histórico", () => {
  it("monthAbbr e monthTitle", () => {
    assert.equal(C.MONTH_ABBR.length, 12);
    assert.equal(C.monthAbbr("2026-11"), "nov");
    assert.equal(C.monthAbbr("2026-11", true), "nov/26");
    assert.equal(C.monthAbbr("2026-01", true), "jan/26");
    assert.equal(C.monthAbbr("2026-13"), "2026-13");
    assert.equal(C.monthAbbr("x"), "x");
    assert.equal(C.monthTitle("2026-03"), "Março de 2026");
  });
});
