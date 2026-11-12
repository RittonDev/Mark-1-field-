"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui";

/** Uma tela quebrou: o menu continua de pé e dá para tentar de novo sem recarregar tudo. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md animate-enter flex-col items-center gap-4 py-20 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
        <TriangleAlert className="size-6" />
      </span>
      <div>
        <h1 className="text-lg font-semibold text-ink">Esta tela não carregou</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Nada do que já foi salvo se perdeu. Tente de novo; se continuar, avise o suporte com o código abaixo.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={reset}>
          <RotateCcw className="size-4" />
          Tentar de novo
        </Button>
        <Link
          href="/minha-fila"
          className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3.5 text-sm font-medium text-ink shadow-elev-1 hover:border-line-strong hover:bg-surface-2"
        >
          Ir para a Minha fila
        </Link>
      </div>
      {error.digest ? <p className="font-mono text-xs text-ink-subtle">código {error.digest}</p> : null}
    </div>
  );
}
