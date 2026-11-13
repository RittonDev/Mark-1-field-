// Banco local (expo-sqlite). Guarda as OS do técnico, acompanhamentos, apontamentos,
// a fila de operações para POST /sync/push, as fotos aguardando upload e os avisos
// de operações recusadas pelo servidor.

import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";
import { notifyDataChanged } from "./changes";
import { rebase } from "./ops";
import type { LocalTicket, OutboxOp, SyncOperation } from "./syncTypes";
import type { Attachment, Comment, TicketDetail, UnproductiveReason, User, UUID, Worklog } from "./types";

export type DB = SQLite.SQLiteDatabase;

const IS_WEB = Platform.OS === "web";

/**
 * Espera até 5 s por um lock em vez de falhar na hora com "database is locked" (ex.: a tarefa de
 * segundo plano da jornada e a tela escrevendo juntas). Vale por conexão.
 */
const BUSY_TIMEOUT = "PRAGMA busy_timeout = 5000";

/**
 * Android/iOS: transação exclusiva (conexão própria, que também recebe o busy_timeout). Na
 * pré-visualização web o expo-sqlite não tem transação exclusiva; usa a comum na mesma conexão
 * (a fila de escrita abaixo já serializa).
 */
function inTransaction(db: DB, task: (db: DB) => Promise<void>): Promise<void> {
  if (IS_WEB) return db.withTransactionAsync(() => task(db));
  return db.withExclusiveTransactionAsync(async (txn) => {
    await txn.execAsync(BUSY_TIMEOUT);
    await task(txn);
  });
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value TEXT);

  CREATE TABLE tickets (
    id TEXT PRIMARY KEY NOT NULL,
    server_json TEXT NOT NULL,      -- última versão recebida do servidor
    json TEXT NOT NULL,             -- servidor + operações pendentes (o que a tela mostra)
    status TEXT NOT NULL,
    assignee_id TEXT,
    scheduled_start TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE comments (
    id TEXT PRIMARY KEY NOT NULL,
    ticket_id TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    local_state TEXT                -- NULL = do servidor; 'pending' | 'sent' = criado no aparelho
  );
  CREATE INDEX comments_ticket ON comments (ticket_id, created_at);

  CREATE TABLE worklogs (
    id TEXT PRIMARY KEY NOT NULL,
    ticket_id TEXT NOT NULL,
    json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    local_state TEXT
  );
  CREATE INDEX worklogs_ticket ON worklogs (ticket_id, started_at);

  CREATE TABLE outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    client_op_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    client_timestamp TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE INDEX outbox_ticket ON outbox (ticket_id, seq);

  CREATE TABLE photos (
    id TEXT PRIMARY KEY NOT NULL,
    ticket_id TEXT NOT NULL,
    file_uri TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );

  CREATE TABLE notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT,
    ticket_code TEXT,
    kind TEXT NOT NULL,             -- rejected | conflict | photo
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 2: fila de pontos do rastreamento da jornada (POST /tracking/pings em lote).
  `
  CREATE TABLE pings (
    recorded_at TEXT PRIMARY KEY NOT NULL,   -- ISO do fix do GPS; o servidor ignora duplicados
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accuracy_m REAL,
    speed_mps REAL,
    heading REAL,
    battery_pct REAL,
    is_mock INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 3: formulários da OS (foto de campo) e assinatura do responsável no local.
  `
  ALTER TABLE photos ADD COLUMN form_id TEXT;
  ALTER TABLE photos ADD COLUMN field_id TEXT;
  CREATE TABLE signatures (
    id TEXT PRIMARY KEY NOT NULL,
    ticket_id TEXT NOT NULL,
    file_uri TEXT NOT NULL,
    signer_name TEXT NOT NULL,
    signer_role TEXT,
    latitude REAL,
    longitude REAL,
    after_seq INTEGER NOT NULL,     -- operações da fila até aqui vão antes da assinatura
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  `,
  // 4: fotos de um pedido de peça (sobem antes; os ids entram na operação `part_request`).
  `
  ALTER TABLE photos ADD COLUMN part_op_id TEXT;
  `,
  // 5: o técnico é terceiro e o servidor passou a mandar só o básico da OS. Tira do aparelho o
  // que veio antes (notas da central, horas de colegas, prazos de SLA, analista, solicitante,
  // documentos do escritório) sem apagar as OS — o técnico pode estar sem rede — e zera o
  // cursor, para o próximo sync trazer tudo de novo já na versão enxuta.
  `
  DELETE FROM comments WHERE local_state IS NULL OR local_state = 'sent';
  DELETE FROM worklogs WHERE local_state IS NULL;
  UPDATE tickets SET
    server_json = json_set(server_json,
      '$.owner', NULL, '$.team', NULL, '$.project', NULL, '$.category', NULL, '$.tags', json('[]'),
      '$.client_reference', NULL, '$.requester_name', NULL, '$.requester', NULL,
      '$.requester_contact', NULL, '$.created_by', NULL, '$.response_due_at', NULL,
      '$.resolution_due_at', NULL, '$.first_response_at', NULL, '$.sla_paused_at', NULL,
      '$.response_violation_reason', NULL, '$.resolution_violation_reason', NULL,
      '$.violation_note', NULL, '$.recurrence', NULL, '$.recurrence_30d', 0, '$.legacy', NULL,
      '$.authorized_by_name', NULL, '$.authorization_channel', NULL, '$.authorization_ref', NULL,
      '$.authorized_by', NULL, '$.authorized_at', NULL, '$.location.document', NULL,
      '$.response_breached', json('false'), '$.resolution_breached', json('false'),
      '$.violation_reason_pending', json('false')),
    json = json_set(json,
      '$.owner', NULL, '$.team', NULL, '$.project', NULL, '$.category', NULL, '$.tags', json('[]'),
      '$.client_reference', NULL, '$.requester_name', NULL, '$.requester', NULL,
      '$.requester_contact', NULL, '$.created_by', NULL, '$.response_due_at', NULL,
      '$.resolution_due_at', NULL, '$.first_response_at', NULL, '$.sla_paused_at', NULL,
      '$.response_violation_reason', NULL, '$.resolution_violation_reason', NULL,
      '$.violation_note', NULL, '$.recurrence', NULL, '$.recurrence_30d', 0, '$.legacy', NULL,
      '$.authorized_by_name', NULL, '$.authorization_channel', NULL, '$.authorization_ref', NULL,
      '$.authorized_by', NULL, '$.authorized_at', NULL, '$.location.document', NULL,
      '$.response_breached', json('false'), '$.resolution_breached', json('false'),
      '$.violation_reason_pending', json('false'));
  UPDATE kv SET value = (
    SELECT json_group_array(json(each.value)) FROM json_each(kv.value) AS each
     WHERE json_extract(each.value, '$.kind') IN ('photo', 'signature')
        OR json_extract(each.value, '$.form_id') IS NOT NULL
  ) WHERE key LIKE 'attachments:%' AND json_valid(value);
  DELETE FROM kv WHERE key = 'sync_since';
  `,
  // 6: o contato da loja (nome e telefone) também ficou só com a central: tira o que estava
  // guardado nas OS do aparelho e refaz o sync.
  `
  UPDATE tickets SET
    server_json = json_set(server_json, '$.location.contact_name', NULL, '$.location.contact_phone', NULL),
    json = json_set(json, '$.location.contact_name', NULL, '$.location.contact_phone', NULL);
  DELETE FROM kv WHERE key = 'sync_since';
  `,
  // 7: a autorização do cliente saiu e o horário ficou só com a central (o técnico só sai, inicia
  // e conclui). Tira os campos de autorização guardados e refaz o sync, para as OS virem com as
  // ações novas. Os motivos de atraso de SLA também não ficam mais no aparelho.
  `
  UPDATE tickets SET
    server_json = json_remove(server_json, '$.authorization_status', '$.authorized_by_name',
      '$.authorization_channel', '$.authorization_ref', '$.authorized_at', '$.authorized_by'),
    json = json_remove(json, '$.authorization_status', '$.authorized_by_name',
      '$.authorization_channel', '$.authorization_ref', '$.authorized_at', '$.authorized_by');
  DELETE FROM kv WHERE key IN ('sync_since', 'violation_reasons', 'violation_reasons_at');
  `,
  // 8: assinatura recusada porque o formulário ainda não está concluído no servidor. Ela fica
  // guardada (o responsável no local já foi embora) e volta a ser enviada quando ele for concluído.
  `
  ALTER TABLE signatures ADD COLUMN blocked_reason TEXT;
  `,
];

let dbPromise: Promise<DB> | null = null;

async function userVersion(db: DB): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  return row?.user_version ?? 0;
}

async function migrate(db: DB) {
  // Uma volta por migração; a folga cobre as voltas em que outra conexão migrou no meio.
  for (let step = 0; step < MIGRATIONS.length * 2; step++) {
    const version = await userVersion(db);
    if (version >= MIGRATIONS.length) return;
    await inTransaction(db, async (txn) => {
      // Outra conexão (a tarefa de segundo plano abrindo o banco junto com a tela, logo depois de
      // uma atualização do app) pode ter aplicado esta migração no meio: não aplica duas vezes.
      const current = await userVersion(txn);
      if (current !== version) return;
      await txn.execAsync(MIGRATIONS[current]);
      await txn.execAsync(`PRAGMA user_version = ${current + 1}`);
    });
  }
  throw new Error("Não foi possível atualizar o banco local do aparelho.");
}

export function getDb(): Promise<DB> {
  if (!dbPromise) {
    const opening = (async () => {
      const db = await SQLite.openDatabaseAsync("maxxchamados.db");
      // Na web (pré-visualização, OPFS) o WAL não se aplica e há uma conexão só.
      if (!IS_WEB) await db.execAsync(`PRAGMA journal_mode = WAL; ${BUSY_TIMEOUT};`);
      await migrate(db);
      return db;
    })();
    dbPromise = opening;
    // Falha ao abrir ou migrar (disco cheio, lock de outra conexão): não fica presa até reiniciar
    // o app; a próxima chamada tenta de novo.
    opening.catch(() => {
      if (dbPromise === opening) dbPromise = null;
    });
  }
  return dbPromise;
}

/** A escrita foi cancelada pelo `guard` da transação (ex.: rodada de sync de uma sessão que terminou). */
export class WriteCancelled extends Error {
  constructor() {
    super("Escrita cancelada: a sessão mudou");
    this.name = "WriteCancelled";
  }
}

export interface TransactionOptions {
  /** false: não avisa as telas (escritas de rotina que nenhuma tela mostra, como os pontos do GPS). */
  notify?: boolean;
  /** Conferido na fila, logo antes de abrir a transação; false cancela com WriteCancelled. */
  guard?: () => boolean;
}

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Transação exclusiva. Cada uma abre a própria conexão no expo-sqlite, então todas as
 * escritas passam por esta fila em JS: duas transações nunca disputam o lock (SQLITE_BUSY).
 * Não chame transaction() de dentro de outra — use o `db` recebido.
 */
export async function transaction(
  task: (db: DB) => Promise<void>,
  { notify = true, guard }: TransactionOptions = {},
): Promise<void> {
  const run = writeQueue.then(async () => {
    if (guard && !guard()) throw new WriteCancelled();
    const db = await getDb();
    await inTransaction(db, task);
  });
  writeQueue = run.catch(() => undefined);
  await run;
  if (notify) notifyDataChanged();
}

// ───────────────────────────── kv ─────────────────────────────

export async function getKv(key: string, db?: DB): Promise<string | null> {
  const conn = db ?? (await getDb());
  const row = await conn.getFirstAsync<{ value: string | null }>("SELECT value FROM kv WHERE key = ?", key);
  return row?.value ?? null;
}

/**
 * Dentro de uma transação, passe o `db` dela; fora, a escrita entra na fila de transações
 * (`options`: ex.: `{ notify: false }` para chaves que nenhuma tela mostra).
 */
export async function setKv(key: string, value: string | null, db?: DB, options: TransactionOptions = {}): Promise<void> {
  if (!db) return transaction((txn) => setKv(key, value, txn), options);
  await db.runAsync("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

// ─────────────────── motivos de visita improdutiva ──────────────────

const UNPRODUCTIVE_KEY = "unproductive_reasons";
const UNPRODUCTIVE_AT_KEY = "unproductive_reasons_at";

/** Motivos guardados no aparelho, para registrar a visita improdutiva offline. */
export async function getUnproductiveReasons(): Promise<UnproductiveReason[]> {
  const raw = await getKv(UNPRODUCTIVE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as UnproductiveReason[];
  } catch {
    return [];
  }
}

export async function getUnproductiveReasonsAt(): Promise<string | null> {
  return getKv(UNPRODUCTIVE_AT_KEY);
}

export async function saveUnproductiveReasons(reasons: UnproductiveReason[], db?: DB): Promise<void> {
  if (!db) return transaction((txn) => saveUnproductiveReasons(reasons, txn));
  await setKv(UNPRODUCTIVE_KEY, JSON.stringify(reasons), db);
  await setKv(UNPRODUCTIVE_AT_KEY, new Date().toISOString(), db);
}

// ─────────────────────────── outbox ───────────────────────────

interface OutboxRow {
  seq: number;
  client_op_id: string;
  type: string;
  ticket_id: string;
  payload: string;
  client_timestamp: string;
  attempts: number;
  last_error: string | null;
}

function toOp(row: OutboxRow): OutboxOp {
  return {
    seq: row.seq,
    client_op_id: row.client_op_id,
    ticket_id: row.ticket_id,
    client_timestamp: row.client_timestamp,
    attempts: row.attempts,
    last_error: row.last_error,
    type: row.type,
    payload: JSON.parse(row.payload),
  } as OutboxOp;
}

export interface OutboxFilter {
  /** OS cujas operações ficam para depois (item travado ou em espera dessa OS). */
  excludeTickets?: Iterable<UUID>;
  /**
   * Assinatura pendente por OS (`after_seq`): as operações feitas depois dela esperam o envio da
   * assinatura; as de formulário vão antes dela, qualquer que seja a ordem.
   */
  gates?: Map<UUID, number>;
}

/** Fila em ordem, sem as OS excluídas e respeitando as assinaturas pendentes. */
export async function listOutbox(limit = 1000, db?: DB, filter: OutboxFilter = {}): Promise<OutboxOp[]> {
  const conn = db ?? (await getDb());
  const rows = await conn.getAllAsync<OutboxRow>(
    `SELECT * FROM outbox o
      WHERE o.ticket_id NOT IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) g
                         WHERE g.key = o.ticket_id AND o.seq > g.value AND o.type <> 'form_answers')
      ORDER BY o.seq LIMIT ?`,
    JSON.stringify([...(filter.excludeTickets ?? [])]),
    JSON.stringify(Object.fromEntries(filter.gates ?? [])),
    limit,
  );
  return rows.map(toOp);
}

export async function maxOutboxSeq(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ m: number | null }>("SELECT MAX(seq) AS m FROM outbox");
  return row?.m ?? 0;
}

export type PendingOp = OutboxOp & { ticket_code: string | null };

/** Fila com o código da OS, para a tela de pendências. */
export async function listPendingOps(): Promise<PendingOp[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<OutboxRow & { ticket_code: string | null }>(
    `SELECT o.*, json_extract(t.json, '$.code') AS ticket_code
       FROM outbox o LEFT JOIN tickets t ON t.id = o.ticket_id
      ORDER BY o.seq`,
  );
  return rows.map((row) => ({ ...toOp(row), ticket_code: row.ticket_code }));
}

async function opsForTicket(db: DB, ticketId: UUID): Promise<OutboxOp[]> {
  const rows = await db.getAllAsync<OutboxRow>("SELECT * FROM outbox WHERE ticket_id = ? ORDER BY seq", ticketId);
  return rows.map(toOp);
}

export async function insertOp(
  db: DB,
  op: SyncOperation & { client_op_id: string; ticket_id: UUID; client_timestamp: string },
): Promise<void> {
  await db.runAsync(
    "INSERT INTO outbox (client_op_id, type, ticket_id, payload, client_timestamp) VALUES (?, ?, ?, ?, ?)",
    op.client_op_id,
    op.type,
    op.ticket_id,
    JSON.stringify(op.payload),
    op.client_timestamp,
  );
}

export async function deleteOp(db: DB, clientOpId: string): Promise<void> {
  await db.runAsync("DELETE FROM outbox WHERE client_op_id = ?", clientOpId);
}

/**
 * Tira da fila os rascunhos (respostas sem concluir) de um formulário. Cada envio leva todas as
 * respostas, então o novo substitui os anteriores; a conclusão fica, porque muda o status.
 */
export async function dropFormDrafts(db: DB, ticketId: UUID, formId: UUID): Promise<void> {
  await db.runAsync(
    `DELETE FROM outbox
      WHERE ticket_id = ? AND type = 'form_answers'
        AND json_extract(payload, '$.form_id') = ?
        AND json_extract(payload, '$.complete') = 0`,
    ticketId,
    formId,
  );
}

export async function markOpsAttempt(db: DB, clientOpIds: string[], error: string | null): Promise<void> {
  if (!clientOpIds.length) return;
  await db.runAsync(
    "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE client_op_id IN (SELECT value FROM json_each(?))",
    error,
    JSON.stringify(clientOpIds),
  );
}

export async function countPending(): Promise<{ ops: number; photos: number }> {
  const db = await getDb();
  const ops = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
  // Fotos e assinaturas aguardando upload contam juntas como "arquivos".
  const files = await db.getFirstAsync<{ n: number }>(
    "SELECT (SELECT COUNT(*) FROM photos) + (SELECT COUNT(*) FROM signatures) AS n",
  );
  return { ops: ops?.n ?? 0, photos: files?.n ?? 0 };
}

// ─────────────────────────── tickets ──────────────────────────

/**
 * Servidor + fila. Uma operação ou um status que esta versão do app não sabe aplicar (backend
 * mais novo) não pode derrubar o download inteiro: a OS fica como veio do servidor.
 */
function effective(server: TicketDetail, ops: OutboxOp[], user: User): LocalTicket {
  try {
    return rebase(server, ops, user);
  } catch (error) {
    console.warn("Falha ao reaplicar a fila local sobre a OS", error);
    return { ...server, pending_ops: ops.length };
  }
}

/** Grava a versão do servidor e recalcula a efetiva com as operações pendentes. */
export async function saveServerTicket(db: DB, ticket: TicketDetail, user: User): Promise<void> {
  const local = effective(ticket, await opsForTicket(db, ticket.id), user);
  await db.runAsync(
    `INSERT INTO tickets (id, server_json, json, status, assignee_id, scheduled_start, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET server_json = excluded.server_json, json = excluded.json,
       status = excluded.status, assignee_id = excluded.assignee_id,
       scheduled_start = excluded.scheduled_start, updated_at = excluded.updated_at`,
    ticket.id,
    JSON.stringify(ticket),
    JSON.stringify(local),
    local.status,
    local.assignee?.id ?? null,
    local.scheduled_start,
    ticket.updated_at,
  );
}

/** Recalcula a versão efetiva a partir da última do servidor (depois de mexer na fila). */
export async function rebaseTicket(db: DB, ticketId: UUID, user: User): Promise<void> {
  const row = await db.getFirstAsync<{ server_json: string }>("SELECT server_json FROM tickets WHERE id = ?", ticketId);
  if (!row) return;
  const local = effective(JSON.parse(row.server_json) as TicketDetail, await opsForTicket(db, ticketId), user);
  await db.runAsync(
    "UPDATE tickets SET json = ?, status = ?, assignee_id = ?, scheduled_start = ? WHERE id = ?",
    JSON.stringify(local),
    local.status,
    local.assignee?.id ?? null,
    local.scheduled_start,
    ticketId,
  );
}

/** Tira a OS do aparelho com o que é dela (inclusive o cache de anexos, com links de download). */
export async function deleteTicket(db: DB, ticketId: UUID): Promise<void> {
  await db.runAsync(
    `DELETE FROM kv WHERE key = ? OR key IN (
       SELECT 'form_error:' || json_extract(f.value, '$.id')
         FROM tickets t, json_each(json_extract(t.server_json, '$.forms')) f
        WHERE t.id = ?)`,
    attachmentsKey(ticketId),
    ticketId,
  );
  await db.runAsync("DELETE FROM tickets WHERE id = ?", ticketId);
  await db.runAsync("DELETE FROM comments WHERE ticket_id = ?", ticketId);
  await db.runAsync("DELETE FROM worklogs WHERE ticket_id = ?", ticketId);
}

/**
 * Depois de um download completo: OS abertas no servidor que não vieram mais (o técnico perdeu o
 * acesso enquanto o app estava fechado) saem do aparelho, menos as que ainda têm algo a enviar.
 * Devolve quantas saíram.
 */
export async function deleteMissingOpenTickets(db: DB, receivedIds: Iterable<UUID>): Promise<number> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM tickets
      WHERE id NOT IN (SELECT value FROM json_each(?))
        AND json_extract(server_json, '$.status') NOT IN ('resolved', 'closed', 'cancelled')
        AND id NOT IN (SELECT ticket_id FROM outbox)
        AND id NOT IN (SELECT ticket_id FROM photos)
        AND id NOT IN (SELECT ticket_id FROM signatures)`,
    JSON.stringify([...receivedIds]),
  );
  for (const row of rows) await deleteTicket(db, row.id);
  return rows.length;
}

/** Última versão recebida do servidor (sem as operações pendentes do aparelho). */
export async function getServerTicket(id: UUID, db?: DB): Promise<TicketDetail | null> {
  const conn = db ?? (await getDb());
  const row = await conn.getFirstAsync<{ server_json: string }>("SELECT server_json FROM tickets WHERE id = ?", id);
  return row ? (JSON.parse(row.server_json) as TicketDetail) : null;
}

/** `version` da última OS recebida do servidor (null quando ela não está no aparelho). */
export async function getServerVersion(id: UUID): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ version: number | null }>(
    "SELECT json_extract(server_json, '$.version') AS version FROM tickets WHERE id = ?",
    id,
  );
  return row?.version ?? null;
}

/** Há OS do técnico em deslocamento (estado efetivo, já com a fila)? */
export async function hasTicketInTransit(userId: UUID): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ found: number }>(
    "SELECT 1 AS found FROM tickets WHERE assignee_id = ? AND status = 'en_route' LIMIT 1",
    userId,
  );
  return Boolean(row);
}

export async function listTickets(): Promise<LocalTicket[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ json: string }>("SELECT json FROM tickets");
  return rows.map((r) => JSON.parse(r.json) as LocalTicket);
}

export async function getTicket(id: UUID, db?: DB): Promise<LocalTicket | null> {
  const conn = db ?? (await getDb());
  const row = await conn.getFirstAsync<{ json: string }>("SELECT json FROM tickets WHERE id = ?", id);
  return row ? (JSON.parse(row.json) as LocalTicket) : null;
}

// ────────────────────── comentários e horas ─────────────────────

export type LocalComment = Comment & { local_state: "pending" | "sent" | null };
export type LocalWorklog = Worklog & { local_state: "pending" | "sent" | null };

export async function saveServerComment(db: DB, comment: Comment): Promise<void> {
  await db.runAsync(
    "INSERT OR REPLACE INTO comments (id, ticket_id, json, created_at, local_state) VALUES (?, ?, ?, ?, NULL)",
    comment.id,
    comment.ticket_id,
    JSON.stringify(comment),
    comment.created_at,
  );
}

export async function saveServerWorklog(db: DB, worklog: Worklog): Promise<void> {
  await db.runAsync(
    "INSERT OR REPLACE INTO worklogs (id, ticket_id, json, started_at, local_state) VALUES (?, ?, ?, ?, NULL)",
    worklog.id,
    worklog.ticket_id,
    JSON.stringify(worklog),
    worklog.started_at,
  );
}

/** Rascunho local (id = client_op_id) exibido até o pull trazer o registro oficial. */
export async function insertLocalComment(db: DB, comment: Comment): Promise<void> {
  await db.runAsync(
    "INSERT INTO comments (id, ticket_id, json, created_at, local_state) VALUES (?, ?, ?, ?, 'pending')",
    comment.id,
    comment.ticket_id,
    JSON.stringify(comment),
    comment.created_at,
  );
}

export async function insertLocalWorklog(db: DB, worklog: Worklog): Promise<void> {
  await db.runAsync(
    "INSERT INTO worklogs (id, ticket_id, json, started_at, local_state) VALUES (?, ?, ?, ?, 'pending')",
    worklog.id,
    worklog.ticket_id,
    JSON.stringify(worklog),
    worklog.started_at,
  );
}

/** Operação aceita: o rascunho fica visível ("enviado") até o próximo pull. */
export async function markLocalSent(db: DB, clientOpId: string): Promise<void> {
  await db.runAsync("UPDATE comments SET local_state = 'sent' WHERE id = ? AND local_state IS NOT NULL", clientOpId);
  await db.runAsync("UPDATE worklogs SET local_state = 'sent' WHERE id = ? AND local_state IS NOT NULL", clientOpId);
}

export async function deleteLocalDraft(db: DB, clientOpId: string): Promise<void> {
  await db.runAsync("DELETE FROM comments WHERE id = ? AND local_state IS NOT NULL", clientOpId);
  await db.runAsync("DELETE FROM worklogs WHERE id = ? AND local_state IS NOT NULL", clientOpId);
}

/** Depois de um pull completo, os rascunhos já enviados foram substituídos pelos oficiais. */
export async function purgeSentDrafts(db: DB): Promise<void> {
  await db.runAsync("DELETE FROM comments WHERE local_state = 'sent'");
  await db.runAsync("DELETE FROM worklogs WHERE local_state = 'sent'");
}

export async function listComments(ticketId: UUID): Promise<LocalComment[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ json: string; local_state: LocalComment["local_state"] }>(
    "SELECT json, local_state FROM comments WHERE ticket_id = ? ORDER BY created_at",
    ticketId,
  );
  return rows.map((r) => ({ ...(JSON.parse(r.json) as Comment), local_state: r.local_state }));
}

export async function listWorklogs(ticketId: UUID): Promise<LocalWorklog[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ json: string; local_state: LocalWorklog["local_state"] }>(
    "SELECT json, local_state FROM worklogs WHERE ticket_id = ? ORDER BY started_at DESC",
    ticketId,
  );
  return rows.map((r) => ({ ...(JSON.parse(r.json) as Worklog), local_state: r.local_state }));
}

// ─────────────────────────── fotos ────────────────────────────

export interface PendingPhoto {
  id: string;
  ticket_id: UUID;
  file_uri: string;
  filename: string;
  mime_type: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
  /** Foto de um campo de formulário (POST /tickets/{id}/forms/{form_id}/photos). */
  form_id: UUID | null;
  field_id: string | null;
  /** Foto de um pedido de peça ainda na fila (client_op_id da operação `part_request`). */
  part_op_id?: string | null;
}

export async function insertPhotoRow(db: DB, photo: Omit<PendingPhoto, "attempts" | "last_error">): Promise<void> {
  await db.runAsync(
    `INSERT INTO photos (id, ticket_id, file_uri, filename, mime_type, created_at, form_id, field_id, part_op_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    photo.id,
    photo.ticket_id,
    photo.file_uri,
    photo.filename,
    photo.mime_type,
    photo.created_at,
    photo.form_id,
    photo.field_id,
    photo.part_op_id ?? null,
  );
}

export async function insertPhoto(photo: Omit<PendingPhoto, "attempts" | "last_error">): Promise<void> {
  await transaction((db) => insertPhotoRow(db, photo));
}

/** Pedidos de peça com foto ainda por subir: a operação espera as fotos para levar os ids. */
export async function partOpsWithPendingPhotos(db?: DB): Promise<Set<string>> {
  const conn = db ?? (await getDb());
  const rows = await conn.getAllAsync<{ part_op_id: string }>(
    "SELECT DISTINCT part_op_id FROM photos WHERE part_op_id IS NOT NULL",
  );
  return new Set(rows.map((r) => r.part_op_id));
}

/** Foto do pedido enviada: o id do anexo entra no payload da operação ainda na fila. */
export async function addPartAttachment(db: DB, clientOpId: string, attachmentId: UUID): Promise<void> {
  const row = await db.getFirstAsync<{ payload: string }>("SELECT payload FROM outbox WHERE client_op_id = ?", clientOpId);
  if (!row) return;
  const payload = JSON.parse(row.payload) as { attachment_ids?: UUID[] };
  const ids = payload.attachment_ids ?? [];
  if (ids.includes(attachmentId)) return;
  await db.runAsync(
    "UPDATE outbox SET payload = ? WHERE client_op_id = ?",
    JSON.stringify({ ...payload, attachment_ids: [...ids, attachmentId] }),
    clientOpId,
  );
}

export async function listPhotos(ticketId?: UUID): Promise<PendingPhoto[]> {
  const db = await getDb();
  if (ticketId) {
    return db.getAllAsync<PendingPhoto>("SELECT * FROM photos WHERE ticket_id = ? ORDER BY created_at", ticketId);
  }
  return db.getAllAsync<PendingPhoto>("SELECT * FROM photos ORDER BY created_at");
}

export async function deletePhoto(id: string): Promise<void> {
  await transaction(async (db) => {
    await db.runAsync("DELETE FROM photos WHERE id = ?", id);
  });
}

/**
 * Conta a tentativa antes de enviar: se o app morrer ou a resposta se perder no meio, o próximo
 * envio sabe que a foto pode já estar no servidor (e confere antes de duplicar).
 */
export async function markPhotoAttempt(db: DB, id: string): Promise<void> {
  await db.runAsync("UPDATE photos SET attempts = attempts + 1 WHERE id = ?", id);
}

export async function markPhotoError(id: string, error: string, db?: DB): Promise<void> {
  if (!db) return transaction((txn) => markPhotoError(id, error, txn));
  await db.runAsync("UPDATE photos SET last_error = ? WHERE id = ?", error, id);
}

// ─────────────────────────── avisos ───────────────────────────

export interface Notice {
  id: number;
  ticket_id: UUID | null;
  ticket_code: string | null;
  kind: "rejected" | "conflict" | "photo";
  message: string;
  created_at: string;
}

export async function addNotice(db: DB, notice: Omit<Notice, "id" | "created_at">): Promise<void> {
  await db.runAsync(
    "INSERT INTO notices (ticket_id, ticket_code, kind, message, created_at) VALUES (?, ?, ?, ?, ?)",
    notice.ticket_id,
    notice.ticket_code,
    notice.kind,
    notice.message,
    new Date().toISOString(),
  );
}

export async function listNotices(): Promise<Notice[]> {
  const db = await getDb();
  return db.getAllAsync<Notice>("SELECT * FROM notices ORDER BY id DESC LIMIT 50");
}

export async function dismissNotice(id: number): Promise<void> {
  await transaction(async (db) => {
    await db.runAsync("DELETE FROM notices WHERE id = ?", id);
  });
}

// ─────────────────── anexos, formulários e assinatura ───────────────────

const attachmentsKey = (ticketId: UUID) => `attachments:${ticketId}`;
const formErrorKey = (formId: UUID) => `form_error:${formId}`;

/** Última lista de anexos vista online (conta as fotos de cada campo de formulário offline). */
export async function getAttachmentsCache(ticketId: UUID, db?: DB): Promise<Attachment[]> {
  const raw = await getKv(attachmentsKey(ticketId), db);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Attachment[];
  } catch {
    return [];
  }
}

export async function setAttachmentsCache(ticketId: UUID, attachments: Attachment[], db?: DB): Promise<void> {
  await setKv(attachmentsKey(ticketId), JSON.stringify(attachments), db);
}

/** Motivo da última conclusão recusada do formulário (ex.: "Falta preencher: …"). */
export async function getFormError(formId: UUID): Promise<string | null> {
  return getKv(formErrorKey(formId));
}

export async function setFormError(formId: UUID, message: string | null, db?: DB): Promise<void> {
  await setKv(formErrorKey(formId), message, db);
}

export interface PendingSignature {
  id: string;
  ticket_id: UUID;
  file_uri: string;
  signer_name: string;
  signer_role: string | null;
  latitude: number | null;
  longitude: number | null;
  after_seq: number;
  created_at: string;
  attempts: number;
  last_error: string | null;
  /**
   * O servidor recusou porque o formulário obrigatório ainda não está concluído lá: a assinatura
   * fica guardada e sai quando ele for concluído (null = pronta para enviar).
   */
  blocked_reason?: string | null;
}

/** Assinatura colhida no aparelho; substitui uma anterior ainda não enviada da mesma OS. */
export async function insertSignature(
  sig: Omit<PendingSignature, "attempts" | "last_error" | "blocked_reason">,
): Promise<string[]> {
  let replaced: string[] = [];
  await transaction(async (db) => {
    const old = await db.getAllAsync<{ file_uri: string }>("SELECT file_uri FROM signatures WHERE ticket_id = ?", sig.ticket_id);
    replaced = old.map((o) => o.file_uri);
    await db.runAsync("DELETE FROM signatures WHERE ticket_id = ?", sig.ticket_id);
    await db.runAsync(
      `INSERT INTO signatures (id, ticket_id, file_uri, signer_name, signer_role, latitude, longitude, after_seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sig.id,
      sig.ticket_id,
      sig.file_uri,
      sig.signer_name,
      sig.signer_role,
      sig.latitude,
      sig.longitude,
      sig.after_seq,
      sig.created_at,
    );
  });
  return replaced;
}

export async function listSignatures(ticketId?: UUID): Promise<PendingSignature[]> {
  const db = await getDb();
  if (ticketId) {
    return db.getAllAsync<PendingSignature>("SELECT * FROM signatures WHERE ticket_id = ? ORDER BY created_at", ticketId);
  }
  return db.getAllAsync<PendingSignature>("SELECT * FROM signatures ORDER BY after_seq, created_at");
}

export async function deleteSignature(id: string, db?: DB): Promise<void> {
  if (!db) return transaction((txn) => deleteSignature(id, txn));
  await db.runAsync("DELETE FROM signatures WHERE id = ?", id);
}

/** Conta a tentativa antes de enviar (como as fotos): um envio interrompido é conferido antes de repetir. */
export async function markSignatureAttempt(db: DB, id: string): Promise<void> {
  await db.runAsync("UPDATE signatures SET attempts = attempts + 1 WHERE id = ?", id);
}

export async function markSignatureError(id: string, error: string, db?: DB): Promise<void> {
  if (!db) return transaction((txn) => markSignatureError(id, error, txn));
  await db.runAsync("UPDATE signatures SET last_error = ? WHERE id = ?", error, id);
}

/** Recusada por formulário incompleto no servidor: fica guardada, esperando a conclusão. */
export async function markSignatureBlocked(db: DB, id: string, reason: string): Promise<void> {
  await db.runAsync("UPDATE signatures SET last_error = ?, blocked_reason = ? WHERE id = ?", reason, reason, id);
}

/** Uma conclusão de formulário entrou na fila: a assinatura da OS volta a ser enviada depois dela. */
export async function clearSignatureBlock(db: DB, ticketId: UUID): Promise<void> {
  await db.runAsync("UPDATE signatures SET blocked_reason = NULL WHERE ticket_id = ?", ticketId);
}

// ───────────────────────── rastreamento ─────────────────────────

export interface Ping {
  recorded_at: string;
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading: number | null;
  battery_pct: number | null;
  is_mock: boolean;
}

/**
 * Põe pontos na fila numa instrução só (dentro da transação de quem chama, junto com o marcador
 * do último ponto). Repetidos são ignorados. Nenhuma tela lista os pontos: a escrita é silenciosa.
 */
export async function insertPingRows(db: DB, pings: Ping[]): Promise<void> {
  if (!pings.length) return;
  await db.runAsync(
    `INSERT OR IGNORE INTO pings (recorded_at, latitude, longitude, accuracy_m, speed_mps, heading, battery_pct, is_mock)
     SELECT json_extract(value, '$.recorded_at'), json_extract(value, '$.latitude'), json_extract(value, '$.longitude'),
            json_extract(value, '$.accuracy_m'), json_extract(value, '$.speed_mps'), json_extract(value, '$.heading'),
            json_extract(value, '$.battery_pct'), json_extract(value, '$.is_mock')
       FROM json_each(?)`,
    JSON.stringify(pings.map((p) => ({ ...p, is_mock: p.is_mock ? 1 : 0 }))),
  );
}

export async function listPings(limit: number): Promise<Ping[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Omit<Ping, "is_mock"> & { is_mock: number }>(
    "SELECT * FROM pings ORDER BY recorded_at LIMIT ?",
    limit,
  );
  return rows.map((r) => ({ ...r, is_mock: r.is_mock === 1 }));
}

/** Tira da fila os pontos enviados (silencioso; `guard` cancela se o técnico logado mudou). */
export async function deletePings(recordedAts: string[], guard?: () => boolean): Promise<void> {
  if (!recordedAts.length) return;
  await transaction(
    async (db) => {
      await db.runAsync("DELETE FROM pings WHERE recorded_at IN (SELECT value FROM json_each(?))", JSON.stringify(recordedAts));
    },
    { notify: false, guard },
  );
}

export async function countPings(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM pings");
  return row?.n ?? 0;
}

/** Hora do ponto mais antigo ainda na fila (null se vazia). */
export async function oldestPingAt(): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ at: string | null }>("SELECT MIN(recorded_at) AS at FROM pings");
  return row?.at ?? null;
}

// ─────────────────────────── geral ────────────────────────────

/**
 * OS fechadas/canceladas há mais de 30 dias saem do aparelho (o servidor continua com elas), junto
 * com o que sobrou delas: cache de anexos, motivo de formulário recusado e avisos antigos.
 */
export async function pruneOld(db: DB): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  await db.runAsync(
    `DELETE FROM tickets WHERE status IN ('closed', 'cancelled') AND updated_at < ?
       AND id NOT IN (SELECT ticket_id FROM outbox)`,
    cutoff,
  );
  await db.runAsync("DELETE FROM comments WHERE ticket_id NOT IN (SELECT id FROM tickets) AND local_state IS NULL");
  await db.runAsync("DELETE FROM worklogs WHERE ticket_id NOT IN (SELECT id FROM tickets) AND local_state IS NULL");
  // 'attachments:' tem 12 caracteres e 'form_error:' 11: o id começa logo depois.
  await db.runAsync("DELETE FROM kv WHERE key GLOB 'attachments:*' AND substr(key, 13) NOT IN (SELECT id FROM tickets)");
  await db.runAsync(
    `DELETE FROM kv WHERE key GLOB 'form_error:*' AND substr(key, 12) NOT IN (
       SELECT json_extract(f.value, '$.id') FROM tickets t, json_each(json_extract(t.server_json, '$.forms')) f
        WHERE json_extract(f.value, '$.id') IS NOT NULL)`,
  );
  // Chave apagada com valor nulo (ex.: motivo de formulário já resolvido) é o mesmo que não existir.
  await db.runAsync("DELETE FROM kv WHERE value IS NULL");
  await db.runAsync("DELETE FROM notices WHERE created_at < ?", cutoff);
}

/** Apaga tudo (troca de usuário no aparelho). */
export async function resetLocalData(): Promise<void> {
  await transaction(async (db) => {
    for (const table of ["kv", "tickets", "comments", "worklogs", "outbox", "photos", "notices", "pings", "signatures"]) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
  });
}

export { notifyDataChanged };
