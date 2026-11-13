"use client";

import { ChevronLeft, ChevronRight, MapPin, Pencil, Plus, Search, Upload, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { LocationDialog } from "@/components/LocationDialog";
import { LocationImportDialog } from "@/components/LocationImportDialog";
import {
  Button,
  Card,
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
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatDocument } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCustomers, useLocationSearch } from "@/lib/queries";
import type { Location } from "@/lib/types";

const PAGE_SIZE = 50;

function LocationsView() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const canEdit = canManageTickets(user?.role);
  const customers = useCustomers();
  const [search, setSearch] = useState("");
  const [customerId, setCustomerId] = useState(() => searchParams.get("customer_id") ?? "");
  const [onlyActive, setOnlyActive] = useState(true);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Location | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const q = useDebounced(search.trim(), 350);

  const locations = useLocationSearch({
    q,
    customerId: customerId || null,
    active: onlyActive ? true : undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const data = locations.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(1);
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Locais de atendimento"
        description={
          data
            ? `${data.total} local(is) · filiais, lojas e unidades onde os técnicos atendem`
            : "Filiais, lojas e unidades onde os técnicos atendem"
        }
        actions={
          canEdit ? (
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
          ) : null
        }
      />

      <Card className="mb-4 p-3">
        <div className="grid gap-2 md:grid-cols-[2fr_1fr_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
            <Input
              value={search}
              onChange={(e) => resetPage(setSearch)(e.target.value)}
              placeholder="Buscar por nome, código, CNPJ, endereço ou cliente"
              className="pl-9"
            />
          </div>
          <Select value={customerId} onChange={(e) => resetPage(setCustomerId)(e.target.value)}>
            <option value="">Todos os clientes</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 px-1 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={onlyActive}
              onChange={(e) => resetPage(setOnlyActive)(e.target.checked)}
              className="size-4 accent-brand"
            />
            Somente ativos
          </label>
        </div>
        {customerId ? (
          <button
            type="button"
            onClick={() => resetPage(setCustomerId)("")}
            className="mt-2 inline-flex items-center gap-1 rounded-full bg-brand/10 px-2.5 py-1 text-xs text-brand"
          >
            Filtrando por cliente
            <X className="size-3" />
          </button>
        ) : null}
      </Card>

      <Card>
        {locations.isLoading ? (
          <LoadingBlock />
        ) : locations.error ? (
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
                  {canEdit ? <Th className="w-10" /> : null}
                </tr>
              </thead>
              <tbody>
                {data.items.map((l) => (
                  <tr key={l.id} className="hover:bg-surface-2">
                    <Td className="font-mono text-xs">{l.code ?? "—"}</Td>
                    <Td>
                      <p className="font-semibold text-ink">
                        <Link href={`/locais/${l.id}`} className="hover:text-brand hover:underline">
                          {l.name}
                        </Link>
                        {!l.is_active ? <span className="ml-1 text-xs font-normal text-ink-muted">(inativo)</span> : null}
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
                    <Td className="text-right">
                      {l.open_tickets > 0 ? (
                        <Link
                          href={`/chamados?location_id=${l.id}&open_only=true`}
                          className="font-medium text-brand hover:underline"
                        >
                          {l.open_tickets}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">0</span>
                      )}
                    </Td>
                    <Td className="text-right">
                      {l.total_tickets > 0 ? (
                        <Link href={`/chamados?location_id=${l.id}`} className="hover:underline">
                          {l.total_tickets}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">0</span>
                      )}
                    </Td>
                    <Td className="text-xs whitespace-nowrap text-ink-muted">{formatDate(l.last_ticket_at)}</Td>
                    {canEdit ? (
                      <Td>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(l)} aria-label={`Editar ${l.name}`}>
                          <Pencil className="size-3.5" />
                        </Button>
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between px-4 py-3 text-sm text-ink-muted">
              <span>
                Página {data.page} de {totalPages} · {data.total} local(is)
              </span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="size-4" />
                  Anterior
                </Button>
                <Button size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
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
