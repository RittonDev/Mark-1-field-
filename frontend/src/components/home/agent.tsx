// A cara do Maxx Agent, o agente de IA da central: só no botão do topo, no Ctrl+K, na caixa da Início e na
// resposta dele. O resto da central segue sem brilhos nem degradês. Cores e movimento em globals.css
// (.mf-agent-*).

import clsx from "clsx";
import { Sparkles } from "lucide-react";
import { AGENT_NAME } from "./phrase";

/** O convite nos campos do agente (Ctrl+K e a caixa da Início). */
export const AGENT_PROMPT = `Pergunte ao ${AGENT_NAME}`;

/** Nome do diálogo do Ctrl+K e do botão do topo para o leitor de tela. */
export const AGENT_LABEL = `${AGENT_NAME}, busca com IA`;

const MARK_SIZE = {
  xs: "size-5 rounded-md [&_svg]:size-3",
  sm: "size-6 rounded-md [&_svg]:size-3.5",
  md: "size-8 rounded-lg [&_svg]:size-[18px]",
};

/**
 * A marca do Maxx Agent: os brilhos brancos numa placa no degradê da marca. Com `thinking` eles piscam, só
 * enquanto a busca está em andamento; parada, nada se mexe.
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

/** A linha em degradê que corre na base do campo enquanto o agente procura (entra depois de 150 ms). */
export function AgentScan() {
  return <span aria-hidden className="mf-agent-scan" />;
}
