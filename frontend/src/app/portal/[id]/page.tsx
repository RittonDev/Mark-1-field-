"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, CalendarClock, CircleAlert, ExternalLink, MapPinCheck, Phone, Plus, Store, UserRound, XCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/portal/Badge";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Card, Dialog, ErrorBox, Field, LoadingBlock, PageHeader, SectionTitle, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { canOpenRequests, clientStatusColor, clientTimeline, TIMELINE_LABEL, usePortalMe, visitWindow } from "@/lib/portal";
import type { PortalRequestDetail } from "@/lib/types";

function Info({ icon: Icon, label, children }: { icon: typeof Store; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-ink/80">{label}</p>
        <div className="text-sm text-ink">{children}</div>
      </div>
    </div>
  );
}

/** Aviso no topo da solicitação (concluída, cancelada): título, quando e a ação ao lado. */
function Outcome({ title, at, children, action }: { title: string; at: string | null; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card className="mb-4 flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <SectionTitle as="h2">{title}</SectionTitle>
        {at ? <p className="mt-1 text-xs text-ink-muted">{formatDateTime(at)}</p> : null}
        {children}
      </div>
      {action}
    </Card>
  );
}

function CancelDialog({ request, onClose }: { request: PortalRequestDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const cancel = useMutation({
    mutationFn: () => api.post<PortalRequestDetail>(`/portal/requests/${request.id}/cancel`, { reason: reason.trim() }),
    onSuccess: (data) => {
      queryClient.setQueryData(["portal", "request", request.id], data);
      void queryClient.invalidateQueries({ queryKey: ["portal", "requests"] });
      toast({ title: "Solicitação cancelada", description: request.code, tone: "success" });
      onClose();
    },
  });
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      busy={cancel.isPending}
      title="Cancelar solicitação"
      description={`${request.code} · ${request.title}`}
      footer={
        <>
          <Button onClick={onClose} disabled={cancel.isPending}>
            Voltar
          </Button>
          <Button variant="danger" loading={cancel.isPending} disabled={reason.trim().length < 3} onClick={() => cancel.mutate()}>
            Cancelar solicitação
          </Button>
        </>
      }
    >
      <Field label="Por que cancelar?" required>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="Ex.: resolvemos na loja"
          autoFocus
        />
      </Field>
      {cancel.error ? (
        <div className="mt-3">
          <ErrorBox message={errorMessage(cancel.error)} />
        </div>
      ) : null}
    </Dialog>
  );
}

/** Uma solicitação: em que pé está, quando é a visita, quem vai e o relatório no fim. */
export default function PortalRequestPage() {
  const { id } = useParams<{ id: string }>();
  const me = usePortalMe();
  const [cancelling, setCancelling] = useState(false);
  const query = useQuery({
    queryKey: ["portal", "request", id],
    queryFn: () => api.get<PortalRequestDetail>(`/portal/requests/${id}`),
    refetchInterval: 30_000,
  });

  const back = (
    <Link href="/portal" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
      <ArrowLeft className="size-4" />
      Solicitações
    </Link>
  );
  if (query.isLoading) return <LoadingBlock rows={4} />;
  if (query.error || !query.data) {
    return (
      <div>
        {back}
        <ErrorBox message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  const r = query.data;
  const done = r.status === "resolved" || r.status === "closed";
  const cancelled = r.status === "cancelled";
  // Encerrada (concluída ou cancelada): o que faltava combinar não vai mais acontecer.
  const ended = done || cancelled;
  const timeline = clientTimeline(r.timeline);

  return (
    <div>
      {back}
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2 pb-1">
            <Badge status={r.status} />
            <span className="font-mono text-xs text-ink-subtle">{r.code}</span>
          </span>
        }
        title={r.title}
        documentTitle={r.code}
        description={
          <>
            Aberta {formatDateTime(r.created_at)}
            {r.requester_name ? ` por ${r.requester_name}` : ""}
          </>
        }
      />

      {r.status === "on_hold_customer" ? (
        <Card className="mb-4 flex items-start gap-2.5 p-4">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-ink-muted">
            <span className="font-semibold text-ink">A central precisa de um retorno de vocês.</span> Responda pelo canal de
            sempre (WhatsApp ou e-mail) e cite o nº {r.code}.
          </p>
        </Card>
      ) : null}

      {done ? (
        <Outcome
          title="Atendimento concluído"
          at={r.resolved_at}
          action={
            r.report_url ? (
              <a href={r.report_url} target="_blank" rel="noreferrer" className={buttonClassName("primary", "md", "shrink-0")}>
                Ver relatório da visita
                <ExternalLink aria-hidden className="size-4" />
              </a>
            ) : null
          }
        >
          {r.resolution_notes ? <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-ink">{r.resolution_notes}</p> : null}
        </Outcome>
      ) : cancelled ? (
        <Outcome
          title="Solicitação cancelada"
          at={r.cancelled_at}
          action={
            canOpenRequests(me.data) ? (
              <Link href="/portal/nova" className={buttonClassName("secondary", "md", "shrink-0")}>
                <Plus aria-hidden className="size-4" />
                Abrir nova solicitação
              </Link>
            ) : null
          }
        >
          <p className="mt-2 text-sm text-ink-muted">Se o problema voltar, abra uma nova solicitação.</p>
        </Outcome>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Info icon={Store} label="Loja">
                {r.location ? (
                  <>
                    {r.location.code ? <span className="mr-1.5 font-mono text-xs text-ink-muted">{r.location.code}</span> : null}
                    {r.location.name}
                    {r.location.address || r.location.city ? (
                      <span className="block text-xs text-ink-muted">
                        {[r.location.address, [r.location.city, r.location.state].filter(Boolean).join(" - ")].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </>
                ) : (
                  "—"
                )}
              </Info>
              <Info icon={CalendarClock} label="Visita">
                {r.scheduled_start ? visitWindow(r.scheduled_start, r.scheduled_end) : ended ? "—" : "A combinar com a central"}
              </Info>
              <Info icon={UserRound} label="Técnico">
                {r.technician ?? (ended ? "—" : "A central está escolhendo")}
              </Info>
              {r.arrived_at ? (
                <Info icon={MapPinCheck} label="Chegada do técnico">
                  {formatDateTime(r.arrived_at)}
                </Info>
              ) : null}
              <Info icon={Phone} label="Quem recebe o técnico">
                {r.contact ?? "—"}
              </Info>
            </div>
            {r.client_reference ? <p className="mt-4 text-xs text-ink-muted">Nº do chamado de vocês: {r.client_reference}</p> : null}
          </Card>

          <Card className="p-5">
            <SectionTitle as="h2" className="mb-2">O que aconteceu</SectionTitle>
            <p className="text-sm leading-relaxed whitespace-pre-line text-ink">{r.description || r.title}</p>
          </Card>

          {r.can_cancel ? (
            <div>
              <Button variant="ghost" onClick={() => setCancelling(true)}>
                <XCircle aria-hidden className="size-4" />
                Cancelar solicitação
              </Button>
            </div>
          ) : null}
        </div>

        <Card className="h-fit p-5">
          <SectionTitle as="h2" className="mb-3">Andamento</SectionTitle>
          <ol className="relative flex flex-col gap-4">
            {timeline.map((entry, i) => {
              const last = i === timeline.length - 1;
              const color = entry.status === "created" ? "#64748b" : clientStatusColor(entry.status);
              return (
                <li key={`${entry.status}-${entry.at}`} className="relative flex gap-3">
                  {!last ? <span className="absolute top-3 left-[5px] h-[calc(100%+4px)] w-px bg-line" aria-hidden /> : null}
                  <span
                    aria-hidden
                    className={clsx("relative mt-1 size-[11px] shrink-0 rounded-full ring-4 ring-surface", !last && "opacity-60")}
                    style={{ backgroundColor: color }}
                  />
                  <div className="min-w-0">
                    <p className={clsx("text-sm", last ? "font-medium text-ink" : "text-ink-muted")}>{TIMELINE_LABEL[entry.status]}</p>
                    <p className="text-xs text-ink-subtle">{formatDateTime(entry.at)}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      </div>

      {cancelling ? <CancelDialog request={r} onClose={() => setCancelling(false)} /> : null}
    </div>
  );
}
