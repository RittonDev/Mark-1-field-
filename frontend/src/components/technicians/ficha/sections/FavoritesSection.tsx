"use client";

import { Star } from "lucide-react";
import Link from "next/link";
import { ErrorBox, Skeleton } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useFavorites } from "@/lib/queries";
import type { Technician } from "@/lib/types";
import { favoritesHref } from "../../FavoritesView";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";

/**
 * Favoritos (só leitura nesta entrega): as cidades em que ele é favorito, pela regra (as OS atendidas) ou fixado pela
 * central. Cada cidade abre a aba Favoritos de Técnicos já nela.
 */
export function FavoritesSection({ tech }: { tech: Technician }) {
  const favorites = useFavorites({ technicianId: tech.id });
  const cities = (favorites.data?.cities ?? []).flatMap((city) => {
    const me = city.favorites.find((f) => f.id === tech.id);
    return me ? [{ city, me }] : [];
  });

  return (
    <SectionCard title={fichaLabel("favoritos")}>
      {favorites.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : favorites.error ? (
        <ErrorBox message={errorMessage(favorites.error)} onRetry={() => void favorites.refetch()} />
      ) : !cities.length ? (
        <p className="text-sm text-ink-muted">Não é favorito em nenhuma cidade.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {cities.map(({ city, me }) => (
            <li key={`${city.state}-${city.key}`} className="flex flex-wrap items-center gap-x-1.5 text-sm text-ink">
              <Star aria-hidden className="size-3.5 shrink-0 fill-current text-brand" />
              <Link
                href={favoritesHref(city.state, city.city)}
                className="rounded font-medium text-ink underline-offset-2 hover:text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                {city.city}-{city.state}
              </Link>
              <span className="text-ink-muted">({me.pinned ? "fixado" : `${me.visits} OS`})</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
