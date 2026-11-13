"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CalendarClock, Download, FileText, Link2, Loader2, Plus, Search, Send, Share2, SquarePen } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Tabs } from "@/components/motion";
import { QUOTE_EDITABLE, QuoteViewer } from "@/components/quotes/QuoteViewer";
import { QuoteEditor, type QuotePrefill, type QuoteTicketRef, ShareDialog } from "@/components/ticket/QuotesCard";
import { TicketLink } from "@/components/ticket/TicketLink";
import { useToast } from "@/components/Toaster";
import { useNow } from "@/components/useNow";
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Pill,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, STATUS } from "@/lib/constants";
import { downloadCsv } from "@/lib/download";
import { dayKey, formatDate, formatMoney, moneyInput, OPERATION_TZ, todayISO } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { QUOTE_KIND, QUOTE_STATUS, QUOTE_VALID_DAYS, readDecimal } from "@/lib/quotes";
import type { Page, Quote, QuoteCatalogItem, QuoteItemKind, QuoteListRow, QuoteStatus, TicketListItem } from "@/lib/types";

type Tab = "quotes" | "catalog";

/** A API devolve no máximo 500 orçamentos por consulta (os mais novos do período). */
const LIST_LIMIT = 500;
const RECENT = "90d";
const ALL = "all";
const NEUTRAL = "#64748b";
const CHIPS: { key: QuoteStatus; label: string }[] = [
  { key: "draft", label: "Rascunhos" },
  { key: "sent", label: "Aguardando cliente" },
  { key: "approved", label: "Aprovados" },
  { key: "expired", label: "Vencidos" },
  { key: "rejected", label: "Recusados" },
  { key: "cancelled", label: "Cancelados" },
];
const KINDS = Object.keys(QUOTE_KIND) as QuoteItemKind[];

const intFmt = (n: number) => n.toLocaleString("pt-BR");
const plural = (n: number, one: string, many: string) => `${intFmt(n)} ${n === 1 ? one : many}`;
const csvMoney = (v: number) => v.toFixed(2).replace(".", ",");
/** Sem acento e em minúsculas: a busca acha "Joao" em "João". */
const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const matches = (term: string, text: string) => term.split(/\s+/).every((word) => normalize(text).includes(word));
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: OPERATION_TZ }).format(new Date(iso));

/** Últimos 24 meses ("2026-11", "Novembro de 2026"), do atual para trás. */
function monthOptions(): { value: string; label: string }[] {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: OPERATION_TZ }).format(new Date()).split("-").map(Number);
  return Array.from({ length: 24 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 15));
    const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
    return { value: d.toISOString().slice(0, 7), label: label.charAt(0).toUpperCase() + label.slice(1) };
  });
}

const OFFSET = new Intl.DateTimeFormat("en-US", { timeZone: OPERATION_TZ, timeZoneName: "longOffset" });

/** Meia-noite do dia no fuso da operação, ex.: "2026-11-01T00:00:00-03:00". */
function midnight(day: string): string {
  const zone = OFFSET.formatToParts(new Date(`${day}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${day}T00:00:00${/GMT([+-]\d{2}:\d{2})/.exec(zone)?.[1] ?? "-03:00"}`;
}

/** Período pela criação do orçamento: últimos 90 dias, um mês ou tudo. */
function periodRange(period: string): { start?: string; end?: string } {
  if (period === ALL) return {};
  if (period === RECENT) return { start: new Date(Date.now() - 90 * 86_400_000).toISOString() };
  const [y, m] = period.split("-").map(Number);
  return { start: midnight(`${period}-01`), end: midnight(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)) };
}

/** Dias de `from` até `to` ("AAAA-MM-DD"); negativo quando `to` já passou. */
function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** O dia do calendário `days` dias depois de `day` ("AAAA-MM-DD"). */
function shiftDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Validade vencida num orçamento que ainda dá para mexer (rascunho, enviado ou vencido): o envio seria
 * recusado, o caminho é renovar a data. A validade é dia do calendário no fuso da operação, como na API.
 */
const needsRenew = (q: QuoteListRow, today: string) =>
  QUOTE_EDITABLE.includes(q.status) && (q.status === "expired" || Boolean(q.valid_until && q.valid_until < today));

/** O cliente já recebeu o link alguma vez (o rascunho em revisão também já foi enviado). */
const sentBefore = (q: QuoteListRow) => q.status !== "draft" || Boolean(q.sent_at);

/** Cliente e local (loja) da OS, numa linha. */
const placeOf = (q: QuoteListRow) => [q.customer, q.location].filter(Boolean).join(" · ");

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

/** A aba fica na URL (?aba=itens), sem navegar e mantendo a OS aberta no painel (?os=). */
function setParams(patch: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  const state = window.history.state as { mfPanel?: string } | null;
  window.history.replaceState(state?.mfPanel ? { mfPanel: state.mfPanel } : null, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function QuotesPage() {
  const { user } = useAuth();
  if (user && !canManageTickets(user.role)) return <ErrorBox message="Orçamentos são da gestão." />;
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Orçamentos" description="Orçamentos enviados aos clientes a partir das OS, e os itens com preço para montá-los." />
      {/* useSearchParams pede um Suspense em volta. */}
      <Suspense fallback={<LoadingBlock />}>
        <QuotesTabs />
      </Suspense>
    </div>
  );
}

function QuotesTabs() {
  const tab: Tab = useSearchParams().get("aba") === "itens" ? "catalog" : "quotes";
  return (
    <>
      <div className="mb-4 border-b border-line">
        <Tabs<Tab>
          className="-mb-px"
          items={[
            { key: "quotes", label: "Orçamentos" },
            { key: "catalog", label: "Itens e preços" },
          ]}
          value={tab}
          onChange={(key) => setParams({ aba: key === "catalog" ? "itens" : null })}
          ariaLabel="Orçamentos"
          idPrefix="orcamentos"
        />
      </div>
      <div role="tabpanel" id={`orcamentos-panel-${tab}`} aria-labelledby={`orcamentos-tab-${tab}`}>
        {tab === "quotes" ? <QuoteList /> : <Catalog />}
      </div>
    </>
  );
}

/** Botão quadrado das ações da linha (mesmo padrão do lápis das listas de OS). */
function RowAction({
  label,
  onClick,
  disabled,
  loading,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // A linha inteira abre o orçamento: o botão vale sozinho.
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled || loading}
      aria-label={label}
      title={label}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1 transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft active:translate-y-px disabled:pointer-events-none disabled:opacity-50"
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : children}
    </button>
  );
}

/** Filtro de situação com a contagem (e o valor, onde importa). */
function StatusChip({
  active,
  label,
  count,
  amount,
  color,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  amount?: number;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm shadow-elev-1 transition-[border-color,background-color] duration-150",
        active ? "border-brand bg-brand-soft ring-2 ring-brand/15" : "border-line bg-surface hover:border-line-strong",
      )}
    >
      {color ? <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden /> : null}
      <span className="font-medium text-ink">{label}</span>
      <span className="font-semibold text-ink tabular-nums">{intFmt(count)}</span>
      {amount !== undefined ? <span className="text-ink-muted tabular-nums">· {formatMoney(amount)}</span> : null}
    </button>
  );
}

/** Validade; no enviado, quanto falta (âmbar a 2 dias ou menos, vermelho quando passou). */
function Validity({ quote, today }: { quote: QuoteListRow; today: string }) {
  if (!quote.valid_until) return <span className="text-ink-muted">Sem validade</span>;
  const date = formatDate(quote.valid_until);
  if (quote.status !== "sent") return <span className="text-ink-muted">{date}</span>;
  const days = daysBetween(today, quote.valid_until);
  const text =
    days < 0 ? `venceu há ${plural(-days, "dia", "dias")}` : days === 0 ? "vence hoje" : days === 1 ? "vence amanhã" : `vence em ${days} dias`;
  return (
    <>
      <span className="block text-ink">{date}</span>
      <span
        className={clsx(
          "block text-[11px]",
          days < 0 ? "font-semibold text-red-600 dark:text-red-400" : days <= 2 ? "font-semibold text-amber-700 dark:text-amber-400" : "text-ink-muted",
        )}
      >
        {text}
      </span>
    </>
  );
}

/** Quem respondeu e quando; ou quando foi enviado. */
function statusDetail(q: QuoteListRow): string | null {
  if ((q.status === "approved" || q.status === "rejected") && q.decided_at) return `por ${q.approver_name ?? "cliente"} · ${shortDate(q.decided_at)}`;
  if ((q.status === "sent" || q.status === "expired") && q.sent_at) return `enviado ${shortDate(q.sent_at)}`;
  if (q.status === "draft") return q.sent_at ? "em revisão: reenvie" : "não enviado";
  return null;
}

const ticketOf = (q: QuoteListRow): QuoteTicketRef => ({
  id: q.ticket_id,
  code: q.ticket_code,
  title: q.title,
  customer: q.customer ? { name: q.customer } : null,
});

/** O orçamento recém-salvo no formato da lista (para abrir a visualização ou o link na hora). */
const rowOf = (saved: Quote, ticket: QuoteTicketRef): QuoteListRow => ({
  ...saved,
  ticket_code: ticket.code,
  customer: ticket.customer?.name ?? null,
});

function QuoteList() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const now = useNow(60_000);
  const today = dayKey(now);
  const months = useMemo(() => monthOptions(), []);
  const [period, setPeriod] = useState(RECENT);
  const [status, setStatus] = useState<QuoteStatus | "">("");
  const [search, setSearch] = useState("");
  const term = useDebounced(normalize(search.trim()), 200);
  // Guardam a linha do clique; a tela usa a versão mais nova da lista (o cliente pode responder com a janela aberta).
  const [opened, setOpened] = useState<QuoteListRow | null>(null);
  const [editing, setEditing] = useState<QuoteListRow | null>(null);
  const [sharing, setSharing] = useState<QuoteListRow | null>(null);
  const [renewing, setRenewing] = useState<QuoteListRow | null>(null);
  const [picking, setPicking] = useState(false);
  // Orçamento novo: escolhido pela OS (Novo orçamento) ou cópia de outro (Duplicar).
  const [creating, setCreating] = useState<{ ticket: QuoteTicketRef; prefill?: QuotePrefill } | null>(null);
  // Sem a situação na consulta: os contadores somam o período inteiro e a situação filtra aqui.
  const quotes = useQuery({
    queryKey: ["quotes", period],
    queryFn: ({ signal }) => api.get<QuoteListRow[]>("/quotes", periodRange(period), { signal }),
    placeholderData: keepPreviousData,
  });
  const refresh = (ticketId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["quotes"] });
    void queryClient.invalidateQueries({ queryKey: ["ticket", ticketId, "quotes"] });
  };
  // Enviar (ou gerar o link de um enviado sem link) e já abrir o compartilhamento.
  const send = useMutation({
    mutationFn: (q: QuoteListRow) => api.post<Quote>(`/quotes/${q.id}/send`),
    onSuccess: (saved, q) => {
      refresh(q.ticket_id);
      setOpened(null);
      setSharing({ ...q, ...saved });
    },
    onError: (e) => toast({ title: "Não foi possível enviar", description: errorMessage(e), tone: "error" }),
  });
  const rows = quotes.data;
  const summary = useMemo(() => {
    const by = Object.fromEntries(CHIPS.map(({ key }) => [key, { count: 0, total: 0 }])) as Record<QuoteStatus, { count: number; total: number }>;
    for (const q of rows ?? []) {
      by[q.status].count += 1;
      by[q.status].total += q.total;
    }
    // Taxa de aprovação: aprovados sobre os que tiveram desfecho (aprovado, recusado ou vencido).
    const decided = by.approved.count + by.rejected.count + by.expired.count;
    return { by, count: rows?.length ?? 0, rate: decided ? Math.round((by.approved.count / decided) * 100) : null };
  }, [rows]);
  const visible = useMemo(
    () =>
      (rows ?? []).filter(
        (q) =>
          (!status || q.status === status) &&
          (!term || matches(term, `${q.code} ${q.ticket_code} ${q.title} ${q.customer ?? ""} ${q.location ?? ""}`)),
      ),
    [rows, status, term],
  );
  const latest = (q: QuoteListRow | null) => (q ? (rows?.find((r) => r.id === q.id) ?? q) : null);
  const openedQuote = latest(opened);
  const sharingQuote = latest(sharing);
  const filtered = Boolean(status || search.trim());
  const periodSlug = period === RECENT ? "ultimos-90-dias" : period === ALL ? "todo-periodo" : period;

  const exportCsv = () =>
    downloadCsv(`orcamentos-${periodSlug}.csv`, [
      ["orcamento", "os", "cliente", "local", "titulo", "situacao", "total", "validade", "criado_em", "criado_por", "enviado_em", "respondido_em", "respondido_por", "motivo_recusa"],
      ...visible.map((q) => [
        q.code,
        q.ticket_code,
        q.customer ?? "",
        q.location ?? "",
        q.title,
        QUOTE_STATUS[q.status].label,
        csvMoney(q.total),
        q.valid_until ? formatDate(q.valid_until) : "",
        formatDate(q.created_at),
        q.created_by?.name ?? "",
        q.sent_at ? formatDate(q.sent_at) : "",
        q.decided_at ? formatDate(q.decided_at) : "",
        q.decided_at ? (q.approver_name ?? "") : "",
        q.rejection_reason ?? "",
      ]),
    ]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nº, OS, cliente, loja ou título"
            aria-label="Buscar orçamentos"
            className="pl-9"
          />
        </div>
        <Select value={period} onChange={(e) => setPeriod(e.target.value)} className="w-full sm:w-52" aria-label="Período">
          <option value={RECENT}>Últimos 90 dias</option>
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
          <option value={ALL}>Todo o período</option>
        </Select>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button disabled={!visible.length} onClick={exportCsv}>
            <Download className="size-4" />
            Exportar CSV
          </Button>
          <Button variant="primary" onClick={() => setPicking(true)}>
            <Plus className="size-4" />
            Novo orçamento
          </Button>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Situação">
        <StatusChip active={status === ""} label="Todos" count={summary.count} onClick={() => setStatus("")} />
        {CHIPS.map((c) => (
          <StatusChip
            key={c.key}
            active={status === c.key}
            label={c.label}
            count={summary.by[c.key].count}
            amount={c.key === "sent" || c.key === "approved" ? summary.by[c.key].total : undefined}
            color={QUOTE_STATUS[c.key].color}
            onClick={() => setStatus(status === c.key ? "" : c.key)}
          />
        ))}
        {summary.rate !== null ? (
          <span className="text-xs text-ink-muted sm:ml-auto" title="Aprovados sobre os aprovados, recusados e vencidos do período">
            Taxa de aprovação <strong className="font-semibold text-ink">{summary.rate}%</strong>
          </span>
        ) : null}
      </div>
      {rows && rows.length >= LIST_LIMIT ? (
        <p className="mb-3 text-xs text-ink-muted">
          Mostrando os {intFmt(LIST_LIMIT)} orçamentos mais recentes do período: escolha um mês para ver todos.
        </p>
      ) : null}
      <Card>
        {quotes.isLoading ? (
          <LoadingBlock />
        ) : quotes.error && !rows ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(quotes.error)} onRetry={() => void quotes.refetch()} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-6" />}
            title={filtered ? "Nenhum orçamento encontrado" : "Nenhum orçamento no período"}
            description={
              filtered
                ? "Tente outra busca, outra situação ou um período maior."
                : "Crie aqui, em Novo orçamento, ou dentro da OS, no quadro Orçamentos."
            }
            action={
              filtered ? (
                <Button
                  onClick={() => {
                    setSearch("");
                    setStatus("");
                  }}
                >
                  Limpar busca e situação
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {quotes.error ? (
              <div className="p-4 pb-0">
                <ErrorBox message={errorMessage(quotes.error)} onRetry={() => void quotes.refetch()} />
              </div>
            ) : null}
            <div className={clsx("transition-opacity duration-150", quotes.isPlaceholderData && "opacity-60")} aria-busy={quotes.isFetching}>
              <Table label="Orçamentos do período">
                <thead>
                  <tr>
                    <Th>Orçamento</Th>
                    <Th>OS / cliente</Th>
                    <Th className="text-right">Total</Th>
                    <Th>Validade</Th>
                    <Th>Situação</Th>
                    <Th className="hidden lg:table-cell">Criado</Th>
                    <Th className="edit-col">Editar</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((q) => {
                    const detail = statusDetail(q);
                    const place = placeOf(q);
                    return (
                      <tr
                        key={q.id}
                        onClick={(e) => {
                          // Só o clique na própria linha (não o que vem de uma janela aberta a partir dela).
                          if (e.currentTarget.contains(e.target as Node)) setOpened(q);
                        }}
                        className="cursor-pointer transition-colors hover:bg-[var(--row-hover)]"
                      >
                        <Td className="max-w-[18rem]">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpened(q);
                            }}
                            className="block max-w-full text-left"
                            title={q.title}
                          >
                            <span className="block font-mono text-xs text-ink-subtle">{q.code}</span>
                            <span className="block truncate font-semibold text-ink hover:text-brand">{q.title}</span>
                          </button>
                        </Td>
                        <Td>
                          <TicketLink ticketId={q.ticket_id} className="font-mono text-xs text-brand hover:underline">
                            {q.ticket_code}
                          </TicketLink>
                          <span className="block max-w-44 truncate text-xs text-ink-muted xl:max-w-64" title={place || undefined}>
                            {place || "—"}
                          </span>
                        </Td>
                        <Td className="text-right font-medium whitespace-nowrap tabular-nums">{formatMoney(q.total)}</Td>
                        <Td className="text-xs whitespace-nowrap">
                          <Validity quote={q} today={today} />
                        </Td>
                        <Td className="whitespace-nowrap">
                          <Pill color={QUOTE_STATUS[q.status].color}>{QUOTE_STATUS[q.status].label}</Pill>
                          {detail ? <span className="mt-1 block text-[11px] text-ink-muted">{detail}</span> : null}
                        </Td>
                        <Td className="hidden text-xs whitespace-nowrap text-ink-muted lg:table-cell">
                          {formatDate(q.created_at)}
                          {q.created_by ? ` · ${q.created_by.name.split(" ")[0]}` : ""}
                        </Td>
                        <Td className="edit-col">
                          <span className="inline-flex items-center gap-1.5">
                            {needsRenew(q, today) ? (
                              // Validade vencida: enviar seria recusado; renovar dá a data nova e envia.
                              <RowAction label={`Renovar o ${q.code} (nova validade)`} onClick={() => setRenewing(q)}>
                                <CalendarClock className="size-4" />
                              </RowAction>
                            ) : q.status === "sent" && q.link ? (
                              <RowAction label={`Link do ${q.code} para o cliente`} onClick={() => setSharing(q)}>
                                <Share2 className="size-4" />
                              </RowAction>
                            ) : q.status === "draft" || q.status === "sent" ? (
                              <RowAction
                                label={q.status === "draft" ? `Enviar o ${q.code} ao cliente` : `Gerar o link do ${q.code}`}
                                loading={send.isPending && send.variables?.id === q.id}
                                disabled={send.isPending}
                                onClick={() => send.mutate(q)}
                              >
                                <Send className="size-4" />
                              </RowAction>
                            ) : (q.status === "approved" || q.status === "rejected") && q.link ? (
                              // Já respondido: o link mostra ao cliente o documento com a decisão.
                              <RowAction label={`Link do ${q.code} (já respondido)`} onClick={() => setSharing(q)}>
                                <Link2 className="size-4" />
                              </RowAction>
                            ) : (
                              <span className="size-8" aria-hidden />
                            )}
                            {QUOTE_EDITABLE.includes(q.status) ? (
                              <RowAction label={`Editar o ${q.code}`} onClick={() => setEditing(q)}>
                                <SquarePen className="size-4" />
                              </RowAction>
                            ) : (
                              <span className="size-8" aria-hidden />
                            )}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          </>
        )}
      </Card>
      {openedQuote ? (
        <QuoteViewer
          quote={openedQuote}
          ticket={{ id: openedQuote.ticket_id, code: openedQuote.ticket_code, customer: openedQuote.customer }}
          onClose={() => setOpened(null)}
          onEdit={() => {
            setOpened(null);
            setEditing(openedQuote);
          }}
          // Validade vencida: a visualização oferece "Renovar" no lugar de enviar (o envio seria recusado).
          onRenew={() => {
            setOpened(null);
            setRenewing(openedQuote);
          }}
          onSend={() => send.mutate(openedQuote)}
          sending={send.isPending}
          onShare={() => {
            setOpened(null);
            setSharing(openedQuote);
          }}
          onDuplicate={() => {
            setOpened(null);
            setCreating({ ticket: ticketOf(openedQuote), prefill: duplicateOf(openedQuote) });
          }}
        />
      ) : null}
      {editing ? (
        <QuoteEditor
          ticket={ticketOf(editing)}
          quote={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, sending) => {
            refresh(editing.ticket_id);
            // "Salvar e enviar": o envio abre o link do cliente em seguida.
            if (sending) return;
            toast({
              title: `${saved.code} salvo`,
              description: editing.status === "sent" ? "Envie de novo para o cliente responder a versão nova." : undefined,
              tone: "success",
            });
            // Volta para a visualização: dali já dá para enviar ao cliente.
            setOpened({ ...editing, ...saved });
          }}
          onSend={(saved) => send.mutate({ ...editing, ...saved })}
        />
      ) : null}
      {sharingQuote ? (
        <ShareDialog
          ticket={{ code: sharingQuote.ticket_code }}
          quote={sharingQuote}
          onClose={() => setSharing(null)}
          onRotated={() => refresh(sharingQuote.ticket_id)}
        />
      ) : null}
      {renewing ? (
        <RenewDialog
          quote={renewing}
          onClose={() => setRenewing(null)}
          onDone={(saved) => {
            const quote = renewing;
            setRenewing(null);
            refresh(quote.ticket_id);
            toast({
              title: `${saved.code} renovado e enviado`,
              description: sentBefore(quote) ? "O link é o mesmo: mande de novo para o cliente." : "Mande o link para o cliente.",
              tone: "success",
            });
            setSharing({ ...quote, ...saved });
          }}
        />
      ) : null}
      {picking ? (
        <PickTicketDialog
          onClose={() => setPicking(false)}
          onPick={(ticket) => {
            setPicking(false);
            setCreating({ ticket });
          }}
        />
      ) : null}
      {creating ? (
        <QuoteEditor
          ticket={creating.ticket}
          quote={null}
          prefill={creating.prefill}
          onClose={() => setCreating(null)}
          onSaved={(saved, sending) => {
            refresh(creating.ticket.id);
            if (sending) return;
            toast({ title: `${saved.code} criado`, description: "Confira e envie ao cliente.", tone: "success" });
            setOpened(rowOf(saved, creating.ticket));
          }}
          onSend={(saved) => send.mutate(rowOf(saved, creating.ticket))}
        />
      ) : null}
    </>
  );
}

/** Orçamento com a validade vencida: data nova e envio (quem já tinha o link continua com o mesmo). */
function RenewDialog({ quote, onClose, onDone }: { quote: QuoteListRow; onClose: () => void; onDone: (saved: Quote) => void }) {
  // A validade é dia do calendário no fuso da operação, como a API confere.
  const today = todayISO();
  const [date, setDate] = useState(() => shiftDays(today, QUOTE_VALID_DAYS));
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today;
  const wasSent = sentBefore(quote);
  const renew = useMutation({
    mutationFn: async () => {
      // Salvar volta o orçamento a rascunho com a validade nova; o envio o devolve ao cliente.
      await api.put<Quote>(`/quotes/${quote.id}`, {
        title: quote.title,
        items: quote.items.map((i) => ({
          description: i.description,
          quantity: i.quantity,
          unit: i.unit,
          unit_price: i.unit_price,
          catalog_item_id: i.catalog_item_id,
          kind: i.kind ?? "product",
        })),
        discount: quote.discount,
        valid_until: date,
        notes: quote.notes,
      });
      return api.post<Quote>(`/quotes/${quote.id}/send`);
    },
    onSuccess: onDone,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Renovar o ${quote.code}`}
      description={
        wasSent
          ? `Venceu${quote.valid_until ? ` em ${formatDate(quote.valid_until)}` : ""} sem resposta. Com a validade nova, ele volta para o cliente no mesmo link.`
          : `A validade${quote.valid_until ? ` (${formatDate(quote.valid_until)})` : ""} passou antes do envio. Com a data nova, ele vai para o cliente.`
      }
      busy={renew.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={renew.isPending}>
            Cancelar
          </Button>
          <Button type="submit" form="renew-quote" variant="primary" disabled={!valid} loading={renew.isPending}>
            {renew.isPending ? null : <Send className="size-4" />}
            {wasSent ? "Renovar e reenviar" : "Renovar e enviar"}
          </Button>
        </>
      }
    >
      <form
        id="renew-quote"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) renew.mutate();
        }}
      >
        <Field label="Nova validade" required hint={valid ? "O cliente pode aprovar até esse dia." : "Escolha hoje ou uma data futura."}>
          <Input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} autoFocus />
        </Field>
        {renew.error ? (
          <div className="mt-3">
            <ErrorBox message={errorMessage(renew.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Novo orçamento pela tela de Orçamentos: primeiro a OS (pedido que chegou pelo WhatsApp, por exemplo). */
function PickTicketDialog({ onClose, onPick }: { onClose: () => void; onPick: (ticket: QuoteTicketRef) => void }) {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 300);
  const ready = q.length >= 2 || /^\d+$/.test(q);
  const results = useQuery({
    queryKey: ["quote-ticket-search", q],
    queryFn: ({ signal }) => api.get<Page<TicketListItem>>("/tickets", { q, page_size: 8 }, { signal }),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
  const items = results.data?.items ?? [];
  return (
    <Dialog open onClose={onClose} title="Novo orçamento" description="De qual OS? Busque pelo número, cliente, loja ou título.">
      <Input
        type="search"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ex.: 1234 ou o nome do cliente"
        aria-label="Buscar OS"
      />
      <div className="mt-3 max-h-[22rem] overflow-y-auto" aria-live="polite">
        {!ready ? (
          <p className="py-2 text-sm text-ink-muted">Digite o número da OS ou pelo menos 2 letras.</p>
        ) : results.error ? (
          <ErrorBox message={errorMessage(results.error)} onRetry={() => void results.refetch()} />
        ) : results.isLoading ? (
          <LoadingBlock rows={2} />
        ) : items.length === 0 ? (
          <p className="py-2 text-sm text-ink-muted">Nenhuma OS encontrada.</p>
        ) : (
          <ul
            className={clsx(
              "divide-y divide-line overflow-hidden rounded-lg border border-line transition-opacity duration-150",
              results.isPlaceholderData && "opacity-60",
            )}
          >
            {items.map((t) => {
              // A API recusa orçamento em OS cancelada: ela aparece, mas não dá para escolher.
              const cancelled = t.status === "cancelled";
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={cancelled}
                    onClick={() => onPick({ id: t.id, code: t.code, title: t.title, customer: t.customer })}
                    className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--row-hover)] focus-visible:bg-[var(--row-hover)] focus-visible:outline-none disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    <span className="min-w-0">
                      <span className="block font-mono text-xs text-ink-subtle">{t.code}</span>
                      <span className="block truncate text-sm font-semibold text-ink">{t.title}</span>
                      <span className="block truncate text-xs text-ink-muted">
                        {cancelled
                          ? "OS cancelada: reabra a OS para fazer orçamento"
                          : [t.customer?.name, t.location?.name].filter(Boolean).join(" · ") || "Sem cliente"}
                      </span>
                    </span>
                    <Pill color={STATUS[t.status].color} className="shrink-0">
                      {STATUS[t.status].label}
                    </Pill>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function Catalog() {
  const [editing, setEditing] = useState<QuoteCatalogItem | "new" | null>(null);
  const [search, setSearch] = useState("");
  const term = useDebounced(normalize(search.trim()), 200);
  const [active, setActive] = useState<"active" | "inactive" | "all">("active");
  const [kind, setKind] = useState<QuoteItemKind | "">("");
  const items = useQuery({ queryKey: ["quote-items"], queryFn: ({ signal }) => api.get<QuoteCatalogItem[]>("/quote-items", undefined, { signal }) });
  const list = items.data;
  const activeCount = useMemo(() => (list ?? []).filter((i) => i.is_active).length, [list]);
  const visible = useMemo(
    () =>
      (list ?? []).filter(
        (i) =>
          (active === "all" || i.is_active === (active === "active")) &&
          (!kind || (i.kind ?? "product") === kind) &&
          (!term || matches(term, `${i.name} ${i.description ?? ""}`)),
      ),
    [list, active, kind, term],
  );
  const filtered = Boolean(search.trim() || kind || active !== "active");
  return (
    <Card>
      <CardHeader
        title="Itens e preços"
        description={
          list ? `${plural(activeCount, "item ativo", "itens ativos")} · o preço é a referência (dá para mudar no orçamento)` : "Material e serviços com preço de referência"
        }
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            Novo item
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" aria-hidden />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar item" aria-label="Buscar item" className="pl-9" />
        </div>
        <Select
          value={active}
          onChange={(e) => setActive(e.target.value as "active" | "inactive" | "all")}
          className="w-full sm:w-36"
          aria-label="Situação do item"
        >
          <option value="active">Ativos</option>
          <option value="inactive">Inativos</option>
          <option value="all">Todos</option>
        </Select>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tipo do item">
          {([["", "Todos os tipos"], ...KINDS.map((k) => [k, QUOTE_KIND[k].plural])] as [QuoteItemKind | "", string][]).map(([key, label]) => (
            <button
              key={key || "all"}
              type="button"
              aria-pressed={kind === key}
              onClick={() => setKind(key)}
              className={clsx(
                "h-8 rounded-lg border px-3 text-xs font-medium transition-[border-color,background-color] duration-150",
                kind === key ? "border-brand bg-brand-soft text-ink ring-2 ring-brand/15" : "border-line bg-surface text-ink-muted hover:border-line-strong hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {items.isLoading ? (
        <LoadingBlock />
      ) : items.error ? (
        <div className="p-4">
          <ErrorBox message={errorMessage(items.error)} onRetry={() => void items.refetch()} />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          title={filtered ? "Nenhum item encontrado" : "Nenhum item"}
          description={filtered ? "Tente outra busca ou outro filtro." : "Ex.: Velcro 3 m, Conector RJ45, Hora técnica."}
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch("");
                  setKind("");
                  setActive("active");
                }}
              >
                Limpar filtros
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table label="Itens e preços">
          <thead>
            <tr>
              <Th>Item</Th>
              <Th>Tipo</Th>
              <Th>Unidade</Th>
              <Th className="text-right">Preço</Th>
              <Th className="edit-col">Editar</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => (
              <tr
                key={i.id}
                onClick={(e) => {
                  if (e.currentTarget.contains(e.target as Node)) setEditing(i);
                }}
                className="cursor-pointer transition-colors hover:bg-[var(--row-hover)]"
              >
                <Td className="max-w-[26rem]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold text-ink" title={i.name}>
                      {i.name}
                    </span>
                    {i.is_active ? null : <Pill color={NEUTRAL}>Inativo</Pill>}
                  </span>
                  {i.description ? (
                    <span className="block truncate text-xs text-ink-muted" title={i.description}>
                      {i.description}
                    </span>
                  ) : null}
                </Td>
                <Td className="text-ink-muted">{QUOTE_KIND[i.kind ?? "product"].label}</Td>
                <Td className="text-ink-muted">{i.unit}</Td>
                <Td className="text-right whitespace-nowrap tabular-nums">{formatMoney(i.price)}</Td>
                <Td className="edit-col">
                  <RowAction label={`Editar ${i.name}`} onClick={() => setEditing(i)}>
                    <SquarePen className="size-4" />
                  </RowAction>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing ? <ItemDialog item={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function ItemDialog({ item, onClose }: { item: QuoteCatalogItem | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(item?.name ?? "");
  const [unit, setUnit] = useState(item?.unit ?? "un");
  const [kind, setKind] = useState<QuoteItemKind>(item?.kind ?? "product");
  const [price, setPrice] = useState(item ? moneyInput(item.price) : "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [active, setActive] = useState(item?.is_active ?? true);
  // Os erros aparecem depois da primeira tentativa de salvar (não enquanto a pessoa digita).
  const [tried, setTried] = useState(false);
  const priceRead = readDecimal(price, { decimals: 2, allowZero: true, emptyMessage: "Informe o preço (pode ser 0)" });
  const errors = {
    name: name.trim().length < 2 ? "Escreva o nome (pelo menos 2 letras)" : null,
    unit: unit.trim() ? null : "Informe a unidade (ex.: un, m, h)",
    price: priceRead.error,
  };
  const valid = !errors.name && !errors.unit && !errors.price;
  const shown = (key: keyof typeof errors) => (tried ? errors[key] : null);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        kind,
        unit: unit.trim(),
        price: (priceRead.value ?? 0).toFixed(2),
        description: description.trim() || null,
        is_active: active,
      };
      return item ? api.put(`/quote-items/${item.id}`, body) : api.post("/quote-items", body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["quote-items"] });
      toast({ title: item ? "Item salvo" : "Item criado", tone: "success" });
      onClose();
    },
  });
  const fieldError = (key: keyof typeof errors) =>
    shown(key) ? (
      <span role="alert" className="text-xs text-red-600 dark:text-red-400">
        {shown(key)}
      </span>
    ) : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={item ? "Editar item" : "Novo item"}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="quote-item-form" variant="primary" loading={save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="quote-item-form"
        noValidate
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (valid) save.mutate();
        }}
      >
        <Field label="Nome" required className="sm:col-span-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Velcro 3 m"
            maxLength={200}
            autoFocus
            aria-invalid={Boolean(shown("name"))}
          />
          {fieldError("name")}
        </Field>
        <Field label="Tipo">
          <Select value={kind} onChange={(e) => setKind(e.target.value as QuoteItemKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {QUOTE_KIND[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Unidade (medida)" required>
          <Input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="un, m, rolo, h"
            maxLength={20}
            aria-invalid={Boolean(shown("unit"))}
          />
          {fieldError("unit")}
        </Field>
        <Field label="Preço (R$)" required>
          <Input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            placeholder="0,00"
            aria-invalid={Boolean(shown("price"))}
          />
          {fieldError("price")}
        </Field>
        <Field label="Descrição" hint="Para a equipe: detalhes do item (não vai para o cliente)." className="sm:col-span-3">
          <Textarea rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="sm:col-span-3">
          <Checkbox label="Ativo (aparece ao montar um orçamento)" checked={active} onChange={setActive} />
        </div>
        {save.error ? (
          <div className="sm:col-span-3">
            <ErrorBox message={errorMessage(save.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
