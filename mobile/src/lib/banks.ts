// Bancos da folha da conta (Configurações › Formas de recebimento): a lista que a folha sugere enquanto o técnico digita
// o banco, com o código de compensação (3 números) que vai para o servidor. Fora da lista, ele digita o nome e o código.
// Os mais usados primeiro. Os códigos seguem a lista de participantes do STR (Banco Central): conferir lá antes de
// publicar e quando um banco mudar de nome. Puro (só ./techProfileForm, pelo foldName): entra na sonda
// tests/payout-form.test.mjs.

import { foldName } from "./techProfileForm";

export interface BankOption {
  /** Código de compensação, 3 números ("260"). */
  code: string;
  /** Como aparece na folha e vai para o servidor ("Nubank"). */
  name: string;
  /** Outros nomes que a pessoa digita ("Nu Pagamentos"). */
  aliases?: string[];
}

export const BANKS: readonly BankOption[] = [
  { code: "260", name: "Nubank", aliases: ["Nu Pagamentos"] },
  { code: "104", name: "Caixa", aliases: ["Caixa Econômica Federal", "CEF"] },
  { code: "001", name: "Banco do Brasil", aliases: ["BB"] },
  { code: "341", name: "Itaú", aliases: ["Itaú Unibanco"] },
  { code: "237", name: "Bradesco", aliases: ["Next"] },
  { code: "033", name: "Santander" },
  { code: "077", name: "Inter", aliases: ["Banco Inter"] },
  { code: "336", name: "C6 Bank", aliases: ["C6"] },
  { code: "290", name: "PagBank", aliases: ["PagSeguro"] },
  { code: "323", name: "Mercado Pago" },
  { code: "380", name: "PicPay" },
  { code: "756", name: "Sicoob" },
  { code: "748", name: "Sicredi" },
  { code: "041", name: "Banrisul" },
  { code: "208", name: "BTG Pactual" },
  { code: "212", name: "Banco Original" },
  { code: "422", name: "Safra" },
  { code: "070", name: "BRB" },
  { code: "004", name: "Banco do Nordeste" },
  { code: "003", name: "Banco da Amazônia" },
  { code: "623", name: "Banco Pan" },
  { code: "655", name: "Banco BV", aliases: ["Votorantim"] },
  { code: "121", name: "Agibank" },
  { code: "197", name: "Stone" },
  { code: "403", name: "Cora" },
  { code: "389", name: "Mercantil do Brasil" },
  { code: "136", name: "Unicred" },
  { code: "085", name: "Ailos" },
  { code: "318", name: "BMG" },
];

/** Quantas sugestões a folha mostra. */
export const BANK_SUGGESTIONS = 6;

/** Sem acento, maiúsculas e espaços repetidos ("Itaú  Unibanco" = "itau unibanco"). */
const fold = (text: string) => foldName(text);

/** Para comparar o nome inteiro: sem o "Banco" da frente e sem espaço, ponto e hífen ("Banco Bradesco" = "Bradesco"). */
const compact = (text: string) => fold(text).replace(/^banco\s+/, "").replace(/[\s.-]/g, "");

const namesOf = (bank: BankOption) => [bank.name, ...(bank.aliases ?? [])];

/** O banco da lista com este nome ou apelido (sem diferença de acento, maiúsculas, "Banco" na frente e espaços). */
export function bankByName(text: string): BankOption | null {
  const key = compact(text);
  if (!key) return null;
  return BANKS.find((bank) => namesOf(bank).some((name) => compact(name) === key)) ?? null;
}

/** O banco da lista com este código ("260"; "1" também acha o "001"). */
export function bankByCode(code: string): BankOption | null {
  const digits = code.replace(/\D/g, "");
  if (!digits) return null;
  return BANKS.find((bank) => Number(bank.code) === Number(digits)) ?? null;
}

/**
 * 0: o nome (ou apelido) começa com o texto; 1: uma palavra dele começa com o texto; 2: o texto está no meio; 3: nada.
 * Compara também sem espaço ("pic pay" acha o PicPay).
 */
function rankOf(bank: BankOption, text: string): number {
  const key = compact(text);
  let best = 3;
  for (const name of namesOf(bank)) {
    const folded = fold(name);
    const tight = compact(name);
    if (folded.startsWith(text) || (key && tight.startsWith(key))) return 0;
    if (folded.split(" ").some((word) => word.startsWith(text))) best = Math.min(best, 1);
    else if (folded.includes(text) || (key && tight.includes(key))) best = Math.min(best, 2);
  }
  return best;
}

/**
 * As sugestões da folha: com o campo vazio, os mais usados; só números, pelo código (o igual primeiro, depois os que
 * começam com eles); senão, pelo nome e pelos apelidos (começa com o texto, depois uma palavra, depois no meio), na
 * ordem da lista. No máximo `max`.
 */
export function bankSuggestions(query: string, max = BANK_SUGGESTIONS): BankOption[] {
  const text = fold(query);
  if (!text) return BANKS.slice(0, max);
  const digits = text.replace(/\s/g, "");
  if (/^\d+$/.test(digits)) {
    const same = BANKS.filter((bank) => Number(bank.code) === Number(digits));
    const starting = BANKS.filter((bank) => bank.code.startsWith(digits) && !same.includes(bank));
    return [...same, ...starting].slice(0, max);
  }
  return BANKS.map((bank, index) => ({ bank, index, rank: rankOf(bank, text) }))
    .filter((item) => item.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, max)
    .map((item) => item.bank);
}
