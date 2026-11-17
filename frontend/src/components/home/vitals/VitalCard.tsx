"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Card, CardHeader, Skeleton } from "@/components/ui";

/** Atalho curto no cabeçalho de um cartão ("Abrir o dia →"). */
export function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap text-brand-ink underline-offset-2 hover:underline"
    >
      {children}
      <ArrowRight aria-hidden className="size-3.5" />
    </Link>
  );
}

/**
 * Casca dos 4 sinais vitais: o cartão opaco de sempre com o filete de luz no topo, o atalho no
 * cabeçalho, o rodapé com borda e a mesma altura carregando ou com dados (sem pulo quando chegam).
 */
export function VitalCard({
  title,
  description,
  action,
  loading,
  footer,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  action?: { href: string; label: string };
  loading: boolean;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="h-full">
      <Card className="relative flex h-full min-h-[248px] flex-col transition-[border-color] duration-150 hover:border-line-strong dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.04),var(--elev-1)]">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-5 top-0 h-px bg-linear-to-r from-transparent via-brand/45 to-transparent dark:via-brand/60"
        />
        <CardHeader
          title={title}
          description={description}
          actions={action ? <CardLink href={action.href}>{action.label}</CardLink> : undefined}
        />
        {loading ? (
          <div role="status" aria-label={`Carregando: ${title}`} className="flex flex-1 flex-col gap-3 px-4 py-4 sm:px-5">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="mt-auto h-3 w-1/2" />
          </div>
        ) : (
          <>
            <div className="flex flex-1 flex-col gap-3 px-4 py-4 sm:px-5">{children}</div>
            {footer ? <div className="border-t border-line px-4 py-3 text-xs text-ink-muted sm:px-5">{footer}</div> : null}
          </>
        )}
      </Card>
    </section>
  );
}
