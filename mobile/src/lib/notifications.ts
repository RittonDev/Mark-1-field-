// Notificações do aparelho (expo-notifications), num lugar só: handler, canais do Android, permissão, toque,
// alertas locais (tempo na loja e lembretes da visita) e as novidades da sincronização como notificação do
// sistema quando o app está fora da tela. Na web não há nada disso.
//
// - Locais: funcionam offline, com o app fechado e no Expo Go (Android e iOS). O push da central ainda não está
//   ligado (device.ts); quando estiver, o POST /devices responde "live" e a sincronização para de repetir o aviso.
// - Permissão: um único pedido automático, uma vez por técnico (auth.ts, depois do termo de localização). Depois
//   disso, só pelos botões da Conta.
// - Toque: aviso de OS abre a OS, de oferta abre a oferta, resumo abre Hoje.
//
// Não importa sync, auth nem device: eles importam este módulo.

import type * as NotificationsApi from "expo-notifications";
import { router } from "expo-router";
import { AppState, Linking, Platform } from "react-native";
import { getServerOffsetMs, serverNow } from "./api";
import { getKv, listTickets, setKv } from "./db";
import { loadOfferStore, pendingOffers } from "./offers";
import { ONSITE_CHANNEL, reconcileOnsiteAlerts } from "./onsiteAlerts";
import { session } from "./session";
import type { LocalTicket } from "./syncTypes";
import type { User } from "./types";
import { planVisitReminders, remindableVisits, VISIT_PREFIX, type PlannedReminder } from "./visitReminders";

export type NotificationsModule = typeof NotificationsApi;
type NotificationRequest = NotificationsApi.NotificationRequest;
type NotificationResponse = NotificationsApi.NotificationResponse;

/** Novidades (OS nova, oferta, reagendamento...): canal "Ordens de serviço", o mesmo do push da central. */
const NEWS_CHANNEL = "default";
const REMINDERS_CHANNEL = "lembretes";
/** O pedido automático da permissão já foi feito para este técnico (o kv some na troca de técnico). */
const ASKED_KEY = "notifications_asked";
/** "off": o técnico desligou os lembretes da visita na Conta (sem a chave, ligados). */
const VISIT_REMINDERS_KEY = "visit_reminders";

// ───────────────────────────── preparo, handler e toque ─────────────────────────────

let ready: Promise<NotificationsModule | null> | null = null;
let launchHandled = false;

/**
 * Prepara as notificações uma vez: handler (com o app na tela, mostra banner, lista e som; o push da central não
 * aparece, porque a sincronização já mostra o toast), canais do Android e o toque. `launch` (só no início da
 * sessão): trata também o toque que abriu o app. Na web devolve null.
 */
export async function ensureNotificationsReady({ launch = false }: { launch?: boolean } = {}): Promise<NotificationsModule | null> {
  if (Platform.OS === "web") return null;
  ready ??= setUp().catch((error: unknown) => {
    console.warn("Notificações indisponíveis", error);
    ready = null; // tenta de novo na próxima vez
    return null;
  });
  const N = await ready;
  if (N && launch && !launchHandled) {
    launchHandled = true;
    try {
      const last = N.getLastNotificationResponse();
      if (last) openResponse(N, last);
    } catch (error) {
      console.warn("Não foi possível ler o toque que abriu o app", error);
    }
  }
  return N;
}

async function setUp(): Promise<NotificationsModule> {
  // Import tardio: o módulo nativo só carrega quando há o que notificar.
  const N = await import("expo-notifications");
  N.setNotificationHandler({
    handleNotification: async (notification) => {
      const show = !isRemote(notification.request);
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
    },
  });
  N.addNotificationResponseReceivedListener((response) => openResponse(N, response));
  if (Platform.OS === "android") {
    // No Android 13 o pedido de permissão só aparece depois que existe um canal.
    try {
      await N.setNotificationChannelAsync(NEWS_CHANNEL, { name: "Ordens de serviço", importance: N.AndroidImportance.HIGH });
      await N.setNotificationChannelAsync(REMINDERS_CHANNEL, {
        name: "Lembretes das visitas",
        importance: N.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 150, 250],
      });
      await N.setNotificationChannelAsync(ONSITE_CHANNEL, {
        name: "Tempo na loja",
        importance: N.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 150, 250],
      });
    } catch (error) {
      console.warn("Não foi possível criar os canais de notificação", error);
    }
  }
  return N;
}

/** Push da central (remoto), e não uma notificação agendada ou mostrada pelo próprio app. */
function isRemote(request: NotificationRequest): boolean {
  const trigger = request.trigger as { type?: unknown } | null;
  return trigger?.type === "push";
}

type Target = { ticketId: string } | { offerId: string } | { home: true };

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/** Para onde o toque leva. Sem destino (ex.: o lembrete da jornada), só abre o app. */
async function targetOf(request: NotificationRequest): Promise<Target | null> {
  const data = request.content.data ?? {};
  const offerId = text(data.offerId);
  if (offerId) return { offerId };
  // Alertas da loja agendados por versões anteriores levam a OS só no identificador.
  const ticketId = text(data.ticketId) ?? /^onsite-(?:warning|over)-(.+)$/.exec(request.identifier)?.[1] ?? null;
  if (ticketId) return { ticketId };
  if (data.home === true) return { home: true };
  // Push da central: {ticket_id, type}. A oferta abre a oferta pendente daquela OS (ela ainda não é do técnico).
  const pushed = text(data.ticket_id);
  if (!pushed) return null;
  if (data.type !== "ticket.offer") return { ticketId: pushed };
  const offer = pendingOffers((await loadOfferStore()).offers, serverNow()).find((item) => item.ticket.id === pushed);
  return offer ? { offerId: offer.id } : { home: true };
}

async function go(target: Target) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      if ("offerId" in target) router.push({ pathname: "/oferta/[id]", params: { id: target.offerId } });
      else if ("ticketId" in target) router.push({ pathname: "/ticket/[id]", params: { id: target.ticketId } });
      else router.dismissTo("/");
      return;
    } catch {
      // Toque que abriu o app: a navegação ainda está montando (sessão sendo lida, fonte carregando).
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/** Último toque tratado: o mesmo toque pode chegar pelo ouvinte e como o que abriu o app. */
let lastTap: string | null = null;

function openResponse(N: NotificationsModule, response: NotificationResponse) {
  const { request, date } = response.notification;
  const key = `${request.identifier}@${date}`;
  if (key === lastTap) return;
  lastTap = key;
  try {
    N.clearLastNotificationResponse(); // a próxima abertura do app não leva de novo ao mesmo lugar
  } catch {
    // nada guardado
  }
  if (!session.get().user) return;
  targetOf(request)
    .then((target) => (target ? go(target) : undefined))
    .catch((error: unknown) => console.warn("Não foi possível abrir a notificação", error));
}

// ───────────────────────────── permissão ─────────────────────────────

/**
 * Pede a permissão de notificações (os canais do Android vêm antes). Só pede se o sistema ainda deixa
 * (`canAskAgain`). `auto`: o pedido que o app faz sozinho, no máximo uma vez por técnico; os botões da Conta pedem
 * quando o técnico quiser. Devolve se as notificações estão liberadas.
 */
export async function askNotificationPermission({ auto = false }: { auto?: boolean } = {}): Promise<boolean> {
  const N = await ensureNotificationsReady();
  if (!N) return false;
  try {
    const current = await N.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    if (auto) {
      if (await getKv(ASKED_KEY)) return false;
      await setKv(ASKED_KEY, "1", undefined, { notify: false });
    }
    return (await N.requestPermissionsAsync()).granted;
  } catch (error) {
    console.warn("Não foi possível pedir a permissão de notificações", error);
    return false;
  }
}

export interface NotificationState {
  /** "unavailable": sem notificações nesta versão do app (web). */
  permission: "granted" | "denied" | "undetermined" | "unavailable";
  canAskAgain: boolean;
  /** Android: alarme exato liberado (sem ele, o aviso pode atrasar alguns minutos). null fora do Android. */
  exactAlarm: boolean | null;
}

/** Estado atual da permissão (a Conta relê ao abrir e quando o app volta à tela). */
export async function notificationState(): Promise<NotificationState> {
  const N = await ensureNotificationsReady();
  if (!N) return { permission: "unavailable", canAskAgain: false, exactAlarm: null };
  const current = await N.getPermissionsAsync();
  const exactAlarm =
    Platform.OS === "android"
      ? await N.getExactAlarmPermissionsAsync().then(
          (result) => result.granted,
          () => null,
        )
      : null;
  return {
    permission: current.granted ? "granted" : current.status === N.PermissionStatus.DENIED ? "denied" : "undetermined",
    canAskAgain: current.canAskAgain,
    exactAlarm,
  };
}

/**
 * Android 12 ou mais novo: abre a tela do sistema do alarme exato. Liberado, agenda tudo de novo para valer na hora
 * certa. Sem a permissão declarada no app (ex.: Expo Go), abre as configurações do app.
 */
export async function requestExactAlarm(): Promise<boolean> {
  const N = await ensureNotificationsReady();
  if (!N || Platform.OS !== "android") return true;
  let granted: boolean;
  try {
    granted = (await N.requestExactAlarmPermissionsAsync()).granted;
  } catch {
    await Linking.openSettings().catch(() => undefined);
    return false;
  }
  if (granted) await syncLocalAlerts({ force: true });
  return granted;
}

// ───────────────────────────── alertas locais ─────────────────────────────

export async function visitRemindersEnabled(): Promise<boolean> {
  return (await getKv(VISIT_REMINDERS_KEY)) !== "off";
}

/** Chave "Lembretes das visitas" da Conta: desliga (ou religa) os três lembretes de uma vez. */
export async function setVisitRemindersEnabled(on: boolean): Promise<void> {
  await setKv(VISIT_REMINDERS_KEY, on ? null : "off", undefined, { notify: false });
  await syncLocalAlerts();
}

/** O próximo lembrete da visita que o aparelho agenda (para a Conta), ou null. */
export async function nextVisitReminder(): Promise<PlannedReminder | null> {
  const user = session.get().user;
  if (!user) return null;
  return planVisitReminders(await listTickets(), user.id, Date.now(), getServerOffsetMs())[0] ?? null;
}

/** O que as reconciliações dos alertas locais recebem (uma leitura das OS para as duas). */
export interface AlertsContext {
  N: NotificationsModule;
  /** Sem técnico (saiu da conta), nenhum alerta fica agendado. */
  user: User | null;
  /** Estado efetivo das OS no aparelho (com as ações ainda na fila). */
  tickets: LocalTicket[];
  granted: boolean;
  /** Agenda tudo de novo, mesmo o que não mudou. */
  force: boolean;
  /** A sessão desta volta ainda vale: saiu da conta no meio, não agenda mais nada. */
  alive: () => boolean;
}

let alertsRun: Promise<void> | null = null;
let alertsWanted = false;
let alertsForce = false;

/**
 * Reconcilia os alertas locais com as OS do aparelho: tempo na loja e lembretes da visita, um depois do outro.
 * Idempotente; roda uma vez por vez, e o pedido feito durante uma volta ganha outra volta logo depois. Chamada a
 * cada rodada do sync (inclusive em segundo plano), a cada ação do técnico, quando o app volta à tela, quando a
 * chave ou a permissão mudam e ao sair da conta (sem técnico, cancela tudo).
 */
export function syncLocalAlerts({ force = false }: { force?: boolean } = {}): Promise<void> {
  if (Platform.OS === "web") return Promise.resolve();
  alertsWanted = true;
  if (force) alertsForce = true;
  alertsRun ??= runLocalAlerts();
  return alertsRun;
}

async function runLocalAlerts(): Promise<void> {
  while (alertsWanted) {
    alertsWanted = false;
    const force = alertsForce;
    alertsForce = false;
    await reconcileLocalAlerts(force);
  }
  alertsRun = null;
}

async function reconcileLocalAlerts(force: boolean): Promise<void> {
  try {
    const N = await ensureNotificationsReady();
    if (!N) return;
    const user = session.get().user;
    const tickets = user ? await listTickets() : [];
    const granted = (await N.getPermissionsAsync()).granted;
    const alive = () => session.get().user?.id === user?.id;
    const context: AlertsContext = { N, user, tickets, granted, force, alive };
    await reconcileOnsiteAlerts(context).catch((error: unknown) => console.warn("Alertas do tempo na loja indisponíveis", error));
    await reconcileVisitReminders(context).catch((error: unknown) => console.warn("Lembretes da visita indisponíveis", error));
  } catch (error) {
    console.warn("Alertas locais indisponíveis", error);
  }
}

/**
 * Lembretes da visita (visitReminders.ts): mantém o agendado que não mudou (hora, título e texto), cancela o resto
 * e agenda o que falta. Sem técnico, sem permissão ou com a chave desligada, não fica nenhum. Na bandeja, tira o
 * lembrete de uma visita que não vale mais (começou, foi cancelada, saiu da lista ou mudou de horário).
 */
async function reconcileVisitReminders({ N, user, tickets, granted, force, alive }: AlertsContext): Promise<void> {
  const wanted =
    user && granted && (await visitRemindersEnabled()) ? planVisitReminders(tickets, user.id, Date.now(), getServerOffsetMs()) : [];
  const byId = new Map(wanted.map((reminder) => [reminder.identifier, reminder]));
  const kept = new Set<string>();
  for (const n of await N.getAllScheduledNotificationsAsync()) {
    if (!n.identifier.startsWith(VISIT_PREFIX)) continue;
    const want = byId.get(n.identifier);
    const same = !force && want && n.content.data?.at === want.at && n.content.title === want.title && n.content.body === want.body;
    if (same) kept.add(n.identifier);
    else await N.cancelScheduledNotificationAsync(n.identifier);
  }
  for (const reminder of wanted) {
    if (kept.has(reminder.identifier)) continue;
    if (!alive()) return;
    await N.scheduleNotificationAsync({
      identifier: reminder.identifier,
      content: {
        title: reminder.title,
        body: reminder.body,
        data: { kind: "visit", ticketId: reminder.ticketId, start: reminder.start, at: reminder.at },
      },
      trigger: { type: N.SchedulableTriggerInputTypes.DATE, date: new Date(reminder.fireAt), channelId: REMINDERS_CHANNEL },
    });
  }
  const visits = user ? remindableVisits(tickets, user.id) : new Map<string, string>();
  for (const n of await N.getPresentedNotificationsAsync()) {
    const { identifier, content } = n.request;
    if (!identifier.startsWith(VISIT_PREFIX)) continue;
    const ticketId = text(content.data?.ticketId);
    const start = ticketId ? visits.get(ticketId) : undefined;
    if (!start || start !== content.data?.start) await N.dismissNotificationAsync(identifier);
  }
}

// ───────────────────────────── novidades como notificação do sistema ─────────────────────────────

/** Uma novidade da sincronização (OS nova, oferta, reagendamento...) como notificação do sistema. */
export interface NewsItem {
  /** Identificador da notificação (news-<tipo>-<id>): o mesmo id substitui a anterior, sem empilhar. */
  id: string;
  title: string;
  body?: string;
  /** Tocar abre a OS. */
  ticketId?: string;
  /** Tocar abre a oferta (a OS da oferta ainda não é do técnico). */
  offerId?: string;
  /** Resumo de vários avisos: tocar abre Hoje. */
  home?: boolean;
  /** Notificações que esta torna velhas e saem da bandeja (ex.: a OS cancelada tira o aviso de OS nova). */
  replaces?: string[];
}

/** O app está na tela: as novidades viram toast, e não notificação do sistema. */
export const inForeground = () => AppState.currentState === "active";

/**
 * Mostra as novidades na hora como notificação do sistema (Android: canal "Ordens de serviço"). Devolve false sem
 * permissão, com erro ou na web: quem chamou mostra o toast.
 */
export async function presentNews(items: readonly NewsItem[]): Promise<boolean> {
  const N = await ensureNotificationsReady();
  if (!N) return false;
  try {
    if (!(await N.getPermissionsAsync()).granted) return false;
    for (const item of items) {
      if (item.replaces?.length) await dismissNews(item.replaces);
      const data: Record<string, unknown> = { kind: "news" };
      if (item.ticketId) data.ticketId = item.ticketId;
      if (item.offerId) data.offerId = item.offerId;
      if (item.home) data.home = true;
      await N.scheduleNotificationAsync({
        identifier: item.id,
        content: { title: item.title, body: item.body ?? null, data },
        trigger: Platform.OS === "android" ? { channelId: NEWS_CHANNEL } : null,
      });
    }
    return true;
  } catch (error) {
    console.warn("Não foi possível mostrar a notificação", error);
    return false;
  }
}

/** Tira notificações da bandeja pelo identificador. */
export async function dismissNews(ids: readonly string[]): Promise<void> {
  const N = await ensureNotificationsReady();
  if (!N) return;
  for (const id of ids) await N.dismissNotificationAsync(id).catch(() => undefined);
}

/** Tira da bandeja as notificações de prefixo `prefix` que não estão em `keep` (ex.: ofertas que fecharam). */
export async function dismissNewsExcept(prefix: string, keep: readonly string[]): Promise<void> {
  const N = await ensureNotificationsReady();
  if (!N) return;
  try {
    const wanted = new Set(keep);
    for (const n of await N.getPresentedNotificationsAsync()) {
      const id = n.request.identifier;
      if (id.startsWith(prefix) && !wanted.has(id)) await N.dismissNotificationAsync(id);
    }
  } catch (error) {
    console.warn("Não foi possível limpar as notificações", error);
  }
}

/** Saiu da conta: nada agendado e a bandeja limpa (loja e endereço aparecem na tela bloqueada). */
export async function clearNotificationsOnSignOut(): Promise<void> {
  const N = await ensureNotificationsReady();
  if (!N) return;
  await N.cancelAllScheduledNotificationsAsync().catch((error: unknown) => console.warn("Falha ao cancelar as notificações", error));
  await N.dismissAllNotificationsAsync().catch((error: unknown) => console.warn("Falha ao limpar as notificações", error));
}
