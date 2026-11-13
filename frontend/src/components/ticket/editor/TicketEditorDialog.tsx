"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { SquarePen, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, ErrorBox, isTopLayer, lockScroll, restoreFocus, Skeleton, trapTab } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { STATUS } from "@/lib/constants";
import type { TicketDetail, TicketStatus, UUID } from "@/lib/types";
import { StatusChip } from "./StatusMenu";
import { TicketEditor } from "./TicketEditor";

/** O que a lista da tela já sabe da OS: o cabeçalho aparece antes do detalhe chegar. */
interface Preview {
  code: string;
  title: string;
  status: TicketStatus;
}

/** Procura a OS nos dados de uma lista em cache (página, seções da fila, atividades do dia...). */
function findPreview(data: unknown, id: string, depth = 0): Preview | null {
  if (!data || typeof data !== "object" || depth > 5) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findPreview(item, id, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record.id === id && typeof record.code === "string" && typeof record.title === "string" && typeof record.status === "string") {
    return record.status in STATUS ? { code: record.code, title: record.title, status: record.status as TicketStatus } : null;
  }
  for (const value of Object.values(record)) {
    const found = findPreview(value, id, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Barra azul do painel enquanto a OS não abre (carregando ou com erro): sempre com o Fechar. */
function PanelBar({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 bg-brand px-5 py-3 text-white dark:bg-brand-strong">
      <SquarePen aria-hidden className="size-4 shrink-0 text-white/80" />
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 rounded-md p-1 text-white/85 hover:bg-white/10 hover:text-white focus-visible:outline-white"
        aria-label="Fechar"
      >
        <X className="size-5" />
      </button>
    </div>
  );
}

/** O formato do editor enquanto a OS carrega (cabeçalho, abas, campos e rodapé): nada pula quando ela chega. */
function EditorSkeleton({ preview, onClose }: { preview: Preview | null; onClose: () => void }) {
  return (
    <div role="status" aria-live="polite" className="flex h-full flex-col">
      <span className="sr-only">Abrindo {preview ? preview.code : "a OS"}...</span>
      <PanelBar onClose={onClose}>
        {preview ? (
          <>
            <p className="min-w-0 flex-1 truncate text-[15px] font-bold tracking-[-0.01em]">
              <span className="font-mono">{preview.code}</span>
              <span className="ml-2 font-normal text-white/90">{preview.title}</span>
            </p>
            <StatusChip status={preview.status} className="shrink-0" />
          </>
        ) : (
          <span aria-hidden className="h-4 w-56 max-w-full rounded bg-white/20" />
        )}
      </PanelBar>
      <div aria-hidden className="flex gap-5 overflow-hidden border-b border-line px-6 pt-3.5 pb-3">
        {[44, 52, 74, 58, 72, 96, 82].map((width, i) => (
          <Skeleton key={i} className="h-3.5 shrink-0" style={{ width }} />
        ))}
      </div>
      <div aria-hidden className="min-h-0 flex-1 overflow-hidden bg-[var(--canvas,transparent)] px-5 py-5">
        <div className="rounded-xl border border-line bg-surface shadow-elev-1">
          <div className="border-b border-line px-5 py-4">
            <Skeleton className="h-4 w-28" />
          </div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-5 p-5 sm:grid-cols-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-9 w-full rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div aria-hidden className="flex items-center gap-3 border-t border-line bg-surface-2/60 px-5 py-3">
        <Skeleton className="h-9 w-20 rounded-lg" />
        <div className="ml-auto flex gap-1">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="size-9 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A OS aberta num painel à direita, como o "Editar atividade" do Field Control: a lista continua à
 * vista (escurecida) e o painel ocupa a altura toda. No celular, a tela inteira. Quem abre é o
 * TicketPanelProvider (um painel por tela, pela URL ?os=).
 */
export function TicketEditorDialog({
  ticketId,
  onClose,
  onDirtyChange,
  entering = true,
}: {
  ticketId: UUID;
  /** Pedido para fechar (Esc, clique fora, X). O TicketPanel pergunta antes se há alteração não salva. */
  onClose: () => void;
  /** A aba Geral passou a ter (ou deixou de ter) alteração não salva. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Abrindo agora (desliza da direita). Trocando de uma OS para outra, o painel só troca o conteúdo. */
  entering?: boolean;
}) {
  const queryClient = useQueryClient();
  const ticket = useQuery({ queryKey: ["ticket", ticketId], queryFn: () => api.get<TicketDetail>(`/tickets/${ticketId}`) });
  // Lido uma vez, ao abrir: a lista de trás (fila, quadro, dia) já tem o nº, o título e a situação.
  const [preview] = useState(() => {
    for (const [, data] of queryClient.getQueriesData({ predicate: (q) => q.queryKey[0] !== "ticket" })) {
      const found = findPreview(data, ticketId);
      if (found) return found;
    }
    return null;
  });
  const panel = useRef<HTMLDivElement>(null);
  // O efeito não depende de onClose: se dependesse, rodaria de novo a cada render de quem abriu e
  // tiraria o foco do campo que está sendo editado.
  const close = useEffectEvent(() => onClose());

  useEffect(() => {
    // Quem abriu (o link ou o botão da lista): o foco volta para ele quando o painel fecha.
    const opener = document.activeElement;
    const unlock = lockScroll();
    // Foco no painel: teclado e leitor de tela começam pela OS, não pela lista atrás.
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const node = panel.current;
      // Já tratado (busca Ctrl+K, legenda de anexo, foto ampliada) ou com outra camada por cima
      // (horários, transição, menu do relatório): o Esc e o Tab são dela.
      if (e.defaultPrevented || !node) return;
      if (e.key === "Escape" && isTopLayer(node)) close();
      else if (e.key === "Tab" && isTopLayer(node, false)) trapTab(e, node);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlock();
      restoreFocus(opener);
    };
  }, []);

  return createPortal(
    // O painel é um portal no <body>, mas o clique ainda "sobe" pela árvore do React até quem o
    // renderiza. Ele para aqui.
    <div className="fixed inset-0 z-40 flex justify-end" onClick={(e) => e.stopPropagation()}>
      <div
        className={clsx("absolute inset-0 bg-[rgb(9_11_15/0.38)] backdrop-blur-[2px]", entering && "animate-fade")}
        // Num duplo clique na lista, o 2º clique (detail 2) cairia aqui e fecharia o painel recém-aberto.
        onClick={(e) => {
          if (e.detail <= 1) onClose();
        }}
        aria-hidden
      />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ticket.data ? `${ticket.data.code}: ${ticket.data.title}` : preview ? `${preview.code}: ${preview.title}` : "Abrindo a OS"}
        data-drawer
        // Celular e tablet: a tela toda. Telas largas: a lista continua à vista ao lado.
        className={clsx(
          "relative flex h-full w-full flex-col bg-surface shadow-pop outline-none sm:border-l sm:border-line lg:w-[56rem] 2xl:w-[64rem]",
          entering && "animate-drawer",
        )}
      >
        {ticket.data ? (
          <TicketEditor ticket={ticket.data} variant="dialog" onClose={onClose} onDirtyChange={onDirtyChange} />
        ) : ticket.error ? (
          <>
            {/* Com erro também há como fechar: no celular o painel cobre tudo. */}
            <PanelBar onClose={onClose}>
              <p className="min-w-0 flex-1 truncate text-[15px] font-bold tracking-[-0.01em]">
                {preview ? `Não foi possível abrir ${preview.code}` : "Não foi possível abrir a OS"}
              </p>
            </PanelBar>
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="flex w-full max-w-md flex-col gap-3">
                <ErrorBox message={errorMessage(ticket.error)} />
                <div className="flex justify-end gap-2">
                  <Button onClick={onClose}>Fechar</Button>
                  <Button variant="primary" loading={ticket.isFetching} onClick={() => void ticket.refetch()}>
                    Tentar de novo
                  </Button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <EditorSkeleton preview={preview} onClose={onClose} />
        )}
      </div>
    </div>,
    document.body,
  );
}
