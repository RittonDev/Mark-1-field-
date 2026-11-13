"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight, FileDown, MapPin, MapPinOff, Plus, Search, SquarePen, Upload, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { LocationDialog, validCoords } from "@/components/LocationDialog";
import { LOCATION_COLUMNS, LocationImportDialog } from "@/components/LocationImportDialog";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorBox,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { downloadCsv } from "@/lib/download";
import { formatDate, formatDocument, todayISO } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCustomers, useLocationSearch } from "@/lib/queries";
import type { Location, Page } from "@/lib/types";

const PAGE_SIZE = 50;
/** Exportação: páginas grandes (o máximo da API) até completar o filtro. */
const EXPORT_PAGE = 200;

const plural = (n: number) => `${n.toLocaleString("pt-BR")} ${n === 1 ? "local" : "locais"}`;

/** Busca, filtros e página na URL: ao voltar da ficha da loja, a lista está como foi deixada. */
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

const documentOrBlank = (value: string | null | undefined) => (value ? formatDocument(value) : "");
// Coordenada com vírgula decimal: abre certa no Excel brasileiro e volta igual pela importação.
const coordOrBlank = (value: number | null) => (value === null ? "" : String(value).replace(".", ","));

function LocationsView() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canEdit = canManageTickets(user?.role);
  const customers = useCustomers();
  const [params, setParams] = useUrlParams();
  const urlQ = params.get("q") ?? "";
  const customerId = params.get("customer_id") ?? "";
  const onlyActive = params.get("inativos") !== "1";
  const page = Math.max(1, Math.floor(Number(params.get("pagina"))) || 1);
  const [search, setSearch] = useState(urlQ);
  const [syncedQ, setSyncedQ] = useState(urlQ);
  const [editing, setEditing] = useState<Location | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const debounced = useDebounced(search.trim(), 350);

  // Voltar/avançar no navegador trocou a busca da URL: o campo acompanha (a busca que saiu daqui, não).
  if (urlQ !== syncedQ) {
    setSyncedQ(urlQ);
    if (urlQ !== debounced) setSearch(urlQ);
  }
  // A busca digitada vai para a URL quando a digitação para (e volta para a página 1).
  useEffect(() => {
    if (debounced !== search.trim() || debounced === urlQ) return;
    setParams({ q: debounced || null, pagina: null });
  }, [debounced, search, urlQ, setParams]);

  const filters = { q: urlQ || undefined, customer_id: customerId || undefined, active: onlyActive ? true : undefined };
  const locations = useLocationSearch({
    q: urlQ,
    customerId: customerId || null,
    active: filters.active,
    page,
    pageSize: PAGE_SIZE,
  });
  const data = locations.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const customerName = customers.data?.find((c) => c.id === customerId)?.name;

  /** Planilha com os locais do filtro, nas colunas da importação (corrige no Excel e importa de volta). */
  const exportCsv = async () => {
    setExporting("...");
    try {
      const rows: Location[] = [];
      let total = 0;
      for (let p = 1; p <= 100 && (p === 1 || rows.length < total); p += 1) {
        const chunk = await api.get<Page<Location>>("/locations", { ...filters, page: p, page_size: EXPORT_PAGE });
        rows.push(...chunk.items);
        total = chunk.total;
        setExporting(`${rows.length.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")}`);
        if (chunk.items.length === 0) break;
      }
      const documents = new Map((customers.data ?? []).map((c) => [c.id, c.document]));
      downloadCsv(`locais-${todayISO()}.csv`, [
        [...LOCATION_COLUMNS, "ativo", "os_abertas", "total_os", "ultima_os"],
        ...rows.map((l) => [
          l.customer.name,
          documentOrBlank(documents.get(l.customer_id)),
          l.code,
          l.name,
          documentOrBlank(l.document),
          l.address_line,
          l.district,
          l.city,
          l.state,
          l.zip_code,
          coordOrBlank(l.latitude),
          coordOrBlank(l.longitude),
          l.contact_name,
          l.contact_phone,
          l.notes,
          l.is_active ? "sim" : "não",
          l.open_tickets,
          l.total_tickets,
          l.last_ticket_at ? formatDate(l.last_ticket_at) : "",
        ]),
      ]);
      toast({ title: `${plural(rows.length)} na planilha`, tone: "success" });
    } catch (error) {
      toast({ title: "Não foi possível exportar", description: errorMessage(error), tone: "error" });
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Locais de atendimento"
        description={
          data
            ? `${plural(data.total)} · filiais, lojas e unidades onde os técnicos atendem`
            : "Filiais, lojas e unidades onde os técnicos atendem"
        }
        actions={
          <>
            <Button onClick={() => void exportCsv()} loading={exporting !== null} disabled={!data || data.total === 0}>
              {exporting === null ? <FileDown className="size-4" /> : null}
              {exporting === null ? "Exportar" : `Exportando ${exporting}`}
            </Button>
            {canEdit ? (
              <>
                <Button onClick={() => setImporting(true)}>
                  <Upload className="size-4" />
                  Importar planilha
                </Button>
                <Button variant="primary" onClick={() => setEditing("new")}>
                  <Plus className="size-4" />
                  Novo local
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <Card className="mb-4 p-3">
        <div className="grid gap-2 md:grid-cols-[2fr_1fr_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome, código, CNPJ, endereço ou cliente"
              aria-label="Buscar locais"
              className="pl-9"
            />
          </div>
          <Select
            value={customerId}
            onChange={(e) => setParams({ customer_id: e.target.value || null, pagina: null })}
            aria-label="Cliente"
          >
            <option value="">Todos os clientes</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {customerId && !customerName ? <option value={customerId}>Cliente escolhido</option> : null}
          </Select>
          <div className="flex items-center px-1">
            <Checkbox
              label="Somente ativos"
              checked={onlyActive}
              onChange={(only) => setParams({ inativos: only ? null : "1", pagina: null })}
            />
          </div>
        </div>
        {customerId ? (
          <button
            type="button"
            onClick={() => setParams({ customer_id: null, pagina: null })}
            className="mt-2 inline-flex items-center gap-1 rounded-full bg-brand/10 px-2.5 py-1 text-xs text-brand"
            aria-label="Tirar o filtro de cliente"
          >
            {customerName ? `Cliente: ${customerName}` : "Filtrando por cliente"}
            <X className="size-3" />
          </button>
        ) : null}
      </Card>

      <Card>
        {locations.isLoading ? (
          <LoadingBlock />
        ) : locations.error && !data ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(locations.error)} />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState icon={<MapPin className="size-8" />} title="Nenhum local encontrado" />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Código</Th>
                  <Th>Local</Th>
                  <Th>Cliente</Th>
                  <Th>CNPJ / CPF</Th>
                  <Th>Cidade</Th>
                  <Th className="text-right">OS abertas</Th>
                  <Th className="text-right">Total de OS</Th>
                  <Th>Última OS</Th>
                  {canEdit ? <Th className="edit-col">Editar</Th> : null}
                </tr>
              </thead>
              {/* Linhas sem entrada animada; trocando de página ou de busca, a lista anterior fica esmaecida. */}
              <tbody className={clsx("transition-opacity duration-150", locations.isPlaceholderData && "opacity-60")}>
                {data.items.map((l) => (
                  <tr key={l.id} className="transition-colors hover:bg-[var(--row-hover)]">
                    <Td className="font-mono text-xs">{l.code ?? "—"}</Td>
                    <Td className="min-w-[14rem]">
                      <p className="flex flex-wrap items-center gap-x-1.5 font-semibold text-ink">
                        <Link href={`/locais/${l.id}`} className="hover:text-brand hover:underline">
                          {l.name}
                        </Link>
                        {!l.is_active ? (
                          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-line ring-inset">
                            Inativo
                          </span>
                        ) : null}
                        {validCoords(l.latitude, l.longitude) ? null : (
                          <span title="Sem coordenadas válidas: a distância dos técnicos usa o centro da cidade">
                            <MapPinOff className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
                            <span className="sr-only">sem coordenadas válidas</span>
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {[l.address_line, l.district].filter(Boolean).join(" · ") || "Sem endereço"}
                      </p>
                    </Td>
                    <Td className="text-sm">{l.customer.name}</Td>
                    <Td className="font-mono text-xs whitespace-nowrap">{formatDocument(l.document)}</Td>
                    <Td className="text-xs whitespace-nowrap text-ink-muted">
                      {l.city ? `${l.city}${l.state ? `/${l.state}` : ""}` : "—"}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {l.open_tickets > 0 ? (
                        <Link
                          href={`/chamados?location_id=${l.id}&open_only=true`}
                          className="font-medium text-brand hover:underline"
                          aria-label={`${l.open_tickets} ${l.open_tickets === 1 ? "OS aberta" : "OS abertas"} em ${l.name}`}
                        >
                          {l.open_tickets}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">0</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {l.total_tickets > 0 ? (
                        <Link
                          href={`/chamados?location_id=${l.id}`}
                          className="hover:underline"
                          aria-label={`${l.total_tickets.toLocaleString("pt-BR")} OS em ${l.name}`}
                        >
                          {l.total_tickets.toLocaleString("pt-BR")}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">0</span>
                      )}
                    </Td>
                    <Td className="text-xs whitespace-nowrap text-ink-muted">{formatDate(l.last_ticket_at)}</Td>
                    {canEdit ? (
                      <Td className="edit-col">
                        <button
                          type="button"
                          onClick={() => setEditing(l)}
                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1 transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft active:translate-y-px"
                          aria-label={`Editar ${l.name}`}
                          title={`Editar ${l.name}`}
                        >
                          <SquarePen className="size-4" />
                        </button>
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm text-ink-muted">
              <span>
                Página {data.page} de {totalPages.toLocaleString("pt-BR")} · {plural(data.total)}
              </span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setParams({ pagina: page > 2 ? String(page - 1) : null })}>
                  <ChevronLeft className="size-4" />
                  Anterior
                </Button>
                <Button size="sm" disabled={page >= totalPages} onClick={() => setParams({ pagina: String(page + 1) })}>
                  Próxima
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {importing ? <LocationImportDialog customerId={customerId || null} onClose={() => setImporting(false)} /> : null}
      {editing ? (
        <LocationDialog
          location={editing === "new" ? null : editing}
          customerId={customerId || null}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

export default function LocationsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LocationsView />
    </Suspense>
  );
}
