"use client";

import { CalendarClock, ChevronLeft, ChevronRight, MapPin, Navigation } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, Card, EmptyState, ErrorBox, Input, LoadingBlock, PageHeader, Select } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useIsClient } from "@/lib/auth";
import { formatMinutes, formatTime } from "@/lib/format";
import { useDayActivities, useTeams } from "@/lib/queries";
import type { Activity, ActivityState, DaySummary } from "@/lib/types";

// Fuso da operação (mesmo de settings.TIMEZONE na API).
const OPERATION_TZ = "America/Sao_Paulo";

const STATE: Record<ActivityState, { label: string; className: string }> = {
  late: { label: "Atrasada", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300" },
  scheduled: { label: "Agendada", className: "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-300" },
  en_route: { label: "Em deslocamento", className: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300" },
  in_progress: { label: "Em atendimento", className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  on_hold: { label: "Pendente", className: "bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300" },
  rescheduled: { label: "Reagendada", className: "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300" },
  done: { label: "Concluída", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  pending: { label: "Na fila", className: "bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300" },
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

function ActivityRow({ a, day }: { a: Activity; day: string }) {
  const t = a.ticket;
  const loc = t.location;
  const ratio = a.estimated_minutes && a.actual_minutes > 0 ? a.actual_minutes / a.estimated_minutes : null;
  return (
    <tr className="border-t border-line align-top hover:bg-surface-2">
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
          </>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-sm whitespace-nowrap">{a.finished_at ? when(a.finished_at, day) : <span className="text-ink-muted">—</span>}</td>
      <td className="px-3 py-2.5">
        <Link href={`/chamados/${t.id}`} className="group">
          <span className="font-mono text-xs text-ink-muted">{t.code}</span>{" "}
          <span className="text-sm font-medium text-ink group-hover:text-brand group-hover:underline">{t.title}</span>
        </Link>
        {a.service_type_name ? <p className="text-xs text-ink-muted">{a.service_type_name}</p> : null}
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
    </tr>
  );
}

export default function DayPage() {
  const isClient = useIsClient();
  const [picked, setPicked] = useState<string | null>(null);
  // Hoje é calculado só no cliente (evita divergência de hidratação perto da meia-noite).
  const day = picked ?? (isClient ? todayString() : null);
  const [teamId, setTeamId] = useState("");
  const [stateFilter, setStateFilter] = useState<ActivityState | null>(null);
  const teams = useTeams();
  const query = useDayActivities(day, teamId || null);
  const data = query.data;

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; items: Activity[] }>();
    for (const a of data?.activities ?? []) {
      if (stateFilter && a.state !== stateFilter) continue;
      const key = a.ticket.assignee?.id ?? "none";
      const name = a.ticket.assignee?.name ?? "Sem técnico";
      if (!map.has(key)) map.set(key, { name, items: [] });
      map.get(key)!.items.push(a);
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
              className={`rounded-lg border px-3 py-2 text-left transition ${
                active ? "border-brand bg-brand/10" : "border-line bg-surface hover:bg-surface-2"
              } ${!state ? "cursor-default" : ""} ${key === "late" && value > 0 ? "border-red-300 dark:border-red-500/40" : ""}`}
            >
              <span className={`block text-lg font-semibold ${key === "late" && value > 0 ? "text-red-600 dark:text-red-400" : "text-ink"}`}>
                {value}
              </span>
              <span className="text-xs text-ink-muted">{label}</span>
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
            const done = group.items.filter((a) => a.state === "done").length;
            return (
              <Card key={key}>
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                  <h2 className="text-sm font-semibold text-ink">{group.name}</h2>
                  <span className="text-xs text-ink-muted">
                    {group.items.length} atividade(s) · {done} concluída(s)
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[56rem] text-left">
                    <thead>
                      <tr className="text-xs tracking-wide text-ink-muted uppercase">
                        <th className="px-3 py-2 font-medium">Situação</th>
                        <th className="px-3 py-2 font-medium">Agendado</th>
                        <th className="px-3 py-2 font-medium">Início real</th>
                        <th className="px-3 py-2 font-medium">Término</th>
                        <th className="px-3 py-2 font-medium">OS</th>
                        <th className="px-3 py-2 font-medium">Local</th>
                        <th className="px-3 py-2 text-right font-medium">Estimada / real</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map((a) => (
                        <ActivityRow key={a.ticket.id} a={a} day={day} />
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
