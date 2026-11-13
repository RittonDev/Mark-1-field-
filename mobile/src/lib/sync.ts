// Motor de sincronização offline-first (docs/MOBILE_SYNC.md).
//
// Cada rodada: envia a fila (POST /sync/push), baixa o delta (GET /sync/pull?since=)
// até has_more = false e sobe as fotos pendentes. Rodadas nunca correm em paralelo;
// um pedido durante uma rodada agenda outra logo depois.
//
// Gatilhos: login/abertura do app, rede voltando, app voltando ao primeiro plano,
// cada ação do técnico, cada evento do WebSocket e um intervalo de segurança.

import NetInfo from "@react-native-community/netinfo";
import { randomUUID } from "expo-crypto";
import { deleteAllPhotoFiles, deletePhotoFile, persistPhoto, photoExists } from "./photoFiles";
import { useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { api, ApiError, errorMessage, uploadFile } from "./api";
import { STATUS } from "./constants";
import {
  addNotice,
  countPending,
  deleteLocalDraft,
  deleteOp,
  dropFormDrafts,
  deleteSignature,
  deletePhoto,
  deleteTicket,
  getAttachmentsCache,
  getDb,
  getKv,
  getTicket,
  getUnproductiveReasonsAt,
  getViolationReasonsAt,
  insertLocalComment,
  insertLocalWorklog,
  addPartAttachment,
  insertOp,
  insertPhoto,
  insertPhotoRow,
  partOpsWithPendingPhotos,
  insertSignature,
  listOutbox,
  listPhotos,
  listTickets,
  listSignatures,
  markLocalSent,
  markOpsAttempt,
  markPhotoError,
  markSignatureError,
  maxOutboxSeq,
  pruneOld,
  purgeSentDrafts,
  rebaseTicket,
  resetLocalData,
  saveServerComment,
  saveServerTicket,
  saveServerWorklog,
  saveUnproductiveReasons,
  saveViolationReasons,
  setAttachmentsCache,
  setFormError,
  setKv,
  transaction,
  type PendingPhoto,
  type PendingSignature,
} from "./db";
import { AUTHORIZATION_ERROR, setFieldRules } from "./field";
import { isDone, isHelper } from "./lists";
import { haptic } from "./haptics";
import { syncOnsiteAlerts } from "./onsiteAlerts";
import { userRef } from "./ops";
import { showSuccess } from "./success";
import { RealtimeClient, type RealtimeState } from "./realtime";
import { session } from "./session";
import type {
  CommentCreatePayload,
  FormAnswersPayload,
  PartRequestPayload,
  UnproductivePayload,
  OutboxOp,
  SyncOperation,
  SyncOperationIn,
  SyncPullResponse,
  SyncPushResponse,
  WorklogCreatePayload,
} from "./syncTypes";
import { showToast } from "./toast";
import { flushPings, resumeTracking, updateTrackingMode } from "./tracking";
import type {
  Attachment,
  FieldRules,
  RealtimeEvent,
  TicketDetail,
  TicketTransitionPayload,
  UnproductiveReason,
  User,
  UUID,
  ViolationReason,
} from "./types";

const PUSH_BATCH = 100; // a API aceita até 200 por lote
const SAFETY_INTERVAL_MS = 90_000;
const SINCE_KEY = "sync_since";

// ───────────────────────────── estado ─────────────────────────────

export interface SyncStatus {
  /** Conectividade do aparelho (NetInfo). */
  network: "unknown" | "online" | "offline";
  /** Resultado da última conversa com a API. */
  server: "unknown" | "reachable" | "unreachable";
  realtime: RealtimeState;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingOps: number;
  pendingPhotos: number;
}

let status: SyncStatus = {
  network: "unknown",
  server: "unknown",
  realtime: "off",
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  pendingOps: 0,
  pendingPhotos: 0,
};
const listeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getStatus = () => status;

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, getStatus, getStatus);
}

export const isOnline = (s: SyncStatus = status) => s.network !== "offline" && s.server !== "unreachable";

async function refreshPendingCounts() {
  const { ops, photos } = await countPending();
  setStatus({ pendingOps: ops, pendingPhotos: photos });
}

function currentUser(): User {
  const user = session.get().user;
  if (!user) throw new Error("Sessão encerrada");
  return user;
}

// ───────────────────────────── rodada ─────────────────────────────

let running: Promise<void> | null = null;
let again = false;

/** Pede uma sincronização. Resolve quando a rodada (e as que forem pedidas durante ela) terminar. */
export function requestSync(): Promise<void> {
  if (session.get().status !== "signedIn") return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await runOnce();
      } while (again && session.get().status === "signedIn");
    } finally {
      running = null;
    }
  })();
  return running;
}

async function runOnce() {
  if (status.network === "offline") {
    await refreshPendingCounts();
    return;
  }
  setStatus({ syncing: true });
  try {
    // Ordem causal: fotos (inclusive de campos de formulário) → respostas/conclusões →
    // assinatura → o restante (ex.: "Resolver"), que o servidor só aceita depois dela.
    await uploadPhotos();
    await pushWithSignatures();
    await pullChanges();
    await revalidateHelperTickets();
    await refreshFieldRules();
    await refreshViolationReasons();
    // Alertas locais do tempo na loja (aviso faltando 30 min e no estouro das 4h).
    void syncOnsiteAlerts();
    // Rastreamento da jornada: sobe a fila de pontos e ajusta o ritmo (deslocamento = mais frequente).
    await flushPings(true);
    await updateTrackingMode();
    setStatus({ server: "reachable", lastSyncAt: new Date().toISOString(), lastError: null });
  } catch (error) {
    if (error instanceof ApiError && error.status === 0) {
      setStatus({ server: "unreachable", lastError: error.message });
    } else {
      setStatus({ server: "reachable", lastError: errorMessage(error) });
    }
  } finally {
    await refreshPendingCounts().catch(() => undefined);
    setStatus({ syncing: false });
  }
}

// ───────────────────────────── push ─────────────────────────────

function toWire(op: OutboxOp): SyncOperationIn {
  return {
    client_op_id: op.client_op_id,
    type: op.type,
    ticket_id: op.ticket_id,
    payload: op.payload,
    client_timestamp: op.client_timestamp,
  };
}

/** O backend monta erros de validação como "campo: Value error, msg" (com campo vazio no nível do modelo). */
function cleanServerError(error: string | null): string {
  if (!error) return "regra de negócio";
  return error
    .split("; ")
    .map((part) => part.replace(/^:\s*/, "").replace(/Value error, /g, ""))
    .join("; ");
}

export function describeOp(op: SyncOperation): string {
  switch (op.type) {
    case "transition":
      return `Mudança para "${STATUS[op.payload.to_status]?.label ?? op.payload.to_status}"`;
    case "comment":
      return op.payload.is_internal ? "Nota interna" : "Acompanhamento";
    case "worklog":
      return "Apontamento de horas";
    case "update":
      return "Edição da OS";
    case "form_answers":
      return op.payload.complete ? "Conclusão de formulário" : "Respostas de formulário";
    case "unproductive":
      return "Visita improdutiva";
    case "part_request":
      return `Pedido de peça (${op.payload.description})`;
  }
}

/** Envia a fila em fases: tudo até cada assinatura pendente, a assinatura, e então o resto. */
async function pushWithSignatures() {
  for (const signature of await listSignatures()) {
    await pushOutbox(signature.after_seq);
    await uploadSignature(signature);
  }
  await pushOutbox();
}

const FORM_INCOMPLETE = /falta preencher/i;

async function pushOutbox(maxSeq?: number) {
  for (let round = 0; round < 50; round++) {
    // Pedido de peça com foto ainda no aparelho espera a foto subir (leva os ids dos anexos).
    const waiting = await partOpsWithPendingPhotos();
    const ops = (await listOutbox(PUSH_BATCH, undefined, maxSeq)).filter(
      (op) => !(op.type === "part_request" && waiting.has(op.client_op_id)),
    );
    if (!ops.length) return;
    const user = currentUser();
    const byId = new Map(ops.map((op) => [op.client_op_id, op]));

    let response: SyncPushResponse;
    try {
      response = await api.post<SyncPushResponse>("/sync/push", { operations: ops.map(toWire) });
    } catch (error) {
      if (error instanceof ApiError && !error.retryable && error.status !== 401) {
        // O lote inteiro foi recusado (validação do envelope): reenviar igual não adianta.
        await transaction(async (db) => {
          for (const op of ops) {
            const ticket = await getTicket(op.ticket_id, db);
            await deleteOp(db, op.client_op_id);
            await deleteLocalDraft(db, op.client_op_id);
            await addNotice(db, {
              ticket_id: op.ticket_id,
              ticket_code: ticket?.code ?? null,
              kind: "rejected",
              message: `${describeOp(op)}: o servidor recusou — ${cleanServerError(error.message)}`,
            });
            await rebaseTicket(db, op.ticket_id, user);
          }
        });
        continue;
      }
      const message = errorMessage(error);
      await transaction((db) => markOpsAttempt(db, ops.map((op) => op.client_op_id), message));
      throw error;
    }

    const problems: string[] = [];
    let unauthorized = false;
    await transaction(async (db) => {
      const latest = new Map<UUID, TicketDetail | null>();
      for (const result of response.results) {
        const op = byId.get(result.client_op_id);
        if (!op) continue;
        await deleteOp(db, op.client_op_id);
        if (result.status === "applied" || result.status === "duplicate") {
          await markLocalSent(db, op.client_op_id);
          if (op.type === "form_answers" && op.payload.complete) await setFormError(op.payload.form_id, null, db);
        } else {
          const ticket = result.ticket ?? (await getTicket(op.ticket_id, db));
          await deleteLocalDraft(db, op.client_op_id);
          let message =
            result.status === "conflict"
              ? `${describeOp(op)}: descartado porque a OS foi alterada por outra pessoa. Confira o estado atual.`
              : `${describeOp(op)}: o servidor recusou — ${cleanServerError(result.error)}`;
          // 422 da promessa de campo: a visita ainda não foi autorizada pelo cliente.
          if (op.type === "transition" && AUTHORIZATION_ERROR.test(result.error ?? "")) {
            message = `${describeOp(op)} desfeita: o cliente ainda não autorizou a visita. Aguarde a central liberar.`;
            unauthorized = true;
          }
          if (op.type === "form_answers") {
            await setFormError(op.payload.form_id, cleanServerError(result.error), db);
            // Conclusão recusada por falta de item: o servidor não gravou nada. Reenvia as mesmas
            // respostas sem concluir, para o técnico não perder o que preencheu.
            if (op.payload.complete && FORM_INCOMPLETE.test(result.error ?? "")) {
              await insertOp(db, {
                type: "form_answers",
                payload: { ...op.payload, complete: false },
                client_op_id: randomUUID(),
                ticket_id: op.ticket_id,
                client_timestamp: new Date().toISOString(),
              });
              message = `Formulário não concluído — ${cleanServerError(result.error)}. As respostas foram mantidas.`;
            }
          }
          await addNotice(db, { ticket_id: op.ticket_id, ticket_code: ticket?.code ?? null, kind: result.status, message });
          problems.push(`${ticket?.code ?? "OS"}: ${message}`);
        }
        if (result.ticket) latest.set(op.ticket_id, result.ticket);
        else if (!latest.has(op.ticket_id)) latest.set(op.ticket_id, null);
      }
      for (const [ticketId, ticket] of latest) {
        if (ticket) await saveServerTicket(db, ticket, user);
        else await rebaseTicket(db, ticketId, user);
      }
    });
    if (problems.length) {
      if (unauthorized) haptic.warning();
      showToast(
        unauthorized && problems.length === 1
          ? "Visita aguardando autorização"
          : problems.length === 1
            ? "Uma operação não foi aceita"
            : `${problems.length} operações não foram aceitas`,
        { description: problems[0], tone: unauthorized ? "info" : "error" },
      );
    }
    // Resposta sem resultado para alguma operação: ela fica na fila e volta na próxima rodada.
    if (response.results.length === 0) return;
  }
}

// ───────────────────────────── pull ─────────────────────────────

async function pullChanges() {
  for (let page = 0; page < 100; page++) {
    const since = await getKv(SINCE_KEY);
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    const data = await api.get<SyncPullResponse>(`/sync/pull${query}`);
    const user = currentUser();
    const news: FieldNews[] = [];
    await transaction(async (db) => {
      for (const ticket of data.tickets) {
        const before = await getTicket(ticket.id, db);
        if (before) news.push(...fieldNews(before, ticket, user));
        await saveServerTicket(db, ticket, user);
      }
      for (const comment of data.comments) await saveServerComment(db, comment);
      for (const worklog of data.worklogs) await saveServerWorklog(db, worklog);
      for (const id of data.revoked_ticket_ids) await deleteTicket(db, id);
      if (!data.has_more) {
        await purgeSentDrafts(db);
        await pruneOld(db);
      }
      await setKv(SINCE_KEY, data.server_time, db);
    });
    announceFieldNews(news);
    if (data.revoked_ticket_ids.length) {
      showToast(
        data.revoked_ticket_ids.length === 1
          ? "Uma OS foi reatribuída e saiu da sua lista"
          : `${data.revoked_ticket_ids.length} OS foram reatribuídas e saíram da sua lista`,
      );
    }
    if (!data.has_more) return;
  }
}

type FieldNews =
  | { kind: "part_approved" | "part_rejected"; code: string; description: string }
  | { kind: "authorized" | "denied"; code: string; by: string | null };

/** O que mudou entre a OS no aparelho e a recebida e merece aviso ao técnico. */
function fieldNews(before: TicketDetail, after: TicketDetail, user: User): FieldNews[] {
  if (after.assignee?.id !== user.id) return [];
  const news: FieldNews[] = [];
  const previous = new Map((before.part_requests ?? []).map((r) => [r.id, r.status]));
  for (const request of after.part_requests ?? []) {
    const was = previous.get(request.id);
    if (was && was !== "approved" && request.status === "approved") {
      news.push({ kind: "part_approved", code: after.code, description: request.description });
    } else if (was && was !== "rejected" && request.status === "rejected") {
      news.push({ kind: "part_rejected", code: after.code, description: request.description });
    }
  }
  const auth = after.authorization_status;
  if (before.authorization_status === "pending" && (auth === "authorized" || auth === "denied")) {
    news.push({ kind: auth, code: after.code, by: after.authorized_by_name ?? null });
  }
  return news;
}

function announceFieldNews(news: FieldNews[]) {
  const approved = news.filter((n): n is Extract<FieldNews, { description: string }> => n.kind === "part_approved");
  if (approved.length) {
    haptic.success();
    showSuccess(
      approved.length === 1 ? "Peça aprovada" : `${approved.length} peças aprovadas`,
      approved.length === 1
        ? `${approved[0].code} · ${approved[0].description}: pode instalar.`
        : "O cliente aprovou o orçamento: pode instalar.",
    );
  }
  for (const n of news) {
    if (n.kind === "authorized") {
      haptic.step();
      showToast(`${n.code} autorizada`, {
        tone: "success",
        description: `${n.by ? `Autorizada por ${n.by}. ` : ""}Pode iniciar o deslocamento.`,
      });
    } else if (n.kind === "denied") {
      haptic.warning();
      showToast(`${n.code}: visita não autorizada`, { tone: "error", description: "Fale com a central no grupo." });
    } else if (n.kind === "part_rejected") {
      haptic.warning();
      showToast(`${n.code}: peça recusada`, {
        tone: "error",
        description: `${n.description}: o cliente não aprovou o orçamento. Não instale; fale com a central no grupo.`,
      });
    }
  }
}

const FIELD_RULES_KEY = "field_rules";

/** Regras de campo da empresa (GET /settings/field). Enquanto a rota não existir (404), valem as da promessa. */
let fieldRulesAt = 0;

async function refreshFieldRules() {
  if (!forceReasons && Date.now() - fieldRulesAt < 30 * 60_000) return;
  try {
    const rules = await api.get<FieldRules>("/settings/field");
    setFieldRules(rules);
    await setKv(FIELD_RULES_KEY, JSON.stringify(rules));
    fieldRulesAt = Date.now();
  } catch (error) {
    if (error instanceof ApiError && error.status === 0) throw error;
    // 404 (servidor antigo) ou outro erro: segue com as regras guardadas/da promessa e tenta mais tarde.
    fieldRulesAt = Date.now();
  }
}

/** Regras guardadas no aparelho (valem offline desde a abertura do app). */
export async function loadFieldRules() {
  try {
    const raw = await getKv(FIELD_RULES_KEY);
    if (raw) setFieldRules(JSON.parse(raw) as FieldRules);
  } catch {
    // padrão da promessa
  }
}

const REASONS_MAX_AGE_MS = 6 * 3600_000;
let forceReasons = false;

/**
 * Cadastro de motivos de violação de SLA (GET /violation-reasons?active=true), guardado no SQLite.
 * Muda pouco: baixa na primeira vez, a cada 6 h ou em "Baixar tudo". Falha aqui não derruba a rodada.
 */
async function refreshViolationReasons() {
  const stale = (at: string | null) => forceReasons || !at || Date.now() - new Date(at).getTime() >= REASONS_MAX_AGE_MS;
  try {
    if (stale(await getViolationReasonsAt())) {
      await saveViolationReasons(await api.get<ViolationReason[]>("/violation-reasons?active=true"));
    }
    // Motivos de visita improdutiva: mesmo ciclo (o técnico registra a visita offline).
    if (stale(await getUnproductiveReasonsAt())) {
      await saveUnproductiveReasons(await api.get<UnproductiveReason[]>("/unproductive-reasons?active=true"));
    }
    forceReasons = false;
  } catch (error) {
    if (error instanceof ApiError && error.status === 0) throw error;
    console.warn("Não foi possível atualizar os cadastros de motivos", error);
  }
}

/**
 * Confere uma OS direto na API. Sem acesso (o técnico saiu da visita ou ela foi reatribuída), sai do
 * aparelho: o `revoked_ticket_ids` do pull só cobre reatribuição, não a saída da equipe da visita.
 */
async function revalidateTicket(ticketId: UUID): Promise<void> {
  try {
    await storeServerTicket(await api.get<TicketDetail>(`/tickets/${ticketId}`));
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) return;
    const local = await getTicket(ticketId);
    await transaction((db) => deleteTicket(db, ticketId));
    if (local) showToast(`${local.code} saiu da sua lista`, { description: "Você não está mais na visita desta OS." });
  }
}

let helpersCheckedAt = 0;

/** Rede de segurança (a cada 10 min): as OS em que o técnico vai junto ainda são dele? */
async function revalidateHelperTickets() {
  if (Date.now() - helpersCheckedAt < 10 * 60_000) return;
  helpersCheckedAt = Date.now();
  const user = currentUser();
  for (const ticket of await listTickets()) {
    if (isHelper(ticket, user) && !isDone(ticket.status)) await revalidateTicket(ticket.id);
  }
}

/** Busca uma OS direto na API (após "assumir", por exemplo) e grava localmente. */
export async function storeServerTicket(ticket: TicketDetail) {
  const user = currentUser();
  await transaction((db) => saveServerTicket(db, ticket, user));
}

// ───────────────────────────── fotos ─────────────────────────────

async function uploadPhotos() {
  const photos = await listPhotos();
  for (const photo of photos) {
    if (session.get().status !== "signedIn") return;
    if (!photoExists(photo.file_uri)) {
      await transaction(async (db) => {
        const ticket = await getTicket(photo.ticket_id, db);
        await addNotice(db, {
          ticket_id: photo.ticket_id,
          ticket_code: ticket?.code ?? null,
          kind: "photo",
          message: `A foto ${photo.filename} não está mais no aparelho e não foi enviada.`,
        });
        await db.runAsync("DELETE FROM photos WHERE id = ?", photo.id);
      });
      continue;
    }
    try {
      const isFormPhoto = Boolean(photo.form_id && photo.field_id);
      const attachment = await uploadFile<Attachment>(
        isFormPhoto ? `/tickets/${photo.ticket_id}/forms/${photo.form_id}/photos` : `/tickets/${photo.ticket_id}/attachments`,
        photo.file_uri,
        isFormPhoto ? { field_id: photo.field_id! } : { kind: "photo" },
        photo.mime_type,
        photo.filename,
      );
      // A foto sai da fila e entra no cache de anexos na mesma transação (a contagem do campo não pisca).
      await transaction(async (db) => {
        await db.runAsync("DELETE FROM photos WHERE id = ?", photo.id);
        if (attachment?.id) {
          const cached = await getAttachmentsCache(photo.ticket_id);
          if (!cached.some((a) => a.id === attachment.id)) await setAttachmentsCache(photo.ticket_id, [...cached, attachment], db);
          // Foto de pedido de peça: o id vai junto na operação, que só sai depois de todas as fotos.
          if (photo.part_op_id) await addPartAttachment(db, photo.part_op_id, attachment.id);
        }
      });
      deletePhotoFile(photo.file_uri);
    } catch (error) {
      if (error instanceof ApiError && (error.retryable || error.status === 401)) {
        await markPhotoError(photo.id, error.message);
        throw error;
      }
      await transaction(async (db) => {
        const ticket = await getTicket(photo.ticket_id, db);
        await addNotice(db, {
          ticket_id: photo.ticket_id,
          ticket_code: ticket?.code ?? null,
          kind: "photo",
          message: `Foto recusada pelo servidor: ${errorMessage(error)}`,
        });
        await db.runAsync("DELETE FROM photos WHERE id = ?", photo.id);
      });
      deletePhotoFile(photo.file_uri);
    }
  }
}

/**
 * Guarda a foto no app (o cache do picker pode ser limpo) e coloca na fila de upload.
 * Com `target`, é a foto de um campo de formulário.
 */
export async function queuePhoto(
  ticketId: UUID,
  sourceUri: string,
  mimeType: string | null | undefined,
  target?: { formId: UUID; fieldId: string },
) {
  const id = randomUUID();
  const mime = mimeType ?? "image/jpeg";
  const ext = mime === "image/png" ? "png" : mime === "image/heic" ? "heic" : "jpg";
  // O nome do arquivo é o que chega ao servidor no multipart.
  const filename = `foto-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${id.slice(0, 8)}.${ext}`;
  const fileUri = await persistPhoto(sourceUri, filename);
  await insertPhoto({
    id,
    ticket_id: ticketId,
    file_uri: fileUri,
    filename,
    mime_type: mime,
    created_at: new Date().toISOString(),
    form_id: target?.formId ?? null,
    field_id: target?.fieldId ?? null,
  });
  void requestSync();
}

/** Remove uma foto de campo já enviada (online; só quem enviou ou a gestão). */
export async function deleteFormPhoto(ticketId: UUID, formId: UUID, attachmentId: UUID) {
  await api.delete(`/tickets/${ticketId}/forms/${formId}/photos/${attachmentId}`);
  const cached = await getAttachmentsCache(ticketId);
  await setAttachmentsCache(
    ticketId,
    cached.filter((a) => a.id !== attachmentId),
  );
}

/** Busca os anexos da OS (online) e guarda no cache para contar as fotos dos campos offline. */
export async function refreshAttachments(ticketId: UUID): Promise<Attachment[]> {
  const list = await api.get<Attachment[]>(`/tickets/${ticketId}/attachments`);
  await setAttachmentsCache(ticketId, list);
  return list;
}

// ───────────────────────────── assinatura ─────────────────────────────

/**
 * Assinatura do responsável no local, colhida no aparelho (funciona offline). Entra na fila
 * depois de tudo o que já estava pendente (formulários), e antes do que vier depois ("Resolver").
 */
export async function queueSignature(
  ticketId: UUID,
  sourceUri: string,
  signer: { name: string; role: string | null; latitude: number | null; longitude: number | null },
) {
  const id = randomUUID();
  const filename = `assinatura-${id.slice(0, 8)}.png`;
  const fileUri = await persistPhoto(sourceUri, filename);
  const replaced = await insertSignature({
    id,
    ticket_id: ticketId,
    file_uri: fileUri,
    signer_name: signer.name,
    signer_role: signer.role,
    latitude: signer.latitude,
    longitude: signer.longitude,
    after_seq: await maxOutboxSeq(),
    created_at: new Date().toISOString(),
  });
  replaced.forEach(deletePhotoFile);
  await refreshPendingCounts();
  void requestSync();
}

async function uploadSignature(signature: PendingSignature) {
  if (!photoExists(signature.file_uri)) {
    await deleteSignature(signature.id);
    return;
  }
  const fields: Record<string, string> = { signer_name: signature.signer_name };
  if (signature.signer_role) fields.signer_role = signature.signer_role;
  if (signature.latitude !== null && signature.longitude !== null) {
    fields.latitude = String(signature.latitude);
    fields.longitude = String(signature.longitude);
  }
  try {
    const ticket = await uploadFile<TicketDetail>(
      `/tickets/${signature.ticket_id}/signature`,
      signature.file_uri,
      fields,
      "image/png",
      `assinatura-${signature.id.slice(0, 8)}.png`,
    );
    const user = currentUser();
    await transaction(async (db) => {
      await deleteSignature(signature.id, db);
      if (ticket?.id) await saveServerTicket(db, ticket, user);
    });
    deletePhotoFile(signature.file_uri);
  } catch (error) {
    if (error instanceof ApiError && (error.retryable || error.status === 401)) {
      await markSignatureError(signature.id, error.message);
      throw error;
    }
    // Recusada (ex.: formulário obrigatório incompleto): sai da fila e o técnico colhe de novo.
    await transaction(async (db) => {
      const ticket = await getTicket(signature.ticket_id, db);
      await addNotice(db, {
        ticket_id: signature.ticket_id,
        ticket_code: ticket?.code ?? null,
        kind: "rejected",
        message: `Assinatura de ${signature.signer_name}: o servidor recusou — ${errorMessage(error)}`,
      });
      await deleteSignature(signature.id, db);
    });
    deletePhotoFile(signature.file_uri);
    showToast("Assinatura não aceita", { description: errorMessage(error), tone: "error" });
  }
}

/**
 * Visita improdutiva pela fila de sync (funciona offline). A OS volta para "Atribuído" sem agenda,
 * sai da agenda do técnico e a central reagenda.
 */
export async function enqueueUnproductive(ticketId: UUID, payload: UnproductivePayload) {
  await enqueue(ticketId, { type: "unproductive", payload });
  // Se estava em deslocamento, o ritmo do rastreamento volta ao normal.
  void updateTrackingMode();
}

/**
 * Pedido de peça pela fila (funciona offline). As fotos ficam no aparelho, sobem como anexo
 * comum da OS e só então a operação sai, levando os ids (`attachment_ids`).
 */
export async function enqueuePartRequest(
  ticketId: UUID,
  payload: PartRequestPayload,
  photos: { uri: string; mimeType?: string | null }[],
) {
  const user = currentUser();
  const clientOpId = randomUUID();
  const createdAt = new Date().toISOString();
  const rows: Omit<PendingPhoto, "attempts" | "last_error">[] = [];
  for (const [i, photo] of photos.entries()) {
    const id = randomUUID();
    const mime = photo.mimeType ?? "image/jpeg";
    const ext = mime === "image/png" ? "png" : mime === "image/heic" ? "heic" : "jpg";
    const filename = `peca-${createdAt.slice(0, 19).replace(/[:T]/g, "-")}-${i + 1}-${id.slice(0, 6)}.${ext}`;
    const fileUri = await persistPhoto(photo.uri, filename);
    rows.push({ id, ticket_id: ticketId, file_uri: fileUri, filename, mime_type: mime, created_at: createdAt, form_id: null, field_id: null, part_op_id: clientOpId });
  }
  await transaction(async (db) => {
    for (const row of rows) await insertPhotoRow(db, row);
    await insertOp(db, {
      type: "part_request",
      payload: { ...payload, attachment_ids: [], client_id: clientOpId },
      client_op_id: clientOpId,
      ticket_id: ticketId,
      client_timestamp: createdAt,
    });
    await rebaseTicket(db, ticketId, user);
  });
  await refreshPendingCounts();
  void requestSync();
}

/** Respostas de formulário (Salvar) ou conclusão (Concluir), pela fila de sync. */
export function enqueueFormAnswers(ticketId: UUID, payload: FormAnswersPayload) {
  return enqueue(ticketId, { type: "form_answers", payload });
}

/** Apaga banco local e fotos pendentes (troca de usuário ou usuário sem acesso ao app). */
export async function wipeLocalData() {
  await resetLocalData();
  deleteAllPhotoFiles();
  await refreshPendingCounts();
}

export async function discardPhoto(id: string, fileUri: string) {
  await deletePhoto(id);
  deletePhotoFile(fileUri);
  await refreshPendingCounts();
}

// ───────────────────────────── ações do técnico ─────────────────────────────

async function enqueue(ticketId: UUID, operation: SyncOperation) {
  const user = currentUser();
  const clientOpId = randomUUID();
  const clientTimestamp = new Date().toISOString();
  await transaction(async (db) => {
    // O formulário salva sozinho a cada pergunta: a fila guarda só o rascunho mais recente.
    if (operation.type === "form_answers") await dropFormDrafts(db, ticketId, operation.payload.form_id);
    await insertOp(db, { ...operation, client_op_id: clientOpId, ticket_id: ticketId, client_timestamp: clientTimestamp });
    if (operation.type === "comment") {
      await insertLocalComment(db, {
        id: clientOpId,
        ticket_id: ticketId,
        author: userRef(user),
        body: operation.payload.body,
        is_internal: operation.payload.is_internal,
        created_at: clientTimestamp,
      });
    } else if (operation.type === "worklog") {
      const p = operation.payload;
      const minutes =
        p.minutes ?? (p.ended_at ? Math.round((new Date(p.ended_at).getTime() - new Date(p.started_at).getTime()) / 60000) : 0);
      await insertLocalWorklog(db, {
        id: clientOpId,
        ticket_id: ticketId,
        user: userRef(user),
        description: p.description,
        started_at: p.started_at,
        ended_at: p.ended_at ?? null,
        minutes,
        latitude: p.latitude ?? null,
        longitude: p.longitude ?? null,
        created_at: clientTimestamp,
      });
    }
    await rebaseTicket(db, ticketId, user);
  });
  await refreshPendingCounts();
  void requestSync();
}

/**
 * Mudança de status. Sem `expected_version`: para ações do próprio técnico em campo,
 * a última ação vale (docs/MOBILE_SYNC.md §3).
 */
export async function enqueueTransition(ticketId: UUID, payload: TicketTransitionPayload) {
  await enqueue(ticketId, { type: "transition", payload });
  // Entrar/sair de "Em deslocamento" muda o ritmo do rastreamento, mesmo offline.
  void updateTrackingMode();
  // Check-in agenda os alertas do tempo na loja; concluir cancela (também offline).
  void syncOnsiteAlerts();
}

export function enqueueComment(ticketId: UUID, payload: CommentCreatePayload) {
  return enqueue(ticketId, { type: "comment", payload });
}

export function enqueueWorklog(ticketId: UUID, payload: WorklogCreatePayload) {
  return enqueue(ticketId, { type: "worklog", payload });
}

/** Descarta uma operação ainda não enviada (tela Conta → pendências). */
export async function discardOp(op: OutboxOp) {
  const user = currentUser();
  const partPhotos =
    op.type === "part_request" ? (await listPhotos(op.ticket_id)).filter((p) => p.part_op_id === op.client_op_id) : [];
  await transaction(async (db) => {
    await deleteOp(db, op.client_op_id);
    await deleteLocalDraft(db, op.client_op_id);
    // Fotos de um pedido descartado não sobem soltas.
    for (const photo of partPhotos) await db.runAsync("DELETE FROM photos WHERE id = ?", photo.id);
    await rebaseTicket(db, op.ticket_id, user);
  });
  partPhotos.forEach((p) => deletePhotoFile(p.file_uri));
  await refreshPendingCounts();
}

// ───────────────────────────── ciclo de vida ─────────────────────────────

let stopFns: (() => void)[] = [];
let realtime: RealtimeClient | null = null;
let wsDebounce: ReturnType<typeof setTimeout> | undefined;

function describeEvent(event: RealtimeEvent, user: User): string | null {
  if (event.actor_id && event.actor_id === user.id) return null;
  const code = event.ticket_code ?? "OS";
  if (event.type === "ticket.assigned" && event.assignee_id === user.id) return `${code} foi atribuída a você`;
  if (event.type === "ticket.created" && event.assignee_id === user.id) return `Nova ${code} para você`;
  const addedIds = (event.data?.added_ids as string[] | undefined) ?? [];
  if (event.type === "ticket.helpers_changed" && addedIds.includes(user.id)) return `Você vai na visita da ${code}`;
  // "ticket.authorization" e "ticket.part_request_decided" só disparam o sync: o pull compara a OS
  // e avisa (autorizada/negada, peça aprovada com o check, peça recusada), sem aviso duplicado.
  // Acompanhamentos não fazem parte do app: a central fala com o técnico pelo grupo de WhatsApp.
  return null;
}

/** Liga rede, ciclo do app, WebSocket e o intervalo de segurança. Idempotente. */
export function startSync() {
  if (stopFns.length) return;
  let appState: AppStateStatus | string = AppState.currentState ?? "active";

  realtime = new RealtimeClient({
    onState: (state) => setStatus({ realtime: state }),
    onOpen: () => void requestSync(),
    onEvent: (event) => {
      const user = session.get().user;
      const text = user ? describeEvent(event, user) : null;
      if (text) showToast(text);
      clearTimeout(wsDebounce);
      wsDebounce = setTimeout(() => void requestSync(), 400);
      // Mudou a equipe da visita: quem saiu não recebe mais a OS no pull; confere direto na API.
      const removedMe = user && event.ticket_id && !((event.data?.added_ids as string[] | undefined) ?? []).includes(user.id);
      if (event.type === "ticket.helpers_changed" && removedMe && event.ticket_id) {
        const ticketId = event.ticket_id;
        void getTicket(ticketId).then((local) => (local && user && isHelper(local, user) ? revalidateTicket(ticketId) : undefined));
      }
    },
  });

  const unsubscribeNet = NetInfo.addEventListener((net) => {
    const online = net.isConnected !== false && net.isInternetReachable !== false;
    const wasOffline = status.network !== "online";
    setStatus({ network: online ? "online" : "offline", ...(online ? {} : { server: "unknown" }) });
    if (online && wasOffline) {
      realtime?.reconnectNow();
      void requestSync();
    }
  });

  const appSub = AppState.addEventListener("change", (next) => {
    const wasActive = appState === "active";
    appState = next;
    if (next === "active" && !wasActive) {
      realtime?.start();
      realtime?.reconnectNow();
      void requestSync();
      // Garante a coleta da jornada (o sistema pode ter encerrado o app em segundo plano).
      void resumeTracking();
    } else if (next !== "active" && wasActive) {
      realtime?.stop();
    }
  });

  const interval = setInterval(() => {
    if (appState === "active") void requestSync();
  }, SAFETY_INTERVAL_MS);

  stopFns = [
    unsubscribeNet,
    () => appSub.remove(),
    () => clearInterval(interval),
    () => clearTimeout(wsDebounce),
    () => realtime?.stop(),
  ];

  if (appState === "active") realtime.start();
  void getDb().then(async () => {
    await loadFieldRules();
    await requestSync();
  });
}

export function stopSync() {
  stopFns.forEach((fn) => fn());
  stopFns = [];
  realtime = null;
  setStatus({ realtime: "off", syncing: false });
  // Saiu da conta: os alertas do tempo na loja deste técnico não valem mais neste aparelho.
  setTimeout(() => void syncOnsiteAlerts(), 0);
}

/** Pede ao servidor um pull completo na próxima rodada (tela Conta). */
export async function resetCursor() {
  await setKv(SINCE_KEY, null);
  forceReasons = true;
  await requestSync();
}

export { refreshPendingCounts };
