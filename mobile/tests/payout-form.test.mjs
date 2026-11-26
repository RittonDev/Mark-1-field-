// Sonda de lib/payoutForm.ts e lib/banks.ts (Configurações › Formas de recebimento): a folha da chave PIX e da conta, o
// corpo das rotas /me/profile/payout-methods, a próxima preferencial e os textos da forma. Dados fictícios. Sem
// dependência nova: node:test.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { URL } from "node:url";
import { BANKS, bankByCode, bankByName, bankSuggestions } from "../src/lib/banks.ts";
import { maskAccount, PAYOUT_LIMITS, payoutMethodText } from "../src/lib/constants.ts";
import { PIX_INVALID } from "../src/lib/pix.ts";
import * as form from "../src/lib/payoutForm.ts";

const {
  choosePixType,
  holderDocumentNeeded,
  keyPrefill,
  legacyPayoutMethods,
  nextPreferred,
  NO_PAYOUT,
  PAYOUT_FIELDS,
  PAYOUT_MSG,
  payoutCard,
  payoutChanged,
  payoutDraftOf,
  payoutInput,
  payoutListStale,
  payoutMethodsOf,
  payoutOwnerOf,
  payoutProblem,
  payoutRowSummary,
  payoutSpoken,
  pickBank,
  preferredPayout,
  typeBank,
} = form;

const OWNER = {
  name: "Tecnico Alfa",
  cpf: "12345678909",
  companyDocument: "12345678000195",
  companyName: "Empresa Exemplo Ltda",
  email: "tecnico.alfa@exemplo.com",
  phone: "(11) 98888-7777",
};

const PIX_CPF = {
  id: "m1",
  kind: "pix",
  preferred: true,
  pix_key_type: "cpf",
  pix_key: "12345678909",
  holder_name: "Tecnico Alfa",
  holder_document: "12345678909",
  created_at: "2026-11-01T10:00:00Z",
  changed_at: "2026-11-01T10:00:00Z",
};

const PIX_PHONE = {
  id: "m2",
  kind: "pix",
  preferred: false,
  pix_key_type: "phone",
  pix_key: "+5511988887777",
  holder_name: "Tecnico Alfa",
  holder_document: "12345678909",
  created_at: "2026-11-10T10:00:00Z",
  changed_at: "2026-11-10T10:00:00Z",
};

const BANK = {
  id: "m3",
  kind: "bank",
  preferred: false,
  bank_code: "999",
  bank_name: "Banco Exemplo",
  branch: "0001",
  account_number: "12345678",
  account_digit: "9",
  account_type: "checking",
  holder_name: "Tecnico Alfa",
  holder_document: "12345678909",
  created_at: "2026-11-20T10:00:00Z",
  changed_at: "2026-11-20T10:00:00Z",
};

/** O cadastro com o que importa aqui (API nova: payout_methods; antiga: só pix). */
function profileWith(extra) {
  return {
    id: "u1",
    name: "Tecnico Alfa",
    email: "tecnico.alfa@exemplo.com",
    phone: "(11) 98888-7777",
    cpf: "12345678909",
    company_document: null,
    company_name: null,
    pix: null,
    ...extra,
  };
}

/** A folha nova com a senha (para conferir só os outros erros). */
const draft = (patch = {}) => ({ ...payoutDraftOf(null, OWNER), password: "senha-exemplo", ...patch });

const valueImports = (file) => {
  const source = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
  return [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => ({ type: Boolean(m[1]), from: m[2] }));
};

describe("os módulos são puros", () => {
  it("payoutForm.ts só importa ./banks, ./constants, ./masks e ./pix (a sonda roda sem React nem React Native)", () => {
    const imports = valueImports("payoutForm.ts");
    assert.deepEqual(
      imports.filter((i) => !i.type).map((i) => i.from),
      ["./banks", "./constants", "./masks", "./pix"],
    );
    assert.ok(imports.every((i) => i.from.startsWith("./")));
  });

  it("banks.ts só importa ./techProfileForm (o foldName)", () => {
    const imports = valueImports("banks.ts");
    assert.deepEqual(
      imports.filter((i) => !i.type).map((i) => i.from),
      ["./techProfileForm"],
    );
  });
});

describe("a folha começa preenchida", () => {
  it("nova: PIX sem tipo, titular = o nome, documento = o CPF mascarado", () => {
    const fresh = payoutDraftOf(null, OWNER);
    assert.equal(fresh.kind, "pix");
    assert.equal(fresh.pixType, null);
    assert.equal(fresh.pixKey, "");
    assert.equal(fresh.holderName, "Tecnico Alfa");
    assert.equal(fresh.holderDocument, "123.456.789-09");
    assert.equal(fresh.preferred, false);
    assert.equal(fresh.password, "");
    assert.equal(fresh.accountType, null);
  });

  it("sem CPF no cadastro, o documento começa vazio", () => {
    assert.equal(payoutDraftOf(null, { ...OWNER, cpf: null }).holderDocument, "");
  });

  it("edição de chave: o tipo e a chave no jeito de editar", () => {
    const edit = payoutDraftOf(PIX_CPF, OWNER);
    assert.equal(edit.pixType, "cpf");
    assert.equal(edit.pixKey, "123.456.789-09");
    assert.equal(edit.preferred, true);
    assert.equal(payoutDraftOf(PIX_PHONE, OWNER).pixKey, "(11) 98888-7777");
  });

  it("edição de conta: banco fora da lista fica com o código digitado; o da lista, escolhido", () => {
    const edit = payoutDraftOf(BANK, OWNER);
    assert.equal(edit.kind, "bank");
    assert.equal(edit.bankPicked, false);
    assert.equal(edit.bankCode, "999");
    assert.equal(edit.branch, "0001");
    assert.equal(edit.accountNumber, "12345678");
    assert.equal(edit.accountDigit, "9");
    assert.equal(edit.accountType, "checking");
    assert.equal(edit.holderDocument, "123.456.789-09");
    assert.equal(payoutDraftOf({ ...BANK, bank_name: "Nubank", bank_code: "260" }, OWNER).bankPicked, true);
    // Nome da lista com outro código: fica como foi gravado.
    assert.equal(payoutDraftOf({ ...BANK, bank_name: "Nubank", bank_code: "999" }, OWNER).bankPicked, false);
  });

  it("payoutOwnerOf tira do cadastro o nome, o CPF, a empresa, o e-mail e o celular", () => {
    const owner = payoutOwnerOf(profileWith({ company_document: "12345678000195", company_name: "Empresa Exemplo Ltda" }));
    assert.deepEqual(owner, OWNER);
  });
});

describe("chave sugerida pelo tipo", () => {
  it("os 5 tipos", () => {
    assert.equal(keyPrefill("cpf", OWNER), "123.456.789-09");
    assert.equal(keyPrefill("cnpj", OWNER), "12.345.678/0001-95");
    assert.equal(keyPrefill("email", OWNER), "tecnico.alfa@exemplo.com");
    assert.equal(keyPrefill("phone", OWNER), "(11) 98888-7777");
    assert.equal(keyPrefill("random", OWNER), "");
  });

  it("só o que vale como chave: e-mail importado, telefone fixo, sem CPF ou sem empresa ficam vazios", () => {
    assert.equal(keyPrefill("email", { ...OWNER, email: "fc-12@importado.invalid" }), "");
    assert.equal(keyPrefill("email", { ...OWNER, email: "tecnico" }), "");
    assert.equal(keyPrefill("email", { ...OWNER, email: "Tecnico.Alfa@Exemplo.com" }), "tecnico.alfa@exemplo.com");
    assert.equal(keyPrefill("phone", { ...OWNER, phone: "(11) 3333-4444" }), "");
    assert.equal(keyPrefill("phone", { ...OWNER, phone: "+55 11 98888-7777" }), "(11) 98888-7777");
    assert.equal(keyPrefill("cpf", { ...OWNER, cpf: null }), "");
    assert.equal(keyPrefill("cnpj", { ...OWNER, companyDocument: null }), "");
  });
});

describe("trocar o tipo da chave", () => {
  it("a troca limpa a chave e põe a sugerida do tipo", () => {
    let d = choosePixType(draft(), "email", OWNER, null);
    assert.equal(d.pixType, "email");
    assert.equal(d.pixKey, "tecnico.alfa@exemplo.com");
    d = choosePixType({ ...d, pixKey: "outro@exemplo.com" }, "random", OWNER, null);
    assert.equal(d.pixKey, "");
  });

  it("voltar ao tipo gravado traz a chave gravada", () => {
    const base = payoutDraftOf(PIX_PHONE, OWNER);
    const other = choosePixType(base, "email", OWNER, PIX_PHONE);
    assert.equal(other.pixKey, "tecnico.alfa@exemplo.com");
    const back = choosePixType({ ...other, pixKey: "digitada@exemplo.com" }, "phone", OWNER, PIX_PHONE);
    assert.equal(back.pixKey, "(11) 98888-7777");
  });

  it("o mesmo tipo não muda nada", () => {
    const d = choosePixType(draft(), "cpf", OWNER, null);
    assert.equal(choosePixType(d, "cpf", OWNER, null), d);
  });

  it("o titular sugerido acompanha o tipo (CNPJ: a razão social); o digitado fica", () => {
    const cnpj = choosePixType(draft(), "cnpj", OWNER, null);
    assert.equal(cnpj.holderName, "Empresa Exemplo Ltda");
    assert.equal(choosePixType(cnpj, "cpf", OWNER, null).holderName, "Tecnico Alfa");
    const typed = choosePixType({ ...draft(), holderName: "Outra Pessoa Exemplo" }, "cnpj", OWNER, null);
    assert.equal(typed.holderName, "Outra Pessoa Exemplo");
    assert.equal(choosePixType(draft(), "cnpj", { ...OWNER, companyName: null }, null).holderName, "Tecnico Alfa");
  });
});

describe("CPF ou CNPJ do titular", () => {
  it("pedido na conta e nas chaves e-mail, celular e aleatória; na CPF e na CNPJ, é a chave", () => {
    assert.equal(holderDocumentNeeded({ kind: "bank", pixType: null }), true);
    assert.equal(holderDocumentNeeded({ kind: "pix", pixType: null }), false);
    assert.equal(holderDocumentNeeded({ kind: "pix", pixType: "cpf" }), false);
    assert.equal(holderDocumentNeeded({ kind: "pix", pixType: "cnpj" }), false);
    for (const type of ["email", "phone", "random"]) assert.equal(holderDocumentNeeded({ kind: "pix", pixType: type }), true);
  });
});

describe("erros da folha", () => {
  it("a ordem da tela", () => {
    assert.deepEqual(PAYOUT_FIELDS, [
      "pixType",
      "pixKey",
      "bankName",
      "bankCode",
      "branch",
      "accountNumber",
      "accountDigit",
      "accountType",
      "holderName",
      "holderDocument",
      "password",
    ]);
  });

  it("chave: o tipo, vazia, inválida (com ponto) e a senha", () => {
    assert.deepEqual(payoutProblem({ ...draft(), password: "" }, []), { pixType: PAYOUT_MSG.pixType, password: PAYOUT_MSG.password });
    assert.deepEqual(payoutProblem(draft({ pixType: "cpf", pixKey: " " }), []), { pixKey: PAYOUT_MSG.pixKey });
    assert.deepEqual(payoutProblem(draft({ pixType: "cpf", pixKey: "123.456.789-00" }), []), { pixKey: `${PIX_INVALID.cpf}.` });
    assert.deepEqual(payoutProblem(draft({ pixType: "cpf", pixKey: "123.456.789-09" }), []), {});
  });

  it("chave repetida mesmo escrita de outro jeito; editar a própria não é repetida", () => {
    const phone = draft({ pixType: "phone", pixKey: "(11) 98888-7777", holderDocument: "123.456.789-09" });
    assert.deepEqual(payoutProblem(phone, [PIX_CPF, PIX_PHONE]), { pixKey: PAYOUT_MSG.pixRepeated });
    assert.deepEqual(payoutProblem(phone, [PIX_CPF]), {});
    // A mesma chave de outro tipo não é repetida.
    assert.deepEqual(payoutProblem(draft({ pixType: "cpf", pixKey: "12345678909" }), [PIX_PHONE]), {});
  });

  it("titular e documento", () => {
    assert.deepEqual(payoutProblem(draft({ pixType: "cpf", pixKey: "12345678909", holderName: " Al " }), []), {
      holderName: PAYOUT_MSG.holderName,
    });
    const email = draft({ pixType: "email", pixKey: "tecnico.alfa@exemplo.com" });
    assert.deepEqual(payoutProblem({ ...email, holderDocument: "" }, []), { holderDocument: PAYOUT_MSG.holderDocument });
    assert.deepEqual(payoutProblem({ ...email, holderDocument: "123.456.789-00" }, []), {
      holderDocument: PAYOUT_MSG.holderDocumentInvalid,
    });
    assert.deepEqual(payoutProblem({ ...email, holderDocument: "12.ABC.345/01DE-35" }, []), {});
    assert.deepEqual(payoutProblem({ ...email, holderDocument: "12.345.678/0001-95" }, []), {});
  });

  it("conta vazia: banco, agência, conta, dígito e tipo", () => {
    assert.deepEqual(payoutProblem(draft({ kind: "bank" }), []), {
      bankName: PAYOUT_MSG.bankName,
      branch: PAYOUT_MSG.branch,
      accountNumber: PAYOUT_MSG.accountNumber,
      accountDigit: PAYOUT_MSG.accountDigit,
      accountType: PAYOUT_MSG.accountType,
    });
  });

  it("banco fora da lista pede o código com 3 números", () => {
    const account = draft({
      kind: "bank",
      bankName: "Banco Exemplo",
      branch: "1",
      accountNumber: "12345",
      accountDigit: "6",
      accountType: "checking",
    });
    assert.deepEqual(payoutProblem(account, []), { bankCode: PAYOUT_MSG.bankCode });
    assert.deepEqual(payoutProblem({ ...account, bankCode: "99" }, []), { bankCode: PAYOUT_MSG.bankCode });
    assert.deepEqual(payoutProblem({ ...account, bankCode: "999" }, []), {});
    assert.deepEqual(payoutProblem(pickBank(account, bankByCode("260")), []), {});
  });

  it("conta repetida: mesmo banco, agência com 4 números, conta sem os zeros da frente e dígito", () => {
    const saved = { ...BANK, account_number: "12345", account_digit: "6" };
    const account = draft({
      kind: "bank",
      bankName: "Banco Exemplo",
      bankCode: "999",
      branch: "1",
      accountNumber: "0012345",
      accountDigit: "6",
      accountType: "savings",
    });
    assert.deepEqual(payoutProblem(account, [saved]), { accountNumber: PAYOUT_MSG.accountRepeated });
    assert.deepEqual(payoutProblem({ ...account, accountDigit: "7" }, [saved]), {});
    assert.deepEqual(payoutProblem({ ...account, branch: "2" }, [saved]), {});
  });

  it("os textos são os do servidor, com ponto", () => {
    assert.equal(PAYOUT_MSG.pixRepeated, "Esta chave PIX já está na lista.");
    assert.equal(PAYOUT_MSG.accountRepeated, "Esta conta já está na lista.");
    assert.equal(PAYOUT_MSG.limit, "Limite de 10 formas de recebimento. Exclua uma para incluir outra.");
    assert.equal(PAYOUT_LIMITS.methods, 10);
    for (const message of Object.values(PAYOUT_MSG)) assert.ok(message.endsWith("."), message);
  });
});

describe("corpo das rotas", () => {
  it("chave CPF e CNPJ vão sem documento (é a própria chave), normalizadas", () => {
    const input = payoutInput(draft({ pixType: "cpf", pixKey: "123.456.789-09", holderName: "  Tecnico   Alfa " }));
    assert.deepEqual(input, { kind: "pix", pix_key_type: "cpf", pix_key: "12345678909", holder_name: "Tecnico Alfa" });
    assert.ok(!("holder_document" in input));
    const cnpj = payoutInput(draft({ pixType: "cnpj", pixKey: "12.345.678/0001-95" }));
    assert.ok(!("holder_document" in cnpj));
  });

  it("chave celular com o documento limpo", () => {
    assert.deepEqual(payoutInput(draft({ pixType: "phone", pixKey: "(11) 98888-7777", holderDocument: "12.abc.345/01de-35" })), {
      kind: "pix",
      pix_key_type: "phone",
      pix_key: "+5511988887777",
      holder_name: "Tecnico Alfa",
      holder_document: "12ABC34501DE35",
    });
  });

  it("conta: o nome do banco da lista, a agência com 4 números, o dígito em maiúscula", () => {
    const account = typeBank(
      draft({ kind: "bank", branch: "1", accountNumber: "0012345", accountDigit: "x", accountType: "payment" }),
      "nu pagamentos",
    );
    assert.deepEqual(payoutInput(account), {
      kind: "bank",
      bank_code: "260",
      bank_name: "Nubank",
      branch: "0001",
      account_number: "0012345",
      account_digit: "X",
      account_type: "payment",
      holder_name: "Tecnico Alfa",
      holder_document: "12345678909",
    });
  });

  it("banco fora da lista: o nome e o código digitados", () => {
    const account = draft({
      kind: "bank",
      bankName: " Banco  Exemplo ",
      bankCode: "999",
      branch: "0001",
      accountNumber: "12345678",
      accountDigit: "9",
      accountType: "checking",
    });
    const input = payoutInput(account);
    assert.equal(input.bank_name, "Banco Exemplo");
    assert.equal(input.bank_code, "999");
  });

  it("sem o tipo da chave ou da conta: null", () => {
    assert.equal(payoutInput(draft()), null);
    assert.equal(payoutInput(draft({ kind: "bank" })), null);
  });
});

describe("mudou?", () => {
  it("a senha e o preferencial não contam", () => {
    const base = payoutDraftOf(BANK, OWNER);
    assert.equal(payoutChanged({ ...base, password: "senha-exemplo", preferred: true }, base), false);
    assert.equal(payoutChanged({ ...base, accountNumber: "12345679" }, base), true);
    assert.equal(payoutChanged({ ...base, holderName: "Outra Pessoa Exemplo" }, base), true);
  });

  it("a mesma chave escrita de outro jeito não é mudança", () => {
    const base = payoutDraftOf(PIX_PHONE, OWNER);
    assert.equal(payoutChanged({ ...base, pixKey: "11988887777" }, base), false);
    assert.equal(payoutChanged({ ...base, pixKey: "(11) 97777-6666" }, base), true);
  });

  it("o documento escondido (chave CPF) não conta", () => {
    const base = payoutDraftOf(PIX_CPF, OWNER);
    assert.equal(payoutChanged({ ...base, holderDocument: "" }, base), false);
  });
});

describe("a lista", () => {
  it("excluir a preferencial passa para a mais nova das outras; outra ou a única: null", () => {
    const list = [PIX_CPF, PIX_PHONE, BANK];
    assert.equal(nextPreferred(list, "m1"), BANK);
    assert.equal(nextPreferred([PIX_CPF, PIX_PHONE], "m1"), PIX_PHONE);
    assert.equal(nextPreferred(list, "m2"), null);
    assert.equal(nextPreferred([PIX_CPF], "m1"), null);
    assert.equal(nextPreferred(list, "nao-existe"), null);
  });

  it("a chave PIX da API antiga vira a única forma, preferencial, sem documento", () => {
    const pix = { key_type: "email", key: "tecnico.alfa@exemplo.com", holder_name: "Tecnico Alfa", updated_at: "2026-11-18T14:30:00Z" };
    assert.deepEqual(legacyPayoutMethods(pix), [
      {
        id: "pix",
        kind: "pix",
        preferred: true,
        pix_key_type: "email",
        pix_key: "tecnico.alfa@exemplo.com",
        holder_name: "Tecnico Alfa",
        holder_document: null,
        created_at: "2026-11-18T14:30:00Z",
        changed_at: "2026-11-18T14:30:00Z",
      },
    ]);
    assert.deepEqual(legacyPayoutMethods(null), []);
  });

  it("payoutMethodsOf: a API nova edita; a antiga só mostra a chave de antes", () => {
    assert.deepEqual(payoutMethodsOf(profileWith({ payout_methods: [PIX_CPF] })), { methods: [PIX_CPF], editable: true });
    const old = payoutMethodsOf(profileWith({ pix: { key_type: "cpf", key: "12345678909", holder_name: null, updated_at: null } }));
    assert.equal(old.editable, false);
    assert.equal(old.methods.length, 1);
    assert.equal(old.methods[0].holder_name, "");
  });

  it("preferredPayout: a preferencial (nova), a chave de antes (antiga) ou nenhuma", () => {
    assert.equal(preferredPayout(profileWith({ payout_methods: [PIX_PHONE, { ...BANK, preferred: true }] })).id, "m3");
    assert.equal(preferredPayout(profileWith({ pix: { key_type: "cpf", key: "12345678909", holder_name: "Tecnico Alfa", updated_at: null } })).id, "pix");
    assert.equal(preferredPayout(profileWith({ payout_methods: [] })), null);
    assert.equal(preferredPayout(profileWith({})), null);
    assert.equal(preferredPayout(null), null);
  });
});

describe("erros depois dos quais a tela relê a lista (payoutListStale)", () => {
  /** Como o ApiError de lib/api.ts (status e code), sem importá-lo: api.ts puxa o React Native. */
  class ApiErrorLike extends Error {
    constructor(status, code = null) {
      super("erro de exemplo");
      this.status = status;
      this.code = code;
    }
  }

  it("sem resposta (status 0) e os códigos de lista velha: relê", () => {
    assert.equal(payoutListStale(new ApiErrorLike(0)), true);
    assert.equal(payoutListStale(new ApiErrorLike(404, "PAYOUT_METHOD_NOT_FOUND")), true);
    assert.equal(payoutListStale(new ApiErrorLike(409, "PAYOUT_METHOD_DUPLICATE")), true);
    assert.equal(payoutListStale(new ApiErrorLike(422, "PAYOUT_METHODS_LIMIT")), true);
  });

  it("os outros erros não mexem na lista", () => {
    assert.equal(payoutListStale(new ApiErrorLike(404)), false);
    assert.equal(payoutListStale(new ApiErrorLike(409, "PAYOUT_METHOD_NOT_FOUND")), false);
    assert.equal(payoutListStale(new ApiErrorLike(422)), false);
    assert.equal(payoutListStale(new ApiErrorLike(422, "PAYOUT_METHOD_KIND_LOCKED")), false);
    assert.equal(payoutListStale(new ApiErrorLike(400)), false);
    assert.equal(payoutListStale(new ApiErrorLike(429)), false);
    assert.equal(payoutListStale(new ApiErrorLike(500)), false);
    assert.equal(payoutListStale(new Error("Sessão encerrada")), false);
    assert.equal(payoutListStale(null), false);
    assert.equal(payoutListStale(undefined), false);
    assert.equal(payoutListStale("Sem conexão"), false);
  });

  it("a resposta do 1º POST se perdeu: com a lista velha a folha deixa reenviar; relida, acusa a repetida no campo", () => {
    const sheet = draft({ pixType: "phone", pixKey: "(11) 97777-6666", holderDocument: "123.456.789-09" });
    const input = payoutInput(sheet);
    assert.ok(input && input.kind === "pix");
    // O que o servidor gravou no POST cuja resposta não chegou (o reenvio dá 409 PAYOUT_METHOD_DUPLICATE).
    const committed = { ...PIX_PHONE, id: "m-nova", pix_key: input.pix_key, created_at: "2026-11-26T10:00:00Z" };
    assert.deepEqual(payoutProblem(sheet, [PIX_CPF]), {});
    assert.equal(payoutListStale(new ApiErrorLike(409, "PAYOUT_METHOD_DUPLICATE")), true);
    assert.equal(payoutProblem(sheet, [PIX_CPF, committed]).pixKey, PAYOUT_MSG.pixRepeated);
  });
});

describe("textos da forma", () => {
  it("payoutMethodText e maskAccount (constants)", () => {
    assert.equal(payoutMethodText(PIX_CPF), "PIX CPF •••.456.789-••");
    assert.equal(payoutMethodText(BANK), "Banco Exemplo ••••5678-9");
    assert.equal(maskAccount("23", "4"), "••23-4");
    assert.equal(maskAccount("234", "4"), "••34-4");
  });

  it("o cartão", () => {
    assert.deepEqual(payoutCard(PIX_CPF), { title: "Chave PIX · CPF", detail: "•••.456.789-••", holder: "Tecnico Alfa" });
    assert.deepEqual(payoutCard(BANK), { title: "Banco Exemplo", detail: "Conta corrente · Ag. 0001 · ••••5678-9", holder: "Tecnico Alfa" });
    assert.equal(payoutCard({ ...PIX_PHONE, pix_key_type: "random", pix_key: "a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6" }).title, "Chave PIX · Aleatória");
  });

  it("o leitor de tela não fala números", () => {
    assert.equal(payoutSpoken(PIX_CPF), "Chave PIX CPF, titular Tecnico Alfa");
    assert.equal(payoutSpoken(BANK), "Conta corrente, Banco Exemplo, titular Tecnico Alfa");
    assert.equal(payoutSpoken({ ...PIX_PHONE, holder_name: "" }), "Chave PIX celular");
    for (const method of [PIX_CPF, PIX_PHONE, BANK]) assert.doesNotMatch(payoutSpoken(method), /\d/);
  });

  it("a linha de Configurações", () => {
    assert.deepEqual(payoutRowSummary(profileWith({ payout_methods: [PIX_CPF, BANK] })), {
      value: "PIX CPF •••.456.789-••",
      tone: "muted",
      spoken: "Formas de recebimento, chave PIX CPF",
    });
    assert.deepEqual(payoutRowSummary(profileWith({ payout_methods: [{ ...BANK, preferred: true }] })), {
      value: "Banco Exemplo ••••5678-9",
      tone: "muted",
      spoken: "Formas de recebimento, conta Banco Exemplo",
    });
    assert.deepEqual(payoutRowSummary(profileWith({ payout_methods: [] })), {
      value: NO_PAYOUT,
      tone: "warning",
      spoken: "Formas de recebimento, nenhuma",
    });
    assert.equal(NO_PAYOUT, "Nenhuma");
  });
});

describe("bancos", () => {
  it("29 bancos, códigos de 3 números e nomes sem repetir", () => {
    assert.equal(BANKS.length, 29);
    assert.ok(BANKS.every((bank) => /^\d{3}$/.test(bank.code)));
    assert.equal(new Set(BANKS.map((bank) => bank.code)).size, BANKS.length);
    assert.equal(new Set(BANKS.map((bank) => bank.name)).size, BANKS.length);
  });

  it("sugestões: vazio os 6 primeiros; pelo nome e pelo código", () => {
    assert.deepEqual(bankSuggestions(""), BANKS.slice(0, 6));
    assert.equal(bankSuggestions("nu")[0].name, "Nubank");
    assert.equal(bankSuggestions("itau")[0].name, "Itaú");
    assert.deepEqual(bankSuggestions("260").map((bank) => bank.name), ["Nubank"]);
    // O igual primeiro (o "1" acha o 001), depois os que começam com 1, na ordem da lista.
    assert.deepEqual(bankSuggestions("1").map((bank) => bank.code), ["001", "104", "121", "197", "136"]);
    assert.equal(bankSuggestions("pic pay")[0].name, "PicPay");
    assert.equal(bankSuggestions("cef")[0].name, "Caixa");
    assert.ok(bankSuggestions("a").length <= 6);
    assert.deepEqual(bankSuggestions("Banco Exemplo"), []);
  });

  it("pelo nome inteiro: sem acento, maiúsculas, o \"Banco\" da frente e os espaços", () => {
    assert.equal(bankByName("Itau Unibanco")?.code, "341");
    assert.equal(bankByName("banco bradesco")?.code, "237");
    assert.equal(bankByName("BANCO DO BRASIL")?.code, "001");
    assert.equal(bankByName("Pic Pay")?.code, "380");
    assert.equal(bankByName("Banco Exemplo"), null);
    assert.equal(bankByName(""), null);
    assert.equal(bankByCode("1")?.name, "Banco do Brasil");
    assert.equal(bankByCode("999"), null);
  });

  it("digitar o nome de um da lista escolhe; outro texto solta e tira o código da lista", () => {
    const picked = typeBank(draft({ kind: "bank" }), "Caixa Econômica Federal");
    assert.equal(picked.bankPicked, true);
    assert.equal(picked.bankCode, "104");
    const released = typeBank(picked, "Caixa Exemplo");
    assert.equal(released.bankPicked, false);
    assert.equal(released.bankCode, "");
    // Fora da lista, o código digitado fica enquanto o nome muda.
    const typed = typeBank({ ...released, bankCode: "999" }, "Banco Exemplo");
    assert.equal(typed.bankCode, "999");
  });

  it("tocar numa sugestão põe o nome e o código dela", () => {
    const picked = pickBank(draft({ kind: "bank", bankName: "nu" }), bankByCode("260"));
    assert.equal(picked.bankName, "Nubank");
    assert.equal(picked.bankCode, "260");
    assert.equal(picked.bankPicked, true);
  });
});
