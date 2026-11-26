// Sonda de lib/profileForm.ts (as telas do cadastro em Configurações, o veículo do Transporte e os resumos do menu).
// Dados fictícios. Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { URL } from "node:url";
import { CEP_TEXT } from "../src/lib/constants.ts";
import {
  ADDRESS_SECTION,
  addressSummary,
  BIO_SECTION,
  bioCount,
  bioSummary,
  birthLimits,
  cepDiffers,
  cepMiss,
  cepPatch,
  COMPANY_SECTION,
  companySummary,
  CONTACT_SECTION,
  contactRowSummary,
  contactSummary,
  countLabel,
  emailHint,
  emailStatus,
  firstError,
  linkSentText,
  MSG,
  NO_ADDRESS,
  NO_PHONE,
  PERSONAL_SECTION,
  rebase,
  reviewAddress,
  reviewBio,
  reviewCompany,
  reviewContact,
  reviewPersonal,
  reviewVehicle,
  todayIso,
  vehicleDraftOf,
  vehicleText,
} from "../src/lib/profileForm.ts";

/** O cadastro como o GET /me/profile da API do cadastro V2 devolve (fictício). */
const PROFILE = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Tecnico Alfa",
  email: "tecnico.alfa@exemplo.com",
  phone: "(11) 98888-7777",
  job_title: null,
  team: { id: "00000000-0000-4000-8000-000000000002", name: "Grupo Exemplo" },
  home_city: "Cidade Exemplo",
  home_state: "SP",
  coverage_area: "Zona Exemplo",
  address_line: "Rua Exemplo",
  address_number: "100",
  address_complement: "Apto 4",
  address_district: "Centro",
  address_zip: "01001-000",
  avatar_url: null,
  pix: null,
  cpf: null,
  rg_number: null,
  rg_issuer: null,
  rg_state: null,
  birth_date: null,
  phone_secondary: null,
  bio: null,
  company_document: null,
  company_name: null,
  company_trade_name: null,
  vehicle_model: null,
  vehicle_plate: null,
  email_pending: null,
  email_verified_at: "2026-11-20T12:00:00Z",
  email_link_sent_at: null,
  mail_enabled: true,
  payout_methods: [],
  unavailability: [],
  tool_ids: [],
  availability: [],
  transport: null,
  skills: [],
  education: [],
  tech_profile_updated: {},
};

const TODAY = "2026-11-25";

/** Revisa o formulário de uma tela montado do cadastro, com as mudanças da pessoa por cima. */
const check = (reviewer, spec) => (patch = {}, profile = PROFILE) =>
  reviewer({ ...spec.fromProfile(profile), ...patch }, spec.fromProfile(profile));
const personalReview = (patch = {}, profile = PROFILE) =>
  reviewPersonal({ ...PERSONAL_SECTION.fromProfile(profile), ...patch }, PERSONAL_SECTION.fromProfile(profile), TODAY);
const contactReview = check(reviewContact, CONTACT_SECTION);
const addressReview = check(reviewAddress, ADDRESS_SECTION);
const bioReview = check(reviewBio, BIO_SECTION);
const companyReview = check(reviewCompany, COMPANY_SECTION);
const UNCHANGED = { body: {}, errors: {}, needsPassword: false };

it("lib/profileForm.ts é puro: além dos tipos, só ./constants e ./masks", () => {
  const source = readFileSync(new URL("../src/lib/profileForm.ts", import.meta.url), "utf8");
  const values = [...source.matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(values.sort(), ["./constants", "./masks"]);
});

it("cada tela usa o seu revisor; só Contato e Dados empresariais pedem a senha", () => {
  assert.equal(PERSONAL_SECTION.review, reviewPersonal);
  assert.equal(CONTACT_SECTION.review, reviewContact);
  assert.equal(ADDRESS_SECTION.review, reviewAddress);
  assert.equal(BIO_SECTION.review, reviewBio);
  assert.equal(COMPANY_SECTION.review, reviewCompany);
  assert.equal(CONTACT_SECTION.passwordReason, "Mudar o e-mail pede a senha atual.");
  assert.equal(COMPANY_SECTION.passwordReason, "Mudar os dados da empresa pede a senha atual.");
  for (const spec of [PERSONAL_SECTION, ADDRESS_SECTION, BIO_SECTION]) assert.equal(spec.passwordReason, undefined);
});

it("os campos que faltam na API de antes não quebram a montagem dos formulários", () => {
  const legacy = { ...PROFILE };
  for (const key of ["cpf", "rg_number", "birth_date", "phone_secondary", "address_number", "bio", "company_document", "email_pending", "mail_enabled"]) {
    delete legacy[key];
  }
  assert.equal(PERSONAL_SECTION.fromProfile(legacy).cpf, "");
  assert.equal(CONTACT_SECTION.fromProfile(legacy).mailEnabled, false);
  assert.equal(ADDRESS_SECTION.fromProfile(legacy).number, "");
  assert.deepEqual(BIO_SECTION.fromProfile(legacy), { bio: "" });
  assert.equal(COMPANY_SECTION.fromProfile(legacy).cnpj, "");
});

describe("reviewPersonal (Dados pessoais)", () => {
  it("nada mudou: corpo vazio, sem erro e sem senha", () => {
    assert.deepEqual(personalReview(), UNCHANGED);
  });

  it("nome novo com número não passa; o antigo com número que não mudou passa", () => {
    const r = personalReview({ name: "Tecnico Alfa 2" });
    assert.equal(r.errors.name, MSG.nameLetters);
    assert.equal(r.errors.name, "Use só letras no nome.");
    assert.equal(r.body.name, "Tecnico Alfa 2");
    assert.deepEqual(personalReview({}, { ...PROFILE, name: "Tecnico Alfa 2" }), UNCHANGED);
  });

  it("nome com menos de 3 caracteres e contato no nome", () => {
    assert.equal(personalReview({ name: "Al" }).errors.name, "Informe seu nome completo.");
    assert.equal(personalReview({ name: "Tecnico www.exemplo" }).errors.name, MSG.nameLetters);
    assert.equal(personalReview({ name: "Tecnico Alfa @exemplo" }).errors.name, MSG.nameLetters);
  });

  it("espaços juntados e acento separado não são mudança; o nome vai como o servidor grava", () => {
    const accented = { ...PROFILE, name: "Técnico Alfa" };
    assert.deepEqual(personalReview({ name: "  Técnico   Alfa " }, accented).body, {});
    assert.deepEqual(personalReview({ name: "  Tecnico   Beta " }).body, { name: "Tecnico Beta" });
    assert.deepEqual(personalReview({ name: "Tecnico D'Alfa-Beta Jr." }).errors, {});
  });

  it("CPF inválido", () => {
    const r = personalReview({ cpf: "123.456.789-00" });
    assert.equal(r.errors.cpf, MSG.cpf);
    assert.equal(r.errors.cpf, "CPF inválido.");
  });

  it("CPF válido vai com os 11 números e a tela pede para conferir antes de gravar", () => {
    const r = personalReview({ cpf: "123.456.789-09" });
    assert.deepEqual(r.body, { cpf: "12345678909" });
    assert.deepEqual(r.errors, {});
    assert.equal(r.needsPassword, false);
    assert.deepEqual(PERSONAL_SECTION.confirm(r, PERSONAL_SECTION.fromProfile(PROFILE)), {
      title: "Confira o CPF",
      message: "123.456.789-09. Depois de salvo, só a central muda.",
      confirmText: "Salvar",
    });
    assert.equal(PERSONAL_SECTION.confirm(personalReview({ name: "Tecnico Beta" }), PERSONAL_SECTION.fromProfile(PROFILE)), null);
  });

  it("CPF gravado: só leitura, nunca vai no corpo", () => {
    const withCpf = { ...PROFILE, cpf: "12345678909" };
    const form = PERSONAL_SECTION.fromProfile(withCpf);
    assert.equal(form.cpf, "123.456.789-09");
    assert.equal(form.cpfLocked, true);
    assert.deepEqual(personalReview({ cpf: "111.444.777-35" }, withCpf), UNCHANGED);
    assert.equal(PERSONAL_SECTION.fromProfile(PROFILE).cpfLocked, false);
    // A central gravou o CPF com a tela aberta (a releitura trouxe o gravado): o digitado não vai.
    const typed = { ...PERSONAL_SECTION.fromProfile(PROFILE), cpf: "123.456.789-09" };
    assert.deepEqual(reviewPersonal(typed, form, TODAY), UNCHANGED);
  });

  it("RG só com o número: faltam o órgão emissor e a UF", () => {
    const r = personalReview({ rgNumber: "12.345.678-x" });
    assert.equal(r.errors.rgIssuer, "Informe o órgão emissor.");
    assert.equal(r.errors.rgState, "Informe a UF do RG.");
    assert.equal(r.errors.rgNumber, undefined);
    assert.deepEqual(r.body, { rg_number: "12.345.678-X", rg_issuer: null, rg_state: null });
  });

  it("RG completo: os três juntos, como o servidor grava", () => {
    const r = personalReview({ rgNumber: "12.345.678-x", rgIssuer: "ssp", rgState: "sp" });
    assert.deepEqual(r.body, { rg_number: "12.345.678-X", rg_issuer: "SSP", rg_state: "SP" });
    assert.deepEqual(r.errors, {});
    assert.equal(personalReview({ rgNumber: "12345678", rgIssuer: "Polícia  Civil", rgState: "MG" }).body.rg_issuer, "POLICIA CIVIL");
    assert.deepEqual(personalReview({ rgNumber: "MG-12.345.678", rgIssuer: "SSP", rgState: "MG" }).errors, {});
  });

  it("RG: número curto, órgão curto, UF fora das 27 e órgão sem o número", () => {
    const r = personalReview({ rgNumber: "123", rgIssuer: "S", rgState: "XX" });
    assert.equal(r.errors.rgNumber, "Confira o número do RG.");
    assert.equal(r.errors.rgIssuer, "Confira o órgão emissor.");
    assert.equal(r.errors.rgState, MSG.uf);
    assert.equal(personalReview({ rgIssuer: "SSP" }).errors.rgNumber, "Informe o número do RG.");
  });

  it("os três vazios limpam o RG gravado; o RG antigo que não mudou não trava o resto", () => {
    const withRg = { ...PROFILE, rg_number: "12.345.678-X", rg_issuer: "SSP", rg_state: "SP" };
    const cleared = personalReview({ rgNumber: "", rgIssuer: "  ", rgState: "" }, withRg);
    assert.deepEqual(cleared.body, { rg_number: null, rg_issuer: null, rg_state: null });
    assert.deepEqual(cleared.errors, {});
    const oldRg = { ...PROFILE, rg_number: "123", rg_issuer: "S", rg_state: null };
    assert.deepEqual(personalReview({ name: "Tecnico Beta" }, oldRg).errors, {});
  });

  it("nascimento: de 18 a 90 anos completos no dia", () => {
    assert.equal(personalReview({ birthDate: "2008-11-26" }).errors.birthDate, MSG.birthMinor);
    assert.equal(MSG.birthMinor, "O cadastro é para maiores de 18 anos: confira a data de nascimento.");
    assert.deepEqual(personalReview({ birthDate: "2008-11-25" }), { body: { birth_date: "2008-11-25" }, errors: {}, needsPassword: false });
    assert.equal(personalReview({ birthDate: "1935-11-24" }).errors.birthDate, "Confira a data de nascimento.");
    assert.equal(personalReview({ birthDate: "1935-11-25" }).errors.birthDate, MSG.birth);
    assert.deepEqual(personalReview({ birthDate: "1935-11-26" }).errors, {});
    assert.deepEqual(personalReview({ birthDate: "1936-11-25" }).errors, {});
    assert.equal(personalReview({ birthDate: "2026-02-30" }).errors.birthDate, MSG.birth);
  });

  it("nascimento apagado vai como null; a data gravada que não mudou não é mudança", () => {
    const born = { ...PROFILE, birth_date: "1990-11-25" };
    assert.deepEqual(personalReview({ birthDate: null }, born).body, { birth_date: null });
    assert.deepEqual(personalReview({}, born), UNCHANGED);
  });

  it("os limites do seletor do nascimento (29/02 em ano que não é bissexto vira 28/02)", () => {
    assert.deepEqual(birthLimits("2026-11-25"), { min: "1935-11-26", max: "2008-11-25", initial: "1996-11-25" });
    assert.deepEqual(birthLimits("2028-02-29"), { min: "1937-03-01", max: "2010-02-28", initial: "1998-02-28" });
  });

  it("aviso de salvo e a ordem da tela", () => {
    assert.deepEqual(PERSONAL_SECTION.saved(personalReview({ name: "Tecnico Beta" }), PERSONAL_SECTION.fromProfile(PROFILE)), {
      title: "Dados pessoais atualizados",
    });
    const r = personalReview({ name: "Al", rgNumber: "123" });
    assert.equal(firstError(r.errors, PERSONAL_SECTION.order), MSG.name);
  });
});

describe("reviewContact (Contato)", () => {
  it("nada mudou: corpo vazio, sem erro e sem senha", () => {
    assert.deepEqual(contactReview(), UNCHANGED);
  });

  it("o mesmo celular escrito com +55 não é mudança; celular novo vai com a máscara", () => {
    assert.deepEqual(contactReview({ phone: "+55 11 98888-7777" }).body, {});
    assert.deepEqual(contactReview({ phone: "11977776666" }).body, { phone: "(11) 97777-6666" });
  });

  it("celular sem DDD", () => {
    assert.equal(contactReview({ phone: "98888-77" }).errors.phone, "Informe o celular com DDD.");
    assert.equal(contactReview({ phone: "" }).errors.phone, MSG.phone);
  });

  it("telefone secundário: com DDD, diferente do celular; apagado vai como null", () => {
    assert.deepEqual(contactReview({ phone2: "(11) 3333-4444" }), {
      body: { phone_secondary: "(11) 3333-4444" },
      errors: {},
      needsPassword: false,
    });
    assert.equal(contactReview({ phone2: "3333-444" }).errors.phone2, "Informe o telefone com DDD.");
    assert.equal(contactReview({ phone2: "(11) 98888-7777" }).errors.phone2, "Igual ao celular.");
    const withPhone2 = { ...PROFILE, phone_secondary: "(11) 3333-4444" };
    assert.deepEqual(contactReview({ phone2: "" }, withPhone2).body, { phone_secondary: null });
    assert.deepEqual(contactReview({ phone2: "+55 11 3333-4444" }, withPhone2), UNCHANGED);
  });

  it("e-mail trocado pede a senha e vai em minúsculas, sem espaços", () => {
    const r = contactReview({ email: " Tecnico.Beta@Exemplo.com " });
    assert.equal(r.needsPassword, true);
    assert.deepEqual(r.body, { email: "tecnico.beta@exemplo.com" });
    assert.deepEqual(r.errors, {});
  });

  it("o mesmo e-mail com maiúsculas não é mudança", () => {
    assert.deepEqual(contactReview({ email: "Tecnico.Alfa@Exemplo.com" }), UNCHANGED);
  });

  it("e-mail inválido ou que não recebe mensagens", () => {
    assert.equal(contactReview({ email: "tecnico.beta@exemplo" }).errors.email, "Informe um e-mail válido.");
    assert.equal(contactReview({ email: "fc-1@importado.invalid" }).errors.email, "Este e-mail não recebe mensagens.");
  });

  it("com a troca pendente: digitar o e-mail novo de novo não reenvia, e o login também não é mudança", () => {
    const pending = { ...PROFILE, email_pending: "tecnico.beta@exemplo.com", email_link_sent_at: "2026-11-25T17:30:00Z" };
    assert.deepEqual(contactReview({ email: "Tecnico.Beta@exemplo.com" }, pending), UNCHANGED);
    assert.deepEqual(contactReview({}, pending), UNCHANGED);
    assert.deepEqual(contactReview({ email: "tecnico.gama@exemplo.com" }, pending).body, { email: "tecnico.gama@exemplo.com" });
  });

  it("envio de e-mail desligado: o e-mail não muda pelo app", () => {
    const off = { ...PROFILE, mail_enabled: false };
    assert.deepEqual(contactReview({ email: "tecnico.beta@exemplo.com" }, off), UNCHANGED);
    assert.deepEqual(contactReview({ email: "tecnico.beta@exemplo.com", phone: "11977776666" }, off), {
      body: { phone: "(11) 97777-6666" },
      errors: {},
      needsPassword: false,
    });
  });

  it("login de teste sem @ que não mudou não dá erro", () => {
    const test = { ...PROFILE, email: "tecnico" };
    assert.deepEqual(contactReview({}, test), UNCHANGED);
    assert.deepEqual(contactReview({ phone: "(11) 97777-6666" }, test).errors, {});
  });

  it("aviso de salvo: com e-mail novo, abrir o link (o login continua o de hoje); sem, Contato atualizado", () => {
    const base = CONTACT_SECTION.fromProfile(PROFILE);
    assert.deepEqual(CONTACT_SECTION.saved(contactReview({ email: "tecnico.beta@exemplo.com" }), base), {
      title: "Confirme o novo e-mail",
      description: "Abra o link enviado para tecnico.beta@exemplo.com. Até lá, entre com tecnico.alfa@exemplo.com.",
    });
    assert.deepEqual(CONTACT_SECTION.saved(contactReview({ phone: "(11) 97777-6666" }), base), { title: "Contato atualizado" });
  });
});

describe("estado do e-mail (Contato)", () => {
  const sent = new Date(2026, 10, 25, 14, 30).toISOString();
  const now = new Date(2026, 10, 25, 18, 0);

  it("emailStatus de cada caso", () => {
    assert.deepEqual(emailStatus(PROFILE), { kind: "verified" });
    assert.deepEqual(emailStatus({ ...PROFILE, mail_enabled: false }), { kind: "disabled" });
    assert.deepEqual(emailStatus({ ...PROFILE, mail_enabled: undefined }), { kind: "disabled" });
    assert.deepEqual(emailStatus({ ...PROFILE, email: "tecnico", email_verified_at: null }), { kind: "none" });
    assert.deepEqual(emailStatus({ ...PROFILE, email: "fc-1@importado.invalid", email_verified_at: null }), { kind: "undeliverable" });
    assert.deepEqual(emailStatus({ ...PROFILE, email_verified_at: null }), { kind: "unverified", sentAt: null });
    assert.deepEqual(emailStatus({ ...PROFILE, email_verified_at: null, email_link_sent_at: sent }), { kind: "unverified", sentAt: sent });
    const pending = { ...PROFILE, email_pending: "tecnico.beta@exemplo.com", email_link_sent_at: sent };
    assert.deepEqual(emailStatus(pending), { kind: "pending", email: "tecnico.beta@exemplo.com", sentAt: sent, resend: true });
    // Envio desligado com a troca pedida antes: ainda dá para cancelar (o link enviado pode valer), não para reenviar.
    assert.deepEqual(emailStatus({ ...pending, mail_enabled: false }), {
      kind: "pending",
      email: "tecnico.beta@exemplo.com",
      sentAt: sent,
      resend: false,
    });
  });

  it("emailHint de cada estado, editando ou não", () => {
    assert.equal(emailHint({ kind: "verified" }, false, now), "Validado");
    assert.equal(emailHint({ kind: "verified" }, true, now), "Você recebe um link para validar.");
    assert.equal(emailHint({ kind: "unverified", sentAt: null }, false, now), "Pendente de validação");
    assert.equal(emailHint({ kind: "unverified", sentAt: sent }, false, now), "Pendente de validação · link enviado às 14:30");
    assert.equal(emailHint({ kind: "pending", email: "tecnico.beta@exemplo.com", sentAt: sent, resend: true }, false, now), "Seu login até validar o novo.");
    assert.equal(emailHint({ kind: "disabled" }, false, now), "Para trocar, fale com a central pelo WhatsApp.");
    assert.equal(emailHint({ kind: "none" }, false, now), "É o seu login no app.");
    assert.equal(emailHint({ kind: "undeliverable" }, false, now), "Este e-mail não recebe mensagens.");
    assert.equal(emailHint({ kind: "undeliverable" }, true, now), "Você recebe um link para validar.");
  });

  it("linkSentText no mesmo dia, em outro dia e em outro ano", () => {
    assert.equal(linkSentText(sent, now), "Link enviado às 14:30");
    assert.equal(linkSentText(new Date(2026, 10, 18, 14, 30).toISOString(), now), "Link enviado em 18/11 às 14:30");
    assert.equal(linkSentText(new Date(2025, 10, 18, 9, 5).toISOString(), now), "Link enviado em 18/11/2025 às 09:05");
    assert.equal(linkSentText("não é data", now), "Link enviado");
  });
});

describe("reviewAddress (Endereço)", () => {
  it("nada mudou: corpo vazio, sem erro e sem senha", () => {
    assert.deepEqual(addressReview(), UNCHANGED);
  });

  it("mudou só o número: logradouro, número e complemento vão juntos", () => {
    assert.deepEqual(addressReview({ number: " 200 " }).body, {
      address_line: "Rua Exemplo",
      address_number: "200",
      address_complement: "Apto 4",
    });
    assert.deepEqual(addressReview({ complement: "" }).body, {
      address_line: "Rua Exemplo",
      address_number: "100",
      address_complement: null,
    });
  });

  it("cidade vazia", () => {
    assert.equal(addressReview({ city: "  " }).errors.city, "Informe a cidade.");
  });

  it("UF fora das 27; em minúsculas vai em maiúsculas", () => {
    assert.equal(addressReview({ uf: "XX" }).errors.uf, "UF inválida.");
    assert.deepEqual(addressReview({ uf: "rj" }).body, { home_state: "RJ" });
  });

  it("CEP com 7 números", () => {
    assert.equal(addressReview({ zip: "0100100" }).errors.zip, CEP_TEXT.invalid);
    assert.equal(MSG.zip, "CEP inválido: use os 8 números.");
  });

  it("CEP apagado vai como null, sem erro", () => {
    const r = addressReview({ zip: "" });
    assert.deepEqual(r.body, { address_zip: null });
    assert.deepEqual(r.errors, {});
  });

  it("CEP novo vai com a máscara; vazios viram null; só o que mudou vai no corpo", () => {
    const r = addressReview({ zip: "02002000", district: " ", coverage: "" });
    assert.deepEqual(r.body, { address_zip: "02002-000", address_district: null, coverage_area: null });
    assert.equal(r.needsPassword, false);
  });

  it("cidade e UF faltando só travam esta tela (cadastro antigo sem cidade)", () => {
    const noCity = { ...PROFILE, home_city: null, home_state: null };
    const r = addressReview({}, noCity);
    assert.equal(r.errors.city, MSG.city);
    assert.equal(r.errors.uf, MSG.uf);
    assert.deepEqual(contactReview({ phone: "(11) 97777-6666" }, noCity).errors, {});
  });

  it("o primeiro erro na ordem da tela vai para o rodapé", () => {
    const r = addressReview({ zip: "0100100", city: "", uf: "XX" });
    assert.equal(firstError(r.errors, ADDRESS_SECTION.order), MSG.zip);
    assert.equal(firstError({ uf: MSG.uf, city: MSG.city }, ADDRESS_SECTION.order), MSG.city);
    assert.equal(firstError({}, ADDRESS_SECTION.order), null);
  });

  it("aviso de salvo", () => {
    assert.deepEqual(ADDRESS_SECTION.saved(addressReview({ district: "Bairro Exemplo" }), ADDRESS_SECTION.fromProfile(PROFILE)), {
      title: "Endereço atualizado",
    });
  });
});

describe("CEP no Endereço (cepPatch, cepDiffers, cepMiss)", () => {
  const FOUND = { cep: "02002-000", street: "Rua Nova Exemplo", district: "Bairro Exemplo", city: "Cidade Exemplo", state: "SP" };
  const GENERAL = { cep: "13999-999", street: null, district: null, city: "Cidade Geral", state: "MG" };
  const saved = ADDRESS_SECTION.fromProfile(PROFILE);
  const NONE = new Set();
  const empty = ADDRESS_SECTION.fromProfile({
    ...PROFILE,
    address_line: null,
    address_number: null,
    address_complement: null,
    address_district: null,
    home_city: null,
    home_state: null,
  });

  it("endereço vazio: preenche logradouro, bairro, cidade e UF e vai para o Número", () => {
    const r = cepPatch(empty, empty, NONE, FOUND);
    assert.deepEqual(r.patch, { street: "Rua Nova Exemplo", district: "Bairro Exemplo", city: "Cidade Exemplo", uf: "SP" });
    assert.deepEqual(r.filled, { street: "Rua Nova Exemplo", district: "Bairro Exemplo", city: "Cidade Exemplo", state: "SP" });
    assert.equal(r.focus, "number");
  });

  it("campo igual ao gravado é livre; logradouro novo limpa o número e o complemento que a pessoa não mexeu", () => {
    const r = cepPatch(saved, saved, NONE, FOUND);
    assert.deepEqual(r.patch, { street: "Rua Nova Exemplo", district: "Bairro Exemplo", number: "", complement: "" });
  });

  it("a mesma rua com outra grafia: o logradouro ganha a do CEP e o número e o complemento ficam", () => {
    const sameStreet = ADDRESS_SECTION.fromProfile({ ...PROFILE, address_line: "rua nova  exemplo" });
    assert.deepEqual(cepPatch(sameStreet, sameStreet, NONE, FOUND).patch, { street: "Rua Nova Exemplo", district: "Bairro Exemplo" });
  });

  it("o número digitado fica quando o logradouro muda", () => {
    const r = cepPatch({ ...saved, number: "250" }, saved, NONE, FOUND);
    assert.equal(r.patch.number, undefined);
    assert.equal(r.patch.complement, "");
  });

  it("o logradouro digitado fica, e a tela mostra o conflito", () => {
    const typed = { ...saved, street: "Rua Digitada" };
    const r = cepPatch(typed, saved, NONE, FOUND);
    assert.equal(r.patch.street, undefined);
    assert.equal(r.patch.number, undefined);
    assert.equal(cepDiffers({ ...typed, ...r.patch }, FOUND), true);
    assert.equal(cepDiffers({ ...saved, ...cepPatch(saved, saved, NONE, FOUND).patch }, FOUND), false);
  });

  it("o conflito ignora acento e maiúsculas", () => {
    assert.equal(cepDiffers({ ...saved, street: "RUA NOVA EXEMPLO", district: "bairro exemplo" }, FOUND), false);
  });

  it("o campo preenchido pela busca anterior (auto) conta como livre", () => {
    const fromSearch = { ...saved, street: "Rua Antiga Exemplo" };
    assert.equal(cepPatch(fromSearch, saved, NONE, FOUND).patch.street, undefined);
    assert.equal(cepPatch(fromSearch, saved, new Set(["street"]), FOUND).patch.street, "Rua Nova Exemplo");
  });

  it("CEP geral (sem logradouro): só cidade e UF, e o foco vai para o Logradouro", () => {
    const r = cepPatch(saved, saved, NONE, GENERAL);
    assert.deepEqual(r.patch, { city: "Cidade Geral", uf: "MG" });
    assert.equal(r.focus, "street");
  });

  it("Usar este endereço: troca também o que foi digitado", () => {
    const typed = { ...saved, street: "Rua Digitada", city: "Outra Cidade" };
    const r = cepPatch(typed, saved, NONE, FOUND, true);
    assert.equal(r.patch.street, "Rua Nova Exemplo");
    assert.equal(r.patch.city, "Cidade Exemplo");
  });

  it("cepMiss: só o 404 com CEP_NOT_FOUND é não encontrado", () => {
    assert.equal(cepMiss(404, "CEP_NOT_FOUND"), "not_found");
    assert.equal(cepMiss(404, null), "unavailable");
    assert.equal(cepMiss(503, "CEP_UNAVAILABLE"), "unavailable");
    assert.equal(cepMiss(429, null), "unavailable");
    assert.equal(cepMiss(422, null), "unavailable");
    assert.equal(cepMiss(0, null), "unavailable");
  });
});

describe("reviewBio (Mini biografia)", () => {
  it("nada mudou", () => {
    assert.deepEqual(bioReview(), UNCHANGED);
  });

  it("até 500 caracteres, contados como o servidor", () => {
    assert.equal(bioReview({ bio: "a".repeat(501) }).errors.bio, "No máximo 500 caracteres.");
    assert.deepEqual(bioReview({ bio: "a".repeat(500) }).errors, {});
    assert.deepEqual(bioReview({ bio: "😀".repeat(500) }).errors, {});
  });

  it("espaços e quebras juntados; vazio limpa", () => {
    assert.deepEqual(bioReview({ bio: " Instalo  redes\ne câmeras " }).body, { bio: "Instalo redes e câmeras" });
    const withBio = { ...PROFILE, bio: "Instalo redes e câmeras" };
    assert.deepEqual(bioReview({ bio: "  " }, withBio).body, { bio: null });
    assert.deepEqual(bioReview({ bio: "Instalo redes\ne câmeras" }, withBio), UNCHANGED);
  });

  it("contador e aviso de salvo", () => {
    assert.equal(bioCount("Instalo"), "7/500");
    assert.equal(bioCount(""), "0/500");
    assert.deepEqual(BIO_SECTION.saved(bioReview({ bio: "Instalo redes" }), BIO_SECTION.fromProfile(PROFILE)), {
      title: "Mini biografia atualizada",
    });
  });
});

describe("reviewCompany (Dados empresariais)", () => {
  const company = { ...PROFILE, company_document: "12345678000195", company_name: "Empresa Exemplo Ltda", company_trade_name: null };

  it("nada mudou", () => {
    assert.deepEqual(companyReview(), UNCHANGED);
    assert.deepEqual(companyReview({}, company), UNCHANGED);
    assert.equal(COMPANY_SECTION.fromProfile(company).cnpj, "12.345.678/0001-95");
  });

  it("CNPJ inválido", () => {
    assert.equal(companyReview({ cnpj: "12.345.678/0001-00" }).errors.cnpj, "CNPJ inválido.");
  });

  it("razão social ou nome fantasia sem CNPJ", () => {
    assert.equal(companyReview({ name: "Empresa Exemplo Ltda" }).errors.cnpj, "Informe o CNPJ.");
    assert.equal(companyReview({ tradeName: "Loja Exemplo" }).errors.cnpj, MSG.cnpjRequired);
  });

  it("só o CNPJ vale; os três vão juntos e pedem a senha", () => {
    const r = companyReview({ cnpj: "12.345.678/0001-95" });
    assert.deepEqual(r.body, { company_document: "12345678000195", company_name: null, company_trade_name: null });
    assert.deepEqual(r.errors, {});
    assert.equal(r.needsPassword, true);
  });

  it("mudar só o nome fantasia leva os três; os três vazios limpam", () => {
    assert.deepEqual(companyReview({ tradeName: " Loja  Exemplo " }, company).body, {
      company_document: "12345678000195",
      company_name: "Empresa Exemplo Ltda",
      company_trade_name: "Loja Exemplo",
    });
    const cleared = companyReview({ cnpj: "", name: "", tradeName: "" }, company);
    assert.deepEqual(cleared.body, { company_document: null, company_name: null, company_trade_name: null });
    assert.deepEqual(cleared.errors, {});
  });

  it("CNPJ alfanumérico", () => {
    const r = companyReview({ cnpj: "12.abc.345/01de-35", name: "Empresa Exemplo Ltda" });
    assert.deepEqual(r.errors, {});
    assert.equal(r.body.company_document, "12ABC34501DE35");
  });

  it("aviso de salvo", () => {
    assert.deepEqual(COMPANY_SECTION.saved(companyReview({ cnpj: "12345678000195" }), COMPANY_SECTION.fromProfile(PROFILE)), {
      title: "Dados empresariais atualizados",
    });
  });
});

describe("reviewVehicle e vehicleText (Transporte)", () => {
  const none = { model: null, plate: null };

  it("placa antiga e Mercosul passam; vão os dois juntos", () => {
    assert.deepEqual(reviewVehicle({ model: "Modelo Exemplo", plate: "abc-1234" }, none), {
      body: { vehicle_model: "Modelo Exemplo", vehicle_plate: "ABC1234" },
      errors: {},
    });
    assert.deepEqual(reviewVehicle({ model: "", plate: "ABC1D23" }, none), {
      body: { vehicle_model: null, vehicle_plate: "ABC1D23" },
      errors: {},
    });
  });

  it("placa inválida e modelo curto", () => {
    assert.equal(reviewVehicle({ model: "", plate: "AB12345" }, none).errors.plate, "Placa inválida: confira as letras e os números.");
    assert.equal(reviewVehicle({ model: "X", plate: "" }, none).errors.model, "Confira o modelo.");
  });

  it("nada mudou (a placa escrita de outro jeito também não); apagar limpa", () => {
    const saved = { model: "Modelo Exemplo", plate: "ABC1234" };
    assert.deepEqual(reviewVehicle(vehicleDraftOf(saved.model, saved.plate), saved), { body: {}, errors: {} });
    assert.deepEqual(reviewVehicle({ model: " Modelo  Exemplo ", plate: "abc-1234" }, saved), { body: {}, errors: {} });
    assert.deepEqual(reviewVehicle({ model: "", plate: "" }, saved).body, { vehicle_model: null, vehicle_plate: null });
  });

  it("vehicleText", () => {
    assert.equal(vehicleText("Modelo Exemplo", "ABC1234"), "Modelo Exemplo · ABC-1234");
    assert.equal(vehicleText("Modelo Exemplo", "ABC1D23"), "Modelo Exemplo · ABC1D23");
    assert.equal(vehicleText(null, "ABC1D23"), "ABC1D23");
    assert.equal(vehicleText("Modelo Exemplo", null), "Modelo Exemplo");
    assert.equal(vehicleText(null, null), "Não informado");
  });
});

describe("rebase: a releitura não apaga o que foi digitado", () => {
  it("o campo mexido fica; o outro acompanha o servidor", () => {
    const before = CONTACT_SECTION.fromProfile(PROFILE);
    const after = CONTACT_SECTION.fromProfile({ ...PROFILE, phone: "(11) 96666-5555", email_pending: "tecnico.beta@exemplo.com" });
    const typed = { ...before, phone2: "(11) 3333-4444" };
    assert.deepEqual(rebase(typed, before, after), {
      ...after,
      phone2: "(11) 3333-4444",
    });
  });
});

describe("resumos das linhas de Configurações", () => {
  it("countLabel", () => {
    assert.equal(countLabel(0, "ferramenta", "ferramentas"), "Nenhuma");
    assert.equal(countLabel(1, "ferramenta", "ferramentas"), "1 ferramenta");
    assert.equal(countLabel(3, "ferramenta", "ferramentas"), "3 ferramentas");
    assert.equal(countLabel(1, "aptidão", "aptidões"), "1 aptidão");
    assert.equal(countLabel(2, "formação", "formações"), "2 formações");
  });

  it("Contato: o celular; sem celular ou com a troca de e-mail pendente, em âmbar", () => {
    assert.equal(contactSummary("(11) 98888-7777"), "(11) 98888-7777");
    assert.equal(contactSummary("+55 11 98888-7777"), "(11) 98888-7777");
    assert.equal(contactSummary(null), null);
    assert.equal(contactSummary(""), null);
    assert.deepEqual(contactRowSummary(PROFILE), { value: "(11) 98888-7777", tone: "muted" });
    assert.deepEqual(contactRowSummary({ ...PROFILE, phone: null }), { value: NO_PHONE, tone: "warning" });
    assert.equal(NO_PHONE, "Sem celular");
    assert.deepEqual(contactRowSummary({ ...PROFILE, email_pending: "tecnico.beta@exemplo.com" }), { value: "E-mail pendente", tone: "warning" });
  });

  it("Endereço: cidade/UF, só a cidade ou Não informado", () => {
    assert.equal(addressSummary("Cidade Exemplo", "sp"), "Cidade Exemplo/SP");
    assert.equal(addressSummary(" Cidade  Exemplo ", null), "Cidade Exemplo");
    assert.equal(addressSummary(null, "SP"), "Não informado");
    assert.equal(NO_ADDRESS, "Não informado");
  });

  it("Mini biografia: o texto numa linha; vazia, Não informada", () => {
    assert.equal(bioSummary("Instalo redes\ne câmeras  "), "Instalo redes e câmeras");
    assert.equal(bioSummary(null), "Não informada");
    assert.equal(bioSummary("  "), "Não informada");
  });

  it("Dados empresariais: nome fantasia, razão social, o CNPJ ou Não informados", () => {
    const base = { company_document: "12345678000195", company_name: "Empresa Exemplo Ltda", company_trade_name: "Loja Exemplo" };
    assert.equal(companySummary(base), "Loja Exemplo");
    assert.equal(companySummary({ ...base, company_trade_name: null }), "Empresa Exemplo Ltda");
    assert.equal(companySummary({ ...base, company_trade_name: null, company_name: null }), "12.345.678/0001-95");
    assert.equal(companySummary({ company_document: null, company_name: null, company_trade_name: null }), "Não informados");
  });

  it("todayIso: a data do relógio do aparelho", () => {
    assert.equal(todayIso(new Date(2026, 10, 5, 23, 59)), "2026-11-05");
    assert.equal(todayIso(new Date(2027, 0, 1, 0, 0)), "2027-01-01");
  });
});
