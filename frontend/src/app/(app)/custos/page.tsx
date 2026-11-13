"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Download, Paperclip, Receipt, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { StatTile } from "@/components/charts";
import { useConfirm } from "@/components/Confirm";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import { TicketLink } from "@/components/ticket/TicketLink";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, isManager } from "@/lib/constants";
import { downloadCsv } from "@/lib/download";
import { EXPENSE_KIND, EXPENSE_STATUS } from "@/lib/expenses";
import { formatDate, formatDocument, formatMoney, moneyInput } from "@/lib/format";
import { useCustomers } from "@/lib/queries";
import { readDecimal } from "@/lib/quotes";
import type { Attachment, ExpenseKind, ExpenseReport, ExpenseStatus, UUID, User } from "@/lib/types";

type Row = ExpenseReport["items"][number];
type StatusFilter = ExpenseStatus | "";
interface Settled {
  ok: number;
  failed: number;
  error: string | null;
}

/** Fuso da operação: o mês fecha à meia-noite de Brasília, não na do navegador. */
const OPERATION_TZ = "America/Sao_Paulo";
const ALL = "all";
/** Tipos que costumam ter nota ou recibo: sem o comprovante, a aprovação fica no escuro. */
const RECEIPT_KINDS: ExpenseKind[] = ["material", "toll", "parking", "transport", "meal"];
/** Limite das observações do custo na API. */
const NOTES_MAX = 2000;
/** A API reembolsa até 500 por chamada; aprovar e recusar vão em lotes pequenos (um registro por custo). */
const BATCH = 500;
const PARALLEL = 5;
const EMPTY_TITLE: Record<StatusFilter, string> = {
  "": "Nenhum custo extra no período",
  pending: "Nenhum custo aguardando aprovação",
  approved: "Nada a reembolsar",
  paid: "Nenhum custo reembolsado",
  rejected: "Nenhum custo recusado",
};
const STATUS_SLUG: Record<ExpenseStatus, string> = { pending: "aguardando", approved: "a-reembolsar", paid: "reembolsados", rejected: "recusados" };

const intFmt = (n: number) => n.toLocaleString("pt-BR");
const plural = (n: number, one: string, many: string) => `${intFmt(n)} ${n === 1 ? one : many}`;
const sum = (rows: Row[]) => rows.reduce((acc, r) => acc + r.total, 0);
const csvMoney = (v: number) => v.toFixed(2).replace(".", ",");
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: OPERATION_TZ }).format(new Date(iso));
const currentMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: OPERATION_TZ }).format(new Date()).slice(0, 7);

/** Últimos 24 meses ("2026-11", "Novembro de 2026"), do atual para trás. */
function monthOptions(): { value: string; label: string }[] {
  const [y, m] = currentMonth().split("-").map(Number);
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

/** Início e fim do período pelo lançamento do custo ("Todo o período": de 2020 até amanhã). */
function periodRange(period: string): { start: string; end: string } {
  if (period === ALL) return { start: midnight("2020-01-01"), end: new Date(Date.now() + 86_400_000).toISOString() };
  const [y, m] = period.split("-").map(Number);
  return { start: midnight(`${period}-01`), end: midnight(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)) };
}

/** Altera os custos aos poucos (cada um ganha o próprio registro no histórico da OS) e conta o resultado. */
async function settle(rows: Row[], body: (row: Row) => object): Promise<Settled> {
  let ok = 0;
  let failed = 0;
  let error: string | null = null;
  for (let i = 0; i < rows.length; i += PARALLEL) {
    const results = await Promise.allSettled(rows.slice(i, i + PARALLEL).map((r) => api.patch(`/expenses/${r.id}`, body(r))));
    for (const result of results) {
      if (result.status === "fulfilled") ok += 1;
      else {
        failed += 1;
        error ??= errorMessage(result.reason);
      }
    }
  }
  return { ok, failed, error };
}

/** Caixa do cabeçalho: marca todos os que dá para escolher (meio marcada quando só parte está). */
function HeaderCheckbox({
  checked,
  partial,
  disabled,
  onChange,
}: {
  checked: boolean;
  partial: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 accent-[var(--brand)]"
      aria-label="Selecionar os lançados e aprovados da lista"
    />
  );
}

/** Ação da linha (coluna fixa à direita), no mesmo formato do botão Editar das listas. */
function RowAction({
  label,
  onClick,
  disabled,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={clsx(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface shadow-elev-1 transition-[border-color,background-color,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
        danger
          ? "text-red-600 hover:border-red-300 hover:bg-red-50 dark:text-red-400 dark:hover:border-red-500/40 dark:hover:bg-red-500/10"
          : "text-brand hover:border-brand/40 hover:bg-brand-soft",
      )}
    >
      {children}
    </button>
  );
}

/** Recusa com motivo (vai para as observações do custo). */
function RejectDialog({ rows, onClose, onDone }: { rows: Row[]; onClose: () => void; onDone: (result: Settled) => void }) {
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const valid = reason.trim().length >= 3;
  const reject = useMutation({
    mutationFn: () =>
      settle(rows, (row) => {
        const tag = `Recusado: ${reason.trim()}`;
        const kept = (row.notes ?? "").slice(0, NOTES_MAX - tag.length - 1);
        return { status: "rejected", notes: kept ? `${kept}\n${tag}` : tag };
      }),
    onSuccess: onDone,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={rows.length === 1 ? "Recusar o custo?" : `Recusar ${rows.length} custos?`}
      description={
        <>
          {rows.length === 1 ? `${rows[0].ticket.code} · ${rows[0].description}` : plural(rows.length, "custo", "custos")} ·{" "}
          <strong className="font-semibold text-ink">{formatMoney(sum(rows))}</strong>. O custo recusado sai das somas e do reembolso.
        </>
      }
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button type="submit" form="reject-expenses" variant="danger" loading={reject.isPending}>
            Recusar
          </Button>
        </>
      }
    >
      <form
        id="reject-expenses"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (valid) reject.mutate();
        }}
      >
        <Field label="Motivo" required hint="Fica nas observações do custo.">
          <Textarea
            autoFocus
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={tried && !valid}
            placeholder="Ex.: sem nota fiscal, valor acima do combinado"
          />
        </Field>
        {tried && !valid ? (
          <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
            Escreva o motivo (pelo menos 3 letras).
          </p>
        ) : null}
        {reject.error ? (
          <div className="mt-3">
            <ErrorBox message={errorMessage(reject.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

export default function ExpensesPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const panel = useTicketPanel();
  const months = useMemo(() => monthOptions(), []);
  const [period, setPeriod] = useState(currentMonth);
  // Guarda o nome junto: o técnico escolhido continua na lista mesmo sem custos no período.
  const [technician, setTechnician] = useState<{ id: UUID; name: string } | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [selected, setSelected] = useState<UUID[]>([]);
  const [rejecting, setRejecting] = useState<Row[] | null>(null);
  // Só os técnicos ativos (os parceiros de agora); os inativos com custo no período entram pela lista.
  const technicians = useQuery({
    queryKey: ["users", { role: "technician", active: true }],
    queryFn: () => api.get<User[]>("/users", { role: "technician", active: true }),
    staleTime: 60_000,
  });
  const customers = useCustomers();
  // Sem a situação na consulta: os cartões somam todas e funcionam como o filtro da lista.
  const report = useQuery({
    queryKey: ["expenses", period, technician?.id ?? "", customerId],
    queryFn: () =>
      api.get<ExpenseReport>("/expenses", {
        ...periodRange(period),
        technician_id: technician?.id,
        customer_id: customerId || undefined,
      }),
    placeholderData: keepPreviousData,
  });
  // Aprovados e ainda não reembolsados em qualquer mês: o que a empresa deve aos técnicos.
  const backlog = useQuery({
    queryKey: ["expenses", "approved", "all"],
    queryFn: () =>
      api.get<ExpenseReport>("/expenses", {
        status: "approved",
        start: "2020-01-01T00:00:00-03:00",
        end: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    staleTime: 60_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["expenses"] });
    void queryClient.invalidateQueries({ queryKey: ["ticket"] });
  };
  const announce = (result: Settled, one: string, many: string) => {
    setSelected([]);
    if (result.failed === 0) {
      toast({ title: plural(result.ok, `custo ${one}`, `custos ${many}`), tone: "success" });
    } else {
      toast({
        title: result.ok
          ? `${plural(result.ok, `custo ${one}`, `custos ${many}`)}; ${plural(result.failed, "deu erro", "deram erro")}`
          : `Nenhum custo ${one}`,
        description: result.error ?? undefined,
        tone: "error",
      });
    }
  };
  const approve = useMutation({
    mutationFn: (rows: Row[]) => settle(rows, () => ({ status: "approved" })),
    onSuccess: (result) => announce(result, "aprovado", "aprovados"),
    onError: (e) => toast({ title: errorMessage(e), tone: "error" }),
    onSettled: refresh,
  });
  const markPaid = useMutation({
    mutationFn: async (ids: UUID[]) => {
      let updated = 0;
      for (let i = 0; i < ids.length; i += BATCH) {
        updated += (await api.post<{ updated: number }>("/expenses/mark-paid", { ids: ids.slice(i, i + BATCH) })).updated;
      }
      return updated;
    },
    onSuccess: (updated) => {
      setSelected([]);
      toast(
        updated
          ? { title: plural(updated, "custo marcado como reembolsado", "custos marcados como reembolsados"), tone: "success" }
          : { title: "Nada mudou: a lista estava desatualizada", tone: "info" },
      );
    },
    onError: (e) => toast({ title: errorMessage(e), tone: "error" }),
    onSettled: refresh,
  });

  const data = report.data;
  const byStatus = useMemo(() => {
    const items = data?.items ?? [];
    const of = (s: ExpenseStatus) => items.filter((r) => r.status === s);
    return { pending: of("pending"), approved: of("approved"), paid: of("paid"), rejected: of("rejected") };
  }, [data]);
  const visible = useMemo(() => {
    const items = data?.items ?? [];
    return status ? items.filter((r) => r.status === status) : items;
  }, [data, status]);
  // "Por técnico" e "Por tipo" seguem o filtro de situação (sem os recusados, a menos que sejam o filtro).
  const breakdown = useMemo(() => {
    const counted = status === "rejected" ? visible : visible.filter((r) => r.status !== "rejected");
    const techs = new Map<string, { id: UUID | null; name: string; count: number; total: number; toPay: number }>();
    const kinds = new Map<ExpenseKind, number>();
    for (const r of counted) {
      const key = r.technician?.id ?? "none";
      const entry = techs.get(key) ?? { id: r.technician?.id ?? null, name: r.technician?.name ?? "Custo da empresa", count: 0, total: 0, toPay: 0 };
      entry.count += 1;
      entry.total += r.total;
      if (r.status === "approved") entry.toPay += r.total;
      techs.set(key, entry);
      kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + r.total);
    }
    return { techs: [...techs.values()].sort((a, b) => b.total - a.total), kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]) };
  }, [visible, status]);
  const technicianOptions = useMemo(() => {
    const map = new Map<UUID, { id: UUID; name: string; email?: string }>();
    for (const u of technicians.data ?? []) map.set(u.id, { id: u.id, name: u.name, email: u.email });
    for (const r of data?.items ?? []) {
      if (r.technician && !map.has(r.technician.id)) map.set(r.technician.id, { id: r.technician.id, name: r.technician.name });
    }
    if (technician && !map.has(technician.id)) map.set(technician.id, technician);
    const repeated = new Map<string, number>();
    for (const t of map.values()) repeated.set(t.name, (repeated.get(t.name) ?? 0) + 1);
    return [...map.values()]
      .map((t) => ({ ...t, label: (repeated.get(t.name) ?? 0) > 1 && t.email ? `${t.name} · ${t.email}` : t.name }))
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  }, [technicians.data, data, technician]);
  const customerOptions = useMemo(() => {
    const list = customers.data ?? [];
    const repeated = new Map<string, number>();
    for (const c of list) repeated.set(c.name, (repeated.get(c.name) ?? 0) + 1);
    return list.map((c) => ({
      id: c.id,
      label: (repeated.get(c.name) ?? 0) > 1 ? `${c.name} · ${c.document ? formatDocument(c.document) : (c.city ?? "sem CNPJ")}` : c.name,
    }));
  }, [customers.data]);

  if (user && !canManageTickets(user.role)) {
    return <ErrorBox message="Os custos extras são da gestão." />;
  }

  const stale = report.isPlaceholderData;
  const busy = approve.isPending || markPaid.isPending;
  const filtered = Boolean(technician || customerId || status);
  const pickable = visible.filter((r) => r.status === "pending" || r.status === "approved");
  const chosen = pickable.filter((r) => selected.includes(r.id));
  const chosenPending = chosen.filter((r) => r.status === "pending");
  const chosenApproved = chosen.filter((r) => r.status === "approved");
  const counted = visible.filter((r) => r.status !== "rejected");
  const backlogTotal = backlog.data?.total ?? 0;
  const showingBacklog = period === ALL && status === "approved" && !technician && !customerId;

  // Toda troca de filtro limpa a seleção: nada escolhido fora da tela vai junto numa ação.
  const pickStatus = (next: StatusFilter) => {
    setStatus(next);
    setSelected([]);
  };
  const clearFilters = () => {
    setTechnician(null);
    setCustomerId("");
    setStatus("");
    setSelected([]);
  };
  const openTicket = (id: UUID) => (panel ? panel.open(id) : router.push(`/chamados/${id}`));
  const openReceipt = async (row: Row) => {
    // A aba abre já no clique (senão o navegador bloqueia) e recebe o endereço assinado do arquivo depois.
    const tab = window.open("", "_blank");
    if (!tab) {
      toast({ title: "O navegador bloqueou a nova aba", description: "Libere as janelas pop-up deste site para ver o comprovante.", tone: "error" });
      return;
    }
    tab.opener = null;
    try {
      const files = await queryClient.fetchQuery({
        queryKey: ["ticket", row.ticket.id, "attachments"],
        queryFn: () => api.get<Attachment[]>(`/tickets/${row.ticket.id}/attachments`),
        staleTime: 30_000,
      });
      const url = absoluteApiUrl(files.find((f) => f.id === row.receipt_attachment_id)?.download_url);
      if (!url) throw new Error("O comprovante não está mais nos anexos da OS.");
      tab.location.href = url;
    } catch (e) {
      tab.close();
      toast({ title: "Não foi possível abrir o comprovante", description: errorMessage(e), tone: "error" });
    }
  };
  const confirmReimburse = async (rows: Row[]) => {
    const perTechnician = new Map<string, { name: string; total: number }>();
    for (const r of rows) {
      const key = r.technician?.id ?? "none";
      const entry = perTechnician.get(key) ?? { name: r.technician?.name ?? "Custo da empresa", total: 0 };
      entry.total += r.total;
      perTechnician.set(key, entry);
    }
    const ok = await confirm({
      title: rows.length === 1 ? "Marcar 1 custo como reembolsado?" : `Marcar ${rows.length} custos como reembolsados?`,
      description: (
        <div className="flex flex-col gap-2">
          <p>
            Total <strong className="font-semibold text-ink">{formatMoney(sum(rows))}</strong>. O técnico passa a ver o reembolso como
            pago no app.
          </p>
          <ul className="flex flex-col gap-0.5">
            {[...perTechnician].map(([key, t]) => (
              <li key={key} className="flex justify-between gap-3">
                <span className="min-w-0 truncate">{t.name}</span>
                <span className="shrink-0 text-ink tabular-nums">{formatMoney(t.total)}</span>
              </li>
            ))}
          </ul>
        </div>
      ),
      confirmLabel: "Marcar como reembolsado",
    });
    if (ok) markPaid.mutate(rows.map((r) => r.id));
  };
  const exportCsv = () =>
    downloadCsv(`custos-extras-${period === ALL ? "todo-periodo" : period}${status ? `-${STATUS_SLUG[status]}` : ""}.csv`, [
      ["data", "os", "cliente", "tipo", "descricao", "quantidade", "valor_unitario", "total", "tecnico", "situacao", "reembolsado_em", "comprovante", "observacao"],
      ...visible.map((r) => [
        formatDate(r.created_at),
        r.ticket.code,
        r.ticket.customer?.name ?? "",
        EXPENSE_KIND[r.kind].label,
        r.description,
        String(r.quantity).replace(".", ","),
        csvMoney(r.unit_value),
        csvMoney(r.total),
        r.technician?.name ?? "",
        EXPENSE_STATUS[r.status].label,
        r.paid_at ? formatDate(r.paid_at) : "",
        r.receipt_attachment_id ? "sim" : "não",
        r.notes ?? "",
      ]),
    ]);
  const cards: { key: StatusFilter; label: string; rows: Row[]; hint: string }[] = [
    { key: "", label: "Todos", rows: [...byStatus.pending, ...byStatus.approved, ...byStatus.paid], hint: "sem os recusados" },
    { key: "pending", label: "Aguardando aprovação", rows: byStatus.pending, hint: "lançados na OS" },
    { key: "approved", label: "A reembolsar", rows: byStatus.approved, hint: "aprovados" },
    { key: "paid", label: "Reembolsado", rows: byStatus.paid, hint: "já pagos ao técnico" },
    { key: "rejected", label: "Recusado", rows: byStatus.rejected, hint: "fora das somas" },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Custos extras"
        description="Reembolso aos técnicos: material, km rodado e despesas lançadas nas OS."
        actions={
          <>
            <KmRate canEdit={isManager(user?.role)} />
            <Button
              disabled={!data?.items.length}
              onClick={() =>
                downloadCsv(`custos-extras-${month}.csv`, [
                  ["data", "os", "cliente", "tipo", "descricao", "quantidade", "valor_unitario", "total", "tecnico", "situacao"],
                  ...(data?.items ?? []).map((i) => [
                    formatDate(i.created_at),
                    i.ticket.code,
                    i.ticket.customer?.name ?? "",
                    EXPENSE_KIND[i.kind].label,
                    i.description,
                    String(i.quantity).replace(".", ","),
                    i.unit_value.toFixed(2).replace(".", ","),
                    i.total.toFixed(2).replace(".", ","),
                    i.technician?.name ?? "",
                    EXPENSE_STATUS[i.status].label,
                  ]),
                ])
              }
            >
              <Download className="size-4" />
              Exportar CSV
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="w-44">
          <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Mês" />
        </div>
        <div className="w-full sm:w-56">
          <Select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} aria-label="Técnico">
            <option value="">Todos os técnicos</option>
            {(technicians.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-44">
          <Select value={status} onChange={(e) => setStatus(e.target.value as ExpenseStatus | "")} aria-label="Situação">
            <option value="">Todas as situações</option>
            {Object.entries(EXPENSE_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {report.isLoading ? (
        <LoadingBlock />
      ) : report.error ? (
        <ErrorBox message={errorMessage(report.error)} />
      ) : !data || data.items.length === 0 ? (
        <Card>
          <EmptyState icon={<Receipt className="size-6" />} title="Nenhum custo extra neste período" />
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total no mês" value={formatMoney(data.total)} />
            <Stat label="A reembolsar (aprovado)" value={formatMoney(sums.approved)} tone="text-sky-700 dark:text-sky-300" />
            <Stat label="Reembolsado" value={formatMoney(sums.paid)} tone="text-emerald-700 dark:text-emerald-300" />
            <Stat label="Aguardando aprovação" value={formatMoney(sums.pending)} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <Card className="min-w-0">
              <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
                <span className="text-sm text-ink-muted">
                  {selected.length ? `${selected.length} selecionado(s)` : `${data.items.length} lançamento(s)`}
                </span>
                <Button size="sm" variant="primary" disabled={!selected.length} loading={markPaid.isPending} onClick={() => markPaid.mutate()}>
                  <Check className="size-4" />
                  Marcar como reembolsado
                </Button>
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>
                      <input
                        type="checkbox"
                        aria-label="Selecionar aprovados"
                        checked={payable.length > 0 && selected.length === payable.length}
                        onChange={(e) => setSelected(e.target.checked ? payable.map((i) => i.id) : [])}
                      />
                    </Th>
                    <Th>OS</Th>
                    <Th>Custo</Th>
                    <Th className="hidden md:table-cell">Técnico</Th>
                    <Th className="text-right">Total</Th>
                    <Th>Situação</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.id} className={clsx(i.status === "rejected" && "opacity-60")}>
                      <Td>
                        <input
                          type="checkbox"
                          aria-label={`Selecionar ${i.description}`}
                          disabled={i.status !== "approved"}
                          checked={selected.includes(i.id)}
                          onChange={(e) =>
                            setSelected((s) => (e.target.checked ? [...s, i.id] : s.filter((x) => x !== i.id)))
                          }
                        />
                      </Td>
                      <Td>
                        <TicketLink ticketId={i.ticket.id} className="font-mono text-xs text-brand hover:underline">
                          {i.ticket.code}
                        </TicketLink>
                        <span className="block max-w-48 truncate text-xs text-ink-muted">{i.ticket.customer?.name ?? i.ticket.title}</span>
                      </Td>
                      <Td>
                        <span className="block font-semibold text-ink">{EXPENSE_KIND[i.kind].label}</span>
                        <span className="block max-w-56 truncate text-xs text-ink-muted">{i.description}</span>
                      </Td>
                      <Td className="hidden md:table-cell">{i.technician?.name ?? <span className="text-ink-muted">—</span>}</Td>
                      <Td className="text-right font-medium tabular-nums">{formatMoney(i.total)}</Td>
                      <Td>
                        <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium", EXPENSE_STATUS[i.status].className)}>
                          {EXPENSE_STATUS[i.status].label}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>

            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader title="Por técnico" />
                <ul className="divide-y divide-line">
                  {data.by_technician.map((t) => (
                    <li key={t.technician?.id ?? "none"} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-ink">{t.technician?.name ?? "Custo da empresa"}</span>
                        <span className="text-xs text-ink-muted">
                          {t.count} lançamento(s){t.to_pay ? ` · a reembolsar ${formatMoney(t.to_pay)}` : ""}
                        </span>
                      </span>
                      <span className="font-medium tabular-nums">{formatMoney(t.total)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card>
                <CardHeader title="Por tipo" />
                <ul className="divide-y divide-line">
                  {Object.entries(data.by_kind)
                    .sort((a, b) => b[1] - a[1])
                    .map(([kind, total]) => (
                      <li key={kind} className="flex justify-between px-4 py-2 text-sm">
                        <span className="font-semibold text-ink">{kind}</span>
                        <span className="tabular-nums">{formatMoney(total)}</span>
                      </li>
                    ))}
                </ul>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs font-semibold text-ink/80">{label}</p>
      <p className={clsx("mt-1 text-xl font-semibold tabular-nums text-ink", tone)}>{value}</p>
    </Card>
  );
}

function KmRate({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "expenses"], queryFn: () => api.get<{ km_rate: number }>("/settings/expenses") });
  const [value, setValue] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (rate: string) => api.put("/settings/expenses", { km_rate: rate.replace(",", ".") }),
    onSuccess: () => {
      setValue(null);
      queryClient.invalidateQueries({ queryKey: ["settings", "expenses"] });
    },
  });
  if (!settings.data) return null;
  if (value === null) {
    return (
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => setValue(String(settings.data.km_rate).replace(".", ","))}
        className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted enabled:hover:border-brand enabled:hover:text-ink"
        title={canEdit ? "Alterar o valor do km" : "Só supervisor ou admin altera"}
      >
        Km: <span className="font-medium text-ink">{formatMoney(settings.data.km_rate)}</span>
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(value);
      }}
    >
      <span className="text-xs font-semibold text-ink/80">R$/km</span>
      <Input value={value} onChange={(e) => setValue(e.target.value)} className="w-20" inputMode="decimal" autoFocus />
      <Button size="sm" type="submit" variant="primary" loading={save.isPending}>
        Salvar
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setValue(null)}>
        Cancelar
      </Button>
    </form>
  );
}
