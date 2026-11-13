// Rastreamento da jornada do técnico (LGPD: só com termo aceito e só durante a jornada).
//
// - Termo: POST /tracking/consent (grava o aceite; UserOut.location_consent_at).
// - Jornada: POST /tracking/shift/start | /tracking/shift/end; GET /tracking/shift.
// - Pontos: coletados pelo GPS, guardados na fila `pings` do SQLite e enviados em lote
//   (POST /tracking/pings, até 500). Sem rede, acumulam e sobem depois.
// - Segundo plano: expo-task-manager + Location.startLocationUpdatesAsync (foreground service no
//   Android, "Sempre" no iOS). Exige build de desenvolvimento/produção; no Expo Go e na web o app
//   cai para o primeiro plano (watchPositionAsync) e avisa na tela.
// - Ritmo: ~30 s parado/normal; ~15 s quando há OS minha "Em deslocamento"; 1 por minuto com a
//   bateria abaixo de 15% e fora da tomada. No Android o serviço de localização só pode ser
//   reconfigurado com o app na tela: a troca de ritmo pedida em segundo plano espera o app voltar.
// - Iniciar, encerrar, retomar, sair e trocar o ritmo passam por uma fila única (nunca correm juntos).
// - Jornada esquecida aberta: lembrete depois de 10 h e encerramento automático depois de 14 h.

import { isRunningInExpoGo } from "expo";
import * as Battery from "expo-battery";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { locationConsentAt, refreshMe } from "./account";
import { api, ApiError, errorMessage, getServerOffsetMs, serverNow } from "./api";
import {
  countPings,
  deletePings,
  getKv,
  hasTicketInTransit,
  insertPingRows,
  listPings,
  oldestPingAt,
  setKv,
  transaction,
  WriteCancelled,
  type Ping,
} from "./db";
import { currentPosition, type Position } from "./device-actions";
import { session } from "./session";
import { showToast } from "./toast";

export const TRACKING_TASK = "maxxfield-tracking";

const SHIFT_KEY = "tracking_shift";
const END_PENDING_KEY = "tracking_end_pending";
const PACE_KEY = "tracking_pace";
const BATCH = 500;
const FLUSH_MIN_INTERVAL_MS = 20_000;
/** Jornada aberta há mais que isto foi esquecida: é encerrada sozinha (nada de coletar a noite toda). */
const MAX_SHIFT_MS = 14 * 3600_000;
/** Lembrete local para encerrar a jornada. */
const REMINDER_AFTER_MS = 10 * 3600_000;
const REMINDER_ID = "jornada-aberta";
const REMINDER_CHANNEL = "jornada";
/** Diferença de relógio que faz o servidor descartar os pontos (ele tolera 2 min). */
const CLOCK_LIMIT_MS = 90_000;

const CLOCK_NOTICE =
  "O relógio do celular está diferente do horário oficial. Ative “Data e hora automáticas” para a central ver sua posição.";
const GPS_FAILED = "Não foi possível ligar o GPS. Ative a localização do celular: o rastreamento volta sozinho com o app aberto.";
const SERVICES_OFF = "A localização do celular está desligada. Ligue para a central ver sua posição.";
const noPermissionNotice = () =>
  Platform.OS === "ios"
    ? "Sem permissão de localização: libere em Ajustes > Maxx Field > Localização."
    : "Sem permissão de localização: libere em Configurações > Apps > Maxx Field > Localização.";

export interface Shift {
  id: string;
  started_at: string;
  ended_at: string | null;
}

export type TrackingMode = "off" | "background" | "foreground";

/** Ritmo da coleta: normal, em deslocamento (mais frequente) ou economia de bateria. */
type Pace = "normal" | "transit" | "saver";

export interface TrackingState {
  shift: Shift | null;
  mode: TrackingMode;
  /** Há OS minha em deslocamento: coleta mais frequente. */
  transit: boolean;
  /** Bateria abaixo de 15% e fora da tomada: um ponto por minuto, com precisão menor. */
  batterySaver: boolean;
  lastFixAt: string | null;
  lastSentAt: string | null;
  queued: number;
  error: string | null;
  /** Aviso fixo (permissão, GPS, relógio do celular ou o modo, ex.: só com o app aberto). */
  notice: string | null;
  /** false quando a API ainda não tem os endpoints /tracking (404). */
  serverAvailable: boolean | null;
}

let state: TrackingState = {
  shift: null,
  mode: "off",
  transit: false,
  batterySaver: false,
  lastFixAt: null,
  lastSentAt: null,
  queued: 0,
  error: null,
  notice: null,
  serverAvailable: null,
};
const listeners = new Set<() => void>();

function setState(patch: Partial<TrackingState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getState = () => state;

export function useTracking(): TrackingState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export class ConsentRequiredError extends Error {
  constructor() {
    super("Aceite o termo de rastreamento para iniciar a jornada.");
    this.name = "ConsentRequiredError";
  }
}

export const hasConsent = () => Boolean(locationConsentAt(session.get().user));

// ───────────────────────────── avisos do cartão ─────────────────────────────

/** Problemas do momento, do mais grave para o mais leve; sem nenhum, vale o aviso do modo. */
const problems: { location: string | null; gps: string | null; clock: string | null } = {
  location: null,
  gps: null,
  clock: null,
};
/** Aviso fixo do modo de coleta (ex.: só com o app aberto). */
let modeNotice: string | null = null;

function refreshNotice() {
  setState({ notice: problems.location ?? problems.gps ?? problems.clock ?? modeNotice });
}

function setProblem(kind: keyof typeof problems, text: string | null) {
  problems[kind] = text;
  refreshNotice();
}

function clearNotices() {
  problems.location = null;
  problems.gps = null;
  problems.clock = null;
  modeNotice = null;
  refreshNotice();
}

// ───────────────────────────── fila das ações da jornada ─────────────────────────────

let lock: Promise<unknown> = Promise.resolve();

/**
 * Iniciar, encerrar, retomar, sair e trocar o ritmo correm um de cada vez: intercalados, um podia
 * religar o GPS depois do encerramento ou apagar a jornada que acabou de ser aberta.
 */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

// ───────────────────────────── jornada local ─────────────────────────────

async function readShift(): Promise<Shift | null> {
  const raw = await getKv(SHIFT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Shift;
  } catch {
    return null;
  }
}

async function writeShift(shift: Shift | null) {
  await setKv(SHIFT_KEY, shift ? JSON.stringify(shift) : null, undefined, { notify: false });
  setState({ shift });
}

const unwrapShift = (data: unknown): Shift | null =>
  data && typeof data === "object" && "shift" in data ? ((data as { shift: Shift | null }).shift ?? null) : ((data as Shift) ?? null);

/** Aberta há mais de 14 h pelo relógio do servidor (o do celular pode estar errado). */
const shiftExpired = (shift: Shift) => serverNow() - new Date(shift.started_at).getTime() > MAX_SHIFT_MS;

// ───────────────────────────── coleta ─────────────────────────────

let foregroundSub: Location.LocationSubscription | null = null;
/** Ritmo configurado agora (null: desconhecido, ex.: app reaberto com a tarefa já rodando). */
let pace: Pace | null = null;

const backgroundPossible = () => Platform.OS !== "web" && !isRunningInExpoGo();
const appActive = () => AppState.currentState === "active";

async function canUseBackground(): Promise<boolean> {
  if (!backgroundPossible()) return false;
  try {
    if (!(await TaskManager.isAvailableAsync())) return false;
    return (await Location.getBackgroundPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

function taskOptions(next: Pace): Location.LocationTaskOptions {
  const interval = next === "saver" ? 60_000 : next === "transit" ? 15_000 : 30_000;
  return {
    accuracy: next === "transit" ? Location.Accuracy.High : Location.Accuracy.Balanced,
    // Entrega por tempo, mesmo parado: o mapa da gestão marca "sem sinal" após 5 min sem ponto.
    // No iOS (que ignora timeInterval) o GPS entrega com frequência e o app limita em handleLocations.
    timeInterval: interval,
    distanceInterval: 0,
    deferredUpdatesInterval: interval,
    pausesUpdatesAutomatically: false,
    activityType: next === "transit" ? Location.ActivityType.AutomotiveNavigation : Location.ActivityType.Other,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "Maxx Field · jornada em andamento",
      notificationBody: "Sua localização é compartilhada com a empresa somente durante a jornada.",
      notificationColor: "#2447FF",
      killServiceOnDestroy: false,
    },
  };
}

function foregroundNotice(): string {
  if (isRunningInExpoGo()) {
    return "Deixe o app aberto durante a jornada: nesta versão a localização não é registrada em segundo plano.";
  }
  if (Platform.OS === "web") return "Pré-visualização no navegador: só registra com a página aberta.";
  return "Sem permissão de localização “Sempre”: mantenha o app aberto ou libere nas configurações do aparelho.";
}

async function setPace(next: Pace) {
  pace = next;
  await setKv(PACE_KEY, next, undefined, { notify: false });
}

/** Ritmo guardado da última configuração (o app pode ter sido reaberto com a tarefa rodando). */
async function storedPace(): Promise<Pace | null> {
  const raw = await getKv(PACE_KEY);
  return raw === "normal" || raw === "transit" || raw === "saver" ? raw : null;
}

async function lowBattery(): Promise<boolean> {
  try {
    const power = await Battery.getPowerStateAsync();
    return power.batteryState === Battery.BatteryState.UNPLUGGED && power.batteryLevel >= 0 && power.batteryLevel < 0.15;
  } catch {
    return false;
  }
}

/** Ritmo pedido agora: economia de bateria, deslocamento (OS minha "Em deslocamento") ou normal. */
async function desiredPace(): Promise<Pace> {
  if (await lowBattery()) return "saver";
  const user = session.get().user;
  return user && (await hasTicketInTransit(user.id)) ? "transit" : "normal";
}

// ───────── ritmo: limitador de pontos e batimento com o app aberto ─────────

const LAST_POINT_KEY = "tracking_last_point_at";
const HEARTBEAT_MS = 60_000;
/** A cada quantos batimentos (~5 min) confere permissão e localização do aparelho. */
const HEALTH_EVERY = 5;
let lastStoredAt = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let beats = 0;

/** Intervalo mínimo entre pontos guardados: ~25 s, ~10 s em deslocamento, ~1 min economizando bateria. */
const minGapMs = () => (pace === "saver" ? 55_000 : pace === "transit" ? 10_000 : 25_000);

async function lastStored(): Promise<number> {
  if (!lastStoredAt) {
    const raw = await getKv(LAST_POINT_KEY);
    lastStoredAt = raw ? Number(raw) || 0 : 0;
  }
  return lastStoredAt;
}

function startHeartbeat() {
  if (heartbeat) return;
  beats = 0;
  heartbeat = setInterval(() => void beat(), HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = undefined;
}

/**
 * Com o app aberto (ou o serviço do Android de pé), garante um ponto a cada ~60 s mesmo parado (o
 * sistema pode não entregar posição nova sem movimento) e, de tempos em tempos, confere se a
 * permissão e a localização do aparelho continuam ligadas. Em segundo plano quem cuida é a tarefa.
 */
async function beat() {
  if (!state.shift) return;
  beats += 1;
  if (state.mode === "off" || beats % HEALTH_EVERY === 0) {
    void exclusive(checkCollection).catch((error: unknown) => console.warn("Falha ao conferir o rastreamento", error));
  }
  // Relógio que voltou para trás deixa a diferença negativa: vale o valor absoluto.
  if (state.mode === "off" || Math.abs(Date.now() - lastStoredAt) < HEARTBEAT_MS - 5_000) return;
  try {
    const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    await handleLocations([location], { force: true });
  } catch {
    // sem posição agora: a próxima batida tenta de novo
  }
}

function removeForegroundWatch() {
  foregroundSub?.remove();
  foregroundSub = null;
}

async function backgroundRunning(): Promise<boolean> {
  if (!backgroundPossible()) return false;
  return Location.hasStartedLocationUpdatesAsync(TRACKING_TASK).catch(() => false);
}

async function stopBackgroundTask() {
  if (!backgroundPossible()) return;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK)) await Location.stopLocationUpdatesAsync(TRACKING_TASK);
  } catch {
    // tarefa não registrada
  }
}

/** Para a coleta. `keepHeartbeat`: segue conferindo, para religar quando a permissão voltar. */
async function stopCollection({ keepHeartbeat = false } = {}) {
  if (!keepHeartbeat) stopHeartbeat();
  removeForegroundWatch();
  await stopBackgroundTask();
}

/**
 * Liga a coleta no ritmo pedido ou ajusta o ritmo da que já roda. Com a tarefa já registrada o
 * sistema só atualiza as opções, sem derrubar o serviço do Android. Nunca lança: sem GPS, o cartão
 * da jornada avisa e o batimento tenta de novo.
 */
async function startCollection(next: Pace): Promise<void> {
  if (!(state.shift ?? (await readShift()))) return; // a jornada acabou enquanto esperava a vez
  startHeartbeat();
  if (await canUseBackground()) {
    if (state.mode === "background" && pace === next && (await backgroundRunning())) return;
    if (Platform.OS === "android" && !appActive()) {
      // Com o app em segundo plano o Android recusa (re)configurar o serviço de localização e a
      // coleta pararia: segue no ritmo atual até o app voltar à tela.
      if (await backgroundRunning()) return;
    } else {
      try {
        await Location.startLocationUpdatesAsync(TRACKING_TASK, taskOptions(next));
        removeForegroundWatch();
        await setPace(next);
        modeNotice = null;
        problems.gps = null;
        setState({ mode: "background", transit: next === "transit", batterySaver: next === "saver" });
        refreshNotice();
        return;
      } catch (error) {
        console.warn("Rastreamento em segundo plano indisponível", error);
      }
    }
  }
  await stopBackgroundTask();
  if (foregroundSub && state.mode === "foreground" && pace === next) return;
  removeForegroundWatch();
  try {
    const opts = taskOptions(next);
    foregroundSub = await Location.watchPositionAsync(
      { accuracy: opts.accuracy, timeInterval: opts.timeInterval, distanceInterval: 0 },
      (location) => {
        handleLocations([location]).catch((error: unknown) => console.warn("Falha ao registrar posição da jornada", error));
      },
      (reason) => {
        console.warn("GPS indisponível", reason);
        setProblem("gps", GPS_FAILED);
      },
    );
    await setPace(next);
    modeNotice = foregroundNotice();
    problems.gps = null;
    setState({ mode: "foreground", transit: next === "transit", batterySaver: next === "saver" });
    refreshNotice();
  } catch (error) {
    console.warn("Não foi possível ligar o GPS", error);
    setState({ mode: "off", transit: false, batterySaver: false });
    setProblem("gps", GPS_FAILED);
  }
}

type LocationProblem = "permission" | "services" | null;

/** Permissão retirada ou localização do aparelho desligada no meio da jornada. */
async function locationProblem(): Promise<LocationProblem> {
  if (Platform.OS === "web") return null;
  try {
    if (!(await Location.getForegroundPermissionsAsync()).granted) return "permission";
    if (!(await Location.hasServicesEnabledAsync())) return "services";
  } catch {
    // sem como conferir agora
  }
  return null;
}

/**
 * Garante a coleta no ritmo certo, conferindo permissão e localização do aparelho. Sem permissão,
 * para (e o batimento segue conferindo para religar); localização desligada só avisa, porque a
 * coleta volta sozinha quando ela for ligada.
 */
async function ensureCollecting() {
  if (!state.shift) return;
  const problem = await locationProblem();
  if (problem === "permission") {
    await stopCollection({ keepHeartbeat: true });
    startHeartbeat();
    setState({ mode: "off", transit: false, batterySaver: false });
    setProblem("location", noPermissionNotice());
    return;
  }
  // App reaberto com a tarefa ainda rodando: retoma o ritmo que ela tem, sem reconfigurar à toa.
  if (state.mode === "off" && (await backgroundRunning())) {
    pace ??= await storedPace();
    setState({ mode: "background", transit: pace === "transit", batterySaver: pace === "saver" });
  }
  await startCollection(await desiredPace());
  setProblem("location", problem === "services" ? SERVICES_OFF : null);
}

/** Conferência periódica (batimento). No Android em segundo plano nada pode ser religado agora. */
async function checkCollection() {
  if (Platform.OS === "android" && !appActive()) return;
  await ensureCollecting();
}

/** Ajusta o ritmo quando uma OS entra ou sai de "Em deslocamento" (ou a bateria fica fraca). Nunca lança. */
export function updateTrackingMode(): Promise<void> {
  return exclusive(async () => {
    if (!state.shift || state.mode === "off") return;
    const next = await desiredPace();
    if (next !== pace) await startCollection(next);
  }).catch((error: unknown) => console.warn("Falha ao ajustar o ritmo do rastreamento", error));
}

// ───────────────────────────── pontos ─────────────────────────────

async function batteryPct(): Promise<number | null> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return level >= 0 ? Math.min(100, Math.max(0, Math.round(level * 100))) : null;
  } catch {
    return null;
  }
}

/** Posição de antena ou Wi-Fi (precisão pior que 1 km): só entra se não houver ponto há 4 min. */
const COARSE_M = 1_000;
const COARSE_GAP_MS = 4 * 60_000;
/** Ponto mais velho que o último guardado por mais que isto: o relógio do celular voltou para trás. */
const CLOCK_JUMP_MS = 3 * 60_000;

/** Coordenada utilizável. O iOS marca posição inválida com precisão negativa; (0, 0) é fix vazio. */
function usable(l: Location.LocationObject): boolean {
  const { latitude, longitude, accuracy } = l.coords;
  if (!Number.isFinite(l.timestamp) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) return false;
  return accuracy === null || !(accuracy < 0);
}

const inRange = (value: number | null, min: number, max = Number.POSITIVE_INFINITY) =>
  value !== null && Number.isFinite(value) && value >= min && value <= max ? value : null;

function toPing(l: Location.LocationObject, battery: number | null): Ping {
  return {
    recorded_at: new Date(l.timestamp).toISOString(),
    latitude: l.coords.latitude,
    longitude: l.coords.longitude,
    accuracy_m: inRange(l.coords.accuracy, 0),
    speed_mps: inRange(l.coords.speed, 0),
    heading: inRange(l.coords.heading, 0, 360),
    battery_pct: battery,
    is_mock: Boolean(l.mocked),
  };
}

/** Recebe pontos do GPS (tarefa de segundo plano ou watch em primeiro plano) e põe na fila. */
export async function handleLocations(locations: Location.LocationObject[], { force = false } = {}) {
  if (!locations.length) return;
  // A tarefa pode rodar com o app fechado: lê a sessão e a jornada do armazenamento.
  if (session.get().status === "loading") await session.load();
  const user = session.get().user;
  // Sessão encerrada (logout, senha redefinida, usuário desativado): para de coletar.
  if (session.get().status !== "signedIn" || !user) {
    await stopCollection();
    return;
  }
  const shift = state.shift ?? (await readShift());
  if (!shift) return; // fora da jornada nada é guardado
  // Jornada esquecida aberta (LGPD): encerra em vez de seguir coletando.
  if (shiftExpired(shift)) {
    await exclusive(autoEndShift);
    return;
  }

  // Limitador: o GPS pode entregar a cada segundo (iOS sem filtro de distância); guarda ~1 a cada 25 s.
  let last = await lastStored();
  const kept: Location.LocationObject[] = [];
  for (const l of [...locations].sort((a, b) => a.timestamp - b.timestamp)) {
    if (!usable(l)) continue;
    // Hora do celular acertada para trás: recomeça o limitador em vez de descartar tudo até o
    // relógio alcançar o último ponto guardado.
    if (l.timestamp < last - CLOCK_JUMP_MS) last = 0;
    if ((l.coords.accuracy ?? 0) > COARSE_M && l.timestamp - last < COARSE_GAP_MS) continue;
    if (force || l.timestamp - last >= minGapMs()) {
      kept.push(l);
      last = l.timestamp;
    }
  }
  if (!kept.length) return;

  const battery = await batteryPct();
  const pings = kept.map((l) => toPing(l, battery));
  // Pontos e marcador do último ponto juntos (o app pode morrer entre um e outro). Silencioso:
  // nenhuma tela lista os pontos, e avisar as telas a cada ponto recarregaria tudo o dia inteiro.
  // Se outro técnico entrou no aparelho enquanto isto rodava, os pontos do anterior não entram.
  try {
    await transaction(
      async (db) => {
        await insertPingRows(db, pings);
        await setKv(LAST_POINT_KEY, String(last), db);
      },
      { notify: false, guard: () => session.get().user?.id === user.id },
    );
  } catch (error) {
    if (error instanceof WriteCancelled) return;
    throw error;
  }
  lastStoredAt = last;
  setState({ lastFixAt: pings[pings.length - 1].recorded_at, queued: await countPings() });
  void flushPings();
}

function toWire(p: Ping) {
  const out: Record<string, unknown> = {
    recorded_at: p.recorded_at,
    latitude: p.latitude,
    longitude: p.longitude,
    is_mock: p.is_mock,
  };
  if (p.accuracy_m !== null) out.accuracy_m = p.accuracy_m;
  if (p.speed_mps !== null) out.speed_mps = p.speed_mps;
  if (p.heading !== null) out.heading = p.heading;
  if (p.battery_pct !== null) out.battery_pct = p.battery_pct;
  return out;
}

let flushRun: Promise<void> | null = null;
let lastFlush = 0;

/**
 * Envia a fila em lotes de até 500. Sem rede, os pontos ficam para a próxima. Em segundo plano
 * junta os pontos (o rádio do celular dorme entre os envios): envia quando o mais antigo passa de
 * 60 s em deslocamento ou de 2 min nos outros casos. `force` (sync, fim da jornada) envia na hora,
 * esperando um envio que já estava em andamento. Nunca lança.
 */
export function flushPings(force = false): Promise<void> {
  if (flushRun) return force ? flushRun.then(() => flushPings(true)) : flushRun;
  if (!force && Date.now() - lastFlush < FLUSH_MIN_INTERVAL_MS) return Promise.resolve();
  const run = sendQueued(force).finally(() => {
    flushRun = null;
  });
  flushRun = run;
  return run;
}

async function backgroundBatchDue(): Promise<boolean> {
  const oldest = await oldestPingAt();
  if (!oldest) return false;
  return Math.abs(Date.now() - new Date(oldest).getTime()) >= (pace === "transit" ? 60_000 : 120_000);
}

interface Delivery {
  accepted: number;
  discarded: number;
  sent: number;
  stop: boolean;
}

async function sendQueued(force: boolean): Promise<void> {
  try {
    if (session.get().status === "loading") await session.load();
    const user = session.get().user;
    if (session.get().status !== "signedIn" || !user) return;
    if (!force && !appActive() && !(await backgroundBatchDue())) return;
    lastFlush = Date.now();
    const guard = () => session.get().user?.id === user.id;
    const total: Delivery = { accepted: 0, discarded: 0, sent: 0, stop: false };
    for (let round = 0; round < 20; round++) {
      const batch = await listPings(BATCH);
      if (!batch.length) break;
      const delivery = await postPings(batch, guard);
      total.accepted += delivery.accepted;
      total.discarded += delivery.discarded;
      total.sent += delivery.sent;
      if (delivery.stop || batch.length < BATCH) break;
    }
    if (total.sent) reviewDelivery(total);
  } catch (error) {
    if (!(error instanceof WriteCancelled)) setState({ error: errorMessage(error) });
  } finally {
    setState({ queued: await countPings().catch(() => state.queued) });
  }
}

/** Um lote. Um ponto inválido faz o servidor recusar o lote inteiro (422): divide até isolar só ele. */
async function postPings(batch: Ping[], guard: () => boolean): Promise<Delivery> {
  let result: { accepted?: number; discarded?: number } | null;
  try {
    result = await api.post<{ accepted?: number; discarded?: number } | null>("/tracking/pings", { pings: batch.map(toWire) });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      setState({ serverAvailable: false, error: "O servidor ainda não recebe rastreamento." });
      return { accepted: 0, discarded: 0, sent: 0, stop: true };
    }
    if (error instanceof ApiError && error.status === 422) {
      if (batch.length === 1) {
        await deletePings([batch[0].recorded_at], guard);
        setState({ error: `Ponto recusado pelo servidor: ${error.message}` });
        return { accepted: 0, discarded: 0, sent: 0, stop: false };
      }
      const half = Math.ceil(batch.length / 2);
      const first = await postPings(batch.slice(0, half), guard);
      if (first.stop) return first;
      const second = await postPings(batch.slice(half), guard);
      return {
        accepted: first.accepted + second.accepted,
        discarded: first.discarded + second.discarded,
        sent: first.sent + second.sent,
        stop: second.stop,
      };
    }
    // Sem rede, servidor fora ou um proxy recusando (413, 400…): os pontos ficam para a próxima.
    setState({ error: errorMessage(error) });
    return { accepted: 0, discarded: 0, sent: 0, stop: true };
  }
  await deletePings(batch.map((p) => p.recorded_at), guard);
  const accepted = result?.accepted ?? batch.length;
  // "Última posição enviada" só quando o servidor gravou algum ponto deste lote.
  setState({ error: null, serverAvailable: true, ...(accepted > 0 ? { lastSentAt: new Date().toISOString() } : {}) });
  return { accepted, discarded: result?.discarded ?? 0, sent: batch.length, stop: false };
}

/**
 * Pontos enviados e todos descartados pelo servidor (fora de uma jornada aberta lá ou mais de
 * 2 min no futuro): relógio do celular errado ou jornada encerrada no servidor. Avisa ou para.
 */
function reviewDelivery({ accepted, discarded, sent }: Delivery) {
  if (accepted > 0) {
    if (problems.clock) setProblem("clock", null);
    return;
  }
  if (discarded < sent || !state.shift) return;
  if (Math.abs(getServerOffsetMs()) > CLOCK_LIMIT_MS) {
    setProblem("clock", CLOCK_NOTICE);
    return;
  }
  void exclusive(confirmShiftOpen).catch((error: unknown) => console.warn("Falha ao conferir a jornada", error));
}

/** Relógio certo e pontos descartados: a jornada pode ter sido encerrada no servidor. */
async function confirmShiftOpen() {
  if (!state.shift) return;
  let open: Shift | null;
  try {
    open = unwrapShift(await api.get("/tracking/shift"));
  } catch {
    return; // sem rede: confere numa próxima vez
  }
  if (open) {
    if (open.id !== state.shift.id) await writeShift(open);
    return;
  }
  await stopCollection();
  await writeShift(null);
  pace = null;
  void cancelShiftReminder();
  setState({ mode: "off", transit: false, batterySaver: false });
  clearNotices();
  showToast("Sua jornada foi encerrada no servidor", {
    description: "O rastreamento parou. Inicie uma nova jornada quando for trabalhar.",
  });
}

// ───────────────────────────── termo e jornada ─────────────────────────────

/** Grava o aceite do termo de rastreamento (LGPD) e atualiza o usuário. */
export async function acceptConsent() {
  await api.post("/tracking/consent");
  await refreshMe();
}

let consentPrompted = false;

/** O termo é oferecido sozinho uma vez por abertura do app (o técnico pode deixar para depois). */
export function shouldPromptConsent(): boolean {
  if (consentPrompted || hasConsent()) return false;
  consentPrompted = true;
  return true;
}

export interface LocationPermissions {
  foreground: boolean;
  /** "Sempre"/"Permitir o tempo todo"; só existe no app instalado (não no Expo Go nem na web). */
  background: boolean | null;
}

/** Pede a permissão de localização do sistema (uso no app e, quando possível, em segundo plano). */
export async function requestLocationPermissions(): Promise<LocationPermissions> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { foreground: false, background: null };
  if (!backgroundPossible()) return { foreground: true, background: null };
  try {
    const bg = await Location.requestBackgroundPermissionsAsync();
    return { foreground: true, background: bg.granted };
  } catch {
    return { foreground: true, background: false };
  }
}

// ───────────────────────────── lembrete da jornada aberta ─────────────────────────────

/** Notificação local 10 h depois do início: "encerre se já terminou o dia". Sem permissão, não agenda. */
async function scheduleShiftReminder(shift: Shift) {
  if (Platform.OS === "web") return;
  try {
    // Horário do servidor convertido para o relógio do aparelho, que é o que dispara a notificação.
    const at = new Date(new Date(shift.started_at).getTime() + REMINDER_AFTER_MS - getServerOffsetMs());
    if (at.getTime() <= Date.now()) return;
    const Notifications = await import("expo-notifications");
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL, {
        name: "Jornada",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    await Notifications.scheduleNotificationAsync({
      identifier: REMINDER_ID,
      content: { title: "Sua jornada ainda está aberta", body: "Encerre a jornada no app se você já terminou o dia." },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: REMINDER_CHANNEL },
    });
  } catch (error) {
    console.warn("Lembrete da jornada indisponível", error);
  }
}

async function cancelShiftReminder() {
  if (Platform.OS === "web") return;
  try {
    const Notifications = await import("expo-notifications");
    await Notifications.cancelScheduledNotificationAsync(REMINDER_ID);
  } catch {
    // nada agendado
  }
}

// ───────────────────────────── iniciar, encerrar e retomar ─────────────────────────────

/** Encerramento feito sem sinal (guardado no aparelho): envia antes de qualquer outra ação da jornada. */
async function sendPendingEnd(): Promise<void> {
  const raw = await getKv(END_PENDING_KEY);
  if (!raw) return;
  let body: Partial<Position> = {};
  try {
    body = JSON.parse(raw) as Partial<Position>;
  } catch {
    body = {};
  }
  try {
    await api.post("/tracking/shift/end", { latitude: body.latitude ?? null, longitude: body.longitude ?? null });
  } catch (error) {
    // Sem rede ou servidor fora: fica para a próxima. Recusa definitiva: não adianta repetir.
    if (!(error instanceof ApiError) || error.retryable || error.status === 401) return;
  }
  await setKv(END_PENDING_KEY, null, undefined, { notify: false });
}

/** Envia um encerramento de jornada feito sem sinal (rodada de sync). Nunca lança. */
export function flushPendingShiftEnd(): Promise<void> {
  return exclusive(sendPendingEnd).catch((error: unknown) => console.warn("Falha ao enviar o encerramento da jornada", error));
}

async function openShiftOnServer(position: Position | null): Promise<Shift> {
  let data: unknown;
  try {
    data = await api.post("/tracking/shift/start", position ?? {});
  } catch (error) {
    if (error instanceof ApiError && error.status === 0) throw new Error("Conecte-se à internet para iniciar a jornada.");
    if (error instanceof ApiError && error.status === 404) {
      setState({ serverAvailable: false });
      throw new Error("O servidor ainda não tem o rastreamento de jornada.");
    }
    throw error;
  }
  const shift = unwrapShift(data);
  if (!shift) throw new Error("O servidor não abriu a jornada.");
  return shift;
}

/** Inicia a jornada: pede permissões, abre a jornada no servidor e começa a coletar. */
export function startShift(): Promise<void> {
  return exclusive(async () => {
    if (!hasConsent()) throw new ConsentRequiredError();
    const permissions = await requestLocationPermissions();
    if (!permissions.foreground) throw new Error("Permita o acesso à localização para iniciar a jornada.");
    // Encerramento anterior feito sem sinal vai antes: senão o servidor devolveria a jornada antiga
    // como se fosse a nova, e o encerramento atrasado fecharia a nova depois.
    await sendPendingEnd();
    if (await getKv(END_PENDING_KEY)) throw new Error("Conecte-se à internet para iniciar a jornada.");
    const position = await currentPosition();
    let shift = await openShiftOnServer(position);
    // O servidor devolveu uma jornada esquecida aberta de outro dia: fecha e abre a de hoje.
    if (shiftExpired(shift)) {
      await api.post("/tracking/shift/end", {});
      shift = await openShiftOnServer(position);
    }
    await writeShift(shift);
    // Jornada nova: o primeiro ponto entra sem esperar o intervalo mínimo.
    lastStoredAt = 0;
    await setKv(LAST_POINT_KEY, null, undefined, { notify: false });
    clearNotices();
    setState({ serverAvailable: true, error: null });
    await startCollection(await desiredPace());
    void scheduleShiftReminder(shift);
  });
}

/**
 * Para a coleta na hora, envia os pontos que restaram e fecha a jornada no servidor. O
 * encerramento é guardado antes do envio: sem rede (ou com o app morto no meio), ele vai na
 * próxima sincronização e, até lá, o aparelho já trata a jornada como encerrada.
 */
async function closeShift(withPosition: boolean) {
  const position = withPosition ? await currentPosition() : null;
  await stopCollection();
  // A partir daqui nenhum ponto novo entra na fila (handleLocations exige jornada aberta).
  await writeShift(null);
  pace = null;
  setState({ mode: "off", transit: false, batterySaver: false });
  clearNotices();
  void cancelShiftReminder();
  await flushPings(true);
  await setKv(END_PENDING_KEY, JSON.stringify(position ?? {}), undefined, { notify: false });
  await sendPendingEnd();
}

/**
 * Encerra a jornada: para a coleta na hora, envia o que restou e fecha no servidor.
 * Sem rede, o encerramento fica pendente e é enviado na próxima sincronização.
 */
export function endShift(): Promise<void> {
  return exclusive(() => closeShift(true));
}

/** Jornada aberta há mais de 14 h (esquecida): encerra como se o técnico tivesse tocado em Encerrar. */
async function autoEndShift() {
  if (!(state.shift ?? (await readShift()))) return;
  await closeShift(false);
  showToast("Jornada encerrada automaticamente", {
    description: "Ela estava aberta havia mais de 14 h. Inicie uma nova quando começar a trabalhar.",
  });
}

/**
 * Abertura do app/volta ao primeiro plano: confere a jornada no servidor e garante a coleta no
 * ritmo certo (o app pode ter sido fechado ou o aparelho reiniciado no meio da jornada).
 */
export function resumeTracking(): Promise<void> {
  return exclusive(resumeNow);
}

async function resumeNow() {
  await flushPings(true);
  await sendPendingEnd();
  // Encerramento feito sem sinal que ainda não chegou: para o aparelho a jornada já acabou, mesmo
  // que o servidor ainda a mostre aberta (nada de religar o GPS depois do "Encerrar").
  const endPending = Boolean(await getKv(END_PENDING_KEY));
  let shift = endPending ? null : await readShift();
  if (!endPending) {
    try {
      shift = unwrapShift(await api.get("/tracking/shift"));
      setState({ serverAvailable: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setState({ serverAvailable: false });
      // offline: vale a jornada guardada no aparelho
    }
  }
  await writeShift(shift);
  setState({ queued: await countPings() });
  if (shift && shiftExpired(shift)) {
    await autoEndShift();
    return;
  }
  if (!shift) {
    await stopCollection();
    pace = null;
    setState({ mode: "off", transit: false, batterySaver: false });
    clearNotices();
    return;
  }
  await ensureCollecting();
}

/** Logout/perda de acesso: encerra a jornada (se der) e para tudo. */
export function stopTracking({ endOnServer }: { endOnServer: boolean }): Promise<void> {
  return exclusive(async () => {
    const shift = state.shift ?? (await readShift().catch(() => null));
    if (endOnServer && shift) {
      try {
        await closeShift(true);
      } catch {
        // segue o logout
      }
    }
    await stopCollection();
    void cancelShiftReminder();
    // Sem jornada local: nada mais é coletado. No próximo login, GET /tracking/shift diz se ela segue aberta.
    await writeShift(null).catch(() => undefined);
    pace = null;
    lastStoredAt = 0;
    clearNotices();
    setState({
      shift: null,
      mode: "off",
      transit: false,
      batterySaver: false,
      lastFixAt: null,
      lastSentAt: null,
      queued: 0,
      error: null,
    });
  });
}
