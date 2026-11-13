// Motor de sincronização offline-first (docs/MOBILE_SYNC.md).
//
// Cada rodada: sobe as fotos pendentes, envia a fila (POST /sync/push) com as assinaturas na
// ordem certa e baixa o delta (GET /sync/pull?since=) até has_more = false. Rodadas nunca correm
// em paralelo; um pedido durante uma rodada agenda outra logo depois.
//
// A ordem só importa dentro de cada OS (fotos → formulários → assinatura → "Resolver"): um item
// travado de uma OS espera, com intervalo crescente entre as tentativas, sem segurar as outras OS,
// e problema no envio não impede o download. Nada sai da fila por erro de transporte: só a recusa
// do servidor àquela ação tira ela da fila (com aviso ao técnico).
//
// Gatilhos: login/abertura do app, rede voltando, app voltando ao primeiro plano,
// cada ação do técnico, cada evento do WebSocket e um intervalo de segurança.

import NetInfo from "@react-native-community/netinfo";
import { randomUUID } from "expo-crypto";
import { useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { api, ApiError, errorMessage, uploadFile } from "./api";
import { STATUS } from "./constants";
import {
  addNotice,
  addPartAttachment,
  clearSignatureBlock,
  countPending,
  deleteLocalDraft,
  deleteMissingOpenTickets,
  deleteOp,
  deletePhoto,
  deleteSignature,
  deleteTicket,
  dropFormDrafts,
  getAttachmentsCache,
  getDb,
  getKv,
  getServerTicket,
  getServerVersion,
  getTicket,
  getUnproductiveReasonsAt,
  insertLocalComment,
  insertLocalWorklog,
  insertOp,
  insertPhoto,
  insertPhotoRow,
  insertSignature,
  listOutbox,
  listPhotos,
  listSignatures,
  listTickets,
  markLocalSent,
  markOpsAttempt,
  markPhotoAttempt,
  markPhotoError,
  markSignatureAttempt,
  markSignatureBlocked,
  markSignatureError,
  maxOutboxSeq,
  partOpsWithPendingPhotos,
  pruneOld,
  purgeSentDrafts,
  rebaseTicket,
  resetLocalData,
  saveServerComment,
  saveServerTicket,
  saveServerWorklog,
  saveUnproductiveReasons,
  setAttachmentsCache,
  setFormError,
  setKv,
  transaction,
  WriteCancelled,
  type DB,
  type PendingPhoto,
  type PendingSignature,
} from "./db";
import { flushDeviceRegistration } from "./device";
import { setFieldRules } from "./field";
import { formatShort } from "./format";
import { pendingRequiredForms } from "./forms";
import { haptic } from "./haptics";
import { isDone, isHelper } from "./lists";
import { syncOnsiteAlerts } from "./onsiteAlerts";
import { userRef } from "./ops";
import { deleteAllPhotoFiles, deletePhotoFile, persistPhoto, photoExists } from "./photoFiles";
import { RealtimeClient, type RealtimeState } from "./realtime";
import { session } from "./session";
import { showSuccess } from "./success";
import type {
  CommentCreatePayload,
  FormAnswersPayload,
  OutboxOp,
  PartRequestPayload,
  SyncOperation,
  SyncOperationIn,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  UnproductivePayload,
} from "./syncTypes";
import { showToast } from "./toast";
import { flushPendingShiftEnd, flushPings, resumeTracking, updateTrackingMode } from "./tracking";
import type {
  Attachment,
  FieldRules,
  RealtimeEvent,
  TicketDetail,
  TicketTransitionPayload,
  UnproductiveReason,
  User,
  UUID,
} from "./types";

/** A API aceita até 200 por lote; lotes pequenos respondem antes do tempo limite em rede móvel. */
const PUSH_BATCH = 25;
/** Envio e download do sync carregam OS inteiras: mais tempo que uma consulta comum. */
const SYNC_TIMEOUT_MS = 60_000;
const SAFETY_INTERVAL_MS = 90_000;
/** Com o tempo real no ar, os eventos já disparam o sync: o intervalo de segurança espaça. */
const REALTIME_INTERVAL_MS = 5 * 60_000;
const SINCE_KEY = "sync_since";
const LAST_SYNC_KEY = "sync_last_at";

// ───────────────────────────── estado ─────────────────────────────

export interface SyncStatus {
  /** Conectividade do aparelho (NetInfo): "offline" só sem Wi-Fi e sem dados. */
  network: "unknown" | "online" | "offline";
  /** Resultado da última conversa com a API. */
  server: "unknown" | "reachable" | "unreachable";
  realtime: RealtimeState;
  /** Rodada visível: há algo a enviar ou o técnico pediu (rotina silenciosa não acende a faixa). */
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingOps: number;
  pendingPhotos: number;
  /** Ações que o servidor falhou em processar várias vezes seguidas: o técnico decide (Conta → Descartar). */
  stuckOps: number;
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
  stuckOps: 0,
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

// ───────────────────────────── sessão e escritas ─────────────────────────────

/**
 * Muda a cada "Sair", troca de usuário ou limpeza do aparelho: o que uma rodada da sessão
 * anterior ainda tinha em andamento não grava mais nada (nem pede mais nada ao servidor).
 */
let epoch = 0;

/** Sessão que começou um trabalho (rodada, conferência de OS). */
interface Ctx {
  epoch: number;
  user: User;
}

const sessionCtx = (): Ctx => ({ epoch, user: currentUser() });

const alive = (ctx: Ctx) => ctx.epoch === epoch && session.get().user?.id === ctx.user.id;

/** Escrita de um trabalho em andamento: cancelada (WriteCancelled) se a sessão mudou no meio. */
function write(ctx: Ctx, task: (db: DB) => Promise<void>, notify = true): Promise<void> {
  return transaction(task, { notify, guard: () => alive(ctx) });
}

/** Antes de cada pedido ao servidor: a sessão ainda é a mesma? */
function ensureAlive(ctx: Ctx) {
  if (!alive(ctx)) throw new WriteCancelled();
}

// ───────────────────────────── espera entre tentativas ─────────────────────────────

interface Retry {
  failures: number;
  nextAt: number;
  /** Falhou sozinha com erro do servidor: provavelmente é ela que derruba o envio. */
  stuck: boolean;
}

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** Falhas seguidas, sozinha, para a ação aparecer como "precisa de atenção". */
const STUCK_AFTER = 3;

/** Por operação, foto ou assinatura (ids aleatórios, sem colisão). Falta de rede não conta aqui. */
const retries = new Map<string, Retry>();

/** Falha do lado do servidor: espera 5 s, 10 s, 20 s… até 5 min (±20%) antes de tentar de novo. */
function scheduleRetry(id: string, stuck = false) {
  const failures = (retries.get(id)?.failures ?? 0) + 1;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS) * (0.8 + Math.random() * 0.4);
  retries.set(id, { failures, nextAt: Date.now() + delay, stuck });
}

const isDue = (id: string) => (retries.get(id)?.nextAt ?? 0) <= Date.now();
const failuresOf = (id: string) => retries.get(id)?.failures ?? 0;

function countStuck(): number {
  let count = 0;
  for (const retry of retries.values()) if (retry.stuck && retry.failures >= STUCK_AFTER) count += 1;
  return count;
}

// ───────────────────────────── rodada ─────────────────────────────

interface Round extends Ctx {
  /** OS cujo restante fica para a próxima rodada (item travado, em espera ou aguardando foto). */
  blocked: Set<UUID>;
  /** Primeiro problema de envio que não é falta de rede: vira o "último erro" da rodada. */
  error: string | null;
  /** Anexos da OS no servidor, buscados no máximo uma vez por rodada (reenvio sem duplicar). */
  attachments: Map<UUID, Attachment[] | null>;
}

export interface SyncRequest {
  /**
   * Pedido do técnico (puxar para atualizar, "Sincronizar agora"): acende a faixa, tenta mesmo com
   * o sistema dizendo que não há rede e não espera o intervalo entre tentativas.
   */
  manual?: boolean;
}

let running: Promise<void> | null = null;
let runningEpoch = -1;
let again = false;
let pendingManual = false;
let lastRoundAt = 0;

/** Pede uma sincronização. Resolve quando a rodada (e as que forem pedidas durante ela) terminar. */
export function requestSync({ manual = false }: SyncRequest = {}): Promise<void> {
  if (session.get().status !== "signedIn") return Promise.resolve();
  if (manual) {
    retries.clear();
    pendingManual = true;
  }
  // A rodada de uma sessão que já terminou não segura a da sessão nova (ela não grava mais nada).
  if (running && runningEpoch === epoch) {
    again = true;
    return running;
  }
  const myEpoch = epoch;
  const loop = (async () => {
    try {
      do {
        again = false;
        const isManual = pendingManual;
        pendingManual = false;
        await runOnce(myEpoch, isManual);
      } while (again && myEpoch === epoch && session.get().status === "signedIn");
    } finally {
      if (running === loop) running = null;
    }
  })();
  running = loop;
  runningEpoch = myEpoch;
  return loop;
}

async function runOnce(myEpoch: number, manual: boolean) {
  const user = session.get().user;
  if (!user || myEpoch !== epoch) return;
  // Sem Wi-Fi e sem dados não adianta tentar, a menos que o técnico peça.
  if (status.network === "offline" && !manual) {
    await refreshPendingCounts().catch(() => undefined);
    return;
  }
  const round: Round = { epoch: myEpoch, user, blocked: new Set(), error: null, attachments: new Map() };
  lastRoundAt = Date.now();
  const pending = await countPending().catch(() => ({ ops: 0, photos: 0 }));
  // A faixa "Sincronizando…" só acende quando há o que enviar ou o técnico pediu: a rotina
  // silenciosa (intervalo, eventos do tempo real) não pisca a tela o dia todo.
  if (manual || pending.ops + pending.photos > 0) setStatus({ syncing: true });
  try {
    // Ordem causal por OS: fotos (inclusive de campos de formulário) → respostas/conclusões →
    // assinatura → o restante (ex.: "Resolver"), que o servidor só aceita depois dela.
    await sendPhase(round, () => uploadPhotos(round));
    await sendPhase(round, () => pushWithSignatures(round));
    await pullChanges(round);
    await revalidateHelperTickets(round);
    await refreshFieldRules(round);
    await refreshReasons(round);
    // Alertas locais do tempo na loja (aviso faltando 30 min e no estouro das 4h).
    void syncOnsiteAlerts();
    await syncTracking();
    await flushDeviceRegistration().catch((error: unknown) => console.warn("Falha ao registrar o aparelho", error));
    const at = new Date().toISOString();
    setStatus({ server: "reachable", lastSyncAt: at, lastError: round.error });
    await write(round, (db) => setKv(LAST_SYNC_KEY, at, db), false);
  } catch (error) {
    if (error instanceof WriteCancelled) return; // a sessão mudou: nada a registrar
    if (error instanceof ApiError && error.status === 0) {
      setStatus({ server: "unreachable", lastError: error.message });
    } else {
      setStatus({ server: "reachable", lastError: errorMessage(error) });
    }
  } finally {
    if (myEpoch === epoch) {
      await refreshPendingCounts().catch(() => undefined);
      setStatus({ syncing: false, stuckOps: countStuck() });
    }
  }
}

/**
 * Fase de envio: falta de rede (ou sessão encerrada) para a rodada; outro problema fica anotado e
 * o download segue, para o técnico continuar recebendo OS novas, reagendamentos e cancelamentos.
 */
async function sendPhase(round: Round, phase: () => Promise<void>) {
  try {
    await phase();
  } catch (error) {
    if (error instanceof WriteCancelled || (error instanceof ApiError && (error.status === 0 || error.status === 401))) {
      throw error;
    }
    console.warn("Falha no envio da fila", error);
    round.error ??= errorMessage(error);
  }
}

/**
 * Rastreamento da jornada: sobe a fila de pontos, envia um encerramento feito sem sinal e ajusta o
 * ritmo (deslocamento = mais frequente). Problema aqui nunca vira falha da sincronização.
 */
async function syncTracking() {
  await flushPings(true);
  await flushPendingShiftEnd();
  await updateTrackingMode();
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

/**
 * Envia a fila em fases, por OS: com assinatura pendente, primeiro o que foi feito até ela (e os
 * formulários, sempre antes dela), depois a assinatura e então o resto ("Resolver"). As OS sem
 * assinatura pendente seguem direto.
 */
async function pushWithSignatures(round: Round) {
  const signatures = await listSignatures();
  const gates = new Map(signatures.map((s) => [s.ticket_id, s.after_seq]));
  await pushOutbox(round, gates);
  for (const signature of signatures) {
    if (round.blocked.has(signature.ticket_id)) continue;
    ensureAlive(round);
    if (await uploadSignature(round, signature)) gates.delete(signature.ticket_id);
    else round.blocked.add(signature.ticket_id);
  }
  await pushOutbox(round, gates);
}

const FORM_INCOMPLETE = /falta preencher/i;

async function pushOutbox(round: Round, gates: Map<UUID, number>) {
  for (let page = 0; page < 200; page++) {
    const ops = await nextBatch(round, gates);
    if (!ops.length) return;
    if (!(await pushBatch(round, ops))) return;
  }
}

/**
 * Próximo lote, em ordem. Uma operação em espera (falhou há pouco) ou um pedido de peça com foto
 * ainda no aparelho (leva os ids dos anexos) seguram as seguintes da mesma OS; as das outras seguem.
 */
async function nextBatch(round: Round, gates: Map<UUID, number>): Promise<OutboxOp[]> {
  const waiting = await partOpsWithPendingPhotos();
  for (let pass = 0; pass < 100; pass++) {
    const rows = await listOutbox(PUSH_BATCH, undefined, { excludeTickets: round.blocked, gates });
    const batch: OutboxOp[] = [];
    let held = false;
    for (const op of rows) {
      if (round.blocked.has(op.ticket_id)) continue;
      if ((op.type === "part_request" && waiting.has(op.client_op_id)) || !isDue(op.client_op_id)) {
        round.blocked.add(op.ticket_id);
        held = true;
        continue;
      }
      batch.push(op);
    }
    // Vazio só porque tudo o que veio ficou para depois: busca de novo, já sem essas OS.
    if (batch.length || !held) return batch;
  }
  return [];
}

/** Envia um lote e trata o resultado. Devolve false quando o envio deve parar nesta rodada. */
async function pushBatch(round: Round, candidates: OutboxOp[]): Promise<boolean> {
  // Uma OS que travou no meio da divisão de um lote segura as operações seguintes dela.
  const ops = candidates.filter((op) => !round.blocked.has(op.ticket_id));
  if (!ops.length) return true;
  ensureAlive(round);
  let response: SyncPushResponse;
  try {
    const body: SyncPushRequest = { operations: ops.map(toWire), sent_at: new Date().toISOString() };
    response = await api.post<SyncPushResponse>("/sync/push", body, { timeoutMs: SYNC_TIMEOUT_MS });
  } catch (error) {
    return pushFailed(round, ops, error);
  }
  await applyResults(round, ops, response);
  return true;
}

/**
 * O lote inteiro falhou. Só uma operação que o servidor recusou na validação sai da fila; nos
 * outros casos (proxy, servidor fora, envio anterior ainda em processamento) nada foi aplicado ou
 * já foi aplicado e volta como "duplicate": as operações ficam e esperam para tentar de novo.
 */
async function pushFailed(round: Round, ops: OutboxOp[], error: unknown): Promise<boolean> {
  if (!(error instanceof ApiError)) throw error;
  const ids = ops.map((op) => op.client_op_id);
  // Sem rede ou sessão encerrada: a rodada para; a fila fica como está, sem espera extra.
  if (error.status === 0 || error.status === 401) {
    await write(round, (db) => markOpsAttempt(db, ids, error.message));
    throw error;
  }
  // Lote recusado na validação (ex.: tipo de operação que este servidor ainda não conhece) ou grande
  // demais para um proxy: divide ao meio até isolar a operação que causa a recusa.
  if ((error.status === 422 || error.status === 413) && ops.length > 1) {
    const half = Math.ceil(ops.length / 2);
    return (await pushBatch(round, ops.slice(0, half))) && (await pushBatch(round, ops.slice(half)));
  }
  if (error.status === 422) {
    await rejectOps(round, ops, cleanServerError(error.message));
    return true;
  }
  // Erro do servidor que pode vir de uma operação só (500, ou 409 que se repete). Depois de duas
  // falhas do lote, manda uma a uma: a que derruba fica esperando e as outras passam.
  const suspect = error.status === 409 || (error.status >= 500 && ![502, 503, 504].includes(error.status));
  if (suspect && ops.length > 1 && Math.max(...ids.map(failuresOf)) >= 2) {
    for (const op of ops) {
      if (!(await pushBatch(round, [op]))) return false;
    }
    return true;
  }
  const alone = ops.length === 1 && (suspect || error.status === 413);
  const message = alone
    ? `O servidor falhou ao processar esta ação (erro ${error.status}). Toque em Descartar se continuar.`
    : error.status === 409
      ? "O servidor ainda processava o envio anterior. Vamos tentar de novo."
      : error.retryable
        ? `O servidor está com problema (erro ${error.status}). Vamos tentar de novo.`
        : `O servidor não aceitou o envio (erro ${error.status}). Vamos tentar de novo.`;
  await write(round, (db) => markOpsAttempt(db, ids, message));
  for (const id of ids) scheduleRetry(id, alone);
  for (const op of ops) round.blocked.add(op.ticket_id);
  round.error ??= message;
  // Uma ação travada sozinha não para as das outras OS; problema no envio inteiro para a rodada.
  return alone;
}

/** Recusa definitiva: sai da fila, o rascunho local some e o técnico é avisado. */
async function rejectOps(round: Round, ops: OutboxOp[], reason: string) {
  const problems: string[] = [];
  await write(round, async (db) => {
    for (const op of ops) {
      const ticket = await getTicket(op.ticket_id, db);
      await deleteOp(db, op.client_op_id);
      await deleteLocalDraft(db, op.client_op_id);
      const message = `${describeOp(op)}: o servidor recusou — ${reason}`;
      await addNotice(db, { ticket_id: op.ticket_id, ticket_code: ticket?.code ?? null, kind: "rejected", message });
      problems.push(`${ticket?.code ?? "OS"}: ${message}`);
    }
    for (const ticketId of new Set(ops.map((op) => op.ticket_id))) await rebaseTicket(db, ticketId, round.user);
  });
  for (const op of ops) retries.delete(op.client_op_id);
  announceProblems(problems);
}

async function applyResults(round: Round, ops: OutboxOp[], response: SyncPushResponse) {
  const byId = new Map(ops.map((op) => [op.client_op_id, op]));
  const answered = new Set<string>();
  const problems: string[] = [];
  await write(round, async (db) => {
    const latest = new Map<UUID, TicketDetail | null>();
    for (const result of response.results) {
      const op = byId.get(result.client_op_id);
      if (!op) continue;
      answered.add(op.client_op_id);
      await deleteOp(db, op.client_op_id);
      // "duplicate" com erro: o envio anterior (cuja resposta se perdeu) tinha sido recusado.
      const refused =
        result.status === "rejected" || result.status === "conflict" || (result.status === "duplicate" && Boolean(result.error));
      if (!refused) {
        await markLocalSent(db, op.client_op_id);
        if (op.type === "form_answers" && op.payload.complete) await setFormError(op.payload.form_id, null, db);
      } else {
        const ticket = result.ticket ?? (await getTicket(op.ticket_id, db));
        await deleteLocalDraft(db, op.client_op_id);
        let message =
          result.status === "conflict"
            ? `${describeOp(op)}: descartado porque a OS foi alterada por outra pessoa. Confira o estado atual.`
            : `${describeOp(op)}: o servidor recusou — ${cleanServerError(result.error)}`;
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
        await addNotice(db, {
          ticket_id: op.ticket_id,
          ticket_code: ticket?.code ?? null,
          kind: result.status === "conflict" ? "conflict" : "rejected",
          message,
        });
        problems.push(`${ticket?.code ?? "OS"}: ${message}`);
      }
      if (result.ticket) latest.set(op.ticket_id, result.ticket);
      else if (!latest.has(op.ticket_id)) latest.set(op.ticket_id, null);
    }
    for (const [ticketId, ticket] of latest) {
      if (ticket) await saveServerTicket(db, ticket, round.user);
      else await rebaseTicket(db, ticketId, round.user);
    }
  });
  for (const id of answered) retries.delete(id);
  // Operação sem resultado na resposta: fica na fila para a próxima rodada (sem repetir agora).
  for (const op of ops) if (!answered.has(op.client_op_id)) round.blocked.add(op.ticket_id);
  announceProblems(problems);
}

function announceProblems(problems: string[]) {
  if (!problems.length) return;
  showToast(problems.length === 1 ? "Uma operação não foi aceita" : `${problems.length} operações não foram aceitas`, {
    description: problems[0],
    tone: "error",
  });
}

// ───────────────────────────── pull ─────────────────────────────

/**
 * "Baixar tudo" pedido (ou download completo interrompido no meio): o próximo download começa do
 * zero. Só zera depois da última página, então uma rodada em andamento não engole o pedido.
 */
let forceFull = false;

async function pullChanges(round: Round) {
  let full = false;
  const received = new Set<UUID>();
  for (let page = 0; page < 100; page++) {
    ensureAlive(round);
    const stored = await getKv(SINCE_KEY);
    const since = page === 0 && forceFull ? null : stored;
    if (page === 0) {
      full = since === null;
      if (full) forceFull = true;
    }
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    const data = await api.get<SyncPullResponse>(`/sync/pull${query}`, { timeoutMs: SYNC_TIMEOUT_MS });
    const last = !data.has_more;
    const news: FieldNews[] = [];
    const revoked: string[] = [];
    let removed = 0;
    // Página sem novidade não acorda as telas (o intervalo e os eventos rodam o dia todo).
    const changed = full || data.tickets.length + data.comments.length + data.worklogs.length + data.revoked_ticket_ids.length > 0;
    await write(
      round,
      async (db) => {
        for (const ticket of data.tickets) {
          received.add(ticket.id);
          // Avisos só no delta: o download completo (primeiro acesso, "Baixar tudo") não é novidade.
          if (!full) news.push(...fieldNews(await getServerTicket(ticket.id, db), ticket, round.user));
          await saveServerTicket(db, ticket, round.user);
        }
        for (const comment of data.comments) await saveServerComment(db, comment);
        for (const worklog of data.worklogs) await saveServerWorklog(db, worklog);
        for (const id of data.revoked_ticket_ids) {
          const local = await getTicket(id, db);
          if (local) revoked.push(local.code);
          await deleteTicket(db, id);
        }
        if (last) {
          // Download completo: a OS aberta que não veio mais não é do técnico (perdeu o acesso com o app fechado).
          if (full) removed = await deleteMissingOpenTickets(db, received);
          await purgeSentDrafts(db);
          await pruneOld(db);
        }
        await setKv(SINCE_KEY, data.server_time, db);
      },
      changed,
    );
    if (last && full) forceFull = false;
    announceFieldNews(news);
    announceRemoved(revoked, removed);
    if (last) return;
  }
}

/** OS que saíram da lista: reatribuídas (o código vem do aparelho) ou que sumiram no download completo. */
function announceRemoved(codes: string[], removed: number) {
  announceGroup(
    codes,
    (code) => `${code} foi reatribuída e saiu da sua lista`,
    (count) => `${count} OS foram reatribuídas e saíram da sua lista`,
  );
  if (removed > 0) {
    showToast(removed === 1 ? "Uma OS que não é mais sua saiu da lista" : `${removed} OS que não são mais suas saíram da lista`);
  }
}

/** Até dois avisos do mesmo tipo saem um a um; mais que isso, um resumo só. */
function announceGroup(codes: string[], one: (code: string) => string, many: (count: number) => string, options: ToastOptions = {}) {
  if (codes.length > 2) showToast(many(codes.length), options);
  else for (const code of codes) showToast(one(code), options);
}

type FieldNews =
  | { kind: "part_approved" | "part_rejected"; code: string; description: string }
  | { kind: "assigned" | "helper" | "cancelled"; code: string }
  | { kind: "rescheduled"; code: string; at: string; first: boolean };

/**
 * O que mudou entre a última versão do servidor guardada no aparelho e a recebida, e merece aviso
 * ao técnico (também quando o app estava fechado e o tempo real não avisou).
 */
function fieldNews(before: TicketDetail | null, after: TicketDetail, user: User): FieldNews[] {
  const mine = after.assignee?.id === user.id;
  if (!mine && !isHelper(after, user)) return [];
  if (!before) {
    return isDone(after.status) ? [] : [{ kind: mine ? "assigned" : "helper", code: after.code }];
  }
  const news: FieldNews[] = [];
  if (before.status !== "cancelled" && after.status === "cancelled") {
    news.push({ kind: "cancelled", code: after.code });
  } else if (after.scheduled_start && after.scheduled_start !== before.scheduled_start && !isDone(after.status)) {
    news.push({ kind: "rescheduled", code: after.code, at: after.scheduled_start, first: !before.scheduled_start });
  }
  if (!mine) return news;
  const previous = new Map((before.part_requests ?? []).map((r) => [r.id, r.status]));
  for (const request of after.part_requests ?? []) {
    const was = previous.get(request.id);
    if (was && was !== "approved" && request.status === "approved") {
      news.push({ kind: "part_approved", code: after.code, description: request.description });
    } else if (was && was !== "rejected" && request.status === "rejected") {
      news.push({ kind: "part_rejected", code: after.code, description: request.description });
    }
  }
  return news;
}

function announceFieldNews(news: FieldNews[]) {
  const codes = (kind: FieldNews["kind"]) => news.filter((n) => n.kind === kind).map((n) => n.code);
  announceGroup(codes("assigned"), (code) => `Nova OS para você: ${code}`, (count) => `${count} OS novas para você`);
  announceGroup(codes("helper"), (code) => `Você vai na visita da ${code}`, (count) => `Você entrou em ${count} visitas`);
  const cancelled = codes("cancelled");
  if (cancelled.length) {
    haptic.warning();
    announceGroup(
      cancelled,
      (code) => `${code} foi cancelada pela central`,
      (count) => `${count} OS foram canceladas pela central`,
      { tone: "error", description: "Não precisa ir ao local." },
    );
  }
  const rescheduled = news.filter((n): n is Extract<FieldNews, { kind: "rescheduled" }> => n.kind === "rescheduled");
  if (rescheduled.length > 2) {
    showToast(`${rescheduled.length} OS foram reagendadas`, { description: "Confira a agenda." });
  } else {
    for (const n of rescheduled) showToast(`${n.code} ${n.first ? "agendada" : "reagendada"} para ${formatShort(n.at)}`);
  }

  const parts = news.filter((n): n is Extract<FieldNews, { kind: "part_approved" | "part_rejected" }> =>
    n.kind === "part_approved" || n.kind === "part_rejected",
  );
  const approved = parts.filter((n) => n.kind === "part_approved");
  if (approved.length) {
    haptic.success();
    showSuccess(
      approved.length === 1 ? "Peça aprovada" : `${approved.length} peças aprovadas`,
      approved.length === 1
        ? `${approved[0].code} · ${approved[0].description}: pode instalar.`
        : "O cliente aprovou o orçamento: pode instalar.",
    );
  }
  for (const n of parts) {
    if (n.kind === "part_rejected") {
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

async function refreshFieldRules(round: Round) {
  if (!forceReasons && Date.now() - fieldRulesAt < 30 * 60_000) return;
  try {
    ensureAlive(round);
    const rules = await api.get<FieldRules>("/settings/field");
    await write(round, (db) => setKv(FIELD_RULES_KEY, JSON.stringify(rules), db));
    setFieldRules(rules);
    fieldRulesAt = Date.now();
  } catch (error) {
    if (error instanceof WriteCancelled || (error instanceof ApiError && error.status === 0)) throw error;
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
 * Cadastro de motivos de visita improdutiva (GET /unproductive-reasons?active=true), guardado no
 * SQLite para o técnico registrar a visita offline. Muda pouco: baixa na primeira vez, a cada 6 h
 * ou em "Baixar tudo". Falha aqui não derruba a rodada. (Motivo de atraso de SLA é da central.)
 */
async function refreshReasons(round: Round) {
  const stale = (at: string | null) => forceReasons || !at || Date.now() - new Date(at).getTime() >= REASONS_MAX_AGE_MS;
  try {
    if (stale(await getUnproductiveReasonsAt())) {
      ensureAlive(round);
      const reasons = await api.get<UnproductiveReason[]>("/unproductive-reasons?active=true");
      await write(round, (db) => saveUnproductiveReasons(reasons, db));
    }
    forceReasons = false;
  } catch (error) {
    if (error instanceof WriteCancelled || (error instanceof ApiError && error.status === 0)) throw error;
    console.warn("Não foi possível atualizar os cadastros de motivos", error);
  }
}

/**
 * Confere uma OS direto na API. Sem acesso (o técnico saiu da visita ou ela foi reatribuída), sai do
 * aparelho: o `revoked_ticket_ids` do pull só cobre reatribuição, não a saída da equipe da visita.
 */
async function revalidateTicket(ctx: Ctx, ticketId: UUID): Promise<void> {
  ensureAlive(ctx);
  let ticket: TicketDetail;
  try {
    ticket = await api.get<TicketDetail>(`/tickets/${ticketId}`);
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) return;
    const local = await getTicket(ticketId);
    await write(ctx, (db) => deleteTicket(db, ticketId));
    if (local) showToast(`${local.code} saiu da sua lista`, { description: "Você não está mais na visita desta OS." });
    return;
  }
  await write(ctx, (db) => saveServerTicket(db, ticket, ctx.user));
}

let helpersCheckedAt = 0;

/** Rede de segurança (a cada 10 min): as OS em que o técnico vai junto ainda são dele? */
async function revalidateHelperTickets(round: Round) {
  if (Date.now() - helpersCheckedAt < 10 * 60_000) return;
  helpersCheckedAt = Date.now();
  for (const ticket of await listTickets()) {
    if (isHelper(ticket, round.user) && !isDone(ticket.status)) await revalidateTicket(round, ticket.id);
  }
}

/** Busca uma OS direto na API (após "assumir", por exemplo) e grava localmente. */
export async function storeServerTicket(ticket: TicketDetail) {
  const ctx = sessionCtx();
  await write(ctx, (db) => saveServerTicket(db, ticket, ctx.user));
}

// ───────────────────────────── fotos ─────────────────────────────

/**
 * Sobe as fotos, uma OS não segurando a outra: foto que falhou (ou que ainda espera a vez de tentar
 * de novo) segura só o que vem depois na mesma OS (conclusão de formulário, pedido de peça).
 */
async function uploadPhotos(round: Round) {
  for (const photo of await listPhotos()) {
    ensureAlive(round);
    if (round.blocked.has(photo.ticket_id)) continue;
    if (!isDue(photo.id)) {
      round.blocked.add(photo.ticket_id);
      continue;
    }
    if (!photoExists(photo.file_uri)) {
      await write(round, async (db) => {
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
    await uploadPhoto(round, photo);
  }
}

/**
 * Arquivo que este técnico já enviou e cuja resposta se perdeu (tempo esgotado, conexão caiu, app
 * fechado no meio): já está no servidor? A lista de anexos da OS é buscada uma vez por rodada.
 */
async function findUploaded(round: Round, ticketId: UUID, match: (a: Attachment) => boolean): Promise<Attachment | null> {
  if (!round.attachments.has(ticketId)) {
    ensureAlive(round);
    try {
      round.attachments.set(ticketId, await api.get<Attachment[]>(`/tickets/${ticketId}/attachments`));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 0 || error.status === 401)) throw error;
      // Sem a lista (ex.: OS que saiu do técnico): o próprio envio decide.
      round.attachments.set(ticketId, null);
    }
  }
  return round.attachments.get(ticketId)?.find((a) => a.uploaded_by?.id === round.user.id && match(a)) ?? null;
}

async function uploadPhoto(round: Round, photo: PendingPhoto) {
  const isFormPhoto = Boolean(photo.form_id && photo.field_id);
  // O nome do arquivo leva o id da foto: um reenvio acha a foto que já chegou e não duplica.
  let attachment =
    photo.attempts > 0
      ? await findUploaded(
          round,
          photo.ticket_id,
          (a) =>
            a.filename === photo.filename &&
            (isFormPhoto ? a.form_id === photo.form_id && a.field_id === photo.field_id : a.kind === "photo"),
        )
      : null;
  if (!attachment) {
    // A tentativa conta antes do envio: se o app morrer no meio, o próximo envio confere primeiro.
    await write(round, (db) => markPhotoAttempt(db, photo.id), false);
    ensureAlive(round);
    try {
      attachment = await uploadFile<Attachment>(
        isFormPhoto ? `/tickets/${photo.ticket_id}/forms/${photo.form_id}/photos` : `/tickets/${photo.ticket_id}/attachments`,
        photo.file_uri,
        isFormPhoto ? { field_id: photo.field_id! } : { kind: "photo" },
        photo.mime_type,
        photo.filename,
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.retryable || error.status === 401) {
        await write(round, (db) => markPhotoError(photo.id, error.message, db));
        // Sem rede ou sessão encerrada: para a rodada. Servidor com problema: só esta OS espera.
        if (error.status === 0 || error.status === 401) throw error;
        scheduleRetry(photo.id);
        round.blocked.add(photo.ticket_id);
        round.error ??= `Foto ${photo.filename}: ${error.message}`;
        return;
      }
      // Recusada (ex.: campo já com o máximo de fotos, arquivo grande demais): sai da fila com aviso.
      await write(round, async (db) => {
        const ticket = await getTicket(photo.ticket_id, db);
        await addNotice(db, {
          ticket_id: photo.ticket_id,
          ticket_code: ticket?.code ?? null,
          kind: "photo",
          message: `Foto recusada pelo servidor: ${error.message}`,
        });
        await db.runAsync("DELETE FROM photos WHERE id = ?", photo.id);
      });
      retries.delete(photo.id);
      deletePhotoFile(photo.file_uri);
      return;
    }
  }
  retries.delete(photo.id);
  const uploaded = attachment;
  // A foto sai da fila e entra no cache de anexos na mesma transação (a contagem do campo não pisca).
  await write(round, async (db) => {
    await db.runAsync("DELETE FROM photos WHERE id = ?", photo.id);
    if (uploaded?.id) {
      const cached = await getAttachmentsCache(photo.ticket_id, db);
      if (!cached.some((a) => a.id === uploaded.id)) await setAttachmentsCache(photo.ticket_id, [...cached, uploaded], db);
      // Foto de pedido de peça: o id vai junto na operação, que só sai depois de todas as fotos.
      if (photo.part_op_id) await addPartAttachment(db, photo.part_op_id, uploaded.id);
    }
  });
  deletePhotoFile(photo.file_uri);
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
  // "ticket.part_request_decided" só dispara o sync: o pull compara a OS e avisa (peça aprovada com
  // o check, peça recusada), sem aviso duplicado.
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
