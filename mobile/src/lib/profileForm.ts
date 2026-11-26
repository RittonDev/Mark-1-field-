// Regras das telas do cadastro em Configurações (Dados pessoais, Endereço, Contato, Mini biografia e Dados
// empresariais), do veículo (Transporte) e os resumos das linhas do menu. Cada tela salva só a sua parte: o revisor dela
// diz o que mudou (o corpo do PATCH, sem a senha), o que está errado e se pede a senha. Só o que mudou é conferido: um
// dado antigo fora da regra não trava outra mudança. As regras e as mensagens são as do servidor (schemas/my_profile.py e
// schemas/personal.py, sem ponto final), que confere de novo; aqui, com ponto. Puro (só ./constants, ./masks e tipos):
// entra nas sondas de mobile/tests.

import {
  ageAt,
  BIRTH_AGE,
  CEP_TEXT,
  cepFill,
  formatPlate,
  isSendableEmail,
  isValidPlate,
  isValidRg,
  normalizeBio,
  normalizePlate,
  normalizeRg,
  PROFILE_LIMITS,
  sameStreet,
  splitIssuer,
  type CepSlots,
} from "./constants";
import { isValidCnpj, isValidCpf, maskCep, maskCnpj, maskCpf, maskPhone, onlyDigits, phoneDigits, UFS } from "./masks";
import type { CepAddress, MyProfile, MyProfileUpdate } from "./types";

export const MSG = {
  name: "Informe seu nome completo.",
  nameLetters: "Use só letras no nome.",
  cpf: "CPF inválido.",
  rgNumber: "Informe o número do RG.",
  rgShort: "Confira o número do RG.",
  rgIssuer: "Informe o órgão emissor.",
  rgIssuerShort: "Confira o órgão emissor.",
  rgState: "Informe a UF do RG.",
  birthMinor: "O cadastro é para maiores de 18 anos: confira a data de nascimento.",
  birth: "Confira a data de nascimento.",
  phone: "Informe o celular com DDD.",
  phone2: "Informe o telefone com DDD.",
  phone2Same: "Igual ao celular.",
  email: "Informe um e-mail válido.",
  emailUndeliverable: "Este e-mail não recebe mensagens.",
  zip: CEP_TEXT.invalid,
  city: "Informe a cidade.",
  uf: "UF inválida.",
  bioLong: `No máximo ${PROFILE_LIMITS.bio} caracteres.`,
  cnpj: "CNPJ inválido.",
  cnpjRequired: "Informe o CNPJ.",
  vehicleModel: "Confira o modelo.",
  plate: "Placa inválida: confira as letras e os números.",
} as const;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const collapse = (text: string) => text.trim().replace(/\s+/g, " ");

/** O nome como o servidor grava: espaços juntados e o acento digitado separado da letra virando uma letra só (NFC). */
export const nameOf = (text: string) => collapse(text).normalize("NFC");

/** Caracteres como o servidor conta (um emoji ou letra rara ocupa duas posições no texto do JavaScript). */
const charCount = (text: string) => Array.from(text).length;

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

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Hoje no relógio do aparelho, "AAAA-MM-DD" (o nascimento e os dias de indisponibilidade são datas sem hora). */
export const todayIso = (now: Date = new Date()) => `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

// --------------------------------------------------------------------------- base comum das telas

/** O que o revisor de uma tela diz do formulário em relação ao cadastro gravado. */
export interface SectionReview<K extends string> {
  /** Só o que mudou: o corpo do PATCH, sem a senha. */
  body: MyProfileUpdate;
  errors: Partial<Record<K, string>>;
  needsPassword: boolean;
}

/** Uma tela do cadastro: como monta o formulário, como revisa, a ordem dos campos e os avisos. */
export interface SectionSpec<F extends object, K extends string> {
  fromProfile: (p: MyProfile) => F;
  review: (form: F, base: F) => SectionReview<K>;
  /** Ordem da tela: o primeiro erro vai para o rodapé. */
  order: readonly K[];
  /** Aviso de salvo; `base` é o formulário gravado de quando tocou em "Salvar" (o e-mail novo cita o de hoje). */
  saved: (r: SectionReview<K>, base: F) => { title: string; description?: string };
  /** Pergunta antes de enviar ("Confira o CPF"); null envia direto. */
  confirm?: (r: SectionReview<K>, base: F) => { title: string; message: string; confirmText: string } | null;
  /** Texto da folha da senha (Contato e Dados empresariais). */
  passwordReason?: string;
}

export const hasChanges = (r: SectionReview<string>) => Object.keys(r.body).length > 0;

/** O primeiro erro na ordem da tela (o do rodapé). */
export function firstError<K extends string>(errors: Partial<Record<K, string>>, order: readonly K[]): string | null {
  return order.map((key) => errors[key]).find(Boolean) ?? null;
}

/**
 * O cadastro mudou no servidor com a tela aberta (foto enviada, link pedido, releitura): o campo que a pessoa não mexeu
 * acompanha o servidor; o que ela mexeu fica como está.
 */
export function rebase<F extends object>(form: F, before: F, after: F): F {
  const next = { ...form };
  for (const key of Object.keys(form) as (keyof F)[]) {
    if (form[key] === before[key]) next[key] = after[key];
  }
  return next;
}

// --------------------------------------------------------------------------- Dados pessoais

/** Nome com 3 caracteres ou mais (contados como o servidor); o que muda tem de passar em `lettersOnly`. */
export function reviewName(form: { name: string }, base: { name: string }): SectionReview<"name"> {
  const body: MyProfileUpdate = {};
  const errors: Partial<Record<"name", string>> = {};
  const name = nameOf(form.name);
  if (charCount(name) < 3) errors.name = MSG.name;
  if (name !== nameOf(base.name)) {
    body.name = name;
    if (!errors.name && !lettersOnly(name)) errors.name = MSG.nameLetters;
  }
  return { body, errors, needsPassword: false };
}

export interface PersonalForm {
  name: string;
  /** Com a máscara ("123.456.789-09"). */
  cpf: string;
  /** O CPF já está gravado: só leitura (quem corrige é a central). */
  cpfLocked: boolean;
  rgNumber: string;
  rgIssuer: string;
  /** UF do órgão emissor. */
  rgState: string;
  /** "AAAA-MM-DD"; null: não informado. */
  birthDate: string | null;
}
export type PersonalField = "name" | "cpf" | "rgNumber" | "rgIssuer" | "rgState" | "birthDate";

/**
 * O órgão emissor e a UF do RG como ficam ao salvar (o servidor separa igual): "SSP/SP" ou "SSP-SP" viram órgão "SSP" e
 * UF "SP" (splitIssuer). A UF do fim do órgão só vale com o campo da UF vazio; com outra UF lá, fica a do campo e o fim
 * sai. Sem UF válida no fim, "/" e "-" viram espaço ("SSP XX").
 */
export function issuerParts(issuer: string, state: string): { issuer: string; state: string } {
  const split = splitIssuer(issuer);
  return { issuer: split.issuer, state: state.trim().toUpperCase() || split.state || "" };
}

/** O RG como o servidor grava (normalizeRg e issuerParts, sem os espaços das pontas). */
function rgOf(form: Pick<PersonalForm, "rgNumber" | "rgIssuer" | "rgState">) {
  return { number: normalizeRg(form.rgNumber).trim(), ...issuerParts(form.rgIssuer, form.rgState) };
}

/**
 * Nome (reviewName); CPF só enquanto não está gravado (11 números válidos; depois, só a central muda); RG com os três
 * juntos (número, órgão emissor de 2 a 20 letras e UF, que pode vir no fim do órgão: issuerParts; os três vazios
 * limpam); nascimento de 18 a 90 anos completos em `today`.
 */
export function reviewPersonal(form: PersonalForm, base: PersonalForm, today: string = todayIso()): SectionReview<PersonalField> {
  const { body, errors: nameErrors } = reviewName(form, base);
  const errors: Partial<Record<PersonalField, string>> = { ...nameErrors };

  // O CPF gravado (o servidor diz) não vai mais pelo app, nem se a central o gravou com a tela aberta.
  if (!base.cpfLocked) {
    const cpf = onlyDigits(form.cpf);
    if (cpf && cpf !== onlyDigits(base.cpf)) {
      body.cpf = cpf;
      if (!isValidCpf(cpf)) errors.cpf = MSG.cpf;
    }
  }

  const rg = rgOf(form);
  const savedRg = rgOf(base);
  if (rg.number !== savedRg.number || rg.issuer !== savedRg.issuer || rg.state !== savedRg.state) {
    body.rg_number = rg.number || null;
    body.rg_issuer = rg.issuer || null;
    body.rg_state = rg.state || null;
    if (rg.number || rg.issuer || rg.state) {
      if (!rg.number) errors.rgNumber = MSG.rgNumber;
      else if (!isValidRg(rg.number)) errors.rgNumber = MSG.rgShort;
      if (!rg.issuer) errors.rgIssuer = MSG.rgIssuer;
      else if (rg.issuer.length < 2 || rg.issuer.length > PROFILE_LIMITS.rgIssuer) errors.rgIssuer = MSG.rgIssuerShort;
      if (!rg.state) errors.rgState = MSG.rgState;
      else if (!UFS.includes(rg.state)) errors.rgState = MSG.uf;
    }
  }

  const birth = form.birthDate || null;
  if (birth !== (base.birthDate || null)) {
    body.birth_date = birth;
    if (birth) {
      const age = ageAt(birth, today);
      if (age === null || age > BIRTH_AGE.max) errors.birthDate = MSG.birth;
      else if (age < BIRTH_AGE.min) errors.birthDate = MSG.birthMinor;
    }
  }
  return { body, errors, needsPassword: false };
}

export const PERSONAL_SECTION: SectionSpec<PersonalForm, PersonalField> = {
  fromProfile: (p) => ({
    name: p.name,
    cpf: maskCpf(p.cpf ?? ""),
    cpfLocked: Boolean(p.cpf),
    rgNumber: p.rg_number ?? "",
    rgIssuer: p.rg_issuer ?? "",
    rgState: p.rg_state ?? "",
    birthDate: p.birth_date ? p.birth_date.slice(0, 10) : null,
  }),
  review: reviewPersonal,
  order: ["name", "cpf", "rgNumber", "rgIssuer", "rgState", "birthDate"],
  saved: () => ({ title: "Dados pessoais atualizados" }),
  // O CPF vai uma vez: antes de gravar, a pessoa confere os números.
  confirm: (r) =>
    r.body.cpf
      ? { title: "Confira o CPF", message: `${maskCpf(r.body.cpf)}. Depois de salvo, só a central muda.`, confirmText: "Salvar" }
      : null,
};

/** "AAAA-MM-DD" `years` anos antes de `iso` (29/02 vira 28/02 no ano que não é bissexto). */
function yearsBefore(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const year = y - years;
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${year}-${pad2(m)}-${pad2(Math.min(d, lastDay))}`;
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

/**
 * O seletor do nascimento (`today` "AAAA-MM-DD"): do dia seguinte a hoje − 91 anos (ainda 90 completos) a hoje − 18
 * anos; vazio, abre em hoje − 30 anos.
 */
export function birthLimits(today: string): { min: string; max: string; initial: string } {
  return {
    min: nextDay(yearsBefore(today, BIRTH_AGE.max + 1)),
    max: yearsBefore(today, BIRTH_AGE.min),
    initial: yearsBefore(today, 30),
  };
}

// --------------------------------------------------------------------------- Endereço e CEP

export interface AddressForm {
  zip: string;
  /** O logradouro (endereço antigo que não deu para separar: a linha inteira). */
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  uf: string;
  coverage: string;
}
export type AddressField = keyof AddressForm;

/** O número sem número, depois das maiúsculas: "SN", "S/N", "S / N". */
const NO_NUMBER = /^(S\s*\/\s*N|SN)$/;

/** O número do endereço como o servidor grava (personal.address_number): espaços juntados, em maiúsculas, "SN" → "S/N". */
export function addressNumberOf(text: string): string {
  const number = collapse(text).normalize("NFC").toUpperCase();
  return NO_NUMBER.test(number) ? "S/N" : number;
}

/**
 * Cidade e UF obrigatórias (só nesta tela); CEP conferido quando muda, e apagado vai como null. Logradouro, número e
 * complemento vão juntos quando um muda (o servidor limpa número e complemento quando o logradouro chega sozinho, como no
 * app antigo); o número vai como o servidor grava (addressNumberOf: "s/n" e "S/N" não são mudança). Vazio vira null.
 */
export function reviewAddress(form: AddressForm, base: AddressForm): SectionReview<AddressField> {
  const body: MyProfileUpdate = {};
  const errors: Partial<Record<AddressField, string>> = {};

  const zip = onlyDigits(form.zip);
  if (zip !== onlyDigits(base.zip)) {
    body.address_zip = zip ? maskCep(zip) : null;
    if (zip && zip.length !== 8) errors.zip = MSG.zip;
  }

  const street = form.street.trim();
  const number = addressNumberOf(form.number);
  const complement = collapse(form.complement);
  if (street !== base.street.trim() || number !== addressNumberOf(base.number) || complement !== collapse(base.complement)) {
    body.address_line = street || null;
    body.address_number = number || null;
    body.address_complement = complement || null;
  }

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
    street: p.address_line ?? "",
    number: p.address_number ?? "",
    complement: p.address_complement ?? "",
    district: p.address_district ?? "",
    city: p.home_city ?? "",
    uf: p.home_state ?? "",
    coverage: p.coverage_area ?? "",
  }),
  review: reviewAddress,
  order: ["zip", "street", "number", "complement", "district", "city", "uf", "coverage"],
  saved: () => ({ title: "Endereço atualizado" }),
};

/** Os campos que o CEP preenche, nos nomes de cepFill (constants). */
export function addressSlots(form: Pick<AddressForm, "street" | "district" | "city" | "uf">): CepSlots {
  return { street: form.street, district: form.district, city: form.city, state: form.uf };
}

const EVERY_SLOT: ReadonlySet<keyof CepSlots> = new Set(["street", "district", "city", "state"]);
const NO_SLOT: ReadonlySet<keyof CepSlots> = new Set();
const EMPTY_SLOTS: CepSlots = { street: "", district: "", city: "", state: "" };

export interface CepPatch {
  /** O que muda no formulário (vazio: nada a preencher). */
  patch: Partial<AddressForm>;
  /** Os campos que a busca preencheu, com o valor posto: continuam livres enquanto ficarem assim (`auto` de cepFill). */
  filled: Partial<CepSlots>;
  /** Para onde vai o foco: o Número; CEP geral (sem logradouro), o Logradouro. */
  focus: "number" | "street";
}

/**
 * O CEP achado sobre o Endereço, com a regra dos 6 lugares (cepFill): campo livre (vazio, igual ao gravado ou preenchido
 * pela busca anterior, `auto`) recebe o valor; o digitado fica. `use`: "Usar este endereço" (todos contam como livres).
 * O que o CEP não traz (CEP geral: logradouro e bairro) esvazia só o campo que ainda tem o valor da busca anterior
 * (`auto`, o `stale` de cepFill, também no `use`); o digitado e o gravado ficam. Logradouro trocado de fato por outro
 * (sameStreet: outra grafia não conta): Número e Complemento que a pessoa não mexeu (iguais ao gravado) eram do endereço
 * de antes e ficam vazios. Logradouro esvaziado por um CEP geral não conta: a pessoa digita a rua e o número fica.
 */
export function cepPatch(
  form: AddressForm,
  base: AddressForm,
  auto: ReadonlySet<keyof CepSlots>,
  found: CepAddress,
  use = false,
): CepPatch {
  const result = cepFill(addressSlots(form), addressSlots(base), use ? EVERY_SLOT : auto, found, auto);
  const patch: Partial<AddressForm> = {};
  const filled: Partial<CepSlots> = {};
  for (const key of result.filled) {
    filled[key] = result.next[key];
    if (key === "state") patch.uf = result.next.state;
    else patch[key] = result.next[key];
  }
  if (result.filled.includes("street") && result.next.street.trim() && !sameStreet(result.next.street, form.street)) {
    if (form.number && form.number === base.number) patch.number = "";
    if (form.complement && form.complement === base.complement) patch.complement = "";
  }
  return { patch, filled, focus: found.street ? "number" : "street" };
}

/**
 * Algum campo preenchido difere do CEP (o que o CEP não traz não conta, nem acento e maiúsculas): a tela mostra "CEP de
 * {cepSummary}." e "Usar este endereço".
 */
export function cepDiffers(form: AddressForm, found: CepAddress): boolean {
  return cepFill(addressSlots(form), EMPTY_SLOTS, NO_SLOT, found).differs;
}

/**
 * A busca que não achou: só o 404 com o código CEP_NOT_FOUND é "não existe". O resto (a API antiga sem a rota dá 404
 * sem código, 422, 429, 503, sem rede) é "unavailable": busca indisponível, o técnico preenche à mão.
 */
export function cepMiss(status: number, code: string | null): "not_found" | "unavailable" {
  return status === 404 && code === "CEP_NOT_FOUND" ? "not_found" : "unavailable";
}

// --------------------------------------------------------------------------- Contato

export interface ContactForm {
  phone: string;
  /** Telefone secundário (com a máscara; "" sem ele). */
  phone2: string;
  /** O e-mail de login como está no campo. */
  email: string;
  /** Troca de e-mail esperando o link ("" sem troca): digitar o mesmo não é mudança (não reenvia). */
  emailPending: string;
  /** Envio de e-mail ligado no servidor; desligado, o e-mail fica só leitura (a troca é pela central). */
  mailEnabled: boolean;
}
export type ContactField = "phone" | "phone2" | "email";

/**
 * Celular com DDD sempre; telefone secundário opcional (10 ou 11 números, diferente do celular). O mesmo número escrito
 * de outro jeito (com +55) não é mudança. O e-mail só é conferido quando muda (há logins de teste sem "@"): diferente do
 * login e da troca pendente, vira a troca (o login continua até o link), pede a senha e precisa receber mensagens. Com o
 * envio desligado, o e-mail não muda pelo app.
 */
export function reviewContact(form: ContactForm, base: ContactForm): SectionReview<ContactField> {
  const body: MyProfileUpdate = {};
  const errors: Partial<Record<ContactField, string>> = {};
  const phone = phoneDigits(form.phone);
  if (phone.length < 10) errors.phone = MSG.phone;
  if (phone !== phoneDigits(base.phone)) body.phone = maskPhone(phone);

  const phone2 = phoneDigits(form.phone2);
  if (phone2 !== phoneDigits(base.phone2)) {
    body.phone_secondary = phone2 ? maskPhone(phone2) : null;
    if (phone2 && (phone2.length < 10 || phone2.length > 11)) errors.phone2 = MSG.phone2;
    else if (phone2 && phone2 === phone) errors.phone2 = MSG.phone2Same;
  }

  const email = form.email.trim().toLowerCase();
  const emailChanged =
    base.mailEnabled && email !== base.email.trim().toLowerCase() && email !== base.emailPending.trim().toLowerCase();
  if (emailChanged) {
    body.email = email;
    if (!EMAIL.test(email)) errors.email = MSG.email;
    else if (!isSendableEmail(email)) errors.email = MSG.emailUndeliverable;
  }
  return { body, errors, needsPassword: emailChanged };
}

export const CONTACT_SECTION: SectionSpec<ContactForm, ContactField> = {
  fromProfile: (p) => ({
    phone: maskPhone(p.phone ?? ""),
    phone2: maskPhone(p.phone_secondary ?? ""),
    email: p.email,
    emailPending: p.email_pending ?? "",
    mailEnabled: p.mail_enabled === true,
  }),
  review: reviewContact,
  order: ["phone", "phone2", "email"],
  saved: (r, base) =>
    r.body.email !== undefined
      ? { title: "Confirme o novo e-mail", description: `Abra o link enviado para ${r.body.email}. Até lá, entre com ${base.email}.` }
      : { title: "Contato atualizado" },
  passwordReason: "Mudar o e-mail pede a senha atual.",
};

/** O que o Contato diz do e-mail de login (abaixo do campo) e o que dá para fazer. */
export type EmailStatus =
  /** Troca pedida: o login continua até o link. `resend`: o envio está ligado (com ele desligado, só dá para cancelar). */
  | { kind: "pending"; email: string; sentAt: string | null; resend: boolean }
  /** Envio de e-mail desligado no servidor: o campo fica só leitura, sem estado de validação. */
  | { kind: "disabled" }
  /** Login de teste, sem "@". */
  | { kind: "none" }
  /** Endereço que não recebe mensagens (os importados, ".invalid"). */
  | { kind: "undeliverable" }
  | { kind: "verified" }
  | { kind: "unverified"; sentAt: string | null };

type EmailFacts = Pick<MyProfile, "email" | "email_pending" | "email_verified_at" | "email_link_sent_at" | "mail_enabled">;

export function emailStatus(p: EmailFacts): EmailStatus {
  const enabled = p.mail_enabled === true;
  if (p.email_pending) return { kind: "pending", email: p.email_pending, sentAt: p.email_link_sent_at ?? null, resend: enabled };
  if (!enabled) return { kind: "disabled" };
  if (!p.email.includes("@")) return { kind: "none" };
  if (!isSendableEmail(p.email)) return { kind: "undeliverable" };
  if (p.email_verified_at) return { kind: "verified" };
  return { kind: "unverified", sentAt: p.email_link_sent_at ?? null };
}

/** "às 14:30"; outro dia, "em 18/11 às 14:30"; outro ano, "em 18/11/2025 às 14:30" (no fuso do aparelho). */
function sentWhen(iso: string, now: Date): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = `às ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) return time;
  const year = at.getFullYear() === now.getFullYear() ? "" : `/${at.getFullYear()}`;
  return `em ${pad2(at.getDate())}/${pad2(at.getMonth() + 1)}${year} ${time}`;
}

/** "Link enviado às 14:30" | "Link enviado em 18/11 às 14:30". */
export function linkSentText(iso: string, now: Date = new Date()): string {
  const when = sentWhen(iso, now);
  return when ? `Link enviado ${when}` : "Link enviado";
}

/** O aviso depois de "Cancelar troca" (o tom do toast: "success" ou "info"). */
export interface CancelChangeNotice {
  title: string;
  description?: string;
  tone: "success" | "info";
}

/**
 * O aviso de "Cancelar troca" pelo cadastro que o DELETE devolveu (`after`) e o da tela (`before`). A tela pode estar
 * velha: com o link já aberto no navegador, o pendente virou o login e não havia o que cancelar ("Seu e-mail já foi
 * validado"). Login trocado para outro endereço (pela central): a troca saiu e ele entra com o novo.
 */
export function cancelChangeNotice(
  before: Pick<MyProfile, "email" | "email_pending">,
  after: Pick<MyProfile, "email">,
): CancelChangeNotice {
  const login = after.email.trim().toLowerCase();
  if (login === before.email.trim().toLowerCase()) return { title: "Troca de e-mail cancelada", tone: "success" };
  const description = `Agora você entra com ${after.email}.`;
  if (login === (before.email_pending ?? "").trim().toLowerCase()) return { title: "Seu e-mail já foi validado", description, tone: "info" };
  return { title: "Troca de e-mail cancelada", description, tone: "info" };
}

/** A dica do campo E-mail: o estado do login ou, digitando um e-mail novo (`editing`), o que acontece ao salvar. */
export function emailHint(status: EmailStatus, editing: boolean, now: Date = new Date()): string {
  if (editing) return "Você recebe um link para validar.";
  switch (status.kind) {
    case "pending":
      return "Seu login até validar o novo.";
    case "disabled":
      return "Para trocar, fale com a central pelo WhatsApp.";
    case "none":
      return "É o seu login no app.";
    case "undeliverable":
      return MSG.emailUndeliverable;
    case "verified":
      return "Validado";
    case "unverified": {
      const when = status.sentAt ? sentWhen(status.sentAt, now) : null;
      return when ? `Pendente de validação · link enviado ${when}` : "Pendente de validação";
    }
  }
}

// --------------------------------------------------------------------------- Mini biografia

export interface BioForm {
  bio: string;
}

/**
 * Texto livre e opcional, com os parágrafos, gravado como o servidor (normalizeBio: sem espaços no fim das linhas, no
 * máximo uma linha em branco entre os parágrafos, sem quebras nas pontas); até 500 caracteres, contados depois disso;
 * vazio limpa.
 */
export function reviewBio(form: BioForm, base: BioForm): SectionReview<"bio"> {
  const body: MyProfileUpdate = {};
  const errors: Partial<Record<"bio", string>> = {};
  const bio = normalizeBio(form.bio);
  if (bio !== normalizeBio(base.bio)) {
    body.bio = bio || null;
    if (charCount(bio) > PROFILE_LIMITS.bio) errors.bio = MSG.bioLong;
  }
  return { body, errors, needsPassword: false };
}

export const BIO_SECTION: SectionSpec<BioForm, "bio"> = {
  fromProfile: (p) => ({ bio: p.bio ?? "" }),
  review: reviewBio,
  order: ["bio"],
  saved: () => ({ title: "Mini biografia atualizada" }),
};

/** O contador do campo: "120/500", contado como o limite (depois de normalizeBio). */
export const bioCount = (text: string) => `${charCount(normalizeBio(text))}/${PROFILE_LIMITS.bio}`;

// --------------------------------------------------------------------------- Dados empresariais

export interface CompanyForm {
  /** Com a máscara (aceita o CNPJ alfanumérico). */
  cnpj: string;
  /** Razão social. */
  name: string;
  /** Nome fantasia. */
  tradeName: string;
}
export type CompanyField = keyof CompanyForm;

const cnpjChars = (value: string) => value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

/**
 * CNPJ, razão social e nome fantasia vão juntos quando um muda e pedem a senha (conta invadida não troca a empresa que
 * recebe). Os três são opcionais; razão social ou nome fantasia pedem o CNPJ. Os três vazios limpam.
 */
export function reviewCompany(form: CompanyForm, base: CompanyForm): SectionReview<CompanyField> {
  const body: MyProfileUpdate = {};
  const errors: Partial<Record<CompanyField, string>> = {};
  const cnpj = cnpjChars(form.cnpj);
  const name = collapse(form.name);
  const tradeName = collapse(form.tradeName);
  const changed = cnpj !== cnpjChars(base.cnpj) || name !== collapse(base.name) || tradeName !== collapse(base.tradeName);
  if (changed) {
    body.company_document = cnpj || null;
    body.company_name = name || null;
    body.company_trade_name = tradeName || null;
    if (cnpj && !isValidCnpj(cnpj)) errors.cnpj = MSG.cnpj;
    else if (!cnpj && (name || tradeName)) errors.cnpj = MSG.cnpjRequired;
  }
  return { body, errors, needsPassword: changed };
}

export const COMPANY_SECTION: SectionSpec<CompanyForm, CompanyField> = {
  fromProfile: (p) => ({
    cnpj: maskCnpj(p.company_document ?? ""),
    name: p.company_name ?? "",
    tradeName: p.company_trade_name ?? "",
  }),
  review: reviewCompany,
  order: ["cnpj", "name", "tradeName"],
  saved: () => ({ title: "Dados empresariais atualizados" }),
  passwordReason: "Mudar os dados da empresa pede a senha atual.",
};

// --------------------------------------------------------------------------- Veículo (Transporte)

export interface VehicleDraft {
  model: string;
  /** Só letras e números, em maiúsculas (normalizePlate). */
  plate: string;
}
export type VehicleField = keyof VehicleDraft;

export function vehicleDraftOf(model: string | null | undefined, plate: string | null | undefined): VehicleDraft {
  return { model: model ?? "", plate: normalizePlate(plate ?? "") };
}

/**
 * Modelo e placa, os dois opcionais, vão juntos quando um muda (vazio limpa). Placa antiga (ABC1234) ou Mercosul
 * (ABC1D23); modelo com 2 caracteres ou mais.
 */
export function reviewVehicle(
  draft: VehicleDraft,
  saved: { model: string | null | undefined; plate: string | null | undefined },
): { body: MyProfileUpdate; errors: Partial<Record<VehicleField, string>> } {
  const model = collapse(draft.model);
  const plate = normalizePlate(draft.plate);
  if (model === collapse(saved.model ?? "") && plate === normalizePlate(saved.plate ?? "")) return { body: {}, errors: {} };
  const errors: Partial<Record<VehicleField, string>> = {};
  if (model && charCount(model) < 2) errors.model = MSG.vehicleModel;
  if (plate && !isValidPlate(plate)) errors.plate = MSG.plate;
  return { body: { vehicle_model: model || null, vehicle_plate: plate || null }, errors };
}

/** "Modelo Exemplo · ABC1D23" (a placa antiga com hífen); só um dos dois, ele; nenhum, "Não informado". */
export function vehicleText(model: string | null | undefined, plate: string | null | undefined): string {
  const parts = [collapse(model ?? ""), plate ? formatPlate(plate) : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Não informado";
}

// --------------------------------------------------------------------------- resumos das linhas de Configurações

export const NO_PHONE = "Sem celular";
export const NO_ADDRESS = "Não informado";
export const EMAIL_PENDING = "E-mail pendente";
export const EMAIL_UNVERIFIED = "E-mail não validado";

/** "3 ferramentas", "1 ferramenta"; zero: "Nenhuma" (aptidão, formação e ferramenta são femininas). */
export function countLabel(n: number, one: string, many: string): string {
  if (n <= 0) return "Nenhuma";
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** O celular como a pessoa lê, "(11) 98888-7777"; null sem celular (a linha mostra NO_PHONE). */
export function contactSummary(phone: string | null | undefined): string | null {
  return phone && onlyDigits(phone) ? maskPhone(phone) : null;
}

/**
 * A linha Contato: sem celular, "Sem celular" (âmbar: a central não fala com ele); com a troca de e-mail esperando o
 * link, "E-mail pendente" (âmbar: falta abrir o link); com o envio de e-mail ligado e o login que recebe e-mail ainda
 * sem validação, "E-mail não validado" (neutro: sem validar, o "Esqueci minha senha" não chega a ele); senão, o celular.
 */
export function contactRowSummary(p: Pick<MyProfile, "phone"> & EmailFacts): { value: string; tone: "muted" | "warning" } {
  const phone = contactSummary(p.phone);
  if (!phone) return { value: NO_PHONE, tone: "warning" };
  const status = emailStatus(p).kind;
  if (status === "pending") return { value: EMAIL_PENDING, tone: "warning" };
  if (status === "unverified") return { value: EMAIL_UNVERIFIED, tone: "muted" };
  return { value: phone, tone: "muted" };
}

/** "Cidade Exemplo/SP"; só a cidade, ela; sem cidade, NO_ADDRESS. */
export function addressSummary(city: string | null | undefined, uf: string | null | undefined): string {
  const name = collapse(city ?? "");
  if (!name) return NO_ADDRESS;
  const state = (uf ?? "").trim().toUpperCase();
  return state ? `${name}/${state}` : name;
}

/** A biografia numa linha (espaços e quebras juntados; a linha corta com "…"); vazia, "Não informada". */
export function bioSummary(bio: string | null | undefined): string {
  return collapse(bio ?? "") || "Não informada";
}

/** O nome fantasia; sem ele, a razão social; só o CNPJ, ele; nada, "Não informados". */
export function companySummary(p: Pick<MyProfile, "company_document" | "company_name" | "company_trade_name">): string {
  const name = collapse(p.company_trade_name ?? "") || collapse(p.company_name ?? "");
  if (name) return name;
  return p.company_document ? maskCnpj(p.company_document) : "Não informados";
}
