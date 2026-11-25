// O CEP sobre os formulários da central que guardam o endereço em linha: Clientes e Locais ("line": rua, número e
// complemento num campo, mais bairro, cidade e UF) e Configurações › Empresa ("company": o endereço inteiro numa linha).
// Os formulários em partes (ficha pública e Técnicos) usam cepFill de constants.ts, com a mesma regra: campo livre
// (vazio, igual ao aberto ou preenchido pela busca anterior) recebe o valor; o digitado fica e, se difere, a tela mostra
// "CEP de {cepSummary}." + "Usar este endereço".
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

/** Só os números do CEP, até 8 ("01001-0009" → "01001000"). */
export function cepDigits(text: string): string {
  return text.replace(/\D/g, "").slice(0, 8);
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
 * O CEP sobre o endereço em linha (Clientes e Locais). A linha livre recebe "{logradouro}, " (a pessoa completa o número);
 * a que já começa pelo logradouro fica como está; a digitada que não começa por ele fica e marca `differs`. Bairro, cidade
 * e UF seguem cepFill. CEP geral (sem logradouro) não mexe na linha nem no bairro. "Usar este endereço": todos em `auto`.
 */
export function cepLineFill(
  current: AddressSlots,
  opened: AddressSlots,
  auto: ReadonlySet<keyof AddressSlots>,
  found: CepAddress,
): { next: AddressSlots; filled: (keyof AddressSlots)[]; differs: boolean } {
  const next = { ...current };
  const filled: (keyof AddressSlots)[] = [];
  let differs = false;
  const free = (key: keyof AddressSlots) => !current[key].trim() || current[key] === opened[key] || auto.has(key);
  if (found.street && !startsWithStreet(current.street, found.street)) {
    if (free("street")) {
      next.street = `${found.street}, `;
      filled.push("street");
    } else {
      differs = true;
    }
  }
  const values = { district: found.district ?? "", city: found.city, state: found.state };
  for (const key of ["district", "city", "state"] as const) {
    const value = values[key];
    if (!value) continue;
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

/** A linha com este CEP no fim: troca o último CEP escrito nela ou acrescenta ", 01001-000". */
function lineWithCep(line: string, cep: string): string {
  const text = cepText(cep);
  const current = lastCep(line);
  if (current) return current.text === text ? line : `${line.slice(0, current.start)}${text}${line.slice(current.end)}`;
  const base = line.replace(/[\s,;-]+$/, "");
  return base ? `${base}, ${text}` : text;
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
  const withCep = lineWithCep(line, found.cep);
  return { next: withCep === line ? null : { line: withCep, caret: withCep.length }, differs: false };
}
