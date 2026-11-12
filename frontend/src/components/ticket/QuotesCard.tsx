"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Copy, ExternalLink, FileText, Link2, Mail, MessageCircle, Plus, RefreshCw, Send, Share2, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { Button, Card, CardHeader, Dialog, ErrorBox, Field, Input, Select, Textarea } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { QUOTE_KIND, QUOTE_STATUS, quoteUrl, totalsByKind } from "@/lib/quotes";
import type { Quote, QuoteCatalogItem, QuoteItemKind, QuoteLink, TicketDetail } from "@/lib/types";

/** Link do cliente: o persistente da API (copiar a qualquer momento) ou o token devolvido no envio. */
function linkOf(q: Quote): string | null {
  if (q.link?.url) return q.link.url;
  return q.token ? quoteUrl(q.token) : null;
}

const num = (v: string) => Number(v.replace(",", ".")) || 0;

/** Orçamentos da OS: montar, enviar o link e acompanhar a decisão do cliente. */
export function QuotesCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Quote | "new" | null>(null);
  const [sharing, setSharing] = useState<Quote | null>(null);
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
      setSharing(q);
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
        description="Monte, envie o link e o cliente aprova com nome, matrícula (opcional) e assinatura."
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
              {q.status !== "draft" && q.status !== "cancelled" && linkOf(q) ? (
                <button
                  type="button"
                  onClick={() => setSharing(q)}
                  className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-brand"
                  aria-label={`Link do ${q.code} para o cliente`}
                  title="Link para o cliente"
                >
                  <Link2 className="size-4" />
                </button>
              ) : null}
              {["draft", "sent", "expired"].includes(q.status) ? (
                <div className="flex w-full justify-end gap-1.5 sm:w-auto">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(q)}>
                    Editar
                  </Button>
                  {q.status === "sent" && linkOf(q) ? (
                    <Button size="sm" variant="primary" onClick={() => setSharing(q)}>
                      <Share2 className="size-3.5" />
                      Enviar link
                    </Button>
                  ) : (
                    // Rascunho, vencido ou enviado sem link (veio do Field Control): o envio cria o link.
                    <Button size="sm" variant="primary" loading={send.isPending && send.variables?.id === q.id} onClick={() => send.mutate(q)}>
                      <Send className="size-3.5" />
                      {q.status === "draft" ? "Enviar" : q.status === "sent" ? "Gerar link" : "Reenviar"}
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={async () =>
                      (await confirm({
                        title: `Cancelar o orçamento ${q.code}?`,
                        description: "O link enviado ao cliente deixa de funcionar.",
                        confirmLabel: "Cancelar orçamento",
                        tone: "danger",
                      })) && cancel.mutate(q)
                    }
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
      {sharing ? <ShareDialog ticket={ticket} quote={sharing} onClose={() => setSharing(null)} onRotated={refresh} /> : null}
      {opened ? <QuoteView quote={opened} onClose={() => setOpened(null)} /> : null}
    </Card>
  );
}

interface Line {
  kind: QuoteItemKind;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  catalog_item_id: string | null;
}

/** Itens iniciais de um orçamento novo (ex.: o pedido de peça do técnico). */
export interface QuotePrefill {
  title?: string;
  items: { description: string; quantity: number; unit: string; kind?: QuoteItemKind }[];
}

export function QuoteEditor({
  ticket,
  quote,
  prefill,
  onClose,
  onSaved,
}: {
  ticket: TicketDetail;
  quote: Quote | null;
  prefill?: QuotePrefill;
  onClose: () => void;
  onSaved: (saved: Quote) => void;
}) {
  const catalog = useQuery({
    queryKey: ["quote-items", "active"],
    queryFn: () => api.get<QuoteCatalogItem[]>("/quote-items", { active: true }),
  });
  const [title, setTitle] = useState(quote?.title ?? prefill?.title ?? ticket.title);
  const [lines, setLines] = useState<Line[]>(
    quote?.items.map((i) => ({
      kind: i.kind ?? "product",
      description: i.description,
      quantity: String(i.quantity).replace(".", ","),
      unit: i.unit,
      unit_price: i.unit_price.toFixed(2).replace(".", ","),
      catalog_item_id: i.catalog_item_id,
    })) ??
      prefill?.items.map((i) => ({
        kind: i.kind ?? "product",
        description: i.description,
        quantity: String(i.quantity).replace(".", ","),
        unit: i.unit,
        unit_price: "",
        catalog_item_id: null,
      })) ?? [{ kind: "product", description: "", quantity: "1", unit: "un", unit_price: "", catalog_item_id: null }],
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
            kind: l.kind,
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
      return quote ? api.put<Quote>(`/quotes/${quote.id}`, body) : api.post<Quote>(`/tickets/${ticket.id}/quotes`, body);
    },
    onSuccess: (saved) => {
      onSaved(saved);
      onClose();
    },
  });

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={quote ? `Editar ${quote.code}` : "Novo orçamento"}
      description={quote?.status === "sent" ? "O link continua o mesmo: depois de salvar, envie de novo para o cliente responder." : `${ticket.code} · ${ticket.customer?.name ?? "sem cliente"}`}
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
          <table className="w-full min-w-[42rem] text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-muted">
              <tr>
                <th className="px-2 py-1.5 font-medium">Item</th>
                <th className="w-28 px-2 py-1.5 font-medium">Tipo</th>
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
                            ? { description: match.name, unit: match.unit, unit_price: match.price.toFixed(2).replace(".", ","), catalog_item_id: match.id, kind: match.kind ?? "product" }
                            : { description: e.target.value, catalog_item_id: null },
                        );
                      }}
                    />
                  </td>
                  <td className="p-1.5">
                    <Select value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value as QuoteItemKind })} aria-label="Tipo do item">
                      {(Object.keys(QUOTE_KIND) as QuoteItemKind[]).map((k) => (
                        <option key={k} value={k}>
                          {QUOTE_KIND[k].label}
                        </option>
                      ))}
                    </Select>
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
          onClick={() => setLines((ls) => [...ls, { kind: "product", description: "", quantity: "1", unit: "un", unit_price: "", catalog_item_id: null }])}
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

/** Link do orçamento para o cliente: copiar, WhatsApp, e-mail ou gerar um novo (o anterior para de valer). */
function ShareDialog({
  ticket,
  quote,
  onClose,
  onRotated,
}: {
  ticket: TicketDetail;
  quote: Quote;
  onClose: () => void;
  onRotated: () => void;
}) {
  const confirm = useConfirm();
  const [copied, setCopied] = useState(false);
  const [current, setCurrent] = useState(quote);
  const rotate = useMutation({
    mutationFn: () => api.post<QuoteLink>(`/quotes/${quote.id}/link/rotate`),
    onSuccess: (link) => {
      setCurrent((q) => ({ ...q, link, token: link.token }));
      setCopied(false);
      onRotated();
    },
  });
  const url = linkOf(current);
  const message = `Olá! Segue o orçamento ${quote.code} (${quote.title}) referente à OS ${ticket.code}, no valor de ${formatMoney(quote.total)}. Para aprovar com sua assinatura, acesse: ${url}`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Link do ${quote.code}`}
      description="O cliente abre pelo celular e aprova com nome, matrícula (opcional) e assinatura, ou recusa com o motivo."
      footer={
        <Button variant="primary" onClick={onClose}>
          Concluir
        </Button>
      }
    >
      {url ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 py-1.5 pr-1.5 pl-3">
            <code className="min-w-0 flex-1 truncate text-xs text-ink-muted">{url}</code>
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
              }}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copiado" : "Copiar"}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
              <Button size="sm">
                <MessageCircle className="size-3.5" />
                WhatsApp
              </Button>
            </a>
            <a href={`mailto:?subject=${encodeURIComponent(`Orçamento ${quote.code}`)}&body=${encodeURIComponent(message)}`}>
              <Button size="sm">
                <Mail className="size-3.5" />
                E-mail
              </Button>
            </a>
            <a href={current.link?.path ?? url} target="_blank" rel="noreferrer">
              <Button size="sm">
                <ExternalLink className="size-3.5" />
                Ver como o cliente
              </Button>
            </a>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <p className="text-xs text-ink-muted">O link fica aqui para copiar de novo quando precisar.</p>
            <button
              type="button"
              disabled={rotate.isPending}
              onClick={async () =>
                (await confirm({
                  title: "Gerar um novo link?",
                  description: "O link já enviado ao cliente para de funcionar.",
                  confirmLabel: "Gerar novo link",
                  tone: "danger",
                })) && rotate.mutate()
              }
              className="inline-flex items-center gap-1 text-xs text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              <RefreshCw className="size-3.5" />
              Gerar novo link
            </button>
          </div>
          {rotate.error ? <ErrorBox message={errorMessage(rotate.error)} /> : null}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">Envie o orçamento para gerar o link do cliente.</p>
      )}
    </Dialog>
  );
}

export function QuoteView({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  return (
    <Dialog open size="lg" onClose={onClose} title={`${quote.code} · ${quote.title}`} description={QUOTE_STATUS[quote.status].label}>
      <div className="flex flex-col gap-4 text-sm">
        <table className="w-full">
          <thead className="text-left text-xs text-ink-muted">
            <tr>
              <th className="py-1 font-medium">Item</th>
              <th className="py-1 font-medium">Tipo</th>
              <th className="py-1 text-right font-medium">Qtd.</th>
              <th className="py-1 text-right font-medium">Unit.</th>
              <th className="py-1 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {quote.items.map((i, k) => (
              <tr key={k}>
                <td className="py-1.5 text-ink">{i.description}</td>
                <td className="py-1.5 text-ink-muted">{QUOTE_KIND[i.kind ?? "product"].label}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {i.quantity.toLocaleString("pt-BR")} {i.unit}
                </td>
                <td className="py-1.5 text-right tabular-nums">{formatMoney(i.unit_price)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatMoney(i.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ml-auto w-64 space-y-1 text-right tabular-nums">
          {(() => {
            const totals = totalsByKind(quote.items, quote.totals_by_kind);
            return (Object.keys(QUOTE_KIND) as QuoteItemKind[])
              .filter((k) => totals[k] > 0)
              .map((k) => (
                <p key={k} className="text-xs text-ink-subtle">
                  {QUOTE_KIND[k].plural} {formatMoney(totals[k])}
                </p>
              ));
          })()}
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
            <div className="text-emerald-900 dark:text-emerald-200">
              <p>
                Aprovado por <strong>{quote.approver_name}</strong>
                {quote.approver_registration ? ` · matrícula ${quote.approver_registration}` : ""}
                {quote.approver_role ? ` (${quote.approver_role})` : ""}
                {quote.approver_document ? ` · doc. ${quote.approver_document}` : ""} em {formatDateTime(quote.decided_at)}
              </p>
              {quote.client_comment ? <p className="mt-1 text-emerald-800/80 dark:text-emerald-200/80">“{quote.client_comment}”</p> : null}
            </div>
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
