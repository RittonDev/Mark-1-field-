"use client";

import clsx from "clsx";
import { Hand, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useConnectionState } from "@/lib/realtime";

const clockFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Hora de um carimbo em milissegundos (dataUpdatedAt/errorUpdatedAt do TanStack). */
export const clock = (at: number) => clockFmt.format(at);

/**
 * A atualização em segundo plano falhou (ex.: a API reiniciando), mas a tela continua com o que já
 * tinha: avisa, sem apagar a lista, e oferece tentar de novo.
 */
export function RefreshFailed({
  at,
  onRetry,
  retrying,
  className,
}: {
  at: number;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={clsx(
        "flex animate-enter flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900",
        "dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
        className,
      )}
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">Não foi possível atualizar às {clock(at || Date.now())}. A tela mostra os últimos dados.</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="font-semibold underline-offset-2 hover:underline disabled:opacity-60"
      >
        {retrying ? "Tentando..." : "Tentar de novo"}
      </button>
    </div>
  );
}

/**
 * Como a tela se mantém em dia: com o tempo real ligado, a hora da última leitura; sem ele, avisa que
 * só atualiza sozinha de tempos em tempos e oferece atualizar agora.
 */
export function LiveStatus({
  updatedAt,
  every,
  onRefresh,
  refreshing,
}: {
  /** dataUpdatedAt do TanStack (0 enquanto não carregou). */
  updatedAt: number;
  /** De quanto em quanto tempo a tela relê sozinha (ex.: "a cada minuto"). */
  every: string;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const state = useConnectionState();
  // "Conectando" na abertura é normal; depois de já ter conectado, é o tempo real caído tentando voltar.
  const [wasOnline, setWasOnline] = useState(state === "online");
  if (state === "online" && !wasOnline) setWasOnline(true);
  const down = state === "offline" || (state === "connecting" && wasOnline);
  if (!down) {
    return <span className="tabular-nums">{updatedAt ? `Atualizado ${clock(updatedAt)}` : "Atualizando..."}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <span>Tempo real desconectado · atualiza {every}</span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="font-semibold text-brand-ink underline-offset-2 hover:underline disabled:opacity-60"
      >
        {refreshing ? "Atualizando..." : "Atualizar"}
      </button>
    </span>
  );
}

/** Técnico desativado: não entra mais no app, então a visita não acontece até alguém trocar o técnico. */
export function InactiveChip({ className }: { className?: string }) {
  return (
    <span
      title="Ele não entra mais no app: troque o técnico na OS"
      className={clsx(
        "inline-flex shrink-0 items-center rounded-md bg-red-50 px-1.5 py-px text-[11px] font-semibold whitespace-nowrap text-red-700 ring-1 ring-red-200 ring-inset",
        "dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25",
        className,
      )}
    >
      inativo · reatribua
    </span>
  );
}

/** Botão "Puxar" das linhas (ícone, à esquerda do Editar): leva a OS para a minha fila. */
export function ClaimButton({ code, busy, onClaim }: { code: string; busy: boolean; onClaim: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClaim();
      }}
      disabled={busy}
      aria-label={`Puxar ${code} para a minha fila`}
      title="Puxar para a minha fila"
      className={clsx(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted shadow-elev-1",
        "transition-[border-color,background-color,transform] duration-150 hover:border-brand/40 hover:bg-brand-soft hover:text-brand active:translate-y-px",
        "focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none disabled:opacity-60",
      )}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Hand className="size-4" />}
    </button>
  );
}
