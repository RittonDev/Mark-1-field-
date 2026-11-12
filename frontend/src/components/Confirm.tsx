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
    (options) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <Dialog
          open
          onClose={() => close(false)}
          title={
            <span className="flex items-center gap-2">
              {pending.tone === "danger" ? (
                <span className="flex size-7 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
                  <TriangleAlert className="size-4" />
                </span>
              ) : null}
              {pending.title}
            </span>
          }
          footer={
            <>
              <Button onClick={() => close(false)}>{pending.cancelLabel ?? "Voltar"}</Button>
              <Button variant={pending.tone === "danger" ? "danger" : "primary"} onClick={() => close(true)} autoFocus>
                {pending.confirmLabel ?? "Confirmar"}
              </Button>
            </>
          }
        >
          {pending.description ? <div className="text-sm text-ink-muted">{pending.description}</div> : null}
        </Dialog>
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
