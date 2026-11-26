"use client";

import { useToast } from "@/components/Toaster";
import { absoluteApiUrl } from "@/lib/api";
import { FILE_LINK_FRESH_MS } from "@/lib/documents";

/**
 * Um arquivo do técnico (documento, versão anterior, arquivo da ficha) num link de verdade para outra aba: o clique, o
 * Ctrl/⌘+clique e o botão do meio abrem o link assinado (30 min). Com a lista lida há mais de FILE_LINK_FRESH_MS (o link
 * pode ter vencido), o clique e o botão do meio abrem a aba vazia, pedem a lista de novo (`refresh`, o link novo; null se
 * o arquivo saiu) e só então navegam; se falhar, a aba fecha e fica o aviso.
 */
export function FileLink({
  url,
  fetchedAt,
  refresh,
  label,
  className,
  children,
}: {
  /** O link assinado, relativo à API. */
  url: string;
  /** Quando a lista com este link foi lida (o dataUpdatedAt da consulta). */
  fetchedAt: number;
  refresh: () => Promise<string | null>;
  /** O nome acessível ("Abrir NR10 em outra aba"). */
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { toast } = useToast();
  const stale = () => Date.now() - fetchedAt > FILE_LINK_FRESH_MS;

  const openFresh = async () => {
    // A aba abre agora, no clique (depois de esperar a lista, o navegador a bloquearia).
    const tab = window.open("", "_blank");
    if (!tab) {
      toast({ title: "O navegador bloqueou a nova aba", description: "Libere as janelas pop-up deste site para abrir o arquivo.", tone: "error" });
      return;
    }
    tab.opener = null;
    try {
      const fresh = absoluteApiUrl(await refresh());
      if (!fresh) throw new Error("O arquivo saiu da lista");
      tab.location.href = fresh;
    } catch {
      tab.close();
      toast({ title: "Não foi possível abrir o arquivo", tone: "error" });
    }
  };

  return (
    <a
      href={absoluteApiUrl(url) ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className={className}
      onClick={(e) => {
        if (!stale()) return;
        e.preventDefault();
        void openFresh();
      }}
      onAuxClick={(e) => {
        // Só o botão do meio (o direito abre o menu do navegador, que fica como está).
        if (e.button !== 1 || !stale()) return;
        e.preventDefault();
        void openFresh();
      }}
    >
      {children}
    </a>
  );
}
