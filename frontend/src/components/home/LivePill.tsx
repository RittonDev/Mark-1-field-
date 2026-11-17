"use client";

import { WifiOff } from "lucide-react";
import { useState } from "react";
import { formatTime } from "@/lib/format";
import { useConnectionState } from "@/lib/realtime";

/**
 * "Ao vivo · 11:28": a hora dos dados e se a tela está recebendo as mudanças na hora. Ponto parado,
 * nada pisca (a tela fica aberta o dia todo). O tempo real caído vira "Reconectando…"; desistiu de
 * conectar, "Sem conexão" com a hora dos dados que estão na tela.
 */
export function LivePill({ updatedAt }: { updatedAt: string | null }) {
  const state = useConnectionState();
  // "Conectando" na abertura é normal; depois de já ter conectado, é o tempo real caído tentando voltar.
  const [wasOnline, setWasOnline] = useState(state === "online");
  if (state === "online" && !wasOnline) setWasOnline(true);
  const time = updatedAt ? formatTime(updatedAt) : null;
  const offline = state === "offline";
  const reconnecting = state === "connecting" && wasOnline;

  let label: string;
  let title: string | undefined;
  if (offline) {
    label = time ? `Sem conexão · dados das ${time}` : "Sem conexão";
    title = "Sem tempo real: a tela relê a cada minuto enquanto a conexão não volta.";
  } else if (reconnecting) {
    label = "Reconectando…";
    title = time ? `Tempo real caiu; os dados são das ${time}.` : undefined;
  } else {
    label = time ? `Ao vivo · ${time}` : "Ao vivo";
    title = time ? `Dados das ${time}; a tela se atualiza sozinha.` : undefined;
  }
  return (
    <span
      className="inline-flex h-7 items-center gap-1.5 rounded-full bg-surface px-2.5 text-xs font-medium whitespace-nowrap text-ink-muted tabular-nums ring-1 ring-line"
      title={title}
    >
      {offline ? (
        <WifiOff aria-hidden className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      ) : (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: reconnecting ? "#d97706" : state === "online" ? "var(--viz-2)" : "var(--ink-subtle)" }}
        />
      )}
      {label}
    </span>
  );
}
