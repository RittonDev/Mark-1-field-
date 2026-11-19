// Regras das telas do cadastro em Configurações (Dados pessoais, Contato, Endereço e Chave PIX) e os resumos das
// linhas do menu. Cada tela salva só a sua parte: o revisor dela diz o que mudou (o corpo do PATCH, sem a senha), o que
// está errado e se pede a senha. As regras e as mensagens são as do servidor (schemas/my_profile.py e core/pix.py),
// que confere de novo. Puro (só ./constants, ./masks, ./pix e tipos): entra nas sondas de mobile/tests.

import { maskPixKey, PIX_KEY_TYPE } from "./constants";
import { maskCep, maskPhone, onlyDigits, phoneDigits, UFS } from "./masks";
import { parsePixKey, pixInputValue } from "./pix";
import type { MyProfile, MyProfileUpdate, PixInfo, PixKeyType } from "./types";

export const MSG = {
  name: "Informe seu nome completo.",
  nameLetters: "Use só letras no nome.",
  phone: "Informe o celular com DDD.",
  email: "Informe um e-mail válido.",
  city: "Informe a cidade.",
  uf: "UF inválida.",
  zip: "CEP com 8 números.",
  pixKey: "Informe a chave PIX.",
  holder: "Informe o nome do titular da conta.",
} as const;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const collapse = (text: string) => text.trim().replace(/\s+/g, " ");

/** O nome como o servidor grava: espaços juntados e o acento digitado separado da letra virando uma letra só (NFC). */
export const nameOf = (text: string) => collapse(text).normalize("NFC");

// O nome vai para os textos do grupo do cliente, o relatório e o portal. A regra é a do servidor (_letters_only em
// schemas/my_profile.py) e só vale para o nome que muda: os antigos ficam como estão.
/** Além das letras: espaço, apóstrofos (' ’ ‘ ´ ` ʼ, o do teclado e os que o celular põe sozinho), hífen e ponto. */
const NAME_MARKS = new Set(Array.from(" '’‘´`ʼ-."));
const LETTER = /\p{L}/u;
/** Endereço colado ("site.com.br", "wa.me"): duas letras, ponto e letra. Iniciais ("J.R.") passam. */
const NAME_ADDRESS = /\p{L}{2}\.\p{L}/u;

/** Sem dígito, "@", "/", ":" nem link: o nome não leva contato para o cliente. */
export function lettersOnly(name: string): boolean {
  for (const ch of name) {
    if (!NAME_MARKS.has(ch) && !LETTER.test(ch)) return false;
  }
  // Letras de outra largura ("ｗｗｗ") contam como as comuns.
  const folded = name.normalize("NFKC").toLowerCase();
  return !folded.includes("www") && !folded.includes("http") && !NAME_ADDRESS.test(folded);
}

// --------------------------------------------------------------------------- base comum das telas

/** O que o revisor de uma tela diz do formulário em relação ao cadastro gravado. */
export interface SectionReview<K extends string> {
  /** Só o que mudou: o corpo do PATCH, sem a senha. */
  body: MyProfileUpdate;
  errors: Partial<Record<K, string>>;
  needsPassword: boolean;
}

/** Uma tela do cadastro: como monta o formulário, como revisa, a ordem dos campos e o aviso de salvo. */
export interface SectionSpec<F extends object, K extends string> {
  fromProfile: (p: MyProfile) => F;
  review: (form: F, base: F) => SectionReview<K>;
  /** Ordem da tela: o primeiro erro vai para o rodapé. */
  order: readonly K[];
  saved: (r: SectionReview<K>) => { title: string; description?: string };
  /** Texto da folha da senha (só Contato e Chave PIX). */
  passwordReason?: string;
}

export const hasChanges = (r: SectionReview<string>) => Object.keys(r.body).length > 0;

/** O primeiro erro na ordem da tela (o do rodapé). */
export function firstError<K extends string>(errors: Partial<Record<K, string>>, order: readonly K[]): string | null {
  return order.map((key) => errors[key]).find(Boolean) ?? null;
}

/**
 * O cadastro mudou no servidor com a tela aberta (foto enviada, releitura): o campo que a pessoa não mexeu acompanha
 * o servidor; o que ela mexeu fica como está.
 */
export function rebase<F extends object>(form: F, before: F, after: F): F {
  const next = { ...form };
  for (const key of Object.keys(form) as (keyof F)[]) {
    if (form[key] === before[key]) next[key] = after[key];
  }
  return next;
}

// --------------------------------------------------------------------------- Dados pessoais

export interface NameForm {
  name: string;
}
export type NameField = "name";

/** Nome com 3 caracteres ou mais (contados como o servidor); o que muda tem de passar em `lettersOnly`. */
export function reviewName(form: NameForm, base: NameForm): SectionReview<NameField> {
  const body: MyProfileUpdate = {};
  const errors: Partial<Record<NameField, string>> = {};
  const name = nameOf(form.name);
  // Em caracteres, como o servidor (um emoji ou letra rara ocupa duas posições no texto do JavaScript).
  if (Array.from(name).length < 3) errors.name = MSG.name;
  if (name !== nameOf(base.name)) {
    body.name = name;
    if (!errors.name && !lettersOnly(name)) errors.name = MSG.nameLetters;
  }
  return { body, errors, needsPassword: false };
}

export const NAME_SECTION: SectionSpec<NameForm, NameField> = {
  fromProfile: (p) => ({ name: p.name }),
  review: reviewName,
  order: ["name"],
  saved: () => ({ title: "Nome atualizado" }),
};

// --------------------------------------------------------------------------- Contato

export interface ContactForm {
  phone: string;
  email: string;
}
export type ContactField = "phone" | "email";

/**
 * Celular com DDD sempre; o e-mail só é conferido quando muda (há logins de teste sem "@") e, mudando, pede a senha.
 * O mesmo celular escrito de outro jeito (com +55) não é mudança.
 */
export function reviewContact(form: ContactForm, base: ContactForm): SectionReview<ContactField> {
  const body: MyProfileUpdate = {};
  const errors: Partial<Record<ContactField, string>> = {};
  const phone = phoneDigits(form.phone);
  if (phone.length < 10) errors.phone = MSG.phone;
  if (phone !== phoneDigits(base.phone)) body.phone = maskPhone(phone);
  const email = form.email.trim().toLowerCase();
  const emailChanged = email !== base.email.trim().toLowerCase();
  if (emailChanged) {
    body.email = email;
    if (!EMAIL.test(email)) errors.email = MSG.email;
  }
  return { body, errors, needsPassword: emailChanged };
}

export const CONTACT_SECTION: SectionSpec<ContactForm, ContactField> = {
  fromProfile: (p) => ({ phone: maskPhone(p.phone ?? ""), email: p.email }),
  review: reviewContact,
  order: ["phone", "email"],
  saved: (r) => ({
    title: "Contato atualizado",
    description: r.body.email !== undefined ? "Use o novo e-mail para entrar no app." : undefined,
  }),
  passwordReason: "Mudar o e-mail pede a senha atual.",
};

// --------------------------------------------------------------------------- Endereço

export interface AddressForm {
  zip: string;
  addressLine: string;
  district: string;
  city: string;
  uf: string;
  coverage: string;
}
export type AddressField = keyof AddressForm;

/** Cidade e UF obrigatórias (só nesta tela); CEP conferido quando muda, e apagado vai como null; vazio vira null. */
export function reviewAddress(form: AddressForm, base: AddressForm): SectionReview<AddressField> {
  const body: MyProfileUpdate = {};
  const errors: Partial<Record<AddressField, string>> = {};

  const zip = onlyDigits(form.zip);
  if (zip !== onlyDigits(base.zip)) {
    body.address_zip = zip ? maskCep(zip) : null;
    if (zip && zip.length !== 8) errors.zip = MSG.zip;
  }

  const line = form.addressLine.trim();
  if (line !== base.addressLine.trim()) body.address_line = line || null;
  const district = form.district.trim();
  if (district !== base.district.trim()) body.address_district = district || null;

  const city = collapse(form.city);
  if (city.length < 2) errors.city = MSG.city;
  if (city !== collapse(base.city)) body.home_city = city;

  const uf = form.uf.trim().toUpperCase();
  if (!UFS.includes(uf)) errors.uf = MSG.uf;
  if (uf !== base.uf.trim().toUpperCase()) body.home_state = uf;

  const coverage = form.coverage.trim();
  if (coverage !== base.coverage.trim()) body.coverage_area = coverage || null;

  return { body, errors, needsPassword: false };
}

export const ADDRESS_SECTION: SectionSpec<AddressForm, AddressField> = {
  fromProfile: (p) => ({
    zip: maskCep(p.address_zip ?? ""),
    addressLine: p.address_line ?? "",
    district: p.address_district ?? "",
    city: p.home_city ?? "",
    uf: p.home_state ?? "",
    coverage: p.coverage_area ?? "",
  }),
  review: reviewAddress,
  order: ["zip", "addressLine", "district", "city", "uf", "coverage"],
  saved: () => ({ title: "Endereço atualizado" }),
};

// --------------------------------------------------------------------------- Chave PIX

export interface PixForm {
  pixType: PixKeyType | null;
  /** Como está no campo (com a máscara do tipo). */
  pixKey: string;
  pixHolder: string;
  /** "Remover chave PIX" tocado: a chave sai quando salvar. */
  pixRemoved: boolean;
}
export type PixField = "pixKey" | "pixHolder";

/** A chave como o servidor grava; digitada pela metade, o próprio texto (para comparar com a gravada). */
function keyOf(type: PixKeyType, text: string): string {
  const parsed = parsePixKey(type, text);
  return "key" in parsed ? parsed.key : text.trim();
}

/**
 * Cadastrar, trocar (tipo, chave ou titular) e remover pedem a senha. Escolher o tipo sem digitar a chave não é
 * mudança; a chave é validada pelo tipo (lib/pix.ts) e o titular tem 3 caracteres ou mais.
 */
export function reviewPix(form: PixForm, base: PixForm): SectionReview<PixField> {
  const body: MyProfileUpdate = {};
  const errors: Partial<Record<PixField, string>> = {};
  if (form.pixRemoved) {
    if (base.pixType) body.pix = null;
  } else if (form.pixType) {
    const keyText = form.pixKey.trim();
    const parsed = keyText ? parsePixKey(form.pixType, keyText) : null;
    const key = parsed && "key" in parsed ? parsed.key : keyText;
    const holder = collapse(form.pixHolder);
    const changed = base.pixType
      ? form.pixType !== base.pixType || key !== keyOf(base.pixType, base.pixKey) || holder !== collapse(base.pixHolder)
      : keyText !== "";
    if (changed) {
      body.pix = { key_type: form.pixType, key, holder_name: holder };
      if (!keyText) errors.pixKey = MSG.pixKey;
      else if (parsed && "error" in parsed) errors.pixKey = parsed.error;
      if (holder.length < 3) errors.pixHolder = MSG.holder;
    }
  }
  return { body, errors, needsPassword: "pix" in body };
}

export const PIX_SECTION: SectionSpec<PixForm, PixField> = {
  fromProfile: (p) => ({
    pixType: p.pix?.key_type ?? null,
    pixKey: p.pix ? pixInputValue(p.pix.key_type, p.pix.key) : "",
    pixHolder: p.pix?.holder_name ?? "",
    pixRemoved: false,
  }),
  review: reviewPix,
  order: ["pixKey", "pixHolder"],
  saved: (r) =>
    r.body.pix === null
      ? { title: "Chave PIX removida" }
      : { title: "Chave PIX atualizada", description: "A central foi avisada da nova chave PIX." },
  passwordReason: "Mudar a chave PIX pede a senha atual.",
};

// --------------------------------------------------------------------------- resumos das linhas de Configurações

export const NO_PHONE = "Sem celular";
export const NO_ADDRESS = "Não informado";
export const NO_PIX = "Não cadastrada";

/** "3 ferramentas", "1 ferramenta"; zero: "Nenhuma" (aptidão, formação e ferramenta são femininas). */
export function countLabel(n: number, one: string, many: string): string {
  if (n <= 0) return "Nenhuma";
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** O celular como a pessoa lê, "(11) 98888-7777"; null sem celular (a linha mostra NO_PHONE). */
export function contactSummary(phone: string | null | undefined): string | null {
  return phone && onlyDigits(phone) ? maskPhone(phone) : null;
}

/** "Cidade Exemplo/SP"; só a cidade, ela; sem cidade, NO_ADDRESS. */
export function addressSummary(city: string | null | undefined, uf: string | null | undefined): string {
  const name = collapse(city ?? "");
  if (!name) return NO_ADDRESS;
  const state = (uf ?? "").trim().toUpperCase();
  return state ? `${name}/${state}` : name;
}

/** O tipo e a chave mascarada ("CPF •••.456.789-••", "Chave aleatória …a1b2"); sem chave, NO_PIX. */
export function pixSummary(pix: Pick<PixInfo, "key_type" | "key"> | null | undefined): string {
  return pix ? `${PIX_KEY_TYPE[pix.key_type]} ${maskPixKey(pix.key_type, pix.key)}` : NO_PIX;
}
