// Faturamento do técnico, de lib/constants.ts (a mesma cópia do app): a situação de cada mês, a linha do cartão, o
// texto do topo do mês e a chave PIX da linha "Recebe no PIX". Sem dependência nova: node:test com o type stripping do
// Node 22. Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EARNINGS_HISTORY_SINCE,
  EARNINGS_MONTH_STATE,
  earningsMonthLine,
  earningsSituation,
  maskPixKey,
  monthTitle,
  osCount,
  PIX_KEY_TYPE,
} from "../src/lib/constants.ts";

const STATES = ["empty", "in_progress", "no_invoice", "in_review", "rejected", "to_pay", "partial", "paid_no_invoice", "paid"];
/** O que a tela passa: o valor como veio e o dia fixo. */
const fmt = { money: (v) => `R$ ${v}`, day: () => "18/11" };
const PAID_AT = "2026-11-18T15:00:00Z";

const bucket = (count = 0, amount = 0) => ({ count, amount });

/** Um mês de GET /me/earnings/months, vazio a não ser pelo que o caso muda. */
function month(state, extra = {}) {
  return {
    month: "2026-11",
    state,
    count: 0,
    total: 0,
    to_pay: bucket(),
    expected: bucket(),
    paid: bucket(),
    due_without_invoice: bucket(),
    due_in_review: bucket(),
    due_checked: bucket(),
    paid_without_invoice: bucket(),
    last_paid_at: null,
    rejection: null,
    ...extra,
  };
}

const rejection = (reason) => ({ invoice_id: "nota-1", number: "1200", reason, rejected_at: PAID_AT });

describe("situações do mês", () => {
  it("as 9 situações têm selo e cor, e só a recusa é vermelha (a nota nunca trava o pagamento)", () => {
    assert.deepEqual(Object.keys(EARNINGS_MONTH_STATE), STATES);
    for (const state of STATES) {
      const { label, color } = EARNINGS_MONTH_STATE[state];
      assert.ok(label.trim().length > 0, state);
      assert.match(color, /^#[0-9A-F]{6}$/i, state);
    }
    assert.equal(new Set(STATES.map((state) => EARNINGS_MONTH_STATE[state].label)).size, STATES.length);
    const red = STATES.filter((state) => EARNINGS_MONTH_STATE[state].color === EARNINGS_MONTH_STATE.rejected.color);
    assert.deepEqual(red, ["rejected"]);
  });

  it("título do mês, contagem de OS e o início dos valores", () => {
    assert.equal(monthTitle("2026-11"), "Novembro de 2026");
    assert.equal(osCount(0), "nenhuma OS");
    assert.equal(osCount(1), "1 OS");
    assert.equal(osCount(3), "3 OS");
    assert.match(EARNINGS_HISTORY_SINCE, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("earningsMonthLine (linha do cartão do mês)", () => {
  const cases = [
    [month("empty"), null],
    [month("in_progress", { expected: bucket(2, 300) }), "2 OS em andamento"],
    [month("no_invoice", { due_without_invoice: bucket(1, 150) }), "1 OS sem nota · R$ 150"],
    [month("in_review", { due_in_review: bucket(3, 450) }), "3 OS com nota em conferência"],
    [month("rejected", { rejection: rejection("Valor diferente") }), "Nota nº 1200 recusada · ver motivo"],
    [month("rejected"), "Nota recusada · ver motivo"],
    [month("to_pay", { to_pay: bucket(2, 300) }), "R$ 300 a receber"],
    [
      month("partial", { paid: bucket(1, 100), to_pay: bucket(1, 150), expected: bucket(1, 200) }),
      "R$ 100 pago · R$ 150 a receber · R$ 200 previsto",
    ],
    [month("partial", { paid: bucket(1, 100), to_pay: bucket(1, 150) }), "R$ 100 pago · R$ 150 a receber"],
    [month("partial", { paid: bucket(1, 100), expected: bucket(2, 400) }), "R$ 100 pago · R$ 400 previsto"],
    [month("paid_no_invoice", { last_paid_at: PAID_AT }), "Pago em 18/11 · sem nota"],
    [month("paid_no_invoice"), "Pago · sem nota"],
    [month("paid", { last_paid_at: PAID_AT }), "Pago em 18/11"],
    [month("paid"), null],
  ];
  cases.forEach(([m, text], i) => {
    it(`${i + 1}. ${m.state} → ${JSON.stringify(text)}`, () => {
      assert.equal(earningsMonthLine(m, fmt), text);
    });
  });
});

describe("earningsSituation (o texto do topo do mês)", () => {
  const cases = [
    [month("empty"), null],
    [month("in_progress", { expected: bucket(1, 90) }), "Nenhuma OS concluída ainda. O valor fica previsto até a conclusão."],
    [
      month("no_invoice", { due_without_invoice: bucket(1, 150) }),
      "1 OS sem nota fiscal (R$ 150). A central paga com ou sem nota; se quiser, envie a nota abaixo.",
    ],
    [
      month("in_review", { due_in_review: bucket(2, 300) }),
      "A central está conferindo a nota de 2 OS. Nota errada? Apague e envie outra.",
    ],
    [
      month("rejected", { rejection: rejection("Valor diferente do da OS") }),
      "A central recusou a nota nº 1200. Motivo: Valor diferente do da OS. Apague a nota recusada e envie outra.",
    ],
    [
      month("rejected", { rejection: rejection("CNPJ errado.") }),
      "A central recusou a nota nº 1200. Motivo: CNPJ errado. Apague a nota recusada e envie outra.",
    ],
    [
      month("rejected", { rejection: rejection(null) }),
      "A central recusou a nota nº 1200. Apague a nota recusada e envie outra.",
    ],
    [
      month("rejected", { rejection: rejection("   ") }),
      "A central recusou a nota nº 1200. Apague a nota recusada e envie outra.",
    ],
    [month("rejected"), "A central recusou a nota. Apague a nota recusada e envie outra."],
    [month("to_pay", { to_pay: bucket(2, 300) }), "Nota conferida. Falta a central pagar R$ 300."],
    [
      month("partial", {
        paid: bucket(1, 100),
        to_pay: bucket(1, 150),
        expected: bucket(1, 200),
        due_without_invoice: bucket(1, 150),
      }),
      "R$ 100 pago, R$ 150 a receber, R$ 200 previsto. 1 OS sem nota.",
    ],
    [month("partial", { paid: bucket(1, 100), to_pay: bucket(1, 150) }), "R$ 100 pago, R$ 150 a receber."],
    [
      month("partial", { paid: bucket(2, 200), to_pay: bucket(1, 150), paid_without_invoice: bucket(2, 200) }),
      "R$ 200 pago, R$ 150 a receber. 2 OS sem nota.",
    ],
    [
      month("paid_no_invoice", { last_paid_at: PAID_AT }),
      "Tudo pago em 18/11. Se quiser, envie a nota fiscal destas OS.",
    ],
    [month("paid_no_invoice"), "Tudo pago. Se quiser, envie a nota fiscal destas OS."],
    [month("paid", { last_paid_at: PAID_AT }), "Tudo pago em 18/11."],
    [month("paid"), "Tudo pago."],
  ];
  cases.forEach(([m, text], i) => {
    it(`${i + 1}. ${m.state} → ${JSON.stringify(text)}`, () => {
      assert.equal(earningsSituation(m, fmt), text);
    });
  });

  it("o valor passa pelo formatador de quem mostra (o olho do app oculta)", () => {
    const hidden = { money: () => "R$ •••", day: fmt.day };
    assert.equal(earningsMonthLine(month("to_pay", { to_pay: bucket(1, 150) }), hidden), "R$ ••• a receber");
    assert.equal(
      earningsSituation(month("to_pay", { to_pay: bucket(1, 150) }), hidden),
      "Nota conferida. Falta a central pagar R$ •••.",
    );
  });
});

describe("Recebe no PIX (tipo e chave mascarada)", () => {
  const cases = [
    ["cpf", "12345678909", "CPF •••.456.789-••"],
    ["cnpj", "12345678000195", "CNPJ 12.345.678/••••-••"],
    ["email", "tecnico.alfa@exemplo.com", "E-mail t•••@exemplo.com"],
    ["phone", "+5511988887777", "Celular +55 (11) •••••-7777"],
    ["phone", "11988887777", "Celular +55 (11) •••••-7777"],
    ["random", "0f3c2e1d-7a6b-4c5d-9e8f-1a2b3c4da1b2", "Chave aleatória …a1b2"],
  ];
  for (const [type, key, text] of cases) {
    it(`${type} ${key} → "${text}"`, () => {
      assert.equal(`${PIX_KEY_TYPE[type]} ${maskPixKey(type, key)}`, text);
    });
  }
});
