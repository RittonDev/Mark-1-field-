"use client";

import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";
import { useId } from "react";
import { fieldClassName } from "@/components/ui";
import { PAGE_SIZES } from "./params";

function PageButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink shadow-elev-1 transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Rodapé da lista como no Field Control: itens por página à esquerda; "1 - 25 de 102" e as páginas à direita. */
export function Pagination({
  page,
  pageSize,
  total,
  shown,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** OS nesta página. */
  shown: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const sizeId = useId();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = total === 0 ? 0 : first + shown - 1;
  const n = (value: number) => value.toLocaleString("pt-BR");
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <label htmlFor={sizeId} className="text-xs font-medium whitespace-nowrap text-ink-muted">
          Itens por página
        </label>
        <select
          id={sizeId}
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className={fieldClassName("h-8 w-auto pr-8 text-xs")}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs whitespace-nowrap text-ink-muted tabular-nums">
          {n(first)} - {n(last)} de {n(total)}
        </span>
        <nav aria-label="Páginas da lista" className="flex items-center gap-1">
          <PageButton label="Primeira página" disabled={page <= 1} onClick={() => onPage(1)}>
            <ChevronFirst aria-hidden className="size-4" />
          </PageButton>
          <PageButton label="Página anterior" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft aria-hidden className="size-4" />
          </PageButton>
          <PageButton label="Próxima página" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            <ChevronRight aria-hidden className="size-4" />
          </PageButton>
          <PageButton label="Última página" disabled={page >= pages} onClick={() => onPage(pages)}>
            <ChevronLast aria-hidden className="size-4" />
          </PageButton>
        </nav>
        <span className="sr-only" aria-live="polite">
          Página {n(page)} de {n(pages)}
        </span>
      </div>
    </div>
  );
}
