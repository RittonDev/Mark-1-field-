"use client";

import clsx from "clsx";
import { CheckCircle2, CircleAlert, type LucideIcon, OctagonAlert, TriangleAlert } from "lucide-react";
import { CountUp } from "@/components/motion";
import { revealSection } from "@/components/operacao/hooks";
import { Skeleton } from "@/components/ui";
import { formatTime } from "@/lib/format";
import { intFmt } from "./rules";
import type { AttentionGroup, HomeFocus, Severity } from "./types";

/** Fichas que cabem no celular; as outras viram "+N". */
const MOBILE_CHIPS = 3;

/** Ícone na cor da gravidade (vermelho só para o crítico). */
const SEVERITY_ICON: Record<Severity, { icon: LucideIcon; className: string }> = {
  critical: { icon: OctagonAlert, className: "text-red-600 dark:text-red-400" },
  high: { icon: TriangleAlert, className: "text-amber-600 dark:text-amber-400" },
  medium: { icon: CircleAlert, className: "text-ink-subtle" },
  low: { icon: CircleAlert, className: "text-ink-subtle" },
};

const chipClass =
  "inline-flex h-8 items-center gap-1.5 rounded-full bg-surface px-3 text-[13px] shadow-elev-1 ring-1 ring-line " +
  "transition-shadow duration-150 hover:ring-line-strong focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-hidden";

/** Rola até o alvo e põe o foco nele, sem mudar a URL. Sem o alvo na tela, o link segue normal. */
function reveal(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  revealSection(el);
}

/**
 * O número do topo: quantas OS pedem ação agora (cada OS conta uma vez, mesmo com dois motivos) e uma
 * ficha por motivo, que leva ao cartão do grupo em "Pontos de atenção · Agora". Sem cartão, direto
 * sobre o fundo; a direita fica vazia de propósito.
 */
export function FocusHero({ focus, groups }: { focus: HomeFocus | null; groups: AttentionGroup[] }) {
  if (focus === null) {
    return (
      <div className="min-h-[124px] max-w-[760px]" role="status" aria-label="Carregando o que pede ação agora">
        <Skeleton className="h-14 w-28" />
        <div className="mt-4 flex flex-wrap gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-40" />
          ))}
        </div>
      </div>
    );
  }
  const chips = groups.filter((g) => g.tier === "now" && g.count > 0);
  const extra = chips.length - MOBILE_CHIPS;
  return (
    <section aria-labelledby="pedem-acao" className="min-h-[124px] max-w-[760px]">
      {focus.total > 0 ? (
        <>
          <h2 id="pedem-acao" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <CountUp
              value={focus.total}
              tabular={false}
              className="text-[44px] leading-none font-bold tracking-[-0.03em] text-ink sm:text-[56px]"
            />
            <span className="text-[15px] font-semibold text-ink">
              {focus.total === 1 ? "OS pede ação agora" : "OS pedem ação agora"}
            </span>
          </h2>
          {chips.length ? (
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="Motivos">
              {chips.map((g, i) => {
                const { icon: Icon, className } = SEVERITY_ICON[g.severity] ?? SEVERITY_ICON.medium;
                return (
                  <li key={g.key} className={clsx(i >= MOBILE_CHIPS && "hidden sm:block")}>
                    <a href={`#ponto-${g.key}`} onClick={(e) => reveal(e, `ponto-${g.key}`)} className={chipClass}>
                      <Icon aria-hidden className={clsx("size-4 shrink-0", className)} />
                      <span className="font-bold text-ink tabular-nums">{intFmt(g.count)}</span>
                      <span className="text-ink-muted">{g.title}</span>
                    </a>
                  </li>
                );
              })}
              {extra > 0 ? (
                <li className="sm:hidden">
                  <a
                    href="#pontos-agora"
                    onClick={(e) => reveal(e, "pontos-agora")}
                    className={clsx(chipClass, "font-semibold text-ink-muted")}
                    aria-label={`Mais ${extra} ${extra === 1 ? "motivo" : "motivos"} em Pontos de atenção`}
                  >
                    +{extra}
                  </a>
                </li>
              ) : null}
            </ul>
          ) : null}
        </>
      ) : (
        <div className="flex items-start gap-3">
          <CheckCircle2 aria-hidden className="mt-0.5 size-6 shrink-0 text-ink-subtle" />
          <div>
            <h2 id="pedem-acao" className="text-[15px] font-semibold text-ink">
              Nada pedindo ação agora
            </h2>
            {focus.next_visit_at ? (
              <p className="mt-0.5 text-sm text-ink-muted tabular-nums">Próxima visita às {formatTime(focus.next_visit_at)}</p>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
