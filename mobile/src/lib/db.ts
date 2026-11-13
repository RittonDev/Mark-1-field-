// Banco local (expo-sqlite). Guarda as OS do técnico, acompanhamentos, apontamentos,
// a fila de operações para POST /sync/push, as fotos aguardando upload e os avisos
// de operações recusadas pelo servidor.

import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";
import { notifyDataChanged } from "./changes";
import { rebase } from "./ops";
import type { LocalTicket, OutboxOp, SyncOperation } from "./syncTypes";
import type { Attachment, Comment, TicketDetail, UnproductiveReason, User, UUID, ViolationReason, Worklog } from "./types";

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

export async function saveUnproductiveReasons(reasons: UnproductiveReason[]): Promise<void> {
  await transaction(async (db) => {
    await setKv(UNPRODUCTIVE_KEY, JSON.stringify(reasons), db);
    await setKv(UNPRODUCTIVE_AT_KEY, new Date().toISOString(), db);
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

/** Fila em ordem; `maxSeq` limita às operações feitas até um ponto (ex.: antes de uma assinatura). */
export async function listOutbox(limit = 1000, db?: DB, maxSeq?: number): Promise<OutboxOp[]> {
  const conn = db ?? (await getDb());
  const rows =
    maxSeq === undefined
      ? await conn.getAllAsync<OutboxRow>("SELECT * FROM outbox ORDER BY seq LIMIT ?", limit)
      : await conn.getAllAsync<OutboxRow>("SELECT * FROM outbox WHERE seq <= ? ORDER BY seq LIMIT ?", maxSeq, limit);
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
  for (const id of clientOpIds) {
    await db.runAsync("UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE client_op_id = ?", error, id);
  }
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

// ─────────────────── anexos, formulários e assinatura ───────────────────

const attachmentsKey = (ticketId: UUID) => `attachments:${ticketId}`;
const formErrorKey = (formId: UUID) => `form_error:${formId}`;

/** Última lista de anexos vista online (conta as fotos de cada campo de formulário offline). */
export async function getAttachmentsCache(ticketId: UUID): Promise<Attachment[]> {
  const raw = await getKv(attachmentsKey(ticketId));
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
}

/** Assinatura colhida no aparelho; substitui uma anterior ainda não enviada da mesma OS. */
export async function insertSignature(sig: Omit<PendingSignature, "attempts" | "last_error">): Promise<string[]> {
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

export async function markSignatureError(id: string, error: string): Promise<void> {
  await transaction(async (db) => {
    await db.runAsync("UPDATE signatures SET attempts = attempts + 1, last_error = ? WHERE id = ?", error, id);
  });
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

export async function insertPings(pings: Ping[]): Promise<void> {
  if (!pings.length) return;
  await transaction(async (db) => {
    for (const p of pings) {
      await db.runAsync(
        `INSERT OR IGNORE INTO pings (recorded_at, latitude, longitude, accuracy_m, speed_mps, heading, battery_pct, is_mock)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        p.recorded_at,
        p.latitude,
        p.longitude,
        p.accuracy_m,
        p.speed_mps,
        p.heading,
        p.battery_pct,
        p.is_mock ? 1 : 0,
      );
    }
  });
}

export async function listPings(limit: number): Promise<Ping[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Omit<Ping, "is_mock"> & { is_mock: number }>(
    "SELECT * FROM pings ORDER BY recorded_at LIMIT ?",
    limit,
  );
  return rows.map((r) => ({ ...r, is_mock: r.is_mock === 1 }));
}

export async function deletePings(recordedAts: string[]): Promise<void> {
  if (!recordedAts.length) return;
  await transaction(async (db) => {
    for (const at of recordedAts) await db.runAsync("DELETE FROM pings WHERE recorded_at = ?", at);
  });
}

export async function countPings(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM pings");
  return row?.n ?? 0;
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
    for (const table of ["kv", "tickets", "comments", "worklogs", "outbox", "photos", "notices", "pings", "signatures"]) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
  });
}

export { notifyDataChanged };
