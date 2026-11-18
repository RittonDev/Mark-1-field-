"use client";

import clsx from "clsx";
import { type LucideIcon, MoreHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CountUp } from "@/components/motion";

/** Algo pendente na aba (ex.: prazo vencido): ponto colorido ao lado do rótulo e o texto para o leitor de tela. */
export interface TicketTabAlert {
  tone: "danger" | "warning";
  /** Lido depois do rótulo (ex.: "prazo vencido"). */
  label: string;
}

export interface TicketTabItem<K extends string> {
  key: K;
  label: string;
  icon: LucideIcon;
  /** Contador ao lado do rótulo; zero ou vazio esconde. */
  count?: number | null;
  alert?: TicketTabAlert | null;
}

/** Abaixo desta largura (celular) as abas inativas mostram só o ícone. */
const COMPACT_BELOW = 560;
/** Espaço entre as abas (gap-1). */
const GAP = 4;
/** Recuo do traço da aba ativa em cada ponta. */
const INSET = 8;
/** Chave do "Mais" no roving tabindex (nunca é chave de aba: as chaves não começam com "_"). */
const MORE = "__more";

const TAB =
  "relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap " +
  "transition-[color,background-color,box-shadow] duration-150 focus-visible:-outline-offset-2 " +
  // Fundo do hover em pílula, sem encostar no traço da aba ativa.
  "before:absolute before:inset-x-0 before:inset-y-1.5 before:-z-10 before:rounded-md before:bg-ink/[0.045] " +
  "before:opacity-0 before:transition-opacity before:duration-150 hover:before:opacity-100";

const BADGE = "rounded-full px-1.5 text-[11px] leading-[18px] font-semibold tabular-nums transition-colors duration-150";

const TONE_RANK = { warning: 1, danger: 2 } as const;

function AlertDot({ tone, className }: { tone: TicketTabAlert["tone"]; className?: string }) {
  // Âmbar 600 e vermelho 600 passam de 3:1 no branco (o ponto é a marca visual do alerta).
  return (
    <span
      aria-hidden
      className={clsx(
        "size-1.5 shrink-0 rounded-full",
        tone === "danger" ? "bg-red-600 dark:bg-red-400" : "bg-amber-600 dark:bg-amber-400",
        className,
      )}
    />
  );
}

/** Nome completo da aba para o leitor de tela quando ela mostra só o ícone. */
function spokenName<K extends string>(item: TicketTabItem<K>): string {
  return `${item.label}${item.count ? ` (${item.count})` : ""}${item.alert ? `, ${item.alert.label}` : ""}`;
}

/** Ícone, rótulo, alerta e contador: o mesmo desenho na aba, no item do "Mais" e no clone que mede. */
function TabFace<K extends string>({
  item,
  label,
  active = false,
  animate = false,
  fill = false,
}: {
  item: TicketTabItem<K>;
  /** false: só o ícone (celular), com o ponto de alerta sobre ele. */
  label: boolean;
  active?: boolean;
  /** Contador que anda até o número novo (na aba de verdade; no clone, o número direto). */
  animate?: boolean;
  /** Item do menu: o rótulo ocupa a linha e o contador fica na ponta direita. */
  fill?: boolean;
}) {
  const Icon = item.icon;
  const count = item.count || null;
  return (
    <>
      <span className="relative flex shrink-0">
        <Icon aria-hidden className="size-4" />
        {!label && item.alert ? <AlertDot tone={item.alert.tone} className="absolute -top-0.5 -right-0.5 ring-2 ring-surface" /> : null}
      </span>
      {label ? (
        <>
          {/* A largura já conta o negrito da aba ativa: trocar de aba não empurra as vizinhas. */}
          <span
            data-label={item.label}
            className={clsx(
              "inline-flex flex-col after:invisible after:h-0 after:overflow-hidden after:font-semibold after:content-[attr(data-label)]",
              fill && "flex-1",
            )}
          >
            {item.label}
          </span>
          {item.alert ? <AlertDot tone={item.alert.tone} /> : null}
          {count ? (
            <span className={clsx(BADGE, active ? "bg-brand-soft text-brand-ink" : "bg-surface-3 text-ink-muted")}>
              {animate ? <CountUp value={count} /> : count}
            </span>
          ) : null}
          {item.alert ? <span className="sr-only">, {item.alert.label}</span> : null}
        </>
      ) : null}
    </>
  );
}

/** Conteúdo do botão "Mais": ícone, texto e o ponto do pior alerta das abas que estão nele. */
function MoreFace({ tone }: { tone: TicketTabAlert["tone"] | null }) {
  return (
    <>
      <MoreHorizontal aria-hidden className="size-4 shrink-0" />
      Mais
      {tone ? <AlertDot tone={tone} /> : null}
    </>
  );
}

/**
 * Quais abas cabem na fileira, na ordem, guardando o lugar do "Mais". A aba ativa nunca fica no "Mais":
 * troca de lugar com a última visível (ou as últimas, se for mais larga). Tudo cabendo, não há "Mais".
 */
function fitTabs<K extends string>(keys: K[], width: (key: K) => number, active: K, room: number, more: number): K[] {
  const span = (list: K[]) => list.reduce((sum, key, i) => sum + width(key) + (i ? GAP : 0), 0);
  if (span(keys) <= room) return keys;
  const budget = room - more - GAP;
  const visible: K[] = [];
  for (const key of keys) {
    if (span([...visible, key]) > budget) break;
    visible.push(key);
  }
  if (keys.includes(active) && !visible.includes(active)) {
    while (visible.length && span([...visible, active]) > budget) visible.pop();
    visible.push(active);
  }
  return visible;
}

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((key, i) => key === b[i]);

/**
 * Barra de abas da OS. Nunca rola para o lado: mede (num clone invisível) quanto cabe e manda o resto
 * para o menu "Mais", com a aba ativa sempre à vista. No celular as abas inativas viram só o ícone.
 * Traço da marca que desliza até a aba ativa; teclado no padrão de abas (roving tabindex), com o "Mais"
 * no fim da fileira: setas, Home e End percorrem; Enter, Espaço ou seta para baixo abrem o menu.
 */
export function TicketTabs<K extends string>({
  items,
  value,
  onChange,
  idPrefix,
  ariaLabel,
}: {
  items: TicketTabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  /** A aba recebe o id "<prefixo>-tab-<chave>" e aponta para o painel "<prefixo>-panel-<chave>". */
  idPrefix: string;
  ariaLabel: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  /** Aba escolhida no "Mais": recebe o foco quando entrar na fileira. */
  const focusAfter = useRef<K | null>(null);
  const [fit, setFit] = useState<{ visible: K[]; compact: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  // Roving tabindex: quem entra no Tab (a aba ativa, ou o "Mais" quando o foco está nele).
  const [roving, setRoving] = useState<string>(value);
  const [seenValue, setSeenValue] = useState(value);
  if (seenValue !== value) {
    setSeenValue(value);
    setRoving(value);
  }

  const keys = items.map((i) => i.key);
  // Antes da primeira medida, todas; a ativa entra sempre (a medida acerta a fileira antes de pintar).
  const fitted = fit ? fit.visible.filter((key) => keys.includes(key)) : keys;
  const visibleKeys = fitted.includes(value) || !keys.includes(value) ? fitted : [...fitted.slice(0, -1), value];
  const compact = fit?.compact ?? false;
  const shown = visibleKeys.map((key) => items.find((i) => i.key === key)!);
  const hidden = items.filter((i) => !visibleKeys.includes(i.key));
  const hiddenAlerts = hidden.flatMap((i) => (i.alert ? [i.alert] : []));
  const worst = hiddenAlerts.reduce<TicketTabAlert["tone"] | null>(
    (tone, a) => (!tone || TONE_RANK[a.tone] > TONE_RANK[tone] ? a.tone : tone),
    null,
  );
  const menuOpen = open && hidden.length > 0;
  const group = hidden.length ? [...visibleKeys, MORE] : visibleKeys;
  const tabStop = group.includes(roving) ? roving : value;
  const menuId = `${idPrefix}-more`;

  // O que muda a largura das abas (rótulo, contador, alerta) pede uma nova medida.
  const signature = items.map((i) => `${i.key}:${i.label}:${i.count || ""}:${i.alert?.tone ?? ""}`).join("|");

  useLayoutEffect(() => {
    const box = root.current;
    const sizes = probe.current;
    if (!box || !sizes) return;
    const measure = () => {
      const widthOf = (selector: string) => sizes.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
      // 1 px de folga: as larguras quebradas somadas não podem passar da fileira.
      const room = box.clientWidth - 1;
      const narrow = room < COMPACT_BELOW;
      const order = Array.from(sizes.querySelectorAll<HTMLElement>('[data-probe="full"]')).map((el) => el.dataset.key as K);
      const alerted = new Set(
        Array.from(sizes.querySelectorAll<HTMLElement>('[data-probe="full"][data-alert]')).map((el) => el.dataset.key),
      );
      const width = (key: K) =>
        widthOf(`[data-probe="${narrow && key !== value ? "icon" : "full"}"][data-key="${CSS.escape(key)}"]`);
      let visible = fitTabs(order, width, value, room, widthOf('[data-probe="more"]'));
      // Aba com alerta indo para o "Mais": ele ganha o ponto (fica mais largo) e a conta se refaz.
      if (order.some((key) => !visible.includes(key) && alerted.has(key))) {
        visible = fitTabs(order, width, value, room, widthOf('[data-probe="more-alert"]'));
      }
      setFit((prev) => (prev && prev.compact === narrow && sameKeys(prev.visible, visible) ? prev : { visible, compact: narrow }));
    };
    measure();
    // A fileira muda de largura (janela, painel) ou as abas mudam (fonte que carrega, contador que chega).
    const observer = new ResizeObserver(() => measure());
    observer.observe(box);
    observer.observe(sizes);
    return () => observer.disconnect();
  }, [signature, value]);

  // Traço da aba ativa: desliza (transform e largura); a primeira posição entra sem animar.
  useLayoutEffect(() => {
    const row = list.current;
    const bar = indicator.current;
    if (!row || !bar) return;
    const place = () => {
      const el = row.querySelector<HTMLElement>(`[data-tab="${CSS.escape(value)}"]`);
      if (!el) {
        bar.style.opacity = "0";
        return;
      }
      bar.style.opacity = "1";
      bar.style.width = `${Math.max(0, el.offsetWidth - INSET * 2)}px`;
      bar.style.transform = `translateX(${el.offsetLeft + INSET}px)`;
    };
    if (!placed.current) {
      bar.style.transition = "none";
      place();
      void bar.offsetWidth;
      bar.style.transition = "";
      placed.current = true;
    } else {
      place();
    }
    const observer = new ResizeObserver(place);
    observer.observe(row);
    row.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [value, fit]);

  // A aba escolhida no "Mais" já está na fileira: o foco vai para ela.
  useEffect(() => {
    const key = focusAfter.current;
    if (key === null) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(key)}"]`);
    if (!el) return;
    focusAfter.current = null;
    el.focus();
  }, [value, fit]);

  // Menu aberto: foco no primeiro item; clique fora fecha.
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !moreButton.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const focusKey = (key: string) => {
    if (key === MORE) moreButton.current?.focus();
    else list.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(key)}"]`)?.focus();
  };

  const closeMenu = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) moreButton.current?.focus();
  };

  const pick = (key: K) => {
    setOpen(false);
    focusAfter.current = key;
    if (key !== value) onChange(key);
  };

  // Setas, Home e End nas abas e no "Mais" (o menu trata as próprias teclas).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (menu.current?.contains(e.target as Node)) return;
    const current = (e.target as HTMLElement).closest<HTMLElement>("[data-roving]")?.dataset.roving;
    const index = current ? group.indexOf(current) : -1;
    if (index < 0 || group.length === 0) return;
    let next: number;
    if (e.key === "ArrowRight") next = (index + 1) % group.length;
    else if (e.key === "ArrowLeft") next = index === 0 ? group.length - 1 : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = group.length - 1;
    else return;
    e.preventDefault();
    const key = group[next];
    setRoving(key);
    // Abas ativam ao chegar (padrão de abas); o "Mais" só recebe o foco.
    if (key !== MORE && key !== value) onChange(key as K);
    focusKey(key);
  };

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const index = entries.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      // O Esc fecha só o menu (o painel da OS continua aberto).
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.key === "Tab") {
      closeMenu(false);
    } else if (entries.length && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? entries.length - 1
            : (index + (e.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
      entries[next].focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
    }
  };

  return (
    <div
      ref={root}
      // O clone que mede é mais largo que a fileira: cortado aqui, nunca rola para o lado (o menu desce, não é cortado).
      className="relative overflow-x-clip"
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // O foco saiu da barra: na volta, o Tab cai de novo na aba ativa.
        if (!root.current?.contains(e.relatedTarget as Node | null)) setRoving(value);
      }}
    >
      {/* Clone invisível que mede cada aba (inteira e só o ícone) e o "Mais". */}
      <div
        ref={probe}
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 flex h-0 w-max overflow-hidden font-medium"
      >
        {items.map((item) => (
          <span key={`full-${item.key}`} data-probe="full" data-key={item.key} data-alert={item.alert ? "" : undefined} className={TAB}>
            <TabFace item={item} label active />
          </span>
        ))}
        {items.map((item) => (
          <span key={`icon-${item.key}`} data-probe="icon" data-key={item.key} className={TAB}>
            <TabFace item={item} label={false} />
          </span>
        ))}
        {/* O "Mais" sem e com o ponto de alerta (o ponto aparece quando vai para ele uma aba com alerta). */}
        <span data-probe="more" className={TAB}>
          <MoreFace tone={null} />
        </span>
        <span data-probe="more-alert" className={TAB}>
          <MoreFace tone="danger" />
        </span>
      </div>

      <div className="flex gap-1">
        <div ref={list} role="tablist" aria-label={ariaLabel} className="relative isolate flex min-w-0 gap-1">
          <span
            ref={indicator}
            aria-hidden
            className="brand-gradient pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full opacity-0 transition-[transform,width,opacity] duration-200 ease-out-expo"
          />
          {shown.map((item) => {
            const active = item.key === value;
            const iconOnly = compact && !active;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                id={`${idPrefix}-tab-${item.key}`}
                aria-controls={`${idPrefix}-panel-${item.key}`}
                aria-selected={active}
                aria-label={iconOnly ? spokenName(item) : undefined}
                title={iconOnly ? item.label : undefined}
                tabIndex={item.key === tabStop ? 0 : -1}
                data-tab={item.key}
                data-roving={item.key}
                onClick={() => {
                  if (!active) onChange(item.key);
                }}
                onFocus={() => setRoving(item.key)}
                className={clsx(TAB, active ? "font-semibold text-ink" : "font-medium text-ink-muted hover:text-ink")}
              >
                <TabFace item={item} label={!iconOnly} active={active} animate />
              </button>
            );
          })}
        </div>
        {hidden.length ? (
          <button
            ref={moreButton}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-label={`Mais seções${hiddenAlerts.length ? `, ${hiddenAlerts.map((a) => a.label).join(", ")}` : ""}`}
            tabIndex={tabStop === MORE ? 0 : -1}
            data-roving={MORE}
            onClick={() => setOpen((v) => !v)}
            onFocus={() => setRoving(MORE)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && !menuOpen) {
                e.preventDefault();
                e.stopPropagation();
                setOpen(true);
              }
            }}
            className={clsx(TAB, "font-medium", menuOpen ? "text-ink before:opacity-100" : "text-ink-muted hover:text-ink")}
          >
            <MoreFace tone={worst} />
          </button>
        ) : null}
      </div>

      {menuOpen ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Mais seções da OS"
          onKeyDown={onMenuKey}
          className="absolute top-full right-0 z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] animate-enter overflow-hidden rounded-xl border border-line bg-surface py-1.5 text-ink shadow-pop"
        >
          {hidden.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitemradio"
              aria-checked={item.key === value}
              tabIndex={-1}
              onClick={() => pick(item.key)}
              className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm font-medium text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:-outline-offset-2"
            >
              <TabFace item={item} label fill />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
