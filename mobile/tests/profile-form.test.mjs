// Sonda de lib/profileForm.ts (as telas do cadastro em Configurações e os resumos do menu). Dados fictícios.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PIX_INVALID } from "../src/lib/pix.ts";
import {
  ADDRESS_SECTION,
  addressSummary,
  CONTACT_SECTION,
  contactSummary,
  countLabel,
  firstError,
  MSG,
  NAME_SECTION,
  NO_ADDRESS,
  NO_PHONE,
  NO_PIX,
  PIX_SECTION,
  pixSummary,
  rebase,
  reviewAddress,
  reviewContact,
  reviewName,
  reviewPix,
} from "../src/lib/profileForm.ts";

/** O cadastro como o GET /me/profile devolve (fictício). */
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
  address_line: "Rua Exemplo, 100",
  address_district: "Centro",
  address_zip: "01001-000",
  avatar_url: null,
  pix: { key_type: "cpf", key: "12345678909", holder_name: "Tecnico Alfa", updated_at: "2026-11-18T17:30:00Z" },
  tool_ids: [],
  availability: [],
  transport: null,
  skills: [],
  education: [],
  tech_profile_updated: {},
};

/** Revisa o formulário de uma tela montado do cadastro, com as mudanças da pessoa por cima. */
const check = (reviewer, spec) => (patch = {}, profile = PROFILE) =>
  reviewer({ ...spec.fromProfile(profile), ...patch }, spec.fromProfile(profile));
const nameReview = check(reviewName, NAME_SECTION);
const contactReview = check(reviewContact, CONTACT_SECTION);
const addressReview = check(reviewAddress, ADDRESS_SECTION);
const pixReview = check(reviewPix, PIX_SECTION);
const UNCHANGED = { body: {}, errors: {}, needsPassword: false };

it("cada tela usa o seu revisor", () => {
  assert.equal(NAME_SECTION.review, reviewName);
  assert.equal(CONTACT_SECTION.review, reviewContact);
  assert.equal(ADDRESS_SECTION.review, reviewAddress);
  assert.equal(PIX_SECTION.review, reviewPix);
  assert.equal(NAME_SECTION.passwordReason, undefined);
  assert.equal(ADDRESS_SECTION.passwordReason, undefined);
});

describe("reviewName (Dados pessoais)", () => {
  it("nada mudou: corpo vazio, sem erro e sem senha", () => {
    assert.deepEqual(nameReview(), UNCHANGED);
  });

  it("nome novo com número não passa", () => {
    const r = nameReview({ name: "Tecnico Alfa 2" });
    assert.equal(r.errors.name, MSG.nameLetters);
    assert.equal(r.errors.name, "Use só letras no nome.");
    assert.equal(r.body.name, "Tecnico Alfa 2");
  });

  it("o nome antigo com número que não mudou passa", () => {
    assert.deepEqual(nameReview({}, { ...PROFILE, name: "Tecnico Alfa 2" }), UNCHANGED);
  });

  it("menos de 3 caracteres e contato no nome", () => {
    assert.equal(nameReview({ name: "Al" }).errors.name, "Informe seu nome completo.");
    assert.equal(nameReview({ name: "Tecnico www.exemplo" }).errors.name, MSG.nameLetters);
    assert.equal(nameReview({ name: "Tecnico Alfa @exemplo" }).errors.name, MSG.nameLetters);
  });

  it("espaços juntados e acento separado não são mudança; o corpo vai como o servidor grava", () => {
    const accented = { ...PROFILE, name: "Técnico Alfa" };
    assert.deepEqual(nameReview({ name: "  Técnico   Alfa " }, accented).body, {});
    assert.deepEqual(nameReview({ name: "  Tecnico   Beta " }).body, { name: "Tecnico Beta" });
    assert.deepEqual(nameReview({ name: "Tecnico D'Alfa-Beta Jr." }).errors, {});
  });

  it("aviso de salvo", () => {
    assert.deepEqual(NAME_SECTION.saved(nameReview({ name: "Tecnico Beta" })), { title: "Nome atualizado" });
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

  it("e-mail trocado pede a senha e vai em minúsculas, sem espaços", () => {
    const r = contactReview({ email: " Tecnico.Beta@Exemplo.com " });
    assert.equal(r.needsPassword, true);
    assert.deepEqual(r.body, { email: "tecnico.beta@exemplo.com" });
    assert.deepEqual(r.errors, {});
  });

  it("o mesmo e-mail com maiúsculas não é mudança", () => {
    assert.deepEqual(contactReview({ email: "Tecnico.Alfa@Exemplo.com" }), UNCHANGED);
  });

  it("e-mail inválido", () => {
    assert.equal(contactReview({ email: "tecnico.beta@exemplo" }).errors.email, "Informe um e-mail válido.");
  });

  it("login de teste sem @ que não mudou não dá erro", () => {
    const test = { ...PROFILE, email: "tecnico" };
    assert.deepEqual(contactReview({}, test), UNCHANGED);
    assert.deepEqual(contactReview({ phone: "(11) 97777-6666" }, test).errors, {});
  });

  it("celular e e-mail juntos: um corpo só, com a senha", () => {
    const r = contactReview({ phone: "(11) 97777-6666", email: "tecnico.beta@exemplo.com" });
    assert.deepEqual(r.body, { phone: "(11) 97777-6666", email: "tecnico.beta@exemplo.com" });
    assert.equal(r.needsPassword, true);
  });

  it("aviso de salvo: com e-mail novo, a descrição do login; o motivo da senha", () => {
    const withEmail = CONTACT_SECTION.saved(contactReview({ email: "tecnico.beta@exemplo.com" }));
    assert.deepEqual(withEmail, { title: "Contato atualizado", description: "Use o novo e-mail para entrar no app." });
    const phoneOnly = CONTACT_SECTION.saved(contactReview({ phone: "(11) 97777-6666" }));
    assert.equal(phoneOnly.title, "Contato atualizado");
    assert.equal(phoneOnly.description, undefined);
    assert.equal(CONTACT_SECTION.passwordReason, "Mudar o e-mail pede a senha atual.");
  });
});

describe("reviewAddress (Endereço)", () => {
  it("nada mudou: corpo vazio, sem erro e sem senha", () => {
    assert.deepEqual(addressReview(), UNCHANGED);
  });

  it("cidade vazia", () => {
    assert.equal(addressReview({ city: "  " }).errors.city, "Informe a cidade.");
  });

  it("UF fora das 27; em minúsculas vai em maiúsculas", () => {
    assert.equal(addressReview({ uf: "XX" }).errors.uf, "UF inválida.");
    assert.deepEqual(addressReview({ uf: "rj" }).body, { home_state: "RJ" });
  });

  it("CEP com 7 números", () => {
    assert.equal(addressReview({ zip: "0100100" }).errors.zip, "CEP com 8 números.");
  });

  it("CEP apagado vai como null, sem erro", () => {
    const r = addressReview({ zip: "" });
    assert.deepEqual(r.body, { address_zip: null });
    assert.deepEqual(r.errors, {});
  });

  it("CEP novo vai com a máscara; vazios viram null; só o que mudou vai no corpo", () => {
    const r = addressReview({ zip: "02002000", district: " ", coverage: "", addressLine: "Rua Exemplo, 200 " });
    assert.deepEqual(r.body, {
      address_zip: "02002-000",
      address_line: "Rua Exemplo, 200",
      address_district: null,
      coverage_area: null,
    });
    assert.equal(r.needsPassword, false);
  });

  it("cidade e UF faltando só travam esta tela (cadastro antigo sem cidade)", () => {
    const noCity = { ...PROFILE, home_city: null, home_state: null };
    const r = addressReview({}, noCity);
    assert.equal(r.errors.city, MSG.city);
    assert.equal(r.errors.uf, MSG.uf);
    assert.deepEqual(contactReview({ phone: "(11) 97777-6666" }, noCity).errors, {});
    assert.deepEqual(pixReview({ pixRemoved: true }, noCity).errors, {});
  });

  it("o primeiro erro na ordem da tela vai para o rodapé", () => {
    const r = addressReview({ zip: "0100100", city: "", uf: "XX" });
    assert.equal(firstError(r.errors, ADDRESS_SECTION.order), MSG.zip);
    assert.equal(firstError({ uf: MSG.uf, city: MSG.city }, ADDRESS_SECTION.order), MSG.city);
    assert.equal(firstError({}, ADDRESS_SECTION.order), null);
  });

  it("aviso de salvo", () => {
    assert.deepEqual(ADDRESS_SECTION.saved(addressReview({ district: "Bairro Exemplo" })), { title: "Endereço atualizado" });
  });
});

describe("reviewPix (Chave PIX)", () => {
  const noPix = { ...PROFILE, pix: null };

  it("nada mudou: corpo vazio, sem erro e sem senha", () => {
    assert.deepEqual(pixReview(), UNCHANGED);
  });

  it("a chave gravada aparece com a máscara do campo", () => {
    assert.equal(PIX_SECTION.fromProfile(PROFILE).pixKey, "123.456.789-09");
    assert.equal(PIX_SECTION.fromProfile(noPix).pixType, null);
  });

  it("escolher o tipo sem digitar a chave não é mudança", () => {
    assert.deepEqual(pixReview({ pixType: "email", pixHolder: "Tecnico Alfa" }, noPix), UNCHANGED);
  });

  it("remover: pix null, com a senha; sem chave gravada não há o que remover", () => {
    const r = pixReview({ pixRemoved: true });
    assert.deepEqual(r.body, { pix: null });
    assert.equal(r.needsPassword, true);
    assert.deepEqual(pixReview({ pixRemoved: true }, noPix), UNCHANGED);
  });

  it("titular com 2 letras", () => {
    const r = pixReview({ pixHolder: "Al" });
    assert.equal(r.errors.pixHolder, "Informe o nome do titular da conta.");
    assert.equal(r.needsPassword, true);
  });

  it("chave nova: validada pelo tipo e gravada como o servidor", () => {
    const r = pixReview({ pixType: "email", pixKey: " Tecnico.Alfa@Exemplo.com ", pixHolder: "Tecnico  Alfa" }, noPix);
    assert.deepEqual(r.body, { pix: { key_type: "email", key: "tecnico.alfa@exemplo.com", holder_name: "Tecnico Alfa" } });
    assert.deepEqual(r.errors, {});
    assert.equal(r.needsPassword, true);
  });

  it("chave errada, ou vazia no tipo trocado", () => {
    assert.equal(pixReview({ pixKey: "123.456.789-00" }).errors.pixKey, PIX_INVALID.cpf);
    const switched = pixReview({ pixType: "phone", pixKey: "" });
    assert.equal(switched.errors.pixKey, "Informe a chave PIX.");
    assert.equal(firstError(switched.errors, PIX_SECTION.order), MSG.pixKey);
  });

  it("a mesma chave digitada de outro jeito não é mudança", () => {
    assert.deepEqual(pixReview({ pixKey: "12345678909" }), UNCHANGED);
    const phone = { ...PROFILE, pix: { ...PROFILE.pix, key_type: "phone", key: "+5511988887777" } };
    assert.deepEqual(pixReview({ pixKey: "+55 (11) 98888-7777" }, phone), UNCHANGED);
  });

  it("aviso de salvo e o motivo da senha", () => {
    assert.deepEqual(PIX_SECTION.saved(pixReview({ pixRemoved: true })), { title: "Chave PIX removida" });
    assert.deepEqual(PIX_SECTION.saved(pixReview({ pixHolder: "Tecnico Beta" })), {
      title: "Chave PIX atualizada",
      description: "A central foi avisada da nova chave PIX.",
    });
    assert.equal(PIX_SECTION.passwordReason, "Mudar a chave PIX pede a senha atual.");
  });
});

describe("rebase: a releitura não apaga o que foi digitado", () => {
  it("o campo mexido fica; o outro acompanha o servidor", () => {
    const before = CONTACT_SECTION.fromProfile(PROFILE);
    const after = CONTACT_SECTION.fromProfile({ ...PROFILE, phone: "(11) 96666-5555", email: "tecnico.novo@exemplo.com" });
    const typed = { ...before, email: "tecnico.beta@exemplo.com" };
    assert.deepEqual(rebase(typed, before, after), { phone: "(11) 96666-5555", email: "tecnico.beta@exemplo.com" });
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

  it("Chave PIX: o tipo e a chave mascarada; sem chave, Não cadastrada", () => {
    assert.equal(pixSummary(PROFILE.pix), "CPF •••.456.789-••");
    assert.equal(pixSummary(null), "Não cadastrada");
    assert.equal(NO_PIX, "Não cadastrada");
    assert.equal(pixSummary({ key_type: "random", key: "a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6" }), "Chave aleatória …c5d6");
    assert.equal(pixSummary({ key_type: "email", key: "tecnico.alfa@exemplo.com" }), "E-mail t•••@exemplo.com");
    assert.equal(pixSummary({ key_type: "phone", key: "+5511988887777" }), "Celular +55 (11) •••••-7777");
  });

  it("Contato: o celular como se lê; sem celular, null (a linha mostra Sem celular)", () => {
    assert.equal(contactSummary("(11) 98888-7777"), "(11) 98888-7777");
    assert.equal(contactSummary("+55 11 98888-7777"), "(11) 98888-7777");
    assert.equal(contactSummary(null), null);
    assert.equal(contactSummary(""), null);
    assert.equal(NO_PHONE, "Sem celular");
  });

  it("Endereço: cidade/UF, só a cidade ou Não informado", () => {
    assert.equal(addressSummary("Cidade Exemplo", "sp"), "Cidade Exemplo/SP");
    assert.equal(addressSummary(" Cidade  Exemplo ", null), "Cidade Exemplo");
    assert.equal(addressSummary(null, "SP"), "Não informado");
    assert.equal(NO_ADDRESS, "Não informado");
  });
});
