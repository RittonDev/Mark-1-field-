// A cara da Mia, a busca com IA da central: só no botão do topo, no Ctrl+K, na caixa da Início e na
// resposta dela. O resto da central segue sem brilhos nem degradês. Cores e movimento em globals.css
// (.mf-agent-*).

import clsx from "clsx";
import { Sparkles } from "lucide-react";
import { AGENT_NAME } from "./phrase";

/** O convite nos campos da Mia (botão do topo, Ctrl+K e a caixa da Início). */
export const AGENT_PROMPT = `Diga à ${AGENT_NAME} o que procura`;

/** Nome do diálogo do Ctrl+K. */
export const AGENT_LABEL = `${AGENT_NAME}, busca com IA`;

const MARK_SIZE = {
  xs: "size-5 rounded-md [&_svg]:size-3",
  sm: "size-6 rounded-md [&_svg]:size-3.5",
  md: "size-8 rounded-lg [&_svg]:size-[18px]",
};

/**
 * A marca da Mia: os brilhos azuis numa placa. Com `thinking` eles piscam, só enquanto a busca está em
 * andamento; parada, nada se mexe.
 */
export function AgentMark({
  size = "sm",
  thinking = false,
  className,
}: {
  size?: keyof typeof MARK_SIZE;
  thinking?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={clsx("mf-agent-mark inline-flex shrink-0 items-center justify-center", MARK_SIZE[size], thinking && "is-thinking", className)}
    >
      <Sparkles strokeWidth={2} />
    </span>
  );
}

/** Selo "IA" dos campos da Mia; `from` é a largura a partir da qual ele aparece. */
export function AgentBadge({ from, className }: { from?: "sm" | "md"; className?: string }) {
  return (
    <span
      aria-hidden
      title={`${AGENT_NAME}, a IA de busca do Maxx Field`}
      className={clsx(
        from === "md" ? "hidden md:inline-flex" : from === "sm" ? "hidden sm:inline-flex" : "inline-flex",
        "h-5 shrink-0 items-center rounded-full bg-brand-soft px-1.5 text-[10px] font-bold tracking-[0.06em] text-brand-ink ring-1 ring-brand/15 ring-inset",
        className,
      )}
    >
      IA
    </span>
  );
}

/** A linha em degradê que corre na base do campo enquanto a Mia procura (entra depois de 150 ms). */
export function AgentScan() {
  return <span aria-hidden className="mf-agent-scan" />;
}
