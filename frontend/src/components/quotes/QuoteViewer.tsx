"use client";

import clsx from "clsx";
import { CalendarClock, CheckCircle2, Clock, ExternalLink, FileText, Pencil, Send, Share2, XCircle } from "lucide-react";
import Link from "next/link";
import { Button, Dialog } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { absoluteApiUrl } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { QUOTE_KIND, QUOTE_STATUS, totalsByKind } from "@/lib/quotes";
import type { Quote, QuoteItemKind, QuoteStatus, UUID } from "@/lib/types";

/** Situações em que o orçamento ainda pode ser alterado (o mesmo do backend). */
export const QUOTE_EDITABLE: QuoteStatus[] = ["draft", "sent", "expired"];

const KIND_STYLE: Record<QuoteItemKind, string> = {
  product: "bg-brand-soft text-brand-ink dark:bg-brand/15 dark:text-[#a9b8ff]",
  service: "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300",
  expense: "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
};

const qty = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });

function Meta({ label, children, tone }: { label: string; children: React.ReactNode; tone?: "danger" }) {
  return (
    <div className="min-w-0 bg-surface px-3.5 py-2.5">
      <dt className="text-[11px] font-medium text-ink-subtle">{label}</dt>
      <dd className={clsx("mt-0.5 truncate text-sm font-medium", tone === "danger" ? "text-red-600 dark:text-red-400" : "text-ink")}>
        {children}
      </dd>
    </div>
  );
}

/** A situação do orçamento em destaque: quem aprovou (com a assinatura), por que recusou, desde quando espera. */
function Decision({ quote, expiredByDate }: { quote: Quote; expiredByDate: boolean }) {
  if (quote.status === "approved") {
    const details = [
      quote.approver_registration ? `Matrícula ${quote.approver_registration}` : null,
      quote.approver_role,
      quote.approver_document ? `Doc. ${quote.approver_document}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 sm:flex-row sm:items-center dark:border-emerald-500/25 dark:bg-emerald-500/10">
        <CheckCircle2 className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0 flex-1 text-sm text-emerald-950 dark:text-emerald-100">
          <p className="font-semibold">
            Aprovado por {quote.approver_name ?? "cliente"}
            {quote.decided_at ? <span className="font-normal"> em {formatDateTime(quote.decided_at)}</span> : null}
          </p>
          {details ? <p className="mt-0.5 text-xs text-emerald-900/75 dark:text-emerald-200/75">{details}</p> : null}
          {quote.client_comment ? (
            <p className="mt-2 border-l-2 border-emerald-300 pl-2.5 text-xs text-emerald-900/85 italic dark:border-emerald-500/40 dark:text-emerald-200/85">
              “{quote.client_comment}”
            </p>
          ) : null}
        </div>
        {quote.signature_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
          <img
            src={absoluteApiUrl(quote.signature_url) ?? undefined}
            alt={`Assinatura de ${quote.approver_name ?? "cliente"}`}
            className="h-16 w-40 shrink-0 rounded-lg border border-emerald-200 bg-white object-contain p-1 dark:border-emerald-500/30"
          />
        ) : null}
      </div>
    );
  }
  if (quote.status === "rejected") {
    return (
      <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50/70 p-4 dark:border-red-500/25 dark:bg-red-500/10">
        <XCircle className="size-5 shrink-0 text-red-600 dark:text-red-400" />
        <div className="text-sm text-red-950 dark:text-red-100">
          <p className="font-semibold">
            Recusado{quote.approver_name ? ` por ${quote.approver_name}` : ""}
            {quote.decided_at ? <span className="font-normal"> em {formatDateTime(quote.decided_at)}</span> : null}
          </p>
          {quote.rejection_reason ? <p className="mt-1 text-red-900/80 dark:text-red-200/80">{quote.rejection_reason}</p> : null}
        </div>
      </div>
    );
  }
  if (quote.status === "expired" || expiredByDate) {
    return (
      <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-sm text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
        <CalendarClock className="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <p>
          <span className="font-semibold">Venceu{quote.valid_until ? ` em ${formatDate(quote.valid_until)}` : ""} sem resposta.</span>{" "}
          Ajuste a validade e envie de novo para o cliente.
        </p>
      </div>
    );
  }
  if (quote.status === "sent") {
    return (
      <div className="flex gap-3 rounded-xl border border-sky-200 bg-sky-50/70 p-4 text-sm text-sky-950 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-100">
        <Clock className="size-5 shrink-0 text-sky-600 dark:text-sky-400" />
        <p>
          <span className="font-semibold">Aguardando o cliente</span>
          {quote.sent_at ? ` desde ${formatDateTime(quote.sent_at)}` : ""}. Ele aprova pelo link, com nome e assinatura.
        </p>
      </div>
    );
  }
  if (quote.status === "draft") {
    return (
      <div className="flex gap-3 rounded-xl border border-line bg-surface-2 p-4 text-sm text-ink-muted">
        <FileText className="size-5 shrink-0 text-ink-subtle" />
        <p>
          <span className="font-semibold text-ink">Rascunho.</span> O cliente só vê depois do envio (se já tinha o link, ele
          mostra que o orçamento está em revisão).
        </p>
      </div>
    );
  }
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-surface-2 p-4 text-sm text-ink-muted">
      <XCircle className="size-5 shrink-0 text-ink-subtle" />
      <p>Orçamento cancelado: o link do cliente não abre mais.</p>
    </div>
  );
}

/** Visualização do orçamento como documento: dados, situação, itens por tipo, totais e condições. */
export function QuoteViewer({
  quote,
  ticket,
  onClose,
  onEdit,
  onSend,
  onShare,
  sending = false,
}: {
  quote: Quote;
  /** OS do orçamento (mostra o link para ela e o cliente). */
  ticket?: { id: UUID; code: string; customer?: string | null } | null;
  onClose: () => void;
  onEdit?: () => void;
  /** Envia (ou gera o link de um enviado sem link) e abre o compartilhamento. */
  onSend?: () => void;
  onShare?: () => void;
  sending?: boolean;
}) {
  const now = useNow(60_000);
  const status = QUOTE_STATUS[quote.status];
  const totals = totalsByKind(quote.items, quote.totals_by_kind);
  const kinds = (Object.keys(QUOTE_KIND) as QuoteItemKind[]).filter((k) => quote.items.some((i) => (i.kind ?? "product") === k));
  const editable = QUOTE_EDITABLE.includes(quote.status);
  const local = new Date(now);
  const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
  const expiredByDate = quote.status === "sent" && Boolean(quote.valid_until && quote.valid_until < today);
  const clientPath = quote.status !== "cancelled" ? (quote.link?.path ?? null) : null;
  const needsSend = quote.status === "draft" || quote.status === "expired" || (quote.status === "sent" && !quote.link);

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={quote.title}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{quote.code}</span>
          <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium", status.className)}>{status.label}</span>
        </span>
      }
      footer={
        <>
          {clientPath ? (
            <a
              href={clientPath}
              target="_blank"
              rel="noreferrer"
              className="mr-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-ink-muted transition-colors hover:bg-ink/[0.05] hover:text-ink"
            >
              <ExternalLink className="size-4" />
              Ver como o cliente
            </a>
          ) : null}
          {editable && onEdit ? (
            <Button onClick={onEdit}>
              <Pencil className="size-4" />
              Editar
            </Button>
          ) : null}
          {editable && needsSend && onSend ? (
            <Button variant="primary" loading={sending} onClick={onSend}>
              {sending ? null : <Send className="size-4" />}
              {quote.status === "sent" ? "Gerar link" : quote.status === "draft" ? "Enviar ao cliente" : "Reenviar"}
            </Button>
          ) : quote.status === "sent" && onShare ? (
            <Button variant="primary" onClick={onShare}>
              <Share2 className="size-4" />
              Link do cliente
            </Button>
          ) : (
            <Button variant="primary" onClick={onClose}>
              Fechar
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
          <Meta label="OS">
            {ticket ? (
              <Link href={`/chamados/${ticket.id}`} className="font-mono text-brand hover:underline">
                {ticket.code}
              </Link>
            ) : (
              "—"
            )}
          </Meta>
          <Meta label="Cliente">{ticket?.customer ?? "—"}</Meta>
          <Meta label="Criado">
            {formatDate(quote.created_at)}
            {quote.created_by ? <span className="font-normal text-ink-muted"> · {quote.created_by.name.split(" ")[0]}</span> : null}
          </Meta>
          <Meta label="Validade" tone={expiredByDate ? "danger" : undefined}>
            {quote.valid_until ? formatDate(quote.valid_until) : "Sem validade"}
          </Meta>
        </dl>

        <Decision quote={quote} expiredByDate={expiredByDate} />

        {kinds.length ? (
          <div className="flex flex-col gap-4">
            {kinds.map((kind) => {
              const items = quote.items.filter((i) => (i.kind ?? "product") === kind);
              return (
                <section key={kind} aria-label={QUOTE_KIND[kind].plural}>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className={clsx("rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase", KIND_STYLE[kind])}>
                      {QUOTE_KIND[kind].plural} · {items.length}
                    </span>
                    <span className="text-xs font-medium text-ink-muted tabular-nums">{formatMoney(totals[kind])}</span>
                  </div>
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {items.map((item, index) => (
                      <li key={`${kind}-${index}`} className="flex items-start gap-4 bg-surface px-3.5 py-3">
                        <p className="min-w-0 flex-1 text-sm leading-relaxed text-ink">{item.description}</p>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-semibold text-ink tabular-nums">{formatMoney(item.total)}</p>
                          <p className="text-[11px] whitespace-nowrap text-ink-muted tabular-nums">
                            {qty(item.quantity)} {item.unit} × {formatMoney(item.unit_price)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-ink-muted">Sem itens.</p>
        )}

        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0">
            {quote.notes ? (
              <>
                <p className="text-xs font-medium text-ink-subtle">Condições</p>
                <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink-muted">{quote.notes}</p>
              </>
            ) : null}
          </div>
          <div className="rounded-xl bg-surface-2 p-4 text-sm tabular-nums">
            <div className="flex justify-between text-ink-muted">
              <span>Subtotal</span>
              <span>{formatMoney(quote.subtotal)}</span>
            </div>
            {quote.discount ? (
              <div className="mt-1 flex justify-between text-emerald-700 dark:text-emerald-400">
                <span>Desconto</span>
                <span>−{formatMoney(quote.discount)}</span>
              </div>
            ) : null}
            <div className="mt-2.5 flex items-baseline justify-between border-t border-line pt-2.5">
              <span className="text-sm font-medium text-ink">Total</span>
              <span className="text-xl font-semibold tracking-[-0.01em] text-ink">{formatMoney(quote.total)}</span>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
