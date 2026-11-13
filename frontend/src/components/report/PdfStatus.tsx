"use client";

// Avisos do PDF gerado no navegador (relatório e orçamento públicos): o passo atual enquanto gera e,
// se falhar (celular sem memória, imagem que o gerador não lê), o caminho pela impressão do navegador.

import { FileWarning, Loader2, Printer, X } from "lucide-react";
import { Button } from "@/components/ui";

const box =
  "fixed right-4 bottom-4 left-4 z-50 flex animate-toast gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink shadow-pop sm:left-auto sm:max-w-sm print:hidden";

/** O passo atual ("Preparando as fotos (12 de 40)..."); `null` esconde. */
export function PdfProgress({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <div role="status" aria-live="polite" className={`${box} items-center`}>
      <Loader2 className="size-4 shrink-0 animate-spin text-ink-muted" />
      {text}
    </div>
  );
}

/** Não deu para gerar aqui: imprimir e escolher "Salvar como PDF" chega ao mesmo arquivo. */
export function PdfFailed({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div role="alert" className={`${box} items-start`}>
      <FileWarning className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Não foi possível gerar o PDF aqui.</p>
        <p className="mt-0.5 text-xs text-ink-muted">Use Imprimir e escolha “Salvar como PDF”.</p>
        <Button
          size="sm"
          className="mt-2"
          onClick={() => {
            onClose();
            window.print();
          }}
        >
          <Printer className="size-3.5" />
          Imprimir
        </Button>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="rounded-md p-1 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        aria-label="Fechar aviso"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
