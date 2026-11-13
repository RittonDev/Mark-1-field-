"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Building2, CornerDownLeft, FilePlus2, History, MapPin, MoonStar, RotateCcw, Search, Ticket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StatusBadge } from "@/components/badges";
import { toggleTheme } from "@/components/Brand";
import { visibleNav } from "@/components/nav";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { isTopLayer, Kbd, lockScroll, restoreFocus, trapTab } from "@/components/ui";
import { api } from "@/lib/api";
import { canManageTickets } from "@/lib/constants";
import { formatShort } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { sessionStore } from "@/lib/session";
import type { Customer, Location, Page, TicketListItem, User, UUID } from "@/lib/types";

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

// ------------------------------------------------------------------ OS recentes

/** OS aberta há pouco (o analista reabre as mesmas OS o dia todo). */
export interface RecentTicket {
  id: UUID;
  code: string;
  title: string;
}

const RECENT_LIMIT = 8;
const recentKey = (userId: string) => `mf:recentes:${userId}`;

function readRecent(userId: string): RecentTicket[] {
  try {
    const raw = window.localStorage.getItem(recentKey(userId));
    const list = raw ? (JSON.parse(raw) as RecentTicket[]) : [];
    return Array.isArray(list)
      ? list.filter((t) => t && typeof t.id === "string" && typeof t.code === "string" && typeof t.title === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

/** Guarda a OS entre as recentes da busca rápida (deste usuário, neste navegador). */
export function rememberRecentTicket(ticket: RecentTicket) {
  const userId = sessionStore.get()?.user.id;
  if (!userId) return;
  try {
    const next = [{ id: ticket.id, code: ticket.code, title: ticket.title }, ...readRecent(userId).filter((t) => t.id !== ticket.id)];
    window.localStorage.setItem(recentKey(userId), JSON.stringify(next.slice(0, RECENT_LIMIT)));
  } catch {
    // Sem armazenamento: só não aparece em "Recentes".
  }
}

// ------------------------------------------------------------------ busca

/** Ctrl (ou Cmd) abre a página inteira; Shift abre em outra aba. */
interface Mods {
  ctrl: boolean;
  shift: boolean;
}

interface Entry {
  id: string;
  group: string;
  label: string;
  /** Segunda linha (loja ou cliente e horário da OS; cliente e cidade do local). */
  detail?: string;
  hint?: React.ReactNode;
  icon: React.ReactNode;
  run: (mods: Mods) => void;
}

const modsOf = (e: React.KeyboardEvent | React.MouseEvent): Mods => ({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });

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

/** Agrupa as entradas na ordem em que chegaram ("Ordens de serviço", "Locais", "Telas"...). */
function groupEntries(entries: Entry[]): { group: string; items: { entry: Entry; index: number }[] }[] {
  const groups: { group: string; items: { entry: Entry; index: number }[] }[] = [];
  entries.forEach((entry, index) => {
    const last = groups[groups.length - 1];
    if (last && last.group === entry.group) last.items.push({ entry, index });
    else groups.push({ group: entry.group, items: [{ entry, index }] });
  });
  return groups;
}

function Palette({ user, onClose }: { user: User; onClose: () => void }) {
  const router = useRouter();
  const ticketPanel = useTicketPanel();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Enter apertado antes de a busca do texto digitado voltar: abre o 1º resultado dela quando chegar.
  const [pendingEnter, setPendingEnter] = useState<{ text: string; mods: Mods } | null>(null);
  const [recent] = useState(() => readRecent(user.id));
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const typed = query.trim();
  // Uma busca por pausa na digitação (a cada tecla eram 3 requisições, com COUNT em milhares de OS).
  const q = useDebounced(typed, 200);
  const numeric = /^\d+$/.test(q);
  // Número da OS já com 1 dígito; texto a partir de 2 letras.
  const searching = q.length >= 2 || (numeric && q.length >= 1);
  const searchingPlaces = q.length >= 2;
  const manager = canManageTickets(user.role);

  const tickets = useQuery({
    queryKey: ["command", "tickets", q],
    queryFn: ({ signal }) => api.get<Page<TicketListItem>>("/tickets", { q, page_size: 6 }, { signal }),
    enabled: searching,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const locations = useQuery({
    queryKey: ["command", "locations", q],
    queryFn: ({ signal }) => api.get<Page<Location>>("/locations", { q, page_size: 5, active: true }, { signal }),
    enabled: searchingPlaces && manager,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const customers = useQuery({
    queryKey: ["command", "customers", q],
    queryFn: ({ signal }) => api.get<Customer[]>("/customers", { q }, { signal }),
    enabled: searchingPlaces && manager,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const sources = [
    { query: tickets, on: searching },
    { query: locations, on: searchingPlaces && manager },
    { query: customers, on: searchingPlaces && manager },
  ];
  const fetching = sources.some((s) => s.on && s.query.isFetching);
  // Ainda mostrando o resultado da busca anterior (o texto mudou e a nova não voltou).
  const stale = typed !== q || sources.some((s) => s.on && (s.query.isFetching || s.query.isPlaceholderData));
  const failed = sources.filter((s) => s.on && s.query.isError);

  const go = (href: string, mods: Mods) => {
    onClose();
    if (mods.shift) window.open(href, "_blank", "noopener");
    else router.push(href);
  };

  // A OS abre no painel lateral, sem sair da tela; Ctrl abre a página, Shift abre outra aba.
  const openTicket = (ticket: RecentTicket, mods: Mods) => {
    rememberRecentTicket(ticket);
    const href = `/chamados/${ticket.id}`;
    if (mods.shift || mods.ctrl || !ticketPanel) {
      go(href, mods);
      return;
    }
    onClose();
    ticketPanel.open(ticket.id);
  };

  // Lista refeita a cada render (poucas dezenas de itens): as ações usam sempre o estado do momento.
  const entries = ((): Entry[] => {
    const text = normalize(typed);
    const list: Entry[] = [];
    if (!typed) {
      for (const t of recent) {
        list.push({
          id: `r-${t.id}`,
          group: "Recentes",
          label: `${t.code} · ${t.title}`,
          icon: <History className="size-4" />,
          run: (mods) => openTicket(t, mods),
        });
      }
    }
    if (searching) {
      for (const t of tickets.data?.items ?? []) {
        const place = t.location?.name ?? t.customer?.name;
        list.push({
          id: `t-${t.id}`,
          group: "Ordens de serviço",
          label: `${t.code} · ${t.title}`,
          detail: [place, t.scheduled_start ? formatShort(t.scheduled_start) : null].filter(Boolean).join(" · ") || undefined,
          hint: <StatusBadge status={t.status} />,
          icon: <Ticket className="size-4" />,
          run: (mods) => openTicket({ id: t.id, code: t.code, title: t.title }, mods),
        });
      }
    }
    if (searchingPlaces && manager) {
      for (const l of locations.data?.items ?? []) {
        const city = l.city ? ` · ${l.city}${l.state ? `/${l.state}` : ""}` : "";
        list.push({
          id: `l-${l.id}`,
          group: "Locais",
          label: l.name,
          detail: `${l.customer.name}${city}`,
          icon: <MapPin className="size-4" />,
          run: (mods) => go(`/locais/${l.id}`, mods),
        });
      }
      for (const c of (customers.data ?? []).slice(0, 4)) {
        list.push({
          id: `c-${c.id}`,
          group: "Clientes",
          label: c.name,
          detail: c.city ? `${c.city}${c.state ? `/${c.state}` : ""}` : undefined,
          icon: <Building2 className="size-4" />,
          run: (mods) => go(`/clientes/${c.id}`, mods),
        });
      }
    }
    const pages = visibleNav(user.role).filter((n) => !text || normalize(n.label).includes(text));
    for (const n of pages.slice(0, text ? 6 : 8)) {
      const Icon = n.icon;
      list.push({
        id: `p-${n.href}`,
        group: "Telas",
        label: n.label,
        icon: <Icon className="size-4" />,
        run: (mods) => go(n.href, mods),
      });
    }
    const actions: Entry[] = [
      ...(manager
        ? [
            {
              id: "a-new",
              group: "Ações",
              label: "Nova ordem de serviço",
              icon: <FilePlus2 className="size-4" />,
              run: (mods: Mods) => go("/chamados/novo", mods),
            },
          ]
        : []),
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
    list.push(...actions.filter((a) => !text || normalize(a.label).includes(text)));
    return list;
  })();

  const current = Math.min(active, Math.max(0, entries.length - 1));
  const optionId = (index: number) => `${listId}-${index}`;
  const activeId = entries.length ? optionId(current) : undefined;

  useEffect(() => {
    if (activeId) listRef.current?.querySelector(`#${CSS.escape(activeId)}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  // A busca do Enter voltou: abre o resultado escolhido (descartado se o texto mudou nesse meio-tempo).
  const enterReady = !!pendingEnter && pendingEnter.text === typed && !stale;
  const runPending = useEffectEvent(() => {
    if (pendingEnter) entries[current]?.run(pendingEnter.mods);
  });
  useEffect(() => {
    if (enterReady) runPending();
  }, [enterReady]);

  // Modal: trava a rolagem da página, prende o Tab e devolve o foco a quem abriu.
  const close = useEffectEvent(() => onClose());
  useEffect(() => {
    const opener = document.activeElement;
    const unlock = lockScroll();
    const onKey = (e: KeyboardEvent) => {
      const node = dialogRef.current;
      if (!node || e.defaultPrevented) return;
      if (e.key === "Tab" && isTopLayer(node, false)) trapTab(e, node);
      else if (e.key === "Escape" && isTopLayer(node)) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlock();
      // Abriu a OS no painel: o foco é dele. Senão volta ao botão de busca (ou a quem abriu com Ctrl+K).
      const focused = document.activeElement;
      if (!focused || focused === document.body) restoreFocus(opener);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (entries.length) setActive((i) => (Math.min(i, entries.length - 1) + 1) % entries.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (entries.length) setActive((i) => (Math.min(i, entries.length - 1) - 1 + entries.length) % entries.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const mods = modsOf(e);
      // O que está na tela ainda é da busca anterior: espera a do texto digitado.
      if (typed && stale) setPendingEnter({ text: typed, mods });
      else entries[current]?.run(mods);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const groups = groupEntries(entries);
  const waiting = typed !== "" && (stale || fetching) && entries.every((e) => e.group === "Telas" || e.group === "Ações");

  return createPortal(
    <div className="fixed inset-0 z-[60] flex animate-fade items-start justify-center bg-[rgb(9_11_15/0.42)] p-4 pt-[12vh] backdrop-blur-[3px] print:hidden">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Busca rápida"
        className="relative flex max-h-[70vh] w-full max-w-xl animate-pop flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search aria-hidden className={clsx("size-4 shrink-0", fetching ? "animate-pulse text-brand" : "text-ink-subtle")} />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              // Texto novo: o Enter que esperava a busca anterior não vale mais.
              setPendingEnter(null);
            }}
            onKeyDown={onKeyDown}
            placeholder="Buscar OS, loja, cliente ou tela..."
            className="h-13 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-subtle"
            role="combobox"
            aria-label="Buscar OS, loja, cliente ou tela"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
          />
          <span aria-hidden className="hidden sm:inline-flex">
            <Kbd>Esc</Kbd>
          </span>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto p-2">
          {failed.length ? (
            <div role="alert" className="mx-1 mb-2 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              <span className="flex-1">Não foi possível buscar agora.</span>
              <button
                type="button"
                onClick={() => failed.forEach((s) => void s.query.refetch())}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold hover:bg-red-100 dark:hover:bg-red-900/40"
              >
                <RotateCcw aria-hidden className="size-3.5" />
                Tentar de novo
              </button>
            </div>
          ) : null}
          <div id={listId} role="listbox" aria-label="Resultados">
            {groups.map(({ group, items }) => (
              <div key={group} role="group" aria-label={group}>
                <p aria-hidden className={clsx("px-3 pb-1 text-[11px] font-semibold text-ink-muted", items[0].index === 0 ? "pt-1" : "pt-3")}>
                  {group}
                </p>
                {items.map(({ entry, index }) => {
                  const selected = index === current;
                  return (
                    <div
                      key={entry.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={selected}
                      tabIndex={-1}
                      onMouseMove={() => setActive(index)}
                      // O foco fica no campo de busca.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => entry.run(modsOf(e))}
                      className={clsx(
                        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                        selected ? "bg-brand-soft text-ink" : "text-ink-muted",
                      )}
                    >
                      <span aria-hidden className={clsx("shrink-0", selected ? "text-brand" : "text-ink-subtle")}>
                        {entry.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={clsx("block truncate", selected ? "font-semibold" : "font-medium")}>{entry.label}</span>
                        {entry.detail ? <span className="block truncate text-xs text-ink-muted">{entry.detail}</span> : null}
                      </span>
                      {entry.hint ? <span className="shrink-0">{entry.hint}</span> : null}
                      {selected ? <CornerDownLeft aria-hidden className="size-3.5 shrink-0 text-ink-subtle" /> : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {waiting ? (
            <p className="px-3 py-3 text-center text-sm text-ink-muted">Buscando...</p>
          ) : entries.length === 0 && !failed.length ? (
            <p className="px-3 py-8 text-center text-sm text-ink-muted">Nada encontrado para &quot;{typed}&quot;.</p>
          ) : null}
          <p className="sr-only" aria-live="polite">
            {typed && !stale ? `${entries.length} resultados` : ""}
          </p>
        </div>
        <div className="hidden items-center gap-4 border-t border-line bg-surface-2/60 px-4 py-2 text-[11px] text-ink-subtle sm:flex">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navegar
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Enter</Kbd> abrir
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <Kbd>Ctrl</Kbd>
            <Kbd>Enter</Kbd> abre a página
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
