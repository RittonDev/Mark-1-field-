"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import {
  AlarmClock,
  Building2,
  CalendarClock,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Coffee,
  HardHat,
  Hourglass,
  Inbox,
  Navigation,
  Plus,
  TriangleAlert,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PriorityBadge, SlaCountdown, StatusBadge } from "@/components/badges";
import { CountUp } from "@/components/motion";
import { useNow } from "@/components/useNow";
import { MessagesButton } from "@/components/ticket/MessagesPanel";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import { ArrivalChip, OnsiteBar } from "@/components/ticket/FieldClock";
import { Button, Card, EmptyState, ErrorBox, LoadingBlock, PageHeader, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatShort, formatTime, initials } from "@/lib/format";
import type { MyQueue, QueueItem, QueueReason, QueueSection, QueuesOut, UUID } from "@/lib/types";

const OPERATION_TZ = "America/Sao_Paulo";

const SECTIONS: {
  key: QueueSection;
  title: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  compact?: boolean;
}[] = [
  { key: "attention", title: "Precisa de atenção", hint: "Prazo estourando, sem técnico ou atrasada para começar", icon: TriangleAlert, tone: "text-red-600 dark:text-red-400" },
  { key: "in_field", title: "Em campo agora", hint: "Técnico a caminho ou atendendo", icon: Navigation, tone: "text-sky-600 dark:text-sky-400" },
  { key: "today", title: "Agenda de hoje", hint: "Visitas marcadas para hoje", icon: CalendarClock, tone: "text-brand" },
  { key: "waiting", title: "Aguardando", hint: "Pendente do cliente ou de fornecedor", icon: Hourglass, tone: "text-purple-600 dark:text-purple-400" },
  { key: "unscheduled", title: "Sem agenda", hint: "Abertas, ainda sem visita marcada", icon: Inbox, tone: "text-ink-muted" },
  { key: "upcoming", title: "Próximos dias", hint: "Já agendadas", icon: CalendarRange, tone: "text-ink-muted", compact: true },
  { key: "done", title: "Concluídas hoje", hint: "Resolvidas ou encerradas hoje", icon: CheckCircle2, tone: "text-emerald-600 dark:text-emerald-400", compact: true },
];

const REASON_TONE: Record<QueueReason["tone"], string> = {
  danger: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25",
  warning: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25",
  info: "bg-brand-soft text-brand-ink ring-brand/20",
};

function greeting(): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: OPERATION_TZ }).format(new Date()));
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

function longToday(): string {
  const text = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: OPERATION_TZ }).format(
    new Date(),
  );
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shortDay(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: OPERATION_TZ })
    .format(new Date(value))
    .replace(".", "");
}

function Kpi({
  label,
  value,
  icon: Icon,
  tone,
  alert,
  index,
  onClick,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  alert?: boolean;
  index: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ["--i" as string]: index }}
      className={clsx(
        "group flex items-center gap-3 rounded-xl border bg-surface p-4 text-left shadow-elev-1 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-elev-2",
        alert ? "border-red-200 dark:border-red-500/30" : "border-line hover:border-line-strong",
      )}
    >
      <span
        className={clsx(
          "flex size-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-105",
          alert ? "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400" : "bg-surface-2 " + tone,
        )}
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        <CountUp
          value={value}
          className={clsx("block text-2xl leading-none font-semibold tracking-tight", alert ? "text-red-600 dark:text-red-400" : "text-ink")}
        />
        <span className="mt-1 block truncate text-xs text-ink-muted">{label}</span>
      </span>
    </button>
  );
}

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={clsx(
        "flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-ink-muted",
        className ?? "size-6 text-[10px]",
      )}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

function QueueRow({ item, index, compact }: { item: QueueItem; index: number; compact?: boolean }) {
  const loc = item.location;
  const technician = item.assignee && item.assignee.role === "technician" ? item.assignee : null;
  const place = [item.customer?.name, loc?.name, loc?.city].filter(Boolean).join(" · ");
  return (
    <li
      style={{ ["--i" as string]: index }}
      className="group relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60 sm:px-5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <Link href={`/chamados/${item.id}`} className="min-w-0 flex-1 text-sm font-medium text-ink hover:text-brand">
            <span className="mr-1.5 font-mono text-xs font-normal text-ink-subtle">{item.code}</span>
            {item.title}
          </Link>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          {place ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Building2 className="size-3.5 shrink-0 text-ink-subtle" />
              <span className="truncate">{place}</span>
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <HardHat className="size-3.5 shrink-0 text-ink-subtle" />
            {technician ? technician.name : <span className="text-amber-700 dark:text-amber-400">Sem técnico</span>}
            {item.helpers?.length ? (
              <span className="text-emerald-700 dark:text-emerald-400" title={`Junto: ${item.helpers.map((h) => h.name).join(", ")}`}>
                +{item.helpers.length}
              </span>
            ) : null}
          </span>
          {item.scheduled_start && item.section !== "today" ? (
            <span className="inline-flex items-center gap-1">
              <CalendarClock className="size-3.5 shrink-0 text-ink-subtle" />
              {item.section === "upcoming" ? shortDay(item.scheduled_start) + " " : ""}
              {formatTime(item.scheduled_start)}
            </span>
          ) : null}
          {item.section === "done" && item.resolved_at ? (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              {formatTime(item.resolved_at)}
            </span>
          ) : null}
        </div>
        {!compact && item.reasons.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.reasons.map((r) => (
              <span key={r.code} className={clsx("rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", REASON_TONE[r.tone])}>
                {r.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-1.5 sm:flex">
        <div className="flex items-center gap-1.5">
          <PriorityBadge priority={item.priority} compact />
          <StatusBadge status={item.status} />
        </div>
        {item.section === "done" ? null : <SlaCountdown ticket={item} />}
        {item.section !== "done" && !item.arrived_at ? <ArrivalChip ticket={item} compact /> : null}
        {item.section === "in_field" ? <OnsiteBar ticket={item} /> : null}
      </div>
      {/* Ações sempre no canto direito, alinhadas em coluna (como "Editar" nas tabelas). */}
      <div className="flex shrink-0 items-center gap-1 self-center border-l border-line pl-3">
        <MessagesButton ticketId={item.id} code={item.code} />
        <QuickEditButton ticketId={item.id} code={item.code} />
      </div>
    </li>
  );
}

/** Agenda do dia como linha do tempo: hora à esquerda, marcador e a OS. */
function TodayTimeline({ items }: { items: QueueItem[] }) {
  const now = useNow(60_000);
  return (
    <ol className="stagger relative px-4 py-3 sm:px-5">
      {items.map((item, index) => {
        const start = item.scheduled_start ? new Date(item.scheduled_start).getTime() : null;
        const past = start !== null && start < now;
        const technician = item.assignee && item.assignee.role === "technician" ? item.assignee : null;
        return (
          <li key={item.id} style={{ ["--i" as string]: index }} className="group relative flex gap-4 pb-4 last:pb-0">
            <div className="w-12 shrink-0 pt-0.5 text-right">
              <span className={clsx("text-sm font-semibold tabular-nums", past ? "text-red-600 dark:text-red-400" : "text-ink")}>
                {formatTime(item.scheduled_start)}
              </span>
              {item.scheduled_end ? (
                <span className="block text-[11px] text-ink-subtle tabular-nums">{formatTime(item.scheduled_end)}</span>
              ) : null}
            </div>
            <div className="relative flex flex-col items-center">
              <span
                className={clsx(
                  "relative z-10 mt-1.5 size-2.5 rounded-full ring-4 ring-surface",
                  past ? "bg-red-500" : "bg-brand",
                )}
              />
              <span className="absolute top-3 bottom-[-12px] w-px bg-line group-last:hidden" />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-line bg-surface py-2.5 pr-2.5 pl-3.5 transition-[border-color,box-shadow] group-hover:border-line-strong group-hover:shadow-elev-1">
              <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <Link href={`/chamados/${item.id}`} className="min-w-0 flex-1 text-sm font-medium text-ink hover:text-brand">
                  <span className="mr-1.5 font-mono text-xs font-normal text-ink-subtle">{item.code}</span>
                  {item.title}
                </Link>
                <StatusBadge status={item.status} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                <span className="inline-flex min-w-0 items-center gap-1">
                  <Building2 className="size-3.5 shrink-0 text-ink-subtle" />
                  <span className="truncate">
                    {[item.customer?.name, item.location?.name, item.location?.city].filter(Boolean).join(" · ") || "—"}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <HardHat className="size-3.5 shrink-0 text-ink-subtle" />
                  {technician ? technician.name : <span className="text-amber-700 dark:text-amber-400">Sem técnico</span>}
            {item.helpers?.length ? (
              <span className="text-emerald-700 dark:text-emerald-400" title={`Junto: ${item.helpers.map((h) => h.name).join(", ")}`}>
                +{item.helpers.length}
              </span>
            ) : null}
                </span>
                {past ? (
                  <span className="inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
                    <AlarmClock className="size-3.5" />
                    Ainda não começou
                  </span>
                ) : null}
                {!item.arrived_at ? <ArrivalChip ticket={item} compact /> : null}
              </div>
              </div>
              <div className="flex shrink-0 items-center gap-1 self-stretch border-l border-line pl-2.5">
                <MessagesButton ticketId={item.id} code={item.code} />
                <QuickEditButton ticketId={item.id} code={item.code} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TeamQueues({
  meId,
  viewing,
  onPick,
}: {
  meId: UUID;
  viewing: UUID;
  onPick: (id: UUID) => void;
}) {
  const queues = useQuery({
    queryKey: ["tickets", "queues"],
    queryFn: () => api.get<QueuesOut>("/queues"),
    staleTime: 30_000,
  });
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Users className="size-4 text-ink-subtle" />
          Filas da equipe
        </h2>
        <span className="text-[11px] text-ink-subtle">abertas · atenção</span>
      </div>
      {queues.isLoading ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      ) : queues.error ? (
        <div className="p-3">
          <ErrorBox message={errorMessage(queues.error)} />
        </div>
      ) : (
        <ul className="p-1.5">
          {(queues.data?.queues ?? []).map((q) => {
            const selected = q.user.id === viewing;
            return (
              <li key={q.user.id}>
                <button
                  type="button"
                  onClick={() => onPick(q.user.id)}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    selected ? "bg-brand-soft" : "hover:bg-surface-2",
                  )}
                >
                  <Avatar name={q.user.name} className="size-7 text-[10px]" />
                  <span className="min-w-0 flex-1">
                    <span className={clsx("block truncate text-[13px]", selected ? "font-semibold text-ink" : "text-ink")}>
                      {q.user.id === meId ? "Você" : q.user.name}
                    </span>
                    <span className="block text-[11px] text-ink-subtle">
                      {q.today} hoje · {q.in_field} em campo
                    </span>
                  </span>
                  <span className="text-sm font-semibold text-ink tabular-nums">{q.open}</span>
                  <span
                    className={clsx(
                      "min-w-6 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular-nums",
                      q.attention ? "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400" : "bg-surface-2 text-ink-subtle",
                    )}
                  >
                    {q.attention}
                  </span>
                </button>
              </li>
            );
          })}
          {queues.data ? (
            <li className="mt-1 border-t border-line pt-1">
              <Link
                href="/chamados?no_owner=true"
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <span className="flex size-7 items-center justify-center rounded-full border border-dashed border-line-strong text-ink-subtle">
                  <Inbox className="size-3.5" />
                </span>
                <span className="flex-1">Sem analista</span>
                <span className="text-sm font-semibold text-ink tabular-nums">{queues.data.unowned.open}</span>
              </Link>
            </li>
          ) : null}
        </ul>
      )}
    </Card>
  );
}

export default function MyQueuePage() {
  const { user } = useAuth();
  const router = useRouter();
  const allowed = canManageTickets(user?.role);
  // Solicitante não tem fila: vai para os chamados dele.
  useEffect(() => {
    if (user && !allowed) router.replace("/chamados");
  }, [user, allowed, router]);
  const [viewing, setViewing] = useState<UUID | null>(null);
  const userId = viewing ?? user?.id ?? null;
  const mine = !viewing || viewing === user?.id;
  const queue = useQuery({
    queryKey: ["tickets", "my-queue", userId],
    queryFn: () => api.get<MyQueue>("/my-queue", mine ? {} : { user_id: userId ?? undefined }),
    enabled: Boolean(userId) && allowed,
    // "Atrasada" e prazos dependem do relógio: revalida mesmo sem eventos.
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  const grouped = useMemo(() => {
    const map = new Map<QueueSection, QueueItem[]>();
    for (const item of queue.data?.items ?? []) {
      const list = map.get(item.section) ?? [];
      list.push(item);
      map.set(item.section, list);
    }
    return map;
  }, [queue.data]);

  if (user && !allowed) return null;

  const counts = queue.data?.counts;
  const firstName = (queue.data?.user.name ?? user?.name ?? "").split(" ")[0];
  const scrollTo = (key: QueueSection) =>
    document.getElementById(`fila-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const empty = queue.data && queue.data.items.length === 0;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        eyebrow={longToday()}
        title={mine ? `${greeting()}, ${firstName}` : `Fila de ${queue.data?.user.name ?? "..."}`}
        description={
          mine
            ? "Suas OS organizadas pelo que pede ação primeiro. Atualiza em tempo real."
            : "Você está vendo a fila de um colega. Abra a OS para puxar para a sua fila."
        }
        actions={
          <>
            {!mine ? (
              <Button variant="ghost" onClick={() => setViewing(null)}>
                Voltar para a minha fila
              </Button>
            ) : null}
            <Link href="/chamados/novo">
              <Button variant="primary">
                <Plus className="size-4" />
                Nova OS
              </Button>
            </Link>
          </>
        }
      />

      {queue.error ? (
        <ErrorBox message={errorMessage(queue.error)} />
      ) : (
        <>
          <div className="stagger mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Kpi index={0} label="Na fila" value={counts?.open ?? 0} icon={Inbox} tone="text-brand" />
            <Kpi
              index={1}
              label="Precisam de atenção"
              value={counts?.attention ?? 0}
              icon={TriangleAlert}
              tone="text-red-600"
              alert={(counts?.attention ?? 0) > 0}
              onClick={() => scrollTo("attention")}
            />
            <Kpi index={2} label="Agendadas hoje" value={counts?.today ?? 0} icon={CalendarClock} tone="text-brand" onClick={() => scrollTo("today")} />
            <Kpi index={3} label="Em campo agora" value={counts?.in_field ?? 0} icon={Navigation} tone="text-sky-600" onClick={() => scrollTo("in_field")} />
            <Kpi index={4} label="Concluídas hoje" value={counts?.done ?? 0} icon={CheckCircle2} tone="text-emerald-600" onClick={() => scrollTo("done")} />
          </div>

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex flex-col gap-5">
              {queue.isLoading || !queue.data ? (
                <Card>
                  <LoadingBlock rows={4} label="Carregando sua fila..." />
                </Card>
              ) : empty ? (
                <Card>
                  <EmptyState
                    icon={<Coffee />}
                    title="Fila zerada"
                    description="Nenhuma OS aberta com você. Novas OS atribuídas a você aparecem aqui na hora."
                    action={
                      <Link href="/chamados?no_owner=true">
                        <Button>Ver OS sem analista</Button>
                      </Link>
                    }
                  />
                </Card>
              ) : (
                SECTIONS.map((section) => {
                  const items = grouped.get(section.key) ?? [];
                  if (!items.length) return null;
                  const Icon = section.icon;
                  return (
                    <Card key={section.key} className="animate-enter scroll-mt-20 overflow-hidden">
                      <div id={`fila-${section.key}`} className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
                        <Icon className={clsx("size-4 shrink-0", section.tone)} />
                        <div className="min-w-0 flex-1">
                          <h2 className="text-sm font-semibold text-ink">
                            {section.title}
                            <span className="ml-2 rounded-full bg-surface-2 px-1.5 text-[11px] leading-[18px] font-semibold text-ink-muted tabular-nums">
                              {items.length}
                            </span>
                          </h2>
                          <p className="truncate text-xs text-ink-subtle">{section.hint}</p>
                        </div>
                        {section.key === "today" ? (
                          <Link href="/dia" className="shrink-0 text-xs text-ink-muted hover:text-brand">
                            Atividades do dia
                          </Link>
                        ) : null}
                      </div>
                      {section.key === "today" ? (
                        <TodayTimeline items={items} />
                      ) : (
                        <ul className="stagger divide-y divide-line">
                          {items.map((item, index) => (
                            <QueueRow key={item.id} item={item} index={index} compact={section.compact} />
                          ))}
                        </ul>
                      )}
                    </Card>
                  );
                })
              )}
            </div>

            <aside className="flex flex-col gap-4 lg:sticky lg:top-20">
              {user ? <TeamQueues meId={user.id} viewing={userId ?? user.id} onPick={(id) => setViewing(id === user.id ? null : id)} /> : null}
              <Card className="p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Clock3 className="size-4 text-ink-subtle" />
                  Como a fila se organiza
                </p>
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                  Entram aqui as OS em que você é o analista responsável ou o executor. Primeiro o que está em campo,
                  depois o que precisa de ação (prazo, técnico, atraso), a agenda do dia e o restante.
                </p>
                {queue.data ? (
                  <p className="mt-3 text-[11px] text-ink-subtle">Atualizado {formatShort(queue.data.generated_at)}</p>
                ) : null}
              </Card>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
