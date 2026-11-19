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
  Sparkles,
  Tag,
  Ticket,
  Type,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { StatusBadge } from "@/components/badges";
import { toggleTheme } from "@/components/Brand";
import { useConfirmLeave } from "@/components/Confirm";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { formatDocument, formatShort } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import type { User } from "@/lib/types";
import { AgentMark } from "./agent";
import { openChangePassword } from "./events";
import { ticketsListHref } from "./links";
import { AGENT_NAME, dropWords, stripAgentName } from "./phrase";
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
  agent: `Sugestão da ${AGENT_NAME}`,
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

/**
 * A resposta da Mia, sempre o trabalho à vista: o que virou filtro, o que foi procurado como texto e
 * quantas OS deu. "understood": entendeu algum filtro; "partial": entendeu filtros, mas o texto que
 * sobrou zerou a busca; "text": só procurou o texto (achando OS ou nenhuma).
 */
export interface AgentAnswer {
  mode: "understood" | "partial" | "text";
  /** Todos os chips da API, na ordem da frase. */
  chips: SearchChip[];
  /** O que foi procurado como texto (o chip de texto). */
  text: string | null;
  total: number;
}

export interface SearchController {
  query: string;
  setQuery: (value: string) => void;
  /** O texto do campo, sem espaços nas pontas. */
  typed: string;
  /** O que vai para a busca: o texto sem o nome da Mia no começo ("Mia, atrasadas" -> "atrasadas"). */
  asked: string;
  entries: Entry[];
  chips: SearchChip[];
  current: number;
  setActive: (index: number) => void;
  activeId: string | undefined;
  optionId: (index: number) => string;
  listId: string;
  /** O que está na tela não é a resposta do texto atual: digitando, buscando ou esperando a internet. */
  stale: boolean;
  /** Um pedido da Mia está em andamento (os brilhos piscam e a linha corre); sem internet, nada se mexe. */
  thinking: boolean;
  /** Sem internet: a busca do texto atual espera a conexão voltar. */
  paused: boolean;
  /** O que a Mia entendeu da última busca que voltou (null antes da 1ª resposta, sem texto que dê busca ou com erro). */
  reply: AgentAnswer | null;
  /** A busca falhou e não há outra tentativa em andamento: o alerta com "Tentar de novo". */
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
  const confirmLeave = useConfirmLeave();
  const ticketPanel = useTicketPanel();
  const passwordAllowed = usePasswordAllowed();
  const [query, setQueryState] = useState("");
  const [active, setActive] = useState(0);
  // Enter apertado antes de a busca do texto digitado voltar: abre o 1º resultado dela quando chegar.
  const [pendingEnter, setPendingEnter] = useState<{ text: string; mods: Mods; seq: number } | null>(null);
  const enterSeq = useRef(0);
  const ranEnter = useRef(0);
  const listId = useId();
  const typed = query.trim();
  // "Mia, atrasadas em campinas": o nome dela no começo da frase não vai para a busca.
  const asked = stripAgentName(typed).trim();
  // Uma busca por pausa na digitação.
  const q = useDebounced(asked, 200);
  const searching = isSearchable(q);
  const smart = useSmartSearch(q, searching);
  const data = searching ? smart.data : undefined;
  // Sem internet o pedido fica parado (não sai): a Mia não "pensa" e avisa que espera a conexão.
  const paused = isSearchable(asked) && searching && smart.isPaused;
  const stale = asked !== q || (searching && (smart.isFetching || smart.isPlaceholderData || smart.isPaused));
  // "Tentar de novo" em andamento (ou esperando a internet) não é erro: o alerta sai e volta se falhar de novo.
  const failed = searching && smart.isError && !smart.isFetching && !smart.isPaused;
  const thinking = isSearchable(asked) && stale && !failed && !paused;

  // O que a Mia diz da busca que voltou: os filtros que entendeu, ou só o texto que procurou.
  const reply = ((): AgentAnswer | null => {
    if (!data || !isSearchable(asked) || failed) return null;
    const text = data.chips.find((c) => c.kind === "text")?.label ?? null;
    if (data.chips.some((c) => c.kind !== "text")) {
      return { mode: data.total === 0 && text ? "partial" : "understood", chips: data.chips, text, total: data.total };
    }
    // Sem filtro entendido: o texto que procurou (a busca antiga não manda chips) e quantas OS deu, mesmo
    // nenhuma. Assim a caixa passa de "Procurando…" para "Procurei “mapa” · nenhuma OS" sem sumir, e a
    // lista não pula quando a busca volta.
    return { mode: "text", chips: data.chips, text: text ?? (data.query || asked), total: data.total };
  })();

  const setQuery = (value: string) => {
    setQueryState(value);
    setActive(0);
    // Texto novo: o Enter que esperava a busca anterior não vale mais.
    setPendingEnter(null);
  };

  // Fecha a busca antes de perguntar: a paleta fica por cima do diálogo de confirmação. Outra aba não
  // tira nada da tela; trocar de tela com alteração não salva (OS, Nova OS, diálogo) pergunta antes.
  const go = (href: string, mods: Mods) => {
    onLeave();
    if (mods.shift) window.open(href, "_blank", "noopener");
    else
      void confirmLeave().then((ok) => {
        if (ok) router.push(href);
      });
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
    // O texto que sobrou zerou o recorte ("quantas atrasadas em campinas?"): a 1ª opção refaz a busca sem
    // ele. Só edita o campo; a busca continua aberta, com o foco no texto.
    const suggestions: Entry[] = [];
    if (reply?.mode === "partial" && reply.text && !stale) {
      const rest = dropWords(asked, reply.text);
      if (isSearchable(rest) && rest !== asked) {
        const understood = reply.chips.filter((c) => c.kind !== "text").map((c) => c.label);
        suggestions.push({
          id: "m-sem-texto",
          group: GROUP.agent,
          label: `Buscar sem “${reply.text}”`,
          detail: <span className="block truncate text-xs text-ink-muted">{understood.join(" · ")}</span>,
          icon: <Sparkles className="size-4" />,
          run: () => setQuery(rest),
        });
      }
    }

    const recents: Entry[] = !asked
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
          detail: <span className="block truncate text-xs text-ink-muted">Com o que a {AGENT_NAME} entendeu, para exportar ou agir em lote</span>,
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
    if (asked) {
      const matches = matchScreens([...screens, ...actions], asked);
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
    return [...suggestions, ...recents, ...(screensFirst ? [...places, ...found] : [...found, ...places])];
  })();

  const current = Math.min(active, Math.max(0, entries.length - 1));
  const optionId = (index: number) => `${listId}-${index}`;
  const activeId = entries.length ? optionId(current) : undefined;

  useEffect(() => {
    if (activeId) listRef.current?.querySelector(`#${CSS.escape(activeId)}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId, listRef]);

  // A busca do Enter voltou: abre o resultado escolhido (descartado se o texto mudou nesse meio-tempo).
  // Cada Enter roda uma vez só: a busca que volta a ficar pronta (outra leitura do mesmo texto) não reabre.
  const enterReady = !!pendingEnter && pendingEnter.text === asked && !stale;
  const runPending = useEffectEvent(() => {
    const pending = pendingEnter;
    if (!pending || ranEnter.current === pending.seq) return;
    ranEnter.current = pending.seq;
    entries[current]?.run(pending.mods);
  });
  useEffect(() => {
    if (enterReady) runPending();
  }, [enterReady]);

  // Sem internet o Enter não espera: senão a OS abriria sozinha, sabe-se lá quando, ao voltar a conexão.
  const dropPending = useEffectEvent(() => {
    if (pendingEnter) ranEnter.current = pendingEnter.seq;
  });
  useEffect(() => {
    if (paused) dropPending();
  }, [paused]);

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
      // O que está na tela ainda é da busca anterior: espera a do texto digitado (sem internet, não espera).
      if (asked && stale && isSearchable(asked)) {
        if (!paused) {
          enterSeq.current += 1;
          setPendingEnter({ text: asked, mods, seq: enterSeq.current });
        }
      } else entries[current]?.run(mods);
      return true;
    }
    return false;
  };

  return {
    query,
    setQuery,
    typed,
    asked,
    entries,
    chips: data?.chips ?? [],
    current,
    setActive,
    activeId,
    optionId,
    listId,
    stale,
    thinking,
    paused,
    reply,
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

/** Um filtro que a Mia entendeu (status, cidade, técnico, período...). */
function FilterChip({ chip }: { chip: SearchChip }) {
  const Icon = CHIP_ICON[chip.kind] ?? Type;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[11px] leading-4 font-medium text-brand-ink ring-1 ring-brand/25 ring-inset">
      <Icon aria-hidden className="size-3 shrink-0" />
      {chip.label}
    </span>
  );
}

/** O que a Mia procurou como texto: tracejado, porque não virou filtro. */
function TextChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-line-strong bg-surface px-[5px] py-px text-[11px] leading-4 font-medium text-ink-muted">
      <Type aria-hidden className="size-3 shrink-0" />“{label}”
    </span>
  );
}

const osCount = (total: number) => (total === 0 ? "nenhuma OS" : `${total.toLocaleString("pt-BR")} OS`);

/** Sem internet: a busca do texto atual fica esperando a conexão. */
const OFFLINE = `Sem internet: a ${AGENT_NAME} busca quando a conexão voltar.`;

/**
 * A resposta da Mia, entre o campo e a lista, fora da área que rola: "Entendi:" com os filtros (e o
 * texto, tracejado) ou "Procurei" com o texto, e quantas OS deu (mesmo nenhuma, para a caixa não sumir
 * quando a busca volta). Enquanto ela procura, a resposta anterior fica esmaecida; sem resposta
 * anterior, "Procurando…". Sem internet, uma linha parada no lugar da resposta.
 */
export function AgentReply({ ctl }: { ctl: SearchController }) {
  const { thinking, stale, paused } = ctl;
  const reply = paused ? null : ctl.reply;
  if (!reply && !thinking && !paused) return null;
  return (
    <div className="px-2 pt-2">
      <div
        className={clsx(
          "mx-1 flex items-start gap-2 rounded-lg bg-brand-soft/50 px-2 py-1.5 text-xs leading-5 text-ink transition-opacity duration-150",
          reply && stale && "opacity-60",
        )}
      >
        <AgentMark size="xs" thinking={thinking} />
        {paused ? (
          <p className="text-ink-muted">{OFFLINE}</p>
        ) : reply ? (
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <strong className="font-semibold">{reply.mode === "text" ? "Procurei" : "Entendi:"}</strong>
              {reply.mode === "text" ? (
                <TextChip label={reply.text ?? ""} />
              ) : (
                reply.chips.map((chip, i) =>
                  chip.kind === "text" ? (
                    <TextChip key={`text-${i}`} label={chip.label} />
                  ) : (
                    <FilterChip key={`${chip.kind}-${chip.label}-${i}`} chip={chip} />
                  ),
                )
              )}
              <span className="text-ink-muted tabular-nums">· {osCount(reply.total)}</span>
            </p>
            {reply.mode === "partial" ? <p className="text-ink-muted">Nenhuma OS com o texto “{reply.text}” nesse recorte.</p> : null}
          </div>
        ) : (
          <p className="text-ink-muted">Procurando…</p>
        )}
      </div>
    </div>
  );
}

/** O que o leitor de tela ouve quando a busca volta: o resumo da Mia e quantos resultados há. */
function spokenSummary(ctl: SearchController): string {
  const results = `${plural(ctl.entries.length, "resultado", "resultados")}.`;
  const reply = ctl.reply;
  if (!reply) return results;
  const say = (chip: SearchChip) => (chip.kind === "text" ? `“${chip.label}”` : chip.label);
  const count = reply.total === 0 ? "Nenhuma OS." : `${reply.total.toLocaleString("pt-BR")} OS.`;
  if (reply.mode === "text") return `Procurei “${reply.text ?? ""}”. ${count} ${results}`;
  if (reply.mode === "partial") {
    const understood = reply.chips.filter((c) => c.kind !== "text").map(say);
    return `Entendi: ${understood.join(", ")}. Nenhuma OS com o texto “${reply.text ?? ""}” nesse recorte. ${results}`;
  }
  return `Entendi: ${reply.chips.map(say).join(", ")}. ${count} ${results}`;
}

/**
 * Resultados da busca (lista de opções do combobox): grupos, erro com "Tentar de novo", nada encontrado e
 * o resumo para o leitor de tela. A resposta da Mia (AgentReply) fica fora daqui, entre o campo e a lista.
 * Quem usa põe em volta a área que rola (com o listRef passado ao controlador).
 */
export function SearchResults({ ctl, onLeave }: { ctl: SearchController; onLeave?: () => void }) {
  const groups = groupEntries(ctl.entries);
  // Nada na lista: a dica do que a Mia entende. Com algum filtro entendido, a resposta dela já diz o que
  // faltou; sem internet, ela ainda não buscou.
  const empty =
    ctl.asked !== "" &&
    !ctl.thinking &&
    !ctl.paused &&
    !ctl.failed &&
    ctl.entries.length === 0 &&
    !ctl.chips.some((c) => c.kind !== "text");
  return (
    <>
      {ctl.failed ? (
        <div
          role="alert"
          className="mx-1 mb-2 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          <span className="flex-1">A {AGENT_NAME} não conseguiu buscar agora.</span>
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
      {empty ? (
        <div className="px-4 py-7 text-center">
          <p className="text-sm font-semibold text-ink">A {AGENT_NAME} não achou nada para “{ctl.asked}”.</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-ink-muted">
            Tente o nº da OS, o nome do cliente ou da loja, um técnico, uma cidade, uma etiqueta ou um período.
          </p>
        </div>
      ) : null}
      {/* Uma fala por busca, só com o resultado do texto atual (digitando, fica quieta); sem internet, avisa uma vez. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {ctl.asked && !ctl.stale ? spokenSummary(ctl) : ctl.paused ? OFFLINE : ""}
      </p>
    </>
  );
}
