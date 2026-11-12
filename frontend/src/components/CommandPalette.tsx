"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Building2, CornerDownLeft, FilePlus2, MoonStar, Search, Ticket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StatusBadge } from "@/components/badges";
import { toggleTheme } from "@/components/Brand";
import { visibleNav } from "@/components/nav";
import { Kbd } from "@/components/ui";
import { api } from "@/lib/api";
import type { Customer, Page, TicketListItem, User } from "@/lib/types";

const OPEN_EVENT = "mf:command-open";

/** Abre a busca rápida (o atalho Ctrl+K / ⌘K também abre). */
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

interface Entry {
  id: string;
  group: string;
  label: string;
  hint?: React.ReactNode;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({ user }: { user: User }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  return open ? <Palette user={user} onClose={() => setOpen(false)} /> : null;
}

function Palette({ user, onClose }: { user: User; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const deferred = useDeferredValue(query.trim());
  const searching = deferred.length >= 2;
  const staff = user.role !== "requester";

  const tickets = useQuery({
    queryKey: ["command", "tickets", deferred],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { q: deferred, page_size: 6 }),
    enabled: searching,
    staleTime: 15_000,
  });
  const customers = useQuery({
    queryKey: ["command", "customers", deferred],
    queryFn: () => api.get<Customer[]>("/customers", { q: deferred }),
    enabled: searching && staff,
    staleTime: 30_000,
  });

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const entries = useMemo<Entry[]>(() => {
    const q = normalize(deferred);
    const list: Entry[] = [];
    for (const t of tickets.data?.items ?? []) {
      list.push({
        id: `t-${t.id}`,
        group: "Ordens de serviço",
        label: `${t.code} · ${t.title}`,
        hint: <StatusBadge status={t.status} />,
        icon: <Ticket className="size-4" />,
        run: () => go(`/chamados/${t.id}`),
      });
    }
    for (const c of (customers.data ?? []).slice(0, 4)) {
      list.push({
        id: `c-${c.id}`,
        group: "Clientes",
        label: c.name,
        hint: <span className="text-xs text-ink-subtle">ver chamados</span>,
        icon: <Building2 className="size-4" />,
        run: () => go(`/chamados?customer_id=${c.id}`),
      });
    }
    const pages = visibleNav(user.role).filter((n) => !q || normalize(n.label).includes(q));
    for (const n of pages.slice(0, q ? 6 : 8)) {
      const Icon = n.icon;
      list.push({
        id: `p-${n.href}`,
        group: "Telas",
        label: n.label,
        icon: <Icon className="size-4" />,
        run: () => go(n.href),
      });
    }
    const actions: Entry[] = [
      {
        id: "a-new",
        group: "Ações",
        label: "Nova ordem de serviço",
        icon: <FilePlus2 className="size-4" />,
        run: () => go("/chamados/novo"),
      },
      {
        id: "a-theme",
        group: "Ações",
        label: "Alternar tema claro / escuro",
        icon: <MoonStar className="size-4" />,
        run: () => {
          toggleTheme();
          onClose();
        },
      },
    ];
    list.push(...actions.filter((a) => !q || normalize(a.label).includes(q)));
    return list;
    // `go` e `onClose` são estáveis o bastante para a lista (recriada a cada busca).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, tickets.data, customers.data, user.role]);

  const current = Math.min(active, Math.max(0, entries.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(entries.length - 1, Math.min(i, entries.length - 1) + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(i, entries.length - 1) - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      entries[current]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const loading = searching && (tickets.isFetching || customers.isFetching);
  let lastGroup = "";

  return createPortal(
    <div className="fixed inset-0 z-[60] flex animate-fade items-start justify-center bg-[rgb(9_11_15/0.42)] p-4 pt-[12vh] backdrop-blur-[3px]">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Busca rápida"
        className="relative flex max-h-[70vh] w-full max-w-xl animate-pop flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className={clsx("size-4 shrink-0", loading ? "animate-pulse text-brand" : "text-ink-subtle")} />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Buscar OS pelo número ou título, cliente ou tela..."
            className="h-13 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-subtle"
            aria-label="Buscar"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto p-2" role="listbox">
          {entries.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-ink-muted">
              {loading ? "Buscando..." : `Nada encontrado para "${query}".`}
            </p>
          ) : (
            entries.map((entry, index) => {
              const header = entry.group !== lastGroup ? entry.group : null;
              lastGroup = entry.group;
              const selected = index === current;
              return (
                <div key={entry.id}>
                  {header ? (
                    <p className="px-3 pt-3 pb-1 text-[11px] font-medium text-ink-subtle first:pt-1">{header}</p>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-index={index}
                    onMouseMove={() => setActive(index)}
                    onClick={entry.run}
                    className={clsx(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      selected ? "bg-brand-soft text-ink" : "text-ink-muted",
                    )}
                  >
                    <span className={clsx("shrink-0", selected ? "text-brand" : "text-ink-subtle")}>{entry.icon}</span>
                    <span className={clsx("min-w-0 flex-1 truncate", selected && "font-medium")}>{entry.label}</span>
                    {entry.hint ? <span className="shrink-0">{entry.hint}</span> : null}
                    {selected ? <CornerDownLeft className="size-3.5 shrink-0 text-ink-subtle" /> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex items-center gap-4 border-t border-line bg-surface-2/60 px-4 py-2 text-[11px] text-ink-subtle">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navegar
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Enter</Kbd> abrir
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd> abre de qualquer tela
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
