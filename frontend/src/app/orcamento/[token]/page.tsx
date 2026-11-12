"use client";

import clsx from "clsx";
import { CheckCircle2, Download, FileWarning, MapPin, MessageSquareText, PenLine, XCircle } from "lucide-react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { SignaturePad } from "@/components/SignaturePad";
import { Button, ErrorBox, Input, Skeleton, Textarea } from "@/components/ui";
import { ApiError, errorMessage, request } from "@/lib/api";
import { formatDate, formatDateTime, formatDocument, formatMoney, initials } from "@/lib/format";
import { QUOTE_KIND, QUOTE_STATUS, totalsByKind } from "@/lib/quotes";
import type { PublicQuote, QuoteStatus } from "@/lib/types";

const BANNER: Record<QuoteStatus, { label: string; className: string }> = {
  draft: { label: "Rascunho", className: "bg-slate-500" },
  sent: { label: "Aguardando sua aprovação", className: "bg-brand" },
  approved: { label: "Aprovado", className: "bg-emerald-500" },
  rejected: { label: "Recusado", className: "bg-red-500" },
  expired: { label: "Vencido", className: "bg-amber-500" },
  cancelled: { label: "Cancelado", className: "bg-slate-500" },
};

const COMMENT_MAX = 2000;

function Box({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-xl border border-line bg-surface p-4 print:break-inside-avoid", className)}>
      {title ? <p className="mb-2 text-xs font-medium text-ink-subtle">{title}</p> : null}
      {children}
    </div>
  );
}

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <h2 className="text-sm font-semibold text-ink">{children}</h2>
      {aside}
    </div>
  );
}

function QuoteSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-elev-2">
      <div className="flex justify-between p-8">
        <div className="flex gap-4">
          <Skeleton className="size-14 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <Skeleton className="h-10 w-32" />
      </div>
      <Skeleton className="h-10 rounded-none" />
      <div className="grid gap-4 p-8 md:grid-cols-2">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    </div>
  );
}

export default function PublicQuotePage() {
  const { token } = useParams<{ token: string }>();
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [mode, setMode] = useState<"approve" | "reject">("approve");
  const [name, setName] = useState("");
  const [registration, setRegistration] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/public/quotes/${encodeURIComponent(token)}`;

  useEffect(() => {
    request<PublicQuote>(path, { auth: false })
      .then(setQuote)
      .catch((e) =>
        setGone(
          e instanceof ApiError && (e.status === 410 || e.status === 404)
            ? errorMessage(e)
            : "Não foi possível abrir o orçamento. Verifique a conexão e tente de novo.",
        ),
      );
  }, [path]);

  async function decide(kind: "approve" | "reject") {
    setError(null);
    if (kind === "approve") {
      if (name.trim().length < 3) return setError("Informe seu nome completo.");
      if (!signature) return setError("Assine no quadro para aprovar.");
    } else if (reason.trim().length < 3) {
      return setError("Conte o motivo da recusa.");
    }
    setSending(true);
    try {
      const body =
        kind === "approve"
          ? {
              name: name.trim(),
              registration: registration.trim() || null,
              signature,
              comment: comment.trim() || null,
              accept: true,
            }
          : { name: name.trim() || null, reason: reason.trim(), comment: comment.trim() || null };
      setQuote(await request<PublicQuote>(`${path}/${kind}`, { method: "POST", body, auth: false }));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  const savePdf = () => {
    if (!quote) return;
    const previous = document.title;
    document.title = `Orcamento-${quote.code}`;
    window.print();
    document.title = previous;
  };

  const company = quote?.company;
  const customer = quote?.customer_info ?? (quote?.customer ? { name: quote.customer, document: null, email: null, phone: null } : null);
  const totals = quote ? totalsByKind(quote.items, quote.totals_by_kind) : null;
  const open = quote?.status === "sent";

  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 pt-6 print:hidden">
        <Logo />
        <div className="flex items-center gap-2">
          {quote ? (
            <Button onClick={savePdf}>
              <Download className="size-4" />
              Baixar PDF
            </Button>
          ) : null}
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 print:max-w-none print:p-0">
        {gone ? (
          <div className="mx-auto flex max-w-md animate-rise flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-6 py-12 text-center shadow-elev-2">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400">
              <FileWarning className="size-6" />
            </span>
            <p className="text-base font-semibold text-ink">Orçamento indisponível</p>
            <p className="text-sm text-ink-muted">{gone}</p>
          </div>
        ) : !quote ? (
          <QuoteSkeleton />
        ) : (
          <article className="animate-rise overflow-hidden rounded-2xl border border-line bg-surface shadow-elev-2 print:rounded-none print:border-0 print:shadow-none">
            {/* Empresa e números */}
            <div className="flex flex-wrap items-start justify-between gap-6 px-6 py-6 sm:px-8">
              <div className="flex min-w-0 items-start gap-4">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-line bg-white">
                  <Image src="/brand/maxxfield-mark.png" alt="" width={36} height={18} />
                </span>
                <div className="min-w-0 text-xs leading-relaxed text-ink-muted">
                  <p className="text-base font-semibold text-ink">{company?.name ?? "Maxx Field"}</p>
                  {company?.document ? <p>CNPJ: {formatDocument(company.document)}</p> : null}
                  {company?.email ? <p>E-mail: {company.email}</p> : null}
                  {company?.phone ? <p>Telefone: {company.phone}</p> : null}
                  {company?.address ? <p>Endereço: {company.address}</p> : null}
                </div>
              </div>
              <dl className="grid grid-cols-[auto_auto] items-baseline gap-x-3 gap-y-1 text-right">
                <dt className="text-sm text-ink-subtle">OS</dt>
                <dd className="font-mono text-lg font-semibold text-ink">{quote.ticket_number ?? quote.ticket_code}</dd>
                <dt className="text-sm text-ink-subtle">Orçamento</dt>
                <dd className="font-mono text-lg font-semibold text-ink">{quote.code}</dd>
              </dl>
            </div>

            <div className={clsx("py-2.5 text-center text-sm font-semibold tracking-wide text-white", BANNER[quote.status].className)}>
              {BANNER[quote.status].label}
            </div>

            {/* Dados do orçamento */}
            <section className="px-6 py-6 sm:px-8">
              <SectionTitle
                aside={
                  <dl className="grid grid-cols-[auto_auto] gap-x-2 text-right text-[11px] text-ink-muted">
                    <dt className="font-semibold text-ink">Data de emissão:</dt>
                    <dd className="tabular-nums">{formatDate(quote.issued_at ?? quote.sent_at)}</dd>
                    {quote.valid_until ? (
                      <>
                        <dt className="font-semibold text-ink">Data de vencimento:</dt>
                        <dd className="tabular-nums">{formatDate(quote.valid_until)}</dd>
                      </>
                    ) : null}
                  </dl>
                }
              >
                Dados do orçamento
              </SectionTitle>
              <div className="grid gap-4 md:grid-cols-2">
                <Box>
                  <div className="flex items-start gap-3">
                    <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-base font-semibold text-brand-ink">
                      {initials(customer?.name ?? quote.location ?? "?")}
                    </span>
                    <div className="min-w-0 text-xs leading-relaxed text-ink-muted">
                      <p className="text-sm font-semibold text-ink">
                        {customer?.name ?? "—"}
                        {quote.location ? <span className="font-normal text-ink-muted"> · {quote.location}</span> : null}
                      </p>
                      {customer?.document ? <p>CPF/CNPJ: {formatDocument(customer.document)}</p> : null}
                      {customer?.email ? <p>E-mail: {customer.email}</p> : null}
                      {customer?.phone ? <p>Telefone: {customer.phone}</p> : null}
                    </div>
                  </div>
                </Box>
                <Box title="Endereço">
                  <p className="flex items-start gap-1.5 text-sm text-ink">
                    <MapPin className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
                    {quote.address?.full ?? quote.location ?? "—"}
                  </p>
                </Box>
              </div>
              <Box title="Nome do orçamento" className="mt-4">
                <p className="text-sm font-medium text-ink">{quote.title}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  Referente à OS {quote.ticket_code} · {quote.ticket_title}
                </p>
              </Box>
            </section>

            {/* Itens */}
            <section className="border-t border-line px-6 py-6 sm:px-8">
              <SectionTitle>Itens</SectionTitle>
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="bg-surface-2/70 text-left text-[11px] font-semibold tracking-[0.05em] text-ink-subtle uppercase">
                    <tr>
                      <th className="px-4 py-2.5">Nome</th>
                      <th className="px-4 py-2.5">Tipo</th>
                      <th className="px-4 py-2.5">Medida</th>
                      <th className="px-4 py-2.5 text-right">Quantidade</th>
                      <th className="px-4 py-2.5 text-right">Valor unitário</th>
                      <th className="px-4 py-2.5 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {quote.items.map((item, i) => (
                      <tr key={i} className="print:break-inside-avoid">
                        <td className="px-4 py-3 text-ink">{item.description}</td>
                        <td className="px-4 py-3 text-ink-muted">{QUOTE_KIND[item.kind ?? "product"].label}</td>
                        <td className="px-4 py-3 text-ink-muted">{item.unit}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{item.quantity.toLocaleString("pt-BR")}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{formatMoney(item.unit_price)}</td>
                        <td className="px-4 py-3 text-right font-medium tabular-nums">{formatMoney(item.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Resumo */}
            <section className="border-t border-line px-6 py-6 sm:px-8 print:break-inside-avoid">
              <SectionTitle>Resumo do orçamento</SectionTitle>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
                {[
                  { label: "Total em produtos", value: totals?.product ?? 0 },
                  { label: "Total em serviços", value: totals?.service ?? 0 },
                  { label: "Total em despesas", value: totals?.expense ?? 0 },
                  { label: "Subtotal", value: quote.subtotal },
                  { label: "Descontos", value: quote.discount },
                ].map((cell) => (
                  <div key={cell.label} className="bg-surface px-4 py-3">
                    <p className="text-[11px] text-ink-subtle">{cell.label}</p>
                    <p className="mt-1 text-sm font-medium text-ink tabular-nums">{formatMoney(cell.value)}</p>
                  </div>
                ))}
                <div className="bg-brand-soft px-4 py-3">
                  <p className="text-[11px] font-medium text-brand-ink">Valor total</p>
                  <p className="mt-1 text-base font-semibold text-ink tabular-nums">{formatMoney(quote.total)}</p>
                </div>
              </div>
              {quote.notes ? (
                <Box title="Condições" className="mt-4">
                  <p className="text-sm whitespace-pre-wrap text-ink">{quote.notes}</p>
                </Box>
              ) : null}
            </section>

            {/* Resposta do cliente */}
            <section className="border-t border-line px-6 py-6 sm:px-8 print:break-inside-avoid">
              <SectionTitle>{open ? "Responder orçamento" : "Resposta do cliente"}</SectionTitle>

              {quote.status === "approved" ? (
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="overflow-hidden rounded-xl border border-line">
                    <div className="flex h-40 items-center justify-center bg-white">
                      {quote.signature_url ? (
                        // Assinatura servida pela API com link assinado.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={quote.signature_url} alt={`Assinatura de ${quote.approver_name ?? "cliente"}`} className="max-h-36 w-auto" />
                      ) : (
                        <PenLine className="size-6 text-slate-300" />
                      )}
                    </div>
                    <div className="border-t border-line px-4 py-3">
                      <p className="text-sm font-semibold text-ink uppercase">{quote.approver_name}</p>
                      {quote.approver_registration ? (
                        <p className="text-xs text-ink-muted">Matrícula: {quote.approver_registration}</p>
                      ) : null}
                      <p className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="size-3.5" />
                        Aprovado em {formatDateTime(quote.decided_at)}
                      </p>
                    </div>
                  </div>
                  <Box title="Comentário para a empresa">
                    <p className="text-sm whitespace-pre-wrap text-ink">
                      {quote.client_comment || <span className="text-ink-subtle">Sem comentário.</span>}
                    </p>
                  </Box>
                </div>
              ) : quote.status === "rejected" ? (
                <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
                  <XCircle className="mt-0.5 size-5 shrink-0" />
                  <div>
                    <p className="font-semibold">
                      Recusado{quote.approver_name ? ` por ${quote.approver_name}` : ""} em {formatDateTime(quote.decided_at)}
                    </p>
                    <p className="mt-1">{quote.rejection_reason}</p>
                    {quote.client_comment ? <p className="mt-2 text-red-700/80 dark:text-red-200/80">{quote.client_comment}</p> : null}
                  </div>
                </div>
              ) : !open ? (
                <p className="text-sm text-ink-muted">
                  Este orçamento não aceita mais resposta ({QUOTE_STATUS[quote.status].label.toLowerCase()}).
                </p>
              ) : (
                <div className="print:hidden">
                  <div className="mb-4 inline-flex rounded-lg bg-surface-3/70 p-0.5 text-[13px]">
                    {(["approve", "reject"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setMode(m);
                          setError(null);
                        }}
                        className={clsx(
                          "h-8 rounded-md px-4 transition-colors",
                          mode === m ? "bg-surface font-medium text-ink shadow-elev-1 ring-1 ring-line" : "text-ink-muted hover:text-ink",
                        )}
                      >
                        {m === "approve" ? "Aprovar" : "Recusar"}
                      </button>
                    ))}
                  </div>

                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    {mode === "approve" ? (
                      <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
                        <SignaturePad onChange={setSignature} />
                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-ink-muted">
                              Nome completo <span className="text-red-500">*</span>
                            </span>
                            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-ink-muted">Matrícula (opcional)</span>
                            <Input value={registration} onChange={(e) => setRegistration(e.target.value)} maxLength={40} />
                          </label>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-ink-muted">
                            Motivo da recusa <span className="text-red-500">*</span>
                          </span>
                          <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-ink-muted">Seu nome</span>
                          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                        </label>
                      </div>
                    )}
                    <label className="flex flex-col rounded-xl border border-line p-4">
                      <span className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted">
                        <MessageSquareText className="size-3.5" />
                        Comentário para a empresa (opcional)
                      </span>
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value.slice(0, COMMENT_MAX))}
                        placeholder="Escreva aqui uma mensagem sobre este orçamento."
                        className="min-h-32 flex-1 resize-none bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
                      />
                      <span className="mt-2 self-end text-[11px] text-ink-subtle tabular-nums">
                        {comment.length}/{COMMENT_MAX}
                      </span>
                    </label>
                  </div>

                  {error ? (
                    <div className="mt-4">
                      <ErrorBox message={error} />
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-ink-muted">
                      {mode === "approve"
                        ? `Ao aprovar, você concorda com os itens, valores e condições do orçamento ${quote.code} (${formatMoney(quote.total)}).`
                        : "A recusa fica registrada e nossa equipe é avisada na hora."}
                    </p>
                    {mode === "approve" ? (
                      <Button variant="primary" size="lg" loading={sending} onClick={() => decide("approve")}>
                        <CheckCircle2 className="size-4" />
                        Aprovar orçamento
                      </Button>
                    ) : (
                      <Button variant="danger" size="lg" loading={sending} onClick={() => decide("reject")}>
                        <XCircle className="size-4" />
                        Recusar orçamento
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </section>

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-2/60 px-6 py-4 text-[11px] text-ink-subtle sm:px-8">
              <span>Aprovação eletrônica com registro de data, hora e assinatura · {company?.name ?? "Maxx Field"}</span>
              <span className="font-mono">{quote.code}</span>
            </footer>
          </article>
        )}
      </main>
    </div>
  );
}
