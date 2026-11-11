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
import { Directory, File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { api, ApiError, errorMessage, uploadFile } from "./api";
import { STATUS } from "./constants";
import {
  addNotice,
  countPending,
  deleteLocalDraft,
  deleteOp,
  deletePhoto,
  deleteTicket,
  getDb,
  getKv,
  getTicket,
  insertLocalComment,
  insertLocalWorklog,
  insertOp,
  insertPhoto,
  listOutbox,
  listPhotos,
  markLocalSent,
  markOpsAttempt,
  markPhotoError,
  pruneOld,
  purgeSentDrafts,
  rebaseTicket,
  saveServerComment,
  saveServerTicket,
  saveServerWorklog,
  setKv,
  transaction,
} from "./db";
import { userRef } from "./ops";
import { RealtimeClient, type RealtimeState } from "./realtime";
import { session } from "./session";
import type {
  CommentCreatePayload,
  OutboxOp,
  SyncOperation,
  SyncOperationIn,
  SyncPullResponse,
  SyncPushResponse,
  WorklogCreatePayload,
} from "./syncTypes";
import { showToast } from "./toast";
import type { Attachment, RealtimeEvent, TicketDetail, TicketTransitionPayload, User, UUID } from "./types";

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
    await pushOutbox();
    await pullChanges();
    await uploadPhotos();
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
  }
}

async function pushOutbox() {
  for (let round = 0; round < 50; round++) {
    const ops = await listOutbox(PUSH_BATCH);
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
              message: `${describeOp(op)}: ${error.message}`,
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
    await transaction(async (db) => {
      const latest = new Map<UUID, TicketDetail | null>();
      for (const result of response.results) {
        const op = byId.get(result.client_op_id);
        if (!op) continue;
        await deleteOp(db, op.client_op_id);
        if (result.status === "applied" || result.status === "duplicate") {
          await markLocalSent(db, op.client_op_id);
        } else {
          const ticket = result.ticket ?? (await getTicket(op.ticket_id, db));
          await deleteLocalDraft(db, op.client_op_id);
          const message =
            result.status === "conflict"
              ? `${describeOp(op)} descartada: a OS foi alterada por outra pessoa. Confira o estado atual.`
              : `${describeOp(op)} recusada: ${result.error ?? "regra de negócio"}`;
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
      showToast(problems.length === 1 ? "Uma operação não foi aceita" : `${problems.length} operações não foram aceitas`, {
        description: problems[0],
        tone: "error",
      });
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
    await transaction(async (db) => {
      for (const ticket of data.tickets) await saveServerTicket(db, ticket, user);
      for (const comment of data.comments) await saveServerComment(db, comment);
      for (const worklog of data.worklogs) await saveServerWorklog(db, worklog);
      for (const id of data.revoked_ticket_ids) await deleteTicket(db, id);
      if (!data.has_more) {
        await purgeSentDrafts(db);
        await pruneOld(db);
      }
      await setKv(SINCE_KEY, data.server_time, db);
    });
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

/** Busca uma OS direto na API (após "assumir", por exemplo) e grava localmente. */
export async function storeServerTicket(ticket: TicketDetail) {
  const user = currentUser();
  await transaction((db) => saveServerTicket(db, ticket, user));
}

// ───────────────────────────── fotos ─────────────────────────────

const photosDir = () => new Directory(Paths.document, "pending-photos");

function deleteFileQuietly(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // arquivo já removido
  }
}

async function uploadPhotos() {
  const photos = await listPhotos();
  for (const photo of photos) {
    if (session.get().status !== "signedIn") return;
    let exists = false;
    try {
      exists = new File(photo.file_uri).exists;
    } catch {
      exists = false;
    }
    if (!exists) {
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
      await uploadFile<Attachment>(`/tickets/${photo.ticket_id}/attachments`, photo.file_uri, { kind: "photo" }, photo.mime_type);
      await deletePhoto(photo.id);
      deleteFileQuietly(photo.file_uri);
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
      deleteFileQuietly(photo.file_uri);
    }
  }
}

/** Copia a foto para a pasta do app (o cache do picker pode ser limpo) e coloca na fila. */
export async function queuePhoto(ticketId: UUID, sourceUri: string, mimeType: string | null | undefined) {
  const dir = photosDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const id = randomUUID();
  const mime = mimeType ?? "image/jpeg";
  const ext = mime === "image/png" ? "png" : mime === "image/heic" ? "heic" : "jpg";
  const filename = `foto-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  const target = new File(dir, `${id}.${ext}`);
  await new File(sourceUri).copy(target);
  await insertPhoto({
    id,
    ticket_id: ticketId,
    file_uri: target.uri,
    filename,
    mime_type: mime,
    created_at: new Date().toISOString(),
  });
  void requestSync();
}

export async function discardPhoto(id: string, fileUri: string) {
  await deletePhoto(id);
  deleteFileQuietly(fileUri);
  await refreshPendingCounts();
}

// ───────────────────────────── ações do técnico ─────────────────────────────

async function enqueue(ticketId: UUID, operation: SyncOperation) {
  const user = currentUser();
  const clientOpId = randomUUID();
  const clientTimestamp = new Date().toISOString();
  await transaction(async (db) => {
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
export function enqueueTransition(ticketId: UUID, payload: TicketTransitionPayload) {
  return enqueue(ticketId, { type: "transition", payload });
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
  await transaction(async (db) => {
    await deleteOp(db, op.client_op_id);
    await deleteLocalDraft(db, op.client_op_id);
    await rebaseTicket(db, op.ticket_id, user);
  });
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
  if (event.type === "ticket.comment_added" && event.assignee_id === user.id) {
    return `Novo acompanhamento em ${code}${event.actor_name ? ` por ${event.actor_name}` : ""}`;
  }
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
  void getDb().then(() => requestSync());
}

export function stopSync() {
  stopFns.forEach((fn) => fn());
  stopFns = [];
  realtime = null;
  setStatus({ realtime: "off", syncing: false });
}

/** Pede ao servidor um pull completo na próxima rodada (tela Conta). */
export async function resetCursor() {
  await setKv(SINCE_KEY, null);
  await requestSync();
}

export { refreshPendingCounts };
