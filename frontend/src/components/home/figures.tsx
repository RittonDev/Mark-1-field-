"use client";

import clsx from "clsx";
import { CircleDashed, type LucideIcon, OctagonAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { intFmt, meterTone, type MeterTone, pctText, share } from "./rules";
import type { Ratio } from "./types";

/** Trilho das barras segmentadas: o resto, que ainda não aconteceu. */
export const TRACK = "var(--surface-3)";

/** Link neutro dentro do texto de um cartão. */
export const mutedLink = "underline-offset-2 hover:text-ink hover:underline";
/** Link de ação curto no corpo de um cartão ("Abrir agenda"). */
export const actionLink = "font-semibold text-brand-ink underline-offset-2 hover:underline";

export interface SegmentPart {
  key: string;
  label: string;
  value: number;
  /** var(--viz-N), #d97706, var(--ink-subtle) ou TRACK. */
  color: string;
  /** Definição da parte (tooltip na legenda). */
  title?: string;
}

/**
 * Barra fina com as partes de um todo: 8 px, pontas redondas e vão de 2 px na cor do cartão, sem texto
 * dentro. Parte com zero não desenha nada. Cada parte diz nome, número e % no title; o `label` lê a
 * barra inteira (ex.: "Visitas de hoje: 1 concluída, 0 em campo, 3 sem início, 2 a seguir").
 */
export function SegmentBar({ parts, label }: { parts: SegmentPart[]; label: string }) {
  const shown = parts.filter((p) => p.value > 0);
  const total = shown.reduce((sum, p) => sum + p.value, 0);
  return (
    <div role="img" aria-label={label} className="grow-x flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
      {total > 0 ? (
        shown.map((p) => (
          <span
            key={p.key}
            className="h-full min-w-[3px]"
            style={{ flexGrow: p.value, flexBasis: 0, background: p.color }}
            title={`${p.label}: ${intFmt(p.value)} (${pctText((100 * p.value) / total)})`}
          />
        ))
      ) : (
        <span className="h-full w-full" style={{ background: TRACK }} />
      )}
    </div>
  );
}

/** Legenda da barra segmentada, na ordem dela: quadradinho, nome e número. Zero fica neutro (quadradinho vazio). */
export function SwatchLegend({ parts }: { parts: SegmentPart[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted" aria-label="Legenda">
      {parts.map((p) => (
        <li key={p.key} className="inline-flex items-center gap-1.5" title={p.title}>
          <span
            aria-hidden
            className={clsx("size-2 shrink-0 rounded-[2px]", (p.value === 0 || p.color === TRACK) && "ring-1 ring-line-strong ring-inset")}
            style={p.value > 0 ? { background: p.color } : undefined}
          />
          {p.label}
          <span className={clsx("tabular-nums", p.value > 0 && "font-semibold text-ink")}>{intFmt(p.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Cor de problema: âmbar (abaixo da meta, crescendo, sem técnico) e vermelho (prazo estourado, abaixo do piso). */
const PROBLEM = {
  warning: { text: "text-amber-700 dark:text-amber-400", icon: "text-amber-600 dark:text-amber-400" },
  danger: { text: "text-red-600 dark:text-red-400", icon: "text-red-600 dark:text-red-400" },
} as const;

// O preenchimento e o trilho saem da mesma cor (--meter): o trilho é ela a 16% sobre o cartão.
const METER: Record<MeterTone, string> = {
  accent: "[--meter:var(--viz-1)]",
  warning: "[--meter:#d97706]",
  danger: "[--meter:#dc2626] dark:[--meter:#ef4444]",
};

/** Medidor fino (6 px): a cor diz o estado (acento, abaixo da meta, abaixo do piso); o tique marca a meta. */
export function Meter({ value, tone, target, className }: { value: number; tone: MeterTone; target?: number; className?: string }) {
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  return (
    <span
      aria-hidden
      className={clsx("relative block h-1.5 rounded-full bg-[color-mix(in_srgb,var(--meter)_16%,var(--surface))]", METER[tone], className)}
    >
      <span className="grow-x block h-full rounded-full bg-[var(--meter)]" style={{ width: `${clamp(value)}%` }} />
      {target !== undefined ? (
        <span
          className="absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-ink-subtle"
          style={{ left: `${clamp(target)}%` }}
        />
      ) : null}
    </span>
  );
}

/** Base pequena demais para %: o chip neutro no lugar da barra. */
function FewData({ min }: { min: number }) {
  return (
    <span
      className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-muted"
      title={`Menos de ${min} no período: o percentual ainda não diz muito.`}
    >
      <CircleDashed aria-hidden className="size-3 shrink-0" />
      Poucos dados
    </span>
  );
}

/**
 * Uma medida com a base: nome à esquerda e % à direita, a barra embaixo e, na linha da base, "N de M"
 * (e a meta, quando há). Com base abaixo de `min`, só "N de M" e "Poucos dados", sem barra; com base
 * zero, "—". A definição fica no title do nome.
 */
export function MeterRow({
  label,
  ratio,
  title,
  min,
  target,
  floor,
  unit,
  note,
}: {
  label: string;
  ratio: Ratio;
  title?: string;
  /** Base mínima para mostrar o %. */
  min: number;
  /** Meta em % (tique na barra e "meta N%"): abaixo dela, âmbar. */
  target?: number;
  /** Piso em %: abaixo dele, vermelho. */
  floor?: number;
  /** Complemento da base ("com prazo": "56 de 68 com prazo"). */
  unit?: string;
  note?: React.ReactNode;
}) {
  const { pct, text } = share(ratio, min);
  const tone = pct === null ? "accent" : meterTone(pct, target, floor);
  const Alert = tone === "danger" ? OctagonAlert : tone === "warning" ? TriangleAlert : null;
  const alertColor = tone === "danger" ? PROBLEM.danger.icon : PROBLEM.warning.icon;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 text-[13px] font-medium text-ink" title={title}>
          {label}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[15px] font-semibold text-ink tabular-nums">
          {ratio.base === 0 ? (
            <span className="text-ink-muted">—</span>
          ) : pct === null ? (
            text
          ) : (
            <>
              {Alert ? <Alert aria-hidden className={clsx("size-3.5 shrink-0", alertColor)} /> : null}
              {pctText(pct)}
              {Alert ? <span className="sr-only">, abaixo da meta</span> : null}
            </>
          )}
        </span>
      </div>
      {ratio.base === 0 ? (
        <p className="mt-1 text-xs text-ink-muted">Sem dados no período</p>
      ) : pct === null ? (
        <FewData min={min} />
      ) : (
        <>
          <Meter value={pct} tone={tone} target={target} className="mt-1.5" />
          <p className="mt-1 flex justify-between gap-3 text-xs text-ink-muted tabular-nums">
            <span>
              {text}
              {unit ? ` ${unit}` : ""}
            </span>
            {target !== undefined ? <span>meta {target}%</span> : null}
          </p>
        </>
      )}
      {note ? <p className="mt-0.5 text-xs text-ink-muted tabular-nums">{note}</p> : null}
    </div>
  );
}

/**
 * Número que é problema (nunca o zero): ícone e texto na cor do problema, nunca só a cor. Com `href`,
 * leva à lista que mostra exatamente aquele número.
 */
export function ProblemText({
  tone,
  icon: Icon,
  href,
  title,
  children,
}: {
  tone: "warning" | "danger";
  icon: LucideIcon;
  href?: string | null;
  title?: string;
  children: React.ReactNode;
}) {
  const className = clsx("inline-flex items-center gap-1 font-medium", PROBLEM[tone].text, href && "underline-offset-2 hover:underline");
  const body = (
    <>
      <Icon aria-hidden className={clsx("size-3.5 shrink-0", PROBLEM[tone].icon)} />
      {children}
    </>
  );
  return href ? (
    <Link href={href} className={className} title={title}>
      {body}
    </Link>
  ) : (
    <span className={className} title={title}>
      {body}
    </span>
  );
}
