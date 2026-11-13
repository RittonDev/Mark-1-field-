"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Ban,
  Check,
  Copy,
  CopyPlus,
  ExternalLink,
  FileText,
  Info,
  Link2,
  Mail,
  MessageCircle,
  Plus,
  RefreshCw,
  RotateCw,
  Send,
  Share2,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { QuoteViewer } from "@/components/quotes/QuoteViewer";
import { useToast } from "@/components/Toaster";
import { useNow } from "@/components/useNow";
import { Button, buttonClassName, Card, CardHeader, Dialog, ErrorBox, Field, Input, LoadingBlock, Pill, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import {
  addDaysISO,
  lineTotalCents,
  localDateISO,
  QUOTE_KIND,
  QUOTE_STATUS,
  QUOTE_VALID_DAYS,
  quantityInput,
  quoteUrl,
  readDecimal,
} from "@/lib/quotes";
import type { Quote, QuoteCatalogItem, QuoteItemKind, QuoteLink, Ref, TicketDetail, UUID } from "@/lib/types";
import { copyText, whatsappUrl } from "@/lib/whatsapp";

/** O que o editor e o compartilhamento precisam da OS (dá para abrir também pela tela Orçamentos). */
export interface QuoteTicketRef {
  id: UUID;
  code: string;
  title: string;
  customer?: Pick<Ref, "name"> | null;
}

/** Link do cliente: o persistente da API (copiar a qualquer momento) ou o token devolvido no envio. */
function linkOf(q: Quote): string | null {
  if (q.link?.url) return q.link.url;
  return q.token ? quoteUrl(q.token) : null;
}

/** Novo orçamento com os itens, o desconto e as condições de outro (Duplicar, como no Field Control). */
function duplicateOf(q: Quote): QuotePrefill {
  return {
    title: q.title,
    items: q.items.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      kind: i.kind,
      unit_price: i.unit_price,
      catalog_item_id: i.catalog_item_id,
    })),
    discount: q.discount,
    notes: q.notes,
  };
}

/** Linha de baixo do orçamento na lista: quem decidiu, por que recusou ou até quando vale. */
function rowDetail(q: Quote, today: string): string {
  if (q.decided_at && (q.status === "approved" || q.status === "rejected")) {
    const who = `${q.status === "approved" ? "Aprovado" : "Recusado"} por ${q.approver_name ?? "cliente"} em ${formatDateTime(q.decided_at)}`;
    return q.status === "rejected" && q.rejection_reason ? `${who} · Motivo: ${q.rejection_reason}` : who;
  }
  if (!q.valid_until) return "Sem validade";
  return q.valid_until < today ? `Venceu em ${formatDate(q.valid_until)}` : `Válido até ${formatDate(q.valid_until)}`;
}

const iconAction =
  "rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none";

/** Orçamentos da OS: montar, enviar o link e acompanhar a decisão do cliente. */
export function QuotesCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const now = useNow(60_000);
  const manager = canManageTickets(user?.role);
  const [editing, setEditing] = useState<{ quote: Quote | null; prefill?: QuotePrefill; renew?: boolean } | null>(null);
  const [sharing, setSharing] = useState<Quote | null>(null);
  const [opened, setOpened] = useState<Quote | null>(null);
  const quotes = useQuery({
    queryKey: ["ticket", ticket.id, "quotes"],
    queryFn: () => api.get<Quote[]>(`/tickets/${ticket.id}/quotes`),
    enabled: manager,
  });
  // A lista da OS e a tela Orçamentos mostram os mesmos orçamentos.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id, "quotes"] });
    void queryClient.invalidateQueries({ queryKey: ["quotes"] });
  };
  const send = useMutation({
    mutationFn: (q: Quote) => api.post<Quote>(`/quotes/${q.id}/send`),
    onSuccess: (q) => {
      refresh();
      setSharing(q);
    },
    onError: (e) => toast({ title: "Não foi possível enviar", description: errorMessage(e), tone: "error" }),
  });
  const cancel = useMutation({
    mutationFn: (q: Quote) => api.post<Quote>(`/quotes/${q.id}/cancel`),
    onSuccess: (q) => {
      refresh();
      toast({ title: `${q.code} cancelado`, description: "O link do cliente não abre mais.", tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível cancelar", description: errorMessage(e), tone: "error" }),
  });

  if (!manager) return null;
  const list = quotes.data ?? [];
  const today = localDateISO(new Date(now));

  const askCancel = async (q: Quote) => {
    const ok = await confirm({
      title: `Cancelar o orçamento ${q.code}?`,
      description: "O link enviado ao cliente deixa de funcionar. Não dá para desfazer.",
      confirmLabel: "Cancelar orçamento",
      cancelLabel: "Voltar",
      tone: "danger",
    });
    if (ok) cancel.mutate(q);
  };

  return (
    <Card>
      <CardHeader
        title="Orçamentos"
        description="Monte, envie o link e o cliente aprova com nome, matrícula (opcional) e assinatura."
        actions={
          <Button size="sm" onClick={() => setEditing({ quote: null })}>
            <Plus className="size-4" />
            Novo
          </Button>
        }
      />
      {quotes.isLoading ? (
        <LoadingBlock rows={2} label="Carregando orçamentos..." />
      ) : quotes.error ? (
        <div className="flex flex-col items-start gap-2 p-4">
          <ErrorBox message={errorMessage(quotes.error)} />
          <Button size="sm" onClick={() => void quotes.refetch()}>
            <RotateCw className="size-3.5" />
            Tentar de novo
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-muted">Nenhum orçamento nesta OS.</p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((q) => {
            const editable = q.status === "draft" || q.status === "sent" || q.status === "expired";
            // Validade vencida: o envio seria recusado. Renovar abre o editor com a nova data e envia.
            const pastDue = Boolean(q.valid_until && q.valid_until < today);
            const detail = rowDetail(q, today);
            return (
              <li key={q.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <FileText className="size-4 shrink-0 text-ink-muted" />
                <button type="button" onClick={() => setOpened(q)} className="group min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-semibold text-ink group-hover:text-brand">
                    {q.code} · {q.title}
                  </span>
                  <span className="block truncate text-xs text-ink-muted" title={detail}>
                    {detail}
                  </span>
                </button>
                <span className="text-sm font-semibold text-ink tabular-nums">{formatMoney(q.total)}</span>
                <Pill color={QUOTE_STATUS[q.status].color}>{QUOTE_STATUS[q.status].label}</Pill>
                <div className="flex w-full items-center justify-end gap-1 sm:w-auto">
                  {editable ? (
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ quote: q })}>
                      Editar
                    </Button>
                  ) : null}
                  {editable && pastDue ? (
                    <Button size="sm" variant="primary" onClick={() => setEditing({ quote: q, renew: true })}>
                      <RefreshCw className="size-3.5" />
                      {q.status === "draft" ? "Renovar e enviar" : "Renovar e reenviar"}
                    </Button>
                  ) : q.status === "sent" && linkOf(q) ? (
                    <Button size="sm" variant="primary" onClick={() => setSharing(q)}>
                      <Share2 className="size-3.5" />
                      Enviar link
                    </Button>
                  ) : q.status === "draft" || q.status === "sent" ? (
                    // Rascunho ou enviado sem link (veio do Field Control): o envio cria o link.
                    <Button size="sm" variant="primary" loading={send.isPending && send.variables?.id === q.id} onClick={() => send.mutate(q)}>
                      <Send className="size-3.5" />
                      {q.status === "draft" ? "Enviar" : "Gerar link"}
                    </Button>
                  ) : null}
                  {(q.status === "approved" || q.status === "rejected") && linkOf(q) ? (
                    <button
                      type="button"
                      onClick={() => setSharing(q)}
                      className={clsx(iconAction, "hover:text-brand")}
                      aria-label={`Link do ${q.code} para o cliente`}
                      title="Link para o cliente"
                    >
                      <Link2 className="size-4" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setEditing({ quote: null, prefill: duplicateOf(q) })}
                    className={clsx(iconAction, "hover:text-ink")}
                    aria-label={`Duplicar o orçamento ${q.code}`}
                    title="Duplicar"
                  >
                    <CopyPlus className="size-4" />
                  </button>
                  {editable ? (
                    <button
                      type="button"
                      onClick={() => askCancel(q)}
                      disabled={cancel.isPending && cancel.variables?.id === q.id}
                      className={clsx(iconAction, "hover:text-red-600 disabled:opacity-40")}
                      aria-label={`Cancelar o orçamento ${q.code}`}
                      title="Cancelar orçamento"
                    >
                      <Ban className="size-4" />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing ? (
        <QuoteEditor
          ticket={ticket}
          quote={editing.quote}
          prefill={editing.prefill}
          renew={editing.renew}
          onClose={() => setEditing(null)}
          onSaved={(saved, sending) => {
            refresh();
            if (!sending) toast({ title: `${saved.code} salvo`, tone: "success" });
          }}
          onSend={(saved) => send.mutate(saved)}
        />
      ) : null}
      {sharing ? <ShareDialog ticket={ticket} quote={sharing} onClose={() => setSharing(null)} onRotated={refresh} /> : null}
      {opened ? (
        <QuoteViewer
          quote={opened}
          ticket={{ id: ticket.id, code: ticket.code, customer: ticket.customer?.name ?? null, title: ticket.title }}
          inTicket
          sending={send.isPending}
          onClose={() => setOpened(null)}
          onEdit={() => {
            setOpened(null);
            setEditing({ quote: opened });
          }}
          onRenew={() => {
            setOpened(null);
            setEditing({ quote: opened, renew: true });
          }}
          onSend={() => {
            setOpened(null);
            send.mutate(opened);
          }}
          onShare={() => {
            setOpened(null);
            setSharing(opened);
          }}
          onDuplicate={() => {
            setOpened(null);
            setEditing({ quote: null, prefill: duplicateOf(opened) });
          }}
        />
      ) : null}
    </Card>
  );
}

interface Line {
  /** Chave estável da linha (remover uma do meio não embaralha os campos das outras). */
  id: string;
  kind: QuoteItemKind;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  catalog_item_id: string | null;
}

/** Itens iniciais de um orçamento novo (o pedido de peça do técnico ou um orçamento duplicado). */
export interface QuotePrefill {
  title?: string;
  items: {
    description: string;
    quantity: number;
    unit: string;
    kind?: QuoteItemKind;
    unit_price?: number;
    catalog_item_id?: UUID | null;
  }[];
  discount?: number;
  notes?: string | null;
}

const blankLine = (id: string): Line => ({ id, kind: "product", description: "", quantity: "1", unit: "un", unit_price: "", catalog_item_id: null });
const moneyText = (value: number) => value.toFixed(2).replace(".", ",");

/** O que foi digitado no item (sem a chave da linha), para saber se algo mudou. */
const lineData = (l: Line) => [l.kind, l.description, l.quantity, l.unit, l.unit_price, l.catalog_item_id];

interface LineCheck {
  /** Linha sem nada digitado (é ignorada ao salvar). */
  empty: boolean;
  quantity: number | null;
  price: number | null;
  errors: Partial<Record<"description" | "quantity" | "unit_price", string>>;
}

/** Confere a linha como a API conferiria, com a mensagem em português, ao lado do campo. */
function checkLine(l: Line): LineCheck {
  const empty = !l.description.trim() && !l.unit_price.trim() && ["", "1"].includes(l.quantity.trim());
  const quantity = readDecimal(l.quantity, { decimals: 3, emptyMessage: "Informe a quantidade" });
  const price = readDecimal(l.unit_price, { decimals: 2, allowZero: true, emptyMessage: "Informe o valor (0 para item sem custo)" });
  const errors: LineCheck["errors"] = {};
  if (!l.description.trim()) errors.description = "Descreva o item";
  if (quantity.error) errors.quantity = quantity.error;
  if (price.error) errors.unit_price = price.error;
  return { empty, quantity: quantity.value, price: price.value, errors };
}

const fieldError = "text-xs text-red-700 dark:text-red-400";
const invalidInput = "border-red-400 dark:border-red-500/60";

/** Rótulo pequeno dos campos de cada item (na primeira linha; no celular, em todas). */
function LineField({ label, error, first, children, className }: { label: string; error?: string; first: boolean; children: React.ReactNode; className?: string }) {
  return (
    <label className={clsx("flex min-w-0 flex-col gap-1", className)}>
      <span className={clsx("text-[11px] font-semibold text-ink/80", !first && "sm:sr-only")}>{label}</span>
      {children}
      {error ? <span className={fieldError}>{error}</span> : null}
    </label>
  );
}

export function QuoteEditor({
  ticket,
  quote,
  prefill,
  renew = false,
  onClose,
  onSaved,
  onSend,
}: {
  ticket: QuoteTicketRef;
  quote: Quote | null;
  prefill?: QuotePrefill;
  /** Renovar: a validade vencida passa para hoje + 7 dias. */
  renew?: boolean;
  onClose: () => void;
  /** Depois de salvar; `sending` quando foi "Salvar e enviar". */
  onSaved: (saved: Quote, sending: boolean) => void;
  /** Com ele, o rodapé ganha "Salvar e enviar" (salva e já envia o link ao cliente). */
  onSend?: (saved: Quote) => void;
}) {
  const confirm = useConfirm();
  const catalog = useQuery({
    queryKey: ["quote-items", "active"],
    queryFn: () => api.get<QuoteCatalogItem[]>("/quote-items", { active: true }),
  });
  const listId = `quote-catalog-${quote?.id ?? "new"}`;
  // Estado inicial calculado uma vez (inclusive o "hoje" e a foto do formulário para avisar o que não foi salvo).
  const [initial] = useState(() => {
    const today = localDateISO();
    const items = quote?.items ?? prefill?.items ?? [];
    const lines: Line[] = items.length
      ? items.map((i, n) => {
          const price = (i as { unit_price?: number }).unit_price;
          return {
            id: `l${n}`,
            kind: i.kind ?? "product",
            description: i.description,
            quantity: quantityInput(i.quantity),
            unit: i.unit,
            unit_price: price == null ? "" : moneyText(price),
            catalog_item_id: (i as { catalog_item_id?: string | null }).catalog_item_id ?? null,
          };
        })
      : [blankLine("l0")];
    const current = quote?.valid_until ?? null;
    // Vencida (ou renovando): a nova validade é daqui a 7 dias; o envio com data passada seria recusado.
    const expiredOn = current && current < today ? current : null;
    const validUntil = !quote || renew || expiredOn ? addDaysISO(QUOTE_VALID_DAYS) : (current ?? "");
    const state = {
      title: quote?.title ?? prefill?.title ?? ticket.title,
      lines,
      discount: quote ? moneyText(quote.discount) : prefill?.discount ? moneyText(prefill.discount) : "",
      validUntil,
      notes: quote?.notes ?? prefill?.notes ?? "",
    };
    return { ...state, today, expiredOn, snapshot: JSON.stringify({ ...state, lines: lines.map(lineData) }) };
  });
  const today = initial.today;
  const [title, setTitle] = useState(initial.title);
  const [lines, setLines] = useState<Line[]>(initial.lines);
  const [discount, setDiscount] = useState(initial.discount);
  const [validUntil, setValidUntil] = useState(initial.validUntil);
  const [notes, setNotes] = useState(initial.notes);
  const [tried, setTried] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const seq = useRef(initial.lines.length);

  const checks = lines.map(checkLine);
  const subtotalCents = checks.reduce(
    (sum, c) => sum + (!c.empty && c.quantity !== null && c.price !== null ? lineTotalCents(c.quantity, c.price) : 0),
    0,
  );
  const discountCheck = readDecimal(discount, { decimals: 2, allowZero: true, emptyAsZero: true });
  const discountCents = discountCheck.value !== null ? Math.round(discountCheck.value * 100) : 0;
  const totalCents = Math.max(0, subtotalCents - discountCents);
  const filled = checks.filter((c) => !c.empty);

  const titleError = title.trim().length < 3 ? "Use pelo menos 3 letras no título" : null;
  const itemsError = filled.length === 0 ? "Inclua pelo menos um item" : filled.length > 100 ? "No máximo 100 itens por orçamento" : null;
  const discountError = discountCheck.error ?? (discountCents > subtotalCents ? "O desconto passa do subtotal" : null);
  const dateError = validUntil && validUntil < today ? "A validade já passou: escolha uma data a partir de hoje" : null;
  const problems = [
    titleError ? `Título: ${titleError}` : null,
    itemsError,
    ...checks.map((c, i) => (!c.empty && Object.keys(c.errors).length ? `Item ${i + 1}: ${Object.values(c.errors).join("; ")}` : null)),
    discountError ? `Desconto: ${discountError}` : null,
    dateError ? `Validade: ${dateError}` : null,
  ].filter((p): p is string => Boolean(p));
  const dirty = JSON.stringify({ title, lines: lines.map(lineData), discount, validUntil, notes }) !== initial.snapshot;

  const setLine = (id: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLine = () => {
    seq.current += 1;
    const id = `l${seq.current}`;
    setLines((ls) => [...ls, blankLine(id)]);
    setFocusId(id);
  };

  // A variável é "salvar e enviar" (true) ou só salvar (false).
  const save = useMutation<Quote, Error, boolean>({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        items: lines.flatMap((l, i) => {
          const c = checks[i];
          if (c.empty || c.quantity === null || c.price === null) return [];
          return [
            {
              kind: l.kind,
              description: l.description.trim(),
              quantity: String(c.quantity),
              unit: l.unit.trim() || "un",
              unit_price: String(c.price),
              catalog_item_id: l.catalog_item_id,
            },
          ];
        }),
        discount: (discountCents / 100).toFixed(2),
        valid_until: validUntil || null,
        notes: notes.trim() || null,
      };
      return quote ? api.put<Quote>(`/quotes/${quote.id}`, body) : api.post<Quote>(`/tickets/${ticket.id}/quotes`, body);
    },
    onSuccess: (saved, sending) => {
      onSaved(saved, sending);
      if (sending && onSend) onSend(saved);
      onClose();
    },
  });

  const submit = (sending: boolean) => {
    setTried(true);
    if (problems.length) return;
    save.mutate(sending);
  };

  const requestClose = async () => {
    if (
      dirty &&
      !(await confirm({
        title: "Descartar as alterações?",
        description: "O que você digitou neste orçamento não foi salvo.",
        confirmLabel: "Descartar",
        tone: "danger",
      }))
    ) {
      return;
    }
    onClose();
  };

  const totalLabel = formatMoney(totalCents / 100);

  return (
    <Dialog
      open
      size="lg"
      onClose={requestClose}
      title={quote ? `Editar ${quote.code}` : "Novo orçamento"}
      description={
        quote?.status === "sent"
          ? "Ao salvar, o orçamento volta para revisão: envie de novo para o cliente responder (o link continua o mesmo)."
          : `${ticket.code} · ${ticket.customer?.name ?? "sem cliente"}`
      }
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          <Button onClick={requestClose}>Cancelar</Button>
          {onSend ? (
            <>
              <Button loading={save.isPending && save.variables === false} disabled={save.isPending} onClick={() => submit(false)}>
                Salvar rascunho
              </Button>
              <Button variant="primary" loading={save.isPending && save.variables === true} disabled={save.isPending} onClick={() => submit(true)}>
                {save.isPending && save.variables === true ? null : <Send className="size-4" />}
                Salvar e enviar · {totalLabel}
              </Button>
            </>
          ) : (
            <Button variant="primary" loading={save.isPending} onClick={() => submit(false)}>
              Salvar · {totalLabel}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Título" required>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            aria-invalid={(tried && Boolean(titleError)) || undefined}
            className={tried && titleError ? invalidInput : undefined}
          />
          {tried && titleError ? <span className={fieldError}>{titleError}</span> : null}
        </Field>
        <datalist id={listId}>
          {(catalog.data ?? []).map((c) => (
            <option key={c.id} value={c.name}>
              {formatMoney(c.price)} / {c.unit}
            </option>
          ))}
        </datalist>
        <div>
          <p className="mb-1.5 text-xs font-semibold text-ink/80">
            Itens <span className="text-red-500">*</span>
          </p>
          <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {lines.map((l, i) => {
              const c = checks[i];
              const errors = tried && !c.empty ? c.errors : {};
              const n = i + 1;
              const last = i === lines.length - 1;
              return (
                <li key={l.id} className="flex flex-col gap-2 bg-surface p-3">
                  <div className="flex items-start gap-2">
                    <span className="mt-2 w-5 shrink-0 text-right text-xs font-semibold text-ink-muted tabular-nums">{n}</span>
                    <div className="min-w-0 flex-1">
                      <Input
                        list={listId}
                        value={l.description}
                        maxLength={300}
                        autoFocus={l.id === focusId}
                        placeholder="Descrição do item (digite ou escolha do catálogo)"
                        aria-label={`Item ${n}: descrição`}
                        aria-invalid={Boolean(errors.description) || undefined}
                        className={errors.description ? invalidInput : undefined}
                        onChange={(e) => {
                          const match = catalog.data?.find((item) => item.name === e.target.value);
                          setLine(
                            l.id,
                            match
                              ? {
                                  description: match.name,
                                  unit: match.unit,
                                  unit_price: moneyText(match.price),
                                  catalog_item_id: match.id,
                                  kind: match.kind ?? "product",
                                }
                              : { description: e.target.value, catalog_item_id: null },
                          );
                        }}
                      />
                      {errors.description ? <span className={fieldError}>{errors.description}</span> : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}
                      disabled={lines.length === 1}
                      className="mt-0.5 rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-red-600 disabled:opacity-30"
                      aria-label={`Remover o item ${n}`}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pl-7 sm:grid-cols-[8rem_5.5rem_5rem_7rem_minmax(0,1fr)] sm:pr-9">
                    <LineField label="Tipo" first={i === 0}>
                      <Select value={l.kind} onChange={(e) => setLine(l.id, { kind: e.target.value as QuoteItemKind })} aria-label={`Item ${n}: tipo`}>
                        {(Object.keys(QUOTE_KIND) as QuoteItemKind[]).map((k) => (
                          <option key={k} value={k}>
                            {QUOTE_KIND[k].label}
                          </option>
                        ))}
                      </Select>
                    </LineField>
                    <LineField label="Qtd." first={i === 0} error={errors.quantity}>
                      <Input
                        value={l.quantity}
                        inputMode="decimal"
                        aria-label={`Item ${n}: quantidade`}
                        aria-invalid={Boolean(errors.quantity) || undefined}
                        className={errors.quantity ? invalidInput : undefined}
                        onChange={(e) => setLine(l.id, { quantity: e.target.value })}
                      />
                    </LineField>
                    <LineField label="Unid." first={i === 0}>
                      <Input value={l.unit} maxLength={20} aria-label={`Item ${n}: unidade`} onChange={(e) => setLine(l.id, { unit: e.target.value })} />
                    </LineField>
                    <LineField label="Valor unit. (R$)" first={i === 0} error={errors.unit_price}>
                      <Input
                        value={l.unit_price}
                        inputMode="decimal"
                        placeholder="0,00"
                        aria-label={`Item ${n}: valor unitário`}
                        aria-invalid={Boolean(errors.unit_price) || undefined}
                        className={errors.unit_price ? invalidInput : undefined}
                        onChange={(e) => setLine(l.id, { unit_price: e.target.value })}
                        onKeyDown={(e) => {
                          // Enter no valor do último item abre o próximo.
                          if (e.key === "Enter" && last) {
                            e.preventDefault();
                            addLine();
                          }
                        }}
                      />
                    </LineField>
                    <div className="col-span-2 flex items-end justify-between gap-2 sm:col-span-1 sm:flex-col sm:items-end sm:justify-end">
                      <span className={clsx("text-[11px] font-semibold text-ink/80", i > 0 && "sm:sr-only")}>Total</span>
                      <span className="text-sm font-semibold text-ink tabular-nums sm:leading-9">
                        {formatMoney(c.quantity !== null && c.price !== null ? lineTotalCents(c.quantity, c.price) / 100 : 0)}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          {tried && itemsError ? <p className={clsx(fieldError, "mt-1")}>{itemsError}</p> : null}
        </div>
        <Button size="sm" className="self-start" onClick={addLine}>
          <Plus className="size-4" />
          Adicionar item
        </Button>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Desconto (R$)">
            <Input
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              inputMode="decimal"
              placeholder="0,00"
              aria-invalid={(tried && Boolean(discountError)) || undefined}
              className={tried && discountError ? invalidInput : undefined}
            />
            {tried && discountError ? <span className={fieldError}>{discountError}</span> : null}
          </Field>
          <Field label="Válido até" hint={validUntil ? undefined : "Sem data: o orçamento não vence."}>
            <Input
              type="date"
              min={today}
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              aria-invalid={Boolean(dateError) || undefined}
              className={dateError ? invalidInput : undefined}
            />
            {dateError ? <span className={fieldError}>{dateError}</span> : null}
          </Field>
          <div className="flex flex-col justify-end gap-0.5 rounded-lg bg-surface-2 px-3 py-2 text-sm tabular-nums">
            <span className="text-xs text-ink-muted">Subtotal {formatMoney(subtotalCents / 100)}</span>
            {discountCents > 0 ? <span className="text-xs text-ink-muted">Desconto −{formatMoney(discountCents / 100)}</span> : null}
            <span className="text-lg font-semibold text-ink">{totalLabel}</span>
          </div>
        </div>
        {initial.expiredOn ? (
          <p className="flex items-start gap-1.5 text-xs text-ink-muted">
            <Info className="mt-px size-3.5 shrink-0" />
            A validade anterior ({formatDate(initial.expiredOn)}) já passou: a nova é {formatDate(validUntil || null)}. Ajuste se precisar.
          </p>
        ) : null}
        <Field label="Condições" hint={`Prazo de execução, forma de pagamento, garantia... (${notes.length}/5000)`}>
          <Textarea rows={3} value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {tried && problems.length ? <ErrorBox message={`Confira antes de salvar: ${problems.join(" · ")}`} /> : null}
        {save.error ? <ErrorBox message={errorMessage(save.error)} /> : null}
      </div>
    </Dialog>
  );
}

/** Link do orçamento para o cliente: copiar, WhatsApp, e-mail ou gerar um novo (o anterior para de valer). */
export function ShareDialog({
  ticket,
  quote,
  onClose,
  onRotated,
}: {
  ticket: Pick<QuoteTicketRef, "code">;
  quote: Quote;
  onClose: () => void;
  onRotated: () => void;
}) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const [copied, setCopied] = useState<"link" | "message" | null>(null);
  const [current, setCurrent] = useState(quote);
  const urlField = useRef<HTMLInputElement>(null);
  const rotate = useMutation({
    mutationFn: () => api.post<QuoteLink>(`/quotes/${quote.id}/link/rotate`),
    onSuccess: (link) => {
      setCurrent((q) => ({ ...q, link, token: link.token }));
      setCopied(null);
      onRotated();
      toast({ title: "Novo link gerado", description: "O link anterior parou de funcionar.", tone: "success" });
    },
  });
  const url = linkOf(current);
  const message = url ? shareMessage(current, ticket.code, url) : "";

  const copy = async (what: "link" | "message") => {
    if (!url) return;
    if (await copyText(what === "link" ? url : message)) {
      setCopied(what);
      toast({ title: what === "link" ? "Link copiado" : "Mensagem copiada", description: "Cole na conversa com o cliente.", tone: "success" });
      return;
    }
    toast({ title: "Não foi possível copiar", description: "Selecione o link e copie com Ctrl+C.", tone: "error" });
    urlField.current?.select();
  };

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
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 py-1.5 pr-1.5 pl-3 focus-within:ring-2 focus-within:ring-brand/45">
            <input
              ref={urlField}
              readOnly
              value={url}
              aria-label={`Link do ${quote.code} para o cliente`}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 truncate bg-transparent text-xs text-ink-muted outline-none"
            />
            <Button size="sm" variant="primary" onClick={() => copy("link")}>
              {copied === "link" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied === "link" ? "Copiado" : "Copiar link"}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={whatsappUrl(null, message)} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "sm")}>
              <MessageCircle className="size-3.5" />
              WhatsApp
            </a>
            <a
              href={`mailto:?subject=${encodeURIComponent(`Orçamento ${quote.code} · ${quote.title}`)}&body=${encodeURIComponent(message)}`}
              className={buttonClassName("secondary", "sm")}
            >
              <Mail className="size-3.5" />
              E-mail
            </a>
            <a href={current.link?.path ?? url} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "sm")}>
              <ExternalLink className="size-3.5" />
              Ver como o cliente
            </a>
          </div>
          <div className="rounded-lg border border-line bg-surface-2/40 p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-ink/80">Mensagem que vai junto</span>
              <Button size="sm" variant="ghost" onClick={() => copy("message")}>
                {copied === "message" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied === "message" ? "Copiada" : "Copiar mensagem"}
              </Button>
            </div>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-muted">{message}</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <p className="text-xs text-ink-muted">O link fica aqui para copiar de novo quando precisar.</p>
            <Button
              size="sm"
              variant="ghost"
              loading={rotate.isPending}
              onClick={async () =>
                (await confirm({
                  title: "Gerar um novo link?",
                  description: "O link já enviado ao cliente para de funcionar.",
                  confirmLabel: "Gerar novo link",
                  tone: "danger",
                })) && rotate.mutate()
              }
            >
              {rotate.isPending ? null : <RefreshCw className="size-3.5" />}
              Gerar novo link
            </Button>
          </div>
          {rotate.error ? <ErrorBox message={errorMessage(rotate.error)} /> : null}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">Envie o orçamento para gerar o link do cliente.</p>
      )}
    </Dialog>
  );
}

/** Texto que acompanha o link: pede a aprovação (com a validade) ou, já respondido, só envia para consulta. */
function shareMessage(q: Quote, ticketCode: string, url: string): string {
  const which = `o orçamento ${q.code} (${q.title}), da OS ${ticketCode}`;
  if (q.status === "approved" || q.status === "rejected") {
    const verb = q.status === "approved" ? "aprovado" : "recusado";
    return `Olá! Segue ${which}, ${verb}${q.decided_at ? ` em ${formatDate(q.decided_at)}` : ""}. Para consultar: ${url}`;
  }
  const validity = q.valid_until ? ` Válido até ${formatDate(q.valid_until)}.` : "";
  return `Olá! Segue ${which}, no valor de ${formatMoney(q.total)}.${validity} Para aprovar com sua assinatura (ou recusar com o motivo), acesse: ${url}`;
}

