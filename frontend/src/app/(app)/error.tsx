"use client";

import { RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button, buttonClassName } from "@/components/ui";
import { useDocumentTitle } from "@/lib/hooks";
import { isStaleBuildError, reloadOnce } from "@/lib/reload";

/**
 * Uma tela quebrou: o menu continua de pé e dá para tentar de novo sem recarregar tudo. Se a causa é
 * uma versão nova publicada com a central aberta, recarrega sozinho uma vez (o "Tentar de novo" pediria
 * de novo o arquivo que já não existe).
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = isStaleBuildError(error);
  useDocumentTitle(stale ? "Versão nova" : "Erro");

  useEffect(() => {
    if (stale) reloadOnce();
    else console.error(error);
  }, [error, stale]);

  if (stale) {
    return (
      <div role="alert" className="mx-auto flex max-w-md animate-enter flex-col items-center gap-4 py-20 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand">
          <RefreshCw aria-hidden className="size-6" />
        </span>
        <div>
          <h1 className="text-lg font-bold tracking-[-0.02em] text-ink">Há uma versão nova do Maxx Field</h1>
          <p className="mt-1 text-sm text-ink-muted">Atualize a página para continuar. Nada do que já foi salvo se perdeu.</p>
        </div>
        <Button variant="primary" onClick={() => window.location.reload()}>
          <RefreshCw aria-hidden className="size-4" />
          Atualizar
        </Button>
      </div>
    );
  }

  return (
    <div role="alert" className="mx-auto flex max-w-md animate-enter flex-col items-center gap-4 py-20 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
        <TriangleAlert aria-hidden className="size-6" />
      </span>
      <div>
        <h1 className="text-lg font-bold tracking-[-0.02em] text-ink">Esta tela não carregou</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Nada do que já foi salvo se perdeu. Tente de novo; se continuar, avise o suporte com o código abaixo.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={reset}>
          <RotateCcw aria-hidden className="size-4" />
          Tentar de novo
        </Button>
        <Link href="/minha-fila" className={buttonClassName("secondary")}>
          Ir para a Minha fila
        </Link>
      </div>
      {error.digest ? <p className="font-mono text-xs text-ink-subtle">código {error.digest}</p> : null}
    </div>
  );
}
