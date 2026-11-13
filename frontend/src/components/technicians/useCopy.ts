"use client";

import { useToast } from "@/components/Toaster";
import { copyText } from "@/lib/whatsapp";

/**
 * Copia o texto e avisa. Sem área de transferência (ex.: a central aberta por http na rede), seleciona o
 * texto na tela para a pessoa copiar na mão: a senha provisória e o link de cadastro só aparecem uma vez.
 */
export function useCopy() {
  const { toast } = useToast();
  return async (text: string, options: { select?: HTMLElement | null; title?: string; description?: string } = {}) => {
    if (await copyText(text)) {
      toast({ title: options.title ?? "Copiado", description: options.description, tone: "success" });
      return true;
    }
    if (options.select) window.getSelection()?.selectAllChildren(options.select);
    toast({ title: "Não foi possível copiar: selecione o texto e copie", tone: "error" });
    return false;
  };
}
