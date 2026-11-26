// Formas de recebimento (Configurações › Formas de recebimento): as regras da folha de chave PIX e conta bancária, o
// corpo das rotas /me/profile/payout-methods, a próxima preferencial ao excluir, os erros depois dos quais a tela relê a
// lista (payoutListStale) e os textos da forma (cartão, leitor de tela, linha de Configurações e Faturamento). Sem React
// nem React Native: entra na sonda tests/payout-form.test.mjs (imports de valor só ./banks, ./constants, ./masks e
// ./pix). As regras são as do servidor (contrato §6.4), que confere
// de novo; as mensagens daqui terminam com ponto. O técnico nunca vê nada interno (titular diferente, "Nova").

import { bankByCode, bankByName } from "./banks";
import { BANK_ACCOUNT_TYPE, isSendableEmail, maskAccount, maskPixKey, PAYOUT_LIMITS, payoutMethodText } from "./constants";
import { isValidDocument, maskAccountDigit, maskAccountNumber, maskBranch, maskCpf, maskDocument, onlyDigits } from "./masks";
import { maskPixInput, parsePixKey, pixInputValue } from "./pix";
import type { BankOption } from "./banks";
import type {
  BankAccountType,
  MyProfile,
  PayoutMethod,
  PayoutMethodIn,
  PayoutMethodKind,
  PixInfo,
  PixKeyType,
  PixPayoutMethod,
} from "./types";

// --------------------------------------------------------------------------- dono e rascunho da folha

/** O que a folha usa do cadastro para começar preenchida. */
export interface PayoutOwner {
  name: string;
  /** 11 números, ou null. */
  cpf: string | null;
  /** CNPJ da empresa (14 caracteres), ou null. */
  companyDocument: string | null;
  /** Razão social: o titular da chave CNPJ. */
  companyName: string | null;
  email: string;
  phone: string | null;
}

export function payoutOwnerOf(p: MyProfile): PayoutOwner {
  return {
    name: p.name,
    cpf: p.cpf ?? null,
    companyDocument: p.company_document ?? null,
    companyName: p.company_name ?? null,
    email: p.email,
    phone: p.phone,
  };
}

/** A folha: os campos dos dois tipos ficam guardados (trocar de PIX para conta e voltar não perde o digitado). */
export interface PayoutDraft {
  kind: PayoutMethodKind;
  pixType: PixKeyType | null;
  /** Como está no campo (com a máscara do tipo). */
  pixKey: string;
  bankName: string;
  /** 3 números; com o banco da lista (`bankPicked`), o código dele. */
  bankCode: string;
  bankPicked: boolean;
  branch: string;
  accountNumber: string;
  accountDigit: string;
  accountType: BankAccountType | null;
  holderName: string;
  /** CPF ou CNPJ do titular, com a máscara. */
  holderDocument: string;
  /** "Usar como preferencial" (ao adicionar, já havendo outra). */
  preferred: boolean;
  password: string;
}

export type PayoutField =
  | "pixType"
  | "pixKey"
  | "bankName"
  | "bankCode"
  | "branch"
  | "accountNumber"
  | "accountDigit"
  | "accountType"
  | "holderName"
  | "holderDocument"
  | "password";

/** A ordem da tela (o primeiro erro é o de cima). */
export const PAYOUT_FIELDS: PayoutField[] = [
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
];

/** As da folha; as do servidor são as mesmas, sem o ponto (contrato §6.4). Chave inválida: PIX_INVALID (lib/pix.ts). */
export const PAYOUT_MSG = {
  pixType: "Escolha o tipo da chave PIX.",
  pixKey: "Informe a chave PIX.",
  pixRepeated: "Esta chave PIX já está na lista.",
  bankName: "Informe o banco.",
  bankCode: "Código do banco com 3 números.",
  branch: "Informe a agência.",
  accountNumber: "Informe o número da conta.",
  accountRepeated: "Esta conta já está na lista.",
  accountDigit: "Informe o dígito da conta.",
  accountType: "Escolha o tipo de conta.",
  holderName: "Informe o nome do titular.",
  holderDocument: "Informe o CPF ou CNPJ do titular.",
  holderDocumentInvalid: "CPF ou CNPJ do titular inválido.",
  password: "Informe a senha atual.",
  limit: `Limite de ${PAYOUT_LIMITS.methods} formas de recebimento. Exclua uma para incluir outra.`,
} as const;

/** Espaços juntados e NFC, como o servidor grava o titular e o banco. */
const squash = (text: string) => text.normalize("NFC").trim().replace(/\s+/g, " ");

/** Tamanho em caracteres, como o servidor conta. */
const chars = (text: string) => Array.from(text).length;

/** CPF ou CNPJ só com letras e números, em maiúsculas (como o servidor grava). */
const documentOf = (text: string) => text.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

/** A chave como o servidor grava; digitada pela metade ou errada, o próprio texto (para comparar). */
function pixKeyOf(type: PixKeyType, text: string): string {
  const parsed = parsePixKey(type, text);
  return "key" in parsed ? parsed.key : text.trim();
}

/** O titular que a folha sugere para o tipo: na chave CNPJ, a razão social; senão, o nome. */
function autoHolder(type: PixKeyType | null, owner: PayoutOwner): string {
  const company = squash(owner.companyName ?? "");
  return type === "cnpj" && company ? company : squash(owner.name);
}

/** A folha nova (PIX, sem tipo, titular = o nome, documento = o CPF) ou a da forma gravada. */
export function payoutDraftOf(method: PayoutMethod | null, owner: PayoutOwner): PayoutDraft {
  const blank: PayoutDraft = {
    kind: "pix",
    pixType: null,
    pixKey: "",
    bankName: "",
    bankCode: "",
    bankPicked: false,
    branch: "",
    accountNumber: "",
    accountDigit: "",
    accountType: null,
    holderName: squash(owner.name),
    holderDocument: owner.cpf ? maskCpf(owner.cpf) : "",
    preferred: false,
    password: "",
  };
  if (!method) return blank;
  const saved: PayoutDraft = {
    ...blank,
    holderName: method.holder_name,
    holderDocument: method.holder_document ? maskDocument(method.holder_document) : "",
    preferred: method.preferred,
  };
  if (method.kind === "pix") {
    return { ...saved, kind: "pix", pixType: method.pix_key_type, pixKey: pixInputValue(method.pix_key_type, method.pix_key) };
  }
  return {
    ...saved,
    kind: "bank",
    bankName: method.bank_name,
    bankCode: method.bank_code,
    // Da lista só quando o código também é o dela (um "Nubank" gravado com outro código fica como foi digitado).
    bankPicked: bankByName(method.bank_name)?.code === method.bank_code,
    branch: method.branch,
    accountNumber: method.account_number,
    accountDigit: method.account_digit,
    accountType: method.account_type,
  };
}

/**
 * A chave que a folha sugere para o tipo, do cadastro: o CPF, o CNPJ da empresa, o e-mail (o que recebe mensagens) e o
 * celular, quando valem como chave; a aleatória começa vazia.
 */
export function keyPrefill(type: PixKeyType, owner: PayoutOwner): string {
  const valid = (text: string | null) => (text && "key" in parsePixKey(type, text) ? maskPixInput(type, text) : "");
  switch (type) {
    case "cpf":
      return valid(owner.cpf);
    case "cnpj":
      return valid(owner.companyDocument);
    case "email":
      return isSendableEmail(owner.email) ? valid(owner.email.trim().toLowerCase()) : "";
    case "phone":
      return valid(owner.phone);
    case "random":
      return "";
  }
}

/**
 * Trocar o tipo da chave: a chave sai e entra a sugerida do tipo (`keyPrefill`); voltar ao tipo gravado (`saved`) traz
 * a chave gravada. O titular que ainda é o sugerido acompanha o tipo (na chave CNPJ, a razão social).
 */
export function choosePixType(draft: PayoutDraft, type: PixKeyType, owner: PayoutOwner, saved: PayoutMethod | null): PayoutDraft {
  if (draft.pixType === type) return draft;
  const savedKey = saved?.kind === "pix" && saved.pix_key_type === type ? pixInputValue(type, saved.pix_key) : null;
  const holder = squash(draft.holderName);
  const untouched = !holder || holder === autoHolder(draft.pixType, owner);
  return {
    ...draft,
    pixType: type,
    pixKey: savedKey ?? keyPrefill(type, owner),
    holderName: untouched ? autoHolder(type, owner) : draft.holderName,
  };
}

/** Digitar o banco: o nome (ou apelido) de um da lista o escolhe sozinho; outro texto solta o escolhido. */
export function typeBank(draft: PayoutDraft, text: string): PayoutDraft {
  const bank = bankByName(text);
  if (bank) return { ...draft, bankName: text, bankCode: bank.code, bankPicked: true };
  // O código era o da lista, não o digitado: sai junto.
  return { ...draft, bankName: text, bankCode: draft.bankPicked ? "" : draft.bankCode, bankPicked: false };
}

/** Tocar numa sugestão. */
export function pickBank(draft: PayoutDraft, bank: BankOption): PayoutDraft {
  return { ...draft, bankName: bank.name, bankCode: bank.code, bankPicked: true };
}

/** O CPF ou CNPJ do titular é pedido na conta e nas chaves e-mail, celular e aleatória (na CPF e na CNPJ, é a chave). */
export function holderDocumentNeeded(draft: Pick<PayoutDraft, "kind" | "pixType">): boolean {
  return draft.kind === "bank" || (draft.pixType !== null && draft.pixType !== "cpf" && draft.pixType !== "cnpj");
}

/** O banco que vai para o servidor: o da lista, quando escolhido; senão o digitado. */
function bankOf(draft: PayoutDraft): { code: string; name: string } {
  const listed = draft.bankPicked ? bankByCode(draft.bankCode) : null;
  return listed ? { code: listed.code, name: listed.name } : { code: onlyDigits(draft.bankCode), name: squash(draft.bankName) };
}

/** A mesma conta para o servidor: mesmo banco, agência (com 4 números), conta (sem zeros à esquerda) e dígito. */
function accountKey(code: string, branch: string, number: string, digit: string): string {
  return [code.padStart(3, "0"), onlyDigits(branch).padStart(4, "0"), onlyDigits(number).replace(/^0+/, ""), digit.toUpperCase()].join("|");
}

/**
 * Os erros da folha, na ordem da tela ({} quando pode salvar). `others`: as outras formas do técnico (na edição, sem a
 * editada), para não repetir a chave (mesmo tipo e chave como o servidor grava) nem a conta.
 */
export function payoutProblem(draft: PayoutDraft, others: readonly PayoutMethod[]): Partial<Record<PayoutField, string>> {
  const errors: Partial<Record<PayoutField, string>> = {};
  if (draft.kind === "pix") {
    const type = draft.pixType;
    if (!type) {
      errors.pixType = PAYOUT_MSG.pixType;
    } else if (!draft.pixKey.trim()) {
      errors.pixKey = PAYOUT_MSG.pixKey;
    } else {
      const parsed = parsePixKey(type, draft.pixKey);
      if ("error" in parsed) errors.pixKey = `${parsed.error}.`;
      else if (others.some((m) => m.kind === "pix" && m.pix_key_type === type && m.pix_key === parsed.key)) {
        errors.pixKey = PAYOUT_MSG.pixRepeated;
      }
    }
  } else {
    const name = squash(draft.bankName);
    if (chars(name) < 2) errors.bankName = PAYOUT_MSG.bankName;
    // O código só é pedido com o nome de um banco fora da lista.
    else if (!draft.bankPicked && !/^\d{3}$/.test(draft.bankCode)) errors.bankCode = PAYOUT_MSG.bankCode;
    const branch = maskBranch(draft.branch);
    if (!branch) errors.branch = PAYOUT_MSG.branch;
    const number = maskAccountNumber(draft.accountNumber);
    const digit = maskAccountDigit(draft.accountDigit);
    if (!number) {
      errors.accountNumber = PAYOUT_MSG.accountNumber;
    } else if (branch && digit && !errors.bankName && !errors.bankCode) {
      const key = accountKey(bankOf(draft).code, branch, number, digit);
      if (others.some((m) => m.kind === "bank" && accountKey(m.bank_code, m.branch, m.account_number, m.account_digit) === key)) {
        errors.accountNumber = PAYOUT_MSG.accountRepeated;
      }
    }
    if (!digit) errors.accountDigit = PAYOUT_MSG.accountDigit;
    if (!draft.accountType) errors.accountType = PAYOUT_MSG.accountType;
  }
  if (chars(squash(draft.holderName)) < 3) errors.holderName = PAYOUT_MSG.holderName;
  if (holderDocumentNeeded(draft)) {
    const document = documentOf(draft.holderDocument);
    if (!document) errors.holderDocument = PAYOUT_MSG.holderDocument;
    else if (!isValidDocument(document)) errors.holderDocument = PAYOUT_MSG.holderDocumentInvalid;
  }
  if (!draft.password) errors.password = PAYOUT_MSG.password;
  return errors;
}

/**
 * O corpo de POST e PUT, normalizado (a chave como o servidor grava, a agência com 4 números, o documento limpo, o nome
 * do banco da lista quando escolhido; nas chaves CPF e CNPJ, sem o documento: é a própria chave). null sem o tipo da
 * chave ou da conta (a folha só chama sem erros).
 */
export function payoutInput(draft: PayoutDraft): PayoutMethodIn | null {
  const holder_name = squash(draft.holderName);
  if (draft.kind === "pix") {
    const type = draft.pixType;
    if (!type) return null;
    const pix_key = pixKeyOf(type, draft.pixKey);
    return holderDocumentNeeded(draft)
      ? { kind: "pix", pix_key_type: type, pix_key, holder_name, holder_document: documentOf(draft.holderDocument) }
      : { kind: "pix", pix_key_type: type, pix_key, holder_name };
  }
  if (!draft.accountType) return null;
  const bank = bankOf(draft);
  return {
    kind: "bank",
    bank_code: bank.code,
    bank_name: bank.name,
    branch: maskBranch(draft.branch).padStart(4, "0"),
    account_number: maskAccountNumber(draft.accountNumber),
    account_digit: maskAccountDigit(draft.accountDigit),
    account_type: draft.accountType,
    holder_name,
    holder_document: documentOf(draft.holderDocument),
  };
}

/** O que a folha grava, para comparar (sem a senha e sem o "Usar como preferencial"). */
function signature(draft: PayoutDraft): string {
  const holder = squash(draft.holderName);
  const document = holderDocumentNeeded(draft) ? documentOf(draft.holderDocument) : "";
  if (draft.kind === "pix") {
    const key = draft.pixType ? pixKeyOf(draft.pixType, draft.pixKey) : "";
    return JSON.stringify(["pix", draft.pixType, key, holder, document]);
  }
  const bank = bankOf(draft);
  return JSON.stringify([
    "bank",
    bank.code,
    bank.name,
    onlyDigits(draft.branch).padStart(4, "0"),
    maskAccountNumber(draft.accountNumber),
    maskAccountDigit(draft.accountDigit),
    draft.accountType,
    holder,
    document,
  ]);
}

/** Mudou o que a folha grava (a senha e o "Usar como preferencial" não contam): libera o "Salvar" da edição. */
export function payoutChanged(draft: PayoutDraft, base: PayoutDraft): boolean {
  return signature(draft) !== signature(base);
}

// --------------------------------------------------------------------------- a lista

/** Os códigos do servidor que dizem que a lista da tela não é a dele (contrato §6.4). */
const STALE_LIST: Readonly<Record<number, string>> = {
  404: "PAYOUT_METHOD_NOT_FOUND",
  409: "PAYOUT_METHOD_DUPLICATE",
  422: "PAYOUT_METHODS_LIMIT",
};

/**
 * Depois deste erro de uma gravação das formas, a lista na memória pode estar velha e a tela relê o cadastro: sem
 * resposta (status 0: tempo esgotado ou queda de rede, e o servidor pode ter gravado), a forma que a central excluiu
 * (404 PAYOUT_METHOD_NOT_FOUND) e a repetida ou o limite que a lista da tela não acusou (409 PAYOUT_METHOD_DUPLICATE,
 * 422 PAYOUT_METHODS_LIMIT: em geral, a forma da tentativa anterior entrou e a resposta se perdeu). Recebe o ApiError
 * (lib/api.ts) pelos campos `status` e `code`, sem importá-lo: a sonda roda sem React Native.
 */
export function payoutListStale(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (status === 0) return true;
  return typeof status === "number" && STALE_LIST[status] !== undefined && STALE_LIST[status] === code;
}

const timeOf = (iso: string) => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
};

/**
 * Excluir a preferencial: a mais nova das outras vira a preferencial (como o servidor faz). null quando a excluída não é
 * a preferencial ou é a única.
 */
export function nextPreferred(methods: readonly PayoutMethod[], removingId: string): PayoutMethod | null {
  const removing = methods.find((m) => m.id === removingId);
  if (!removing?.preferred) return null;
  let next: PayoutMethod | null = null;
  for (const method of methods) {
    if (method.id === removingId) continue;
    if (!next || timeOf(method.created_at) > timeOf(next.created_at)) next = method;
  }
  return next;
}

/** A chave PIX da API antiga (`MyProfile.pix`) como forma de recebimento: a única, preferencial, sem documento. */
export function legacyPayoutMethods(pix: PixInfo | null): PixPayoutMethod[] {
  if (!pix) return [];
  const at = pix.updated_at ?? "";
  return [
    {
      id: "pix",
      kind: "pix",
      preferred: true,
      pix_key_type: pix.key_type,
      pix_key: pix.key,
      holder_name: pix.holder_name ?? "",
      holder_document: null,
      created_at: at,
      changed_at: at,
    },
  ];
}

/** As formas do cadastro; com a API antiga (sem `payout_methods`), a chave PIX de antes, só para ler. */
export function payoutMethodsOf(p: MyProfile): { methods: PayoutMethod[]; editable: boolean } {
  return Array.isArray(p.payout_methods)
    ? { methods: p.payout_methods, editable: true }
    : { methods: legacyPayoutMethods(p.pix ?? null), editable: false };
}

/** Onde a central paga: a preferencial (sempre uma, com a lista não vazia). */
export function preferredPayout(p: MyProfile | null): PayoutMethod | null {
  if (!p) return null;
  const { methods } = payoutMethodsOf(p);
  return methods.find((m) => m.preferred) ?? methods[0] ?? null;
}

// --------------------------------------------------------------------------- textos

/** O tipo da chave no cartão ("Chave PIX · CPF"), sem repetir "Chave" na aleatória. */
const PIX_TYPE_SHORT: Record<PixKeyType, string> = { cpf: "CPF", cnpj: "CNPJ", email: "E-mail", phone: "Celular", random: "Aleatória" };

/** O tipo da chave para o leitor de tela ("chave PIX e-mail"). */
const PIX_TYPE_SPOKEN: Record<PixKeyType, string> = { cpf: "CPF", cnpj: "CNPJ", email: "e-mail", phone: "celular", random: "aleatória" };

/**
 * O cartão da lista: "Chave PIX · CPF" e a chave mascarada, ou o banco e "Conta corrente · Ag. 0001 · ••••5678-9"; e
 * o titular.
 */
export function payoutCard(m: PayoutMethod): { title: string; detail: string; holder: string } {
  if (m.kind === "pix") {
    return { title: `Chave PIX · ${PIX_TYPE_SHORT[m.pix_key_type]}`, detail: maskPixKey(m.pix_key_type, m.pix_key), holder: m.holder_name };
  }
  const type = BANK_ACCOUNT_TYPE[m.account_type] ?? "Conta";
  return { title: m.bank_name, detail: `${type} · Ag. ${m.branch} · ${maskAccount(m.account_number, m.account_digit)}`, holder: m.holder_name };
}

/** Para o leitor de tela, sem números: "Chave PIX CPF, titular Tecnico Alfa" | "Conta corrente, Banco Exemplo, titular …". */
export function payoutSpoken(m: PayoutMethod): string {
  const holder = squash(m.holder_name);
  const what = m.kind === "pix" ? `Chave PIX ${PIX_TYPE_SPOKEN[m.pix_key_type]}` : `${BANK_ACCOUNT_TYPE[m.account_type] ?? "Conta"}, ${m.bank_name}`;
  return holder ? `${what}, titular ${holder}` : what;
}

/** A linha sem forma de recebimento (Configurações). */
export const NO_PAYOUT = "Nenhuma";

/**
 * A linha "Formas de recebimento" de Configurações: a preferencial mascarada ("PIX CPF •••.456.789-••", "Banco Exemplo
 * ••••5678-9"); sem nenhuma, "Nenhuma" em âmbar. `spoken`: o que o leitor de tela fala da linha inteira, sem números.
 */
export function payoutRowSummary(p: MyProfile): { value: string; tone: "muted" | "warning"; spoken: string } {
  const m = preferredPayout(p);
  if (!m) return { value: NO_PAYOUT, tone: "warning", spoken: "Formas de recebimento, nenhuma" };
  const spoken = m.kind === "pix" ? `chave PIX ${PIX_TYPE_SPOKEN[m.pix_key_type]}` : `conta ${m.bank_name}`;
  return { value: payoutMethodText(m), tone: "muted", spoken: `Formas de recebimento, ${spoken}` };
}
