"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowDown,
  BadgeCheck,
  Check,
  Download,
  Eye,
  FileSpreadsheet,
  HardHat,
  Loader2,
  MessageCircle,
  Phone,
  Plus,
  Search,
  SquarePen,
  Star,
  Upload,
  UserPlus,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { Tabs } from "@/components/motion";
import { type ComboItem, Combobox, searchText } from "@/components/new-ticket/Combobox";
import { NoAccess } from "@/components/NoAccess";
import { isUuid, replaceSearch, useSearchChange } from "@/components/operacao/hooks";
import { FavoritesView } from "@/components/technicians/FavoritesView";
import { TempPasswordPanel } from "@/components/technicians/GrantAccessDialog";
import { InviteDialog } from "@/components/technicians/InviteDialog";
import { LevelBadge, LevelMedal } from "@/components/technicians/LevelBadge";
import { NearbyFinder } from "@/components/technicians/NearbyFinder";
import { refreshTechnicianViews } from "@/components/technicians/refresh";
import { TechAvatar } from "@/components/technicians/TechAvatar";
import { TechnicianLink } from "@/components/technicians/TechnicianLink";
import { useToast } from "@/components/Toaster";
import {
  Button,
  buttonClassName,
  Card,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Pill,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import {
  APP_ACCESS,
  DAY_PERIOD,
  DAY_PERIOD_ORDER,
  LEVEL_TIER,
  LEVEL_TIER_ORDER,
  OPERATIONAL_STATUS,
  periodShort,
  periodText,
  ratingText,
  SKILL_LEVEL,
  slotsText,
  TRANSPORT_MODE,
  TRANSPORT_MODE_ORDER,
  unavailableOn,
  WEEKDAY,
  WEEKDAY_ORDER,
} from "@/lib/constants";
import { certificationDueRowText, certificationDueState } from "@/lib/documents";
import { downloadCsv } from "@/lib/download";
import { dayKey, formatDate, formatRelative } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { maskPhone, UFS } from "@/lib/onboarding";
import { useCan } from "@/lib/permissions";
import { useFavorites, useTeams, useTechCatalog } from "@/lib/queries";
import {
  certificationCsvText,
  type CityOption,
  cityOptionKey,
  favoriteCitiesMap,
  GAPS,
  LIST_STATUSES,
  listFacets,
  matchesList,
  namesText,
  TECH_CSV_HEADER,
} from "@/lib/techListFilter";
import { isPreGestao } from "@/lib/techProfileEdit";
import {
  cityParam,
  clearedListQuery,
  hasListFilter,
  hasStateSuffix,
  listQueryFrom,
  listQueryPatch,
  OPERATIONAL_STATUS_COLOR,
  operationalRank,
  type TechListQuery,
  technicianHref,
} from "@/lib/technicians";
import type {
  DayPeriod,
  ImportResult,
  LevelTier,
  OperationalStatus,
  TechCatalogItem,
  Technician,
  TechnicianRegion,
  TemporaryPassword,
  Weekday,
} from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";

/** Abas da tela; a de favoritos (e a dos mais próximos) fica na URL: ?aba=favoritos&uf=SP&cidade=Santos-SP. */
type View = "list" | "favorites" | "nearby";
const VIEW_PARAM: Record<View, string | null> = { list: null, favorites: "favoritos", nearby: "proximos" };
const viewOf = (aba: string | null): View => (aba === "favoritos" ? "favorites" : aba === "proximos" ? "nearby" : "list");

// A lista abre com as primeiras linhas; o resto vem no "Mostrar mais" (a base passa de mil técnicos).
const PAGE = 150;
// Quantos técnicos a tela pede de uma vez: só a busca vai ao servidor; os filtros e as contagens correm na tela sobre a
// lista inteira. Ao chegar nele, a lista avisa que há mais.
const API_LIMIT = 5000;

/** A lista com os filtros, para o "← Técnicos" da ficha voltar a ela (a ficha lê). */
const LIST_URL_KEY = "mf-tecnicos-lista";
/** Quantas linhas o "Mostrar mais" abriu nesta lista ({ key, count }): voltar da ficha não fecha de novo. */
const SHOWN_KEY = "mf-tecnicos-mostrar";

/** Cor do selo "Indisponível" (a mesma da ficha). */
const UNAVAILABLE_COLOR = "#d97706";
/** O selo da certificação na linha: vencida em vermelho, vencendo em âmbar. */
const CERTIFICATION_COLOR = { expired: "#dc2626", soon: "#d97706" } as const;
const CERTIFICATION_HINT = "Vencidas ou vencendo em até 30 dias";

/** Filtro rápido do elo (sobre a lista carregada): uma faixa ou quem está em risco de descer. */
type LevelFilter = LevelTier | "at_risk";
/** As faixas nos chips do filtro, da mais alta à mais baixa. */
const LEVEL_CHIPS = [...LEVEL_TIER_ORDER].reverse();
const AT_RISK_HINT = "Abaixo do critério: desce se não voltar a cumprir em 30 dias";

/** Posição da faixa para ordenar; sem o elo na resposta, por último. */
const levelRank = (t: Technician) => (t.level ? LEVEL_TIER_ORDER.indexOf(t.level.tier) : -1);
const byName = new Intl.Collator("pt-BR", { sensitivity: "base" }).compare;

function regionText(city: string | null | undefined, state: string | null | undefined): string {
  return [city, state].filter(Boolean).join("-");
}

const sameQuery = (a: TechListQuery, b: TechListQuery) =>
  JSON.stringify(listQueryPatch(a)) === JSON.stringify(listQueryPatch(b));

/** Os itens de um catálogo no filtro (os ativos, em ordem alfabética), com a contagem. */
function catalogItems(items: readonly TechCatalogItem[] | undefined, counts: Record<string, number>) {
  return (items ?? []).map(
    (item): ComboItem<{ id: string; name: string; count: number }> => ({
      key: item.id,
      item: { id: item.id, name: item.name, count: counts[item.id] ?? 0 },
      label: item.name,
      haystack: searchText(item.name),
    }),
  );
}

/** Uma opção com a contagem à direita (Cidade, Área, Aptidão e Ferramenta). */
function CountedOption({ label, count }: { label: string; count: number }) {
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-xs text-ink-muted tabular-nums">{count.toLocaleString("pt-BR")}</span>
    </span>
  );
}

/** As linhas que o "Mostrar mais" já tinha aberto nesta mesma lista (a volta da ficha); sem nada guardado, PAGE. */
function storedCount(key: string): number {
  try {
    const raw = window.sessionStorage.getItem(SHOWN_KEY);
    const saved = raw ? (JSON.parse(raw) as { key?: unknown; count?: unknown }) : null;
    if (saved?.key === key && typeof saved.count === "number" && saved.count > PAGE) return saved.count;
  } catch {
    // Sem storage (ou valor estragado): a lista abre com as primeiras linhas.
  }
  return PAGE;
}

/** Chip de filtro rápido (Cadastro incompleto, Elo): o marcado fica com a borda da marca. */
function chipClass(on: boolean) {
  return clsx(
    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
    on ? "border-brand bg-nav-active text-ink" : "border-line bg-surface text-ink-muted hover:text-ink",
  );
}

/** Cabeçalho de coluna que ordena a lista (de novo, volta à ordem padrão). */
function SortHeader({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? "Voltar à ordem padrão" : title}
      className="inline-flex items-center gap-1 rounded uppercase hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
    >
      {children}
      <ArrowDown className={clsx("size-3", active ? "text-ink" : "opacity-40")} />
    </button>
  );
}

export default function TechniciansPage() {
  // Os filtros chegam pela URL (?q= do "Ver na base técnica" da Homologação, ?ferramenta= de Configurações › Técnicos).
  return (
    <Suspense fallback={<LoadingBlock />}>
      <TechniciansView />
    </Suspense>
  );
}

function TechniciansView() {
  // Visualizar: a base, os favoritos e os mais próximos (a ficha abre para consulta). Editar: cadastrar e importar (o
  // resto fica na ficha do técnico). Convidar segue a Homologação (Editar lá).
  const canView = useCan("base.technicians");
  const canEdit = useCan("base.technicians", "edit");
  const canOnboarding = useCan("base.onboarding");
  const canInvite = useCan("base.onboarding", "edit");
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const now = useNow(60_000);
  const today = dayKey(now);

  // Link de antes da ficha (?tecnico={id}: avisos antigos, favoritos): abre a ficha no lugar da lista, levando a OS
  // aberta no painel (?os=). Um id que não é de técnico só sai da URL.
  const linked = canView ? searchParams.get("tecnico") : null;
  const redirecting = isUuid(linked);
  useEffect(() => {
    if (linked === null) return;
    if (!isUuid(linked)) {
      replaceSearch({ tecnico: null });
      return;
    }
    const os = new URLSearchParams(window.location.search).get("os");
    const href = technicianHref(linked);
    router.replace(os ? `${href}?os=${encodeURIComponent(os)}` : href);
  }, [linked, router]);

  // Os filtros ficam na URL: recarregar, mandar o link e voltar da ficha mantêm a lista. A busca vai depois da pausa
  // na digitação (apagar vale na hora).
  const [filters, setFilters] = useState(() => listQueryFrom(searchParams));
  const [qInput, setQInput] = useState(filters.q);
  const typed = useDebounced(qInput.trim());
  const q = qInput.trim() ? typed : "";
  const { uf, cidade: city, situacao, grupo: teamId, acesso: active, dia: day, turno: period } = filters;
  const { area: areaId, aptidao: skillId, ferramenta: toolId, favorito: favoriteOnly, certificacao } = filters;
  const { incompleto: gap, elo: levelFilter, ordem: sort } = filters;
  const query: TechListQuery = useMemo(() => ({ ...filters, q }), [filters, q]);
  const [view, setView] = useState<View>(() => viewOf(searchParams.get("aba")));
  // A URL mudou com a tela aberta (o menu, Voltar, a aba Favoritos com a UF e a busca dela): a tela segue a URL. A volta
  // da própria gravação traz a busca que já está na tela; outra busca (o menu, um link) troca o que foi digitado.
  const urlChange = useSearchChange();
  if (urlChange) {
    const nextView = viewOf(urlChange.get("aba"));
    if (nextView !== view) setView(nextView);
    const next = listQueryFrom(urlChange);
    if (!sameQuery(next, filters)) setFilters(next);
    if (next.q.trim() !== q) setQInput(next.q);
  }
  useEffect(() => {
    if (!redirecting) replaceSearch({ q: q || null });
  }, [q, redirecting]);
  /**
   * Troca filtros: a tela na hora e a URL junto (todos os parâmetros da lista, sem entrada no histórico). Mudar a UF
   * tira a cidade de outra UF.
   */
  const update = (patch: Partial<TechListQuery>) => {
    const next = { ...query, ...patch };
    if (patch.uf && next.cidade?.state && next.cidade.state !== patch.uf) next.cidade = null;
    setFilters(next);
    replaceSearch(listQueryPatch(next));
  };

  // O endereço da lista (com os filtros e a aba) para o "← Técnicos" da ficha, sem a OS aberta no painel.
  const search = searchParams.toString();
  useEffect(() => {
    if (redirecting) return;
    const params = new URLSearchParams(search);
    params.delete("os");
    const text = params.toString();
    try {
      window.sessionStorage.setItem(LIST_URL_KEY, `/tecnicos${text ? `?${text}` : ""}`);
    } catch {
      // Sem storage: o "← Técnicos" da ficha abre a lista sem os filtros.
    }
  }, [search, redirecting]);

  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [inviting, setInviting] = useState(false);
  const teams = useTeams();
  // Os catálogos ativos de Configurações › Técnicos: as opções dos filtros e os nomes na planilha (a lista só traz os
  // ids). A API de antes da Gestão não tem áreas nem aptidões (404).
  const areas = useTechCatalog("areas", true);
  const skills = useTechCatalog("skills", true);
  const tools = useTechCatalog("tools", true);
  // Os favoritos por cidade (a consulta da aba Favoritos): a estrela da linha, o filtro e a planilha.
  const favorites = useFavorites();

  // Só a busca vai ao servidor; os filtros e as contagens correm na tela sobre a lista inteira.
  const list = useQuery({
    queryKey: ["technicians", "list", { q }],
    queryFn: ({ signal }) =>
      api.get<Technician[]>("/technicians", { q: q || undefined, limit: API_LIMIT }, { signal }),
    placeholderData: (previous) => previous,
    // A lista é pesada (a base inteira com os serviços): não recarrega a cada volta para a aba.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    // Só a aba da lista busca.
    enabled: canView && view === "list" && !redirecting,
  });
  // Estados e cidades onde a base técnica está (pela região de atuação): só a aba Mais próximos usa.
  const regions = useQuery({
    queryKey: ["technicians", "regions", active],
    queryFn: () => api.get<TechnicianRegion[]>("/technicians/regions", { active: active || undefined }),
    staleTime: 60_000,
    enabled: canView && view === "nearby" && !redirecting,
  });

  const all = useMemo(() => list.data ?? [], [list.data]);
  // A API de antes da Gestão não manda as áreas (nem as aptidões do catálogo e o vencimento): os filtros delas somem.
  const gestao = !!list.data && !list.data.some(isPreGestao);
  const favoriteMap = useMemo(() => favoriteCitiesMap(favorites.data), [favorites.data]);
  const facets = useMemo(() => listFacets(all, query, { favorites: favoriteMap }), [all, query, favoriteMap]);
  const rows = useMemo(() => {
    const ctx = { favorites: favoriteMap };
    const found = all.filter((t) => matchesList(t, query, ctx));
    // Pela última OS; pelo elo, da faixa mais alta para a mais baixa e, na mesma faixa, por nome; ou a padrão: Ativo
    // com acesso, Ativo sem acesso, Inativo e Bloqueado, cada grupo na ordem da API (o nome ou a busca).
    if (sort === "visit") return found.sort((a, b) => (b.last_visit_at ?? "").localeCompare(a.last_visit_at ?? ""));
    if (sort === "level") return found.sort((a, b) => levelRank(b) - levelRank(a) || byName(a.name, b.name));
    return found.sort((a, b) => operationalRank(a) - operationalRank(b));
  }, [all, query, favoriteMap, sort]);
  // Com "Favoritos" ligado, a lista espera a consulta dos favoritos (sem ela, ninguém passaria).
  const waitingFavorites = favoriteOnly && !favorites.data;
  // Quantas linhas mostrar; volta ao começo quando a lista muda (outro filtro). A volta da ficha reabre as mesmas.
  const listKey = JSON.stringify(listQueryPatch(query));
  const [shown, setShown] = useState(() => ({ key: listKey, count: storedCount(listKey) }));
  const shownCount = shown.key === listKey ? shown.count : PAGE;
  const showMore = () => {
    const next = { key: listKey, count: shownCount + PAGE };
    setShown(next);
    try {
      window.sessionStorage.setItem(SHOWN_KEY, JSON.stringify(next));
    } catch {
      // Sem storage: a volta da ficha mostra as primeiras linhas.
    }
  };
  const filtered = hasListFilter(query);
  const toggleSort = (next: "visit" | "level") => update({ ordem: sort === next ? "name" : next });

  // As opções dos filtros, cada uma com a contagem (as linhas ao escolhê-la). A escolhida que não está entre elas
  // (ninguém com ela agora, desativada depois do link) continua no filtro.
  const cityItems = useMemo(
    () =>
      facets.cities.map(
        (option): ComboItem<CityOption> => ({ key: option.key, item: option, label: option.label, haystack: searchText(option.label) }),
      ),
    [facets.cities],
  );
  const ufOptions = useMemo(() => {
    const states = Object.keys(facets.uf).sort();
    return uf && !states.includes(uf) ? [uf, ...states] : states;
  }, [facets.uf, uf]);
  const areaItems = useMemo(() => catalogItems(areas.data, facets.area), [areas.data, facets.area]);
  const skillItems = useMemo(() => catalogItems(skills.data, facets.aptidao), [skills.data, facets.aptidao]);
  const toolItems = useMemo(() => catalogItems(tools.data, facets.ferramenta), [tools.data, facets.ferramenta]);
  const areaNames = useMemo(() => new Map((areas.data ?? []).map((item) => [item.id, item.name])), [areas.data]);
  const toolNames = useMemo(() => new Map((tools.data ?? []).map((item) => [item.id, item.name])), [tools.data]);
  const levelCounts = facets.elo;

  // "Limpar filtros" apaga todos os filtros da URL (a aba e a ordem ficam).
  const clearFilters = () => {
    setQInput("");
    update(clearedListQuery(sort));
  };
  // A planilha espera o que dá nome aos ids (o ferramental e as áreas, quando alguém da lista tem) e os favoritos. Com
  // erro, avisa e busca de novo, sem baixar (a coluna em branco pareceria "nada marcado").
  const needTools = useMemo(() => rows.some((t) => (t.tool_ids?.length ?? 0) > 0), [rows]);
  const needAreas = useMemo(() => rows.some((t) => (t.area_ids?.length ?? 0) > 0), [rows]);
  const csvSources = [
    { need: needTools, query: tools, failed: "Não deu para carregar o ferramental" },
    { need: needAreas, query: areas, failed: "Não deu para carregar as áreas de atuação" },
    { need: true, query: favorites, failed: "Não deu para carregar os favoritos" },
  ].filter((source) => source.need && !source.query.data);
  const csvPending = csvSources.some((source) => !source.query.isError);
  // Sem CPF, RG, nascimento nem dados de recebimento: a planilha circula fora do sistema.
  const exportCsv = () => {
    if (csvSources.length) {
      const failed = csvSources.filter((source) => source.query.isError);
      if (failed.length) {
        toast({ title: failed[0].failed, tone: "error" });
        for (const source of failed) void source.query.refetch();
      }
      return;
    }
    downloadCsv("tecnicos.csv", [
      [...TECH_CSV_HEADER],
      ...rows.map((t) => {
        const transport = t.transport;
        const status = t.operational_status ?? "active";
        return [
          t.name,
          t.email,
          t.phone,
          t.team?.name,
          t.home_city,
          t.home_state,
          regionText(t.base_city, t.base_state),
          OPERATIONAL_STATUS[status],
          status === "active" ? "" : (t.operational_reason ?? ""),
          t.is_active ? APP_ACCESS.on : APP_ACCESS.off,
          // Vazio quando a API ainda não manda o campo.
          t.email_verified_at === undefined ? "" : t.email_verified_at ? "sim" : "não",
          t.payout_methods_count === undefined ? "" : t.payout_methods_count > 0 ? "sim" : "não",
          t.last_login_at ? formatDate(t.last_login_at) : "",
          t.last_visit_at ? formatDate(t.last_visit_at) : "",
          t.open_tickets,
          t.level ? LEVEL_TIER[t.level.tier].label : "",
          t.level?.at_risk ? "sim" : "",
          // Perfil técnico: vazio quando o técnico não informou a parte (ou a API ainda não manda).
          namesText(t.tool_ids, toolNames),
          slotsText(t.availability ?? []),
          transport
            ? TRANSPORT_MODE_ORDER.filter((mode) => transport.modes.includes(mode))
                .map((mode) => TRANSPORT_MODE[mode])
                .join(", ")
            : "",
          transport ? (transport.driver_license ? "sim" : "não") : "",
          (t.skills ?? []).map((skill) => `${skill.name} (${SKILL_LEVEL[skill.level] ?? skill.level})`).join("; "),
          namesText(t.area_ids, areaNames),
          (favoriteMap?.get(t.id) ?? []).join("; "),
          certificationCsvText(t.certification_due, today),
          t.rating_average === null || t.rating_average === undefined ? "" : ratingText(t.rating_average),
          t.rating_count ?? "",
          t.tech_profile_updated_at ? formatDate(t.tech_profile_updated_at) : "",
        ];
      }),
    ]);
  };
  // Trocar de aba: a URL acompanha (mantém o ?os= do painel); UF e cidade ficam para a outra aba. A busca da aba
  // Favoritos ("Santos-SP", ou o nome de um técnico) só vira a cidade da lista quando termina numa UF.
  const changeView = (next: View) => {
    setView(next);
    const patch: Record<string, string | null> = { aba: VIEW_PARAM[next] };
    if (next === "list") {
      const params = new URLSearchParams(window.location.search);
      const kept = hasStateSuffix(params.get("cidade")) ? listQueryFrom(params).cidade : null;
      patch.cidade = kept ? cityParam(kept.city, kept.state) : null;
      setFilters((current) => ({ ...current, cidade: kept }));
    }
    replaceSearch(patch);
  };
  // A linha abre a ficha: Ctrl/⌘+clique e o botão do meio, em outra aba. Arrastar para copiar um texto não abre nada.
  const openRow = (e: React.MouseEvent<HTMLTableRowElement>, t: Technician) => {
    // Só o clique na própria linha (não o que vem de uma janela aberta a partir dela).
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (window.getSelection()?.toString()) return;
    const href = technicianHref(t.id);
    if (e.ctrlKey || e.metaKey) window.open(href, "_blank", "noopener");
    else router.push(href);
  };

  if (!canView) return <NoAccess kind="module" item="base.technicians" />;
  if (redirecting) return <LoadingBlock />;

  return (
    <div>
      <PageHeader
        title="Técnicos"
        description="Base técnica: acesso ao app, contato, região, serviços e foto. Novos técnicos chegam pelo convite (homologação) ou são cadastrados aqui."
        actions={
          <>
            {canOnboarding ? (
              <Link href="/homologacao" className={buttonClassName()}>
                <BadgeCheck className="size-4" />
                Homologação
              </Link>
            ) : null}
            {canEdit ? (
              <Button onClick={() => setImporting(true)}>
                <Upload className="size-4" />
                Importar planilha
              </Button>
            ) : null}
            {canInvite ? (
              <Button onClick={() => setInviting(true)}>
                <UserPlus className="size-4" />
                Convidar técnico
              </Button>
            ) : null}
            {canEdit ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                Novo técnico
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          variant="segmented"
          items={[
            { key: "list" as const, label: "Base técnica" },
            // No celular, rótulos curtos: os três cabem na largura da tela.
            {
              key: "favorites" as const,
              label: (
                <>
                  <span className="sm:hidden">Favoritos</span>
                  <span className="hidden sm:inline">Favoritos por cidade</span>
                </>
              ),
            },
            {
              key: "nearby" as const,
              label: (
                <>
                  <span className="sm:hidden">Mais próximos</span>
                  <span className="hidden sm:inline">Mais próximos de uma loja</span>
                </>
              ),
            },
          ]}
          value={view}
          onChange={changeView}
          ariaLabel="Visão"
          idPrefix="tecnicos"
        />
        {view === "list" && list.data ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            {list.isPlaceholderData ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3.5 animate-spin" />
                Atualizando…
              </span>
            ) : null}
            <span className="tabular-nums">
              {rows.length.toLocaleString("pt-BR")} {rows.length === 1 ? "técnico" : "técnicos"}
            </span>
            {filtered ? (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                Limpar filtros
              </Button>
            ) : null}
            {rows.length && !waitingFavorites ? (
              <Button size="sm" variant="ghost" onClick={exportCsv} disabled={csvPending}>
                <Download className="size-3.5" />
                Exportar
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>

      {view === "nearby" ? (
        <div role="tabpanel" id="tecnicos-panel-nearby" aria-labelledby="tecnicos-tab-nearby">
          <NearbyFinder regions={regions.data} />
        </div>
      ) : view === "favorites" ? (
        <div role="tabpanel" id="tecnicos-panel-favorites" aria-labelledby="tecnicos-tab-favorites">
          <FavoritesView initialUf={searchParams.get("uf") ?? ""} initialCity={searchParams.get("cidade") ?? ""} />
        </div>
      ) : (
        <div role="tabpanel" id="tecnicos-panel-list" aria-labelledby="tecnicos-tab-list">
          <div className="mb-2 flex flex-wrap gap-2">
            <div className="relative w-full sm:w-auto sm:min-w-56 sm:flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
              <Input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Buscar por nome, e-mail ou telefone"
                className="pl-9"
                aria-label="Buscar técnico"
              />
            </div>
            <div className="w-full sm:w-60">
              <Combobox
                items={cityItems}
                value={city ? cityOptionKey(city) : ""}
                onChange={(option) => update({ cidade: option ? { city: option.city, state: option.state } : null })}
                renderItem={(option) => <CountedOption label={option.label} count={option.count} />}
                ariaLabel="Cidade"
                placeholder="Cidade"
                clearLabel="Limpar cidade"
                emptyText="Nenhuma cidade com este nome"
                valueLabel={city ? cityParam(city.city, city.state) : undefined}
                loading={list.isLoading}
              />
            </div>
            <div className="w-full sm:w-40">
              <Select value={uf} onChange={(e) => update({ uf: e.target.value })} aria-label="UF">
                <option value="">Todas as UFs</option>
                {ufOptions.map((s) => (
                  <option key={s} value={s}>
                    {`${s} (${(facets.uf[s] ?? 0).toLocaleString("pt-BR")})`}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-full sm:w-48">
              <Select
                value={situacao}
                onChange={(e) => update({ situacao: e.target.value as OperationalStatus | "" })}
                aria-label="Situação"
              >
                <option value="">Todas as situações</option>
                {LIST_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {`${OPERATIONAL_STATUS[s]} (${facets.situacao[s].toLocaleString("pt-BR")})`}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-full sm:w-44">
              <Select
                value={active}
                onChange={(e) => update({ acesso: e.target.value as TechListQuery["acesso"] })}
                aria-label="Acesso ao app"
              >
                <option value="">Todos os acessos</option>
                <option value="true">{`${APP_ACCESS.on} (${facets.acesso.true.toLocaleString("pt-BR")})`}</option>
                <option value="false">{`${APP_ACCESS.off} (${facets.acesso.false.toLocaleString("pt-BR")})`}</option>
              </Select>
            </div>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            {gestao || areaId ? (
              <div className="w-full sm:w-56">
                <Combobox
                  items={areaItems}
                  value={areaId}
                  onChange={(item) => update({ area: item?.id ?? "" })}
                  renderItem={(item) => <CountedOption label={item.name} count={item.count} />}
                  ariaLabel="Área de atuação"
                  placeholder="Área de atuação"
                  clearLabel="Limpar área"
                  emptyText="Nenhuma área com este nome"
                  valueLabel="Área escolhida"
                  loading={areas.isPending}
                />
              </div>
            ) : null}
            {gestao || skillId ? (
              <div className="w-full sm:w-56">
                <Combobox
                  items={skillItems}
                  value={skillId}
                  onChange={(item) => update({ aptidao: item?.id ?? "" })}
                  renderItem={(item) => <CountedOption label={item.name} count={item.count} />}
                  ariaLabel="Aptidão"
                  placeholder="Aptidão"
                  clearLabel="Limpar aptidão"
                  emptyText="Nenhuma aptidão com este nome"
                  valueLabel="Aptidão escolhida"
                  loading={skills.isPending}
                />
              </div>
            ) : null}
            <div className="w-full sm:w-56">
              <Combobox
                items={toolItems}
                value={toolId}
                onChange={(item) => update({ ferramenta: item?.id ?? "" })}
                renderItem={(item) => <CountedOption label={item.name} count={item.count} />}
                ariaLabel="Ferramenta"
                placeholder="Ferramenta"
                clearLabel="Limpar ferramenta"
                emptyText="Nenhuma ferramenta com este nome"
                valueLabel="Ferramenta escolhida"
                loading={tools.isPending}
              />
            </div>
            <div className="w-full sm:w-52">
              <Select value={teamId} onChange={(e) => update({ grupo: e.target.value })} aria-label="Grupo">
                <option value="">Todos os grupos</option>
                {teamId && teams.data && !teams.data.some((t) => t.id === teamId) ? (
                  <option value={teamId}>Grupo escolhido</option>
                ) : null}
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {`${t.name} (${(facets.grupo[t.id] ?? 0).toLocaleString("pt-BR")})`}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-full sm:w-48">
              <Select value={day} onChange={(e) => update({ dia: e.target.value as Weekday | "" })} aria-label="Disponível no dia">
                <option value="">Qualquer dia</option>
                {WEEKDAY_ORDER.map((d) => (
                  <option key={d} value={d}>
                    {`${WEEKDAY[d].label} (${facets.dia[d].toLocaleString("pt-BR")})`}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-full sm:w-52">
              <Select
                value={period}
                onChange={(e) => update({ turno: e.target.value as DayPeriod | "" })}
                aria-label="Disponível no turno"
              >
                <option value="">Qualquer turno</option>
                {DAY_PERIOD_ORDER.map((p) => (
                  <option key={p} value={p}>
                    {`${DAY_PERIOD[p].label}, ${DAY_PERIOD[p].hours} (${facets.turno[p].toLocaleString("pt-BR")})`}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {day || period ? <p className="-mt-1 mb-3 text-xs text-ink-muted">Só quem tem a disponibilidade informada.</p> : null}

          {facets.favorito > 0 ||
          favoriteOnly ||
          facets.certificacao > 0 ||
          certificacao ||
          GAPS.some((g) => facets.incompleto[g.key] > 0) ||
          gap ||
          levelCounts ||
          levelFilter ? (
            <div className="mb-4 flex flex-col gap-2">
              {facets.favorito > 0 || favoriteOnly || facets.certificacao > 0 || certificacao ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtros rápidos">
                  {facets.favorito > 0 || favoriteOnly ? (
                    <button
                      type="button"
                      aria-pressed={favoriteOnly}
                      title="Favorito em alguma cidade"
                      onClick={() => update({ favorito: !favoriteOnly })}
                      className={chipClass(favoriteOnly)}
                    >
                      <Star aria-hidden className="size-3.5 shrink-0 fill-current text-brand" />
                      Favoritos
                      <span className="font-semibold text-ink tabular-nums">{facets.favorito}</span>
                    </button>
                  ) : null}
                  {facets.certificacao > 0 || certificacao ? (
                    <button
                      type="button"
                      aria-pressed={!!certificacao}
                      title={CERTIFICATION_HINT}
                      onClick={() => update({ certificacao: certificacao ? "" : "vencendo" })}
                      className={chipClass(!!certificacao)}
                    >
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" />
                      Certificação vencendo
                      <span className="font-semibold text-ink tabular-nums">{facets.certificacao}</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
              {GAPS.some((g) => facets.incompleto[g.key] > 0) || gap ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Cadastros incompletos">
                  <span className="text-xs font-semibold text-ink/80">Cadastro incompleto:</span>
                  {GAPS.filter((g) => facets.incompleto[g.key] > 0 || gap === g.key).map((g) => (
                    <button
                      key={g.key}
                      type="button"
                      aria-pressed={gap === g.key}
                      title={g.hint}
                      onClick={() => update({ incompleto: gap === g.key ? "" : g.key })}
                      className={chipClass(gap === g.key)}
                    >
                      {g.label}
                      <span className="font-semibold text-ink tabular-nums">{facets.incompleto[g.key]}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {/* Elo: as quatro faixas sempre (a distribuição da base), a vazia sem clique; "Em risco" só com alguém. */}
              {levelCounts || levelFilter ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Elo">
                  <span className="text-xs font-semibold text-ink/80">Elo:</span>
                  {LEVEL_CHIPS.map((tier) => {
                    const count = levelCounts?.[tier] ?? 0;
                    const on = levelFilter === tier;
                    return (
                      <button
                        key={tier}
                        type="button"
                        aria-pressed={on}
                        disabled={!count && !on}
                        onClick={() => update({ elo: on ? "" : tier })}
                        className={clsx(chipClass(on), "disabled:pointer-events-none disabled:opacity-50")}
                      >
                        <LevelMedal tier={tier} size={14} />
                        {LEVEL_TIER[tier].label}
                        <span className="font-semibold text-ink tabular-nums">{count}</span>
                      </button>
                    );
                  })}
                  {(levelCounts?.at_risk ?? 0) > 0 || levelFilter === "at_risk" ? (
                    <button
                      type="button"
                      aria-pressed={levelFilter === "at_risk"}
                      title={AT_RISK_HINT}
                      onClick={() => update({ elo: levelFilter === "at_risk" ? "" : "at_risk" })}
                      className={chipClass(levelFilter === "at_risk")}
                    >
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" />
                      Em risco
                      <span className="font-semibold text-ink tabular-nums">{levelCounts?.at_risk ?? 0}</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Sem celular o WhatsApp abre sem o número. A planilha exportada volta pela importação, que acha
              cada técnico pelo e-mail e grava o celular preenchido (o resto da planilha vem igual ao cadastro). */}
          {gap === "phone" && canEdit && rows.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5 text-xs text-ink-muted shadow-elev-1">
              <p className="min-w-0 flex-1 basis-64">
                Para preencher de uma vez: exporte esta lista, preencha a coluna{" "}
                <strong className="font-semibold text-ink">celular</strong> e importe a planilha. O e-mail identifica cada
                técnico e nada muda antes da prévia.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={exportCsv} disabled={tools.isPending}>
                  <Download className="size-3.5" />
                  Exportar
                </Button>
                <Button size="sm" onClick={() => setImporting(true)}>
                  <Upload className="size-3.5" />
                  Importar planilha
                </Button>
              </div>
            </div>
          ) : null}

          <Card className={clsx("transition-opacity", list.isPlaceholderData && "opacity-70")}>
            {list.isLoading ? (
              <LoadingBlock />
            ) : list.error ? (
              <div className="p-4">
                <ErrorBox message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
              </div>
            ) : waitingFavorites ? (
              favorites.isError ? (
                <div className="p-4">
                  <ErrorBox message="Não deu para carregar os favoritos." onRetry={() => void favorites.refetch()} />
                </div>
              ) : (
                <LoadingBlock label="Carregando os favoritos..." />
              )
            ) : rows.length === 0 ? (
              filtered ? (
                <EmptyState
                  icon={<HardHat className="size-6" />}
                  title="Nenhum técnico com estes filtros"
                  action={<Button onClick={clearFilters}>Limpar filtros</Button>}
                />
              ) : (
                <EmptyState
                  icon={<HardHat className="size-6" />}
                  title="Nenhum técnico na base"
                  description={
                    canInvite && canEdit
                      ? "Convide pelo WhatsApp, cadastre aqui ou importe a sua base em planilha."
                      : canEdit
                        ? "Cadastre aqui ou importe a sua base em planilha."
                        : canInvite
                          ? "Convide pelo WhatsApp: a ficha chega na Homologação."
                          : undefined
                  }
                  action={
                    canInvite ? (
                      <Button variant="primary" onClick={() => setInviting(true)}>
                        <UserPlus className="size-4" />
                        Convidar técnico
                      </Button>
                    ) : undefined
                  }
                />
              )
            ) : (
              <>
                {(list.data?.length ?? 0) >= API_LIMIT ? (
                  <p className="border-b border-line px-4 py-2.5 text-xs text-ink-muted">
                    Mostrando os primeiros {API_LIMIT.toLocaleString("pt-BR")} técnicos (por nome): use a busca para achar os
                    demais.
                  </p>
                ) : null}
                <Table>
                  <thead>
                    <tr>
                      <Th>Técnico</Th>
                      <Th className="hidden sm:table-cell">
                        <SortHeader active={sort === "level"} onClick={() => toggleSort("level")} title="Ordenar pelo elo">
                          Elo
                        </SortHeader>
                      </Th>
                      <Th className="hidden md:table-cell">Grupo</Th>
                      <Th className="hidden lg:table-cell">Região de atuação</Th>
                      <Th className="hidden lg:table-cell">Celular</Th>
                      <Th>App</Th>
                      <Th className="hidden xl:table-cell">
                        <SortHeader active={sort === "visit"} onClick={() => toggleSort("visit")} title="Ordenar pela última OS">
                          Última OS
                        </SortHeader>
                      </Th>
                      <Th className="hidden sm:table-cell">OS abertas</Th>
                      <Th className="edit-col">{canEdit ? "Editar" : "Ver"}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, shownCount).map((t) => {
                      const status = t.operational_status ?? "active";
                      const away = unavailableOn(t.unavailability, today);
                      return (
                        <tr
                          key={t.id}
                          className="cursor-pointer transition-colors hover:bg-[var(--row-hover)]"
                          onClick={(e) => openRow(e, t)}
                          onMouseDown={(e) => {
                            // Botão do meio fora de um link: sem a rolagem automática do navegador.
                            if (e.button === 1 && !(e.target as Element).closest("a")) e.preventDefault();
                          }}
                          onAuxClick={(e) => {
                            // Botão do meio num link já abre a aba sozinho.
                            if (e.button !== 1 || !e.currentTarget.contains(e.target as Node) || (e.target as Element).closest("a")) {
                              return;
                            }
                            e.preventDefault();
                            window.open(technicianHref(t.id), "_blank", "noopener");
                          }}
                        >
                          <Td>
                            <span className="flex items-center gap-2.5">
                              <TechAvatar tech={t} />
                              <span className="min-w-0">
                                <TechnicianLink
                                  id={t.id}
                                  className="block truncate rounded font-semibold text-ink underline-offset-2 hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                                >
                                  {t.name}
                                </TechnicianLink>
                                <span className="block truncate text-xs text-ink-muted">{t.email}</span>
                                {status !== "active" || away ? (
                                  <span className="mt-1 flex flex-wrap gap-1">
                                    {status !== "active" ? (
                                      <span title={t.operational_reason ?? undefined} className="inline-flex">
                                        <Pill color={OPERATIONAL_STATUS_COLOR[status]}>{OPERATIONAL_STATUS[status]}</Pill>
                                      </span>
                                    ) : null}
                                    {away ? (
                                      <span title={periodText(away)} className="inline-flex">
                                        <Pill color={UNAVAILABLE_COLOR}>Indisponível {periodShort(away, today)}</Pill>
                                      </span>
                                    ) : null}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          </Td>
                          <Td className="hidden sm:table-cell">
                            {t.level ? (
                              <span className="flex flex-col items-start gap-0.5">
                                <LevelBadge tier={t.level.tier} size="sm" />
                                {t.level.at_risk ? (
                                  <span className="text-xs text-amber-800 dark:text-amber-300" title={AT_RISK_HINT}>
                                    em risco
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-ink-muted">—</span>
                            )}
                          </Td>
                          <Td className="hidden md:table-cell">{t.team?.name ?? <span className="text-ink-muted">—</span>}</Td>
                          <Td className="hidden lg:table-cell">
                            {t.base_city || t.home_city ? (
                              <span className="block">
                                <span className="whitespace-nowrap text-ink">
                                  {t.base_city ? regionText(t.base_city, t.base_state) : regionText(t.home_city, t.home_state)}
                                </span>
                                <span className="block text-xs text-ink-muted">
                                  {t.base_source === "history" ? `pelo histórico · ${t.base_visits ?? 0} OS` : "pelo endereço"}
                                </span>
                              </span>
                            ) : (
                              <span className="text-xs text-ink-muted">Sem região</span>
                            )}
                          </Td>
                          <Td className="hidden lg:table-cell">
                            {t.phone ? (
                              <span className="flex items-center gap-1">
                                <a
                                  href={whatsappUrl(t.phone, `Olá, ${t.name.trim().split(/\s+/)[0]}!`)}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-1 rounded text-ink underline-offset-2 hover:text-brand hover:underline"
                                  title={`Conversar com ${t.name} no WhatsApp`}
                                >
                                  <MessageCircle className="size-3.5 shrink-0 text-ink-muted" />
                                  <span className="whitespace-nowrap">{t.phone}</span>
                                </a>
                                <a
                                  href={`tel:${t.phone.replace(/[^\d+]/g, "")}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="rounded p-1 text-ink-muted hover:text-ink"
                                  aria-label={`Ligar para ${t.name}`}
                                  title="Ligar"
                                >
                                  <Phone className="size-3.5" />
                                </a>
                              </span>
                            ) : (
                              <span className="text-ink-muted">—</span>
                            )}
                          </Td>
                          <Td>
                            <AppStatus tech={t} now={now} />
                          </Td>
                          <Td className="hidden text-xs whitespace-nowrap text-ink-muted xl:table-cell">
                            {t.last_visit_at ? formatDate(t.last_visit_at) : "—"}
                          </Td>
                          <Td className="hidden tabular-nums sm:table-cell">
                            {t.open_tickets ? (
                              <Link
                                href={`/chamados?assignee_id=${t.id}&open_only=true`}
                                onClick={(e) => e.stopPropagation()}
                                className="font-medium text-ink underline-offset-2 hover:text-brand hover:underline"
                                title={`OS abertas de ${t.name}`}
                              >
                                {t.open_tickets}
                              </Link>
                            ) : (
                              <span className="text-ink-muted">0</span>
                            )}
                          </Td>
                          <Td className="edit-col">
                            <TechnicianLink
                              id={t.id}
                              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1 transition-[border-color,background-color] duration-150 hover:border-brand/40 hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                              label={`${canEdit ? "Editar" : "Ver"} ${t.name}`}
                              title={`${canEdit ? "Editar" : "Ver"} ${t.name}`}
                            >
                              {canEdit ? <SquarePen className="size-4" /> : <Eye className="size-4" />}
                            </TechnicianLink>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
                {rows.length > shownCount ? (
                  <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-xs text-ink-muted">
                    <span className="tabular-nums">
                      Mostrando {shownCount} de {rows.length}
                    </span>
                    <Button size="sm" onClick={showMore}>
                      Mostrar mais
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
        </div>
      )}

      {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
      {inviting ? <InviteDialog onClose={() => setInviting(false)} /> : null}
    </div>
  );
}

function AppStatus({ tech, now }: { tech: Technician; now: number }) {
  // "Em jornada" leva ao Mapa ao vivo: sem acesso a ele, fica só como texto.
  const canMap = useCan("operation.map");
  if (!tech.is_active) {
    return (
      <span className="inline-flex rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ink-muted">
        {APP_ACCESS.off}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      {tech.on_shift && canMap ? (
        <Link
          href={`/mapa?tecnico=${tech.id}`}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 font-medium text-ink underline-offset-2 hover:text-brand hover:underline"
          title={`Ver ${tech.name} no mapa ao vivo`}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-emerald-600" />
          Em jornada
        </Link>
      ) : tech.on_shift ? (
        <span className="inline-flex items-center gap-1 font-medium text-ink">
          <span aria-hidden className="size-1.5 rounded-full bg-emerald-600" />
          Em jornada
        </span>
      ) : null}
      {tech.must_change_password ? (
        <span className="text-amber-800 dark:text-amber-300">Senha provisória</span>
      ) : null}
      {tech.last_login_at && !tech.location_consent_at ? (
        <span className="text-amber-800 dark:text-amber-300" title="Sem o aceite, o app não inicia a jornada">
          GPS não autorizado
        </span>
      ) : null}
      <span className="text-ink-muted">
        {tech.last_login_at ? `Acesso ${formatRelative(tech.last_login_at, now)}` : "Nunca acessou"}
      </span>
    </span>
  );
}

interface TechnicianForm {
  name: string;
  email: string;
  phone: string;
  team_id: string;
  job_title: string;
  home_city: string;
  home_state: string;
  coverage_area: string;
}

/** Confere antes de enviar (a API responderia em inglês). */
function validateTechnician(v: TechnicianForm): string | null {
  if (v.name.trim().length < 3) return "Informe o nome do técnico (pelo menos 3 letras).";
  if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) return "Informe um e-mail válido: é o login do técnico no app.";
  const phone = v.phone.replace(/\D/g, "");
  if (phone && phone.length < 10) return "Informe o celular com DDD.";
  return null;
}

/** O cadastro direto (Novo técnico); o resto (endereço, dados pessoais, jornada) fica na ficha. */
function TechnicianFields({ value, onChange }: { value: TechnicianForm; onChange: (v: TechnicianForm) => void }) {
  const teams = useTeams();
  const set = (k: keyof TechnicianForm, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Nome" required className="sm:col-span-2">
        <Input value={value.name} onChange={(e) => set("name", e.target.value)} maxLength={160} autoComplete="off" />
      </Field>
      <Field label="E-mail (login no app)" required>
        <Input type="email" value={value.email} onChange={(e) => set("email", e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Celular (WhatsApp)">
        <Input
          value={value.phone}
          onChange={(e) => set("phone", maskPhone(e.target.value))}
          inputMode="tel"
          placeholder="(11) 90000-0000"
          autoComplete="off"
        />
      </Field>
      <Field label="Grupo técnico">
        <Select value={value.team_id} onChange={(e) => set("team_id", e.target.value)}>
          <option value="">Sem grupo</option>
          {(teams.data ?? [])
            .filter((t) => t.is_active || t.id === value.team_id)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Cargo">
        <Input value={value.job_title} onChange={(e) => set("job_title", e.target.value)} maxLength={120} />
      </Field>
      <div className="grid grid-cols-[1fr_6rem] gap-4 sm:col-span-2">
        <Field label="Cidade onde mora">
          <Input value={value.home_city} onChange={(e) => set("home_city", e.target.value)} maxLength={120} />
        </Field>
        <Field label="UF">
          <Select value={value.home_state} onChange={(e) => set("home_state", e.target.value)}>
            <option value="">—</option>
            {(UFS.includes(value.home_state) || !value.home_state ? UFS : [value.home_state, ...UFS]).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Região que atende" className="sm:col-span-2">
        <Input value={value.coverage_area} onChange={(e) => set("coverage_area", e.target.value)} maxLength={1000} />
      </Field>
    </div>
  );
}

const EMPTY_TECHNICIAN: TechnicianForm = {
  name: "",
  email: "",
  phone: "",
  team_id: "",
  job_title: "Técnico de campo",
  home_city: "",
  home_state: "",
  coverage_area: "",
};

function CreateDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<TechnicianForm>(EMPTY_TECHNICIAN);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<TemporaryPassword>("/technicians", {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone || null,
        team_id: form.team_id || null,
        job_title: form.job_title || null,
        home_city: form.home_city || null,
        home_state: form.home_state || null,
        coverage_area: form.coverage_area || null,
      }),
    onSuccess: () => refreshTechnicianViews(queryClient),
  });
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      busy={create.isPending}
      // Fechar sem cadastrar pergunta antes de descartar o que foi digitado.
      dirty={!create.data && JSON.stringify(form) !== JSON.stringify(EMPTY_TECHNICIAN)}
      title="Novo técnico"
      description="Cadastro direto, sem ficha de homologação. O técnico recebe uma senha provisória."
      footer={
        create.data ? (
          <>
            {/* O resto do cadastro (endereço, dados pessoais, jornada e serviços) fica na ficha. */}
            <Link href={technicianHref(create.data.technician.id)} className={buttonClassName()}>
              Abrir ficha
            </Link>
            <Button variant="primary" onClick={onClose}>
              Concluir
            </Button>
          </>
        ) : (
          <>
            {/* Cadastrando: sair agora perderia a senha provisória da resposta. */}
            <Button onClick={onClose} disabled={create.isPending}>
              Cancelar
            </Button>
            <Button variant="primary" type="submit" form="tech-create-form" loading={create.isPending}>
              Cadastrar
            </Button>
          </>
        )
      }
    >
      {create.data ? (
        <TempPasswordPanel result={create.data} />
      ) : (
        <form
          id="tech-create-form"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const found = validateTechnician(form);
            setProblem(found);
            if (!found && !create.isPending) create.mutate();
          }}
        >
          <TechnicianFields value={form} onChange={setForm} />
          {/* O ErrorBox já é anunciado (role="alert"). */}
          {problem || create.error ? <ErrorBox message={problem ?? errorMessage(create.error)} /> : null}
        </form>
      )}
    </Dialog>
  );
}

const TEMPLATE: string[][] = [
  ["nome", "email", "telefone", "grupo", "cargo", "cidade", "uf", "regiao"],
  ["Maria Exemplo", "maria@exemplo.com.br", "(11) 90000-0000", "Campo - Infraestrutura", "Técnico de campo", "Santos", "SP", "Santos, São Vicente e Guarujá"],
];

function ImportDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [file, setFile] = useState<File | null>(null);
  // As senhas provisórias só aparecem uma vez: sair sem baixar obriga a redefinir uma a uma.
  const [downloaded, setDownloaded] = useState(false);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => {
      const body = new FormData();
      body.append("file", file as File);
      return api.upload<ImportResult>(`/technicians/import?dry_run=${dryRun}`, body);
    },
    onSuccess: (r) => {
      if (!r.dry_run) refreshTechnicianViews(queryClient);
    },
  });
  const result = run.data;
  const done = result && !result.dry_run;
  const requestClose = async () => {
    if (
      done &&
      result.credentials.length &&
      !downloaded &&
      !(await confirm({
        tone: "danger",
        title: "Sair sem baixar as senhas?",
        description: "As senhas provisórias não aparecem de novo: será preciso redefinir a senha de cada técnico novo.",
        confirmLabel: "Sair sem baixar",
        cancelLabel: "Voltar e baixar",
      }))
    ) {
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={requestClose}
      // Importando: fechar no meio perderia as senhas provisórias da resposta.
      busy={run.isPending}
      title="Importar técnicos"
      description="Planilha CSV ou Excel (XLSX) com nome, e-mail, telefone, grupo, cargo, cidade, UF e região."
      footer={
        done ? (
          <Button variant="primary" onClick={requestClose}>
            Concluir
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={run.isPending}>
              Cancelar
            </Button>
            {result?.dry_run ? (
              <Button
                variant="primary"
                loading={run.isPending}
                disabled={result.created + result.updated === 0}
                onClick={() => run.mutate(false)}
              >
                Importar {result.created + result.updated} técnico(s)
              </Button>
            ) : (
              <Button variant="primary" loading={run.isPending} disabled={!file} onClick={() => run.mutate(true)}>
                Ver prévia
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {!done ? (
          <div className="flex flex-wrap items-center gap-2">
            <label
              className={clsx(
                buttonClassName("secondary"),
                "max-w-full cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/45",
              )}
            >
              <FileSpreadsheet className="size-4 shrink-0" />
              <span className="truncate">{file ? file.name : "Escolher arquivo"}</span>
              <input
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  run.reset();
                }}
              />
            </label>
            <Button variant="ghost" onClick={() => downloadCsv("modelo-tecnicos.csv", TEMPLATE)}>
              <Download className="size-4" />
              Baixar modelo
            </Button>
          </div>
        ) : null}
        <p className="text-xs text-ink-muted">
          E-mail novo cria o técnico com senha provisória; e-mail de técnico já cadastrado atualiza nome, telefone, grupo,
          cargo, cidade, UF e região (a senha não muda). Nada é gravado antes de você confirmar a prévia.
        </p>

        {result ? (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Count label={result.dry_run ? "Serão criados" : "Criados"} value={result.created} />
              <Count label={result.dry_run ? "Serão atualizados" : "Atualizados"} value={result.updated} />
              <Count label="Com erro (ignorados)" value={result.errors} problem={result.errors > 0} />
            </div>
            {done && result.credentials.length ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-semibold">Baixe agora as senhas provisórias dos novos técnicos.</p>
                <p className="mt-0.5 text-xs">Por segurança, elas não aparecem de novo. Guarde o arquivo em local seguro e apague depois de enviar.</p>
                <Button
                  className="mt-2"
                  onClick={() => {
                    downloadCsv("senhas-provisorias-tecnicos.csv", [
                      ["nome", "email", "senha_provisoria"],
                      ...result.credentials.map((c) => [c.name, c.email, c.temporary_password]),
                    ]);
                    setDownloaded(true);
                  }}
                >
                  {downloaded ? <Check className="size-4" /> : <Download className="size-4" />}
                  {downloaded ? "Senhas baixadas" : `Baixar senhas (${result.credentials.length})`}
                </Button>
              </div>
            ) : null}
            <div className="max-h-72 overflow-auto rounded-lg border border-line">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface-2 text-ink-muted">
                  <tr>
                    <th className="px-2 py-1.5 font-semibold">Linha</th>
                    <th className="px-2 py-1.5 font-semibold">Técnico</th>
                    <th className="px-2 py-1.5 font-semibold">Grupo</th>
                    <th className="px-2 py-1.5 font-semibold">Resultado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.rows.map((r) => (
                    <tr key={r.line}>
                      <td className="px-2 py-1.5 tabular-nums text-ink-muted">{r.line}</td>
                      <td className="px-2 py-1.5">
                        <span className="block font-semibold text-ink">{r.name || "—"}</span>
                        <span className="text-ink-muted">{r.email}</span>
                      </td>
                      <td className="px-2 py-1.5 text-ink-muted">{r.team ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        {r.action === "error" ? (
                          <span className="text-red-700 dark:text-red-400">{r.errors.join(" · ")}</span>
                        ) : r.action === "create" ? (
                          <span className="font-medium text-ink">Novo</span>
                        ) : (
                          <span className="text-ink-muted">Atualizar</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {run.error ? <ErrorBox message={errorMessage(run.error)} /> : null}
      </div>
    </Dialog>
  );
}

/** Contador da prévia: neutro; vermelho só quando há erro. */
function Count({ label, value, problem = false }: { label: string; value: number; problem?: boolean }) {
  return (
    <span
      className={clsx(
        "rounded-lg px-3 py-1.5",
        problem ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300" : "bg-surface-2 text-ink",
      )}
    >
      {label}: <strong className="tabular-nums">{value}</strong>
    </span>
  );
}
