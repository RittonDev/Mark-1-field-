import { Compass } from "lucide-react";
import Link from "next/link";

/** Endereço que não existe (link antigo, OS digitada errado na barra...). */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="flex max-w-md animate-enter flex-col items-center gap-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand">
          <Compass className="size-6" />
        </span>
        <div>
          <h1 className="text-lg font-bold tracking-[-0.02em] text-ink">Página não encontrada</h1>
          <p className="mt-1 text-sm text-ink-muted">O endereço pode ter mudado ou o link já não vale. Volte para o início.</p>
        </div>
        <Link
          href="/"
          className="inline-flex h-9 items-center rounded-lg bg-brand px-3.5 text-sm font-medium text-white hover:bg-brand-strong"
        >
          Ir para o início
        </Link>
      </div>
    </main>
  );
}
