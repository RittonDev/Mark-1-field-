"use client";

import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { AttentionList } from "@/components/home/AttentionList";
import { HomeSearch } from "@/components/home/HomeSearch";
import { KpiRow } from "@/components/home/KpiRow";
import { SuggestionsCard } from "@/components/home/SuggestionsCard";
import type { HomeOverview } from "@/components/home/types";
import { WeekCard } from "@/components/home/WeekCard";
import { revealSection } from "@/components/operacao/hooks";
import { RefreshFailed } from "@/components/operacao/status";
import { Button, ErrorBox, PageHeader, SectionTitle } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dayKey, formatTime, OPERATION_TZ } from "@/lib/format";

const hourFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: OPERATION_TZ });
const longDayFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: OPERATION_TZ });

/** "Bom dia" / "Boa tarde" / "Boa noite" pela hora de São Paulo. */
function greeting(now: number): string {
  const hour = Number(hourFmt.format(now)) % 24;
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

/** "Terça-feira, 17 de novembro". */
function longToday(now: number): string {
  const text = longDayFmt.format(now);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Listas sempre presentes, mesmo que a API omita alguma. */
function normalize(data: Partial<HomeOverview>): HomeOverview {
  const k = data.kpis;
  return {
    generated_at: data.generated_at ?? new Date().toISOString(),
    kpis: {
      open: k?.open ?? 0,
      scheduled_today: k?.scheduled_today ?? 0,
      in_field_now: k?.in_field_now ?? 0,
      resolved_today: k?.resolved_today ?? 0,
      late: k?.late ?? 0,
      unassigned: k?.unassigned ?? 0,
    },
    attention: Array.isArray(data.attention) ? data.attention.filter((g) => g && g.count > 0).map((g) => ({ ...g, items: g.items ?? [] })) : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    week: Array.isArray(data.week) ? data.week : [],
  };
}

/** A API em uso ainda não tem o resumo do Início (rota inexistente). */
const routeMissing = (error: unknown) => error instanceof ApiError && error.status === 404 && error.detail === "Not Found";

const ATTENTION_ID = "pontos-de-atencao";

export default function HomePage() {
  const { user } = useAuth();
  const now = useNow(60_000);
  // Na chave "dashboard": o tempo real (eventos das OS) e o fechar do painel da OS já releem.
  const overview = useQuery({
    queryKey: ["dashboard", "home"],
    queryFn: async ({ signal }) => normalize(await api.get<Partial<HomeOverview>>("/home/overview", undefined, { signal })),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: (count, error) => !routeMissing(error) && count < 2,
  });
  const data = overview.data;
  const firstName = (user?.name ?? "").trim().split(/\s+/)[0];
  const updatedAt = data?.generated_at ?? (overview.dataUpdatedAt ? new Date(overview.dataUpdatedAt).toISOString() : null);

  const showLate = () => {
    const el = document.getElementById(ATTENTION_ID);
    if (el) revealSection(el);
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        eyebrow={longToday(now)}
        title="Início"
        description={
          <>
            {greeting(now)}
            {firstName ? `, ${firstName}` : ""}. O que pede atenção na operação agora
            {updatedAt && data ? <span className="tabular-nums"> · Atualizado às {formatTime(updatedAt)}</span> : null}
          </>
        }
        actions={
          <Button variant="ghost" size="sm" onClick={() => void overview.refetch()} aria-busy={overview.isFetching || undefined}>
            <RotateCw aria-hidden className={overview.isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
            Atualizar
          </Button>
        }
      />

      {user ? <HomeSearch user={user} /> : null}

      {overview.error && data ? (
        <RefreshFailed at={overview.errorUpdatedAt} onRetry={() => void overview.refetch()} retrying={overview.isFetching} className="mt-5" />
      ) : null}

      {overview.error && !data ? (
        <div className="mt-6">
          <ErrorBox
            title="Não foi possível carregar o resumo"
            message={routeMissing(overview.error) ? "O resumo do Início ainda não está disponível neste servidor." : errorMessage(overview.error)}
            onRetry={() => void overview.refetch()}
          />
        </div>
      ) : (
        <>
          <section className="mt-6" aria-label="Números do momento">
            <KpiRow kpis={data?.kpis ?? null} onShowLate={showLate} />
          </section>

          <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
            <section id={ATTENTION_ID} tabIndex={-1} aria-labelledby={`${ATTENTION_ID}-titulo`} className="scroll-mt-20 rounded-xl outline-none">
              <SectionTitle
                as="h2"
                className="mb-3"
                aside={
                  data && data.attention.length ? (
                    <span className="text-xs text-ink-muted">
                      {data.attention.length} {data.attention.length === 1 ? "ponto" : "pontos"}
                    </span>
                  ) : null
                }
              >
                <span id={`${ATTENTION_ID}-titulo`}>Pontos de atenção</span>
              </SectionTitle>
              <AttentionList groups={data?.attention ?? null} now={now} />
            </section>

            <aside className="flex flex-col gap-4" aria-label="Sugestões e semana">
              <SuggestionsCard suggestions={data?.suggestions ?? null} />
              <WeekCard week={data?.week ?? null} today={dayKey(now)} />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
