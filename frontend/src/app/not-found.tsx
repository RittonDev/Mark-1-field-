"use client";

import { Compass } from "lucide-react";
import Link from "next/link";
import { buttonClassName } from "@/components/ui";
import { useDocumentTitle } from "@/lib/hooks";

/** Endereço que não existe (link antigo, OS digitada errado na barra...). */
export default function NotFound() {
  useDocumentTitle("Página não encontrada");
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="flex max-w-md animate-enter flex-col items-center gap-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand">
          <Compass aria-hidden className="size-6" />
        </span>
        <div>
          <h1 className="text-lg font-bold tracking-[-0.02em] text-ink">Página não encontrada</h1>
          <p className="mt-1 text-sm text-ink-muted">O endereço pode ter mudado ou o link já não vale. Volte para o início.</p>
        </div>
        {/* Botão primário do sistema (no escuro, o tom forte da marca mantém o texto branco legível). */}
        <Link href="/" className={buttonClassName("primary")}>
          Ir para o início
        </Link>
      </div>
    </main>
  );
}
