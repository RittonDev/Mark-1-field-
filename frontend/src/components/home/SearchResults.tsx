"use client";

import clsx from "clsx";
import {
  ArrowRight,
  Building2,
  CalendarClock,
  CalendarRange,
  CircleDot,
  CornerDownLeft,
  Flag,
  HardHat,
  Hash,
  History,
  MapPin,
  MapPinned,
  RotateCcw,
  Tag,
  Ticket,
  Type,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { StatusBadge } from "@/components/badges";
import { toggleTheme } from "@/components/Brand";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { formatDocument, formatShort } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import type { User } from "@/lib/types";
import { openChangePassword } from "./events";
import { ticketsListHref } from "./links";
import {
  isSearchable,
  matchScreens,
  nameOf,
  type RecentTicket,
  rememberRecentTicket,
  type ScreenEntry,
  screenCatalog,
  ticketCode,
  usePasswordAllowed,
  useSmartSearch,
} from "./search";
import type { ChipKind, SearchChip, SmartTicket } from "./types";

/** Ctrl (ou Cmd) abre a página inteira; Shift abre em outra aba. */
export interface Mods {
  ctrl: boolean;
  shift: boolean;
}

export const modsOf = (e: React.KeyboardEvent | React.MouseEvent): Mods => ({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });

export interface Entry {
  id: string;
  group: string;
  label: string;
  /** Código da OS, antes do título (em fonte de largura fixa). */
  code?: string;
  /** Segunda linha (cliente · loja · cidade, técnico e data da OS; cliente e cidade do local...). */
  detail?: React.ReactNode;
  /** À direita (ex.: o status da OS). */
  hint?: React.ReactNode;
  icon: React.ReactNode;
  /** Endereço do resultado: o botão do meio do mouse abre em outra aba. */
  href?: string;
  run: (mods: Mods) => void;
}

const GROUP = {
  recent: "Recentes",
  tickets: "Ordens de serviço",
  customers: "Clientes",
  locations: "Locais",
  technicians: "Técnicos",
  screens: "Telas e ações",
  pages: "Telas",
  actions: "Ações",
};

/** Agrupa as entradas na ordem em que chegaram. */
function groupEntries(entries: Entry[]): { group: string; items: { entry: Entry; index: number }[] }[] {
  const groups: { group: string; items: { entry: Entry; index: number }[] }[] = [];
  entries.forEach((entry, index) => {
    const last = groups[groups.length - 1];
    if (last && last.group === entry.group) last.items.push({ entry, index });
    else groups.push({ group: entry.group, items: [{ entry, index }] });
  });
  return groups;
}

function TicketDetail({ ticket }: { ticket: SmartTicket }) {
  const place = [nameOf(ticket.customer), nameOf(ticket.location), ticket.city].filter(Boolean).join(" · ");
  const technician = nameOf(ticket.technician);
  return (
    <span className="flex min-w-0 items-center gap-x-2.5 text-xs text-ink-muted">
      {place ? <span className="min-w-0 truncate">{place}</span> : null}
      {technician ? (
        <span className="inline-flex max-w-[11rem] shrink-0 items-center gap-1">
          <HardHat aria-hidden className="size-3 shrink-0 text-ink-subtle" />
          <span className="truncate">{technician}</span>
        </span>
      ) : null}
      <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
        <CalendarClock aria-hidden className="size-3 shrink-0 text-ink-subtle" />
        {ticket.scheduled_start ? formatShort(ticket.scheduled_start) : `aberta ${formatShort(ticket.created_at)}`}
      </span>
    </span>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;

export interface SearchController {
  query: string;
  setQuery: (value: string) => void;
  typed: string;
  entries: Entry[];
  chips: SearchChip[];
  current: number;
  setActive: (index: number) => void;
  activeId: string | undefined;
  optionId: (index: number) => string;
  listId: string;
  /** O que está na tela ainda é da busca anterior (o texto mudou e a nova não voltou). */
  stale: boolean;
  fetching: boolean;
  failed: boolean;
  retry: () => void;
  /** Setas e Enter no campo; devolve true quando a tecla foi usada. */
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => boolean;
}

/**
 * Estado e resultados da busca (Ctrl+K e a caixa do Início): texto, a busca inteligente com atraso de
 * 200 ms, as telas e ações, a navegação pelo teclado e o Enter apertado antes de a busca voltar.
 */
export function useSearchController({
  user,
  recent,
  mode,
  onLeave,
  listRef,
}: {
  user: User;
  recent: RecentTicket[];
  /** A área que rola a lista: o item escolhido pelo teclado fica sempre à vista. */
  listRef: React.RefObject<HTMLDivElement | null>;
  /** "palette": sem texto mostra recentes, telas e ações; "home": só as recentes. */
  mode: "palette" | "home";
  /** Um resultado foi aberto: fecha a busca (o diálogo ou a lista suspensa). */
  onLeave: () => void;
}): SearchController {
  const router = useRouter();
  const ticketPanel = useTicketPanel();
  const passwordAllowed = usePasswordAllowed();
  const [query, setQueryState] = useState("");
  const [active, setActive] = useState(0);
  // Enter apertado antes de a busca do texto digitado voltar: abre o 1º resultado dela quando chegar.
  const [pendingEnter, setPendingEnter] = useState<{ text: string; mods: Mods } | null>(null);
  const listId = useId();
  const typed = query.trim();
  // Uma busca por pausa na digitação.
  const q = useDebounced(typed, 200);
  const searching = isSearchable(q);
  const smart = useSmartSearch(q, searching);
  const data = searching ? smart.data : undefined;
  const fetching = searching && smart.isFetching;
  const stale = typed !== q || (searching && (smart.isFetching || smart.isPlaceholderData));
  const failed = searching && smart.isError;

  const go = (href: string, mods: Mods) => {
    onLeave();
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
    onLeave();
    ticketPanel.open(ticket.id);
  };

  const screenEntry = (s: ScreenEntry, group: string): Entry => {
    const Icon = s.icon;
    const target = s.target;
    return {
      id: s.id,
      group,
      label: s.label,
      detail: s.detail ? <span className="block truncate text-xs text-ink-muted">{s.detail}</span> : undefined,
      icon: <Icon className="size-4" />,
      href: "href" in target ? target.href : undefined,
      run: (mods) => {
        if ("href" in target) {
          go(target.href, mods);
        } else if (target.action === "theme") {
          toggleTheme();
          onLeave();
        } else {
          onLeave();
          openChangePassword();
        }
      },
    };
  };

  // Lista refeita a cada render (poucas dezenas de itens): as ações usam sempre o estado do momento.
  const entries = ((): Entry[] => {
    const recents: Entry[] = !typed
      ? recent.map((t) => ({
          id: `r-${t.id}`,
          group: GROUP.recent,
          label: t.title,
          code: t.code,
          icon: <History className="size-4" />,
          href: `/chamados/${t.id}`,
          run: (mods: Mods) => openTicket(t, mods),
        }))
      : [];

    const found: Entry[] = [];
    if (data) {
      for (const t of data.tickets) {
        const code = ticketCode(t.number);
        found.push({
          id: `t-${t.id}`,
          group: GROUP.tickets,
          label: t.title,
          code,
          detail: <TicketDetail ticket={t} />,
          hint: <StatusBadge status={t.status} />,
          icon: <Ticket className="size-4" />,
          href: `/chamados/${t.id}`,
          run: (mods) => openTicket({ id: t.id, code, title: t.title }, mods),
        });
      }
      if (data.filters && data.total > 0) {
        const href = ticketsListHref(data.filters);
        found.push({
          id: "t-list",
          group: GROUP.tickets,
          label: data.total === 1 ? "Ver a OS na lista de Chamados" : `Ver as ${data.total.toLocaleString("pt-BR")} OS na lista de Chamados`,
          detail: <span className="block truncate text-xs text-ink-muted">Com os filtros entendidos, para exportar ou agir em lote</span>,
          icon: <ArrowRight className="size-4" />,
          href,
          run: (mods) => go(href, mods),
        });
      }
      for (const c of data.customers) {
        const href = `/clientes/${c.id}`;
        const detail = [c.document ? formatDocument(c.document) : null, plural(c.open_count, "OS em aberto", "OS em aberto")]
          .filter(Boolean)
          .join(" · ");
        found.push({
          id: `c-${c.id}`,
          group: GROUP.customers,
          label: c.name,
          detail: <span className="block truncate text-xs text-ink-muted">{detail}</span>,
          icon: <Building2 className="size-4" />,
          href,
          run: (mods) => go(href, mods),
        });
      }
      for (const l of data.locations) {
        const href = `/locais/${l.id}`;
        const detail = [nameOf(l.customer), l.city].filter(Boolean).join(" · ");
        found.push({
          id: `l-${l.id}`,
          group: GROUP.locations,
          label: l.code && !l.name.includes(l.code) ? `${l.name} (${l.code})` : l.name,
          detail: detail ? <span className="block truncate text-xs text-ink-muted">{detail}</span> : undefined,
          icon: <MapPin className="size-4" />,
          href,
          run: (mods) => go(href, mods),
        });
      }
      for (const t of data.technicians) {
        // A base técnica abre já filtrada pelo nome.
        const href = `/tecnicos?q=${encodeURIComponent(t.name)}`;
        const detail = [t.city, t.active ? null : "inativo"].filter(Boolean).join(" · ");
        found.push({
          id: `tc-${t.id}`,
          group: GROUP.technicians,
          label: t.name,
          detail: detail ? <span className="block truncate text-xs text-ink-muted">{detail}</span> : undefined,
          icon: <HardHat className="size-4" />,
          href,
          run: (mods) => go(href, mods),
        });
      }
    }

    const { screens, actions } = screenCatalog(user.role, { passwordAllowed });
    let places: Entry[] = [];
    let screensFirst = false;
    if (typed) {
      const matches = matchScreens([...screens, ...actions], typed);
      places = matches.map((m) => screenEntry(m.entry, GROUP.screens));
      // Digitou o nome de uma tela ("pagam", "mapa") e a busca não entendeu nenhum filtro: a tela vem primeiro.
      const structured = (data?.chips ?? []).some((c) => c.kind !== "text");
      screensFirst = (matches[0]?.score ?? 0) >= 85 && !structured;
    } else if (mode === "palette") {
      places = [
        ...screens.slice(0, 8).map((s) => screenEntry(s, GROUP.pages)),
        ...actions.filter((a) => a.id === "a-new" || a.id === "a-theme").map((a) => screenEntry(a, GROUP.actions)),
      ];
    }
    return screensFirst ? [...recents, ...places, ...found] : [...recents, ...found, ...places];
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
    const pending = pendingEnter;
    if (!pending) return;
    setPendingEnter(null);
    entries[current]?.run(pending.mods);
  });
  useEffect(() => {
    if (enterReady) runPending();
  }, [enterReady]);

  const setQuery = (value: string) => {
    setQueryState(value);
    setActive(0);
    // Texto novo: o Enter que esperava a busca anterior não vale mais.
    setPendingEnter(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (entries.length) {
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (Math.min(i, entries.length - 1) + step + entries.length) % entries.length);
      }
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const mods = modsOf(e);
      // O que está na tela ainda é da busca anterior: espera a do texto digitado.
      if (typed && stale && isSearchable(typed)) setPendingEnter({ text: typed, mods });
      else entries[current]?.run(mods);
      return true;
    }
    return false;
  };

  return {
    query,
    setQuery,
    typed,
    entries,
    chips: data?.chips ?? [],
    current,
    setActive,
    activeId,
    optionId,
    listId,
    stale,
    fetching,
    failed,
    retry: () => void smart.refetch(),
    onKeyDown,
  };
}

const CHIP_ICON: Record<ChipKind, React.ComponentType<{ className?: string }>> = {
  number: Hash,
  status: CircleDot,
  period: CalendarRange,
  customer: Building2,
  location: MapPin,
  technician: HardHat,
  tag: Tag,
  city: MapPinned,
  priority: Flag,
  text: Type,
};

/** "Entendi: Boticário · Atrasadas · Novembro": como a busca leu a frase. */
function Understood({ chips, stale }: { chips: SearchChip[]; stale: boolean }) {
  return (
    <div className={clsx("mx-1 mb-1.5 flex flex-wrap items-center gap-1.5 px-2 pt-1 transition-opacity duration-150", stale && "opacity-60")}>
      <span className="text-[11px] font-semibold text-ink-muted">Entendi:</span>
      {chips.map((chip, i) => {
        const Icon = CHIP_ICON[chip.kind] ?? Type;
        return (
          <span
            key={`${chip.kind}-${chip.label}-${i}`}
            className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand-ink ring-1 ring-brand/20 ring-inset"
          >
            <Icon aria-hidden className="size-3 shrink-0" />
            {chip.kind === "text" ? `"${chip.label}"` : chip.label}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Resultados da busca (lista de opções do combobox): grupos, "Entendi", erro com "Tentar de novo",
 * "Buscando...", nada encontrado e a contagem para o leitor de tela. Quem usa põe em volta a área que
 * rola (com o listRef passado ao controlador).
 */
export function SearchResults({ ctl, onLeave }: { ctl: SearchController; onLeave?: () => void }) {
  const groups = groupEntries(ctl.entries);
  const showChips = ctl.typed !== "" && ctl.chips.some((c) => c.kind !== "text");
  const onlyPlaces = ctl.entries.every((e) => e.group === GROUP.screens || e.group === GROUP.pages || e.group === GROUP.actions);
  const waiting = ctl.typed !== "" && (ctl.stale || ctl.fetching) && onlyPlaces && !ctl.failed;
  return (
    <>
      {ctl.failed ? (
        <div
          role="alert"
          className="mx-1 mb-2 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          <span className="flex-1">Não foi possível buscar agora.</span>
          <button
            type="button"
            onClick={ctl.retry}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold hover:bg-red-100 dark:hover:bg-red-900/40"
          >
            <RotateCcw aria-hidden className="size-3.5" />
            Tentar de novo
          </button>
        </div>
      ) : null}
      {showChips ? <Understood chips={ctl.chips} stale={ctl.stale} /> : null}
      <div id={ctl.listId} role="listbox" aria-label="Resultados">
        {groups.map(({ group, items }) => (
          <div key={group} role="group" aria-label={group}>
            <p aria-hidden className={clsx("px-3 pb-1 text-[11px] font-semibold text-ink-muted", items[0].index === 0 ? "pt-1" : "pt-3")}>
              {group}
            </p>
            {items.map(({ entry, index }) => {
              const selected = index === ctl.current;
              return (
                <div
                  key={entry.id}
                  id={ctl.optionId(index)}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  onMouseMove={() => {
                    if (!selected) ctl.setActive(index);
                  }}
                  // O foco fica no campo de busca (e o botão do meio não liga a rolagem automática).
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => entry.run(modsOf(e))}
                  onAuxClick={(e) => {
                    // Botão do meio: a página do resultado em outra aba, como num link.
                    if (e.button !== 1 || !entry.href) return;
                    e.preventDefault();
                    window.open(entry.href, "_blank", "noopener");
                    onLeave?.();
                  }}
                  className={clsx(
                    "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-100",
                    selected ? "bg-brand-soft text-ink" : "text-ink-muted",
                  )}
                >
                  <span aria-hidden className={clsx("shrink-0", selected ? "text-brand" : "text-ink-subtle")}>
                    {entry.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={clsx("block truncate text-ink", selected ? "font-semibold" : "font-medium")}>
                      {entry.code ? <span className="mr-1.5 font-mono text-xs font-normal text-ink-muted">{entry.code}</span> : null}
                      {entry.label}
                    </span>
                    {entry.detail ? <span className="mt-0.5 block min-w-0">{entry.detail}</span> : null}
                  </span>
                  {entry.hint ? <span className="hidden shrink-0 sm:inline-flex">{entry.hint}</span> : null}
                  {selected ? <CornerDownLeft aria-hidden className="size-3.5 shrink-0 text-ink-subtle" /> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {waiting ? (
        <p className="px-3 py-3 text-center text-sm text-ink-muted">Buscando...</p>
      ) : ctl.typed && ctl.entries.length === 0 && !ctl.failed ? (
        <div className="px-4 py-7 text-center">
          <p className="text-sm font-semibold text-ink">Nada encontrado para &quot;{ctl.typed}&quot;.</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-ink-muted">
            Tente o nº da OS, o nome do cliente ou da loja, um técnico, uma cidade ou um período (ex.: &quot;novembro&quot;).
          </p>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {ctl.typed && !ctl.stale ? plural(ctl.entries.length, "resultado", "resultados") : ""}
      </p>
    </>
  );
}
