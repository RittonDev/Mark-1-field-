"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowLeft,
  CalendarClock,
  CircleAlert,
  ExternalLink,
  FileImage,
  FileText,
  MapPinCheck,
  Paperclip,
  Phone,
  Plus,
  Store,
  UserRound,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/portal/Badge";
import { useToast } from "@/components/Toaster";
import {
  Button,
  buttonClassName,
  Card,
  Dialog,
  ErrorBox,
  Field,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  Spinner,
  Textarea,
} from "@/components/ui";
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

const FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** O que a API recusa, avisado antes de enviar (a foto do iPhone, em HEIC, não é aceita). */
function fileProblem(file: File): string | null {
  const okType = file.type ? FILE_TYPES.includes(file.type) : /\.(jpe?g|png|webp|pdf)$/i.test(file.name);
  if (!okType) return `${file.name}: envie uma foto (JPG, PNG ou WebP) ou um PDF. A foto do iPhone (HEIC) precisa ser convertida antes.`;
  if (file.size > MAX_FILE_BYTES) return `${file.name}: arquivo maior que 10 MB.`;
  return null;
}

/**
 * Fotos do problema e PDFs que a empresa mandou (antes iam soltos pelo WhatsApp): viram anexos da OS,
 * que a central e o técnico veem. Aqui aparecem só o nome e a data; com a solicitação em aberto, dá
 * para mandar mais.
 */
function ClientFiles({ request }: { request: PortalRequestDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const files = request.attachments ?? [];
  if (!files.length && !request.can_attach) return null;

  const send = async (picked: File[]) => {
    const problem = picked.map(fileProblem).find(Boolean) ?? null;
    setError(problem);
    if (problem || !picked.length) return;
    setSending({ done: 0, total: picked.length });
    try {
      // Um por vez: cada resposta já traz a lista atualizada (e o limite por solicitação).
      for (const [i, file] of picked.entries()) {
        const body = new FormData();
        body.append("file", file);
        const data = await api.upload<PortalRequestDetail>(`/portal/requests/${request.id}/attachments`, body);
        queryClient.setQueryData(["portal", "request", request.id], data);
        setSending({ done: i + 1, total: picked.length });
      }
      toast({ title: picked.length === 1 ? "Arquivo enviado" : `${picked.length} arquivos enviados`, tone: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(null);
    }
  };

  return (
    <Card className="p-5">
      <SectionTitle as="h2">Fotos e arquivos</SectionTitle>
      <p className="mt-1 mb-3 text-xs text-ink-muted">
        {request.can_attach
          ? "Fotos do problema (JPG, PNG ou WebP) ou PDF, até 10 MB cada. A central e o técnico recebem."
          : "Enviados pela sua empresa nesta solicitação."}
      </p>
      {files.length ? (
        <ul className="mb-3 divide-y divide-line">
          {files.map((f) => {
            const Icon = /\.pdf$/i.test(f.filename) ? FileText : FileImage;
            return (
              <li key={f.id} className="flex items-center gap-2.5 py-2 text-sm first:pt-0 last:pb-0">
                <Icon aria-hidden className="size-4 shrink-0 text-ink-subtle" />
                <span className="min-w-0 flex-1 truncate text-ink" title={f.filename}>
                  {f.filename}
                </span>
                <span className="shrink-0 text-xs text-ink-subtle">{formatDateTime(f.created_at)}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {request.can_attach ? (
        <label
          className={buttonClassName(
            "secondary",
            "md",
            clsx(
              "cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface",
              sending && "pointer-events-none opacity-60",
            ),
          )}
        >
          {sending ? <Spinner className="size-4" /> : <Paperclip aria-hidden className="size-4" />}
          {sending
            ? sending.total > 1
              ? `Enviando ${Math.min(sending.done + 1, sending.total)} de ${sending.total}...`
              : "Enviando..."
            : "Enviar foto ou PDF"}
          <input
            type="file"
            multiple
            accept={FILE_TYPES.join(",")}
            className="sr-only"
            disabled={sending !== null}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              void send(picked);
            }}
          />
        </label>
      ) : null}
      {error ? (
        <div className="mt-3">
          <ErrorBox message={error} />
        </div>
      ) : null}
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

          <ClientFiles request={r} />

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
