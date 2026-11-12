"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Ban, CheckCircle2, Clock, MessageCircle, Pencil, StickyNote } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { PriorityBadge, SlaBadge, StatusBadge } from "@/components/badges";
import { AssignmentPanel } from "@/components/ticket/AssignmentPanel";
import { AttachmentsTab } from "@/components/ticket/AttachmentsTab";
import { CommentsTab } from "@/components/ticket/CommentsTab";
import { EditTicketDialog } from "@/components/ticket/EditTicketDialog";
import { ExpensesCard } from "@/components/ticket/ExpensesCard";
import { FormsCard } from "@/components/ticket/FormsCard";
import { MessagesCard } from "@/components/ticket/MessagesPanel";
import { OwnerCard } from "@/components/ticket/OwnerCard";
import { PartRequestsCard } from "@/components/ticket/PartRequestsCard";
import { LegacyOrderCard } from "@/components/ticket/LegacyOrderCard";
import { TagChips } from "@/components/TagChips";
import { AuthorizationCard } from "@/components/ticket/AuthorizationCard";
import { ArrivalChip, AuthorizationChip, OnsiteBar, RecurrenceChip } from "@/components/ticket/FieldClock";
import { ReportLinkCard } from "@/components/ticket/ReportLinkCard";
import { HistoryTab } from "@/components/ticket/HistoryTab";
import { QuotesCard } from "@/components/ticket/QuotesCard";
import { SlaCard } from "@/components/ticket/SlaCard";
import { TicketInfo } from "@/components/ticket/TicketInfo";
import { TransitionDialog } from "@/components/ticket/TransitionDialog";
import { VisitTeamCard } from "@/components/ticket/VisitTeamCard";
import { UNPRODUCTIVE_FROM, UnproductiveDialog } from "@/components/ticket/UnproductiveDialog";
import { WhatsAppShare } from "@/components/ticket/WhatsAppShare";
import { WorklogsTab } from "@/components/ticket/WorklogsTab";
import { Tabs } from "@/components/motion";
import { Button, Card, ErrorBox, LoadingBlock } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, STATUS, STATUS_ORDER, TRANSITION_ACTION } from "@/lib/constants";
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

/** Outras OS na mesma loja nos últimos 30 dias: ajuda a ver reincidência antes de mandar o técnico. */
function StoreHistoryCard({ ticket }: { ticket: TicketDetail }) {
  const history = ticket.recurrence;
  if (!history || history.count_30d === 0) return null;
  return (
    <Card className="p-4">
      <p className="mb-2 flex items-center justify-between text-xs font-medium text-ink-subtle">
        <span>Histórico da loja · 30 dias</span>
        <span className="rounded-full bg-violet-50 px-1.5 font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
          {history.count_30d}
        </span>
      </p>
      <ul className="flex flex-col gap-1">
        {history.previous.map((p) => (
          <li key={p.id}>
            <Link href={`/chamados/${p.id}`} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-2">
              <span className="mt-0.5 font-mono text-[11px] text-ink-subtle">{p.code}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{p.title}</span>
                <span className="text-[11px] text-ink-subtle">
                  {STATUS[p.status]?.label ?? p.status} · {formatDateTime(p.created_at)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function TicketDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const now = useNow(30_000);
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("comments");
  const [target, setTarget] = useState<TicketStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [unproductive, setUnproductive] = useState(false);
  const [sharing, setSharing] = useState(false);

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
              {ticket.client_reference ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted"
                  title="Nº do chamado no sistema do cliente"
                >
                  Chamado do cliente <span className="font-mono font-medium text-ink">{ticket.client_reference}</span>
                </span>
              ) : null}
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
              <SlaBadge status={ticket.sla_status} />
              <AuthorizationChip status={ticket.authorization_status} />
              <RecurrenceChip count={ticket.recurrence?.count_30d} />
              <TagChips tags={ticket.tags} max={4} />
              {ticket.project ? (
                <Link
                  href={`/projetos/${ticket.project.id}`}
                  className="inline-flex items-center gap-1 rounded-full bg-nav-active px-2 py-0.5 text-xs font-medium text-brand hover:underline"
                >
                  Projeto {ticket.project.code} · {ticket.project.name}
                </Link>
              ) : null}
              {ticket.unproductive_count ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300">
                  <Ban className="size-3" />
                  {ticket.unproductive_count} visita{ticket.unproductive_count > 1 ? "s" : ""} improdutiva{ticket.unproductive_count > 1 ? "s" : ""}
                </span>
              ) : null}
            </div>
            <h1 className="mt-2 text-[22px] leading-tight font-semibold tracking-[-0.015em] text-ink">{ticket.title}</h1>
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
            {ticket.arrival_due_at || ticket.arrived_at ? (
              <div className="mt-1 flex flex-col gap-2 border-t border-line pt-2">
                <ArrivalChip ticket={ticket} />
                <OnsiteBar ticket={ticket} />
              </div>
            ) : null}
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
            {ticket.can_assign ? (
              <Button size="sm" variant="ghost" onClick={() => setSharing(true)}>
                <MessageCircle className="size-3.5" />
                WhatsApp
              </Button>
            ) : null}
            {ticket.can_edit && UNPRODUCTIVE_FROM.includes(ticket.status) && ticket.assignee ? (
              <Button size="sm" variant="ghost" onClick={() => setUnproductive(true)}>
                <Ban className="size-3.5" />
                Visita improdutiva
              </Button>
            ) : null}
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
          <AuthorizationCard ticket={ticket} />

          <Card>
            <div className="p-5">
              <h2 className="mb-2 text-xs font-medium tracking-wide text-ink-muted uppercase">Descrição</h2>
              {ticket.description ? (
                <p className="text-sm whitespace-pre-wrap text-ink">{ticket.description}</p>
              ) : (
                <p className="text-sm text-ink-muted">Sem descrição.</p>
              )}
            </div>
            {ticket.visit_note ? (
              <div className="border-t border-line bg-amber-50/50 p-5 dark:bg-amber-500/5">
                <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-amber-800 uppercase dark:text-amber-300">
                  <StickyNote className="size-3.5" />
                  Observação da visita
                </h2>
                <p className="text-sm whitespace-pre-wrap text-ink">{ticket.visit_note}</p>
              </div>
            ) : null}
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

          <ReportLinkCard ticket={ticket} />

          {ticket.can_assign ? <MessagesCard ticketId={ticket.id} /> : null}

          <FormsCard ticket={ticket} />

          <PartRequestsCard ticket={ticket} />

          <QuotesCard ticket={ticket} />

          <LegacyOrderCard ticket={ticket} />

          <Card>
            <div className="border-b border-line px-3 pt-2">
              <Tabs items={TABS} value={tab} onChange={setTab} ariaLabel="Seções da OS" />
            </div>
            <div className="p-4">
              {tab === "comments" ? <CommentsTab ticketId={ticket.id} /> : null}
              {tab === "history" ? <HistoryTab ticketId={ticket.id} /> : null}
              {tab === "worklogs" ? <WorklogsTab ticketId={ticket.id} closed={info.final} /> : null}
              {tab === "attachments" ? (
                <AttachmentsTab ticketId={ticket.id} closed={info.final} canManage={canManageTickets(user?.role)} signatureId={ticket.signature_attachment_id} />
              ) : null}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <OwnerCard ticket={ticket} />
          <StoreHistoryCard ticket={ticket} />
          <AssignmentPanel key={`${ticket.assignee?.id ?? "none"}-${ticket.version}`} ticket={ticket} />
          <VisitTeamCard ticket={ticket} />
          <SlaCard ticket={ticket} />
          <ExpensesCard ticket={ticket} />
          <TicketInfo ticket={ticket} />
        </div>
      </div>

      {target ? <TransitionDialog key={target} ticket={ticket} to={target} onClose={() => setTarget(null)} /> : null}
      {editing ? <EditTicketDialog ticket={ticket} onClose={() => setEditing(false)} /> : null}
      {unproductive ? <UnproductiveDialog ticket={ticket} onClose={() => setUnproductive(false)} /> : null}
      {sharing ? <WhatsAppShare ticket={ticket} onClose={() => setSharing(false)} /> : null}
    </div>
  );
}
