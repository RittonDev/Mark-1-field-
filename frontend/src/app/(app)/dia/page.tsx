"use client";

import clsx from "clsx";
import { CalendarClock, ChevronLeft, ChevronRight, Navigation } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Card, EmptyState, ErrorBox, Input, LoadingBlock, PageHeader, Select } from "@/components/ui";
import { CountUp } from "@/components/motion";
import { TagChips } from "@/components/TagChips";
import { MessagesButton } from "@/components/ticket/MessagesPanel";
import { OpenTicketButton, QuickEditButton } from "@/components/ticket/QuickEditButton";
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
  late: { label: "Atrasada", className: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30", dot: "bg-red-500" },
  scheduled: { label: "Agendada", className: "bg-cyan-50 text-cyan-800 ring-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-300 dark:ring-cyan-500/30", dot: "bg-cyan-500" },
  en_route: { label: "Em deslocamento", className: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30", dot: "bg-sky-500" },
  in_progress: { label: "Em atendimento", className: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30", dot: "bg-amber-500" },
  on_hold: { label: "Pendente", className: "bg-purple-50 text-purple-800 ring-purple-200 dark:bg-purple-500/15 dark:text-purple-300 dark:ring-purple-500/30", dot: "bg-purple-500" },
  rescheduled: { label: "Reagendada", className: "bg-indigo-50 text-indigo-800 ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/30", dot: "bg-indigo-500" },
  done: { label: "Concluída", className: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30", dot: "bg-emerald-500" },
  pending: { label: "Na fila", className: "bg-slate-50 text-slate-700 ring-slate-200 dark:bg-slate-500/15 dark:text-slate-300 dark:ring-slate-500/30", dot: "bg-slate-400" },
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

/** Hora de atuação para ordenar: a agendada ou, sem agenda, a de início (sem hora vai para o fim). */
const actingAt = (a: Activity) => {
  const value = a.scheduled_start ?? a.started_at;
  return value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER;
};

/** "18:52 até 00:05": o realizado quando começou; antes disso, a janela agendada. */
function timeRange(a: Activity, day: string): { text: string; real: boolean } | null {
  // OS migradas do Field Control não têm o histórico de status: valem o início e o fim da própria OS.
  const start = a.arrived_at ?? a.started_at ?? a.ticket.arrived_at ?? null;
  const finished = a.finished_at ?? a.ticket.resolved_at ?? null;
  if (start) {
    const end = finished ? when(finished, day) : a.state === "in_progress" || a.state === "en_route" ? "agora" : null;
    return { text: end ? `${when(start, day)} até ${end}` : when(start, day), real: true };
  }
  if (a.scheduled_start) {
    return {
      text: a.scheduled_end ? `${when(a.scheduled_start, day)} até ${when(a.scheduled_end, day)}` : when(a.scheduled_start, day),
      real: false,
    };
  }
  return null;
}

/**
 * Um cartão por OS, com as informações do Field Control: nº e cliente com a situação; tipo de
 * serviço, loja e endereço; a descrição; etiquetas, técnico e o horário (realizado ou agendado).
 */
function ActivityCard({ a, day, manage }: { a: Activity; day: string; manage: boolean }) {
  const t = a.ticket;
  const loc = t.location;
  const helpers = t.helpers ?? [];
  const address = loc ? [loc.address_line, [loc.city, loc.state].filter(Boolean).join(" - ")].filter(Boolean).join(", ") : null;
  const range = timeRange(a, day);
  const description = (a.description ?? "").trim() || t.title;
  const late = a.start_delay_minutes !== null && a.start_delay_minutes >= 5 && range?.real;
  return (
    <li className="group relative border-b border-line last:border-b-0">
      <div className="flex gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--row-hover)]">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <OpenTicketButton ticketId={t.id} className="font-mono text-ink-muted hover:text-brand">
              {t.code}
            </OpenTicketButton>
            <span className="text-ink-subtle">-</span>
            <span className="font-semibold text-ink">{t.customer?.name ?? "Sem cliente"}</span>
            <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", STATE[a.state].className)}>
              <span className={clsx("size-1.5 rounded-full", STATE[a.state].dot)} />
              {STATE[a.state].label}
            </span>
          </p>
          <p className="truncate text-sm">
            <span className="font-semibold text-ink">{a.service_type_name ?? t.title}</span>
            {loc ? (
              <>
                <span className="mx-2 text-line-strong">|</span>
                <span className="font-semibold text-ink">{[loc.name, loc.code].filter(Boolean).join(" - ")}</span>
                {address ? <span className="text-ink-muted"> - {address}</span> : null}
              </>
            ) : null}
          </p>
          <p className="truncate text-sm text-ink-muted" title={description}>
            {description}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1 text-sm">
            <TagChips tags={t.tags} max={4} />
            <span className="inline-flex items-center gap-2">
              <span
                className={clsx(
                  "flex size-6 items-center justify-center rounded-full text-[10px] font-semibold",
                  t.assignee ? "bg-brand-soft text-brand-ink" : "border border-dashed border-line-strong text-ink-subtle",
                )}
              >
                {t.assignee ? initials(t.assignee.name) : "?"}
              </span>
              <span className="font-medium text-ink">{t.assignee?.name ?? "Sem técnico"}</span>
              {helpers.length ? (
                <span className="text-xs text-ink-muted" title={helpers.map((h) => h.name).join(", ")}>
                  +{helpers.length}
                </span>
              ) : null}
            </span>
            {range ? (
              <span className="inline-flex items-center gap-1.5 border-l border-line pl-3 text-ink-muted tabular-nums">
                {range.text}
                {late ? <span className="text-xs font-medium text-red-600 dark:text-red-400">+{formatMinutes(a.start_delay_minutes!)}</span> : null}
                {a.start_has_gps ? <Navigation className="size-3 text-brand" aria-label="Check-in com GPS" /> : null}
                {!range.real ? <span className="text-xs">(agendado)</span> : null}
              </span>
            ) : (
              <span className="border-l border-line pl-3 text-ink-subtle">sem horário</span>
            )}
            {a.actual_minutes > 0 ? (
              <span className="text-xs text-ink-subtle">
                atendimento {formatMinutes(a.actual_minutes)}
                {a.estimated_minutes ? ` de ${formatMinutes(a.estimated_minutes)}` : ""}
              </span>
            ) : null}
          </div>
        </div>
        {manage ? (
          <div className="flex shrink-0 items-start gap-1 pt-0.5">
            <MessagesButton ticketId={t.id} code={t.code} />
            {a.started_at || a.arrived_at ? <TimesButton ticketId={t.id} code={t.code} /> : null}
            <QuickEditButton ticketId={t.id} code={t.code} />
          </div>
        ) : null}
      </div>
    </li>
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

  // Lista única pela hora de atuação, a manhã primeiro (como pedido pela operação).
  const items = useMemo(
    () => [...(data?.activities ?? [])].filter((a) => !stateFilter || a.state === stateFilter).sort((x, y) => actingAt(x) - actingAt(y)),
    [data, stateFilter],
  );

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Atividades do dia"
        description={day ? `${longDate(day)}${data?.is_today ? " · hoje" : ""} · atualiza em tempo real` : "Carregando..."}
        actions={
          day ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* Filtro de grupo junto da data: a faixa de números abaixo fica numa linha só. */}
              <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Grupo técnico" className="w-48">
                <option value="">Todos os grupos</option>
                {teams.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
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
                "min-w-[7.5rem] rounded-xl border px-3.5 py-2.5 text-left shadow-elev-1 transition-[border-color,background-color,box-shadow] duration-150",
                active
                  ? "border-brand bg-brand-soft ring-2 ring-brand/15"
                  : "border-line bg-surface hover:border-line-strong hover:shadow-elev-2",
                !state && "cursor-default",
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
      </div>

      {query.isLoading || !day ? (
        <LoadingBlock />
      ) : query.error ? (
        <ErrorBox message={errorMessage(query.error)} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarClock className="size-8" />}
            title={stateFilter ? "Nenhuma atividade nessa situação" : "Nenhuma atividade neste dia"}
          />
        </Card>
      ) : (
        <Card className="animate-enter overflow-hidden">
          <div className="flex items-center justify-between border-b border-line bg-[var(--table-head)] px-4 py-2.5 text-xs text-ink-muted">
            <span className="font-medium text-ink">{longDate(day)}</span>
            <span className="tabular-nums">
              {items.length} atividade{items.length === 1 ? "" : "s"}
              {stateFilter ? ` · ${STATE[stateFilter].label.toLowerCase()}` : ""}
            </span>
          </div>
          <ul>
            {items.map((a) => (
              <ActivityCard key={a.ticket.id} a={a} day={day} manage={manage} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
