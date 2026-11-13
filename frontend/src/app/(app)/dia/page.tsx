"use client";

import clsx from "clsx";
import { CalendarClock, ChevronLeft, ChevronRight, MapPin, Navigation } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, Card, EmptyState, ErrorBox, Input, LoadingBlock, PageHeader, Select } from "@/components/ui";
import { CountUp } from "@/components/motion";
import { MessagesButton } from "@/components/ticket/MessagesPanel";
import { ArrivalChip, OnsiteBar } from "@/components/ticket/FieldClock";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import { TimesButton } from "@/components/ticket/TimesDialog";
import { errorMessage } from "@/lib/api";
import { useAuth, useIsClient } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatMinutes, formatTime, initials } from "@/lib/format";
import { useDayActivities, useTeams } from "@/lib/queries";
import type { Activity, ActivityState, DaySummary } from "@/lib/types";

// Fuso da operação (mesmo de settings.TIMEZONE na API).
const OPERATION_TZ = "America/Sao_Paulo";

const STATE: Record<ActivityState, { label: string; className: string; dot: string }> = {
  late: { label: "Atrasada", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300", dot: "bg-red-500" },
  scheduled: { label: "Agendada", className: "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-300", dot: "bg-cyan-500" },
  en_route: { label: "Em deslocamento", className: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300", dot: "bg-sky-500" },
  in_progress: { label: "Em atendimento", className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300", dot: "bg-amber-500" },
  on_hold: { label: "Pendente", className: "bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300", dot: "bg-purple-500" },
  rescheduled: { label: "Reagendada", className: "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300", dot: "bg-indigo-500" },
  done: { label: "Concluída", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300", dot: "bg-emerald-500" },
  pending: { label: "Na fila", className: "bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300", dot: "bg-slate-400" },
};

const SUMMARY_ORDER: { key: keyof DaySummary; label: string; state?: ActivityState }[] = [
  { key: "scheduled", label: "Agendadas", state: "scheduled" },
  { key: "late", label: "Atrasadas", state: "late" },
  { key: "en_route", label: "Em deslocamento", state: "en_route" },
  { key: "in_progress", label: "Em atendimento", state: "in_progress" },
  { key: "on_hold", label: "Pendentes", state: "on_hold" },
  { key: "rescheduled", label: "Reagendadas", state: "rescheduled" },
  { key: "done", label: "Concluídas", state: "done" },
  { key: "unassigned", label: "Sem técnico" },
];

function todayString(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: OPERATION_TZ }).format(new Date());
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function longDate(day: string): string {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

/** Hora; com a data quando não é do dia exibido (ex.: OS em campo desde ontem). */
function when(value: string | null, day: string): string {
  if (!value) return "—";
  const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: OPERATION_TZ }).format(new Date(value));
  if (localDay === day) return formatTime(value);
  return `${localDay.slice(8, 10)}/${localDay.slice(5, 7)} ${formatTime(value)}`;
}

function Delay({ minutes }: { minutes: number | null }) {
  if (minutes === null || Math.abs(minutes) < 5) return null;
  const late = minutes > 0;
  return (
    <span className={late ? "ml-1 text-xs font-medium text-red-600 dark:text-red-400" : "ml-1 text-xs text-emerald-600"}>
      {late ? `+${formatMinutes(minutes)}` : `-${formatMinutes(-minutes)}`}
    </span>
  );
}

function ActivityRow({ a, along, day, manage }: { a: Activity; along?: string | null; day: string; manage: boolean }) {
  const t = a.ticket;
  const helpers = t.helpers ?? [];
  const loc = t.location;
  const ratio = a.estimated_minutes && a.actual_minutes > 0 ? a.actual_minutes / a.estimated_minutes : null;
  return (
    <tr className="border-t border-line align-top transition-colors hover:bg-[var(--row-hover)]">
      <td className="px-3 py-2.5">
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATE[a.state].className}`}>
          {STATE[a.state].label}
        </span>
      </td>
      <td className="px-3 py-2.5 text-sm whitespace-nowrap">
        {a.scheduled_start ? (
          <>
            {when(a.scheduled_start, day)}
            {a.scheduled_end ? <span className="text-ink-muted">–{formatTime(a.scheduled_end)}</span> : null}
          </>
        ) : (
          <span className="text-ink-muted">sem horário</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-sm whitespace-nowrap">
        {a.started_at ? (
          <>
            {when(a.started_at, day)}
            <Delay minutes={a.start_delay_minutes} />
            {a.start_has_gps ? (
              <Navigation className="ml-1 inline size-3 text-brand" aria-label="Check-in com GPS" />
            ) : null}
            {a.arrived_at && a.arrived_at !== a.started_at ? (
              <span className="block text-xs text-ink-muted">chegou {when(a.arrived_at, day)}</span>
            ) : null}
            {a.state === "in_progress" ? <OnsiteBar ticket={t} className="mt-1.5" /> : null}
          </>
        ) : (
          t.arrival_due_at ? <ArrivalChip ticket={t} compact /> : <span className="text-ink-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-sm whitespace-nowrap">{a.finished_at ? when(a.finished_at, day) : <span className="text-ink-muted">—</span>}</td>
      <td className="px-3 py-2.5">
        <Link href={`/chamados/${t.id}`} className="group block">
          <span className="font-mono text-xs text-ink-subtle">{t.code}</span>{" "}
          <span className="text-sm font-medium text-ink group-hover:text-brand">{t.title}</span>
        </Link>
        {a.service_type_name ? <p className="text-xs text-ink-muted">{a.service_type_name}</p> : null}
        {along ? (
          <p className="mt-0.5 inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
            Vai junto · responsável: {along}
          </p>
        ) : helpers.length ? (
          <p className="text-xs text-ink-muted">Com {helpers.map((h) => h.name.split(" ")[0]).join(", ")}</p>
        ) : null}
      </td>
      <td className="px-3 py-2.5 text-sm">
        {loc ? (
          <>
            <p className="flex items-center gap-1">
              <MapPin className="size-3 shrink-0 text-ink-muted" />
              {loc.code ? <span className="font-mono text-xs text-ink-muted">{loc.code}</span> : null}
              <span>{loc.name}</span>
            </p>
            <p className="text-xs text-ink-muted">
              {[t.customer?.name, loc.city].filter(Boolean).join(" · ")}
            </p>
          </>
        ) : (
          <span className="text-ink-muted">{t.customer?.name ?? "—"}</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right text-sm whitespace-nowrap">
        {a.estimated_minutes ? <span className="text-ink-muted">{formatMinutes(a.estimated_minutes)}</span> : "—"}
        {a.actual_minutes > 0 ? (
          <span className={ratio !== null && ratio >= 1.25 ? "block font-medium text-red-600 dark:text-red-400" : "block"}>
            {formatMinutes(a.actual_minutes)}
          </span>
        ) : null}
      </td>
      {manage ? (
        <td className="edit-col px-3 py-2.5">
          <span className="inline-flex items-center gap-1">
            <MessagesButton ticketId={t.id} code={t.code} />
            {a.started_at || a.arrived_at ? <TimesButton ticketId={t.id} code={t.code} /> : null}
            <QuickEditButton ticketId={t.id} code={t.code} />
          </span>
        </td>
      ) : null}
    </tr>
  );
}

export default function DayPage() {
  const isClient = useIsClient();
  const { user } = useAuth();
  const manage = canManageTickets(user?.role);
  const [picked, setPicked] = useState<string | null>(null);
  // Hoje é calculado só no cliente (evita divergência de hidratação perto da meia-noite).
  const day = picked ?? (isClient ? todayString() : null);
  const [teamId, setTeamId] = useState("");
  const [stateFilter, setStateFilter] = useState<ActivityState | null>(null);
  const teams = useTeams();
  const query = useDayActivities(day, teamId || null);
  const data = query.data;

  // Um bloco por técnico; a visita entra também no dia de quem vai junto (marcada como tal).
  // Tudo pela hora de atuação, a manhã primeiro: a agendada ou, sem agenda, a de início (sem hora
  // vai para o fim). Os blocos seguem a primeira OS de cada técnico, então quem começa mais cedo
  // aparece em cima e, dentro do bloco, as OS seguem o relógio.
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; items: { a: Activity; along: string | null }[] }>();
    const add = (key: string, name: string, a: Activity, along: string | null) => {
      if (!map.has(key)) map.set(key, { name, items: [] });
      map.get(key)!.items.push({ a, along });
    };
    const at = (a: Activity) => {
      const value = a.scheduled_start ?? a.started_at;
      return value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER;
    };
    const ordered = [...(data?.activities ?? [])].sort((x, y) => at(x) - at(y));
    for (const a of ordered) {
      if (stateFilter && a.state !== stateFilter) continue;
      add(a.ticket.assignee?.id ?? "none", a.ticket.assignee?.name ?? "Sem técnico", a, null);
      for (const h of a.ticket.helpers ?? []) add(h.id, h.name, a, a.ticket.assignee?.name ?? "sem responsável");
    }
    return [...map.entries()];
  }, [data, stateFilter]);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Atividades do dia"
        description={day ? `${longDate(day)}${data?.is_today ? " · hoje" : ""} · atualiza em tempo real` : "Carregando..."}
        actions={
          day ? (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setPicked(shiftDay(day, -1))} aria-label="Dia anterior">
                <ChevronLeft className="size-4" />
              </Button>
              <Input type="date" value={day} onChange={(e) => e.target.value && setPicked(e.target.value)} className="w-40" />
              <Button size="sm" onClick={() => setPicked(shiftDay(day, 1))} aria-label="Próximo dia">
                <ChevronRight className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                Hoje
              </Button>
            </div>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {SUMMARY_ORDER.map(({ key, label, state }) => {
          const value = data?.summary[key] ?? 0;
          const active = state !== undefined && stateFilter === state;
          return (
            <button
              key={key}
              type="button"
              disabled={!state}
              onClick={() => state && setStateFilter(active ? null : state)}
              className={clsx(
                "min-w-[7.5rem] rounded-xl border px-3.5 py-2.5 text-left shadow-elev-1 transition-[border-color,background-color,box-shadow,transform] duration-200",
                active
                  ? "border-brand bg-brand-soft ring-2 ring-brand/15"
                  : "border-line bg-surface hover:-translate-y-0.5 hover:border-line-strong hover:shadow-elev-2",
                !state && "cursor-default hover:translate-y-0",
                key === "late" && value > 0 && !active && "border-red-200 dark:border-red-500/30",
              )}
            >
              <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                {state ? <span className={clsx("size-1.5 rounded-full", STATE[state].dot)} /> : null}
                {label}
              </span>
              <CountUp
                value={value}
                className={clsx(
                  "mt-0.5 block text-xl font-semibold tracking-tight",
                  key === "late" && value > 0 ? "text-red-600 dark:text-red-400" : "text-ink",
                )}
              />
            </button>
          );
        })}
        <div className="ml-auto w-56">
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Grupo técnico">
            <option value="">Todos os grupos</option>
            {teams.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {query.isLoading || !day ? (
        <LoadingBlock />
      ) : query.error ? (
        <ErrorBox message={errorMessage(query.error)} />
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarClock className="size-8" />}
            title={stateFilter ? "Nenhuma atividade nessa situação" : "Nenhuma atividade neste dia"}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map(([key, group]) => {
            const done = group.items.filter(({ a }) => a.state === "done").length;
            return (
              <Card key={key} className="animate-enter overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={clsx(
                        "flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                        key === "none" ? "border border-dashed border-line-strong text-ink-subtle" : "bg-brand-soft text-brand-ink",
                      )}
                    >
                      {key === "none" ? "?" : initials(group.name)}
                    </span>
                    <h2 className="truncate text-sm font-semibold text-ink">{group.name}</h2>
                  </div>
                  {/* Progresso do dia do técnico: concluídas sobre o total. */}
                  <div className="flex items-center gap-2.5">
                    <span className="text-xs text-ink-muted tabular-nums">
                      {done}/{group.items.length} concluída(s)
                    </span>
                    <span className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-3">
                      <span
                        className="grow-x block h-full rounded-full bg-emerald-500"
                        style={{ width: `${group.items.length ? (done / group.items.length) * 100 : 0}%` }}
                      />
                    </span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[56rem] text-left">
                    <thead>
                      <tr className="text-[11px] font-semibold tracking-[0.06em] text-ink-subtle uppercase [&>th]:border-b [&>th]:border-line [&>th]:bg-[var(--table-head)]">
                        <th className="px-3 py-2 font-medium">Situação</th>
                        <th className="px-3 py-2 font-medium">Agendado</th>
                        <th className="px-3 py-2 font-medium">Início real</th>
                        <th className="px-3 py-2 font-medium">Término</th>
                        <th className="px-3 py-2 font-medium">OS</th>
                        <th className="px-3 py-2 font-medium">Local</th>
                        <th className="px-3 py-2 text-right font-medium">Estimada / real</th>
                        {manage ? <th className="edit-col px-3 py-2 font-medium">Editar</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map(({ a, along }) => (
                        <ActivityRow key={a.ticket.id} a={a} along={along} day={day} manage={manage} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
