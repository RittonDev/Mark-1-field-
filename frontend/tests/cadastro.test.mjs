// Cadastro V2 (Entrega 1) em lib/constants.ts (a mesma cópia do app): os casos iguais aos do pytest (placa, idade,
// períodos de indisponibilidade, formas de recebimento mascaradas, e-mail que recebe, RG), o CEP sobre o formulário, os
// grupos de seções da central e do app, os rótulos do histórico e o aviso de privacidade. Dados fictícios.
// Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as C from "../src/lib/constants.ts";

const TODAY = "2026-11-25";
const unique = (list) => new Set(list).size === list.length;

const PIX = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "pix",
  preferred: true,
  holder_name: "Tecnico Alfa",
  holder_document: "12345678909",
  created_at: "2026-11-20T12:00:00Z",
  changed_at: "2026-11-20T12:00:00Z",
  pix_key_type: "cpf",
  pix_key: "12345678909",
};
const BANK = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "bank",
  preferred: false,
  holder_name: "Tecnico Alfa",
  holder_document: "12345678909",
  created_at: "2026-11-21T12:00:00Z",
  changed_at: "2026-11-21T12:00:00Z",
  bank_code: "999",
  bank_name: "Banco Exemplo",
  branch: "0001",
  account_number: "12345678",
  account_digit: "9",
  account_type: "checking",
};

/** CEP de logradouro (com acento, para a comparação sem acento) e CEP geral da cidade. */
const SE = { cep: "01001-000", street: "Praça da Sé", district: "Sé", city: "São Paulo", state: "SP" };
const GENERAL = { cep: "99999-000", street: null, district: null, city: "Cidade Exemplo", state: "SP" };
const EMPTY = { street: "", district: "", city: "", state: "" };
const NONE = new Set();

describe("placa (os casos do pytest)", () => {
  it("antiga: normaliza, valida e mostra com hífen", () => {
    assert.equal(C.normalizePlate("abc-1234"), "ABC1234");
    assert.equal(C.formatPlate("abc-1234"), "ABC-1234");
    assert.equal(C.formatPlate("ABC1234"), "ABC-1234");
    assert.equal(C.isValidPlate("abc-1234"), true);
  });

  it("Mercosul: válida e mostrada como está", () => {
    assert.equal(C.isValidPlate("ABC1D23"), true);
    assert.equal(C.formatPlate("ABC1D23"), "ABC1D23");
    assert.equal(C.normalizePlate("abc 1d23"), "ABC1D23");
  });

  it("fora dos dois formatos: inválida", () => {
    assert.equal(C.isValidPlate("AB12345"), false);
    assert.equal(C.isValidPlate("ABCD123"), false);
    assert.equal(C.isValidPlate(""), false);
    assert.equal(C.normalizePlate("ABC1D23X9"), "ABC1D23");
  });
});

describe("idade (hoje 2026-11-25, os casos do pytest)", () => {
  it("BIRTH_AGE é de 18 a 90 anos", () => {
    assert.deepEqual(C.BIRTH_AGE, { min: 18, max: 90 });
  });

  it("idade completa no dia", () => {
    assert.equal(C.ageAt("2008-11-25", TODAY), 18);
    assert.equal(C.ageAt("2008-11-26", TODAY), 17);
    assert.ok(C.ageAt("2008-11-26", TODAY) < C.BIRTH_AGE.min);
  });

  it("90 anos ainda vale; 91 não", () => {
    assert.equal(C.ageAt("1936-11-25", TODAY), 90);
    assert.ok(C.ageAt("1936-11-25", TODAY) <= C.BIRTH_AGE.max);
    assert.equal(C.ageAt("1935-11-24", TODAY), 91);
    assert.ok(C.ageAt("1935-11-24", TODAY) > C.BIRTH_AGE.max);
  });

  it("data que não existe ou fora do formato: null", () => {
    assert.equal(C.ageAt("2026-02-30", TODAY), null);
    assert.equal(C.ageAt("25/11/1990", TODAY), null);
    assert.equal(C.ageAt("", TODAY), null);
    assert.equal(C.ageAt("1990-11-25", ""), null);
  });

  it("nascido em 29 de fevereiro faz aniversário em 1º de março nos anos comuns", () => {
    assert.equal(C.ageAt("2008-02-29", "2026-02-28"), 17);
    assert.equal(C.ageAt("2008-02-29", "2026-03-01"), 18);
  });
});

describe("indisponibilidade (os casos do pytest)", () => {
  it("periodText: período e um dia só", () => {
    assert.equal(C.periodText({ start: "2026-12-20", end: "2027-01-05" }), "20/12/2026 a 05/01/2027");
    assert.equal(C.periodText({ start: "2026-12-20", end: "2026-12-20" }), "20/12/2026");
  });

  it("periodShort com hoje 2026-11-25", () => {
    const cases = [
      ["2026-11-20", "2026-11-30", "até 30/11"],
      ["2026-12-10", "2026-12-20", "de 10/12 a 20/12"],
      ["2026-12-10", "2026-12-10", "em 10/12"],
      ["2026-12-20", "2027-01-05", "de 20/12 a 05/01/2027"],
      ["2026-11-25", "2026-11-25", "até 25/11"],
    ];
    for (const [start, end, text] of cases) assert.equal(C.periodShort({ start, end }, TODAY), text, `${start} a ${end}`);
  });

  it("unavailableOn pega o período com os dois dias inclusive", () => {
    const periods = [
      { id: "00000000-0000-4000-8000-0000000000a1", start: "2026-11-20", end: "2026-11-30" },
      { id: "00000000-0000-4000-8000-0000000000a2", start: "2026-12-20", end: "2027-01-05" },
    ];
    assert.equal(C.unavailableOn(periods, "2026-11-20"), periods[0]);
    assert.equal(C.unavailableOn(periods, "2026-11-30"), periods[0]);
    assert.equal(C.unavailableOn(periods, "2027-01-05"), periods[1]);
    assert.equal(C.unavailableOn(periods, "2026-11-19"), null);
    assert.equal(C.unavailableOn(periods, "2026-12-01"), null);
    assert.equal(C.unavailableOn([], TODAY), null);
    assert.equal(C.unavailableOn(null, TODAY), null);
    assert.equal(C.unavailableOn(undefined, TODAY), null);
  });

  it("UNAVAILABILITY_LIMITS igual ao servidor", () => {
    assert.deepEqual(C.UNAVAILABILITY_LIMITS, { periods: 10, horizonDays: 365 });
  });
});

describe("formas de recebimento", () => {
  it("payoutMethodText mascara como o servidor (describe com •)", () => {
    assert.equal(C.payoutMethodText(PIX), "PIX CPF •••.456.789-••");
    assert.equal(C.payoutMethodText(BANK), "Banco Exemplo ••••5678-9");
    assert.equal(C.payoutMethodText({ ...BANK, account_number: "234", account_digit: "4" }), "Banco Exemplo ••34-4");
  });

  it("maskAccount: 4 últimos; com até 4 números, os 2 últimos", () => {
    assert.equal(C.maskAccount("12345678", "9"), "••••5678-9");
    assert.equal(C.maskAccount("234", "4"), "••34-4");
    assert.equal(C.maskAccount("1234", "X"), "••34-X");
    assert.equal(C.maskAccount("12345", null), "••••2345");
  });

  it("bankAccountText: a conta inteira, para quem paga", () => {
    assert.equal(
      C.bankAccountText({ ...BANK, account_number: "12345", account_digit: "6" }),
      "Banco Exemplo (999) · Ag. 0001 · Conta 12345-6 · Conta corrente",
    );
    assert.equal(
      C.bankAccountText({ ...BANK, account_type: "savings" }),
      "Banco Exemplo (999) · Ag. 0001 · Conta 12345678-9 · Conta poupança",
    );
  });

  it("tipos, rótulos e limites", () => {
    assert.deepEqual(C.PAYOUT_KIND, { pix: "Chave PIX", bank: "Conta bancária" });
    assert.deepEqual(C.BANK_ACCOUNT_TYPES, ["checking", "savings", "payment"]);
    assert.deepEqual(C.BANK_ACCOUNT_TYPES, Object.keys(C.BANK_ACCOUNT_TYPE));
    assert.deepEqual(Object.values(C.BANK_ACCOUNT_TYPE), ["Conta corrente", "Conta poupança", "Conta de pagamento"]);
    assert.deepEqual(C.PAYOUT_LIMITS, { methods: 10, holderName: 160, bankName: 80, accountNumber: 20 });
  });

  it("PAYOUT_RECENT_DAYS: \"Nova\" por 7 dias", () => {
    assert.equal(C.PAYOUT_RECENT_DAYS, 7);
  });

  // Contrato §8: o PIX_RECENT_DAYS sai (a central usa PAYOUT_RECENT_DAYS).
  it("PIX_RECENT_DAYS saiu", () => {
    assert.ok(!("PIX_RECENT_DAYS" in C), "PIX_RECENT_DAYS ainda está em lib/constants.ts");
  });
});

describe("e-mail que recebe (= mail.sendable, os casos do pytest)", () => {
  it("endereço com domínio de verdade", () => {
    assert.equal(C.isSendableEmail("alfa@exemplo.com"), true);
    assert.equal(C.isSendableEmail(" Alfa@Exemplo.com "), true);
  });

  it("importados, logins de teste e domínios locais não recebem", () => {
    for (const email of ["fc-12@importado.invalid", "tecnico", "a@b", "x@exemplo.local", "", null, undefined]) {
      assert.equal(C.isSendableEmail(email), false, String(email));
    }
  });

  it("PASSWORD_RESET_HOURS: o link de nova senha vale 2 horas", () => {
    assert.equal(C.PASSWORD_RESET_HOURS, 2);
  });
});

describe("RG e órgão emissor", () => {
  it("normaliza e valida (os casos do pytest)", () => {
    assert.equal(C.normalizeRg("12.345.678-x"), "12.345.678-X");
    assert.equal(C.isValidRg("12.345.678-x"), true);
    assert.equal(C.isValidRg("MG-12.345.678"), true);
    assert.equal(C.isValidRg("123"), false);
    assert.equal(C.isValidRg("AB-123"), false);
  });

  it("tira o que não é do RG e corta em 20", () => {
    assert.equal(C.normalizeRg("12_345*678#9"), "123456789");
    assert.equal(C.normalizeRg("1".repeat(30)).length, C.PROFILE_LIMITS.rgNumber);
  });

  it("órgão emissor: letras sem acento, maiúsculas", () => {
    assert.equal(C.normalizeIssuer("ssp"), "SSP");
    assert.equal(C.normalizeIssuer("Polícia  Civil"), "POLICIA CIVIL");
    assert.equal(C.normalizeIssuer("ssp/sp"), "SSPSP");
  });

  it("PROFILE_LIMITS igual ao servidor", () => {
    assert.deepEqual(C.PROFILE_LIMITS, {
      bio: 500,
      rgNumber: 20,
      rgIssuer: 20,
      addressNumber: 10,
      addressComplement: 60,
      companyName: 160,
      vehicleModel: 60,
    });
  });
});

describe("CEP", () => {
  it("CEP_TEXT", () => {
    assert.deepEqual(C.CEP_TEXT, {
      searching: "Buscando o CEP…",
      notFound: "CEP não encontrado.",
      unavailable: "Busca de CEP indisponível. Preencha o endereço.",
      invalid: "CEP inválido: use os 8 números.",
      use: "Usar este endereço",
    });
  });

  it("cepSummary: logradouro, bairro e cidade; CEP geral só a cidade", () => {
    assert.equal(C.cepSummary(SE), "Praça da Sé, Sé - São Paulo-SP");
    assert.equal(C.cepSummary(GENERAL), "Cidade Exemplo-SP");
    assert.equal(C.cepSummary({ ...SE, district: null }), "Praça da Sé - São Paulo-SP");
  });

  it("cepFill: formulário vazio recebe os 4", () => {
    const { next, filled, differs } = C.cepFill(EMPTY, EMPTY, NONE, SE);
    assert.deepEqual(next, { street: "Praça da Sé", district: "Sé", city: "São Paulo", state: "SP" });
    assert.deepEqual(filled, ["street", "district", "city", "state"]);
    assert.equal(differs, false);
  });

  it("cepFill: o que está igual ao aberto é trocado", () => {
    const opened = { street: "Rua Exemplo", district: "Bairro Exemplo", city: "Cidade Exemplo", state: "RJ" };
    const { next, filled, differs } = C.cepFill(opened, opened, NONE, SE);
    assert.deepEqual(next, { street: "Praça da Sé", district: "Sé", city: "São Paulo", state: "SP" });
    assert.deepEqual(filled, ["street", "district", "city", "state"]);
    assert.equal(differs, false);
  });

  it("cepFill: o digitado fica e avisa a diferença (sem acento, maiúsculas e espaços extras)", () => {
    const current = { street: "Rua Exemplo", district: "", city: "Sao  Paulo", state: "sp" };
    const { next, filled, differs } = C.cepFill(current, EMPTY, NONE, SE);
    assert.deepEqual(next, { street: "Rua Exemplo", district: "Sé", city: "Sao  Paulo", state: "sp" });
    assert.deepEqual(filled, ["district"]);
    assert.equal(differs, true);
    // Só a grafia diferente (acento, caixa): não é conflito.
    const same = C.cepFill({ ...current, street: "praca da se" }, EMPTY, NONE, SE);
    assert.equal(same.differs, false);
    assert.equal(same.next.street, "praca da se");
  });

  it("cepFill: CEP geral não mexe em logradouro nem bairro", () => {
    const current = { street: "Rua Exemplo", district: "Centro", city: "", state: "" };
    const { next, filled, differs } = C.cepFill(current, EMPTY, NONE, GENERAL);
    assert.deepEqual(next, { street: "Rua Exemplo", district: "Centro", city: "Cidade Exemplo", state: "SP" });
    assert.deepEqual(filled, ["city", "state"]);
    assert.equal(differs, false);
    const blank = C.cepFill(EMPTY, EMPTY, NONE, GENERAL);
    assert.deepEqual(blank.next, { street: "", district: "", city: "Cidade Exemplo", state: "SP" });
    assert.deepEqual(blank.filled, ["city", "state"]);
  });

  it("cepFill: campo da busca anterior (auto) conta como livre", () => {
    const current = { street: "Rua Exemplo", district: "Bairro Exemplo", city: "Cidade Exemplo", state: "RJ" };
    const auto = new Set(["street", "district", "city", "state"]);
    const { next, filled, differs } = C.cepFill(current, EMPTY, auto, SE);
    assert.deepEqual(next, { street: "Praça da Sé", district: "Sé", city: "São Paulo", state: "SP" });
    assert.deepEqual(filled, ["street", "district", "city", "state"]);
    assert.equal(differs, false);
  });

  it("cepFill: campo livre que já tem o valor não entra em filled; o formulário não muda", () => {
    const current = { street: "", district: "", city: "São Paulo", state: "SP" };
    const copy = { ...current };
    const { filled } = C.cepFill(current, current, NONE, SE);
    assert.deepEqual(filled, ["street", "district"]);
    assert.deepEqual(current, copy);
  });
});

describe("seções do cadastro (TECH_SECTION_GROUPS, central e app)", () => {
  const EXPECTED = [
    [
      "pessoais",
      "Dados pessoais e cadastrais",
      [
        ["foto", "Foto do perfil"],
        ["dados-pessoais", "Dados pessoais"],
        ["endereco", "Endereço"],
        ["contato", "Contato"],
        ["credenciais", "Credenciais"],
        ["documentos", "Documentos"],
        ["mini-biografia", "Mini biografia"],
      ],
    ],
    [
      "financeiros",
      "Dados financeiros e empresariais",
      [
        ["dados-empresariais", "Dados empresariais"],
        ["recebimento", "Formas de recebimento"],
      ],
    ],
    [
      "profissional",
      "Perfil profissional",
      [
        ["dias-e-horarios", "Dias e horários"],
        ["transporte", "Transporte"],
        ["curriculo", "Currículo"],
        ["formacao", "Formação"],
        ["aptidoes", "Aptidões"],
        ["ferramental", "Ferramental"],
      ],
    ],
  ];

  it("grupos e seções com os rótulos, na ordem", () => {
    const got = C.TECH_SECTION_GROUPS.map((g) => [g.key, g.label, g.sections.map((s) => [s.key, s.label])]);
    assert.deepEqual(got, EXPECTED);
  });

  it("chaves e rótulos não se repetem; Aptidões, nunca Skills", () => {
    const sections = C.TECH_SECTION_GROUPS.flatMap((g) => g.sections);
    assert.ok(unique(sections.map((s) => s.key)));
    assert.ok(unique(sections.map((s) => s.label)));
    assert.ok(unique(C.TECH_SECTION_GROUPS.map((g) => g.label)));
    assert.ok(sections.every((s) => !/skill/i.test(s.label)));
  });

  it("no app, Credenciais é Senha; o resto com o mesmo nome", () => {
    const renamed = C.TECH_SECTION_GROUPS.flatMap((g) => g.sections).filter((s) => s.app);
    assert.deepEqual(
      renamed.map((s) => [s.key, s.app]),
      [["credenciais", "Senha"]],
    );
  });

  it("Entrega 1 no ar: Documentos e Currículo ficam para a 2", () => {
    assert.equal(C.CADASTRO_DELIVERY, 1);
    const later = C.TECH_SECTION_GROUPS.flatMap((g) => g.sections).filter((s) => s.delivery > C.CADASTRO_DELIVERY);
    assert.deepEqual(
      later.map((s) => s.key),
      ["documentos", "curriculo"],
    );
  });
});

describe("situação e acesso", () => {
  it("rótulos", () => {
    assert.deepEqual(C.OPERATIONAL_STATUS, { active: "Ativo", inactive: "Inativo", blocked: "Bloqueado" });
    assert.deepEqual(C.APP_ACCESS, { on: "Liberado", off: "Sem acesso" });
  });
});

describe("histórico do cadastro (USER_CHANGE_LABEL)", () => {
  it("os campos novos, com os rótulos do contrato", () => {
    const NEW = {
      cpf: "CPF",
      rg: "RG",
      birth_date: "Nascimento",
      phone_secondary: "Telefone secundário",
      address_number: "Número",
      address_complement: "Complemento",
      bio: "Mini biografia",
      company_document: "CNPJ",
      company_name: "Razão social",
      company_trade_name: "Nome fantasia",
      vehicle: "Veículo",
      payout_methods: "Formas de recebimento",
      payout_preferred: "Forma preferencial",
      operational_status: "Situação",
      unavailability: "Indisponibilidade",
      email_pending: "E-mail novo",
      email_verified: "Validação do e-mail",
      password_link: "Link para nova senha",
      application: "Homologação",
    };
    for (const [field, label] of Object.entries(NEW)) assert.equal(C.USER_CHANGE_LABEL[field], label, field);
    const keys = Object.keys(C.USER_CHANGE_LABEL);
    assert.deepEqual(keys.slice(keys.indexOf("password") + 1), Object.keys(NEW));
  });

  it("address_line é o logradouro; as linhas antigas de PIX continuam legíveis", () => {
    assert.equal(C.USER_CHANGE_LABEL.address_line, "Logradouro");
    assert.equal(C.USER_CHANGE_LABEL.is_active, "Acesso ao app");
    assert.equal(C.USER_CHANGE_LABEL.pix, "Chave PIX");
    assert.equal(C.USER_CHANGE_LABEL.pix_holder, "Titular da conta");
  });

  it("os rótulos não se repetem", () => {
    assert.ok(unique(Object.values(C.USER_CHANGE_LABEL)));
  });
});

describe("aviso de privacidade", () => {
  const body = (title) => C.PRIVACY_NOTICE.find((item) => item.title === title)?.body ?? "";
  const all = C.PRIVACY_NOTICE.map((item) => `${item.title} ${item.body}`).join(" ");

  it("versão nova, da Entrega 1 (a publicação põe a data do dia, igual no backend)", () => {
    assert.ok(C.PRIVACY_VERSION >= "2026-11-25", C.PRIVACY_VERSION);
    assert.equal(C.PRIVACY_DATE, C.PRIVACY_VERSION.slice(0, 10).split("-").reverse().join("/"));
  });

  it("as seções, nesta ordem", () => {
    assert.deepEqual(
      C.PRIVACY_NOTICE.map((item) => item.title),
      [
        "Quem trata seus dados",
        "Quais dados",
        "Para quê",
        "Situação na operação",
        "Com quem compartilhamos",
        "E-mails",
        "Localização (GPS)",
        "Notas fiscais",
        "Elo",
        "Por quanto tempo",
        "Seus direitos",
      ],
    );
  });

  it("cita os dados novos, a situação e a reabertura da ficha", () => {
    for (const word of ["RG", "CPF", "veículo", "CNPJ", "chaves PIX", "contas bancárias", "biografia", "situação", "reabri"]) {
      assert.ok(all.includes(word), word);
    }
    assert.ok(body("Quais dados").includes("a validação de que o e-mail é seu"));
    assert.ok(body("Quais dados").includes("indisponível"));
    assert.ok(body("Por quanto tempo").includes("180 dias"));
    assert.ok(body("E-mails").includes("WhatsApp"));
  });

  it("textos curtos: sem \"Ex.:\" e sem pontos do Elo", () => {
    assert.ok(!all.includes("Ex.:"));
    assert.ok(!/\bpontos?\b/i.test(body("Elo")));
  });
});
