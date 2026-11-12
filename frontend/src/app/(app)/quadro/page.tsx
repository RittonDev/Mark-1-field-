"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { CalendarClock, MapPin, UserRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { PriorityBadge, SlaBadge } from "@/components/badges";
import { TransitionDialog } from "@/components/ticket/TransitionDialog";
import { Checkbox, ErrorBox, LoadingBlock, PageHeader, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { FINAL_STATUSES, STATUS, STATUS_ORDER } from "@/lib/constants";
import { formatShort } from "@/lib/format";
import { useTeams } from "@/lib/queries";
import type { Page, TicketListItem, TicketStatus } from "@/lib/types";
import { allowedTargets } from "@/lib/workflow";

function BoardCard({
  ticket,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  ticket: TicketListItem;
  draggable: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", ticket.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={clsx(
        "rounded-lg border border-line bg-surface p-3 shadow-xs transition",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default",
        dragging && "opacity-40",
      )}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <Link href={`/chamados/${ticket.id}`} className="font-mono text-xs text-ink-muted hover:text-brand">
          {ticket.code}
        </Link>
        <PriorityBadge priority={ticket.priority} compact />
      </div>
      <Link href={`/chamados/${ticket.id}`} className="line-clamp-2 text-sm font-medium text-ink hover:text-brand">
        {ticket.title}
      </Link>
      {ticket.customer || ticket.location ? (
        <p className="mt-1.5 flex items-center gap-1 truncate text-xs text-ink-muted">
          <MapPin className="size-3 shrink-0" />
          <span className="truncate">
            {[ticket.customer?.name, ticket.location?.name].filter(Boolean).join(" · ")}
          </span>
        </p>
      ) : null}
      {ticket.scheduled_start ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-ink-muted">
          <CalendarClock className="size-3" />
          {formatShort(ticket.scheduled_start)}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span
          className={clsx(
            "flex min-w-0 items-center gap-1 text-xs",
            ticket.assignee ? "text-ink" : "text-amber-600 dark:text-amber-400",
          )}
        >
          <UserRound className="size-3 shrink-0" />
          <span className="truncate">{ticket.assignee?.name ?? "Sem responsável"}</span>
        </span>
        <SlaBadge status={ticket.sla_status} />
      </div>
    </div>
  );
}

export default function BoardPage() {
  const { user } = useAuth();
  const teams = useTeams();
  const [showFinal, setShowFinal] = useState(false);
  const [mine, setMine] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [dragging, setDragging] = useState<TicketListItem | null>(null);
  const [overColumn, setOverColumn] = useState<TicketStatus | null>(null);
  const [pending, setPending] = useState<{ ticket: TicketListItem; to: TicketStatus } | null>(null);

  const columns = STATUS_ORDER.filter((s) => showFinal || !FINAL_STATUSES.includes(s));

  const query = useQuery({
    queryKey: ["tickets", "board", { showFinal, mine, teamId }],
    queryFn: () =>
      api.get<Page<TicketListItem>>("/tickets", {
        status: columns,
        mine,
        team_id: teamId || undefined,
        page_size: 500,
        order_by: "priority",
      }),
  });

  const grouped = useMemo(() => {
    const map = new Map<TicketStatus, TicketListItem[]>();
    for (const t of query.data?.items ?? []) {
      const list = map.get(t.status) ?? [];
      list.push(t);
      map.set(t.status, list);
    }
    return map;
  }, [query.data]);

  const allowed = dragging ? allowedTargets(user, dragging) : [];

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col">
      <PageHeader
        title="Quadro de atendimento"
        description="Arraste a OS para mudar o status. Só as colunas permitidas aceitam o card."
        actions={
          <>
            <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="w-48">
              <option value="">Todos os grupos</option>
              {teams.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Checkbox label="Minhas OS" checked={mine} onChange={setMine} />
            <Checkbox label="Mostrar fechadas/canceladas" checked={showFinal} onChange={setShowFinal} />
          </>
        }
      />

      {query.isLoading ? (
        <LoadingBlock />
      ) : query.error ? (
        <ErrorBox message={errorMessage(query.error)} />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {columns.map((status) => {
            const items = grouped.get(status) ?? [];
            const info = STATUS[status];
            const canDrop = dragging !== null && allowed.includes(status);
            const isSource = dragging?.status === status;
            return (
              <section
                key={status}
                onDragOver={(e) => {
                  if (!canDrop) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overColumn !== status) setOverColumn(status);
                }}
                onDragLeave={() => setOverColumn((c) => (c === status ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (canDrop && dragging) setPending({ ticket: dragging, to: status });
                  setDragging(null);
                  setOverColumn(null);
                }}
                className={clsx(
                  "flex w-72 shrink-0 flex-col rounded-xl border bg-surface-2/60 transition-colors",
                  canDrop && overColumn === status && "border-brand bg-brand/5",
                  canDrop && overColumn !== status && "border-dashed border-brand/50",
                  !canDrop && "border-line",
                  dragging && !canDrop && !isSource && "opacity-50",
                )}
              >
                <header className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ backgroundColor: info.color }} />
                    <h2 className="text-sm font-semibold text-ink">{info.label}</h2>
                  </div>
                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-ink-muted tabular-nums">
                    {items.length}
                  </span>
                </header>
                <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {items.map((t) => (
                    <BoardCard
                      key={t.id}
                      ticket={t}
                      draggable={allowedTargets(user, t).length > 0}
                      dragging={dragging?.id === t.id}
                      onDragStart={() => setDragging(t)}
                      onDragEnd={() => {
                        setDragging(null);
                        setOverColumn(null);
                      }}
                    />
                  ))}
                  {items.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-ink-muted">Nenhuma OS</p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {pending ? (
        <TransitionDialog
          key={`${pending.ticket.id}-${pending.to}`}
          ticket={pending.ticket}
          to={pending.to}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}
