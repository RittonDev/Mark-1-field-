"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { useMemo } from "react";
import { RatingStars } from "@/components/technicians/RatingStars";
import { TicketLink } from "@/components/ticket/TicketLink";
import { Button, ErrorBox, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { RATING_SOURCE } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import {
  averageText,
  isLowScore,
  NO_RATINGS,
  raterText,
  ratingsCountText,
  ratingsSummaryLabel,
  ratingTrail,
  scoreText,
} from "@/lib/ratings";
import type { Technician, TechnicianRating, TechnicianRatings, UUID } from "@/lib/types";
import { fichaLabel } from "../FichaNav";
import { apiErrorText, SectionCard } from "../SectionCard";

/** Avaliações por página (a API aceita até 100). */
const PAGE = 20;

/** As páginas numa lista só, sem repetir (uma avaliação nova no meio empurra as outras para a página seguinte). */
function joinPages(pages: readonly TechnicianRatings[]): TechnicianRating[] {
  const seen = new Set<UUID>();
  const rows: TechnicianRating[] = [];
  for (const page of pages) {
    for (const row of page.items) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Avaliações do cliente (só a central; nada no app e fora do Elo): a média, quantas e a lista, da mais nova para a mais
 * antiga, com a OS (abre no painel por cima da ficha; Ctrl/⌘ e o botão do meio abrem a página da OS em outra aba). Sem
 * ações aqui: a avaliação se registra e se corrige na OS concluída. A chave fica sob ["technicians"]: o tempo real e o
 * salvar da OS mandam buscar de novo.
 */
export function RatingsSection({ tech }: { tech: Technician; canEdit: boolean }) {
  const ratings = useInfiniteQuery({
    queryKey: ["technicians", "ratings", tech.id],
    queryFn: ({ pageParam, signal }) =>
      api.get<TechnicianRatings>(`/technicians/${tech.id}/ratings`, { limit: PAGE, offset: pageParam }, { signal }),
    initialPageParam: 0,
    // A página seguinte começa depois das que já vieram; acabou quando a última veio incompleta ou já chegou a todas.
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.items.length, 0);
      return last.items.length < PAGE || loaded >= last.count ? undefined : loaded;
    },
  });
  const pages = ratings.data?.pages;
  const rows = useMemo(() => joinPages(pages ?? []), [pages]);
  // A média e a quantidade da leitura mais recente (a primeira página relida pelo tempo real).
  const summary = pages?.[0];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = ratings;
  const moreFailed = ratings.isFetchNextPageError && !isFetchingNextPage;

  return (
    <SectionCard title={fichaLabel("avaliacoes")}>
      {ratings.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : ratings.isError && !rows.length && !summary ? (
        <ErrorBox message={apiErrorText(ratings.error)} onRetry={() => void ratings.refetch()} />
      ) : !summary || summary.count === 0 ? (
        <p className="text-sm text-ink-muted">{NO_RATINGS}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="sr-only">{ratingsSummaryLabel(summary.average, summary.count)}</p>
            <span aria-hidden className="text-2xl leading-none font-bold text-ink tabular-nums">
              {averageText(summary.average)}
            </span>
            {summary.average !== null ? <RatingStars value={summary.average} size="lg" /> : null}
            <span aria-hidden className="text-sm text-ink-muted tabular-nums">
              {ratingsCountText(summary.count)}
            </span>
          </div>
          <ol className="flex flex-col divide-y divide-line" aria-busy={isFetchingNextPage || undefined}>
            {rows.map((rating) => (
              <RatingRow key={rating.id} rating={rating} />
            ))}
          </ol>
          {moreFailed ? (
            <ErrorBox message={apiErrorText(ratings.error)} onRetry={() => void fetchNextPage()} />
          ) : hasNextPage ? (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              loading={isFetchingNextPage}
              onClick={() => {
                if (!isFetchingNextPage) void fetchNextPage();
              }}
            >
              Ver mais
            </Button>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}

/** Uma avaliação: a OS, a loja e a conclusão; as estrelas com a nota (até 2 em vermelho); o comentário; quem avaliou e o rastro. */
function RatingRow({ rating }: { rating: TechnicianRating }) {
  const { ticket } = rating;
  const raterLine = raterText(rating.rater_name);
  // O formulário do cliente (depois) não tem quem registrou na central.
  const trail =
    rating.source === "client" && !rating.created_by
      ? `${RATING_SOURCE.client} em ${formatDate(rating.created_at)}`
      : ratingTrail(rating, formatDate);
  return (
    <li className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
          <TicketLink
            ticketId={ticket.id}
            title={ticket.title}
            className="rounded font-semibold text-ink underline-offset-2 hover:text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          >
            {ticket.code}
          </TicketLink>
          {ticket.location ? <span className="min-w-0 truncate text-ink-muted">· {ticket.location}</span> : null}
        </p>
        {ticket.resolved_at ? (
          <span className="shrink-0 text-xs text-ink-muted tabular-nums" title={`OS concluída em ${formatDate(ticket.resolved_at)}`}>
            <span className="sr-only">OS concluída em </span>
            {formatDate(ticket.resolved_at)}
          </span>
        ) : null}
      </div>
      <p className="flex items-center gap-2">
        <RatingStars value={rating.score} />
        <span
          className={clsx(
            "text-sm tabular-nums",
            isLowScore(rating.score) ? "font-medium text-red-700 dark:text-red-400" : "text-ink",
          )}
        >
          {scoreText(rating.score)}
        </span>
      </p>
      {rating.comment ? <p className="text-sm break-words whitespace-pre-line text-ink">“{rating.comment}”</p> : null}
      {raterLine ? <p className="text-xs text-ink-muted">{raterLine}</p> : null}
      <p className="text-xs text-ink-muted">{trail}</p>
    </li>
  );
}
