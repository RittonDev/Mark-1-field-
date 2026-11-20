// Sonda da OS segura na tela (src/lib/db.ts: holdTicket e pruneOld): a OS fechada há mais de 30 dias que o técnico
// abriu pelo Histórico (ou pelo Meu elo, ou pelo mês do Faturamento) não sai do aparelho no pruneOld do fim do pull
// enquanto a tela dela está aberta; soltou, sai no próximo. Roda o db.ts de verdade sobre o node:sqlite, com dublês
// só dos módulos nativos (expo-sqlite, react-native) e de ./changes e ./ops, trocados por um gancho de resolução
// registrado aqui mesmo. Dados fictícios. Sem dependência nova: node:test. Na pasta mobile:
// node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { register } from "node:module";
import { after, describe, it } from "node:test";

const js = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

/** expo-sqlite (assíncrono) sobre o node:sqlite (síncrono): só o que o db.ts usa, num banco em memória. */
const SQLITE = js(`
import { DatabaseSync } from "node:sqlite";
const args = (params) =>
  (params.length === 1 && Array.isArray(params[0]) ? params[0] : params).map((value) => (value === undefined ? null : value));
class Connection {
  constructor(raw) { this.raw = raw; }
  async execAsync(sql) { this.raw.exec(sql); }
  async runAsync(sql, ...params) {
    const result = this.raw.prepare(sql).run(...args(params));
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }
  async getFirstAsync(sql, ...params) { return this.raw.prepare(sql).get(...args(params)) ?? null; }
  async getAllAsync(sql, ...params) { return this.raw.prepare(sql).all(...args(params)); }
  async withExclusiveTransactionAsync(task) { await this.tx(() => task(this)); }
  async withTransactionAsync(task) { await this.tx(task); }
  async tx(task) {
    this.raw.exec("BEGIN");
    try { await task(); this.raw.exec("COMMIT"); } catch (error) { this.raw.exec("ROLLBACK"); throw error; }
  }
  async closeAsync() { this.raw.close(); }
}
export async function openDatabaseAsync() { return new Connection(new DatabaseSync(":memory:")); }
`);
const DOUBLES = {
  "expo-sqlite": SQLITE,
  "react-native": js(`export const Platform = { OS: "android" };`),
  "./changes": js(`export function notifyDataChanged() {}`),
  "./ops": js(`export function rebase(server, ops) { return { ...server, pending_ops: ops.length }; }`),
};
// Só os imports do db.ts mudam; o resto segue a resolução normal (inclusive o node:sqlite do dublê).
register(
  js(`
const DOUBLES = ${JSON.stringify(DOUBLES)};
export async function resolve(specifier, context, next) {
  if ((context.parentURL ?? "").endsWith("/src/lib/db.ts") && DOUBLES[specifier]) {
    return { url: DOUBLES[specifier], shortCircuit: true };
  }
  return next(specifier, context);
}
`),
);
const { getAttachmentsCache, getDb, getTicket, holdTicket, insertOp, pruneOld, saveServerTicket, setAttachmentsCache, transaction } =
  await import("../src/lib/db.ts");

const USER = { id: "tecnico-alfa", role: "technician" };
const DAY = 24 * 3600 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();
const ticket = (id, status, updatedAt) => ({
  id,
  code: `OS-${id}`,
  status,
  assignee: { id: USER.id },
  scheduled_start: null,
  updated_at: updatedAt,
  forms: [],
});
/** Como o MissingTicket (storeServerTicket): grava a OS que veio da central, com o updated_at dela. */
const store = (...tickets) => transaction(async (db) => {
  for (const t of tickets) await saveServerTicket(db, t, USER);
});
/** O fim do pull. */
const prune = () => transaction((db) => pruneOld(db), { notify: false });
const onDevice = async (id) => (await getTicket(id)) !== null;

after(async () => {
  await (await getDb()).closeAsync();
});

describe("OS segura na tela (holdTicket) e o pruneOld", () => {
  it("a OS aberta fica no aparelho, com o cache de anexos; as outras fechadas há mais de 30 dias saem", async () => {
    await store(
      ticket("000101", "closed", "2025-06-10T13:00:00Z"),
      ticket("000102", "closed", "2025-06-10T13:00:00Z"),
      ticket("000103", "cancelled", daysAgo(45)),
      ticket("000104", "closed", daysAgo(10)),
      ticket("000105", "resolved", daysAgo(90)),
    );
    await transaction((db) => setAttachmentsCache("000102", [{ id: "anexo-1", kind: "photo" }], db), { notify: false });
    const release = holdTicket("000102");
    await prune();
    assert.equal(await onDevice("000101"), false, "fechada em 2025, sem tela: sai");
    assert.equal(await onDevice("000102"), true, "fechada em 2025, com a tela aberta: fica");
    assert.deepEqual(
      (await getAttachmentsCache("000102")).map((a) => a.id),
      ["anexo-1"],
      "o cache de anexos da OS aberta fica junto",
    );
    assert.equal(await onDevice("000103"), false, "cancelada há 45 dias: sai");
    assert.equal(await onDevice("000104"), true, "fechada há 10 dias: fica");
    assert.equal(await onDevice("000105"), true, "resolvida (não fechada): fica");
    release();
    await prune();
    assert.equal(await onDevice("000102"), false, "a tela fechou: sai no pull seguinte");
    assert.deepEqual(await getAttachmentsCache("000102"), [], "e o cache de anexos sai junto");
  });

  it("conta as telas: a OS fica até a última soltar; soltar duas vezes não solta a outra", async () => {
    await store(ticket("000201", "closed", daysAgo(400)));
    const first = holdTicket("000201");
    const second = holdTicket("000201");
    first();
    first();
    await prune();
    assert.equal(await onDevice("000201"), true, "a segunda tela ainda segura");
    second();
    await prune();
    assert.equal(await onDevice("000201"), false);
  });

  it("segurar uma OS não poupa outra; a regra da fila continua", async () => {
    await store(ticket("000301", "closed", daysAgo(60)), ticket("000302", "closed", daysAgo(60)), ticket("000303", "closed", daysAgo(60)));
    await transaction((db) =>
      insertOp(db, {
        client_op_id: "op-000303",
        ticket_id: "000303",
        client_timestamp: daysAgo(1),
        type: "comment",
        payload: { body: "Texto de exemplo" },
      }),
    );
    const release = holdTicket("000301");
    await prune();
    assert.equal(await onDevice("000301"), true, "a da tela fica");
    assert.equal(await onDevice("000302"), false, "a outra sai");
    assert.equal(await onDevice("000303"), true, "com algo na fila, fica (sem tela)");
    release();
  });
});
