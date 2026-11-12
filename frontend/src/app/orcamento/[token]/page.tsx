"use client";

import clsx from "clsx";
import { CheckCircle2, Printer, XCircle } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { SignaturePad } from "@/components/SignaturePad";
import { Button, Checkbox, ErrorBox, Field, Input, LoadingBlock, Textarea } from "@/components/ui";
import { ApiError, errorMessage, request } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { QUOTE_STATUS } from "@/lib/quotes";
import type { PublicQuote } from "@/lib/types";

export default function PublicQuotePage() {
  const { token } = useParams<{ token: string }>();
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "approve" | "reject">("view");
  const [name, setName] = useState("");
  const [document, setDocument] = useState("");
  const [role, setRole] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [accept, setAccept] = useState(false);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/public/quotes/${encodeURIComponent(token)}`;

  useEffect(() => {
    request<PublicQuote>(path, { auth: false })
      .then(setQuote)
      .catch((e) => setGone(e instanceof ApiError && e.status === 410 ? errorMessage(e) : "Não foi possível abrir o orçamento."));
  }, [path]);

  async function decide(kind: "approve" | "reject") {
    setError(null);
    if (kind === "approve") {
      if (name.trim().length < 3) return setError("Informe seu nome completo.");
      if (!signature) return setError("Assine no quadro.");
      if (!accept) return setError("Marque que está de acordo com o orçamento.");
    } else if (reason.trim().length < 3) {
      return setError("Conte o motivo da recusa.");
    }
    setSending(true);
    try {
      const body =
        kind === "approve"
          ? { name, document: document || null, role: role || null, signature, accept }
          : { name: name || null, reason };
      setQuote(await request<PublicQuote>(`${path}/${kind}`, { method: "POST", body, auth: false }));
      setMode("view");
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 pt-6 print:pt-0">
        <Logo />
        <div className="flex items-center gap-1 print:hidden">
          {quote ? (
            <button type="button" onClick={() => window.print()} className="rounded-md p-2 text-ink-muted hover:bg-surface-2 hover:text-ink" aria-label="Imprimir">
              <Printer className="size-4" />
            </button>
          ) : null}
          <ThemeToggle />
        </div>
      </header>
      <div className="brand-gradient mx-auto mt-3 h-1 max-w-3xl rounded-full" />
      <main className="mx-auto max-w-3xl px-4 py-6">
        {gone ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface px-6 py-10 text-center">
            <XCircle className="size-10 text-red-500" />
            <p className="text-sm text-ink-muted">{gone}</p>
          </div>
        ) : !quote ? (
          <LoadingBlock />
        ) : (
          <div className="rounded-xl border border-line bg-surface shadow-xs print:border-0 print:shadow-none">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-6 py-5">
              <div>
                <p className="text-xs tracking-wide text-ink-muted uppercase">Orçamento {quote.code}</p>
                <h1 className="mt-1 text-xl font-semibold text-ink">{quote.title}</h1>
                <p className="mt-1 text-sm text-ink-muted">
                  {[quote.customer, quote.location].filter(Boolean).join(" · ")}
                  {" · "}chamado {quote.ticket_code}
                </p>
              </div>
              <span className={clsx("rounded-full px-2.5 py-1 text-xs font-medium", QUOTE_STATUS[quote.status].className)}>
                {QUOTE_STATUS[quote.status].label}
              </span>
            </div>

            <div className="overflow-x-auto px-6 py-4">
              <table className="w-full min-w-[28rem] text-sm">
                <thead className="text-left text-xs text-ink-muted">
                  <tr>
                    <th className="py-2 font-medium">Descrição</th>
                    <th className="py-2 text-right font-medium">Qtd.</th>
                    <th className="py-2 text-right font-medium">Valor unit.</th>
                    <th className="py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {quote.items.map((i, k) => (
                    <tr key={k}>
                      <td className="py-2 text-ink">{i.description}</td>
                      <td className="py-2 text-right tabular-nums">
                        {i.quantity.toLocaleString("pt-BR")} {i.unit}
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatMoney(i.unit_price)}</td>
                      <td className="py-2 text-right tabular-nums">{formatMoney(i.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 ml-auto w-64 space-y-1 border-t border-line pt-3 text-right text-sm tabular-nums">
                <p className="text-ink-muted">Subtotal {formatMoney(quote.subtotal)}</p>
                {quote.discount ? <p className="text-ink-muted">Desconto −{formatMoney(quote.discount)}</p> : null}
                <p className="text-lg font-semibold text-ink">Total {formatMoney(quote.total)}</p>
              </div>
            </div>

            {quote.notes || quote.valid_until ? (
              <div className="border-t border-line px-6 py-4 text-sm">
                {quote.valid_until ? <p className="text-ink">Válido até {formatDate(quote.valid_until)}.</p> : null}
                {quote.notes ? <p className="mt-1 whitespace-pre-wrap text-ink-muted">{quote.notes}</p> : null}
              </div>
            ) : null}

            <div className="border-t border-line px-6 py-5 print:hidden">
              {quote.status === "approved" ? (
                <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="size-5" />
                  Aprovado por {quote.approver_name} em {formatDateTime(quote.decided_at)}. Obrigado! Nossa equipe já foi avisada.
                </p>
              ) : quote.status === "rejected" ? (
                <p className="text-sm text-red-700 dark:text-red-300">
                  Recusado em {formatDateTime(quote.decided_at)}: {quote.rejection_reason}
                </p>
              ) : quote.status !== "sent" ? (
                <p className="text-sm text-ink-muted">Este orçamento não aceita mais resposta ({QUOTE_STATUS[quote.status].label.toLowerCase()}).</p>
              ) : mode === "view" ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={() => setMode("approve")}>
                    <CheckCircle2 className="size-4" />
                    Aprovar orçamento
                  </Button>
                  <Button onClick={() => setMode("reject")}>Recusar</Button>
                </div>
              ) : mode === "approve" ? (
                <div className="flex flex-col gap-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Nome completo" required className="sm:col-span-3">
                      <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                    </Field>
                    <Field label="CPF ou CNPJ">
                      <Input value={document} onChange={(e) => setDocument(e.target.value)} inputMode="numeric" />
                    </Field>
                    <Field label="Cargo" className="sm:col-span-2">
                      <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Ex.: Gerente da loja" />
                    </Field>
                  </div>
                  <Field label="Assinatura" required>
                    <SignaturePad onChange={setSignature} />
                  </Field>
                  <Checkbox label={`Li e aprovo o orçamento ${quote.code} no valor de ${formatMoney(quote.total)}.`} checked={accept} onChange={setAccept} />
                  {error ? <ErrorBox message={error} /> : null}
                  <div className="flex gap-2">
                    <Button onClick={() => setMode("view")}>Voltar</Button>
                    <Button variant="primary" loading={sending} onClick={() => decide("approve")}>
                      Confirmar aprovação
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <Field label="Seu nome">
                    <Input value={name} onChange={(e) => setName(e.target.value)} />
                  </Field>
                  <Field label="Motivo da recusa" required>
                    <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                  </Field>
                  {error ? <ErrorBox message={error} /> : null}
                  <div className="flex gap-2">
                    <Button onClick={() => setMode("view")}>Voltar</Button>
                    <Button variant="danger" loading={sending} onClick={() => decide("reject")}>
                      Recusar orçamento
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        <p className="mt-6 text-center text-xs text-ink-muted print:hidden">Maxx Field · aprovação eletrônica com registro de data, hora e assinatura</p>
      </main>
    </div>
  );
}
