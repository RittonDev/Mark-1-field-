// Elo por pontos, Etapa 1 (Configurações › Elo): os rótulos e a ordem das regras em lib/constants.ts (a mesma cópia do
// app, sem números), a categoria pela quantidade e pelo saldo e a abertura (a tabela do pytest), as mensagens da tela e
// o formulário (lib/levelRules.ts) e a permissão "Elo: confirmar ocorrências" (lib/permissions.ts). Com a pasta backend
// ao lado, os limites, os rótulos e a permissão iguais aos do servidor; sem ela (contêiner só da web), essas pulam.
// Dados fictícios. Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as C from "../src/lib/constants.ts";
import {
  countBandRows,
  draftOf,
  formatPoints,
  knownInt,
  LEVEL_COUNT_TIERS,
  LEVEL_RULE_FIELDS,
  LEVEL_RULE_LIMITS,
  LEVEL_TIER_NAME,
  LEVEL_TIER_OF,
  levelRuleProblems,
  openingBalance,
  openingLine,
  pointsBandRows,
  previewBands,
  readInt,
  sameLevelValues,
  tierForBalance,
  tierForCount,
  valuesOf,
} from "../src/lib/levelRules.ts";

/** As sugestões do QA e os padrões: o que a migração grava (completion, on_time e atraso ficam em branco). */
const QA = Object.freeze({
  count_bands: { silver: 51, gold: 101, diamond: 151 },
  points_bands: { bronze: 100, silver: 901, gold: 1401, diamond: 1850 },
  opening_bonus: 100,
  completion_gain: null,
  on_time_gain: null,
  late: null,
  abandonment_loss: 80,
  rework_loss: 50,
  min_balance: null,
  arrival_tolerance: null,
  arrival_time: null,
  app_reasons: false,
});

/** O formulário do QA com `over` por cima (um nível: `late`, `count_bands` e `points_bands` entram inteiros). */
const draft = (over = {}) => ({ ...draftOf(QA), ...over });
const withCount = (over) => draft({ count_bands: { ...draftOf(QA).count_bands, ...over } });
const withPoints = (over) => draft({ points_bands: { ...draftOf(QA).points_bands, ...over } });

const KEYS = [
  "count_bands",
  "points_bands",
  "opening_bonus",
  "completion_gain",
  "on_time_gain",
  "late",
  "abandonment_loss",
  "rework_loss",
  "min_balance",
  "arrival_tolerance",
  "arrival_time",
  "confirmers",
  "app_reasons",
];

const LABELS = {
  count_bands: "Abertura por atendimentos",
  points_bands: "Faixas de pontos",
  opening_bonus: "Bônus de abertura",
  completion_gain: "Atendimento concluído",
  on_time_gain: "Chegada dentro do SLA",
  late: "Chegada fora do SLA",
  abandonment_loss: "Abandono confirmado",
  rework_loss: "Retorno com falha confirmada",
  min_balance: "Saldo mínimo",
  arrival_tolerance: "Tolerância do SLA de chegada",
  arrival_time: "Hora da chegada",
  confirmers: "Quem confirma abandono e retorno",
  app_reasons: "Motivos no app",
};

const ENTRY_KINDS = {
  opening: "Abertura",
  completion: "Atendimento concluído",
  on_time: "Chegada dentro do SLA",
  late: "Chegada fora do SLA",
  abandonment: "Abandono confirmado",
  rework_failure: "Retorno com falha confirmada",
  adjustment: "Ajuste excepcional",
  reversal: "Estorno",
  recategorization: "Recategorização",
};

const CONFIRM_ITEM = {
  key: "base.level_confirm",
  label: "Elo: confirmar ocorrências",
  href: "/pendencias-elo",
  levels: ["none", "edit"],
  hint: "Confirmar ou dispensar abandono e retorno",
};

describe("lib/constants.ts: as regras do elo (o app recebe este arquivo: nada de números)", () => {
  it("LEVEL_RULE_ORDER: as 13 regras na ordem da tela", () => {
    assert.deepEqual(C.LEVEL_RULE_ORDER, KEYS);
  });

  it("LEVEL_RULE_LABEL: os rótulos exatos, na mesma ordem e sem repetir", () => {
    assert.deepEqual(C.LEVEL_RULE_LABEL, LABELS);
    assert.deepEqual(Object.keys(C.LEVEL_RULE_LABEL), KEYS);
    assert.equal(new Set(Object.values(C.LEVEL_RULE_LABEL)).size, KEYS.length);
  });

  it("estados, atraso, saldo mínimo, hora da chegada e os tipos de lançamento", () => {
    assert.deepEqual(C.LEVEL_RULE_STATE, { pending: "Falta definir", to_validate: "A validar", approved: "Aprovado" });
    assert.deepEqual(C.LEVEL_LATE_MODE, { deduct: "Desconta pontos", no_gain: "Só deixa de ganhar" });
    assert.deepEqual(C.LEVEL_MIN_BALANCE, { negative: "Pode ficar negativo", zero: "Para em zero" });
    assert.deepEqual(C.LEVEL_ARRIVAL_TIME, { server: "Hora do servidor", device: "Hora do aparelho" });
    assert.deepEqual(C.LEVEL_ENTRY_KIND, ENTRY_KINDS);
  });

  it("nenhum texto com dígito nem \"Ex.:\"", () => {
    const texts = [
      ...C.LEVEL_RULE_ORDER,
      ...Object.values(C.LEVEL_RULE_LABEL),
      ...Object.values(C.LEVEL_RULE_STATE),
      ...Object.values(C.LEVEL_LATE_MODE),
      ...Object.values(C.LEVEL_MIN_BALANCE),
      ...Object.values(C.LEVEL_ARRIVAL_TIME),
      ...Object.values(C.LEVEL_ENTRY_KIND),
    ];
    for (const text of texts) assert.ok(!/\d|Ex\.:/.test(text), text);
  });

  it("os nomes das categorias de lib/levelRules.ts são os de LEVEL_TIER", () => {
    for (const tier of C.LEVEL_TIER_ORDER) {
      assert.equal(LEVEL_TIER_NAME[tier], C.LEVEL_TIER[tier].label, tier);
      assert.ok(LEVEL_TIER_OF[tier].endsWith(` ${C.LEVEL_TIER[tier].label}`), tier);
    }
    assert.deepEqual(LEVEL_COUNT_TIERS, C.LEVEL_TIER_ORDER.slice(1));
  });
});

describe("categoria e abertura (a tabela do pytest, com as sugestões do QA)", () => {
  const count = [
    [0, "bronze"],
    [50, "bronze"],
    [51, "silver"],
    [100, "silver"],
    [101, "gold"],
    [150, "gold"],
    [151, "diamond"],
    [12000, "diamond"],
  ];
  for (const [n, tier] of count) {
    it(`${n} atendimentos: ${tier}`, () => assert.equal(tierForCount(n, QA.count_bands), tier));
  }

  const balance = [
    [-50, "bronze"],
    [0, "bronze"],
    [99, "bronze"],
    [100, "bronze"],
    [900, "bronze"],
    [901, "silver"],
    [1400, "silver"],
    [1401, "gold"],
    [1849, "gold"],
    [1850, "diamond"],
    [10 ** 9, "diamond"],
  ];
  for (const [n, tier] of balance) {
    it(`saldo ${n}: ${tier} (abaixo da Prata é Bronze, mesmo negativo; Diamante sem teto)`, () => {
      assert.equal(tierForBalance(n, QA.points_bands), tier);
    });
  }

  it("aberturas 200, 1.001, 1.501 e 1.950, cada uma dentro da própria categoria", () => {
    const opening = Object.fromEntries(C.LEVEL_TIER_ORDER.map((t) => [t, openingBalance(t, QA.points_bands, QA.opening_bonus)]));
    assert.deepEqual(opening, { bronze: 200, silver: 1001, gold: 1501, diamond: 1950 });
    for (const tier of C.LEVEL_TIER_ORDER) assert.equal(tierForBalance(opening[tier], QA.points_bands), tier);
    // 73 atendimentos: Prata, abre com 1.001.
    assert.equal(openingBalance(tierForCount(73, QA.count_bands), QA.points_bands, QA.opening_bonus), 1001);
  });

  it("a linha da abertura e as tabelas De | Até", () => {
    assert.equal(openingLine(draftOf(QA)), "Bronze 200 · Prata 1.001 · Ouro 1.501 · Diamante 1.950");
    assert.equal(openingLine(withPoints({ gold: "" })), null);
    assert.equal(openingLine(draft({ opening_bonus: "abc" })), null);
    assert.deepEqual(countBandRows(draftOf(QA).count_bands), [
      { tier: "bronze", from: 0, to: 50 },
      { tier: "silver", from: 51, to: 100 },
      { tier: "gold", from: 101, to: 150 },
      { tier: "diamond", from: 151, to: null },
    ]);
    assert.deepEqual(pointsBandRows(draftOf(QA).points_bands), [
      { tier: "bronze", from: 100, to: 900 },
      { tier: "silver", from: 901, to: 1400 },
      { tier: "gold", from: 1401, to: 1849 },
      { tier: "diamond", from: 1850, to: null },
    ]);
    // Sem o número seguinte, ou com ele antes do início, o fim fica sem conta.
    const broken = countBandRows({ silver: "51", gold: "x", diamond: "40" });
    assert.deepEqual(broken.map((r) => r.to), [50, null, null, null]);
    assert.deepEqual(broken.map((r) => r.from), [0, 51, null, 40]);
  });
});

describe("números digitados", () => {
  it("readInt: inteiro, ponto de milhar e negativo; vazio null; o resto NaN", () => {
    assert.equal(readInt("1401"), 1401);
    assert.equal(readInt(" 1.401 "), 1401);
    assert.equal(readInt("1.000.000"), 1000000);
    assert.equal(readInt("-50"), -50);
    assert.equal(readInt("051"), 51);
    assert.equal(readInt(""), null);
    assert.equal(readInt("   "), null);
    for (const bad of ["1,5", "1.40", "10.0000", "abc", "1e3", "+5", "1 401", "1.401,00"]) assert.ok(Number.isNaN(readInt(bad)), bad);
    assert.equal(knownInt("abc"), null);
    assert.equal(knownInt(""), null);
    assert.equal(knownInt("1.850"), 1850);
  });

  it("formatPoints: ponto de milhar; negativo com o sinal de menos", () => {
    assert.equal(formatPoints(0), "0");
    assert.equal(formatPoints(80), "80");
    assert.equal(formatPoints(1001), "1.001");
    assert.equal(formatPoints(100000), "100.000");
    assert.equal(formatPoints(1000000), "1.000.000");
    assert.equal(formatPoints(-1950), "−1.950");
  });
});

describe("levelRuleProblems: as mensagens da tela (as do servidor, com ponto)", () => {
  it("as sugestões do QA passam; os +10/+5/−10 da conversa não entram", () => {
    assert.deepEqual(levelRuleProblems(draftOf(QA)), {});
    const values = valuesOf(draftOf(QA));
    assert.deepEqual(values, QA);
    assert.equal(values.completion_gain, null);
    assert.equal(values.on_time_gain, null);
    assert.equal(values.late, null);
  });

  it("contagem: de 1 a 100.000, inteira e obrigatória", () => {
    const message = "Use um número inteiro de 1 a 100.000.";
    for (const bad of ["", "0", "100001", "1,5", "abc", "-3"]) {
      assert.deepEqual(levelRuleProblems(withCount({ silver: bad })), { "count_bands.silver": message }, bad);
    }
    assert.deepEqual(levelRuleProblems(withCount({ silver: "1", gold: "2", diamond: "100.000" })), {});
  });

  it("contagem e pontos crescentes: o erro fica no campo de cima", () => {
    assert.deepEqual(levelRuleProblems(withCount({ gold: "51" })), {
      "count_bands.gold": "O início do Ouro tem de ser maior que o da Prata.",
    });
    assert.deepEqual(levelRuleProblems(withCount({ diamond: "101" })), {
      "count_bands.diamond": "O início do Diamante tem de ser maior que o do Ouro.",
    });
    assert.deepEqual(levelRuleProblems(withPoints({ silver: "100" })), {
      "points_bands.silver": "O início da Prata tem de ser maior que o do Bronze.",
    });
    assert.deepEqual(levelRuleProblems(withPoints({ diamond: "1.401" })), {
      "points_bands.diamond": "O início do Diamante tem de ser maior que o do Ouro.",
    });
    assert.deepEqual(levelRuleProblems(withPoints({ bronze: "-1" })), {
      "points_bands.bronze": "Use um número inteiro de 0 a 1.000.000.",
    });
  });

  it("bônus: de 0 a 1.000.000, e a abertura dentro da faixa (a primeira que passa)", () => {
    assert.deepEqual(levelRuleProblems(draft({ opening_bonus: "500" })), {
      opening_bonus: "Com este bônus, a abertura da Prata (1.401) passa do fim da faixa (1.400).",
    });
    assert.deepEqual(levelRuleProblems(draft({ opening_bonus: "900" })), {
      opening_bonus: "Com este bônus, a abertura do Bronze (1.000) passa do fim da faixa (900).",
    });
    assert.deepEqual(levelRuleProblems(draft({ opening_bonus: "449" })), {
      opening_bonus: "Com este bônus, a abertura do Ouro (1.850) passa do fim da faixa (1.849).",
    });
    assert.deepEqual(levelRuleProblems(draft({ opening_bonus: "448" })), {});
    assert.deepEqual(levelRuleProblems(draft({ opening_bonus: "0" })), {});
    assert.deepEqual(levelRuleProblems(draft({ opening_bonus: "" })), { opening_bonus: "Use um número inteiro de 0 a 1.000.000." });
    // Faixa com erro: a abertura espera a faixa ser corrigida.
    assert.deepEqual(levelRuleProblems(withPoints({ gold: "x" })), {
      "points_bands.gold": "Use um número inteiro de 0 a 1.000.000.",
    });
  });

  it("ganhos: em branco ou de 0 a 1.000", () => {
    for (const key of ["completion_gain", "on_time_gain"]) {
      assert.deepEqual(levelRuleProblems(draft({ [key]: "" })), {});
      assert.deepEqual(levelRuleProblems(draft({ [key]: "0" })), {});
      assert.deepEqual(levelRuleProblems(draft({ [key]: "1.000" })), {});
      for (const bad of ["1001", "-1", "2,5"]) {
        assert.deepEqual(levelRuleProblems(draft({ [key]: bad })), { [key]: "Use um número inteiro de 0 a 1.000." }, `${key} ${bad}`);
      }
    }
  });

  it("atraso: desconta de 1 a 1.000 ou só deixa de ganhar", () => {
    assert.deepEqual(levelRuleProblems(draft({ late: { mode: "deduct", points: "" } })), {
      "late.points": "Informe quantos pontos o atraso desconta.",
    });
    for (const bad of ["0", "1001", "x"]) {
      assert.deepEqual(levelRuleProblems(draft({ late: { mode: "deduct", points: bad } })), {
        "late.points": "Use um número inteiro de 1 a 1.000.",
      });
    }
    assert.deepEqual(levelRuleProblems(draft({ late: { mode: "talvez", points: "" } })), {
      "late.mode": "Escolha se o atraso desconta pontos ou só deixa de ganhar.",
    });
    // "Só deixa de ganhar" e "Falta definir" ignoram os pontos que sobraram no campo escondido.
    assert.deepEqual(levelRuleProblems(draft({ late: { mode: "no_gain", points: "x" } })), {});
    assert.deepEqual(valuesOf(draft({ late: { mode: "no_gain", points: "10" } })).late, { mode: "no_gain", points: null });
    assert.equal(valuesOf(draft({ late: { mode: "", points: "10" } })).late, null);
    assert.deepEqual(valuesOf(draft({ late: { mode: "deduct", points: "10" } })).late, { mode: "deduct", points: 10 });
  });

  it("perdas: abandono de 80 e retorno de 50 até 10.000", () => {
    assert.deepEqual(levelRuleProblems(draft({ abandonment_loss: "79" })), { abandonment_loss: "No mínimo 80 pontos." });
    assert.deepEqual(levelRuleProblems(draft({ rework_loss: "49" })), { rework_loss: "No mínimo 50 pontos." });
    assert.deepEqual(levelRuleProblems(draft({ abandonment_loss: "-5" })), { abandonment_loss: "No mínimo 80 pontos." });
    for (const bad of ["", "10001", "abc", "80,5"]) {
      assert.deepEqual(levelRuleProblems(draft({ abandonment_loss: bad })), { abandonment_loss: "Use um número inteiro de 80 a 10.000." }, bad);
      assert.deepEqual(levelRuleProblems(draft({ rework_loss: bad })), { rework_loss: "Use um número inteiro de 50 a 10.000." }, bad);
    }
    assert.deepEqual(levelRuleProblems(draft({ abandonment_loss: "10.000", rework_loss: "50" })), {});
  });

  it("tolerância: em branco ou minutos inteiros de 0 a 240", () => {
    for (const ok of ["", "0", "15", "240"]) assert.deepEqual(levelRuleProblems(draft({ arrival_tolerance: ok })), {}, ok);
    for (const bad of ["241", "-1", "1,5", "x"]) {
      assert.deepEqual(levelRuleProblems(draft({ arrival_tolerance: bad })), { arrival_tolerance: "Use minutos inteiros de 0 a 240." }, bad);
    }
  });

  it("toda mensagem termina com ponto e cada campo com erro está em LEVEL_RULE_FIELDS", () => {
    const all = {
      ...levelRuleProblems(withCount({ silver: "", gold: "0", diamond: "x" })),
      ...levelRuleProblems(withPoints({ bronze: "", silver: "", gold: "", diamond: "" })),
      ...levelRuleProblems(
        draft({
          opening_bonus: "x",
          completion_gain: "x",
          on_time_gain: "x",
          late: { mode: "deduct", points: "x" },
          abandonment_loss: "1",
          rework_loss: "",
          arrival_tolerance: "999",
        }),
      ),
      ...levelRuleProblems(draft({ late: { mode: "talvez", points: "" } })),
    };
    assert.equal(Object.keys(all).length, LEVEL_RULE_FIELDS.length);
    for (const [field, message] of Object.entries(all)) {
      assert.ok(LEVEL_RULE_FIELDS.includes(field), field);
      assert.ok(message.endsWith("."), message);
      assert.ok(!/Ex\.:/.test(message), message);
    }
  });
});

describe("formulário", () => {
  it("draftOf e valuesOf vão e voltam; listas em branco viram null", () => {
    const full = {
      ...QA,
      completion_gain: 10,
      on_time_gain: 0,
      late: { mode: "deduct", points: 5 },
      min_balance: "zero",
      arrival_tolerance: 15,
      arrival_time: "device",
      app_reasons: true,
    };
    assert.deepEqual(valuesOf(draftOf(full)), full);
    assert.deepEqual(draftOf(full).late, { mode: "deduct", points: "5" });
    assert.deepEqual(draftOf({ ...QA, late: { mode: "no_gain", points: null } }).late, { mode: "no_gain", points: "" });
    const blank = valuesOf(draft({ min_balance: "", arrival_time: "", arrival_tolerance: " " }));
    assert.equal(blank.min_balance, null);
    assert.equal(blank.arrival_time, null);
    assert.equal(blank.arrival_tolerance, null);
    assert.equal(valuesOf(draft({ rework_loss: "" })), null);
  });

  it("sameLevelValues: o mesmo valor escrito de outro jeito não é alteração; com erro, é", () => {
    assert.ok(sameLevelValues(valuesOf(withPoints({ gold: "1.401" })), QA));
    assert.ok(sameLevelValues(valuesOf(withCount({ silver: "051" })), QA));
    assert.ok(!sameLevelValues(valuesOf(draft({ completion_gain: "0" })), QA));
    assert.ok(!sameLevelValues(valuesOf(draft({ app_reasons: true })), QA));
    assert.ok(!sameLevelValues(null, QA));
    // A ordem das chaves vinda da API não conta.
    const shuffled = Object.fromEntries(Object.entries(QA).reverse());
    assert.ok(sameLevelValues(shuffled, QA));
  });

  it("previewBands: as faixas da tela, ou null com erro nas faixas ou no bônus", () => {
    assert.deepEqual(previewBands(draftOf(QA)), { count: QA.count_bands, points: QA.points_bands, bonus: 100 });
    assert.equal(previewBands(withCount({ gold: "51" })), null);
    assert.equal(previewBands(withPoints({ silver: "" })), null);
    assert.equal(previewBands(draft({ opening_bonus: "500" })), null);
    // Erro em outra regra não estraga a prévia.
    assert.notEqual(previewBands(draft({ rework_loss: "1" })), null);
  });
});

/** O inteiro de uma constante de um módulo Python: `NOME = 80`, `NOME: int = 80`, `OUTRO, NOME = 10, 500`, `NOME = 100_000`. */
function pythonInt(text, name) {
  for (const m of text.matchAll(/^([A-Z_][A-Z0-9_]*(?:\s*,\s*[A-Z_][A-Z0-9_]*)*)\s*(?::[^=\n]*)?=\s*([^\n#]+)/gm)) {
    const names = m[1].split(",").map((part) => part.trim());
    const values = m[2].split(",").map((part) => part.trim());
    const i = names.indexOf(name);
    if (i >= 0 && names.length === values.length && /^\d[\d_]*$/.test(values[i])) return Number(values[i].replace(/_/g, ""));
  }
  return undefined;
}

/** O bloco de uma atribuição Python de `name` (tupla, lista ou dict), do abre ao fecha correspondente (sem contar o que está entre aspas). */
function pythonBlock(text, name) {
  const start = new RegExp(`^${name}\\b[^=\\n]*=\\s*([({\\[])`, "m").exec(text);
  if (!start) return undefined;
  const open = start.index + start[0].length - 1;
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("({[".includes(ch)) depth += 1;
    else if (")}]".includes(ch)) depth -= 1;
    if (depth === 0) return text.slice(open + 1, i);
  }
  return undefined;
}

/** As strings de uma tupla ou lista Python, na ordem. */
const pythonStrings = (block) => [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]);

/**
 * Os pares de um dict Python de rótulos: `"chave": "Rótulo"` ou `Enum.MEMBRO: "Rótulo"` (o membro vira o valor pela classe
 * do enum em `enums`, ou o nome em minúsculas).
 */
function pythonLabels(block, enums = "") {
  const out = {};
  for (const m of block.matchAll(/(?:"([^"]+)"|(\w+)\.(\w+))\s*:\s*"([^"]*)"/g)) {
    let key = m[1];
    if (!key) {
      const klass = new RegExp(`^class ${m[2]}\\b[^\\n]*:\\n((?:[ \\t]+[^\\n]*\\n|\\n)*)`, "m").exec(enums);
      const member = klass ? new RegExp(`^\\s+${m[3]}\\s*=\\s*"([^"]+)"`, "m").exec(klass[1]) : null;
      key = member ? member[1] : m[3].toLowerCase();
    }
    out[key] = m[4];
  }
  return out;
}

/** O item `key` de core/permissions.py: Item("chave", "Rótulo", "/rota", NIVEIS, "Dica"), com os níveis resolvidos. */
function pythonItem(text, key) {
  const item = new RegExp(`Item\\(\\s*"${key.replace(".", "\\.")}"\\s*,\\s*"([^"]*)"\\s*,\\s*"([^"]*)"\\s*,\\s*(\\w+)\\s*(?:,\\s*"([^"]*)"\\s*)?,?\\s*\\)`).exec(text);
  if (!item) return undefined;
  const levels = pythonBlock(text, item[3]);
  return { key, label: item[1], href: item[2], levels: levels === undefined ? undefined : pythonStrings(levels), hint: item[4] };
}

describe("leitura do backend (as funções da sonda)", () => {
  it("pythonInt, pythonBlock, pythonLabels e pythonItem", () => {
    const source = 'COUNT_MAX = 100000\nPOINTS_MAX: int = 1_000_000\nREASON_MIN, REASON_MAX = 10, 500\nX = f"{COUNT_MAX}"\n';
    assert.equal(pythonInt(source, "COUNT_MAX"), 100000);
    assert.equal(pythonInt(source, "POINTS_MAX"), 1000000);
    assert.equal(pythonInt(source, "REASON_MAX"), 500);
    assert.equal(pythonInt(source, "X"), undefined);

    const schema = 'RULE_KEYS: tuple[str, ...] = (\n    "count_bands",\n    "points_bands",\n)\nRULE_LABELS: dict[str, str] = {\n    "count_bands": "Abertura por atendimentos",\n}\n';
    assert.deepEqual(pythonStrings(pythonBlock(schema, "RULE_KEYS")), ["count_bands", "points_bands"]);
    assert.deepEqual(pythonStrings(pythonBlock('PAIRS = ("a)", "b")\n', "PAIRS")), ["a)", "b"]);
    assert.deepEqual(pythonLabels(pythonBlock(schema, "RULE_LABELS")), { count_bands: "Abertura por atendimentos" });

    const enums = 'class LevelEntryKind(StrEnum):\n    """Tipo."""\n\n    OPENING = "opening"\n    ON_TIME = "on_time"\n\n\nclass Outro(StrEnum):\n    OPENING = "x"\n';
    const labels = 'LEVEL_ENTRY_KIND_LABELS = {\n    LevelEntryKind.OPENING: "Abertura",\n    LevelEntryKind.ON_TIME: "Chegada dentro do SLA",\n}\n';
    assert.deepEqual(pythonLabels(pythonBlock(labels, "LEVEL_ENTRY_KIND_LABELS"), enums), {
      opening: "Abertura",
      on_time: "Chegada dentro do SLA",
    });

    const perms = 'CONFIRM: tuple[Level, ...] = ("none", "edit")\nITEMS = (\n    Item(\n        "base.level_confirm",\n        "Elo: confirmar ocorrências",\n        "/pendencias-elo",\n        CONFIRM,\n        "Confirmar ou dispensar abandono e retorno",\n    ),\n)\n';
    assert.deepEqual(pythonItem(perms, "base.level_confirm"), CONFIRM_ITEM);
    assert.equal(pythonItem(perms, "base.technicians"), undefined);
  });
});

describe("lib/permissions.ts: \"Elo: confirmar ocorrências\"", () => {
  const source = readFileSync(new URL("../src/lib/permissions.ts", import.meta.url), "utf8");

  /** O catalogItem(...) da chave, com os níveis resolvidos pela constante. */
  function tsItem(key) {
    const item = new RegExp(`catalogItem\\(\\s*"${key.replace(".", "\\.")}"\\s*,\\s*"([^"]*)"\\s*,\\s*"([^"]*)"\\s*,\\s*(\\w+)\\s*(?:,\\s*"([^"]*)"\\s*)?\\)`).exec(source);
    if (!item) return undefined;
    const levels = new RegExp(`const ${item[3]}: AccessLevel\\[\\] = \\[([^\\]]*)\\]`).exec(source);
    return { key, label: item[1], href: item[2], levels: levels ? pythonStrings(levels[1]) : undefined, hint: item[4] };
  }

  it("o item, os níveis (Sem acesso e Editar) e o lugar no catálogo (depois de Técnicos)", () => {
    assert.deepEqual(tsItem("base.level_confirm"), CONFIRM_ITEM);
    const order = [...source.matchAll(/catalogItem\(\s*"([\w.]+)"/g)].map((m) => m[1]);
    assert.equal(order[order.indexOf("base.technicians") + 1], "base.level_confirm");
  });

  it("padrão: o analista sem; supervisor e administrador com Editar (o maior nível)", () => {
    assert.match(source, /items\["base\.level_confirm"\] = "none";/);
  });

  const backend = new URL("../../backend/app/core/permissions.py", import.meta.url);
  it("igual a backend/app/core/permissions.py", { skip: !existsSync(backend) && "pasta backend ausente" }, () => {
    const text = readFileSync(backend, "utf8");
    assert.deepEqual(pythonItem(text, "base.level_confirm"), CONFIRM_ITEM);
    assert.match(text, /"base\.level_confirm": "none"/);
  });
});

describe("iguais ao servidor (com a pasta backend ao lado)", () => {
  const services = new URL("../../backend/app/services/level_rules.py", import.meta.url);
  it("LEVEL_RULE_LIMITS = services/level_rules.py", { skip: !existsSync(services) && "backend/app/services/level_rules.py ausente" }, () => {
    const text = readFileSync(services, "utf8");
    assert.deepEqual(
      {
        countMax: pythonInt(text, "COUNT_MAX"),
        pointsMax: pythonInt(text, "POINTS_MAX"),
        gainMax: pythonInt(text, "GAIN_MAX"),
        lossMax: pythonInt(text, "LOSS_MAX"),
        abandonmentMin: pythonInt(text, "ABANDONMENT_MIN"),
        reworkMin: pythonInt(text, "REWORK_MIN"),
        toleranceMax: pythonInt(text, "TOLERANCE_MAX"),
      },
      LEVEL_RULE_LIMITS,
    );
  });

  const schemas = new URL("../../backend/app/schemas/level_rules.py", import.meta.url);
  it("RULE_KEYS e RULE_LABELS = LEVEL_RULE_ORDER e LEVEL_RULE_LABEL", { skip: !existsSync(schemas) && "backend/app/schemas/level_rules.py ausente" }, () => {
    const text = readFileSync(schemas, "utf8");
    const keys = pythonBlock(text, "RULE_KEYS");
    const labels = pythonBlock(text, "RULE_LABELS");
    assert.ok(keys && labels, "RULE_KEYS ou RULE_LABELS não encontrado em backend/app/schemas/level_rules.py");
    assert.deepEqual(pythonStrings(keys), C.LEVEL_RULE_ORDER);
    assert.deepEqual(pythonLabels(labels), C.LEVEL_RULE_LABEL);
  });

  const labelsPy = new URL("../../backend/app/core/labels.py", import.meta.url);
  const enumsPy = new URL("../../backend/app/core/enums.py", import.meta.url);
  it("LEVEL_ENTRY_KIND_LABELS = LEVEL_ENTRY_KIND", { skip: !existsSync(labelsPy) && "backend/app/core/labels.py ausente" }, () => {
    const block = pythonBlock(readFileSync(labelsPy, "utf8"), "LEVEL_ENTRY_KIND_LABELS");
    assert.ok(block, "LEVEL_ENTRY_KIND_LABELS não encontrado em backend/app/core/labels.py");
    const enums = existsSync(enumsPy) ? readFileSync(enumsPy, "utf8") : "";
    assert.deepEqual(pythonLabels(block, enums), C.LEVEL_ENTRY_KIND);
  });
});
