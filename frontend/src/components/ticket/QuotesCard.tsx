"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Copy, FileText, Mail, MessageCircle, Plus, Send, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button, Card, CardHeader, Dialog, ErrorBox, Field, Input, Textarea } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { QUOTE_STATUS, quoteUrl } from "@/lib/quotes";
import type { Quote, QuoteCatalogItem, TicketDetail } from "@/lib/types";

const num = (v: string) => Number(v.replace(",", ".")) || 0;

/** Orçamentos da OS: montar, enviar o link e acompanhar a decisão do cliente. */
export function QuotesCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Quote | "new" | null>(null);
  const [sent, setSent] = useState<Quote | null>(null);
  const [opened, setOpened] = useState<Quote | null>(null);
  const quotes = useQuery({
    queryKey: ["ticket", ticket.id, "quotes"],
    queryFn: () => api.get<Quote[]>(`/tickets/${ticket.id}/quotes`),
    enabled: canManageTickets(user?.role),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id, "quotes"] });
  const send = useMutation({
    mutationFn: (q: Quote) => api.post<Quote>(`/quotes/${q.id}/send`),
    onSuccess: (q) => {
      refresh();
      setSent(q);
    },
  });
  const cancel = useMutation({
    mutationFn: (q: Quote) => api.post(`/quotes/${q.id}/cancel`),
    onSuccess: refresh,
  });

  if (!canManageTickets(user?.role)) return null;
  const list = quotes.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Orçamentos"
        description="Monte, envie o link e o cliente aprova com assinatura."
        actions={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            Novo
          </Button>
        }
      />
      {list.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-muted">Nenhum orçamento nesta OS.</p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <FileText className="size-4 shrink-0 text-ink-muted" />
              <button type="button" onClick={() => setOpened(q)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium text-ink hover:text-brand">
                  {q.code} · {q.title}
                </span>
                <span className="text-xs text-ink-muted">
                  {q.decided_at
                    ? `${q.status === "approved" ? "Aprovado" : "Recusado"} por ${q.approver_name ?? "cliente"} em ${formatDateTime(q.decided_at)}`
                    : q.valid_until
                      ? `Válido até ${formatDate(q.valid_until)}`
                      : "Sem validade"}
                </span>
              </button>
              <span className="text-sm font-semibold text-ink tabular-nums">{formatMoney(q.total)}</span>
              <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium", QUOTE_STATUS[q.status].className)}>
                {QUOTE_STATUS[q.status].label}
              </span>
              {["draft", "sent", "expired"].includes(q.status) ? (
                <div className="flex w-full justify-end gap-1.5 sm:w-auto">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(q)}>
                    Editar
                  </Button>
                  <Button size="sm" variant="primary" loading={send.isPending && send.variables?.id === q.id} onClick={() => send.mutate(q)}>
                    <Send className="size-3.5" />
                    {q.status === "draft" ? "Enviar" : "Reenviar"}
                  </Button>
                  <button
                    type="button"
                    onClick={() => window.confirm(`Cancelar ${q.code}? O link deixa de funcionar.`) && cancel.mutate(q)}
                    className="rounded-md p-1 text-ink-muted hover:bg-surface-2 hover:text-red-600"
                    aria-label="Cancelar orçamento"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {send.error ? (
        <div className="px-4 pb-3">
          <ErrorBox message={errorMessage(send.error)} />
        </div>
      ) : null}
      {editing ? <QuoteEditor ticket={ticket} quote={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
      {sent?.token ? <SentDialog ticket={ticket} quote={sent} onClose={() => setSent(null)} /> : null}
      {opened ? <QuoteView quote={opened} onClose={() => setOpened(null)} /> : null}
    </Card>
  );
}

interface Line {
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  catalog_item_id: string | null;
}

function QuoteEditor({
  ticket,
  quote,
  onClose,
  onSaved,
}: {
  ticket: TicketDetail;
  quote: Quote | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const catalog = useQuery({
    queryKey: ["quote-items", "active"],
    queryFn: () => api.get<QuoteCatalogItem[]>("/quote-items", { active: true }),
  });
  const [title, setTitle] = useState(quote?.title ?? ticket.title);
  const [lines, setLines] = useState<Line[]>(
    quote?.items.map((i) => ({
      description: i.description,
      quantity: String(i.quantity).replace(".", ","),
      unit: i.unit,
      unit_price: i.unit_price.toFixed(2).replace(".", ","),
      catalog_item_id: i.catalog_item_id,
    })) ?? [{ description: "", quantity: "1", unit: "un", unit_price: "", catalog_item_id: null }],
  );
  const [discount, setDiscount] = useState(quote ? quote.discount.toFixed(2).replace(".", ",") : "0");
  // Validade padrão: 7 dias (calculada uma vez, no primeiro render).
  const [validUntil, setValidUntil] = useState(
    () => quote?.valid_until ?? new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
  );
  const [notes, setNotes] = useState(quote?.notes ?? "");
  const subtotal = lines.reduce((s, l) => s + num(l.quantity) * num(l.unit_price), 0);
  const total = Math.max(0, subtotal - num(discount));
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title,
        items: lines
          .filter((l) => l.description.trim())
          .map((l) => ({
            description: l.description,
            quantity: l.quantity.replace(",", "."),
            unit: l.unit,
            unit_price: l.unit_price.replace(",", ".") || "0",
            catalog_item_id: l.catalog_item_id,
          })),
        discount: discount.replace(",", ".") || "0",
        valid_until: validUntil || null,
        notes: notes || null,
      };
      return quote ? api.put(`/quotes/${quote.id}`, body) : api.post(`/tickets/${ticket.id}/quotes`, body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={quote ? `Editar ${quote.code}` : "Novo orçamento"}
      description={quote?.status === "sent" ? "Ao salvar, o link enviado deixa de valer: envie de novo." : `${ticket.code} · ${ticket.customer?.name ?? "sem cliente"}`}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Salvar · {formatMoney(total)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Título" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <datalist id="quote-catalog">
          {(catalog.data ?? []).map((c) => (
            <option key={c.id} value={c.name}>
              {formatMoney(c.price)} / {c.unit}
            </option>
          ))}
        </datalist>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-muted">
              <tr>
                <th className="px-2 py-1.5 font-medium">Item</th>
                <th className="w-20 px-2 py-1.5 font-medium">Qtd.</th>
                <th className="w-20 px-2 py-1.5 font-medium">Unid.</th>
                <th className="w-28 px-2 py-1.5 font-medium">Valor unit.</th>
                <th className="w-24 px-2 py-1.5 text-right font-medium">Total</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="p-1.5">
                    <Input
                      list="quote-catalog"
                      value={l.description}
                      placeholder="Digite ou escolha do catálogo"
                      aria-label={`Item ${i + 1}`}
                      onChange={(e) => {
                        const match = catalog.data?.find((c) => c.name === e.target.value);
                        setLine(
                          i,
                          match
                            ? { description: match.name, unit: match.unit, unit_price: match.price.toFixed(2).replace(".", ","), catalog_item_id: match.id }
                            : { description: e.target.value, catalog_item_id: null },
                        );
                      }}
                    />
                  </td>
                  <td className="p-1.5">
                    <Input value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} inputMode="decimal" aria-label="Quantidade" />
                  </td>
                  <td className="p-1.5">
                    <Input value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} aria-label="Unidade" />
                  </td>
                  <td className="p-1.5">
                    <Input value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} inputMode="decimal" placeholder="0,00" aria-label="Valor unitário" />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(num(l.quantity) * num(l.unit_price))}</td>
                  <td className="p-1.5">
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      disabled={lines.length === 1}
                      className="rounded p-1 text-ink-muted hover:text-red-600 disabled:opacity-30"
                      aria-label="Remover item"
                    >
                      <X className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button
          size="sm"
          className="self-start"
          onClick={() => setLines((ls) => [...ls, { description: "", quantity: "1", unit: "un", unit_price: "", catalog_item_id: null }])}
        >
          <Plus className="size-4" />
          Adicionar item
        </Button>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Desconto (R$)">
            <Input value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Válido até">
            <Input type="date" value={validUntil ?? ""} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
          <div className="flex flex-col justify-end rounded-lg bg-surface-2 px-3 py-2 text-sm">
            <span className="text-xs text-ink-muted">Subtotal {formatMoney(subtotal)}</span>
            <span className="text-lg font-semibold text-ink tabular-nums">{formatMoney(total)}</span>
          </div>
        </div>
        <Field label="Condições" hint="Prazo de execução, forma de pagamento, garantia...">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {save.error ? <ErrorBox message={errorMessage(save.error)} /> : null}
      </div>
    </Dialog>
  );
}

function SentDialog({ ticket, quote, onClose }: { ticket: TicketDetail; quote: Quote; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = quoteUrl(quote.token as string);
  const message = `Olá! Segue o orçamento ${quote.code} (${quote.title}) referente ao chamado ${ticket.code}, no valor de ${formatMoney(quote.total)}. Para aprovar, acesse: ${url}`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${quote.code} enviado`}
      description="Mande o link ao cliente. Ele aprova com nome e assinatura, ou recusa com o motivo."
      footer={
        <Button variant="primary" onClick={onClose}>
          Concluir
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
          <code className="min-w-0 flex-1 truncate text-xs text-ink">{url}</code>
          <Button
            onClick={async () => {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            }}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copiado" : "Copiar"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
            <Button>
              <MessageCircle className="size-4" />
              WhatsApp
            </Button>
          </a>
          <a href={`mailto:?subject=${encodeURIComponent(`Orçamento ${quote.code} - Maxx Field`)}&body=${encodeURIComponent(message)}`}>
            <Button>
              <Mail className="size-4" />
              E-mail
            </Button>
          </a>
        </div>
        <p className="text-xs text-ink-muted">Por segurança, o link completo só aparece agora. Reenviar gera um novo e invalida este.</p>
      </div>
    </Dialog>
  );
}

function QuoteView({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  return (
    <Dialog open size="lg" onClose={onClose} title={`${quote.code} · ${quote.title}`} description={QUOTE_STATUS[quote.status].label}>
      <div className="flex flex-col gap-4 text-sm">
        <table className="w-full">
          <thead className="text-left text-xs text-ink-muted">
            <tr>
              <th className="py-1 font-medium">Item</th>
              <th className="py-1 text-right font-medium">Qtd.</th>
              <th className="py-1 text-right font-medium">Unit.</th>
              <th className="py-1 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {quote.items.map((i, k) => (
              <tr key={k}>
                <td className="py-1.5 text-ink">{i.description}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {i.quantity.toLocaleString("pt-BR")} {i.unit}
                </td>
                <td className="py-1.5 text-right tabular-nums">{formatMoney(i.unit_price)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatMoney(i.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ml-auto w-56 space-y-1 text-right tabular-nums">
          <p className="text-ink-muted">Subtotal {formatMoney(quote.subtotal)}</p>
          {quote.discount ? <p className="text-ink-muted">Desconto −{formatMoney(quote.discount)}</p> : null}
          <p className="text-base font-semibold text-ink">Total {formatMoney(quote.total)}</p>
        </div>
        {quote.notes ? <p className="whitespace-pre-wrap text-ink-muted">{quote.notes}</p> : null}
        {quote.status === "approved" ? (
          <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/30">
            {quote.signature_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
              <img src={absoluteApiUrl(quote.signature_url) ?? undefined} alt="Assinatura do cliente" className="h-14 w-32 rounded border border-line bg-white object-contain" />
            ) : null}
            <p className="text-emerald-900 dark:text-emerald-200">
              Aprovado por <strong>{quote.approver_name}</strong>
              {quote.approver_role ? ` (${quote.approver_role})` : ""}
              {quote.approver_document ? ` · doc. ${quote.approver_document}` : ""} em {formatDateTime(quote.decided_at)}
            </p>
          </div>
        ) : quote.status === "rejected" ? (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
            Recusado{quote.approver_name ? ` por ${quote.approver_name}` : ""} em {formatDateTime(quote.decided_at)}: {quote.rejection_reason}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
