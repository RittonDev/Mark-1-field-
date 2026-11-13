"use client";

import { TriangleAlert } from "lucide-react";
import { createContext, useCallback, useContext, useState } from "react";
import { Button, Dialog } from "@/components/ui";

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" para excluir, cancelar ou desativar (botão vermelho). */
  tone?: "danger" | "default";
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Confirmação no padrão do sistema (no lugar da janela cinza do navegador). */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) =>
        setPending((current) => {
          // Uma confirmação nova no lugar de outra ainda aberta: a anterior conta como "Voltar".
          current?.resolve(false);
          return { ...options, resolve };
        }),
      ),
    [],
  );
  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  const danger = pending?.tone === "danger";
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <Dialog
          open
          size="sm"
          role="alertdialog"
          onClose={() => close(false)}
          title={
            <span className="flex items-center gap-2">
              {danger ? (
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
                  <TriangleAlert aria-hidden className="size-4" />
                </span>
              ) : null}
              {pending.title}
            </span>
          }
          description={pending.description}
          footer={
            <>
              {/* Ação que destrói (excluir, cancelar) não começa com o foco: um Enter a mais não confirma. */}
              <Button onClick={() => close(false)} autoFocus={danger}>
                {pending.cancelLabel ?? "Voltar"}
              </Button>
              <Button variant={danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus={!danger}>
                {pending.confirmLabel ?? "Confirmar"}
              </Button>
            </>
          }
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}

/** `await confirm({...})` devolve true quando a pessoa confirma. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (ctx) return ctx;
  // Fora do provedor (não deveria acontecer): a confirmação do navegador.
  return (o) => Promise.resolve(window.confirm(o.title));
}
