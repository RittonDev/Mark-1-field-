"use client";

import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CountUp } from "@/components/motion";

const intFmt = (n: number) => n.toLocaleString("pt-BR");

/**
 * Número de destaque com a comparação ao período anterior (texto neutro: a seta indica o sentido).
 * O número só ganha cor quando sinaliza problema (`tone`), como no resto do sistema.
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
}: {
  label: string;
  value: number;
  /** Texto no lugar do número (ex.: valor em R$, percentual, nome do cliente). */
  display?: string;
  previous?: number;
  /** Complemento da diferença, ex.: "vs dia anterior". */
  previousLabel?: string;
  /** Texto quando o número não mudou, ex.: "igual ao dia anterior". */
  sameLabel?: string;
  hint?: string;
  /** Só quando o número indica problema (abaixo da meta, atraso). */
  tone?: "warning" | "danger";
  /** Valor em texto menor, cortado com reticências (ex.: nome do cliente destaque). */
  compact?: boolean;
  /** Leva ao detalhe (ex.: a lista de OS do cliente). */
  href?: string;
}) {
  const delta = previous === undefined ? null : value - previous;
  const Icon = delta === null || delta === 0 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const body = (
    <>
      <p className="text-xs font-semibold text-ink/80">{label}</p>
      <p
        className={clsx(
          "mt-1 font-semibold tracking-tight",
          compact ? "truncate text-lg leading-8" : display !== undefined ? "text-2xl leading-9" : "text-3xl leading-9",
          tone === "danger" ? "text-red-600 dark:text-red-400" : tone === "warning" ? "text-amber-700 dark:text-amber-400" : "text-ink",
        )}
        title={compact ? display : undefined}
      >
        {display ?? <CountUp value={value} duration={250} />}
      </p>
      {delta !== null ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-ink-muted tabular-nums">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            {delta === 0
              ? (sameLabel ?? `sem variação ${previousLabel ?? ""}`.trim())
              : `${delta > 0 ? "+" : "−"}${intFmt(Math.abs(delta))} ${previousLabel ?? ""}`.trim()}
          </span>
        </p>
      ) : null}
      {hint ? <p className="mt-1 text-xs text-ink-muted">{hint}</p> : null}
    </>
  );
  const box = "block min-w-0 rounded-xl border border-line bg-surface px-4 py-3 shadow-elev-1";
  return href ? (
    <Link
      href={href}
      className={clsx(
        box,
        "transition-colors duration-150 hover:border-line-strong focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
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

/** Linhas por dia, um eixo só, com cruz e tooltip ao passar o mouse e rótulo direto no fim. */
export function TrendChart({ labels, series, height = 240 }: { labels: string[]; series: TrendSeries[]; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { top: 12, right: 88, bottom: 26, left: 32 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const n = labels.length;
  const rawMax = Math.max(1, ...series.flatMap((s) => s.values));
  const step = rawMax <= 5 ? 1 : rawMax <= 10 ? 2 : Math.ceil(rawMax / 5 / 5) * 5;
  const max = Math.ceil(rawMax / step) * step;
  const ticks = Array.from({ length: max / step + 1 }, (_, i) => i * step);
  const x = (i: number) => pad.left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => pad.top + h - (v / max) * h;
  const every = Math.ceil(n / Math.max(2, Math.floor(w / 46)));
  // Rótulos no fim das linhas: afasta os que ficariam sobrepostos (mín. 13 px).
  const endY: Record<string, number> = {};
  if (n > 0) {
    const placed = series
      .map((s) => ({ key: s.key, y: y(s.values[n - 1]) }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < placed.length; i++) {
      if (placed[i].y - placed[i - 1].y < 13) placed[i].y = placed[i - 1].y + 13;
    }
    placed.forEach((p) => (endY[p.key] = p.y));
  }

  return (
    <div ref={wrap} className="relative w-full" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={`Gráfico: ${series.map((s) => s.label).join(" e ")} por dia`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={pad.left + w} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-muted text-[11px] tabular-nums">
              {t}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % every === 0 || i === n - 1 ? (
            <text key={l} x={x(i)} y={height - 8} textAnchor="middle" className="fill-ink-muted text-[11px] tabular-nums">
              {l}
            </text>
          ) : null,
        )}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + h} stroke="var(--ink-muted)" strokeWidth={1} strokeDasharray="3 3" /> : null}
        {series.map((s) => (
          <g key={s.key}>
            <polyline
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
            />
            {n > 0 ? (
              <text x={x(n - 1) + 8} y={endY[s.key]} dy="0.32em" className="fill-ink text-[11px] font-medium">
                {s.label} {s.values[n - 1]}
              </text>
            ) : null}
            {hover !== null ? (
              <circle cx={x(hover)} cy={y(s.values[hover])} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            ) : null}
          </g>
        ))}
        {labels.map((l, i) => (
          <rect
            key={`hit-${l}`}
            x={x(i) - (n <= 1 ? w / 2 : w / (n - 1) / 2)}
            y={pad.top}
            width={n <= 1 ? w : w / (n - 1)}
            height={h}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {hover !== null ? (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md"
          style={{ left: Math.min(Math.max(x(hover) + 12, 0), width - 160) }}
        >
          <p className="mb-1 font-semibold text-ink">{labels[hover]}</p>
          {series.map((s) => (
            <p key={s.key} className="flex items-center justify-between gap-4 text-ink-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="font-medium text-ink tabular-nums">{s.values[hover]}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Legend({ series }: { series: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
      {series.map((s) => (
        <li key={s.label} className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
