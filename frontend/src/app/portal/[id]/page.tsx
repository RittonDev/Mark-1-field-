"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, CalendarClock, ExternalLink, FileText, Phone, Store, UserRound, XCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/portal/Badge";
import { Button, Card, Dialog, ErrorBox, Field, LoadingBlock, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { clientStatusColor, TIMELINE_LABEL } from "@/lib/portal";
import type { PortalRequestDetail } from "@/lib/types";

function Info({ icon: Icon, label, children }: { icon: typeof Store; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
      <div className="min-w-0">
        <p className="text-xs text-ink-muted">{label}</p>
        <div className="text-sm text-ink">{children}</div>
      </div>
    </div>
  );
}

function CancelDialog({ request, onClose }: { request: PortalRequestDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const cancel = useMutation({
    mutationFn: () => api.post<PortalRequestDetail>(`/portal/requests/${request.id}/cancel`, { reason: reason.trim() }),
    onSuccess: (data) => {
      queryClient.setQueryData(["portal", "request", request.id], data);
      void queryClient.invalidateQueries({ queryKey: ["portal", "requests"] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Cancelar solicitação"
      description={`${request.code} · ${request.title}`}
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button variant="danger" loading={cancel.isPending} disabled={reason.trim().length < 3} onClick={() => cancel.mutate()}>
            Cancelar solicitação
          </Button>
        </>
      }
    >
      <Field label="Por que cancelar?" required>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Ex.: resolvemos na loja" autoFocus />
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
        <ErrorBox message={errorMessage(query.error)} />
      </div>
    );
  }
  const r = query.data;
  const finished = r.status === "resolved" || r.status === "closed";

  return (
    <div>
      {back}
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge status={r.status} />
          <span className="font-mono text-xs text-ink-subtle">{r.code}</span>
        </div>
        <h1 className="mt-2 text-[22px] leading-tight font-semibold tracking-[-0.015em] text-ink">{r.title}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Aberta {formatDateTime(r.created_at)}
          {r.requester_name ? ` por ${r.requester_name}` : ""}
        </p>
      </div>

      {finished && r.report_url ? (
        <Card className="mb-4 flex flex-col gap-3 border-emerald-200 bg-emerald-50/60 p-4 sm:flex-row sm:items-center dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <FileText className="size-5 shrink-0 text-emerald-700 dark:text-emerald-300" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">Atendimento concluído</p>
            {r.resolution_notes ? <p className="mt-0.5 text-sm text-ink-muted">{r.resolution_notes}</p> : null}
          </div>
          <a
            href={r.report_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
          >
            Ver relatório da visita
            <ExternalLink className="size-4" />
          </a>
        </Card>
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
                {r.scheduled_start ? formatDateTime(r.scheduled_start) : finished ? "—" : "A combinar com a central"}
              </Info>
              <Info icon={UserRound} label="Técnico">
                {r.technician ?? (finished ? "—" : "A central está escolhendo")}
              </Info>
              <Info icon={Phone} label="Quem recebe o técnico">
                {r.contact ?? "—"}
              </Info>
            </div>
            {r.client_reference ? <p className="mt-4 text-xs text-ink-muted">Nº do chamado de vocês: {r.client_reference}</p> : null}
          </Card>

          <Card className="p-5">
            <p className="mb-2 text-xs font-medium text-ink-muted">O que aconteceu</p>
            <p className="text-sm leading-relaxed whitespace-pre-line text-ink">{r.description || r.title}</p>
          </Card>

          {r.can_cancel ? (
            <div>
              <Button variant="ghost" onClick={() => setCancelling(true)}>
                <XCircle className="size-4" />
                Cancelar solicitação
              </Button>
            </div>
          ) : null}
        </div>

        <Card className="h-fit p-5">
          <p className="mb-3 text-xs font-medium text-ink-muted">Andamento</p>
          <ol className="relative flex flex-col gap-4">
            {r.timeline.map((entry, i) => {
              const last = i === r.timeline.length - 1;
              const color = entry.status === "created" ? "#64748b" : clientStatusColor(entry.status);
              return (
                <li key={`${entry.status}-${entry.at}`} className="relative flex gap-3">
                  {!last ? <span className="absolute top-3 left-[5px] h-[calc(100%+4px)] w-px bg-line" aria-hidden /> : null}
                  <span
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
