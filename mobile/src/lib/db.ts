// Banco local (expo-sqlite). Guarda as OS do técnico, acompanhamentos, apontamentos,
// a fila de operações para POST /sync/push, as fotos aguardando upload e os avisos
// de operações recusadas pelo servidor.

import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";
import { notifyDataChanged } from "./changes";
import { rebase } from "./ops";
import type { LocalTicket, OutboxOp, SyncOperation } from "./syncTypes";
import type { Comment, TicketDetail, User, UUID, ViolationReason, Worklog } from "./types";

type DB = SQLite.SQLiteDatabase;

const IS_WEB = Platform.OS === "web";

/**
 * Android/iOS: transação exclusiva (conexão própria). Na pré-visualização web o expo-sqlite
 * não tem transação exclusiva; usa a comum na mesma conexão (a fila de escrita abaixo já serializa).
 */
function inTransaction(db: DB, task: (db: DB) => Promise<void>): Promise<void> {
  return IS_WEB ? db.withTransactionAsync(() => task(db)) : db.withExclusiveTransactionAsync(task);
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
];

let dbPromise: Promise<DB> | null = null;

async function migrate(db: DB) {
  const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    const next = version + 1;
    await inTransaction(db, async (txn) => {
      await txn.execAsync(sql);
      await txn.execAsync(`PRAGMA user_version = ${next}`);
    });
    version = next;
  }
}

export function getDb(): Promise<DB> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("maxxchamados.db");
      // Na web (pré-visualização, OPFS) o WAL não se aplica.
      if (!IS_WEB) await db.execAsync("PRAGMA journal_mode = WAL;");
      await migrate(db);
      return db;
    })();
  }
  return dbPromise;
}

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Transação exclusiva. Cada uma abre a própria conexão no expo-sqlite, então todas as
 * escritas passam por esta fila em JS: duas transações nunca disputam o lock (SQLITE_BUSY).
 * Não chame transaction() de dentro de outra — use o `db` recebido.
 */
export async function transaction(task: (db: DB) => Promise<void>): Promise<void> {
  const run = writeQueue.then(async () => {
    const db = await getDb();
    await inTransaction(db, task);
  });
  writeQueue = run.catch(() => undefined);
  await run;
  notifyDataChanged();
}

// ───────────────────────────── kv ─────────────────────────────

export async function getKv(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string | null }>("SELECT value FROM kv WHERE key = ?", key);
  return row?.value ?? null;
}

/** Dentro de uma transação, passe o `db` dela; fora, a escrita entra na fila de transações. */
export async function setKv(key: string, value: string | null, db?: DB): Promise<void> {
  if (!db) return transaction((txn) => setKv(key, value, txn));
  await db.runAsync("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

// ─────────────────── motivos de violação de SLA ──────────────────

const REASONS_KEY = "violation_reasons";
const REASONS_AT_KEY = "violation_reasons_at";

/** Cadastro de motivos guardado no aparelho, para o diálogo de resolver funcionar offline. */
export async function getViolationReasons(): Promise<ViolationReason[]> {
  const raw = await getKv(REASONS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ViolationReason[];
  } catch {
    return [];
  }
}

export async function getViolationReasonsAt(): Promise<string | null> {
  return getKv(REASONS_AT_KEY);
}

export async function saveViolationReasons(reasons: ViolationReason[]): Promise<void> {
  await transaction(async (db) => {
    await setKv(REASONS_KEY, JSON.stringify(reasons), db);
    await setKv(REASONS_AT_KEY, new Date().toISOString(), db);
  });
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

export async function listOutbox(limit = 1000, db?: DB): Promise<OutboxOp[]> {
  const conn = db ?? (await getDb());
  const rows = await conn.getAllAsync<OutboxRow>("SELECT * FROM outbox ORDER BY seq LIMIT ?", limit);
  return rows.map(toOp);
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

export async function markOpsAttempt(db: DB, clientOpIds: string[], error: string | null): Promise<void> {
  for (const id of clientOpIds) {
    await db.runAsync("UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE client_op_id = ?", error, id);
  }
}

export async function countPending(): Promise<{ ops: number; photos: number }> {
  const db = await getDb();
  const ops = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
  const photos = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM photos");
  return { ops: ops?.n ?? 0, photos: photos?.n ?? 0 };
}

// ─────────────────────────── tickets ──────────────────────────

/** Grava a versão do servidor e recalcula a efetiva com as operações pendentes. */
export async function saveServerTicket(db: DB, ticket: TicketDetail, user: User): Promise<void> {
  const local = rebase(ticket, await opsForTicket(db, ticket.id), user);
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
  const local = rebase(JSON.parse(row.server_json) as TicketDetail, await opsForTicket(db, ticketId), user);
  await db.runAsync(
    "UPDATE tickets SET json = ?, status = ?, assignee_id = ?, scheduled_start = ? WHERE id = ?",
    JSON.stringify(local),
    local.status,
    local.assignee?.id ?? null,
    local.scheduled_start,
    ticketId,
  );
}

export async function deleteTicket(db: DB, ticketId: UUID): Promise<void> {
  await db.runAsync("DELETE FROM tickets WHERE id = ?", ticketId);
  await db.runAsync("DELETE FROM comments WHERE ticket_id = ?", ticketId);
  await db.runAsync("DELETE FROM worklogs WHERE ticket_id = ?", ticketId);
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
}

export async function insertPhoto(photo: Omit<PendingPhoto, "attempts" | "last_error">): Promise<void> {
  await transaction(async (db) => {
    await db.runAsync(
      "INSERT INTO photos (id, ticket_id, file_uri, filename, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      photo.id,
      photo.ticket_id,
      photo.file_uri,
      photo.filename,
      photo.mime_type,
      photo.created_at,
    );
  });
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

export async function markPhotoError(id: string, error: string): Promise<void> {
  await transaction(async (db) => {
    await db.runAsync("UPDATE photos SET attempts = attempts + 1, last_error = ? WHERE id = ?", error, id);
  });
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

// ─────────────────────────── geral ────────────────────────────

/** OS fechadas/canceladas há mais de 30 dias saem do aparelho (o servidor continua com elas). */
export async function pruneOld(db: DB): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  await db.runAsync(
    `DELETE FROM tickets WHERE status IN ('closed', 'cancelled') AND updated_at < ?
       AND id NOT IN (SELECT ticket_id FROM outbox)`,
    cutoff,
  );
  await db.runAsync("DELETE FROM comments WHERE ticket_id NOT IN (SELECT id FROM tickets) AND local_state IS NULL");
  await db.runAsync("DELETE FROM worklogs WHERE ticket_id NOT IN (SELECT id FROM tickets) AND local_state IS NULL");
}

/** Apaga tudo (troca de usuário no aparelho). */
export async function resetLocalData(): Promise<void> {
  await transaction(async (db) => {
    for (const table of ["kv", "tickets", "comments", "worklogs", "outbox", "photos", "notices"]) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
  });
}

export { notifyDataChanged };
