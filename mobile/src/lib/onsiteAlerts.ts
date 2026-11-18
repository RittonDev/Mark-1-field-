// Alertas locais do tempo na loja (cada chamado inclui até 4h de técnico, contadas da chegada).
// Agenda duas notificações por OS em atendimento: faltando `onsite_warning_minutes` e no estouro.
// São locais: funcionam offline e no Expo Go. Na web não há.
//
// O handler, o canal do Android, a permissão e o toque (abre a OS) ficam em notifications.ts, que chama esta
// reconciliação junto com a dos lembretes da visita (syncLocalAlerts).

import { getFieldRules, ONSITE_STATUSES } from "./field";
import { formatMinutes } from "./format";
import type { AlertsContext } from "./notifications";

const PREFIX = "onsite-";
/** Canal do Android "Tempo na loja" (criado em notifications.ts). */
export const ONSITE_CHANNEL = "campo";

interface Wanted {
  ticketId: string;
  date: Date;
  title: string;
  body: string;
}

/**
 * Reconcilia os alertas agendados com as OS do técnico (idempotente): mantém o que não mudou, cancela o resto e
 * agenda o que falta. Sem técnico ou sem permissão, não fica nenhum. `force`: agenda tudo de novo (ex.: o alarme
 * exato acabou de ser liberado).
 */
export async function reconcileOnsiteAlerts({ N, user, tickets, granted, force, alive }: AlertsContext): Promise<void> {
  const wanted = new Map<string, Wanted>();
  if (user && granted) {
    const { onsite_warning_minutes: warnMin } = getFieldRules();
    const now = Date.now();
    for (const t of tickets) {
      if (t.assignee?.id !== user.id || !ONSITE_STATUSES.includes(t.status) || !t.arrived_at || !t.onsite_due_at) continue;
      const due = new Date(t.onsite_due_at).getTime();
      const warnAt = due - warnMin * 60_000;
      if (warnAt > now) {
        wanted.set(`${PREFIX}warning-${t.id}`, {
          ticketId: t.id,
          date: new Date(warnAt),
          title: `${t.code}: faltam ${formatMinutes(warnMin)} na loja`,
          body: `Faltam ${formatMinutes(warnMin)} do tempo do chamado: avise o analista no grupo.`,
        });
      }
      if (due > now) {
        wanted.set(`${PREFIX}over-${t.id}`, {
          ticketId: t.id,
          date: new Date(due),
          title: `${t.code}: tempo do chamado esgotado`,
          body: "As horas incluídas no chamado acabaram. Avise o analista no grupo antes de continuar.",
        });
      }
    }
  }

  const scheduled = (await N.getAllScheduledNotificationsAsync()).filter((n) => n.identifier.startsWith(PREFIX));
  const kept = new Set<string>();
  for (const n of scheduled) {
    const want = wanted.get(n.identifier);
    const same = !force && want && n.content.data?.at === want.date.toISOString() && n.content.data?.ticketId === want.ticketId;
    if (same) kept.add(n.identifier);
    else await N.cancelScheduledNotificationAsync(n.identifier);
  }
  for (const [identifier, want] of wanted) {
    if (kept.has(identifier)) continue;
    if (!alive()) return; // saiu da conta no meio da volta
    await N.scheduleNotificationAsync({
      identifier,
      content: { title: want.title, body: want.body, data: { at: want.date.toISOString(), ticketId: want.ticketId } },
      trigger: { type: N.SchedulableTriggerInputTypes.DATE, date: want.date, channelId: ONSITE_CHANNEL },
    });
  }
}
