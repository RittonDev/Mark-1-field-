// Sonda do último e-mail do login (lib/session.ts e lib/profile.ts de verdade): o e-mail novo, validado pelo link fora
// do app e sem derrubar a sessão, vira o último login pela renovação do token (setTokens) ou pela leitura do cadastro
// (keep). Assim o login não vem com o endereço antigo se a sessão acabar antes de o app abrir de novo. O SecureStore, a
// API e o que puxa o Expo são os stubs de tests/stubs (hooks.mjs, registrado só neste processo). Dados fictícios.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { server } from "./stubs/api.mjs";
import { store, writes } from "./stubs/secureStorage.mjs";

register("./stubs/hooks.mjs", import.meta.url);
globalThis.__DEV__ = false;
const { session } = await import("../src/lib/session.ts");
const { getProfile, loadProfile, writeProfile } = await import("../src/lib/profile.ts");

const OLD = "tecnico.alfa@exemplo.com";
const NEW = "tecnico.beta@exemplo.com";
const PHONE = "(11) 98888-7777";

const userOf = (id, email) => ({ id, name: "Tecnico Alfa", email, phone: PHONE, role: "technician" });
const tokensOf = (n, user) => ({ access_token: `acesso-${n}`, refresh_token: `renova-${n}`, token_type: "bearer", user });
/** O cadastro com o que importa aqui (o login, a troca pendente e o que vai para o usuário da sessão). */
const profileOf = (id, email, pending) => ({
  id,
  name: "Tecnico Alfa",
  email,
  phone: PHONE,
  email_pending: pending,
  email_verified_at: "2026-11-26T12:05:00Z",
  email_link_sent_at: null,
  mail_enabled: true,
});
const lastEmailWrites = () => writes.filter((key) => key === "mc_last_email").length;

describe("último e-mail do login depois da troca validada pelo link", () => {
  it("a renovação do token traz o e-mail novo: ele vira o último login antes da leitura do cadastro", async () => {
    await session.signIn(tokensOf(1, userOf("u1", OLD)));
    // Pediu a troca: o login continua o de hoje e o novo fica pendente.
    await writeProfile(async () => profileOf("u1", OLD, NEW));
    assert.equal(session.get().lastEmail, OLD);
    // Abriu o link no navegador; depois, um 401 renova o token e o /auth/refresh devolve o usuário com o novo.
    await session.setTokens(tokensOf(2, userOf("u1", NEW)));
    assert.equal(session.get().user.email, NEW);
    assert.equal(session.get().lastEmail, NEW);
    assert.equal(store.get("mc_last_email"), NEW);
    // A leitura do cadastro chega com o usuário já igual: nada a corrigir.
    server.profile = profileOf("u1", NEW, null);
    await loadProfile();
    assert.equal(getProfile().email, NEW);
    // A sessão acaba (senha nova pelo link derruba as sessões): o login nasce com o novo.
    await session.signOut(true, null);
    assert.equal(session.get().lastEmail, NEW);
    assert.equal(store.get("mc_last_email"), NEW);
  });

  it("renovação com o mesmo e-mail não regrava o último login", async () => {
    await session.signIn(tokensOf(3, userOf("u2", OLD)));
    const before = lastEmailWrites();
    await session.setTokens(tokensOf(4, userOf("u2", OLD)));
    assert.equal(lastEmailWrites(), before);
    assert.equal(session.get().lastEmail, OLD);
    await session.signOut();
  });

  it("usuário da sessão já com o novo e o último login com o antigo: a leitura do cadastro corrige", async () => {
    // Como a versão anterior do app deixava (setTokens gravava só o usuário).
    await session.setPendingEnd(null);
    store.set("mc_access_token", "acesso-5");
    store.set("mc_refresh_token", "renova-5");
    store.set("mc_user", JSON.stringify(userOf("u3", NEW)));
    store.set("mc_last_email", OLD);
    await session.load();
    assert.equal(session.get().status, "signedIn");
    assert.equal(session.get().lastEmail, OLD);
    server.profile = profileOf("u3", NEW, null);
    await loadProfile();
    assert.equal(session.get().lastEmail, NEW);
    assert.equal(store.get("mc_last_email"), NEW);
    await session.signOut();
  });

  it("\"Cancelar troca\" depois do link: o DELETE devolve o login novo e ele vira o último login", async () => {
    await session.signIn(tokensOf(6, userOf("u4", OLD)));
    await writeProfile(async () => profileOf("u4", OLD, NEW));
    const back = await writeProfile(async () => profileOf("u4", NEW, null));
    assert.equal(back.email, NEW);
    assert.equal(session.get().user.email, NEW);
    assert.equal(session.get().lastEmail, NEW);
    await session.signOut();
  });
});
