"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Card, CardHeader, Skeleton } from "@/components/ui";
import { targetHref } from "./links";
import type { Suggestion } from "./types";

/** Sugestões da API para a operação (o que dá para melhorar agora), cada uma com o atalho para agir. */
export function SuggestionsCard({ suggestions }: { suggestions: Suggestion[] | null }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Sugestões" />
      {suggestions === null ? (
        <div className="flex flex-col gap-4 px-5 py-4" role="status" aria-label="Carregando as sugestões">
          {[0, 1].map((i) => (
            <div key={i}>
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="mt-2 h-3 w-full" />
            </div>
          ))}
        </div>
      ) : suggestions.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">Nenhuma sugestão no momento.</p>
      ) : (
        <ul className="divide-y divide-line">
          {suggestions.map((s) => {
            const href = targetHref(s);
            const body = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink group-hover:text-brand-ink">{s.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{s.detail}</span>
                </span>
                {href ? <ArrowRight aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-subtle group-hover:text-brand" /> : null}
              </>
            );
            return (
              <li key={s.key}>
                {href ? (
                  <Link
                    href={href}
                    className="group flex items-start gap-3 px-5 py-3 transition-colors duration-150 hover:bg-[var(--row-hover)] focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex items-start gap-3 px-5 py-3">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
