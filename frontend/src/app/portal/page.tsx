"use client";

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { CalendarClock, ChevronDown, ChevronRight, CircleAlert, Inbox, Plus, Search, Store, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/portal/Badge";
import { Tabs } from "@/components/motion";
import { Button, EmptyState, ErrorBox, Input, LoadingBlock, PageHeader, Spinner } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, formatRelative, formatTime } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { canOpenRequests, PORTAL_SUSPENDED, usePortalMe, visitWindow } from "@/lib/portal";
import type { Page, PortalLocation, PortalRequestItem } from "@/lib/types";

type Scope = "open" | "done" | "all";

const PAGE = 20;

const storeLabel = (s: PortalLocation) => (s.code ? `${s.code} · ${s.name}` : s.name);

/** Visita marcada e quem vai, ou o que a central está fazendo quando ainda não há visita. */
function Planned({ item, fallback }: { item: PortalRequestItem; fallback: string }) {
  if (!item.scheduled_start && !item.technician) return <span>{fallback}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {item.scheduled_start ? (
        <span className="inline-flex items-center gap-1">
          <CalendarClock className="size-3.5" aria-hidden />
          Visita {visitWindow(item.scheduled_start, item.scheduled_end)}
        </span>
      ) : null}
      {item.technician ? (
        <span className="inline-flex items-center gap-1">
          <UserRound className="size-3.5" aria-hidden />
          {item.technician}
        </span>
      ) : null}
    </span>
  );
}

/** A linha "e agora?" de cada solicitação, conforme a situação (a mesma palavra do selo, explicada). */
function VisitLine({ item }: { item: PortalRequestItem }) {
  switch (item.status) {
    case "cancelled":
      return <span>Cancelada {item.cancelled_at ? formatDateTime(item.cancelled_at) : ""}</span>;
    case "resolved":
    case "closed":
      return <span>Concluída {item.resolved_at ? formatDateTime(item.resolved_at) : ""}</span>;
    case "on_hold_customer":
      return <span className="font-medium text-ink">A central precisa de um retorno de vocês</span>;
    case "on_hold_vendor":
      return <span>Aguardando peça ou terceiro</span>;
    case "en_route":
      return (
        <span>
          Técnico a caminho{item.technician ? ` · ${item.technician}` : ""}
        </span>
      );
    case "in_progress":
      return (
        <span>
          Técnico na loja{item.arrived_at ? ` desde ${formatTime(item.arrived_at)}` : ""}
          {item.technician ? ` · ${item.technician}` : ""}
        </span>
      );
    case "assigned":
    case "scheduled":
      return <Planned item={item} fallback="A central vai combinar o horário da visita" />;
    case "reopened":
      return <Planned item={item} fallback="A central reabriu e vai cuidar de novo" />;
    default:
      return <span>A central está analisando</span>;
  }
}

/**
 * Filtro de loja com busca: a empresa pode ter centenas de lojas (a lista mostra as primeiras em ordem
 * alfabética e a busca acha qualquer uma pelo nome, código ou cidade).
 */
function StoreFilter({
  value,
  onChange,
  total,
}: {
  value: PortalLocation | null;
  onChange: (store: PortalLocation | null) => void;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const stores = useQuery({
    queryKey: ["portal", "locations", q],
    queryFn: () => api.get<PortalLocation[]>("/portal/locations", { q: q || undefined }),
    enabled: open,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (store: PortalLocation | null) => {
    onChange(store);
    setOpen(false);
    setSearch("");
    trigger.current?.focus();
  };
  const list = stores.data ?? [];

  return (
    <div
      ref={root}
      className="relative sm:w-72"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Loja: ${value ? storeLabel(value) : "todas as lojas"}`}
        className={clsx(
          "flex h-9 w-full items-center justify-between gap-2 rounded-lg border bg-surface px-3 text-left text-sm shadow-elev-1 transition-[border-color] duration-150 hover:border-line-strong focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/15 focus-visible:outline-none",
          value ? "border-brand/50 text-ink" : "border-line text-ink-muted",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Store className="size-4 shrink-0 text-ink-subtle" aria-hidden />
          <span className="truncate">{value ? storeLabel(value) : "Todas as lojas"}</span>
        </span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 flex w-full min-w-72 flex-col gap-2 rounded-xl border border-line bg-surface p-2 shadow-pop">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nome, código ou cidade"
              aria-label="Buscar loja"
              className="pl-9"
              autoFocus
            />
          </div>
          <ul className="max-h-72 overflow-y-auto">
            <li>
              <button
                type="button"
                onClick={() => choose(null)}
                className="w-full rounded-md px-2.5 py-2 text-left text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
              >
                Todas as lojas
              </button>
            </li>
            {stores.isLoading ? (
              <li className="flex justify-center py-4">
                <Spinner />
              </li>
            ) : (
              list.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => choose(s)}
                    aria-current={value?.id === s.id ? "true" : undefined}
                    className={clsx(
                      "w-full rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none",
                      value?.id === s.id && "bg-nav-active",
                    )}
                  >
                    <span className="block truncate text-sm font-semibold text-ink">{storeLabel(s)}</span>
                    {s.city ? (
                      <span className="block truncate text-xs text-ink-muted">{[s.city, s.state].filter(Boolean).join(" - ")}</span>
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
          {stores.error ? (
            <p className="px-2.5 pb-1 text-xs text-red-600 dark:text-red-400">{errorMessage(stores.error)}</p>
          ) : !q && total > list.length && list.length > 0 ? (
            <p className="px-2.5 pb-1 text-xs text-ink-muted">
              Mostrando {list.length} de {total.toLocaleString("pt-BR")} lojas. Digite para buscar as outras.
            </p>
          ) : q && !stores.isLoading && list.length === 0 ? (
            <p className="px-2.5 pb-1 text-xs text-ink-muted">Nenhuma loja encontrada.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Solicitações da empresa: em andamento primeiro, com o que importa ao cliente (visita e técnico). */
export default function PortalRequestsPage() {
  const router = useRouter();
  const now = useNow(60_000);
  const me = usePortalMe();
  const [scope, setScope] = useState<Scope>("open");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [store, setStore] = useState<PortalLocation | null>(null);

  // Página a página (a API devolve no máximo 100 por vez): "Mostrar mais" busca só a próxima.
  const list = useInfiniteQuery({
    queryKey: ["portal", "requests", scope, q, store?.id ?? ""],
    queryFn: ({ pageParam }) =>
      api.get<Page<PortalRequestItem>>("/portal/requests", {
        scope,
        q: q || undefined,
        location_id: store?.id,
        page: pageParam,
        page_size: PAGE,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.page_size < last.total ? last.page + 1 : undefined),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  // Uma solicitação nova entre uma página e outra empurra a lista: a mesma não aparece duas vezes.
  const pages = list.data?.pages ?? [];
  const items = [...new Map(pages.flatMap((p) => p.items).map((item) => [item.id, item] as const)).values()];
  const total = pages.length ? pages[pages.length - 1].total : 0;
  const waiting = items.filter((item) => item.status === "on_hold_customer").length;
  const storeCount = me.data?.locations ?? 0;
  // Empresa sem contrato: o histórico continua aqui, mas abrir solicitação não.
  const canOpen = canOpenRequests(me.data);
  const newRequest = (size: "md" | "lg") =>
    canOpen ? (
      <Button variant="primary" size={size} onClick={() => router.push("/portal/nova")}>
        <Plus className="size-4" />
        Nova solicitação
      </Button>
    ) : null;

  return (
    <div>
      <PageHeader
        title="Solicitações"
        documentTitle="Solicitações"
        description={
          canOpen ? "Abra um chamado para a Maxx e acompanhe a visita na sua loja." : "Acompanhe as solicitações da sua empresa."
        }
        actions={newRequest("lg")}
      />

      {canOpen ? null : (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-line bg-surface p-3.5 text-sm shadow-elev-1" role="status">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-ink-subtle" aria-hidden />
          <p className="text-ink-muted">{PORTAL_SUSPENDED}</p>
        </div>
      )}

      <Tabs<Scope>
        items={[
          { key: "open", label: "Em andamento" },
          { key: "done", label: "Encerradas" },
          { key: "all", label: "Todas" },
        ]}
        value={scope}
        onChange={setScope}
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
        {storeCount > 1 ? <StoreFilter value={store} onChange={setStore} total={storeCount} /> : null}
      </div>

      {waiting && scope !== "done" ? (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-line bg-surface p-3.5 text-sm shadow-elev-1" role="status">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <p className="text-ink-muted">
            <span className="font-semibold text-ink">
              {waiting === 1 ? "1 solicitação aguarda" : `${waiting} solicitações aguardam`} um retorno de vocês.
            </span>{" "}
            Responda à central pelo canal de sempre (WhatsApp ou e-mail).
          </p>
        </div>
      ) : null}

      {list.isLoading ? (
        <LoadingBlock rows={4} />
      ) : list.error && !items.length ? (
        <ErrorBox message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
      ) : !items.length ? (
        <EmptyState
          icon={<Inbox />}
          title={
            q || store
              ? "Nenhuma solicitação encontrada"
              : scope === "open"
                ? "Nenhuma solicitação em andamento"
                : "Nenhuma solicitação aqui"
          }
          description={
            q || store
              ? "Mude a busca ou a loja."
              : canOpen
                ? "Quando algo parar na loja, abra uma solicitação: a central da Maxx analisa e envia um técnico."
                : undefined
          }
          action={q || store ? undefined : newRequest("md")}
        />
      ) : (
        <ul className={clsx("stagger flex flex-col gap-2.5 transition-opacity duration-150", list.isPlaceholderData && "opacity-60")}>
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
                    <Store className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">
                      {item.location ? item.location.name : "Sem loja"} · aberta {formatRelative(item.created_at, now)}
                      {item.requester_name ? ` por ${item.requester_name}` : ""}
                    </span>
                  </p>
                  <p className="mt-1.5 text-xs text-ink-muted">
                    <VisitLine item={item} />
                  </p>
                </div>
                <ChevronRight className="mt-1 size-4 shrink-0 text-ink-subtle transition-colors group-hover:text-ink" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {items.length ? (
        <div className="mt-4 flex flex-col items-center gap-3">
          <p className="text-xs text-ink-muted">
            Mostrando {items.length.toLocaleString("pt-BR")} de {total.toLocaleString("pt-BR")}
          </p>
          {/* A página seguinte falhou: as já carregadas ficam, e o "Tentar de novo" busca só a que faltou. */}
          {list.isFetchNextPageError && !list.isFetchingNextPage ? (
            <ErrorBox message={errorMessage(list.error)} onRetry={() => void list.fetchNextPage()} />
          ) : list.hasNextPage ? (
            <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
              Mostrar mais
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
