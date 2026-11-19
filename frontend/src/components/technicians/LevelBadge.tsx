"use client";

import clsx from "clsx";
import { useId } from "react";
import { useTheme } from "@/components/Brand";
import {
  LEVEL_MEDAL_COLOR,
  LEVEL_MEDAL_EMBLEM,
  LEVEL_MEDAL_FACE_PATH,
  LEVEL_MEDAL_FACET_STROKE,
  LEVEL_MEDAL_FLAT_BELOW,
  LEVEL_MEDAL_GRADIENT,
  LEVEL_MEDAL_RELIEF,
  LEVEL_MEDAL_RIM_PATH,
  LEVEL_MEDAL_SHADE_PATH,
  LEVEL_MEDAL_SHEEN_PATH,
  LEVEL_MEDAL_SIZE,
  LEVEL_MEDAL_STROKE,
  LEVEL_MEDAL_VIEWBOX,
  LEVEL_TIER,
} from "@/lib/constants";
import type { LevelMedalKind, LevelTier } from "@/lib/types";

/**
 * A patente do técnico (o elo como medalha): a mesma arte do app, de lib/constants.ts, nas cores do tema da tela (também
 * na impressão). A forma e o emblema diferenciam a faixa sem depender da cor, e o nome vai sempre escrito junto: a
 * medalha é só enfeite. `tier` null: sem elo (apagada). Abaixo de LEVEL_MEDAL_FLAT_BELOW px, sai lisa (sem relevo).
 */
export function LevelMedal({
  tier,
  size = LEVEL_MEDAL_SIZE.chip,
  className,
}: {
  tier: LevelTier | null;
  size?: number;
  className?: string;
}) {
  const theme = useTheme();
  const kind: LevelMedalKind = tier ?? "none";
  const colors = LEVEL_MEDAL_COLOR[kind][theme];
  const emblem = LEVEL_MEDAL_EMBLEM[kind];
  const relief = LEVEL_MEDAL_RELIEF[theme];
  const flat = size < LEVEL_MEDAL_FLAT_BELOW;
  const gradient = !flat && LEVEL_MEDAL_GRADIENT;
  // Um id por medalha (duas na mesma tela não trocam os degradês); o do React traz caracteres que quebram url(#…).
  const id = useId().replace(/[^A-Za-z0-9]/g, "");
  return (
    <svg
      viewBox={LEVEL_MEDAL_VIEWBOX}
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      className={clsx("shrink-0", className)}
    >
      {gradient ? (
        <defs>
          <linearGradient id={`${id}rim`} x1="0.15" y1="0.05" x2="0.85" y2="0.95">
            <stop offset="0" stopColor={colors.rim[0]} />
            <stop offset="1" stopColor={colors.rim[1]} />
          </linearGradient>
          <linearGradient id={`${id}face`} x1="0.5" y1="0" x2="0.5" y2="1">
            <stop offset="0" stopColor={colors.face[0]} />
            <stop offset="1" stopColor={colors.face[1]} />
          </linearGradient>
        </defs>
      ) : null}
      <path
        d={LEVEL_MEDAL_RIM_PATH}
        fill={flat ? colors.outline : gradient ? `url(#${id}rim)` : colors.rim[0]}
        stroke={flat ? "none" : colors.outline}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      {flat ? null : <path d={LEVEL_MEDAL_SHEEN_PATH} fill="#FFFFFF" fillOpacity={relief.sheen} />}
      {flat ? null : <path d={LEVEL_MEDAL_SHADE_PATH} fill="#000000" fillOpacity={relief.shade} />}
      <path
        d={LEVEL_MEDAL_FACE_PATH}
        fill={gradient ? `url(#${id}face)` : colors.face[0]}
        stroke={flat ? "none" : colors.edge}
        strokeOpacity={0.6}
        strokeWidth={1}
      />
      {emblem.fills.map((d) => (
        <path key={d} d={d} fill={colors.emblem} />
      ))}
      {flat
        ? null
        : emblem.facets.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              stroke={colors.face[0]}
              strokeWidth={LEVEL_MEDAL_FACET_STROKE}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
      {emblem.strokes.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={colors.emblem}
          strokeWidth={LEVEL_MEDAL_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

/**
 * Selo do elo do técnico: pílula neutra com a medalha e o nome da faixa (a cor fica só na medalha). `atRisk`:
 * abaixo do critério da faixa, com o ponto âmbar (o title e o leitor de tela dizem "em risco").
 */
export function LevelBadge({
  tier,
  atRisk = false,
  size = "sm",
  className,
}: {
  tier: LevelTier;
  atRisk?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const label = LEVEL_TIER[tier].label;
  return (
    <span
      title={`Elo ${label}${atRisk ? " · em risco" : ""}`}
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface-2 font-semibold whitespace-nowrap text-ink",
        size === "sm" ? "h-5 pr-1.5 pl-1 text-[11px]" : "h-6 pr-2 pl-1 text-xs",
        className,
      )}
    >
      <LevelMedal tier={tier} size={size === "sm" ? 14 : LEVEL_MEDAL_SIZE.chip} />
      <span className="sr-only">Elo </span>
      {label}
      {atRisk ? (
        <>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" />
          <span className="sr-only">, em risco</span>
        </>
      ) : null}
    </span>
  );
}
