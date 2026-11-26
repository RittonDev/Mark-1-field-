// O CEP sobre os formulários da central que guardam o endereço em linha: Clientes e Locais ("line": rua, número e
// complemento num campo, mais bairro, cidade e UF) e Configurações › Empresa ("company": o endereço inteiro numa linha).
// Os formulários em partes (ficha pública e Técnicos) usam cepFill de constants.ts, com a mesma regra: campo livre
// (vazio, igual ao aberto ou preenchido pela busca anterior) recebe o valor; o digitado fica e, se difere, a tela mostra
// "CEP de {cepSummary}." + "Usar este endereço". A linha é a exceção: ela leva o número e o complemento, que o CEP não
// traz, então só fica livre vazia ou com o valor da busca anterior (a gravada não é trocada sozinha).
// Sem import de valor: a sonda tests/address.test.mjs roda direto no Node.
import type { CepSlots } from "./constants";
import type { CepAddress } from "./types";

/** Logradouro, bairro, cidade e UF na tela; no modo "line", `street` é a linha "rua, número e complemento". */
export type AddressSlots = CepSlots;
/** "parts": cada parte no seu campo (cepFill de constants); "line": rua, número e complemento num campo só. */
export type CepMode = "parts" | "line";

export const ADDRESS_SLOTS = ["street", "district", "city", "state"] as const;
/** Formulário sem endereço (a ficha pública não tem o "aberto": tudo o que está nela foi digitado). */
export const NO_ADDRESS: AddressSlots = { street: "", district: "", city: "", state: "" };
const NO_SLOTS: ReadonlySet<keyof AddressSlots> = new Set();

/** Só os números do CEP, até 8 ("01001-0009" → "01001000"). */
export function cepDigits(text: string): string {
  return text.replace(/\D/g, "").slice(0, 8);
}

/** CEP começado e incompleto (de 1 a 7 números): a tela mostra CEP_TEXT.invalid e não salva. */
export function cepIncomplete(text: string): boolean {
  const digits = cepDigits(text).length;
  return digits > 0 && digits < 8;
}

/**
 * A linha sem vírgula, ponto e vírgula, hífen ou espaço sobrando no fim ("Praça da Sé, " → "Praça da Sé"): o
 * "{logradouro}, " do CEP salvo sem o número. Clientes e Locais gravam (e buscam no mapa) assim.
 */
export function tidyLine(line: string): string {
  return line.trim().replace(/[\s,;-]+$/, "");
}

/** O número do endereço como se grava (= personal.normalize_address_number): em maiúsculas; "SN" e "S / N" viram "S/N". */
export function normalizeAddressNumber(text: string): string {
  const value = text.replace(/\s+/g, " ").trim().toUpperCase();
  return /^(S\s*\/\s*N|SN)$/.test(value) ? "S/N" : value;
}

/** "01001-000" (a resposta da API já vem assim; aceita também os 8 números). */
function cepText(cep: string): string {
  const digits = cepDigits(cep);
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : cep.trim();
}

/** Comparação sem acento, maiúsculas e espaços extras (a mesma de cepFill). */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** A linha começa pelo logradouro: "Praça da Sé, 100" e "PRACA DA SE 100" com "Praça da Sé" (mas não "Rua 70" com "Rua 7"). */
function startsWithStreet(line: string, street: string): boolean {
  const l = fold(line);
  const s = fold(street);
  return s !== "" && l.startsWith(s) && !/[A-Z0-9]/.test(l.charAt(s.length));
}

/**
 * O CEP sobre o endereço em linha (Clientes e Locais). A linha vazia ou ainda com o "{logradouro}, " da busca anterior
 * (`auto`) recebe "{logradouro}, " (a pessoa completa o número); a que já começa pelo logradouro fica como está; a gravada
 * ou digitada que não começa por ele ("AV EXEMPLO, 1500 - LOJA 12" com "Avenida Exemplo") fica, com o número e o
 * complemento, e marca `differs`. Com a linha nesse conflito, bairro, cidade e UF só recebem o valor vazios ou da busca
 * anterior (a rua de antes não fica com o bairro e a cidade do CEP); fora dele, seguem cepFill (o igual ao aberto também
 * é livre). O que o CEP não traz (CEP geral: logradouro e bairro null) não mexe no digitado nem no gravado: só a linha e o
 * bairro de `stale` (ainda com o valor da busca anterior) se esvaziam e entram em `filled`. "Usar este endereço": todos
 * em `auto` (o `auto` nunca esvazia; `stale` é sempre o da busca anterior).
 */
export function cepLineFill(
  current: AddressSlots,
  opened: AddressSlots,
  auto: ReadonlySet<keyof AddressSlots>,
  found: CepAddress,
  stale: ReadonlySet<keyof AddressSlots> = NO_SLOTS,
): { next: AddressSlots; filled: (keyof AddressSlots)[]; differs: boolean } {
  const next = { ...current };
  const filled: (keyof AddressSlots)[] = [];
  let differs = false;
  const clear = (key: keyof AddressSlots) => {
    if (stale.has(key) && current[key] !== "") {
      next[key] = "";
      filled.push(key);
    }
  };
  // A linha gravada ou digitada que não começa pelo logradouro do CEP: fica como está.
  let lineKept = false;
  if (!found.street) {
    clear("street");
  } else if (!startsWithStreet(current.street, found.street)) {
    if (!current.street.trim() || auto.has("street")) {
      next.street = `${found.street}, `;
      filled.push("street");
    } else {
      differs = true;
      lineKept = true;
    }
  }
  const free = (key: keyof AddressSlots) =>
    !current[key].trim() || auto.has(key) || (!lineKept && current[key] === opened[key]);
  const values = { district: found.district ?? "", city: found.city, state: found.state };
  for (const key of ["district", "city", "state"] as const) {
    const value = values[key];
    if (!value) {
      clear(key);
      continue;
    }
    if (free(key)) {
      if (current[key] !== value) {
        next[key] = value;
        filled.push(key);
      }
    } else if (fold(current[key]) !== fold(value)) {
      differs = true;
    }
  }
  return { next, filled, differs };
}

/**
 * Configurações › Empresa: o endereço do CEP numa linha, "Praça da Sé - Sé - São Paulo - SP, 01001-000"; `caret` no fim
 * do logradouro, onde a pessoa digita ", 100" (0 no CEP geral, que não tem logradouro).
 */
export function companyLineFromCep(cep: CepAddress): { text: string; caret: number } {
  const parts = [cep.street, cep.district, `${cep.city} - ${cep.state}`].filter((part): part is string => !!part);
  return { text: `${parts.join(" - ")}, ${cepText(cep.cep)}`, caret: cep.street ? cep.street.length : 0 };
}

/** O último CEP escrito na linha (8 números, com ou sem hífen; não pega pedaço de um número maior, como um telefone). */
function lastCep(line: string): { start: number; end: number; text: string } | null {
  // Sem lookbehind: o Safari do iPhone mais antigo não entende e a página inteira deixaria de abrir.
  const pattern = /(^|\D)(\d{5})-?(\d{3})(?!\d)/g;
  let found: { start: number; end: number; text: string } | null = null;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    // O separador antes do CEP (match[1]) entra no casamento, mas não no CEP.
    found = { start: match.index + match[1].length, end: match.index + match[0].length, text: `${match[2]}-${match[3]}` };
  }
  return found;
}

/** O último CEP da linha, "01001-000" (com ou sem hífen no texto); "" quando não há. */
export function cepFromLine(line: string): string {
  return lastCep(line)?.text ?? "";
}

/**
 * Configurações › Empresa: a linha com este CEP no fim (troca o último CEP escrito nela ou acrescenta ", 01001-000"). O
 * campo CEP não é gravado à parte: é assim que o CEP digitado chega ao endereço, com a busca ou sem ela.
 */
export function companyLineWithCep(line: string, cep: string): string {
  const text = cepText(cep);
  const current = lastCep(line);
  if (current) return current.text === text ? line : `${line.slice(0, current.start)}${text}${line.slice(current.end)}`;
  const base = tidyLine(line);
  return base ? `${base}, ${text}` : text;
}

/**
 * Configurações › Empresa: a linha que vai ser gravada, com o CEP completo do campo no fim (o achado já foi para lá; sem a
 * busca, como CEP não achado ou busca fora do ar, ele entra ao salvar, em vez de sumir). Passando de `max`, a linha fica
 * como está.
 */
export function companyLineToSave(line: string, cep: string, max: number): string {
  if (cepDigits(cep).length !== 8) return line;
  const withCep = companyLineWithCep(line, cep);
  return withCep.length <= max ? withCep : line;
}

/**
 * Configurações › Empresa: o campo CEP depois de a pessoa editar a linha. Mudou o CEP escrito na linha (ou ele saiu dela):
 * o campo fica com o da linha (vazio, se saiu), para o salvar não trocar de volta o que foi digitado lá. Senão, o campo fica
 * como está: o CEP digitado só no campo vai para a linha ao salvar.
 */
export function companyCepAfterEdit(before: string, after: string, cep: string): string {
  const next = cepFromLine(after);
  return next === cepFromLine(before) ? cep : next;
}

/**
 * O CEP sobre o endereço da empresa (uma linha). Vazia: recebe o endereço do CEP. Com o logradouro (no CEP geral, a
 * cidade): fica, com o CEP no fim (o campo CEP não é gravado à parte, então ele vai para a linha). Sem ele: fica como está
 * e marca `differs` ("CEP de {cepSummary}." + "Usar este endereço", que troca a linha por companyLineFromCep).
 */
export function companyLineFill(line: string, found: CepAddress): { next: { line: string; caret: number } | null; differs: boolean } {
  if (!line.trim()) {
    const { text, caret } = companyLineFromCep(found);
    return { next: { line: text, caret }, differs: false };
  }
  const key = found.street || found.city;
  if (!fold(line).includes(fold(key))) return { next: null, differs: true };
  const withCep = companyLineWithCep(line, found.cep);
  return { next: withCep === line ? null : { line: withCep, caret: withCep.length }, differs: false };
}
