"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, CheckCircle2, Clock, Pencil } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { PriorityBadge, SlaBadge, StatusBadge } from "@/components/badges";
import { AssignmentPanel } from "@/components/ticket/AssignmentPanel";
import { AttachmentsTab } from "@/components/ticket/AttachmentsTab";
import { CommentsTab } from "@/components/ticket/CommentsTab";
import { EditTicketDialog } from "@/components/ticket/EditTicketDialog";
import { HistoryTab } from "@/components/ticket/HistoryTab";
import { SlaCard } from "@/components/ticket/SlaCard";
import { TicketInfo } from "@/components/ticket/TicketInfo";
import { TransitionDialog } from "@/components/ticket/TransitionDialog";
import { WorklogsTab } from "@/components/ticket/WorklogsTab";
import { Button, Card, ErrorBox, LoadingBlock } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { STATUS, STATUS_ORDER, TRANSITION_ACTION } from "@/lib/constants";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { TicketDetail, TicketStatus } from "@/lib/types";

type Tab = "comments" | "history" | "worklogs" | "attachments";

const TABS: { key: Tab; label: string }[] = [
  { key: "comments", label: "Acompanhamentos" },
  { key: "history", label: "Histórico" },
  { key: "worklogs", label: "Apontamentos" },
  { key: "attachments", label: "Anexos" },
];

const PRIMARY_TARGETS: TicketStatus[] = ["en_route", "in_progress", "resolved", "closed", "scheduled"];

function DueLine({
  label,
  due,
  doneAt,
  paused,
  now,
}: {
  label: string;
  due: string | null;
  doneAt: string | null;
  paused: boolean;
  now: number;
}) {
  if (!due) return null;
  const met = doneAt !== null;
  const late = met ? new Date(doneAt).getTime() > new Date(due).getTime() : new Date(due).getTime() < now;
  return (
    <div className="flex items-center gap-2 text-sm">
      {met ? (
        <CheckCircle2 className={clsx("size-4", late ? "text-red-500" : "text-emerald-500")} />
      ) : (
        <Clock className={clsx("size-4", late ? "text-red-500" : "text-ink-muted")} />
      )}
      <span className="w-16 text-ink-muted">{label}</span>
      <span className="text-ink">{formatDateTime(due)}</span>
      <span
        className={clsx(
          "text-xs",
          late ? "font-medium text-red-600 dark:text-red-400" : "text-ink-muted",
        )}
      >
        {met
          ? late
            ? "cumprido com atraso"
            : "cumprido"
          : paused
            ? "pausado"
            : formatRelative(due, now)}
      </span>
    </div>
  );
}

export default function TicketDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const now = useNow(30_000);
  const [tab, setTab] = useState<Tab>("comments");
  const [target, setTarget] = useState<TicketStatus | null>(null);
  const [editing, setEditing] = useState(false);

  const query = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}`),
  });

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorBox message={errorMessage(query.error)} />
      </div>
    );
  }

  const ticket = query.data;
  const info = STATUS[ticket.status];
  const transitions = [...ticket.allowed_transitions].sort(
    (a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b),
  );
  const paused = ticket.sla_paused_at !== null;

  return (
    <div className="mx-auto max-w-7xl">
      <Link href="/chamados" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        Chamados
      </Link>

      <Card className="mb-4">
        <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-ink-muted">{ticket.code}</span>
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
              <SlaBadge status={ticket.sla_status} />
            </div>
            <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink">{ticket.title}</h1>
            <p className="mt-1 text-sm text-ink-muted">{info.description}</p>
          </div>
          <div className="flex shrink-0 flex-col gap-1.5 rounded-lg bg-surface-2 px-4 py-3">
            <DueLine
              label="Resposta"
              due={ticket.response_due_at}
              doneAt={ticket.first_response_at}
              paused={paused}
              now={now}
            />
            <DueLine
              label="Solução"
              due={ticket.resolution_due_at}
              doneAt={ticket.resolved_at}
              paused={paused}
              now={now}
            />
          </div>
        </div>
        {transitions.length > 0 || ticket.can_edit ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
            {transitions.map((to) => (
              <Button
                key={to}
                size="sm"
                variant={to === "cancelled" ? "danger" : PRIMARY_TARGETS.includes(to) ? "primary" : "secondary"}
                onClick={() => setTarget(to)}
              >
                <span className="size-1.5 rounded-full bg-current opacity-70" />
                {TRANSITION_ACTION[to]}
              </Button>
            ))}
            {ticket.can_edit ? (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" />
                Editar
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <div className="p-5">
              <h2 className="mb-2 text-xs font-medium tracking-wide text-ink-muted uppercase">Descrição</h2>
              {ticket.description ? (
                <p className="text-sm whitespace-pre-wrap text-ink">{ticket.description}</p>
              ) : (
                <p className="text-sm text-ink-muted">Sem descrição.</p>
              )}
            </div>
            {ticket.resolution_notes ? (
              <div className="border-t border-line bg-emerald-50/60 p-5 dark:bg-emerald-950/20">
                <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-emerald-700 uppercase dark:text-emerald-400">
                  <CheckCircle2 className="size-3.5" />
                  Solução aplicada
                </h2>
                <p className="text-sm whitespace-pre-wrap text-ink">{ticket.resolution_notes}</p>
              </div>
            ) : null}
          </Card>

          <Card>
            <div className="flex gap-1 overflow-x-auto border-b border-line px-3">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={clsx(
                    "-mb-px border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors",
                    tab === t.key
                      ? "border-brand font-medium text-ink"
                      : "border-transparent text-ink-muted hover:text-ink",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="p-4">
              {tab === "comments" ? <CommentsTab ticketId={ticket.id} /> : null}
              {tab === "history" ? <HistoryTab ticketId={ticket.id} /> : null}
              {tab === "worklogs" ? <WorklogsTab ticketId={ticket.id} closed={info.final} /> : null}
              {tab === "attachments" ? <AttachmentsTab ticketId={ticket.id} closed={info.final} /> : null}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <AssignmentPanel key={`${ticket.assignee?.id ?? "none"}-${ticket.version}`} ticket={ticket} />
          <SlaCard ticket={ticket} />
          <TicketInfo ticket={ticket} />
        </div>
      </div>

      {target ? <TransitionDialog key={target} ticket={ticket} to={target} onClose={() => setTarget(null)} /> : null}
      {editing ? <EditTicketDialog ticket={ticket} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
