"use client";

import { keepPreviousData, type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CheckCheck, Copy, Download, MessageCircle, RotateCcw, Wallet } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { StatTile } from "@/components/charts";
import { useConfirm } from "@/components/Confirm";
import { Tabs } from "@/components/motion";
import { NoAccess } from "@/components/NoAccess";
import { InvoiceDialog } from "@/components/payouts/InvoiceDialog";
import { type InvoiceListState, InvoicesPanel, InvoiceStrip } from "@/components/payouts/InvoicesPanel";
import { PayoutPixLine } from "@/components/payouts/PayoutPixLine";
import { TicketLink } from "@/components/ticket/TicketLink";
import { useToast } from "@/components/Toaster";
import { Button, Card, EmptyState, ErrorBox, LoadingBlock, PageHeader, Pill, Select } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { PAYOUT_STATUS, STATUS } from "@/lib/constants";
import { downloadCsv } from "@/lib/download";
import { formatDate, formatMoney } from "@/lib/format";
import {
  fetchAllInvoices,
  invoiceCsvRows,
  invoicesByTechnician,
  payInvoiceNote,
  reviewOrder,
  statementInvoiceLines,
  useInvoiceReview,
  useOpenInvoiceFile,
  useTechnicianInvoices,
} from "@/lib/invoices";
import { useCan } from "@/lib/permissions";
import { pixDay, pixRecent, pixStatementText } from "@/lib/pix";
import type {
  ExpenseReport,
  PayoutBoard,
  PayoutLine,
  PayoutList,
  PixInfo,
  TechnicianInvoice,
  TechnicianInvoiceList,
  User,
  UUID,
} from "@/lib/types";
import { copyText, WHATSAPP_TEXT_LIMIT, whatsappUrl } from "@/lib/whatsapp";

/** Abas da tela: o fechamento dos valores e as notas fiscais que os técnicos enviam pelo app. */
type Tab = "closing" | "invoices";
type View = "to_pay" | "expected" | "paid" | "all";
type Bucket = Exclude<View, "all">;
/** Onde cada valor está no fechamento: pago; OS concluída = a pagar; aberta = previsto; cancelada, à parte. */
type LineState = "paid" | "to_pay" | "expected" | "cancelled";

interface Group {
  id: UUID;
  name: string;
  lines: PayoutLine[];
}

/**
 * O fechamento em duas consultas: o que falta pagar (OS concluída, em andamento ou cancelada; cada
 * uma vai para o seu lugar pela situação da OS) e o que já foi pago. Cada consulta traz até 1.000
 * lançamentos, os mais recentes.
 */
type Source = "pending" | "paid";
const SOURCE_QUERY: Record<Source, Record<string, string>> = { pending: { status: "pending" }, paid: { status: "paid" } };
const LIMIT = 1000;
/** A API marca até 500 por chamada. */
const BATCH = 500;
const OPERATION_TZ = "America/Sao_Paulo";
const NEUTRAL = "#64748b";
const STATE_LABEL: Record<LineState, string> = { to_pay: "A pagar", expected: "Previsto", cancelled: "OS cancelada", paid: "Pago" };
const STATE_ORDER: Record<LineState, number> = { to_pay: 0, cancelled: 1, expected: 2, paid: 3 };
const SECTION: Record<Bucket, string> = { to_pay: "A pagar", paid: "Pago", expected: "Previsto (OS em andamento)" };
const VIEW_SLUG: Record<View, string> = { to_pay: "a-pagar", expected: "previsto", paid: "pago", all: "todos" };
const EMPTY: Record<View, { title: string; description: string }> = {
  to_pay: {
    title: "Nada a pagar",
    description: "As OS concluídas com valor do técnico aparecem aqui. O valor é definido na OS (aba Geral, ao lado do colaborador) ou vem do tipo de serviço.",
  },
  expected: { title: "Nada previsto", description: "As OS ainda em andamento que já têm valor do técnico aparecem aqui." },
  paid: { title: "Nenhum pagamento", description: "As OS marcadas como pagas aparecem aqui." },
  all: {
    title: "Nenhum lançamento",
    description: "O valor de cada técnico é definido na OS (aba Geral, ao lado do colaborador) ou vem do tipo de serviço.",
  },
};

const intFmt = (n: number) => n.toLocaleString("pt-BR");
const plural = (n: number, one: string, many: string) => `${intFmt(n)} ${n === 1 ? one : many}`;
/** Quantidade de uma lista cortada no limite: só das linhas que vieram ("812+ OS concluídas"). */
const countText = (n: number, one: string, many: string, partial: boolean) => (partial ? `${intFmt(n)}+ ${many}` : plural(n, one, many));
const total = (lines: PayoutLine[]) => lines.reduce((acc, l) => acc + l.amount, 0);

/** A API cortou a lista no limite: há mais lançamentos no filtro do que linhas na tela. */
function isCut(list: PayoutList | undefined): boolean {
  if (!list) return false;
  // Sem o total do filtro (servidor antigo), a lista cheia indica o corte.
  return list.total_count !== undefined ? list.total_count > list.items.length : list.items.length >= LIMIT;
}
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: OPERATION_TZ }).format(new Date(iso));

function stateOf(line: PayoutLine): LineState {
  if (line.status === "paid") return "paid";
  if (line.concluded) return "to_pay";
  return line.ticket.status === "cancelled" ? "cancelled" : "expected";
}

/** A OS cancelada vem na consulta do previsto, mas não soma nele: o valor dela é para tirar. */
function bucketOf(line: PayoutLine): Bucket {
  const state = stateOf(line);
  return state === "cancelled" ? "expected" : state;
}

/** Últimos 24 meses ("2026-11", "Novembro de 2026"), do atual para trás. */
function lastMonths(): { value: string; label: string }[] {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: OPERATION_TZ }).format(new Date()).split("-").map(Number);
  return Array.from({ length: 24 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 15));
    const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
    return { value: d.toISOString().slice(0, 7), label: label.charAt(0).toUpperCase() + label.slice(1) };
  });
}

function monthRange(month: string): { date_from?: string; date_to?: string } {
  if (!month) return {};
  const [y, m] = month.split("-").map(Number);
  return { date_from: `${month}-01`, date_to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

/**
 * Com o técnico escolhido, a API filtra (a lista e o resumo dos cartões ficam inteiros, sem o corte em 1.000).
 * `with_pix`: a chave PIX de cada técnico das linhas (e do escolhido), para pagar daqui.
 */
function usePayouts(source: Source, month: string, technicianId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["payouts", source, month, technicianId],
    queryFn: ({ signal }) =>
      api.get<PayoutBoard>(
        "/payouts",
        { ...SOURCE_QUERY[source], ...monthRange(month), technician_id: technicianId || undefined, with_pix: true },
        { signal },
      ),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Uma consulta de notas fiscais como o painel da aba recebe. */
function invoiceListState(query: UseQueryResult<TechnicianInvoiceList>): InvoiceListState {
  return {
    list: query.data,
    loading: query.isLoading,
    error: query.error,
    stale: query.isPlaceholderData,
    onRetry: () => void query.refetch(),
  };
}

/** A aba fica na URL (?aba=notas-fiscais), sem navegar e mantendo a OS aberta no painel (?os=). */
function setParams(patch: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  const state = window.history.state as { mfPanel?: string } | null;
  window.history.replaceState(state?.mfPanel ? { mfPanel: state.mfPanel } : null, "", `${url.pathname}${url.search}${url.hash}`);
}

/** Cliente, loja, cidade, onde a OS está (concluída em tal dia, ou o status) e a nota fiscal que cobre o valor. */
function subtitle(line: PayoutLine): string {
  const t = line.ticket;
  const concluded = (t.status === "resolved" || t.status === "closed") && t.resolved_at;
  const when = concluded ? `concluída em ${formatDate(t.resolved_at)}` : STATUS[t.status].label.toLowerCase();
  const invoice = line.invoice ? `NF ${line.invoice.number}` : null;
  return [t.customer, t.location, t.city, when, invoice, line.note].filter(Boolean).join(" · ");
}

/**
 * Extrato para mandar ao técnico no WhatsApp: as OS de cada situação, com o dia da conclusão e o
 * valor. No "a pagar" entram os reembolsos aprovados (custos extras), pagos no mesmo acerto. A chave PIX
 * vai junto, para ele ver onde vai receber, com CPF e CNPJ mascarados: o texto passa pelo endereço do wa.me
 * (`pix` undefined: a API não mandou a chave, a linha fica de fora). Depois do período, as notas fiscais
 * dele que valem (a recusada fica de fora).
 */
function statement(
  name: string,
  lines: PayoutLine[],
  period: string,
  reimbursement: number,
  pix: PixInfo | null | undefined,
  invoices: TechnicianInvoice[],
): string {
  const row = (l: PayoutLine) =>
    `• ${l.ticket.code}${l.ticket.resolved_at ? ` · ${shortDate(l.ticket.resolved_at)}` : ""} · ${l.ticket.location ?? l.ticket.customer ?? l.ticket.title} · ${formatMoney(l.amount)}`;
  const sections = (["to_pay", "paid", "expected"] as const)
    .map((key) => ({ key, lines: lines.filter((l) => stateOf(l) === key) }))
    .filter((s) => s.lines.length > 0);
  const out = ["*Maxx Field · pagamento*", name, `Período: ${period}`, ...statementInvoiceLines(invoices)];
  if (pix) out.push(`Chave PIX: ${pixStatementText(pix)}`);
  else if (pix === null) out.push("Chave PIX: não cadastrada (cadastre no app, em Conta › Meu cadastro)");
  for (const s of sections) {
    out.push("", `*${SECTION[s.key]}*`, ...s.lines.map(row));
    out.push(sections.length === 1 ? `*Total: ${formatMoney(total(s.lines))}*` : `Subtotal: ${formatMoney(total(s.lines))}`);
  }
  const toPay = sections.find((s) => s.key === "to_pay");
  if (toPay && reimbursement > 0) {
    out.push("", `Reembolsos aprovados (custos extras): ${formatMoney(reimbursement)}`);
    out.push(`*Total a receber: ${formatMoney(total(toPay.lines) + reimbursement)}*`);
  }
  return out.join("\n");
}

/** "Selecionar todas" de um técnico: meio marcada quando só parte está escolhida. */
function SelectAll({ checked, partial, label, onChange }: { checked: boolean; partial: boolean; label: string; onChange: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);
  return (
    <label className="-m-2 flex shrink-0 cursor-pointer p-2">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--brand)]"
        aria-label={label}
      />
    </label>
  );
}

function StatePill({ line }: { line: PayoutLine }) {
  const state = stateOf(line);
  if (state === "paid") return <Pill color={PAYOUT_STATUS.paid.color}>Pago{line.paid_at ? ` ${formatDate(line.paid_at)}` : ""}</Pill>;
  if (state === "to_pay") return <Pill color={PAYOUT_STATUS.pending.color}>{PAYOUT_STATUS.pending.label}</Pill>;
  if (state === "cancelled") return <Pill color={STATUS.cancelled.color}>OS cancelada</Pill>;
  return <Pill color={NEUTRAL}>Previsto</Pill>;
}

/**
 * Pagamentos: os técnicos são parceiros e recebem por chamado. Aqui a central vê quanto deve a cada
 * um (OS concluídas), o que ainda vai pagar (OS abertas) e marca como pago.
 */
export default function PayoutsPage() {
  // useSearchParams pede um Suspense em volta.
  return (
    <Suspense fallback={<LoadingBlock rows={4} />}>
      <PayoutsView />
    </Suspense>
  );
}

function PayoutsView() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  // Visualizar: o fechamento, as notas fiscais, o extrato e a exportação. Editar: pagar, desfazer, tirar
  // valor e conferir, desfazer a conferência ou recusar nota.
  const canView = useCan("commercial.payouts");
  const canEdit = useCan("commercial.payouts", "edit");
  // Os reembolsos de Custos extras entram no extrato só para quem tem acesso a Custos extras.
  const canExpenses = useCan("commercial.expenses");
  const canPayExpenses = useCan("commercial.expenses", "edit");
  const months = useMemo(() => lastMonths(), []);
  const [view, setView] = useState<View>("to_pay");
  // ?mes=2026-11 (o "Valor dos técnicos" do relatório mensal): abre já no mês.
  const searchParams = useSearchParams();
  const tab: Tab = searchParams.get("aba") === "notas-fiscais" ? "invoices" : "closing";
  const [month, setMonth] = useState(() => {
    const asked = searchParams.get("mes") ?? "";
    return months.some((m) => m.value === asked) ? asked : "";
  });
  // Guarda o nome junto: o técnico escolhido continua na lista mesmo num mês sem lançamentos dele.
  const [technician, setTechnician] = useState<{ id: UUID; name: string } | null>(null);
  const [selected, setSelected] = useState<Set<UUID>>(new Set());
  const technicianId = technician?.id ?? "";

  const pendingQuery = usePayouts("pending", month, technicianId, canView);
  const paidQuery = usePayouts("paid", month, technicianId, canView);
  const queries = [pendingQuery, paidQuery];
  // Notas fiscais dos técnicos, com os mesmos filtros (o mês é a competência): a aba Notas fiscais e, no
  // fechamento, a faixa de cada técnico, o aviso do Pagar e o extrato.
  const invoices = useTechnicianInvoices(month, technicianId, canView);
  // O "A conferir", com a aba aberta: consulta própria, na ordem da fila. A lista geral traz só as 500 mais
  // novas, e a nota antiga que aguarda ficaria de fora.
  const pendingInvoices = useTechnicianInvoices(month, technicianId, canView && tab === "invoices", "pending");
  // A nota aberta no diálogo (`rejecting`: aberta pelo "Recusar" da lista, já no motivo; `changedAt`: quando
  // ela voltou da API depois de conferir, desfazer ou recusar).
  const [shownInvoice, setShownInvoice] = useState<{ invoice: TechnicianInvoice; rejecting: boolean; changedAt?: number } | null>(null);
  const review = useInvoiceReview((invoice) =>
    setShownInvoice((shown) => (shown?.invoice.id === invoice.id ? { ...shown, invoice, changedAt: Date.now() } : shown)),
  );
  const openInvoiceFile = useOpenInvoiceFile(month, technicianId);
  // Exportando as notas: quantas já vieram e o total (que chega com a primeira página).
  const [exporting, setExporting] = useState<{ loaded: number; total: number } | null>(null);
  const invoiceItems = useMemo(() => invoices.data?.items ?? [], [invoices.data]);
  const pendingItems = useMemo(() => pendingInvoices.data?.items ?? [], [pendingInvoices.data]);
  const invoicesOf = useMemo(() => invoicesByTechnician(reviewOrder(invoiceItems)), [invoiceItems]);
  // O que vai no extrato e no aviso do Pagar só vale com a lista do filtro atual (não a do anterior);
  // "sem nota" só se afirma com a lista inteira (sem o corte das 500 mais novas).
  const invoicesFresh = Boolean(invoices.data) && !invoices.isPlaceholderData;
  const invoicesComplete = invoicesFresh && (invoices.data?.total_count ?? 0) <= invoiceItems.length;
  // "Chave nova" (a chave PIX mudou há menos de 7 dias) muda com o tempo.
  const now = useNow(60_000);
  // Chave PIX de cada técnico, das duas consultas. Sem o mapa (API sem a chave), nada aparece.
  const pixMap = useMemo(() => {
    const pending = pendingQuery.data?.pix;
    const paid = paidQuery.data?.pix;
    return pending || paid ? { ...paid, ...pending } : null;
  }, [pendingQuery.data, paidQuery.data]);
  // Telefone (botão do WhatsApp) e e-mail (separa técnicos com o mesmo nome).
  const people = useQuery({
    queryKey: ["users", { role: "technician", active: true }],
    queryFn: () => api.get<User[]>("/users", { role: "technician", active: true }),
    staleTime: 60_000,
  });
  // Reembolsos aprovados e ainda não pagos (custos extras), de qualquer mês: entram no mesmo acerto.
  const reimbursements = useQuery({
    queryKey: ["expenses", "approved", "all"],
    queryFn: () =>
      api.get<ExpenseReport>("/expenses", {
        status: "approved",
        start: "2020-01-01T00:00:00-03:00",
        end: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    staleTime: 60_000,
    enabled: canView && canExpenses,
  });

  const all = useMemo(() => {
    // Logo depois de pagar, a mesma linha pode vir em duas consultas (uma já recarregou, a outra não):
    // vale a da consulta mais recente.
    const sources = [
      { at: pendingQuery.dataUpdatedAt, items: pendingQuery.data?.items ?? [] },
      { at: paidQuery.dataUpdatedAt, items: paidQuery.data?.items ?? [] },
    ].sort((a, b) => a.at - b.at);
    const byId = new Map<UUID, PayoutLine>();
    for (const source of sources) for (const line of source.items) byId.set(line.id, line);
    return [...byId.values()];
  }, [pendingQuery.data, pendingQuery.dataUpdatedAt, paidQuery.data, paidQuery.dataUpdatedAt]);
  // A API já filtra pelo técnico; o filtro aqui só cobre a lista anterior enquanto a nova não chega.
  const lines = useMemo(() => (technicianId ? all.filter((l) => l.technician.id === technicianId) : all), [all, technicianId]);
  // Técnicos vistos sem o filtro (com um escolhido, a lista só traz ele): o seletor continua com todos.
  const [seen, setSeen] = useState<Record<UUID, string>>({});
  if (!technicianId) {
    const fresh = all.filter((l) => seen[l.technician.id] !== l.technician.name);
    if (fresh.length) setSeen((s) => ({ ...s, ...Object.fromEntries(fresh.map((l) => [l.technician.id, l.technician.name])) }));
  }
  // Os cartões somam pela mesma regra da API, só com o técnico escolhido.
  const byState = useMemo(() => {
    const of = (state: LineState) => lines.filter((l) => stateOf(l) === state);
    return { to_pay: of("to_pay"), expected: of("expected"), cancelled: of("cancelled"), paid: of("paid") };
  }, [lines]);
  const groups = useMemo(() => {
    const visible = view === "all" ? lines : lines.filter((l) => bucketOf(l) === view);
    const map = new Map<UUID, Group>();
    for (const line of visible) {
      const group = map.get(line.technician.id) ?? { id: line.technician.id, name: line.technician.name, lines: [] };
      group.lines.push(line);
      map.set(line.technician.id, group);
    }
    for (const group of map.values()) {
      group.lines.sort(
        (a, b) => STATE_ORDER[stateOf(a)] - STATE_ORDER[stateOf(b)] || (b.ticket.resolved_at ?? "").localeCompare(a.ticket.resolved_at ?? ""),
      );
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [lines, view]);
  const options = useMemo(() => {
    // Técnicos ativos, os das linhas e das notas fiscais (inclusive inativos) e os vistos antes de escolher um.
    const map = new Map<UUID, string>();
    for (const person of people.data ?? []) map.set(person.id, person.name);
    for (const [id, name] of Object.entries(seen)) map.set(id, name);
    for (const line of all) map.set(line.technician.id, line.technician.name);
    for (const invoice of [...invoiceItems, ...pendingItems]) map.set(invoice.technician.id, invoice.technician.name);
    if (technician && !map.has(technician.id)) map.set(technician.id, technician.name);
    const repeated = new Map<string, number>();
    for (const name of map.values()) repeated.set(name, (repeated.get(name) ?? 0) + 1);
    const emails = new Map((people.data ?? []).map((u) => [u.id, u.email]));
    return [...map.entries()]
      .map(([id, name]) => {
        const email = emails.get(id);
        return { id, name, label: (repeated.get(name) ?? 0) > 1 && email ? `${name} · ${email}` : name };
      })
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  }, [all, invoiceItems, pendingItems, technician, seen, people.data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["payouts"] });
    void queryClient.invalidateQueries({ queryKey: ["ticket"] });
  };
  // `lineId`: pagamento de uma linha só, pelo botão dela (OS cancelada); o carregamento fica nela.
  const pay = useMutation({
    mutationFn: async ({ ids, paid }: { ids: UUID[]; paid: boolean; groupId: UUID; lineId?: UUID }) => {
      let changed = 0;
      for (let i = 0; i < ids.length; i += BATCH) {
        const result = await api.post<{ changed: number }>(paid ? "/payouts/pay" : "/payouts/unpay", { ids: ids.slice(i, i + BATCH) });
        changed += result.changed;
      }
      return changed;
    },
    onSuccess: (changed, { paid }) => {
      setSelected(new Set());
      if (changed === 0) {
        toast({ title: "Nada mudou: a lista estava desatualizada", tone: "info" });
      } else {
        toast({
          title: paid
            ? plural(changed, "pagamento marcado como pago", "pagamentos marcados como pagos")
            : `${plural(changed, "pagamento voltou", "pagamentos voltaram")} para "a pagar"`,
          tone: "success",
        });
      }
    },
    onError: (error) => toast({ title: errorMessage(error), tone: "error" }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (line: PayoutLine) => api.delete(`/tickets/${line.ticket.id}/payouts/${line.technician.id}`),
    onSuccess: (_, line) => toast({ title: `Valor de ${line.technician.name} tirado da ${line.ticket.code}`, tone: "success" }),
    onError: (error) => toast({ title: errorMessage(error), tone: "error" }),
    onSettled: refresh,
  });

  const changeView = (next: View) => {
    setView(next);
    setSelected(new Set());
  };
  const changeTab = (next: Tab) => {
    setParams({ aba: next === "invoices" ? "notas-fiscais" : null });
    setSelected(new Set());
  };
  /** O "+N" da faixa de notas: a aba Notas fiscais só com o técnico. */
  const showInvoicesOf = (group: Group) => {
    setTechnician({ id: group.id, name: group.name });
    changeTab("invoices");
  };
  const toggle = (id: UUID) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const labelOf = (group: Group) => options.find((o) => o.id === group.id)?.label ?? group.name;
  const personOf = (id: UUID) => people.data?.find((u) => u.id === id);
  /** A chave PIX do técnico; null sem chave; undefined quando a API não mandou as chaves. */
  const pixOf = (id: UUID): PixInfo | null | undefined => (pixMap ? (pixMap[id] ?? null) : undefined);
  /** "Chave nova": o aviso que vai junto da confirmação do pagamento (confirmar no grupo antes de pagar). */
  const pixWarning = (group: Group) => {
    const pix = pixOf(group.id);
    if (!pix || !pixRecent(pix.updated_at, now)) return null;
    return (
      <strong className="font-semibold text-amber-800 dark:text-amber-300">
        {" "}
        A chave PIX dele mudou em {pixDay(pix.updated_at)}: confirme com ele no grupo antes de pagar.
      </strong>
    );
  };
  // A lista de telefones é a dos técnicos ativos: o inativo não aparece nela.
  const whatsappTitle = (group: Group, phone: string | null) =>
    phone
      ? `Mandar o extrato para ${group.name} no WhatsApp`
      : people.data && !personOf(group.id)
        ? "Técnico inativo: o telefone dele não aparece aqui"
        : "Técnico sem telefone no cadastro";
  const period = month ? (months.find((m) => m.value === month)?.label ?? month) : "até hoje";
  const reimbursementOf = (group: Group) =>
    canExpenses ? (reimbursements.data?.by_technician.find((t) => t.technician?.id === group.id)?.to_pay ?? 0) : 0;
  /** As notas fiscais do técnico no período (a competência é o mês escolhido). */
  const invoicesOfGroup = (group: Group) => invoicesOf.get(group.id) ?? [];
  const textFor = (group: Group) =>
    statement(group.name, group.lines, period, reimbursementOf(group), pixOf(group.id), invoicesFresh ? invoicesOfGroup(group) : []);
  /** No Pagar: a nota do técnico no período, ou a falta dela com um mês escolhido. Só informa, nunca trava. */
  const invoiceNote = (group: Group) => (invoicesFresh ? payInvoiceNote(invoicesOfGroup(group), month, invoicesComplete) : null);

  // Reembolsos aprovados do técnico (Custos extras) ainda não pagos: o extrato soma no "Total a receber".
  const reimbursementIds = (group: Group) =>
    (reimbursements.data?.items ?? []).filter((r) => r.status === "approved" && r.technician?.id === group.id).map((r) => r.id);
  const markReimbursed = useMutation({
    mutationFn: async (ids: UUID[]) => {
      let updated = 0;
      for (let i = 0; i < ids.length; i += BATCH) {
        updated += (await api.post<{ updated: number }>("/expenses/mark-paid", { ids: ids.slice(i, i + BATCH) })).updated;
      }
      return updated;
    },
    onSuccess: (updated) =>
      toast({ title: plural(updated, "reembolso marcado como reembolsado", "reembolsos marcados como reembolsados"), tone: "success" }),
    onError: (error) => toast({ title: "Os reembolsos continuam a reembolsar", description: errorMessage(error), tone: "error" }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
      void queryClient.invalidateQueries({ queryKey: ["ticket"] });
    },
  });

  // `everything`: o "Pagar tudo" do técnico. Só nele (e com Custos extras: Editar) dá para baixar também os
  // reembolsos do mesmo acerto; o pagamento em si nunca mexe neles.
  const confirmPay = async (group: Group, chosen: PayoutLine[], everything: boolean) => {
    const codes = chosen.map((l) => l.ticket.code);
    const reimbursement = reimbursementOf(group);
    const note = invoiceNote(group);
    const ok = await confirm({
      title: chosen.length === 1 ? `Marcar a ${codes[0]} de ${group.name} como paga?` : `Marcar ${chosen.length} OS de ${group.name} como pagas?`,
      description: (
        <>
          Total <strong className="font-semibold text-ink">{formatMoney(total(chosen))}</strong> · {codes.slice(0, 5).join(", ")}
          {codes.length > 5 ? ` e mais ${codes.length - 5}` : ""}. O técnico passa a ver como pago no app.
          {note ? ` ${note}` : ""}
          {reimbursement > 0
            ? ` Os reembolsos aprovados (${formatMoney(reimbursement)}) não entram aqui: continuam a reembolsar em Custos extras.`
            : ""}
          {pixWarning(group)}
        </>
      ),
      confirmLabel: "Marcar como pago",
    });
    if (!ok) return;
    pay.mutate(
      { ids: chosen.map((l) => l.id), paid: true, groupId: group.id },
      {
        onSuccess: async (changed) => {
          const ids = everything && canPayExpenses && changed > 0 ? reimbursementIds(group) : [];
          if (!ids.length) return;
          const also = await confirm({
            title: `Marcar também os reembolsos de ${group.name} (${formatMoney(reimbursement)}) como reembolsados?`,
            description: "Os custos extras aprovados dele saem do “a reembolsar” em Custos extras e no app.",
            confirmLabel: "Marcar como reembolsados",
            cancelLabel: "Agora não",
          });
          if (also) markReimbursed.mutate(ids);
        },
      },
    );
  };
  // OS cancelada não entra no "Pagar tudo": pagar é decisão da central, linha a linha (o técnico foi e o cliente cancelou na hora).
  const confirmPayCancelled = async (group: Group, line: PayoutLine) => {
    const ok = await confirm({
      title: `Pagar a ${line.ticket.code} a ${group.name} mesmo cancelada?`,
      description: (
        <>
          A OS foi cancelada: pague só se o técnico chegou a trabalhar nela. Ele passa a ver{" "}
          <strong className="font-semibold text-ink">{formatMoney(line.amount)}</strong> como pago no app.
          {pixWarning(group)}
        </>
      ),
      confirmLabel: "Marcar como pago",
    });
    if (ok) pay.mutate({ ids: [line.id], paid: true, groupId: group.id, lineId: line.id });
  };
  const confirmUndo = async (group: Group, chosen: PayoutLine[]) => {
    const ok = await confirm({
      title: chosen.length === 1 ? `Desfazer o pagamento da ${chosen[0].ticket.code}?` : `Desfazer o pagamento de ${chosen.length} OS?`,
      description: (
        <>
          {group.name} · <strong className="font-semibold text-ink">{formatMoney(total(chosen))}</strong>. Volta para &quot;a pagar&quot; e o
          técnico deixa de ver como pago no app.
        </>
      ),
      confirmLabel: "Desfazer pagamento",
      tone: "danger",
    });
    if (ok) pay.mutate({ ids: chosen.map((l) => l.id), paid: false, groupId: group.id });
  };
  const confirmRemove = async (line: PayoutLine) => {
    const ok = await confirm({
      title: `Tirar o valor de ${line.technician.name} da ${line.ticket.code}?`,
      description: `A OS foi cancelada: os ${formatMoney(line.amount)} saem do fechamento. Se precisar, dá para lançar de novo na OS.`,
      confirmLabel: "Tirar o valor",
      tone: "danger",
    });
    if (ok) remove.mutate(line);
  };
  const copyStatement = async (group: Group) => {
    const copied = await copyText(textFor(group));
    toast(
      copied
        ? { title: "Extrato copiado: cole na conversa do técnico", tone: "success" }
        : { title: "Não foi possível copiar o extrato", description: "Tente de novo.", tone: "error" },
    );
  };
  const openWhatsApp = async (group: Group, phone: string) => {
    const text = textFor(group);
    if (text.length <= WHATSAPP_TEXT_LIMIT) {
      window.open(whatsappUrl(phone, text), "_blank", "noopener,noreferrer");
      return;
    }
    // Longo demais para ir no endereço do WhatsApp: copia e abre a conversa para colar.
    const copied = await copyText(text);
    window.open(whatsappUrl(phone, ""), "_blank", "noopener,noreferrer");
    toast(
      copied
        ? { title: "Extrato copiado: cole na conversa que abriu", description: "É longo demais para ir direto pelo link.", tone: "info" }
        : { title: "Não foi possível copiar o extrato", description: "Use o Copiar extrato e cole na conversa.", tone: "error" },
    );
  };
  /** Todas as notas do filtro, de qualquer situação, na ordem da aba Todas (a API manda 500 por vez). */
  const exportInvoices = async () => {
    setExporting({ loaded: 0, total: 0 });
    try {
      const items = await fetchAllInvoices(month, technicianId, (loaded, count) => setExporting({ loaded, total: count }));
      downloadCsv(`notas-fiscais-${month || "todos"}.csv`, invoiceCsvRows(reviewOrder(items)));
    } catch (error) {
      toast({ title: "Não foi possível exportar as notas", description: errorMessage(error), tone: "error" });
    } finally {
      setExporting(null);
    }
  };
  // O Exportar CSV do cabeçalho exporta a aba aberta: no fechamento, as linhas da visão; nas notas, todas
  // as notas do filtro.
  const exportCsv = () => {
    if (tab === "invoices") {
      void exportInvoices();
      return;
    }
    downloadCsv(`pagamentos-${month || "todos"}-${VIEW_SLUG[view]}.csv`, [
      [
        "tecnico",
        "os",
        "titulo",
        "cliente",
        "local",
        "cidade",
        "situacao_os",
        "concluida_em",
        "situacao",
        "pago_em",
        "valor",
        "observacao",
        "nota_fiscal",
      ],
      ...groups
        .flatMap((g) => g.lines)
        .map((l) => [
          l.technician.name,
          l.ticket.code,
          l.ticket.title,
          l.ticket.customer ?? "",
          l.ticket.location ?? "",
          l.ticket.city ?? "",
          STATUS[l.ticket.status].label,
          l.ticket.resolved_at ? formatDate(l.ticket.resolved_at) : "",
          STATE_LABEL[stateOf(l)],
          l.paid_at ? formatDate(l.paid_at) : "",
          l.amount.toFixed(2).replace(".", ","),
          l.note ?? "",
          l.invoice?.number ?? "",
        ]),
    ]);
  };

  const loading = queries.some((q) => q.isLoading);
  const error = queries.find((q) => q.error)?.error ?? null;
  const stale = queries.some((q) => q.isPlaceholderData);
  const pendingCut = isCut(pendingQuery.data);
  const paidCut = isCut(paidQuery.data);
  const truncated = pendingCut || paidCut;
  // Lista cortada no limite: o valor dos cartões vem somado pela API, que conta todos os lançamentos do
  // filtro, com o técnico escolhido ou não (as linhas na tela são só as mais recentes).
  const pendingSums = pendingCut ? pendingQuery.data?.summary : undefined;
  const paidSums = paidCut ? paidQuery.data?.summary : undefined;
  const sums = {
    to_pay: pendingSums?.to_pay ?? total(byState.to_pay),
    expected: pendingSums?.expected ?? total(byState.expected),
    cancelled: pendingSums?.cancelled ?? total(byState.cancelled),
    paid: paidSums?.paid ?? total(byState.paid),
  };
  const sumAll = pendingSums || paidSums ? sums.to_pay + sums.expected + sums.cancelled + sums.paid : total(lines);
  const busy = pay.isPending || remove.isPending;
  const retry = () => queries.forEach((q) => void q.refetch());
  // "Previsto" só mostra; marcar como pago vale para OS concluída, e desfazer, para o que já foi pago.
  // A OS cancelada tem os botões dela na própria linha (pagar ou tirar o valor). Só com Visualizar,
  // nada se seleciona.
  const selectable = (line: PayoutLine) =>
    canEdit && view !== "expected" && (stateOf(line) === "to_pay" || stateOf(line) === "paid");

  // A nota do diálogo na versão mais nova: a das listas (a geral ou a do "A conferir"; a ação no diálogo também
  // entra nelas) ou, fora das duas (a antiga do "A conferir", recusada há pouco), a que voltou da API.
  const shownId = shownInvoice?.invoice.id;
  const dialogInvoice = shownInvoice
    ? (invoiceItems.find((i) => i.id === shownId) ?? pendingItems.find((i) => i.id === shownId) ?? shownInvoice.invoice)
    : null;
  const openInvoice = (invoice: TechnicianInvoice, rejecting = false) => setShownInvoice({ invoice, rejecting });
  const pendingCount = (invoices.data ?? pendingInvoices.data)?.summary.pending ?? 0;

  if (!canView) return <NoAccess kind="module" item="commercial.payouts" />;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Pagamentos"
        description="Os técnicos parceiros recebem por chamado. O valor de cada um é definido na OS."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={technicianId}
              onChange={(e) => {
                const option = options.find((o) => o.id === e.target.value);
                setTechnician(option ? { id: option.id, name: option.name } : null);
                setSelected(new Set());
              }}
              className="w-full sm:w-56"
              aria-label="Técnico"
            >
              <option value="">Todos os técnicos</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Select
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setSelected(new Set());
              }}
              className="w-full sm:w-48"
              aria-label="Período"
            >
              <option value="">Todos os períodos</option>
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
            <Button disabled={tab === "invoices" ? !invoiceItems.length : !groups.length} loading={exporting !== null} onClick={exportCsv}>
              {exporting ? null : <Download className="size-4" />}
              {!exporting
                ? "Exportar CSV"
                : exporting.total
                  ? `Exportando ${intFmt(exporting.loaded)} de ${intFmt(exporting.total)}`
                  : "Exportando…"}
            </Button>
          </div>
        }
      />

      <div className="mb-4 border-b border-line">
        <Tabs<Tab>
          className="-mb-px"
          items={[
            { key: "closing", label: "Fechamento" },
            { key: "invoices", label: "Notas fiscais", count: pendingCount > 0 ? pendingCount : null },
          ]}
          value={tab}
          onChange={changeTab}
          ariaLabel="Pagamentos"
          idPrefix="pagamentos"
        />
      </div>
      <div role="tabpanel" id={`pagamentos-panel-${tab}`} aria-labelledby={`pagamentos-tab-${tab}`}>
        {tab === "invoices" ? (
          <InvoicesPanel
            all={invoiceListState(invoices)}
            pending={invoiceListState(pendingInvoices)}
            month={month}
            canEdit={canEdit}
            review={review}
            onOpen={openInvoice}
            onOpenFile={(invoice) => void openInvoiceFile(invoice)}
            onClearTechnician={technician ? () => setTechnician(null) : undefined}
          />
        ) : (
          <>
            <div
              className={clsx("grid grid-cols-2 gap-3 transition-opacity duration-150 lg:grid-cols-4", stale && "opacity-60")}
              role="group"
              aria-label="Situação dos pagamentos"
            >
              <StatTile
                label="A pagar"
                value={sums.to_pay}
                display={formatMoney(sums.to_pay)}
                loading={pendingQuery.isLoading}
                hint={countText(byState.to_pay.length, "OS concluída", "OS concluídas", pendingCut)}
                onSelect={() => changeView("to_pay")}
                selected={view === "to_pay"}
              />
              <StatTile
                label="Previsto"
                value={sums.expected}
                display={formatMoney(sums.expected)}
                loading={pendingQuery.isLoading}
                hint={
                  <>
                    {countText(byState.expected.length, "OS em andamento", "OS em andamento", pendingCut)}
                    {sums.cancelled > 0 ? (
                      <span className="font-medium text-amber-700 dark:text-amber-400"> · {formatMoney(sums.cancelled)} em OS canceladas</span>
                    ) : null}
                  </>
                }
                onSelect={() => changeView("expected")}
                selected={view === "expected"}
              />
              <StatTile
                label="Pago"
                value={sums.paid}
                display={formatMoney(sums.paid)}
                loading={paidQuery.isLoading}
                hint={month ? "OS concluídas no mês" : "até hoje"}
                onSelect={() => changeView("paid")}
                selected={view === "paid"}
              />
              <StatTile
                label="Todos"
                value={sumAll}
                display={formatMoney(sumAll)}
                loading={loading}
                hint={countText(lines.length, "lançamento", "lançamentos", truncated)}
                onSelect={() => changeView("all")}
                selected={view === "all"}
              />
            </div>
            {month || truncated ? (
              <p className="mt-2 text-xs text-ink-muted">
                {month ? "O mês vale pela conclusão da OS; a OS ainda aberta entra pela data em que o valor foi lançado." : ""}
                {truncated
                  ? ` A lista traz até ${intFmt(LIMIT)} lançamentos a pagar e ${intFmt(LIMIT)} pagos (os mais recentes); os valores dos cartões somam todos: escolha um mês para ver a lista inteira.`
                  : ""}
              </p>
            ) : null}

            <div className="mt-5">
              {loading ? (
                <LoadingBlock rows={4} />
              ) : error && !all.length ? (
                <ErrorBox message={errorMessage(error)} onRetry={retry} />
              ) : (
                <>
                  {error ? (
                    <div className="mb-3">
                      <ErrorBox message={errorMessage(error)} onRetry={retry} />
                    </div>
                  ) : null}
                  {!groups.length ? (
                    <Card>
                      <EmptyState
                        icon={<Wallet />}
                        title={EMPTY[view].title}
                        description={EMPTY[view].description}
                        action={
                          technician ? (
                            <Button
                              onClick={() => {
                                setTechnician(null);
                                setSelected(new Set());
                              }}
                            >
                              Ver todos os técnicos
                            </Button>
                          ) : undefined
                        }
                      />
                    </Card>
                  ) : (
                    <div className={clsx("flex flex-col gap-4 transition-opacity duration-150", stale && "opacity-60")} aria-busy={stale}>
                      {groups.map((group) => {
                        const pickable = group.lines.filter(selectable);
                        const chosen = pickable.filter((l) => selected.has(l.id));
                        const payable = group.lines.filter((l) => stateOf(l) === "to_pay");
                        const chosenPayable = chosen.filter((l) => stateOf(l) === "to_pay");
                        const chosenPaid = chosen.filter((l) => stateOf(l) === "paid");
                        const mine = pay.isPending && pay.variables?.groupId === group.id;
                        // Pagamento em lote deste técnico (o de uma linha só gira o botão da própria linha).
                        const batch = mine && !pay.variables?.lineId;
                        const phone = personOf(group.id)?.phone ?? null;
                        const pix = pixOf(group.id);
                        const groupInvoices = invoicesOfGroup(group);
                        const parts = (["to_pay", "paid", "expected", "cancelled"] as const)
                          .map((state) => ({ state, lines: group.lines.filter((l) => stateOf(l) === state) }))
                          .filter((p) => p.lines.length > 0)
                          .map((p) => `${STATE_LABEL[p.state].toLowerCase()} ${formatMoney(total(p.lines))}`);
                        return (
                          <Card key={group.id} className="overflow-hidden">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3">
                              {pickable.length ? (
                                <SelectAll
                                  checked={chosen.length === pickable.length}
                                  partial={chosen.length > 0 && chosen.length < pickable.length}
                                  label={`Selecionar todas de ${group.name}`}
                                  onChange={(on) =>
                                    setSelected((s) => {
                                      const next = new Set(s);
                                      for (const l of pickable) {
                                        if (on) next.add(l.id);
                                        else next.delete(l.id);
                                      }
                                      return next;
                                    })
                                  }
                                />
                              ) : null}
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-bold text-ink">{labelOf(group)}</p>
                                <p className="text-xs text-ink-muted">
                                  {plural(group.lines.length, "OS", "OS")} · {parts.join(" · ")}
                                </p>
                                {pix !== undefined ? <PayoutPixLine name={group.name} pix={pix} phone={phone} now={now} /> : null}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Button size="sm" variant="ghost" onClick={() => void copyStatement(group)}>
                                  <Copy className="size-4" />
                                  Copiar extrato
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={!phone}
                                  title={whatsappTitle(group, phone)}
                                  onClick={() => phone && void openWhatsApp(group, phone)}
                                >
                                  <MessageCircle className="size-4" />
                                  WhatsApp
                                </Button>
                                {canEdit && (chosenPaid.length || view === "paid") ? (
                                  <Button
                                    size="sm"
                                    disabled={!chosenPaid.length || stale || (busy && !batch)}
                                    loading={batch && pay.variables?.paid === false}
                                    title={chosenPaid.length ? undefined : "Selecione os pagamentos que quer desfazer"}
                                    onClick={() => void confirmUndo(group, chosenPaid)}
                                  >
                                    <RotateCcw className="size-4" />
                                    {chosenPaid.length > 1 ? `Desfazer ${chosenPaid.length} pagamentos` : "Desfazer pagamento"}
                                  </Button>
                                ) : null}
                                {canEdit && (view === "to_pay" || view === "all") && payable.length ? (
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    disabled={stale || (busy && !batch)}
                                    loading={batch && pay.variables?.paid === true}
                                    onClick={() => void confirmPay(group, chosenPayable.length ? chosenPayable : payable, !chosenPayable.length)}
                                  >
                                    <CheckCheck className="size-4" />
                                    {chosenPayable.length
                                      ? `Pagar ${plural(chosenPayable.length, "selecionada", "selecionadas")}`
                                      : `Pagar tudo (${formatMoney(total(payable))})`}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                            {groupInvoices.length ? (
                              <InvoiceStrip
                                invoices={groupInvoices}
                                onOpen={(invoice) => openInvoice(invoice)}
                                onMore={() => showInvoicesOf(group)}
                              />
                            ) : null}
                            <ul className="divide-y divide-line">
                              {group.lines.map((line) => {
                                const state = stateOf(line);
                                const canPick = selectable(line);
                                return (
                                  <li key={line.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-2.5 sm:flex-nowrap">
                                    {canEdit && view !== "expected" ? (
                                      <label
                                        className={clsx("-m-2 flex shrink-0 p-2", canPick ? "cursor-pointer" : "cursor-not-allowed")}
                                        title={
                                          canPick
                                            ? undefined
                                            : state === "cancelled"
                                              ? "OS cancelada: pague ou tire o valor pelos botões da linha"
                                              : "Paga quando a OS for concluída"
                                        }
                                      >
                                        <input
                                          type="checkbox"
                                          disabled={!canPick}
                                          checked={selected.has(line.id)}
                                          onChange={() => toggle(line.id)}
                                          className="size-4 accent-[var(--brand)]"
                                          aria-label={`Selecionar ${line.ticket.code}`}
                                        />
                                      </label>
                                    ) : null}
                                    <div className="min-w-0 flex-1 basis-56">
                                      <p className="truncate text-sm font-semibold text-ink" title={line.ticket.title}>
                                        <TicketLink
                                          ticketId={line.ticket.id}
                                          className="mr-1.5 font-mono text-xs font-normal text-ink-subtle hover:text-brand hover:underline"
                                        >
                                          {line.ticket.code}
                                        </TicketLink>
                                        {line.ticket.title}
                                      </p>
                                      <p className="truncate text-xs text-ink-muted">{subtitle(line)}</p>
                                    </div>
                                    <div className="flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-1.5 sm:w-auto sm:flex-nowrap">
                                      <StatePill line={line} />
                                      {canEdit && state === "cancelled" ? (
                                        <span className="flex items-center gap-1">
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={stale || (busy && pay.variables?.lineId !== line.id)}
                                            loading={pay.isPending && pay.variables?.lineId === line.id}
                                            onClick={() => void confirmPayCancelled(group, line)}
                                          >
                                            Pagar
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={stale || (busy && remove.variables?.id !== line.id)}
                                            loading={remove.isPending && remove.variables?.id === line.id}
                                            onClick={() => void confirmRemove(line)}
                                          >
                                            Tirar valor
                                          </Button>
                                        </span>
                                      ) : null}
                                      <span className="text-right text-sm font-medium text-ink tabular-nums sm:w-28">{formatMoney(line.amount)}</span>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          </Card>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {dialogInvoice && shownInvoice ? (
        <InvoiceDialog
          key={dialogInvoice.id}
          invoice={dialogInvoice}
          startRejecting={shownInvoice.rejecting}
          canEdit={canEdit}
          phone={personOf(dialogInvoice.technician.id)?.phone ?? null}
          review={review}
          onOpenFile={(invoice) => void openInvoiceFile(invoice, shownInvoice.changedAt)}
          onClose={() => setShownInvoice(null)}
        />
      ) : null}
    </div>
  );
}
