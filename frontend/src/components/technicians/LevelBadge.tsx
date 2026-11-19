import clsx from "clsx";
import { LEVEL_MARKS, LEVEL_SHIELD_PATH, LEVEL_TIER } from "@/lib/constants";
import type { LevelTier } from "@/lib/types";

/**
 * O brasão do elo: o escudo na cor da faixa (tokens --tier-* do globals.css, claro e escuro) com as marcas na
 * cor da superfície (1, 2 ou 3 divisas ou a pedra do Diamante: a forma diferencia as faixas sem a cor). É só
 * enfeite: o nome da faixa vai sempre escrito junto.
 */
export function LevelShield({ tier, size = 16, className }: { tier: LevelTier; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      className={clsx("shrink-0", className)}
    >
      <path d={LEVEL_SHIELD_PATH} style={{ fill: `var(${LEVEL_TIER[tier].cssVar})` }} />
      {LEVEL_MARKS[tier].map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ stroke: "var(--surface)" }}
        />
      ))}
    </svg>
  );
}

/**
 * Selo do elo do técnico: pílula neutra com o brasão e o nome da faixa (a cor fica só no escudo). `atRisk`:
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
      <LevelShield tier={tier} size={size === "sm" ? 13 : 16} />
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
