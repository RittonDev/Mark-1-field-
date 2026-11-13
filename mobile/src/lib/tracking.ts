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

function taskOptions(transit: boolean): Location.LocationTaskOptions {
  return {
    accuracy: transit ? Location.Accuracy.High : Location.Accuracy.Balanced,
    // Entrega por tempo, mesmo parado: o mapa da gestão marca "sem sinal" após 5 min sem ponto.
    // No iOS (que ignora timeInterval) o GPS entrega com frequência e o app limita em handleLocations.
    timeInterval: transit ? 15_000 : 30_000,
    distanceInterval: 0,
    deferredUpdatesInterval: transit ? 15_000 : 30_000,
    pausesUpdatesAutomatically: false,
    activityType: transit ? Location.ActivityType.AutomotiveNavigation : Location.ActivityType.Other,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "Maxx Field · jornada em andamento",
      notificationBody: "Sua localização é compartilhada com a empresa somente durante a jornada.",
      notificationColor: "#2447FF",
      killServiceOnDestroy: false,
    },
  };
}

// ───────── ritmo: limitador de pontos e batimento com o app aberto ─────────

const LAST_POINT_KEY = "tracking_last_point_at";
const HEARTBEAT_MS = 60_000;
let lastStoredAt = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Intervalo mínimo entre pontos guardados: ~25 s, ~10 s em deslocamento. */
const minGapMs = () => (state.transit ? 10_000 : 25_000);

async function lastStored(): Promise<number> {
  if (!lastStoredAt) {
    const raw = await getKv(LAST_POINT_KEY);
    lastStoredAt = raw ? Number(raw) || 0 : 0;
  }
  return lastStoredAt;
}

/**
 * Com o app aberto, garante um ponto a cada ~60 s mesmo parado (o sistema pode não entregar
 * posição nova sem movimento). Em segundo plano quem cuida é a tarefa do sistema.
 */
function startHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    if (!state.shift || Date.now() - lastStoredAt < HEARTBEAT_MS - 5_000) return;
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
      .then((location) => handleLocations([location], { force: true }))
      .catch(() => undefined);
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = undefined;
}

async function stopCollection() {
  stopHeartbeat();
  foregroundSub?.remove();
  foregroundSub = null;
  if (!backgroundPossible()) return;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK)) await Location.stopLocationUpdatesAsync(TRACKING_TASK);
  } catch {
    // tarefa não registrada
  }
}

async function startCollection(transit: boolean) {
  await stopCollection();
  startHeartbeat();
  if (await canUseBackground()) {
    await Location.startLocationUpdatesAsync(TRACKING_TASK, taskOptions(transit));
    setState({ mode: "background", transit, notice: null });
    return;
  }
  const opts = taskOptions(transit);
  foregroundSub = await Location.watchPositionAsync(
    { accuracy: opts.accuracy, timeInterval: opts.timeInterval, distanceInterval: 0 },
    (location) => void handleLocations([location]),
  );
  setState({
    mode: "foreground",
    transit,
    notice: isRunningInExpoGo()
      ? "No Expo Go o rastreamento só funciona com o app aberto. No app instalado ele continua em segundo plano."
      : Platform.OS === "web"
        ? "Pré-visualização no navegador: só registra com a página aberta."
        : "Sem permissão de localização “Sempre”: mantenha o app aberto ou libere nas configurações do aparelho.",
  });
}

/** Há OS minha em deslocamento? (coleta mais frequente) */
async function inTransit(): Promise<boolean> {
  const user = session.get().user;
  if (!user) return false;
  const tickets = await listTickets();
  return tickets.some((t) => t.assignee?.id === user.id && t.status === "en_route");
}

/** Ajusta o ritmo da coleta quando uma OS entra ou sai de "Em deslocamento". */
export async function updateTrackingMode() {
  if (!state.shift || state.mode === "off") return;
  const transit = await inTransit();
  if (transit !== state.transit) await startCollection(transit);
}

// ───────────────────────────── pontos ─────────────────────────────

async function batteryPct(): Promise<number | null> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return level >= 0 ? Math.round(level * 100) : null;
  } catch {
    return null;
  }
}

/** Recebe pontos do GPS (tarefa de segundo plano ou watch em primeiro plano) e põe na fila. */
export async function handleLocations(locations: Location.LocationObject[], { force = false } = {}) {
  if (!locations.length) return;
  // A tarefa pode rodar com o app fechado: lê a sessão e a jornada do armazenamento.
  if (session.get().status === "loading") await session.load();
  // Sessão encerrada (logout, senha redefinida, usuário desativado): para de coletar.
  if (session.get().status !== "signedIn") {
    await stopCollection();
    return;
  }
  const shift = state.shift ?? (await readShift());
  if (!shift) return; // fora da jornada nada é guardado

  // Limitador: o GPS pode entregar a cada segundo (iOS sem filtro de distância); guarda ~1 a cada 25 s.
  let last = await lastStored();
  const kept: Location.LocationObject[] = [];
  for (const l of [...locations].sort((a, b) => a.timestamp - b.timestamp)) {
    if (force || l.timestamp - last >= minGapMs()) {
      kept.push(l);
      last = l.timestamp;
    }
  }
  if (!kept.length) return;
  lastStoredAt = last;
  await setKv(LAST_POINT_KEY, String(last));

  const battery = await batteryPct();
  const pings: Ping[] = kept.map((l) => ({
    recorded_at: new Date(l.timestamp).toISOString(),
    latitude: l.coords.latitude,
    longitude: l.coords.longitude,
    accuracy_m: l.coords.accuracy ?? null,
    speed_mps: l.coords.speed !== null && l.coords.speed >= 0 ? l.coords.speed : null,
    heading: l.coords.heading !== null && l.coords.heading >= 0 && l.coords.heading <= 360 ? l.coords.heading : null,
    battery_pct: battery,
    is_mock: Boolean(l.mocked),
  }));
  await insertPings(pings);
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

let flushing = false;
let lastFlush = 0;

/** Envia a fila em lotes de até 500. Sem rede, os pontos ficam para a próxima. */
export async function flushPings(force = false) {
  if (flushing) return;
  if (!force && Date.now() - lastFlush < FLUSH_MIN_INTERVAL_MS) return;
  if (session.get().status === "loading") await session.load();
  if (session.get().status !== "signedIn") return;
  flushing = true;
  lastFlush = Date.now();
  try {
    for (let round = 0; round < 20; round++) {
      const batch = await listPings(BATCH);
      if (!batch.length) break;
      try {
        await api.post<{ accepted: number; discarded: number }>("/tracking/pings", { pings: batch.map(toWire) });
        await deletePings(batch.map((p) => p.recorded_at));
        setState({ lastSentAt: new Date().toISOString(), error: null, serverAvailable: true });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          setState({ serverAvailable: false, error: "O servidor ainda não recebe rastreamento." });
          break;
        }
        if (error instanceof ApiError && !error.retryable && error.status !== 401) {
          // Lote recusado por validação: reenviar igual não adianta.
          await deletePings(batch.map((p) => p.recorded_at));
          setState({ error: `Pontos recusados: ${error.message}` });
          continue;
        }
        setState({ error: errorMessage(error) });
        break;
      }
      if (batch.length < BATCH) break;
    }
  } finally {
    flushing = false;
    setState({ queued: await countPings() });
  }
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

/** Inicia a jornada: pede permissões, abre a jornada no servidor e começa a coletar. */
export async function startShift() {
  if (!hasConsent()) throw new ConsentRequiredError();
  const permissions = await requestLocationPermissions();
  if (!permissions.foreground) throw new Error("Permita o acesso à localização para iniciar a jornada.");
  const position = await currentPosition();
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
  await writeShift(shift);
  // Jornada nova: o primeiro ponto entra sem esperar o intervalo mínimo.
  lastStoredAt = 0;
  await setKv(LAST_POINT_KEY, null);
  setState({ serverAvailable: true, error: null });
  await startCollection(await inTransit());
}

/**
 * Encerra a jornada: para a coleta na hora, envia o que restou e fecha no servidor.
 * Sem rede, o encerramento fica pendente e é enviado na próxima sincronização.
 */
export async function endShift() {
  const position = await currentPosition();
  await stopCollection();
  // A partir daqui nenhum ponto novo entra na fila (handleLocations exige jornada aberta).
  await writeShift(null);
  setState({ mode: "off", transit: false, notice: null });
  await flushPings(true);
  try {
    await api.post("/tracking/shift/end", position ?? {});
  } catch (error) {
    if (error instanceof ApiError && (error.retryable || error.status === 401)) {
      await setKv(END_PENDING_KEY, JSON.stringify(position ?? {}));
    }
  }
}

/**
 * Abertura do app/volta da rede: confere a jornada no servidor e garante que a coleta está rodando
 * (o app pode ter sido fechado ou o aparelho reiniciado no meio da jornada).
 */
export async function resumeTracking() {
  const pendingEnd = await getKv(END_PENDING_KEY);
  if (pendingEnd) {
    try {
      const body = JSON.parse(pendingEnd) as Record<string, unknown>;
      await api.post("/tracking/shift/end", { latitude: body.latitude, longitude: body.longitude });
      await setKv(END_PENDING_KEY, null);
    } catch (error) {
      if (error instanceof ApiError && !error.retryable && error.status !== 401) await setKv(END_PENDING_KEY, null);
    }
  }

  let shift = await readShift();
  try {
    shift = unwrapShift(await api.get("/tracking/shift"));
    await writeShift(shift);
    setState({ serverAvailable: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) setState({ serverAvailable: false });
    // offline: vale a jornada guardada no aparelho
  }
  setState({ shift, queued: await countPings() });

  if (!shift) {
    await stopCollection();
    setState({ mode: "off", transit: false, notice: null });
    return;
  }
  const running =
    foregroundSub !== null ||
    (backgroundPossible() && (await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK).catch(() => false)));
  if (!running) await startCollection(await inTransit());
  else if (state.mode === "off") setState({ mode: foregroundSub ? "foreground" : "background" });
  void flushPings(true);
}

/** Logout/perda de acesso: encerra a jornada (se der) e para tudo. */
export async function stopTracking({ endOnServer }: { endOnServer: boolean }) {
  if (endOnServer && state.shift) {
    try {
      await endShift();
    } catch {
      // segue o logout
    }
  }
  await stopCollection();
  // Sem jornada local: nada mais é coletado. No próximo login, GET /tracking/shift diz se ela segue aberta.
  await writeShift(null).catch(() => undefined);
  setState({ shift: null, mode: "off", transit: false, notice: null, lastFixAt: null, lastSentAt: null, queued: 0 });
}
