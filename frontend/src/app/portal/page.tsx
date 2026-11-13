"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CalendarClock, ChevronRight, Inbox, Plus, Search, Store, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useState } from "react";
import { Badge } from "@/components/portal/Badge";
import { Tabs } from "@/components/motion";
import { Button, EmptyState, ErrorBox, Input, LoadingBlock, PageHeader, Select } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { Page, PortalLocation, PortalRequestItem } from "@/lib/types";

type Scope = "open" | "done" | "all";

const PAGE = 20;
const FINAL = ["resolved", "closed", "cancelled"];

function VisitLine({ item }: { item: PortalRequestItem }) {
  if (item.status === "cancelled") return null;
  if (item.resolved_at) {
    return <span>Concluída {formatDateTime(item.resolved_at)}</span>;
  }
  if (!item.scheduled_start && !item.technician) return <span>A central está analisando</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {item.scheduled_start ? (
        <span className="inline-flex items-center gap-1">
          <CalendarClock className="size-3.5" />
          Visita {formatDateTime(item.scheduled_start)}
        </span>
      ) : null}
      {item.technician ? (
        <span className="inline-flex items-center gap-1">
          <UserRound className="size-3.5" />
          {item.technician}
        </span>
      ) : null}
    </span>
  );
}

/** Solicitações da empresa: em andamento primeiro, com o que importa ao cliente (visita e técnico). */
export default function PortalRequestsPage() {
  const router = useRouter();
  const now = useNow(60_000);
  const [scope, setScope] = useState<Scope>("open");
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const [locationId, setLocationId] = useState("");
  const [size, setSize] = useState(PAGE);

  const stores = useQuery({
    queryKey: ["portal", "locations"],
    queryFn: () => api.get<PortalLocation[]>("/portal/locations"),
    staleTime: 5 * 60_000,
  });
  const list = useQuery({
    queryKey: ["portal", "requests", scope, q, locationId, size],
    queryFn: () =>
      api.get<Page<PortalRequestItem>>("/portal/requests", {
        scope,
        q: q || undefined,
        location_id: locationId || undefined,
        page: 1,
        page_size: size,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div>
      <PageHeader
        title="Solicitações"
        description="Abra um chamado para a Maxx e acompanhe a visita na sua loja."
        actions={
          <Button variant="primary" size="lg" onClick={() => router.push("/portal/nova")}>
            <Plus className="size-4" />
            Nova solicitação
          </Button>
        }
      />

      <Tabs<Scope>
        items={[
          { key: "open", label: "Em andamento" },
          { key: "done", label: "Encerradas" },
          { key: "all", label: "Todas" },
        ]}
        value={scope}
        onChange={(key) => {
          setScope(key);
          setSize(PAGE);
        }}
        ariaLabel="Situação das solicitações"
        className="mb-4"
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar pelo nº, pelo assunto ou pelo seu nº de chamado"
            className="pl-9"
            aria-label="Buscar solicitações"
          />
        </div>
        {(stores.data?.length ?? 0) > 1 ? (
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="sm:w-64" aria-label="Loja">
            <option value="">Todas as lojas</option>
            {stores.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code ? `${s.code} · ${s.name}` : s.name}
              </option>
            ))}
          </Select>
        ) : null}
      </div>

      {list.isLoading ? (
        <LoadingBlock rows={4} />
      ) : list.error ? (
        <ErrorBox message={errorMessage(list.error)} />
      ) : !items.length ? (
        <EmptyState
          icon={<Inbox />}
          title={scope === "open" ? "Nenhuma solicitação em andamento" : "Nenhuma solicitação aqui"}
          description="Quando algo parar na loja, abra uma solicitação: a central da Maxx analisa e envia um técnico."
          action={
            <Button variant="primary" onClick={() => router.push("/portal/nova")}>
              <Plus className="size-4" />
              Nova solicitação
            </Button>
          }
        />
      ) : (
        <ul className="stagger flex flex-col gap-2.5">
          {items.map((item, i) => (
            <li key={item.id} style={{ ["--i" as string]: i }}>
              <Link
                href={`/portal/${item.id}`}
                className="group flex items-start gap-3 rounded-xl border border-line bg-surface p-4 shadow-elev-1 transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-elev-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge status={item.status} />
                    <span className="font-mono text-[11px] text-ink-subtle">{item.code}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 font-semibold text-ink">{item.title}</p>
                  <p className="mt-1 flex min-w-0 items-center gap-1 text-xs text-ink-muted">
                    <Store className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {item.location ? item.location.name : "Sem loja"} · aberta {formatRelative(item.created_at, now)}
                      {item.requester_name ? ` por ${item.requester_name}` : ""}
                    </span>
                  </p>
                  {FINAL.includes(item.status) && !item.resolved_at ? null : (
                    <p className="mt-1.5 text-xs text-ink-muted">
                      <VisitLine item={item} />
                    </p>
                  )}
                </div>
                <ChevronRight className="mt-1 size-4 shrink-0 text-ink-subtle transition-colors group-hover:text-ink" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {items.length < total ? (
        <div className="mt-4 flex justify-center">
          <Button onClick={() => setSize((s) => s + PAGE)} loading={list.isFetching}>
            Mostrar mais
          </Button>
        </div>
      ) : null}
    </div>
  );
}
