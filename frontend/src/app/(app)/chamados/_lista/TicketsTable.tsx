"use client";

import clsx from "clsx";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useEffect, useRef } from "react";
import { CopyGroupTextButton } from "@/components/ticket/MessagesPanel";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import { Skeleton, Table, Td, Th } from "@/components/ui";
import type { TicketListItem, UUID } from "@/lib/types";
import {
  CreatedCell,
  CustomerCell,
  IdentifierCell,
  LocationCell,
  OwnerCell,
  PriorityCell,
  ScheduleCell,
  SlaCell,
  StatusCell,
  TechnicianCell,
  TitleCell,
} from "./cells";
import { type ColumnDef, type ColumnKey, type ColumnSort, IDENTIFIER_SORT, splitOrder } from "./columns";
import { TagsCell } from "./tags";

// Linha com fundo opaco (as colunas presas nas bordas herdam dele e cobrem o que rola por baixo):
// passar o mouse escurece um pouco; marcada, ganha um toque da marca.
const ROW =
  "cursor-pointer bg-surface transition-colors hover:bg-[var(--row-hover)] " +
  "data-[selected=true]:bg-[color-mix(in_srgb,var(--brand)_6%,var(--surface))] " +
  "data-[selected=true]:hover:bg-[color-mix(in_srgb,var(--brand)_10%,var(--surface))]";

// Seleção e identificador presos à esquerda: rolando a tabela para o lado (tela estreita, muitas
// colunas), dá para saber de qual OS é cada linha. A coluna "Editar" fica presa à direita. No corpo,
// as células presas herdam o fundo da linha; no cabeçalho, ficam com o fundo dele (o do Th).
const STICKY_BOX = "sticky left-0 w-10 max-w-10 min-w-10 pr-0";
const STICKY_ID = "sticky left-10 shadow-[inset_-1px_0_0_var(--line)]";
const STICKY_HEAD = "z-[2]";
const STICKY_BODY = "z-[1] bg-inherit";

/** Cabeçalho que ordena a lista: o primeiro clique usa a direção natural da coluna, o seguinte inverte. */
function SortHeader({
  label,
  sort,
  order,
  onSort,
  className,
}: {
  label: string;
  sort: ColumnSort;
  order: string;
  onSort: (order: string) => void;
  className?: string;
}) {
  const { field, dir } = splitOrder(order);
  const active = field === sort.field;
  const next = active ? (dir === "asc" ? "desc" : "asc") : sort.first;
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <Th aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined} className={className}>
      <button
        type="button"
        onClick={() => onSort(next === "desc" ? `-${sort.field}` : sort.field)}
        title={`Ordenar por ${label.toLowerCase()}`}
        className={clsx(
          "-mx-1.5 -my-1 inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-bold tracking-[0.06em] uppercase transition-colors hover:bg-surface-3 hover:text-ink",
          active ? "text-ink" : "text-ink-muted",
        )}
      >
        {label}
        <Icon aria-hidden className={clsx("size-3.5 shrink-0", !active && "opacity-60")} />
      </button>
    </Th>
  );
}

/** Caixa "marcar todas desta página": parcial (traço) quando só algumas estão marcadas. */
function PageCheckbox({ checked, partial, disabled, onChange }: { checked: boolean; partial: boolean; disabled: boolean; onChange: () => void }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = partial;
  }, [partial]);
  return (
    <input
      ref={box}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label="Selecionar as OS desta página"
      className="size-4 cursor-pointer align-middle accent-[var(--brand)] disabled:cursor-default"
    />
  );
}

/** O conteúdo de cada coluna escolhível. */
function cell(key: ColumnKey, t: TicketListItem, ctx: CellContext): React.ReactNode {
  switch (key) {
    case "tags":
      return <TagsCell tags={t.tags} />;
    case "scheduled":
      return <ScheduleCell t={t} now={ctx.now} />;
    case "customer":
      return <CustomerCell t={t} />;
    case "location":
      return <LocationCell t={t} />;
    case "status":
      return <StatusCell t={t} />;
    case "priority":
      return <PriorityCell t={t} />;
    case "title":
      return <TitleCell t={t} />;
    case "technician":
      return <TechnicianCell t={t} />;
    case "owner":
      return <OwnerCell t={t} userId={ctx.userId} onClaim={ctx.onClaim} claiming={ctx.claiming} />;
    case "sla":
      return <SlaCell t={t} />;
    case "created":
      return <CreatedCell t={t} />;
    case "texts":
      return <CopyGroupTextButton ticketId={t.id} label="Copiar texto" />;
  }
}

interface CellContext {
  now: number;
  userId: UUID | undefined;
  onClaim: (t: TicketListItem) => void;
  claiming: boolean;
}

/** Linhas de carregamento com a forma da tabela (no lugar de "Carregando..."). */
function SkeletonRows({ count, columns, edit }: { count: number; columns: ColumnDef[]; edit: boolean }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i} className="bg-surface" style={{ opacity: Math.max(0.35, 1 - i * 0.07) }}>
          <Td className={clsx(STICKY_BOX, STICKY_BODY)}>
            <Skeleton className="size-4 rounded" />
          </Td>
          <Td className={clsx(STICKY_ID, STICKY_BODY)}>
            <Skeleton className="h-3.5 w-12" />
          </Td>
          {columns.map((c) => (
            <Td key={c.key}>
              <Skeleton className={clsx("h-3", c.key === "location" || c.key === "title" ? "w-40" : c.key === "tags" ? "w-28" : "w-20")} />
              {c.key === "scheduled" || c.key === "location" ? <Skeleton className="mt-1.5 h-2.5 w-12" /> : null}
            </Td>
          ))}
          {edit ? (
            <Td edit className="bg-inherit!">
              <Skeleton className="mx-auto size-8 rounded-lg" />
            </Td>
          ) : null}
        </tr>
      ))}
    </>
  );
}

/**
 * Tabela de chamados no formato da lista de atividades do Field Control: seleção, identificador,
 * etiquetas, agendamento, cliente e localização (mais as colunas escolhidas em "Colunas") e "Editar"
 * presa à direita. O clique na linha abre a OS no painel; Ctrl+clique ou o botão do meio abrem a
 * página da OS em outra aba. Sem `rows`, mostra linhas de carregamento.
 */
export function TicketsTable({
  rows,
  skeletonRows,
  columns,
  order,
  onSort,
  selected,
  onToggle,
  onTogglePage,
  edit,
  onOpen,
  ctx,
}: {
  rows: TicketListItem[] | null;
  skeletonRows: number;
  columns: ColumnDef[];
  order: string;
  onSort: (order: string) => void;
  selected: ReadonlySet<UUID>;
  onToggle: (id: UUID) => void;
  onTogglePage: () => void;
  /** Coluna "Editar" (abre a OS no painel). */
  edit: boolean;
  onOpen: (id: UUID) => void;
  ctx: CellContext;
}) {
  const list = rows ?? [];
  const marked = list.filter((t) => selected.has(t.id)).length;

  const openInTab = (id: UUID) => window.open(`/chamados/${id}`, "_blank", "noopener");
  const onRowClick = (e: React.MouseEvent<HTMLTableRowElement>, t: TicketListItem) => {
    // Só o clique na própria linha (não o que vem de uma janela aberta a partir dela).
    if (!e.currentTarget.contains(e.target as Node)) return;
    // Arrastou para copiar um texto (loja, cliente, nº da OS): não abre nada.
    if (window.getSelection()?.toString()) return;
    if (e.ctrlKey || e.metaKey) openInTab(t.id);
    else onOpen(t.id);
  };

  return (
    <Table label="Lista de chamados">
      <thead>
        <tr>
          <Th className={clsx(STICKY_BOX, STICKY_HEAD)}>
            <PageCheckbox
              checked={list.length > 0 && marked === list.length}
              partial={marked > 0 && marked < list.length}
              disabled={!list.length}
              onChange={onTogglePage}
            />
          </Th>
          <SortHeader label="Identificador" sort={IDENTIFIER_SORT} order={order} onSort={onSort} className={clsx(STICKY_ID, STICKY_HEAD)} />
          {columns.map((c) =>
            c.sort ? <SortHeader key={c.key} label={c.label} sort={c.sort} order={order} onSort={onSort} /> : <Th key={c.key}>{c.label}</Th>,
          )}
          {edit ? <Th edit>Editar</Th> : null}
        </tr>
      </thead>
      {/* Linhas sem entrada animada: trocar de página ou filtro mostra o dado na hora. */}
      <tbody>
        {rows === null ? (
          <SkeletonRows count={skeletonRows} columns={columns} edit={edit} />
        ) : (
          rows.map((t) => {
            const isSelected = selected.has(t.id);
            return (
              <tr
                key={t.id}
                data-selected={isSelected || undefined}
                onClick={(e) => onRowClick(e, t)}
                onMouseDown={(e) => {
                  // Botão do meio fora de um link: sem a rolagem automática do navegador.
                  if (e.button === 1 && !(e.target as Element).closest("a")) e.preventDefault();
                }}
                onAuxClick={(e) => {
                  // Botão do meio num link já abre a aba sozinho.
                  if (e.button !== 1 || !e.currentTarget.contains(e.target as Node) || (e.target as Element).closest("a")) return;
                  e.preventDefault();
                  openInTab(t.id);
                }}
                className={ROW}
              >
                {/* A célula toda marca a OS (alvo maior que a caixa) e o clique nela não abre a OS. */}
                <Td className={clsx(STICKY_BOX, STICKY_BODY)} onClick={(e) => e.stopPropagation()}>
                  <label className="-my-3 flex cursor-pointer items-center py-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggle(t.id)}
                      aria-label={`Selecionar a OS ${t.number}`}
                      className="size-4 cursor-pointer accent-[var(--brand)]"
                    />
                  </label>
                </Td>
                <Td className={clsx(STICKY_ID, STICKY_BODY)}>
                  <IdentifierCell t={t} />
                </Td>
                {columns.map((c) => (
                  <Td key={c.key} className={c.key === "texts" ? "w-1 whitespace-nowrap" : undefined}>
                    {cell(c.key, t, ctx)}
                  </Td>
                ))}
                {edit ? (
                  <Td edit className="bg-inherit!">
                    <QuickEditButton ticketId={t.id} code={t.code} />
                  </Td>
                ) : null}
              </tr>
            );
          })
        )}
      </tbody>
    </Table>
  );
}
