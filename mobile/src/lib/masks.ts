// Máscaras e validações de documentos e contatos (sem import nativo). Portadas de frontend/src/lib/onboarding.ts,
// com as mesmas regras da API (backend/app/core/documents.py e schemas/onboarding.py).

/** As 27 UFs (a API recusa outra sigla). */
export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB",
  "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

export const onlyDigits = (value: string) => value.replace(/\D/g, "");

export function isValidCpf(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(d[9]) && digit(10) === Number(d[10]);
}

const CNPJ_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * CNPJ, inclusive o alfanumérico da Receita (as 12 primeiras posições podem ter letras; os 2 dígitos
 * verificadores são números). Mesmo cálculo de backend/app/core/documents.py: valor ASCII - 48.
 */
export function isValidCnpj(value: string): boolean {
  const d = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(d) || new Set(d).size === 1) return false;
  const digit = (chars: string, weights: number[]) => {
    const total = weights.reduce((sum, w, i) => sum + (chars.charCodeAt(i) - 48) * w, 0);
    const rest = total % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const base = d.slice(0, 12);
  const first = digit(base, CNPJ_WEIGHTS);
  const second = digit(`${base}${first}`, [6, ...CNPJ_WEIGHTS]);
  return d.slice(12) === `${first}${second}`;
}

/** 000.000.000-00 */
export function maskCpf(value: string): string {
  const d = onlyDigits(value).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
}

/** 00.000.000/0000-00 (aceita letras nas 12 primeiras posições, como o CNPJ alfanumérico). */
export function maskCnpj(value: string): string {
  const d = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase().slice(0, 14);
  const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 8), d.slice(8, 12), d.slice(12)];
  let out = parts[0];
  if (parts[1]) out += `.${parts[1]}`;
  if (parts[2]) out += `.${parts[2]}`;
  if (parts[3]) out += `/${parts[3]}`;
  if (parts[4]) out += `-${parts[4]}`;
  return out;
}

/** 00000-000 */
export function maskCep(value: string): string {
  const d = onlyDigits(value).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

/**
 * DDD e número (o código do país sai): 12 ou 13 dígitos começando com 55 ficam com os 11 (ou 10) do telefone.
 * É também a comparação do servidor: o mesmo número escrito de outro jeito não é mudança.
 */
export function phoneDigits(value: string | null | undefined): string {
  const d = onlyDigits(value ?? "");
  return (d.length === 12 || d.length === 13) && d.startsWith("55") ? d.slice(2) : d;
}

/** (00) 00000-0000, ou (00) 0000-0000 para fixo. Número colado com +55 perde o código do país. */
export function maskPhone(value: string): string {
  let d = onlyDigits(value);
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
