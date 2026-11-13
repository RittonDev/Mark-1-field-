"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowUp, ArrowUpDown, Building2, MapPin, Plus, Search, SquarePen, Star } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { TagChips } from "@/components/TagChips";
import { Button, Card, Checkbox, EmptyState, ErrorBox, Input, LoadingBlock, PageHeader, Table, Td, Th } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDocument } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import type { Customer } from "@/lib/types";
import { CustomerDialog } from "./CustomerDialog";

type SortKey = "name" | "locations" | "open" | "total" | "last" | "first" | "rating";
type Sort = { key: SortKey; desc: boolean } | null;

const SORT_VALUE: Record<SortKey, (c: Customer) => string | number> = {
  name: (c) => c.name,
  locations: (c) => c.locations_count,
  open: (c) => c.open_tickets,
  total: (c) => c.total_tickets,
  last: (c) => c.last_ticket_at ?? "",
  first: (c) => c.legacy?.service?.first_at ?? "",
  rating: (c) => c.legacy?.rating?.average ?? 0,
};

/** No primeiro clique, o nome vai de A a Z; números e datas, do maior (ou mais recente) para o menor. */
const ASCENDING_FIRST: SortKey[] = ["name"];

function parseSort(value: string | null): Sort {
  if (!value) return null;
  const desc = value.startsWith("-");
  const key = (desc ? value.slice(1) : value) as SortKey;
  return key in SORT_VALUE ? { key, desc } : null;
}

function sortCustomers(list: Customer[], sort: Sort): Customer[] {
  if (!sort) return list;
  const valueOf = SORT_VALUE[sort.key];
  return [...list].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    const diff = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "pt-BR");
    return (sort.desc ? -diff : diff) || a.name.localeCompare(b.name, "pt-BR");
  });
}

/** Busca, filtro e ordem na URL: ao voltar da ficha do cliente, a lista está como foi deixada. */
function useUrlParams() {
  const router = useRouter();
  const pathname = usePathname();
  const update = useCallback(
    (changes: Record<string, string | null>) => {
      // Parte da URL de agora: o painel da OS (?os=) e o que mais estiver nela continuam.
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(changes)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  return [useSearchParams(), update] as const;
}

/** Cabeçalho ordenável: o botão troca a ordem e o aria-sort conta ao leitor de tela qual está valendo. */
function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  right = false,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  right?: boolean;
  className?: string;
}) {
  const direction = sort && sort.key === sortKey ? (sort.desc ? "descending" : "ascending") : undefined;
  const Icon = direction === "descending" ? ArrowDown : direction === "ascending" ? ArrowUp : ArrowUpDown;
  return (
    <Th aria-sort={direction} numeric={right} className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={clsx(
          "inline-flex items-center gap-1 rounded uppercase transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
          direction && "text-ink",
          right && "flex-row-reverse",
        )}
      >
        {label}
        <Icon aria-hidden className={clsx("size-3 shrink-0", !direction && "opacity-60")} />
      </button>
    </Th>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;

function CustomersView() {
  const { user } = useAuth();
  const canEdit = canManageTickets(user?.role);
  const [params, setParams] = useUrlParams();
  const urlQ = params.get("q") ?? "";
  const showInactive = params.get("inativos") === "1";
  const sort = parseSort(params.get("ordem"));
  const [search, setSearch] = useState(urlQ);
  const [syncedQ, setSyncedQ] = useState(urlQ);
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const debounced = useDebounced(search.trim(), 300);

  // Voltar/avançar no navegador trocou a busca da URL: o campo acompanha (a busca que saiu daqui, não).
  if (urlQ !== syncedQ) {
    setSyncedQ(urlQ);
    if (urlQ !== debounced) setSearch(urlQ);
  }
  // A busca digitada vai para a URL quando a digitação para.
  useEffect(() => {
    if (debounced !== search.trim() || debounced === urlQ) return;
    setParams({ q: debounced || null });
  }, [debounced, search, urlQ, setParams]);

  const customers = useQuery({
    queryKey: ["customers", urlQ],
    queryFn: () => api.get<Customer[]>("/customers", { q: urlQ || undefined }),
    staleTime: 60_000,
    // Trocar a busca mantém a tabela (esmaecida) até a resposta, sem piscar o esqueleto.
    placeholderData: keepPreviousData,
  });
  const all = customers.data ?? [];
  const hidden = showInactive ? 0 : all.filter((c) => !c.is_active).length;
  const rows = sortCustomers(showInactive ? all : all.filter((c) => c.is_active), sort);
  const onSort = (key: SortKey) => {
    const desc = sort?.key === key ? !sort.desc : !ASCENDING_FIRST.includes(key);
    setParams({ ordem: `${desc ? "-" : ""}${key}` });
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Clientes"
        description="Empresas atendidas, com o histórico resumido das OS. Filiais e lojas ficam em Locais."
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus className="size-4" />
              Novo cliente
            </Button>
          ) : null
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line p-3">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome ou CNPJ"
              aria-label="Buscar clientes"
              className="pl-9"
            />
          </div>
          <Checkbox
            label="Somente ativos"
            checked={!showInactive}
            onChange={(only) => setParams({ inativos: only ? null : "1" })}
          />
          {customers.data ? (
            <span className="text-xs text-ink-muted sm:ml-auto">
              {plural(rows.length, "cliente", "clientes")}
              {hidden ? ` · ${plural(hidden, "inativo oculto", "inativos ocultos")}` : ""}
            </span>
          ) : null}
        </div>
        {customers.isLoading ? (
          <LoadingBlock />
        ) : customers.error && !customers.data ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(customers.error)} onRetry={() => void customers.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Building2 className="size-8" />}
            title="Nenhum cliente encontrado"
            description={hidden ? `Há ${plural(hidden, "cliente inativo", "clientes inativos")}: desmarque “Somente ativos” para ver.` : undefined}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <SortTh label="Cliente" sortKey="name" sort={sort} onSort={onSort} />
                <Th>CNPJ / CPF</Th>
                <SortTh label="Locais" sortKey="locations" sort={sort} onSort={onSort} right />
                <SortTh label="OS abertas" sortKey="open" sort={sort} onSort={onSort} right />
                <SortTh label="Total de OS" sortKey="total" sort={sort} onSort={onSort} right />
                <SortTh label="Última OS" sortKey="last" sort={sort} onSort={onSort} />
                <SortTh label="Primeira visita" sortKey="first" sort={sort} onSort={onSort} className="hidden lg:table-cell" />
                <SortTh label="Avaliação" sortKey="rating" sort={sort} onSort={onSort} right className="hidden lg:table-cell" />
                <Th className="hidden xl:table-cell">Contato</Th>
                {canEdit ? <Th className="edit-col">Editar</Th> : null}
              </tr>
            </thead>
            {/* Linhas sem entrada animada; enquanto a busca nova chega, a tabela anterior fica esmaecida. */}
            <tbody className={clsx("transition-opacity duration-150", customers.isPlaceholderData && "opacity-60")}>
              {rows.map((c) => {
                const rating = c.legacy?.rating?.average ?? 0;
                return (
                  <tr key={c.id} className="transition-colors hover:bg-[var(--row-hover)]">
                    <Td className="min-w-[14rem]">
                      <Link href={`/clientes/${c.id}`} className="font-semibold text-ink hover:text-brand hover:underline">
                        {c.name}
                      </Link>
                      {c.is_active ? null : (
                        <span className="ml-1.5 rounded-md bg-surface-2 px-1.5 py-0.5 align-middle text-[11px] font-medium text-ink-muted ring-1 ring-line ring-inset">
                          Inativo
                        </span>
                      )}
                      <TagChips tags={c.tags} max={3} className="mt-1 flex" />
                    </Td>
                    <Td className="font-mono text-xs whitespace-nowrap">{formatDocument(c.document)}</Td>
                    <Td className="text-right">
                      <Link
                        href={`/locais?customer_id=${c.id}`}
                        className="inline-flex items-center gap-1 text-brand hover:underline"
                        aria-label={`${plural(c.locations_count, "local", "locais")} de ${c.name}`}
                      >
                        <MapPin className="size-3.5" />
                        {c.locations_count.toLocaleString("pt-BR")}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {c.open_tickets > 0 ? (
                        <Link
                          href={`/chamados?customer_id=${c.id}&open_only=true`}
                          className="font-medium text-brand hover:underline"
                          aria-label={`${plural(c.open_tickets, "OS aberta", "OS abertas")} de ${c.name}`}
                        >
                          {c.open_tickets.toLocaleString("pt-BR")}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">0</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{c.total_tickets.toLocaleString("pt-BR")}</Td>
                    <Td className="text-xs whitespace-nowrap text-ink-muted">{formatDate(c.last_ticket_at)}</Td>
                    <Td className="hidden text-xs whitespace-nowrap text-ink-muted lg:table-cell">
                      {formatDate(c.legacy?.service?.first_at ?? null)}
                    </Td>
                    <Td className="hidden text-right text-xs whitespace-nowrap lg:table-cell">
                      {rating > 0 ? (
                        <span className="inline-flex items-center gap-1 text-ink tabular-nums">
                          {rating.toFixed(1).replace(".", ",")}
                          <Star className="size-3 fill-current text-ink-subtle" aria-hidden />
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </Td>
                    <Td className="hidden max-w-[16rem] truncate text-xs text-ink-muted xl:table-cell">
                      {[c.email, c.phone].filter(Boolean).join(" · ") || "—"}
                    </Td>
                    {canEdit ? (
                      <Td className="edit-col">
                        <button
                          type="button"
                          onClick={() => setEditing(c)}
                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1 transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft active:translate-y-px"
                          aria-label={`Editar ${c.name}`}
                          title={`Editar ${c.name}`}
                        >
                          <SquarePen className="size-4" />
                        </button>
                      </Td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {editing ? <CustomerDialog customer={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

export default function CustomersPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <CustomersView />
    </Suspense>
  );
}
