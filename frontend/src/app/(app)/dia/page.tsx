"use client";

import clsx from "clsx";
import { CalendarClock, ChevronLeft, ChevronRight, Navigation, Search, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { CountUp } from "@/components/motion";
import {
  fold,
  isUuid,
  mayHaveGroupText,
  OPERATION_TZ,
  operationDay,
  replaceSearch,
  useActiveTechnicians,
  useSearchChange,
} from "@/components/operacao/hooks";
import { CopyNowButton } from "@/components/operacao/CopyNowButton";
import { InactiveChip, LiveStatus, RefreshFailed } from "@/components/operacao/status";
import { TagChips } from "@/components/TagChips";
import { FAR_FROM_STORE_M, km } from "@/components/ticket/geo";
import { MessagesButton } from "@/components/ticket/MessagesPanel";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import { TicketLink } from "@/components/ticket/TicketLink";
import { TimesButton } from "@/components/ticket/TimesDialog";
import { Button, Card, EmptyState, ErrorBox, Input, LoadingBlock, PageHeader, Pill, Select, Skeleton } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { errorMessage } from "@/lib/api";
import { useAuth, useIsClient } from "@/lib/auth";
import { canManageTickets, STATUS } from "@/lib/constants";
import { formatMinutes, initials } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useDayActivities, useTeams } from "@/lib/queries";
import type { Activity, ActivityState } from "@/lib/types";

/** Situações com as cores dos status da OS (as mesmas do resto do sistema). */
const STATE: Record<ActivityState, { label: string; color: string }> = {
  late: { label: "Atrasada", color: "#dc2626" },
  scheduled: { label: "Agendada", color: STATUS.scheduled.color },
  en_route: { label: "Em deslocamento", color: STATUS.en_route.color },
  in_progress: { label: "Em atendimento", color: STATUS.in_progress.color },
  on_hold: { label: "Pendente", color: STATUS.on_hold_customer.color },
  rescheduled: { label: "Reagendada", color: STATUS.reopened.color },
  done: { label: "Concluída", color: STATUS.resolved.color },
  pending: { label: "Voltou para a fila", color: STATUS.new.color },
};

/** Filtro dos números: uma situação, as visitas improdutivas do dia ou as sem técnico (ou com técnico inativo). */
type Filter = ActivityState | "unproductive" | "no_technician";

const FILTERS: { key: Filter; label: string; color: string; hint?: string }[] = [
  { key: "scheduled", label: "Agendadas", color: STATE.scheduled.color },
  { key: "late", label: "Atrasadas", color: STATE.late.color },
  { key: "en_route", label: "Em deslocamento", color: STATE.en_route.color },
  { key: "in_progress", label: "Em atendimento", color: STATE.in_progress.color },
  { key: "on_hold", label: "Pendentes", color: STATE.on_hold.color },
  { key: "rescheduled", label: "Reagendadas", color: STATE.rescheduled.color },
  { key: "pending", label: "Voltaram para a fila", color: STATE.pending.color, hint: "Saíram da agenda e esperam uma nova visita" },
  { key: "done", label: "Concluídas", color: STATE.done.color },
  { key: "unproductive", label: "Improdutivas", color: "#c2410c", hint: "O técnico foi e não conseguiu atender (com o motivo)" },
  { key: "no_technician", label: "Sem técnico", color: "#b45309", hint: "Sem técnico ou com técnico inativo (não entra mais no app)" },
];

/** Números que pedem ação quando passam de zero: vermelho para atraso, âmbar para o resto. */
const PROBLEM_FILTERS: Filter[] = ["late", "unproductive", "no_technician"];

/** Tolerância antes de marcar o início como atrasado (minutos depois do agendado). */
const LATE_TOLERANCE = 5;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: OPERATION_TZ });

/** Dia, grupo e técnico guardados na URL (?d=&grupo=&tec=); sem ?d=, hoje. */
function readUrl(params: URLSearchParams): { picked: string | null; teamId: string; techId: string } {
  const d = params.get("d");
  const team = params.get("grupo");
  const tech = params.get("tec");
  return { picked: d && DAY_RE.test(d) ? d : null, teamId: isUuid(team) ? team : "", techId: isUuid(tech) ? tech : "" };
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** "Segunda-feira, 16 de novembro" (abre a frase da descrição e o cabeçalho da lista). */
function longDate(day: string): string {
  const text = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`),
  );
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Hora no fuso da operação; com a data quando não é do dia exibido (ex.: OS em campo desde ontem). */
function when(value: string, day: string): string {
  const localDay = operationDay(value);
  const time = timeFmt.format(new Date(value));
  return localDay === day ? time : `${localDay.slice(8, 10)}/${localDay.slice(5, 7)} ${time}`;
}

const minutesBetween = (from: string | number, to: string | number) =>
  Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);

/** Sem técnico, ou com técnico desativado (ele não entra mais no app e a visita não acontece). */
const lacksTechnician = (a: Activity) => !a.ticket.assignee || a.ticket.assignee.is_active === false;

/** Quem trabalha na visita: o responsável ou quem vai junto. */
const worksOn = (a: Activity, userId: string) =>
  a.ticket.assignee?.id === userId || Boolean(a.ticket.helpers?.some((h) => h.id === userId));

/** Hora da visita improdutiva no dia (a API manda a do dia; a última da OS cobre a resposta antiga). */
function unproductiveAt(a: Activity, day: string): string | null {
  if (a.unproductive_at) return a.unproductive_at;
  const last = a.ticket.last_unproductive_at;
  return last && operationDay(last) === day ? last : null;
}

function matches(a: Activity, filter: Filter, day: string): boolean {
  if (filter === "no_technician") return lacksTechnician(a);
  if (filter === "unproductive") return unproductiveAt(a, day) !== null;
  return a.state === filter;
}

/** Texto da busca: nº, cliente, loja e código, cidade, título e tipo de serviço, sem acento. */
function haystack(a: Activity): string {
  const t = a.ticket;
  return fold(
    [t.code, t.customer?.name, t.location?.name, t.location?.code, t.location?.city, t.title, a.service_type_name].join(" "),
  );
}

/**
 * Hora de atuação para ordenar (a mesma regra da API): a agendada quando cai no dia; senão a realizada
 * no dia, a saída, a chegada ou a improdutiva (a visita atendida hoje e remarcada para outro dia fica
 * onde aconteceu, e a improdutiva que tirou a OS da agenda fica na hora em que foi registrada); senão
 * a agendada (em campo desde ontem vem primeiro); sem hora nenhuma, no fim.
 */
function actingAt(a: Activity, day: string): number {
  if (a.scheduled_start && operationDay(a.scheduled_start) === day) return new Date(a.scheduled_start).getTime();
  const real = a.started_at ?? a.arrived_at ?? unproductiveAt(a, day);
  if (real && operationDay(real) === day) return new Date(real).getTime();
  const any = a.scheduled_start ?? real;
  return any ? new Date(any).getTime() : Number.MAX_SAFE_INTEGER;
}

/**
 * Chegada guardada na OS (a primeira de todas), para quando o dia não tem histórico de status (ex.: OS
 * migrada do Field Control). Só vale se cair no dia exibido ou depois do horário desta visita: a
 * chegada de uma visita anterior não é o início do retorno agendado para hoje.
 */
function ticketArrival(a: Activity, day: string): string | null {
  const at = a.ticket.arrived_at;
  if (!at) return null;
  if (operationDay(at) === day) return at;
  return a.scheduled_start && new Date(at).getTime() >= new Date(a.scheduled_start).getTime() ? at : null;
}

/**
 * Feito sem internet: a hora que o aparelho marcou no botão. O envio chegou depois e o horário da OS
 * continua sendo o do servidor; a central decide se corrige.
 */
function OfflineMark({ at, day }: { at: string | null | undefined; day: string }) {
  if (!at) return null;
  return (
    <span
      className="text-ink-subtle"
      title="O técnico estava sem internet: o aparelho marcou este horário e o envio chegou depois. Use Corrigir horários se precisar."
    >
      {" "}
      (marcou {when(at, day)} sem internet)
    </span>
  );
}

/**
 * Previsto e realizado na mesma linha: "Agendada 09:00–10:00 · Início 10:12 (+12min) · a 80 m da
 * loja · Fim 11:40", "em atendimento há 45min", "atrasada há 35min" ou "Improdutiva 10:40: motivo".
 */
function Timing({ a, day, now }: { a: Activity; day: string; now: number }) {
  const t = a.ticket;
  const scheduled = a.scheduled_start;
  const scheduledInDay = Boolean(scheduled && operationDay(scheduled) === day);
  // Chegada (o início do atendimento): a do dia; em atendimento desde antes do dia, a etapa atual; sem
  // registro nenhum no dia, a da OS quando é desta visita. Sem chegada, a visita ainda não começou (e a
  // atrasada mostra há quanto tempo).
  const arrival = a.arrived_at ?? (a.state === "in_progress" ? a.started_at : null) ?? (a.started_at ? null : ticketArrival(a, day));
  // Saiu e não chegou no dia: a caminho, improdutiva antes de chegar ou remarcada no caminho.
  const departure = arrival ? null : a.started_at;
  // Término: o do dia ou o da OS (concluída sem o histórico de status também diz quando terminou).
  const finished = arrival || a.state === "done" ? (a.finished_at ?? t.resolved_at ?? null) : null;
  const delay = arrival && scheduled && scheduledInDay ? minutesBetween(scheduled, arrival) : null;
  // Distância do GPS até a loja no check-in do dia: a prova de presença (como no Field Control).
  const checkinMeters = arrival && arrival === a.arrived_at ? (a.arrival_distance_m ?? null) : null;
  const bounced = unproductiveAt(a, day);
  const parts: React.ReactNode[] = [];
  if (scheduled) {
    parts.push(
      <span key="scheduled">
        {a.state === "rescheduled" ? "Reagendada para " : "Agendada "}
        {when(scheduled, day)}
        {a.scheduled_end && scheduledInDay ? `–${when(a.scheduled_end, day)}` : ""}
      </span>,
    );
  }
  if (departure) {
    parts.push(
      <span key="departure">
        Saiu {when(departure, day)}
        {a.state === "en_route" ? ` · a caminho há ${formatMinutes(Math.max(0, minutesBetween(departure, now)))}` : ""}
        <OfflineMark at={a.started_declared_at} day={day} />
      </span>,
    );
  }
  if (arrival) {
    parts.push(
      <span key="arrival">
        Início {when(arrival, day)}
        {delay !== null && delay >= LATE_TOLERANCE ? (
          <span className="font-semibold text-red-700 dark:text-red-300"> (+{formatMinutes(delay)})</span>
        ) : null}
        <OfflineMark at={arrival === a.arrived_at ? a.arrived_declared_at : null} day={day} />
      </span>,
    );
    if (checkinMeters !== null) {
      const far = checkinMeters > FAR_FROM_STORE_M;
      parts.push(
        <span
          key="gps"
          className={clsx("inline-flex items-center gap-1", far && "font-semibold text-red-700 dark:text-red-300")}
          title="Distância do GPS do técnico até a loja no início do atendimento"
        >
          <Navigation aria-hidden className={clsx("size-3", far ? "text-red-600 dark:text-red-400" : "text-ink-subtle")} />
          {far ? `check-in a ${km(checkinMeters)} da loja` : `a ${km(checkinMeters)} da loja`}
        </span>,
      );
    }
    if (!finished && a.state === "in_progress") {
      parts.push(<span key="running">em atendimento há {formatMinutes(Math.max(0, minutesBetween(arrival, now)))}</span>);
    }
  } else if (a.state === "late" && scheduled) {
    parts.push(
      <span key="late" className="font-semibold text-red-700 dark:text-red-300">
        atrasada há {formatMinutes(Math.max(0, minutesBetween(scheduled, now)))}
      </span>,
    );
  }
  if (finished) parts.push(<span key="end">Fim {when(finished, day)}</span>);
  if (bounced) {
    parts.push(
      <span key="bounce" className="font-semibold text-amber-800 dark:text-amber-300">
        Improdutiva {when(bounced, day)}
        {a.unproductive_reason ? `: ${a.unproductive_reason}` : ""}
      </span>,
    );
  }
  if (!parts.length) return <span className="border-l border-line pl-3 text-ink-muted">sem horário</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 border-l border-line pl-3 text-ink-muted tabular-nums">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-x-1.5">
          {i > 0 ? <span aria-hidden>·</span> : null}
          {part}
        </span>
      ))}
      {a.start_has_gps && checkinMeters === null ? (
        <Navigation className="size-3 text-ink-subtle" aria-label="Registro com GPS" />
      ) : null}
    </span>
  );
}

/**
 * Um cartão por OS, com as informações do Field Control: nº e cliente com a situação; tipo de
 * serviço, loja e endereço; a descrição; etiquetas, técnico e o previsto ao lado do realizado.
 */
function ActivityCard({
  a,
  day,
  now,
  manage,
  focusId,
}: {
  a: Activity;
  day: string;
  now: number;
  manage: boolean;
  /** Técnico filtrado: marca "vai junto" nas visitas em que ele não é o responsável. */
  focusId: string;
}) {
  const t = a.ticket;
  const loc = t.location;
  const helpers = t.helpers ?? [];
  const address = loc ? [loc.address_line, [loc.city, loc.state].filter(Boolean).join(" - ")].filter(Boolean).join(", ") : null;
  const description = (a.description ?? "").trim() || t.title;
  // Voltou para a fila por visita improdutiva no dia: diz o porquê (o motivo vem na linha dos horários).
  const state =
    a.state === "pending" && unproductiveAt(a, day) ? { label: "Improdutiva", color: STATE.pending.color } : STATE[a.state];
  const helperMark = focusId && t.assignee?.id !== focusId ? helpers.find((h) => h.id === focusId) : undefined;
  // A correção vale para qualquer OS com horário real, inclusive iniciada em outro dia.
  const canFixTimes = Boolean(a.started_at || a.arrived_at || t.arrived_at || t.resolved_at);
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--row-hover)]">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <TicketLink ticketId={t.id} className="font-mono text-ink-muted underline-offset-2 hover:text-brand hover:underline">
              {t.code}
            </TicketLink>
            <span className="text-ink-subtle" aria-hidden>
              -
            </span>
            <span className="font-semibold text-ink">{t.customer?.name ?? "Sem cliente"}</span>
            <Pill color={state.color}>
              <span className="size-1.5 rounded-full" style={{ backgroundColor: state.color }} />
              {state.label}
            </Pill>
          </p>
          <p className="truncate text-sm">
            <span className="font-semibold text-ink">{a.service_type_name ?? t.title}</span>
            {loc ? (
              <>
                <span className="mx-2 text-line-strong" aria-hidden>
                  |
                </span>
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
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={clsx(
                  "flex size-6 items-center justify-center rounded-full text-[10px] font-semibold",
                  t.assignee ? "bg-brand-soft text-brand-ink" : "border border-dashed border-line-strong text-ink-muted",
                )}
              >
                {t.assignee ? initials(t.assignee.name) : "?"}
              </span>
              <span className={clsx("font-medium", t.assignee ? "text-ink" : "text-amber-700 dark:text-amber-400")}>
                {t.assignee?.name ?? "Sem técnico"}
              </span>
              {helpers.length ? (
                <span className="text-xs text-ink-muted" title={`Vai junto: ${helpers.map((h) => h.name).join(", ")}`}>
                  +{helpers.length}
                </span>
              ) : null}
              {t.assignee?.is_active === false ? <InactiveChip /> : null}
              {helperMark ? (
                <span className="rounded-md bg-surface-2 px-1.5 py-px text-[11px] font-semibold text-ink-muted ring-1 ring-line ring-inset">
                  {helperMark.name.split(" ")[0]} vai junto
                </span>
              ) : null}
            </span>
            <Timing a={a} day={day} now={now} />
            {a.actual_minutes > 0 ? (
              <span className="text-xs text-ink-muted">
                atendimento {formatMinutes(a.actual_minutes)}
                {a.estimated_minutes ? ` de ${formatMinutes(a.estimated_minutes)}` : ""}
              </span>
            ) : null}
          </div>
        </div>
        {manage ? (
          <div className="flex shrink-0 items-start gap-1 pt-0.5">
            {/* Um clique copia o texto do momento para o grupo: atividade confirmada, técnico a caminho,
                encerrada com o link do relatório... Os outros textos ficam no ícone ao lado. */}
            {mayHaveGroupText(t) ? (
              <span className="hidden sm:inline-flex">
                <CopyNowButton ticketId={t.id} code={t.code} />
              </span>
            ) : null}
            <MessagesButton ticketId={t.id} code={t.code} />
            {canFixTimes ? <TimesButton ticketId={t.id} code={t.code} /> : null}
            <QuickEditButton ticketId={t.id} code={t.code} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function DayView() {
  const isClient = useIsClient();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const manage = canManageTickets(user?.role);
  // Um relógio para a tela toda: "atrasada há", "em atendimento há" e a virada do dia.
  const now = useNow(60_000);
  // Dia, grupo e técnico ficam na URL: recarregar ou mandar o link mantém a visão.
  const [picked, setPicked] = useState(() => readUrl(searchParams).picked);
  const [teamId, setTeamId] = useState(() => readUrl(searchParams).teamId);
  const [techId, setTechId] = useState(() => readUrl(searchParams).techId);
  // A URL mudou com a tela aberta (o link do menu, Voltar, um link com outro dia): mostra o que ela diz.
  const urlChange = useSearchChange();
  if (urlChange) {
    const next = readUrl(urlChange);
    if (next.picked !== picked) setPicked(next.picked);
    if (next.teamId !== teamId) setTeamId(next.teamId);
    if (next.techId !== techId) setTechId(next.techId);
  }
  // Hoje é calculado só no cliente (evita divergência de hidratação perto da meia-noite).
  const day = picked ?? (isClient ? operationDay(now) : null);
  const [search, setSearch] = useState("");
  const term = fold(useDebounced(search.trim(), 200));
  const [filter, setFilter] = useState<Filter | null>(null);
  const teams = useTeams();
  const technicians = useActiveTechnicians();
  const query = useDayActivities(day, teamId || null);
  const data = query.data;
  // A consulta guarda o dia anterior enquanto o novo carrega: só vale o que é do dia e grupo escolhidos.
  const fresh = Boolean(data && day && data.date === day && !query.isPlaceholderData);

  useEffect(() => {
    replaceSearch({ d: picked, grupo: teamId || null, tec: techId || null });
  }, [picked, teamId, techId]);

  const activities = useMemo(() => (fresh && data ? data.activities : []), [fresh, data]);
  // Quem tem visita no dia (responsável ou junto), para o filtro de técnico.
  const people = useMemo(() => {
    const names = new Map<string, string>();
    for (const a of activities) {
      if (a.ticket.assignee) names.set(a.ticket.assignee.id, a.ticket.assignee.name);
      for (const h of a.ticket.helpers ?? []) names.set(h.id, h.name);
    }
    return [...names].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name, "pt-BR"));
  }, [activities]);
  // Técnico e busca valem para a lista e para os números.
  const base = useMemo(
    () => activities.filter((a) => (!techId || worksOn(a, techId)) && (!term || haystack(a).includes(term))),
    [activities, techId, term],
  );
  const counts = useMemo(() => {
    const result = new Map<Filter, number>();
    if (day) for (const f of FILTERS) result.set(f.key, base.filter((a) => matches(a, f.key, day)).length);
    return result;
  }, [base, day]);
  // Lista única pela hora de atuação, a manhã primeiro (como pedido pela operação).
  const items = useMemo(
    () =>
      day
        ? base.filter((a) => !filter || matches(a, filter, day)).sort((x, y) => actingAt(x, day) - actingAt(y, day))
        : [],
    [base, filter, day],
  );

  // Técnico escolhido sem visita no dia (ou vindo pela URL): continua no filtro, com o nome do cadastro.
  const techMissing = Boolean(techId) && !people.some((p) => p.id === techId);
  const techName = techMissing ? technicians.data?.find((t) => t.id === techId)?.name : undefined;
  const narrowed = Boolean(techId || term);
  const clearFilters = () => {
    setFilter(null);
    setTechId("");
    setSearch("");
  };
  const filterLabel = filter ? FILTERS.find((f) => f.key === filter)?.label.toLowerCase() : null;
  // Hoje: OS a caminho ou em atendimento há mais de 12 h (dado parado). A API tira da lista e dos números;
  // a tela avisa para alguém concluir ou corrigir (a mesma regra da Minha fila e da Início).
  const stuck = fresh && data?.is_today ? (data.summary.stuck_in_field ?? 0) : 0;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Atividades do dia"
        description={
          day ? (
            <>
              {longDate(day)}
              {data?.is_today && fresh ? " · hoje" : ""} ·{" "}
              <LiveStatus
                updatedAt={fresh ? query.dataUpdatedAt : 0}
                every="a cada minuto"
                onRefresh={() => void query.refetch()}
                refreshing={query.isFetching}
              />
            </>
          ) : (
            "Carregando..."
          )
        }
        actions={
          day ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setPicked(shiftDay(day, -1))} aria-label="Dia anterior">
                <ChevronLeft className="size-4" />
              </Button>
              <Input
                type="date"
                value={day}
                onChange={(e) => e.target.value && setPicked(e.target.value)}
                aria-label="Data"
                className="w-40"
              />
              <Button size="sm" onClick={() => setPicked(shiftDay(day, 1))} aria-label="Próximo dia">
                <ChevronRight className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPicked(null)} disabled={!picked}>
                Hoje
              </Button>
            </div>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nº, cliente, loja, cidade ou título"
            aria-label="Buscar atividade"
            className="pl-9"
          />
        </div>
        <Select value={techId} onChange={(e) => setTechId(e.target.value)} aria-label="Técnico" className="w-full sm:w-56">
          <option value="">Todos os técnicos</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {techMissing ? (
            <option value={techId}>
              {techName ?? "Técnico escolhido"}
              {fresh ? " (sem visita no dia)" : ""}
            </option>
          ) : null}
        </Select>
        <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Grupo técnico" className="w-full sm:w-48">
          <option value="">Todos os grupos</option>
          {teams.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        {narrowed || filter ? (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            <X className="size-3.5" />
            Limpar filtros
          </Button>
        ) : null}
      </div>

      {/* Antes dos números: explica por que a OS parada não aparece em "Em deslocamento" nem "Em atendimento". */}
      {stuck > 0 ? (
        <p className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">
              {stuck} {stuck === 1 ? "OS parada" : "OS paradas"} em campo há mais de 12 h
            </strong>
            : {stuck === 1 ? "ficou" : "ficaram"} fora da lista e dos números. Conclua ou corrija a situação.{" "}
            <Link
              href="/chamados?status=en_route&status=in_progress&order_by=scheduled_start"
              className="rounded font-semibold whitespace-nowrap underline underline-offset-2 hover:no-underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            >
              Ver em Chamados
            </Link>
          </span>
        </p>
      ) : null}

      <div role="group" aria-label="Situação" className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map(({ key, label, color, hint }) => {
          const value = counts.get(key) ?? 0;
          const active = filter === key;
          const problem = PROBLEM_FILTERS.includes(key) && value > 0;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(active ? null : key)}
              title={hint}
              className={clsx(
                "min-w-[7.5rem] rounded-xl border px-3.5 py-2.5 text-left shadow-elev-1 transition-[border-color,background-color,box-shadow] duration-150",
                active
                  ? "border-brand bg-brand-soft ring-2 ring-brand/15"
                  : "border-line bg-surface hover:border-line-strong hover:shadow-elev-2",
                problem && !active && (key === "late" ? "border-red-200 dark:border-red-500/30" : "border-amber-200 dark:border-amber-500/30"),
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
                <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </span>
              {fresh ? (
                <CountUp
                  value={value}
                  duration={300}
                  className={clsx(
                    "mt-0.5 block text-xl font-semibold tracking-tight",
                    problem
                      ? key === "late"
                        ? "text-red-600 dark:text-red-400"
                        : "text-amber-700 dark:text-amber-400"
                      : "text-ink",
                  )}
                />
              ) : (
                <Skeleton className="mt-1.5 h-5 w-8" />
              )}
            </button>
          );
        })}
      </div>

      {query.error && fresh ? (
        <RefreshFailed
          at={query.errorUpdatedAt}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          className="mb-3"
        />
      ) : null}

      {!day || (!fresh && !query.error) ? (
        <Card>
          <LoadingBlock rows={4} label="Carregando as atividades do dia..." />
        </Card>
      ) : !fresh ? (
        <ErrorBox message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarClock />}
            title={
              narrowed || filter
                ? techMissing
                  ? `${techName ?? "Este técnico"} não tem visita neste dia`
                  : "Nenhuma atividade com esses filtros"
                : "Nenhuma atividade neste dia"
            }
            action={narrowed || filter ? <Button onClick={clearFilters}>Limpar filtros</Button> : undefined}
          />
        </Card>
      ) : (
        <Card className="animate-enter overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-[var(--table-head)] px-4 py-2.5 text-xs text-ink-muted">
            <span className="font-bold text-ink">{longDate(day)}</span>
            <span className="tabular-nums">
              {items.length} atividade{items.length === 1 ? "" : "s"}
              {filterLabel ? ` · ${filterLabel}` : ""}
            </span>
          </div>
          <ul>
            {items.map((a) => (
              <ActivityCard key={a.ticket.id} a={a} day={day} now={now} manage={manage} focusId={techId} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export default function DayPage() {
  // useSearchParams pede um Suspense em volta.
  return (
    <Suspense fallback={<LoadingBlock />}>
      <DayView />
    </Suspense>
  );
}
