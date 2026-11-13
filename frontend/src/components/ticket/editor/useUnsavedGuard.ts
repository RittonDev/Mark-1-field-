"use client";

import { useEffect } from "react";
import { useConfirm } from "@/components/Confirm";

// O clique liberado depois da confirmação passa por todas as guardas abertas (página e painel).
let released = false;

export const DISCARD_CONFIRM = {
  title: "Descartar as alterações?",
  description: "As mudanças da aba Geral ainda não foram salvas.",
  confirmLabel: "Descartar",
  cancelLabel: "Continuar editando",
  tone: "danger" as const,
};

/**
 * Enquanto a aba Geral tem alteração não salva: pede confirmação antes de seguir um link interno
 * (cliente, loja, outra OS, menu lateral) e o navegador avisa antes de recarregar ou fechar a aba.
 * Na página da OS, o link de outra OS só abre o painel por cima (a página fica): esse passa direto.
 * O Voltar do navegador não dá para segurar (o popstate não pode ser cancelado).
 */
export function useUnsavedGuard(dirty: boolean, variant: "page" | "dialog") {
  const confirm = useConfirm();
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      if (released || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const anchor = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      if (variant === "page" && anchor.hasAttribute("data-ticket-link")) return;
      const url = new URL(anchor.href, window.location.href);
      const here = window.location;
      if (url.origin !== here.origin || (url.pathname === here.pathname && url.search === here.search)) return;
      e.preventDefault();
      e.stopPropagation();
      void confirm(DISCARD_CONFIRM).then((ok) => {
        if (!ok || !anchor.isConnected) return;
        released = true;
        try {
          anchor.click();
        } finally {
          released = false;
        }
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    // Na captura, antes do Next tratar o link: o clique só segue se a pessoa confirmar.
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [dirty, variant, confirm]);
}
