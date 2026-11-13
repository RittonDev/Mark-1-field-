"use client";

import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui";

const intFmt = (n: number) => n.toLocaleString("pt-BR");

/**
 * Número de destaque com a comparação ao período anterior (texto neutro: a seta indica o sentido).
 * O número só ganha cor quando sinaliza problema (`tone`), como no resto do sistema. Algarismos
 * proporcionais (número grande e sozinho); `tabular-nums` fica para colunas que se alinham.
 */
export function StatTile({
  label,
  value,
  display,
  previous,
  previousLabel,
  sameLabel,
  hint,
  tone,
  compact = false,
  href,
  onSelect,
  selected = false,
  loading = false,
}: {
  label: string;
  value: number;
  /** Texto no lugar do número (ex.: valor em R$, percentual, nome do cliente). */
  display?: string;
  previous?: number;
  /** Complemento da diferença, ex.: "vs dia anterior". */
  previousLabel?: string;
  /** Texto quando o número não mudou, ex.: "igual ao dia anterior" (sem ele: "sem variação"). */
  sameLabel?: string;
  hint?: React.ReactNode;
  /** Só quando o número indica problema (abaixo da meta, atraso). */
  tone?: "warning" | "danger";
  /** Valor em texto menor, cortado com reticências (ex.: nome do cliente destaque). */
  compact?: boolean;
  /** Leva ao detalhe (ex.: a lista de OS do cliente). */
  href?: string;
  /** Cartão que filtra a lista logo abaixo (ex.: "A pagar"): vira botão, marcado quando `selected`. */
  onSelect?: () => void;
  selected?: boolean;
  /** Ainda carregando: o lugar do número fica reservado (nada de "R$ 0,00" provisório). */
  loading?: boolean;
}) {
  const delta = previous === undefined || loading ? null : value - previous;
  const Icon = delta === null || delta === 0 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  // Só elementos de frase (span): o cartão pode ser um botão.
  const body = (
    <>
      <span className="block text-xs font-semibold text-ink/80">{label}</span>
      {loading ? (
        <Skeleton className="mt-2 mb-1 h-7 w-24 rounded-md" />
      ) : (
        <span
          className={clsx(
            "mt-1 block font-semibold tracking-tight",
            compact ? "truncate text-lg leading-8" : display !== undefined ? "text-2xl leading-9" : "text-3xl leading-9",
            tone === "danger" ? "text-red-600 dark:text-red-400" : tone === "warning" ? "text-amber-700 dark:text-amber-400" : "text-ink",
          )}
          title={compact ? display : undefined}
        >
          {display ?? intFmt(value)}
        </span>
      )}
      {delta !== null ? (
        <span className="mt-1 flex items-center gap-1 text-xs text-ink-muted tabular-nums">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            {delta === 0
              ? (sameLabel ?? "sem variação")
              : `${delta > 0 ? "+" : "−"}${intFmt(Math.abs(delta))} ${previousLabel ?? ""}`.trim()}
          </span>
        </span>
      ) : null}
      {hint ? <span className="mt-1 block text-xs text-ink-muted">{hint}</span> : null}
    </>
  );
  const box = "block min-w-0 rounded-xl border bg-surface px-4 py-3 text-left shadow-elev-1";
  const interactive =
    "transition-[border-color,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none";
  if (onSelect) {
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={clsx(
          box,
          interactive,
          selected ? "border-brand bg-brand-soft ring-2 ring-brand/15" : "border-line hover:border-line-strong",
        )}
      >
        {body}
      </button>
    );
  }
  return href ? (
    <Link href={href} className={clsx(box, interactive, "border-line hover:border-line-strong")}>
      {body}
    </Link>
  ) : (
    <div className={clsx(box, "border-line")}>{body}</div>
  );
}

export interface RankItem {
  /** Cliente ou técnico; o motivo de visita improdutiva vem sem id. */
  id?: string | null;
  name: string;
  count: number;
}

/** Ranking em barras horizontais finas (uma cor: é magnitude, não identidade). */
export function RankBars({
  items,
  empty,
  href,
  label,
}: {
  items: RankItem[];
  empty: string;
  /** Leva ao detalhe do item (ex.: as OS do cliente). */
  href?: (item: RankItem) => string | undefined;
  /** Nome da lista para o leitor de tela. */
  label?: string;
}) {
  if (items.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <ol className="flex flex-col gap-2.5" aria-label={label}>
      {items.map((item, index) => {
        const to = href?.(item);
        return (
          // Nomes repetidos acontecem (dois clientes ou técnicos com o mesmo nome): a chave é o id.
          <li key={item.id ?? `${item.name}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
            {to ? (
              <Link href={to} className="block truncate text-sm font-semibold text-ink hover:text-brand hover:underline" title={item.name}>
                {item.name}
              </Link>
            ) : (
              <span className="truncate text-sm font-semibold text-ink" title={item.name}>
                {item.name}
              </span>
            )}
            <span className="text-sm font-medium text-ink tabular-nums">{intFmt(item.count)}</span>
            <span className="col-span-2 h-2 overflow-hidden rounded-r bg-surface-2" aria-hidden>
              <span className="block h-full rounded-r" style={{ width: `${(item.count / max) * 100}%`, background: "var(--viz-1)" }} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export interface TrendSeries {
  key: string;
  label: string;
  color: string; // var(--viz-N)
  values: number[];
}

const TOOLTIP_WIDTH = 176;
/** Distância mínima entre dois rótulos no fim das linhas; mais perto que isso, eles saem (legenda e tooltip bastam). */
const END_LABEL_GAP = 14;

/**
 * Linhas por dia, um eixo só. A cruz acompanha o ponteiro (mouse ou dedo) até o dia mais próximo e o
 * tooltip lista todas as séries; pelo teclado, as setas andam de dia em dia (com leitura para o leitor
 * de tela). O nome e o último valor vão direto no fim de cada linha quando há espaço e não se encostam.
 */
export function TrendChart({
  labels,
  series,
  height = 240,
  formatLabel,
  partialLast = false,
}: {
  /** Rótulo curto de cada ponto no eixo (ex.: "12"). */
  labels: string[];
  series: TrendSeries[];
  height?: number;
  /** Título do ponto no tooltip e na leitura por teclado (ex.: "qui., 12/11"); sem ele, o rótulo do eixo. */
  formatLabel?: (index: number) => string;
  /** O último ponto ainda está em andamento (hoje): o trecho final fica tracejado. */
  partialLast?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [pointer, setPointer] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = labels.length;
  // Trocou de período com a cruz num dia que não existe mais (31 -> 13 dias): some.
  const hover = pointer !== null && pointer < n ? pointer : null;
  const titleOf = (i: number) => formatLabel?.(i) ?? labels[i];
  const top = 12;
  const bottom = 26;
  const left = 36;
  const h = height - top - bottom;
  const rawMax = Math.max(1, ...series.flatMap((s) => s.values));
  const step = rawMax <= 5 ? 1 : rawMax <= 10 ? 2 : Math.ceil(rawMax / 5 / 5) * 5;
  const max = Math.ceil(rawMax / step) * step;
  const ticks = Array.from({ length: max / step + 1 }, (_, i) => i * step);
  const y = (v: number) => top + h - (v / max) * h;
  // Rótulos diretos só quando cabem (tela larga) e não se encostam: empurrar um para longe da própria
  // linha confunde mais do que ajuda.
  const ends = n > 0 ? series.map((s) => y(s.values[n - 1])).sort((a, b) => a - b) : [];
  const endLabels = width >= 420 && ends.length > 0 && ends.every((v, i) => i === 0 || v - ends[i - 1] >= END_LABEL_GAP);
  const right = endLabels ? 96 : 14;
  const w = width - left - right;
  const x = (i: number) => left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const every = Math.ceil(n / Math.max(2, Math.floor(w / 46)));
  const dashed = partialLast && n >= 2;

  const pick = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = box.width > 0 ? (e.clientX - box.left) / box.width : 0;
    setPointer(Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1)))));
  };
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    const current = hover ?? n - 1;
    const next =
      e.key === "ArrowLeft" ? current - 1 : e.key === "ArrowRight" ? current + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setPointer(Math.min(n - 1, Math.max(0, next)));
  };
  const reading = hover === null ? "" : `${titleOf(hover)}: ${series.map((s) => `${s.label} ${intFmt(s.values[hover])}`).join(", ")}`;
  const tipLeft = hover === null ? 0 : x(hover) + 12 + TOOLTIP_WIDTH <= width ? x(hover) + 12 : Math.max(0, x(hover) - 12 - TOOLTIP_WIDTH);

  return (
    <div ref={wrap} className="relative w-full">
      {n === 0 ? (
        <p className="py-16 text-center text-sm text-ink-muted">Sem dados no período.</p>
      ) : (
        <>
          <svg
            width={width}
            height={height}
            role="img"
            tabIndex={0}
            aria-label={`Gráfico: ${series.map((s) => s.label).join(" e ")} por dia. Use as setas para ler dia a dia.`}
            onKeyDown={onKey}
            onFocus={() => setPointer(hover ?? n - 1)}
            onBlur={() => setPointer(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={left} x2={left + w} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
                <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-muted text-[11px] tabular-nums">
                  {intFmt(t)}
                </text>
              </g>
            ))}
            {labels.map((l, i) =>
              i % every === 0 || i === n - 1 ? (
                <text key={i} x={x(i)} y={height - 8} textAnchor="middle" className="fill-ink-muted text-[11px] tabular-nums">
                  {l}
                </text>
              ) : null,
            )}
            {hover !== null ? (
              <line x1={x(hover)} x2={x(hover)} y1={top} y2={top + h} stroke="var(--ink-subtle)" strokeOpacity={0.55} strokeWidth={1} />
            ) : null}
            {series.map((s) => {
              const points = s.values.map((v, i) => `${x(i)},${y(v)}`);
              return (
                <g key={s.key}>
                  <polyline
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    points={(dashed ? points.slice(0, -1) : points).join(" ")}
                  />
                  {dashed ? (
                    <polyline
                      fill="none"
                      stroke={s.color}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeDasharray="3 4"
                      points={points.slice(-2).join(" ")}
                    />
                  ) : null}
                  {/* Um dia só (o 1º do mês): sem linha para traçar, o ponto. */}
                  {n === 1 && hover === null ? <circle cx={x(0)} cy={y(s.values[0])} r={4} fill={s.color} /> : null}
                  {endLabels ? (
                    <text x={x(n - 1) + 8} y={y(s.values[n - 1])} dy="0.32em" className="fill-ink text-[11px] font-medium">
                      {s.label} {intFmt(s.values[n - 1])}
                    </text>
                  ) : null}
                  {hover !== null ? (
                    <circle cx={x(hover)} cy={y(s.values[hover])} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                  ) : null}
                </g>
              );
            })}
            {/* Uma área só para o ponteiro (mouse ou toque): a cruz vai para o dia mais perto. */}
            <rect
              x={left}
              y={top}
              width={Math.max(0, w)}
              height={h}
              fill="transparent"
              onPointerMove={pick}
              onPointerDown={pick}
              onPointerLeave={(e) => {
                if (e.pointerType === "mouse") setPointer(null);
              }}
            />
          </svg>
          <p className="sr-only" aria-live="polite">
            {reading}
          </p>
          {hover !== null ? (
            <div
              className="pointer-events-none absolute top-2 z-10 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-elev-2"
              style={{ left: tipLeft, width: TOOLTIP_WIDTH }}
              aria-hidden
            >
              <p className="mb-1 font-semibold text-ink">
                {titleOf(hover)}
                {dashed && hover === n - 1 ? <span className="font-normal text-ink-muted"> · parcial</span> : null}
              </p>
              {series.map((s) => (
                <p key={s.key} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-1.5 text-ink-muted">
                    <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="font-semibold text-ink tabular-nums">{intFmt(s.values[hover])}</span>
                </p>
              ))}
            </div>
          ) : null}
          {dashed ? <p className="mt-1 text-xs text-ink-muted">Trecho tracejado: hoje, ainda em andamento.</p> : null}
        </>
      )}
    </div>
  );
}

export function Legend({ series }: { series: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted" aria-label="Legenda">
      {series.map((s) => (
        <li key={s.label} className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
