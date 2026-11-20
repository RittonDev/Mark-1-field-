// Sonda das correções do Faturamento e da oferta: o mês sem valores com nota, o "Outro mês", a nota enviada noutra
// competência, o valor e o código que não são espremidos pelo selo e o foco do leitor de tela no voltar da oferta. As
// telas importam o React Native e não rodam no Node: a sonda lê o código e confere as regras que não podem voltar.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

/** O conteúdo de um estilo de uma linha do StyleSheet.create (`nome: { ... },`). */
function style(source, name) {
  const match = new RegExp(`^\\s*${name}: \\{([^\\n]*)\\},?$`, "m").exec(source);
  assert.ok(match, `estilo ${name} não encontrado`);
  return match[1];
}

describe("Faturamento: mês sem valores e Outro mês", () => {
  const view = read("components/billing/BillingView.tsx");

  it("o mês sem valores aparece quando tem nota da competência (a API antiga não manda invoices: vale 0)", () => {
    assert.match(view, /month\.state !== "empty" \|\| \(month\.invoices \?\? 0\) > 0/);
  });

  it("Outro mês aparece depois dos cartões e sob o vazio", () => {
    assert.equal(view.match(/<OtherMonth\b/g)?.length, 2);
  });

  it("o seletor e a competência da nota vão do mesmo primeiro mês (FIRST_MONTH de lib/earnings) até o atual", () => {
    assert.match(read("lib/earnings.ts"), /export const FIRST_MONTH = "2000-01";/);
    const picker = read("components/billing/OtherMonth.tsx");
    const invoice = read("app/nota-fiscal.tsx");
    for (const source of [picker, invoice]) assert.match(source, /import \{ FIRST_MONTH \} from "(\.\.\/)+lib\/earnings";/);
    assert.doesNotMatch(invoice, /const FIRST_MONTH/);
    assert.match(picker, /next < FIRST_MONTH \|\| next > current/);
  });

  it("nota enviada noutra competência leva ao mês dela, em vez de voltar", () => {
    assert.match(read("app/nota-fiscal.tsx"), /router\.replace\(\{ pathname: "\/faturamento\/\[mes\]", params: \{ mes: other \} \}\)/);
  });
});

describe("Faturamento: o valor não é espremido pelo selo", () => {
  it("cartão do mês: a linha quebra pelo tamanho natural do valor, sem regra de fontScale nem minimumFontScale", () => {
    const card = read("components/billing/BillingMonthCard.tsx");
    assert.match(style(card, "headMain"), /flexWrap: "wrap"/);
    assert.match(style(card, "amount"), /flexGrow: 1/);
    // `flex: 1` zera a base: o selo nunca desceria.
    assert.doesNotMatch(style(card, "amount"), /\bflex: /);
    assert.doesNotMatch(card, /useWindowDimensions|minimumFontScale=/);
  });

  it("totais: empilham com a fonte a partir de 1,25 (o 1,3 do Android chega como 1,2999…) ou abaixo de 340 dp", () => {
    const totals = read("components/billing/BillingTotals.tsx");
    assert.match(totals, /const stacked = fontScale >= 1\.25 \|\| width < 340;/);
    assert.doesNotMatch(totals, /minimumFontScale=/);
  });
});

describe("Oferta", () => {
  const offer = read("app/oferta/[id].tsx");

  it("o topo quebra a linha: o selo desce e o código da OS não encolhe", () => {
    assert.match(style(offer, "topRow"), /flexWrap: "wrap"/);
    assert.match(style(offer, "topRow"), /rowGap: \d+/);
    assert.doesNotMatch(style(offer, "code"), /flexShrink/);
  });

  it("leitor de tela ligado: o foco vai para o voltar pela API atual do RN 0.88 (sendAccessibilityEvent)", () => {
    assert.match(offer, /AccessibilityInfo\.isScreenReaderEnabled\(\)/);
    assert.match(offer, /AccessibilityInfo\.sendAccessibilityEvent\([^)]*, "focus"\)/);
    assert.doesNotMatch(offer, /setAccessibilityFocus/);
  });
});
