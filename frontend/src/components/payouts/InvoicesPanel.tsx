"use client";

import clsx from "clsx";
import { Check, FileText, ReceiptText, RotateCcw, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Tabs } from "@/components/motion";
import { Button, Card, EmptyState, ErrorBox, LoadingBlock, Pill } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { competenceLabel, INVOICE_STATUS } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/format";
import { invoiceDifference, invoiceNo, invoicePayoutsText, type InvoiceReview, reviewOrder } from "@/lib/invoices";
import type { TechnicianInvoice, TechnicianInvoiceList } from "@/lib/types";

type Filter = "pending" | "checked" | "rejected" | "all";

const FILTERS: { key: Filter; label: string; empty: string }[] = [
  { key: "pending", label: "A conferir", empty: "Nenhuma nota a conferir" },
  { key: "checked", label: "Conferidas", empty: "Nenhuma nota conferida" },
  { key: "rejected", label: "Recusadas", empty: "Nenhuma nota recusada" },
  { key: "all", label: "Todas", empty: "Nenhuma nota fiscal" },
];

/** Na faixa do técnico (aba Fechamento), quantas notas aparecem antes do "+N". */
const STRIP_MAX = 4;
/** Na faixa, as que valem vêm antes da recusada (o técnico ainda vai mandar outra). */
const STRIP_RANK: Record<TechnicianInvoice["status"], number> = { pending: 0, checked: 1, rejected: 2 };

const intFmt = (n: number) => n.toLocaleString("pt-BR");

/** Uma lista de notas da aba, como a consulta está. */
export interface InvoiceListState {
  list: TechnicianInvoiceList | undefined;
  loading: boolean;
  error: unknown;
  /** Lista do filtro anterior enquanto a nova não chega. */
  stale: boolean;
  onRetry: () => void;
}

/**
 * Aba Notas fiscais de Pagamentos: as notas que os técnicos enviaram pelo app, com os filtros do cabeçalho
 * (técnico e competência). "A conferir" tem lista própria, na ordem da fila (da mais antiga para a mais nova): a
 * lista geral, das outras abas, traz só as 500 mais novas. Com Editar: conferir, recusar (abre o diálogo com o
 * motivo) e desfazer a conferência. A linha abre o diálogo da nota.
 */
export function InvoicesPanel({
  all,
  pending,
  month,
  canEdit,
  review,
  onOpen,
  onOpenFile,
  onClearTechnician,
}: {
  /** A lista geral (as mais novas, de qualquer situação): Conferidas, Recusadas, Todas e os contadores. */
  all: InvoiceListState;
  /** A do "A conferir" (só as que aguardam), as mais antigas primeiro. */
  pending: InvoiceListState;
  /** Competência escolhida no cabeçalho ("2026-11"), ou vazio. */
  month: string;
  canEdit: boolean;
  review: InvoiceReview;
  onOpen: (invoice: TechnicianInvoice, rejecting?: boolean) => void;
  onOpenFile: (invoice: TechnicianInvoice) => void;
  /** Com um técnico escolhido no cabeçalho: tira o filtro (no vazio). */
  onClearTechnician?: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("pending");
  const { list, loading, error, stale, onRetry } = filter === "pending" ? pending : all;
  const ordered = useMemo(() => reviewOrder(list?.items ?? []), [list]);
  // Também na lista do "A conferir": a nota conferida agora sai antes de a lista voltar do servidor.
  const visible = filter === "all" ? ordered : ordered.filter((i) => i.status === filter);
  // O resumo não depende da situação: é o mesmo nas duas listas.
  const summary = (all.list ?? pending.list)?.summary;
  const counts: Record<Filter, number | undefined> = summary
    ? { pending: summary.pending, checked: summary.checked, rejected: summary.rejected, all: summary.pending + summary.checked + summary.rejected }
    : { pending: undefined, checked: undefined, rejected: undefined, all: undefined };
  const cut = list ? list.total_count > list.items.length : false;
  const busy = review.check.isPending || review.uncheck.isPending;
  const empty = FILTERS.find((f) => f.key === filter)?.empty ?? "Nenhuma nota fiscal";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* No celular as quatro não cabem: a fileira rola de lado (sem barra; a aba escolhida vem para a vista). */}
        <Tabs<Filter>
          variant="segmented"
          className="max-w-full overflow-x-auto [scrollbar-width:none]"
          items={FILTERS.map((f) => ({ key: f.key, label: f.label, count: counts[f.key] }))}
          value={filter}
          onChange={setFilter}
          ariaLabel="Situação das notas"
          idPrefix="notas"
        />
        {summary && (summary.pending_amount > 0 || summary.checked_amount > 0) ? (
          <p className="text-xs text-ink-muted tabular-nums">
            <span className="font-semibold text-ink">{formatMoney(summary.pending_amount)}</span> a conferir ·{" "}
            <span className="font-semibold text-ink">{formatMoney(summary.checked_amount)}</span> conferidos
          </p>
        ) : null}
      </div>
      {cut && list ? (
        <p className="mb-3 text-xs text-ink-muted">
          {filter === "pending"
            ? `A lista mostra as ${intFmt(list.items.length)} notas mais antigas de ${intFmt(list.total_count)} a conferir: as seguintes entram conforme estas forem conferidas.`
            : `A lista mostra as ${intFmt(list.items.length)} notas mais recentes de ${intFmt(list.total_count)}: escolha um mês ou um técnico para ver todas.`}
        </p>
      ) : null}

      <div role="tabpanel" id={`notas-panel-${filter}`} aria-labelledby={`notas-tab-${filter}`}>
        {loading ? (
          <LoadingBlock rows={4} />
        ) : error && !list ? (
          <ErrorBox message={errorMessage(error)} onRetry={onRetry} />
        ) : (
          <>
            {error ? (
              <div className="mb-3">
                <ErrorBox message={errorMessage(error)} onRetry={onRetry} />
              </div>
            ) : null}
            {!visible.length ? (
              <Card>
                <EmptyState
                  icon={<ReceiptText />}
                  title={empty}
                  description={month ? `Nada com competência em ${competenceLabel(month)}.` : undefined}
                  action={
                    onClearTechnician ? (
                      <Button onClick={onClearTechnician} disabled={stale}>
                        Ver todos os técnicos
                      </Button>
                    ) : undefined
                  }
                />
              </Card>
            ) : (
              <Card className={clsx("overflow-hidden transition-opacity duration-150", stale && "opacity-60")}>
                <ul className="divide-y divide-line" aria-busy={stale}>
                  {visible.map((invoice) => (
                    <InvoiceRow
                      key={invoice.id}
                      invoice={invoice}
                      canEdit={canEdit}
                      stale={stale}
                      disabled={stale || busy}
                      checking={review.check.isPending && review.check.variables?.id === invoice.id}
                      unchecking={review.uncheck.isPending && review.uncheck.variables?.id === invoice.id}
                      onOpen={onOpen}
                      onOpenFile={onOpenFile}
                      onCheck={() => review.check.mutate(invoice)}
                      onUncheck={() => review.uncheck.mutate(invoice)}
                    />
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function InvoiceRow({
  invoice,
  canEdit,
  stale,
  disabled,
  checking,
  unchecking,
  onOpen,
  onOpenFile,
  onCheck,
  onUncheck,
}: {
  invoice: TechnicianInvoice;
  canEdit: boolean;
  /** Linha da lista anterior: o link do arquivo é o da lista nova, que ainda não chegou. */
  stale: boolean;
  /** Lista desatualizada ou outra conferência em andamento. */
  disabled: boolean;
  checking: boolean;
  unchecking: boolean;
  onOpen: (invoice: TechnicianInvoice, rejecting?: boolean) => void;
  onOpenFile: (invoice: TechnicianInvoice) => void;
  onCheck: () => void;
  onUncheck: () => void;
}) {
  const status = INVOICE_STATUS[invoice.status];
  const difference = invoiceDifference(invoice);
  // Numa linha só a partir de telas largas, com colunas de largura fixa (valor, situação e botões alinhados
  // de uma nota para outra); antes disso, os botões descem para a linha de baixo.
  return (
    <li
      className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 transition-colors hover:bg-surface-2/60 xl:flex-nowrap"
      onClick={() => onOpen(invoice)}
    >
      <div className="min-w-0 flex-1 basis-72">
        <p className="truncate text-sm text-ink">
          {/* O nome é o alvo do teclado; o clique em qualquer ponto da linha também abre a nota. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(invoice);
            }}
            aria-label={`${invoice.technician.name}: abrir a nota ${invoiceNo(invoice)}`}
            className="rounded font-bold text-ink hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          >
            {invoice.technician.name}
          </button>
          <span className="font-medium"> · Nota {invoiceNo(invoice)}</span>
        </p>
        <p className="text-xs text-pretty text-ink-muted">
          Competência {competenceLabel(invoice.competence)} · emitida em {formatDate(invoice.issue_date)} · {invoicePayoutsText(invoice)}
          {difference ? (
            <span className="font-medium text-amber-700 dark:text-amber-400"> · diferença de {formatMoney(difference)}</span>
          ) : null}
        </p>
      </div>
      {/* Os botões valem sozinhos: o clique neles não abre a nota. */}
      <div
        className="flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-1.5 xl:w-auto xl:flex-nowrap"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-right text-sm font-semibold text-ink tabular-nums xl:w-28">{formatMoney(invoice.amount)}</span>
        <span className="flex xl:w-40">
          <Pill color={status.color}>{status.label}</Pill>
        </span>
        <span className={clsx("flex items-center justify-end gap-1", canEdit && "xl:w-[17.75rem]")}>
          <Button size="sm" variant="ghost" disabled={stale} onClick={() => onOpenFile(invoice)} title={`Abrir ${invoice.filename}`}>
            <FileText className="size-4" />
            Arquivo
          </Button>
          {canEdit && invoice.status === "pending" ? (
            <>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onOpen(invoice, true)}>
                <X className="size-4" />
                Recusar
              </Button>
              <Button size="sm" variant="primary" disabled={disabled && !checking} loading={checking} onClick={onCheck}>
                {checking ? null : <Check className="size-4" />}
                Conferir
              </Button>
            </>
          ) : null}
          {canEdit && invoice.status === "checked" ? (
            <Button size="sm" variant="ghost" disabled={disabled && !unchecking} loading={unchecking} onClick={onUncheck}>
              {unchecking ? null : <RotateCcw className="size-4" />}
              Desfazer
            </Button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

/**
 * Faixa "Nota fiscal:" no cartão do técnico (aba Fechamento), entre o cabeçalho e as OS: as notas dele no
 * período ("nº 1234 · R$ 900,00 · Conferida"), que abrem o diálogo da nota. Muitas: as primeiras e o "+N",
 * que leva à aba Notas fiscais com o técnico escolhido.
 */
export function InvoiceStrip({
  invoices,
  onOpen,
  onMore,
}: {
  invoices: TechnicianInvoice[];
  onOpen: (invoice: TechnicianInvoice) => void;
  onMore: () => void;
}) {
  // A ordenação é estável: dentro de cada situação, segue a ordem recebida (a da conferência).
  const shown = [...invoices].sort((a, b) => STRIP_RANK[a.status] - STRIP_RANK[b.status]).slice(0, STRIP_MAX);
  const more = invoices.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-surface-2/50 px-5 py-2 text-xs">
      <span className="font-semibold text-ink-muted">{invoices.length > 1 ? "Notas fiscais:" : "Nota fiscal:"}</span>
      {shown.map((invoice) => {
        const status = INVOICE_STATUS[invoice.status];
        return (
          <button
            key={invoice.id}
            type="button"
            onClick={() => onOpen(invoice)}
            title={`Abrir a nota ${invoiceNo(invoice)}`}
            className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 font-medium text-ink shadow-elev-1 transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: status.color }} />
            <span className="truncate tabular-nums">
              {invoiceNo(invoice)} · {formatMoney(invoice.amount)} · {status.label}
            </span>
          </button>
        );
      })}
      {more > 0 ? (
        <button
          type="button"
          onClick={onMore}
          title="Ver todas na aba Notas fiscais"
          className="inline-flex h-6 items-center rounded-full px-2 font-semibold text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          +{intFmt(more)}
        </button>
      ) : null}
    </div>
  );
}
