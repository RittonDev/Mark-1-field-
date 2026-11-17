"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { RotateCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { AttentionList } from "@/components/home/AttentionList";
import { useBackdropStopped } from "@/components/home/backdropPref";
import { BackdropToggle } from "@/components/home/BackdropToggle";
import { CustomersCard } from "@/components/home/CustomersCard";
import { FocusHero } from "@/components/home/FocusHero";
import { HomeSearch } from "@/components/home/HomeSearch";
import { LivePill } from "@/components/home/LivePill";
import { SuggestionsCard } from "@/components/home/SuggestionsCard";
import { TeamCard } from "@/components/home/TeamCard";
import { TrendCard } from "@/components/home/TrendCard";
import type { HomeData, HomeFinance, HomeOverview, HomePulse, HomeQuotes } from "@/components/home/types";
import { BacklogCard } from "@/components/home/vitals/BacklogCard";
import { FinanceCard } from "@/components/home/vitals/FinanceCard";
import { QuotesCard } from "@/components/home/vitals/QuotesCard";
import { ServiceCard } from "@/components/home/vitals/ServiceCard";
import { TodayCard } from "@/components/home/vitals/TodayCard";
import { RefreshFailed } from "@/components/operacao/status";
import { Button, ErrorBox, PageHeader, SectionTitle } from "@/components/ui";
import { useMediaQuery, useSaveData } from "@/components/useMediaQuery";
import { useNow } from "@/components/useNow";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dayKey, OPERATION_TZ } from "@/lib/format";

// O fundo (canvas) só existe no navegador e vem em pedaço próprio, depois do resto da tela.
const HomeBackdrop = dynamic(() => import("@/components/home/HomeBackdrop"), { ssr: false, loading: () => null });

/** A tela releu os dados: o fundo solta uma sinapse (ele mesmo limita a uma a cada 10 s). */
const DATA_EVENT = "mf:inicio:dados";

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

/** Valor em R$ como número (o JSON pode trazer o decimal como texto). */
function money(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function normalizeFinance(f: HomeFinance | null | undefined): HomeFinance | null {
  if (!f) return null;
  return {
    ...f,
    payouts_to_pay: money(f.payouts_to_pay),
    payouts_expected: money(f.payouts_expected),
    quotes_waiting_total: money(f.quotes_waiting_total),
    quotes_approved_month_total: money(f.quotes_approved_month_total),
    costs_pending_total: money(f.costs_pending_total),
    payout_tag: f.payout_tag ?? null,
    payout_tag_filters: f.payout_tag_filters ?? null,
  };
}

/** Contagem que a API manda; ausente (API parcial) vale 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Orçamentos com os valores em número; sem o bloco (API antiga ou sem permissão), null e a caixinha não aparece. */
function normalizeQuotes(q: HomeQuotes | null | undefined): HomeQuotes | null {
  if (!q || typeof q !== "object") return null;
  return {
    awaiting: count(q.awaiting),
    awaiting_total: money(q.awaiting_total),
    awaiting_no_link: count(q.awaiting_no_link),
    expiring: count(q.expiring),
    expired_90d: count(q.expired_90d),
    expired_90d_total: money(q.expired_90d_total),
    drafts: count(q.drafts),
    in_review: count(q.in_review),
    follow_up: count(q.follow_up),
    follow_up_total: money(q.follow_up_total),
    approved_month: count(q.approved_month),
    approved_month_total: money(q.approved_month_total),
    rejected_month: count(q.rejected_month),
    approved_90d: count(q.approved_90d),
    decided_90d: count(q.decided_90d),
  };
}

/** Sinais vitais inteiros ou nada: faltando um bloco (API antiga ou parcial), os cartões somem em vez de quebrar. */
function normalizePulse(p: HomePulse | null | undefined): HomePulse | null {
  if (!p || !p.window_from || !p.today || !p.tomorrow || !p.backlog || !p.quality || !p.team || !p.customers) return null;
  return {
    ...p,
    backlog: { ...p.backlog, ages: p.backlog.ages ?? [], old_reasons: p.backlog.old_reasons ?? [] },
    customers: { ...p.customers, top: p.customers.top ?? [] },
    finance: normalizeFinance(p.finance),
    quotes: normalizeQuotes(p.quotes),
    weeks: Array.isArray(p.weeks) ? p.weeks : [],
  };
}

/** Listas sempre presentes, mesmo que a API omita alguma; focus e pulse null com a API antiga. */
function normalize(data: Partial<HomeOverview>): HomeData {
  const k = data.kpis;
  const focus = data.focus;
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
    attention: Array.isArray(data.attention)
      ? data.attention
          .filter((g) => g && g.count > 0)
          .map((g) => ({ ...g, items: g.items ?? [], tier: g.tier === "now" ? ("now" as const) : ("routine" as const) }))
      : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    week: Array.isArray(data.week) ? data.week : [],
    focus: focus && typeof focus.total === "number" ? { total: focus.total, next_visit_at: focus.next_visit_at ?? null } : null,
    pulse: normalizePulse(data.pulse),
  };
}

/** A API em uso ainda não tem o resumo do Início (rota inexistente). */
const routeMissing = (error: unknown) => error instanceof ApiError && error.status === 404 && error.detail === "Not Found";

const ATTENTION_ID = "pontos-de-atencao";

export default function HomePage() {
  const { user } = useAuth();
  const now = useNow(60_000);
  const stopped = useBackdropStopped();
  // O botão "Animação" só aparece quando o fundo pode animar: movimento permitido, tela de 768 px ou mais,
  // sem cores forçadas nem alto contraste (o fundo some) e sem economia de dados (fica estático).
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", true);
  const narrow = useMediaQuery("(max-width: 767.98px)", true);
  const forcedColors = useMediaQuery("(forced-colors: active)", true);
  const moreContrast = useMediaQuery("(prefers-contrast: more)", true);
  const saveData = useSaveData(true);
  const canAnimate = !reducedMotion && !narrow && !forcedColors && !moreContrast && !saveData;
  // Na chave "dashboard": o tempo real (eventos das OS) e o fechar do painel da OS já releem.
  const overview = useQuery({
    queryKey: ["dashboard", "home"],
    queryFn: async ({ signal }) => normalize(await api.get<Partial<HomeOverview>>("/home/overview", undefined, { signal })),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: (count, error) => !routeMissing(error) && count < 2,
  });
  const data = overview.data;
  const pulse = data?.pulse ?? null;
  const failed = Boolean(overview.error) && !data;
  const firstName = (user?.name ?? "").trim().split(/\s+/)[0];

  // Releu (tempo real, a cada minuto, "Atualizar"): avisa o fundo. A 1ª carga não conta.
  const lastUpdate = useRef(0);
  useEffect(() => {
    const at = overview.dataUpdatedAt;
    if (!at) return;
    if (lastUpdate.current && at !== lastUpdate.current) window.dispatchEvent(new Event(DATA_EVENT));
    lastUpdate.current = at;
  }, [overview.dataUpdatedAt]);

  const vital = (index: number, card: React.ReactNode, className?: string) => (
    <div className={className} style={{ ["--i" as string]: index }}>
      {card}
    </div>
  );
  // Carregando, todos os cartões; com os dados, Financeiro só com permissão e Orçamentos só se a API manda.
  const showFinance = !pulse || Boolean(pulse.finance);
  const showQuotes = !pulse || Boolean(pulse.quotes);
  // Com Orçamentos, 6 colunas a partir de 1100 px: Hoje, Fila e Atendimento na 1ª linha (2 cada), Orçamentos e
  // Financeiro na 2ª (3 cada). Em 2 colunas, o 5º cartão fica com a linha inteira. Sem Orçamentos (API
  // antiga), a grade de antes.
  const firstRow = showQuotes ? "@min-[1100px]:col-span-2" : undefined;

  return (
    // De ponta a ponta na folha (as margens negativas anulam o padding do main); "isolate" põe o fundo
    // entre a folha e os cartões.
    <div className="relative isolate -mx-4 -my-6 px-4 py-6 md:-mx-8 md:px-8 print:m-0 print:p-0">
      <HomeBackdrop paused={stopped} />
      <div className="@container mx-auto max-w-7xl">
        <PageHeader
          eyebrow={<span className="text-ink-muted">{longToday(now)}</span>}
          title="Início"
          description={`${greeting(now)}${firstName ? `, ${firstName}` : ""}.`}
          actions={
            <>
              <LivePill updatedAt={data?.generated_at ?? null} />
              {canAnimate ? <BackdropToggle stopped={stopped} /> : null}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void overview.refetch()}
                aria-busy={overview.isFetching || undefined}
                aria-label="Atualizar"
              >
                <RotateCw aria-hidden className={overview.isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
                <span className="hidden sm:inline">Atualizar</span>
              </Button>
            </>
          }
        />

        {failed ? (
          <ErrorBox
            title="Não foi possível carregar o resumo"
            message={
              routeMissing(overview.error) ? "O resumo do Início ainda não está disponível neste servidor." : errorMessage(overview.error)
            }
            onRetry={() => void overview.refetch()}
          />
        ) : !data || data.focus ? (
          <FocusHero focus={data?.focus ?? null} groups={data?.attention ?? []} />
        ) : null}
        {overview.error && data ? (
          <RefreshFailed
            at={overview.errorUpdatedAt}
            onRetry={() => void overview.refetch()}
            retrying={overview.isFetching}
            className="mt-3"
          />
        ) : null}

        {user ? (
          <div className="mt-5">
            <HomeSearch user={user} />
          </div>
        ) : null}

        {failed ? null : (
          <>
            {!data || pulse ? (
              <section
                aria-label="Como está a operação"
                className={clsx(
                  "stagger mt-6 grid grid-cols-1 gap-4 @min-[620px]:grid-cols-2",
                  showQuotes ? "@min-[1100px]:grid-cols-6" : showFinance ? "@min-[1100px]:grid-cols-4" : "@min-[1100px]:grid-cols-3",
                )}
              >
                {vital(0, <TodayCard today={pulse?.today ?? null} tomorrow={pulse?.tomorrow ?? null} />, firstRow)}
                {vital(1, <BacklogCard backlog={pulse?.backlog ?? null} />, firstRow)}
                {vital(2, <ServiceCard quality={pulse?.quality ?? null} windowFrom={pulse?.window_from ?? null} />, firstRow)}
                {showQuotes
                  ? vital(
                      3,
                      <QuotesCard quotes={pulse?.quotes ?? null} />,
                      showFinance ? "@min-[1100px]:col-span-3" : "@min-[1100px]:col-span-6",
                    )
                  : null}
                {showFinance
                  ? vital(
                      showQuotes ? 4 : 3,
                      <FinanceCard finance={pulse?.finance ?? null} />,
                      showQuotes ? "@min-[620px]:col-span-2 @min-[1100px]:col-span-3" : undefined,
                    )
                  : null}
              </section>
            ) : null}

            {/* grid-cols-1 (minmax(0, 1fr)) no celular: sem ela, a coluna cresce até o conteúdo mais largo
                (o gráfico, os títulos cortados) e a página rola para o lado. */}
            <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
              <section
                id={ATTENTION_ID}
                tabIndex={-1}
                aria-labelledby={`${ATTENTION_ID}-titulo`}
                className="scroll-mt-20 rounded-xl outline-none"
              >
                <SectionTitle
                  as="h2"
                  className="mb-3"
                  aside={
                    data && data.attention.length ? (
                      <span className="-mr-1 rounded bg-sheet px-1 text-xs text-ink-muted">
                        {data.attention.length} {data.attention.length === 1 ? "ponto" : "pontos"}
                      </span>
                    ) : null
                  }
                >
                  <span id={`${ATTENTION_ID}-titulo`}>Pontos de atenção</span>
                </SectionTitle>
                <AttentionList
                  groups={data?.attention ?? null}
                  now={now}
                  focusTotal={data?.focus?.total ?? null}
                  backlog={pulse?.backlog ?? null}
                  windowFrom={pulse?.window_from ?? null}
                />
              </section>

              <aside className="flex flex-col gap-4" aria-label="Sugestões e últimos 30 dias">
                <SuggestionsCard suggestions={data?.suggestions ?? null} />
                <TrendCard week={data?.week ?? null} weeks={pulse?.weeks ?? null} today={dayKey(now)} />
                {!data || pulse ? (
                  <>
                    <CustomersCard customers={pulse?.customers ?? null} operationOnTime={pulse?.quality.on_time ?? null} />
                    <TeamCard team={pulse?.team ?? null} />
                  </>
                ) : null}
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
