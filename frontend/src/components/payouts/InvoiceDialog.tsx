"use client";

import clsx from "clsx";
import { Check, CheckCircle2, ExternalLink, FileText, MessageCircle, RotateCcw, X, XCircle } from "lucide-react";
import { useState } from "react";
import { isPlainClick, TicketLink } from "@/components/ticket/TicketLink";
import { Button, buttonClassName, Dialog, Field, Pill, SectionTitle, Textarea } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { INVOICE_FILE_KIND, INVOICE_LIMITS, INVOICE_STATUS, PAYOUT_STATUS } from "@/lib/constants";
import { formatBytes, formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { competenceTitle, invoiceDifference, invoiceNo, type InvoiceReview, rejectedInvoiceText } from "@/lib/invoices";
import type { InvoicePayoutRef, TechnicianInvoice } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";

const NEUTRAL = "#64748b";
const REJECT_MIN = 3;

function Meta({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx("min-w-0 bg-surface px-3.5 py-2.5", className)}>
      <dt className="text-[11px] font-semibold text-ink-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-ink tabular-nums">{children}</dd>
    </div>
  );
}

/** O valor da OS no fechamento: pago, a pagar (OS concluída) ou previsto (a OS voltou a ficar aberta). */
function PayoutPill({ payout }: { payout: InvoicePayoutRef }) {
  if (payout.status === "paid") return <Pill color={PAYOUT_STATUS.paid.color}>{PAYOUT_STATUS.paid.label}</Pill>;
  if (payout.concluded) return <Pill color={PAYOUT_STATUS.pending.color}>{PAYOUT_STATUS.pending.label}</Pill>;
  return <Pill color={NEUTRAL}>Previsto</Pill>;
}

/** Quem conferiu ou recusou, e quando (o motivo da recusa vem junto). */
function Review({ invoice }: { invoice: TechnicianInvoice }) {
  const who = invoice.reviewed_by ? ` por ${invoice.reviewed_by.name}` : "";
  const when = invoice.reviewed_at ? ` em ${formatDateTime(invoice.reviewed_at)}` : "";
  if (invoice.status === "checked") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-950 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-100">
        <CheckCircle2 aria-hidden className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="font-semibold">
          Conferida{who}
          <span className="font-normal">{when}</span>
        </p>
      </div>
    );
  }
  if (invoice.status === "rejected") {
    return (
      <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50/70 px-4 py-3 text-sm text-red-950 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100">
        <XCircle aria-hidden className="size-5 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0">
          <p className="font-semibold">
            Recusada{who}
            <span className="font-normal">{when}</span>
          </p>
          {invoice.reject_reason ? (
            <dl className="mt-1">
              <dt className="text-[11px] font-semibold text-red-900/75 dark:text-red-200/75">Motivo da recusa</dt>
              <dd className="break-words whitespace-pre-wrap text-red-900/90 dark:text-red-200/90">{invoice.reject_reason}</dd>
            </dl>
          ) : null}
        </div>
      </div>
    );
  }
  return null;
}

/**
 * A nota fiscal do técnico na central: valor, emissão, competência, o arquivo, a observação dele e as OS
 * que a nota cobre (com a soma e a diferença para o valor da nota). Com Editar: conferir, recusar com
 * motivo (a recusa é final e solta as OS) ou desfazer a conferência; recusada, o aviso vai pelo WhatsApp.
 */
export function InvoiceDialog({
  invoice,
  startRejecting = false,
  canEdit,
  phone,
  review,
  onOpenFile,
  onClose,
}: {
  invoice: TechnicianInvoice;
  /** Aberto pelo "Recusar" da lista: já no motivo. */
  startRejecting?: boolean;
  canEdit: boolean;
  /** Telefone do técnico (cadastro), para o "Avisar no WhatsApp" da nota recusada. */
  phone: string | null;
  review: InvoiceReview;
  onOpenFile: (invoice: TechnicianInvoice) => void;
  onClose: () => void;
}) {
  const [rejecting, setRejecting] = useState(startRejecting);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const status = INVOICE_STATUS[invoice.status];
  const pending = invoice.status === "pending";
  // Só a que aguarda conferência pode ser recusada: se ela mudou por fora (outra pessoa conferiu), o motivo sai.
  const askingReason = canEdit && rejecting && pending;
  const difference = invoiceDifference(invoice);
  const checking = review.check.isPending && review.check.variables?.id === invoice.id;
  const unchecking = review.uncheck.isPending && review.uncheck.variables?.id === invoice.id;
  const sending = review.reject.isPending;

  const stopRejecting = () => {
    setRejecting(false);
    setReason("");
    setReasonError(null);
  };
  const submitReject = () => {
    const text = reason.trim();
    if (text.length < REJECT_MIN) {
      setReasonError(text ? `Escreva o motivo com pelo menos ${REJECT_MIN} caracteres` : "Informe o motivo da recusa");
      return;
    }
    review.reject.mutate({ invoice, reason: text }, { onSuccess: stopRejecting, onError: (error) => setReasonError(errorMessage(error)) });
  };

  let footer: React.ReactNode = null;
  if (askingReason) {
    footer = (
      <>
        <Button disabled={sending} onClick={stopRejecting}>
          Voltar
        </Button>
        <Button variant="danger" loading={sending} onClick={submitReject}>
          Recusar nota
        </Button>
      </>
    );
  } else if (canEdit && pending) {
    footer = (
      <>
        <Button disabled={checking} onClick={() => setRejecting(true)}>
          <X className="size-4" />
          Recusar
        </Button>
        {/* Conferida, a nota sai do "A conferir": o diálogo fecha para seguir para a próxima. */}
        <Button variant="primary" loading={checking} onClick={() => review.check.mutate(invoice, { onSuccess: onClose })}>
          {checking ? null : <Check className="size-4" />}
          Conferir
        </Button>
      </>
    );
  } else if (canEdit && invoice.status === "checked") {
    footer = (
      <Button loading={unchecking} onClick={() => review.uncheck.mutate(invoice)}>
        {unchecking ? null : <RotateCcw className="size-4" />}
        Desfazer conferência
      </Button>
    );
  } else if (canEdit && invoice.status === "rejected" && phone) {
    footer = (
      <a
        href={whatsappUrl(phone, rejectedInvoiceText(invoice))}
        target="_blank"
        rel="noreferrer"
        className={buttonClassName("primary")}
        title={`Avisar ${invoice.technician.name} da recusa no WhatsApp`}
      >
        <MessageCircle className="size-4" />
        Avisar no WhatsApp
      </a>
    );
  }

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dirty={askingReason && reason.trim() !== ""}
      busy={sending}
      title={`Nota ${invoiceNo(invoice)} · ${invoice.technician.name}`}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <Pill color={status.color}>{status.label}</Pill>
          <span>enviada em {formatDateTime(invoice.created_at)}</span>
        </span>
      }
      footer={footer}
    >
      <div className="flex flex-col gap-5">
        {askingReason ? (
          <Field label="Motivo da recusa" required error={reasonError}>
            <Textarea
              autoFocus
              rows={3}
              maxLength={INVOICE_LIMITS.rejectMax}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setReasonError(null);
              }}
              aria-invalid={reasonError ? true : undefined}
            />
          </Field>
        ) : null}

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          <Meta label="Valor">{formatMoney(invoice.amount)}</Meta>
          <Meta label="Emissão">{formatDate(invoice.issue_date)}</Meta>
          <Meta label="Competência" className="col-span-2 sm:col-span-1">
            {competenceTitle(invoice.competence)}
          </Meta>
        </dl>

        <Review invoice={invoice} />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line px-3.5 py-3">
          <FileText aria-hidden className="size-5 shrink-0 text-ink-subtle" />
          <div className="min-w-0 flex-1 basis-40">
            <p className="text-[11px] font-semibold text-ink-muted">Arquivo</p>
            <p className="truncate text-sm font-medium text-ink" title={invoice.filename}>
              {invoice.filename}
            </p>
            <p className="text-xs text-ink-muted">
              {INVOICE_FILE_KIND[invoice.file_kind]} · {formatBytes(invoice.size_bytes)}
            </p>
          </div>
          <Button size="sm" onClick={() => onOpenFile(invoice)}>
            <ExternalLink className="size-4" />
            Abrir arquivo
          </Button>
        </div>

        {invoice.note ? (
          <dl>
            <dt className="text-[11px] font-semibold text-ink-muted">Observação do técnico</dt>
            <dd className="mt-0.5 text-sm break-words whitespace-pre-wrap text-ink">{invoice.note}</dd>
          </dl>
        ) : null}

        <section aria-label="OS desta nota" className="flex flex-col gap-2">
          <SectionTitle aside={invoice.payouts.length ? <span className="text-xs text-ink-muted">{invoice.payouts.length} OS</span> : null}>
            OS desta nota
          </SectionTitle>
          {invoice.payouts.length ? (
            <>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {invoice.payouts.map((payout) => (
                  <li key={payout.payout_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 sm:flex-nowrap">
                    <p className="min-w-0 flex-1 basis-48 truncate text-sm font-semibold text-ink" title={payout.title}>
                      {askingReason ? (
                        // Escrevendo o motivo: o código fica só como texto (abrir a OS fecharia o diálogo).
                        <span className="mr-1.5 font-mono text-xs font-normal text-ink-subtle">{payout.code}</span>
                      ) : (
                        // Abre a OS no painel lateral (Ctrl+clique abre a página); a nota fecha para dar lugar a ela.
                        <span
                          onClickCapture={(e) => {
                            if (isPlainClick(e)) onClose();
                          }}
                        >
                          <TicketLink
                            ticketId={payout.ticket_id}
                            className="mr-1.5 font-mono text-xs font-normal text-ink-subtle hover:text-brand hover:underline"
                          >
                            {payout.code}
                          </TicketLink>
                        </span>
                      )}
                      {payout.title}
                    </p>
                    <span className="flex items-center gap-3">
                      <PayoutPill payout={payout} />
                      <span className="w-24 text-right text-sm font-medium text-ink tabular-nums">{formatMoney(payout.amount)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                <p className="text-ink-muted">
                  Soma das OS: <span className="font-semibold text-ink tabular-nums">{formatMoney(invoice.payouts_total)}</span>
                </p>
                {difference ? (
                  <p className="font-medium text-amber-700 dark:text-amber-400">Diferença de {formatMoney(difference)} para o valor da nota</p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-sm text-ink-muted">
              Nenhuma OS ligada a esta nota.
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
