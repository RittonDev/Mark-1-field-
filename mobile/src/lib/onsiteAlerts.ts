// Alertas locais do tempo na loja (cada chamado inclui até 4h de técnico, contadas da chegada).
// Agenda duas notificações por OS em atendimento: faltando `onsite_warning_minutes` e no estouro.
// São locais (expo-notifications já instalado): funcionam offline e no Expo Go. Na web não há.

import { Platform } from "react-native";
import { listTickets } from "./db";
import { getFieldRules, ONSITE_STATUSES } from "./field";
import { formatMinutes } from "./format";
import { session } from "./session";

const PREFIX = "onsite-";
const CHANNEL = "campo";

interface Wanted {
  date: Date;
  title: string;
  body: string;
}

let running: Promise<void> | null = null;
let handlerReady = false;

/** Reconcilia os alertas agendados com as OS do técnico. Idempotente; chamada depois de cada sync e ação. */
export function syncOnsiteAlerts(): Promise<void> {
  if (Platform.OS === "web") return Promise.resolve();
  if (!running) {
    running = reconcile()
      .catch((error: unknown) => console.warn("Alertas do tempo na loja indisponíveis", error))
      .finally(() => {
        running = null;
      });
  }
  return running;
}

async function reconcile() {
  const user = session.get().user;
  const wanted = new Map<string, Wanted>();
  if (user) {
    const { onsite_warning_minutes: warnMin } = getFieldRules();
    const now = Date.now();
    for (const t of await listTickets()) {
      if (t.assignee?.id !== user.id || !ONSITE_STATUSES.includes(t.status) || !t.arrived_at || !t.onsite_due_at) continue;
      const due = new Date(t.onsite_due_at).getTime();
      const warnAt = due - warnMin * 60_000;
      if (warnAt > now) {
        wanted.set(`${PREFIX}warning-${t.id}`, {
          date: new Date(warnAt),
          title: `${t.code}: faltam ${formatMinutes(warnMin)} na loja`,
          body: `Faltam ${formatMinutes(warnMin)} do tempo do chamado: avise o analista no grupo.`,
        });
      }
      if (due > now) {
        wanted.set(`${PREFIX}over-${t.id}`, {
          date: new Date(due),
          title: `${t.code}: tempo do chamado esgotado`,
          body: "As horas incluídas no chamado acabaram. Avise o analista no grupo antes de continuar.",
        });
      }
    }
  }

  const Notifications = await import("expo-notifications");
  const scheduled = (await Notifications.getAllScheduledNotificationsAsync()).filter((n) => n.identifier.startsWith(PREFIX));
  const kept = new Set<string>();
  for (const n of scheduled) {
    const want = wanted.get(n.identifier);
    if (want && n.content.data?.at === want.date.toISOString()) kept.add(n.identifier);
    else await Notifications.cancelScheduledNotificationAsync(n.identifier);
  }
  const toSchedule = [...wanted].filter(([id]) => !kept.has(id));
  if (!toSchedule.length) return;

  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return; // segue só com o aviso dentro do app

  if (!handlerReady) {
    handlerReady = true;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: "Tempo na loja",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 150, 250],
      });
    }
  }

  for (const [identifier, want] of toSchedule) {
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: { title: want.title, body: want.body, data: { at: want.date.toISOString() } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: want.date, channelId: CHANNEL },
    });
  }
}
