"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ChevronDown,
  Download,
  Info,
  KeyRound,
  Loader2,
  MapPin,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Search,
  Star,
  Undo2,
  UserPlus,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { ticketsListHref } from "@/components/home/links";
import { fold, replaceSearch, useSearchChange } from "@/components/operacao/hooks";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  SectionTitle,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { absoluteApiUrl, api, buildQuery, errorMessage } from "@/lib/api";
import { APP_ACCESS, OPERATIONAL_STATUS } from "@/lib/constants";
import { downloadCsv } from "@/lib/download";
import { formatDate, initials } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCan } from "@/lib/permissions";
import { useFavorites } from "@/lib/queries";
import type { FavoriteCity, FavoriteCityDetail, FavoritesOut, FavoriteTechnician, Technician, UUID } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";
import { OperationalPill } from "./ficha/OperationalPill";
import { GrantAccessDialog } from "./GrantAccessDialog";
import { TechnicianLink } from "./TechnicianLink";

/** Cartões por vez (o resto vem no "Mostrar mais"). */
const PAGE = 30;
/** Tamanho máximo da nota (o mesmo da API). */
export const NOTE_MAX = 300;

// Etiqueta neutra (Fixado, Sem acesso ao app, Em jornada).
const CHIP =
  "inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-ink-muted ring-1 ring-line ring-inset";
// Botão só com ícone, com o foco visível do sistema.
const ICON_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";
const ICON_BORDERED = "border border-line bg-surface text-ink-muted shadow-elev-1 hover:border-line-strong hover:text-ink";
const TEXT_LINK =
  "rounded text-ink underline-offset-2 hover:text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none";

/** Endereço da aba já filtrada na cidade (a OS e a ficha do técnico levam até ela). */
export function favoritesHref(state: string, city: string): string {
  // "Cidade-UF" na busca acha só a cidade (o nome solto também casaria com o sobrenome de um técnico).
  return `/tecnicos?${new URLSearchParams({ aba: "favoritos", uf: state, cidade: `${city}-${state}` }).toString()}`;
}

/** Filtros rápidos (um de cada vez): favoritos sem acesso ao app e cidades com OS e sem favorito. */
type Chip = "inactive" | "none";

/** Cidade de uma ação: a UF e o nome (a API acha a chave sem acento). */
export interface Place {
  state: string;
  city: string;
}

/** Fixar ou tirar da lista (PUT, com a nota) ou voltar a valer só a regra automática (null = DELETE). */
// hide: só no Desfazer de um tirado (grava tirado mesmo que ele já não esteja no top 3).
type Change = { favorite: boolean; note: string | null; hide?: boolean } | null;
export type { Change as FavoriteChange };

export interface FavoriteAction {
  tech: { id: UUID; name: string };
  place: Place;
  change: Change;
  /** Aviso depois de gravar, com o "Desfazer" (que volta ao estado de antes). */
  notice?: { title: string; undo: Change };
}

export const placeOf = (c: FavoriteCity): Place => ({ state: c.state, city: c.city });
export const placeLabel = (p: Place) => `${p.city}-${p.state}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0];
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
const pendingKey = (techId: UUID, place: Place) => `${techId}|${place.state}|${fold(place.city)}`;
export const detailKey = (state: string, key: string) => ["technician-favorites", "city", state, key] as const;

/** A janela da regra em texto: 365 dias são "12 meses". */
function windowText(days: number): string {
  const months = days % 365 === 0 ? (days / 365) * 12 : days % 30 === 0 ? days / 30 : null;
  if (months === null) return plural(days, "dia", "dias");
  return months === 1 ? "1 mês" : `${months} meses`;
}

/** A regra automática, com os números que a API usa (no title do ícone de informação). */
function ruleText(out: FavoritesOut): string {
  return (
    `Até ${out.top} por cidade: quem mais atendeu nas lojas da cidade nos últimos ${windowText(out.window_days)} ` +
    `(mínimo de ${out.min_visits} OS). Empate: quem tem acesso ao app, depois a visita mais recente. ` +
    "Tirar um automático abre a vaga para o próximo. Fixados valem até alguém tirar."
  );
}

/** Como voltar ao estado de antes: fixado (com a nota), tirado (com o motivo) ou só a regra (DELETE). */
export function undoOf(before: Pick<FavoriteTechnician, "pinned" | "hidden" | "note"> | null | undefined): Change {
  if (before?.pinned) return { favorite: true, note: before.note };
  if (before?.hidden) return { favorite: false, note: before.note, hide: true };
  return null;
}

/** "Automático", "Fixado" ou "Automático e fixado" (exportação). */
function originOf(t: FavoriteTechnician): string {
  if (t.automatic && t.pinned) return "Automático e fixado";
  return t.pinned ? "Fixado" : "Automático";
}

/** "5 OS · última em 10/11/2026", "Sem OS aqui em 12 meses"; com " · Base em X" se a base é outra cidade. */
function factsOf(t: FavoriteTechnician, city: FavoriteCity, windowLabel: string): string {
  const parts = [
    t.visits > 0
      ? `${t.visits} OS${t.last_visit_at ? ` · última em ${formatDate(t.last_visit_at)}` : ""}`
      : `Sem OS aqui em ${windowLabel}`,
  ];
  const elsewhere = t.base_city && (fold(t.base_city) !== fold(city.city) || (t.base_state ?? "").toUpperCase() !== city.state);
  if (elsewhere) parts.push(`Base em ${[t.base_city, t.base_state].filter(Boolean).join("-")}`);
  return parts.join(" · ");
}

/** "Fixado por {analista} em 12/11/2026" (quem fez a última mudança). */
function decisionTitle(verb: string, t: FavoriteTechnician): string {
  return [verb, t.set_by ? `por ${t.set_by.name}` : null, t.set_at ? `em ${formatDate(t.set_at)}` : null].filter(Boolean).join(" ");
}

/** PUT (fixar, tirar da lista, nota) ou DELETE (voltar à regra) de um técnico numa cidade; a API grava no histórico dele. */
export function sendFavorite(techId: UUID, place: Place, change: Change) {
  return change
    ? api.put<FavoriteCityDetail>(`/technicians/favorites/${techId}`, {
        state: place.state,
        city: place.city,
        favorite: change.favorite,
        note: change.note,
        ...(change.hide ? { hide: true } : {}),
      })
    : api.delete<FavoriteCityDetail>(`/technicians/favorites/${techId}${buildQuery({ state: place.state, city: place.city })}`);
}

/**
 * Depois de gravar: o cartão (e a seção Favoritos da ficha) muda na hora com a cidade que a API devolveu; a lista de um
 * técnico (a ficha) ganha ou perde a cidade conforme ele ficou favorito, tirado ou nada nela. A lista, a OS (estrela e
 * ordem do Colaborador), as sugestões, a estrela da lista de Técnicos e o histórico do cadastro releem.
 */
function applyDetail(queryClient: QueryClient, detail: FavoriteCityDetail) {
  queryClient.setQueryData(detailKey(detail.state, detail.key), detail);
  const same = (c: FavoriteCity) => c.state === detail.state && c.key === detail.key;
  for (const [key, out] of queryClient.getQueriesData<FavoritesOut>({ queryKey: ["technician-favorites", "list"] })) {
    if (!out) continue;
    const params = (key[2] ?? {}) as { state?: string; technicianId?: UUID };
    let cities = out.cities.map((c) => (same(c) ? detail : c));
    if (params.technicianId) {
      const id = params.technicianId;
      const listed = detail.favorites.some((f) => f.id === id) || detail.hidden.some((f) => f.id === id);
      if (!listed) cities = cities.filter((c) => !same(c));
      else if (!cities.some(same)) cities = [...cities, detail];
    }
    queryClient.setQueryData<FavoritesOut>(key, { ...out, cities });
  }
  void queryClient.invalidateQueries({ queryKey: ["technician-favorites"] });
  void queryClient.invalidateQueries({ queryKey: ["technician-suggest"] });
  void queryClient.invalidateQueries({ queryKey: ["technicians", "list"] });
  void queryClient.invalidateQueries({ queryKey: ["technicians", "changes"] });
}

/**
 * Estrela, Fixar e Voltar para a lista: gravam sem confirmação, com o botão da linha desabilitado
 * enquanto salva, e avisam com o "Desfazer". Cada linha mostra o próprio carregamento. Também na seção Favoritos da
 * ficha do técnico.
 */
export function useFavoriteActions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const begin = (a: FavoriteAction) => setPending((keys) => new Set(keys).add(pendingKey(a.tech.id, a.place)));
  const end = (a: FavoriteAction) =>
    setPending((keys) => {
      const next = new Set(keys);
      next.delete(pendingKey(a.tech.id, a.place));
      return next;
    });
  const failed = (error: unknown) => {
    void queryClient.invalidateQueries({ queryKey: ["technician-favorites"] });
    toast({ title: errorMessage(error), tone: "error" });
  };
  // O "Desfazer": volta ao estado de antes, sem outro aviso.
  const undo = useMutation({
    mutationFn: (a: FavoriteAction) => sendFavorite(a.tech.id, a.place, a.change),
    onMutate: begin,
    onSettled: (_data, _error, a) => end(a),
    onSuccess: (detail) => applyDetail(queryClient, detail),
    onError: failed,
  });
  const notify = (a: FavoriteAction) => {
    const notice = a.notice;
    if (!notice) return;
    toast({
      title: notice.title,
      tone: "success",
      action: { label: "Desfazer", onClick: () => undo.mutate({ tech: a.tech, place: a.place, change: notice.undo }) },
    });
  };
  const save = useMutation({
    mutationFn: (a: FavoriteAction) => sendFavorite(a.tech.id, a.place, a.change),
    onMutate: begin,
    onSettled: (_data, _error, a) => end(a),
    onSuccess: (detail, a) => {
      applyDetail(queryClient, detail);
      notify(a);
    },
    onError: failed,
  });
  return {
    act: (a: FavoriteAction) => {
      if (!pending.has(pendingKey(a.tech.id, a.place))) save.mutate(a);
    },
    isPending: (techId: UUID, place: Place) => pending.has(pendingKey(techId, place)),
    /** Gravado num diálogo (nota, Desafixar, Incluir): atualiza as telas e avisa. */
    done: (detail: FavoriteCityDetail, a: FavoriteAction) => {
      applyDetail(queryClient, detail);
      notify(a);
    },
  };
}

export type FavoriteActions = ReturnType<typeof useFavoriteActions>;

/** A cidade com os tirados da lista e os outros que atenderam (rodapé do cartão e "Incluir técnico"). */
export function useCityDetail(city: Pick<FavoriteCity, "state" | "city" | "key">, enabled: boolean) {
  return useQuery({
    queryKey: detailKey(city.state, city.key),
    queryFn: ({ signal }) =>
      api.get<FavoriteCityDetail>("/technicians/favorites/city", { state: city.state, city: city.city }, { signal }),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Técnicos favoritos por cidade: até 3 automáticos por cidade (quem mais atendeu nas lojas dela) e os
 * fixados pela central. A estrela tira ou põe, o alfinete fixa e o rodapé de cada cidade traz os
 * tirados e os outros que atenderam. UF e busca ficam na URL (?uf=&cidade=); o nome é o link da ficha.
 */
export function FavoritesView({ initialUf = "", initialCity = "" }: { initialUf?: string; initialCity?: string }) {
  const favorites = useFavorites();
  const actions = useFavoriteActions();
  // Favoritar, fixar, tirar da lista, incluir e liberar acesso gravam em Técnicos: só com Editar.
  const canEdit = useCan("base.technicians", "edit");
  const [uf, setUf] = useState(() => initialUf.trim().toUpperCase());
  const [qInput, setQInput] = useState(initialCity);
  const [chip, setChip] = useState<Chip | null>(null);
  const [including, setIncluding] = useState<FavoriteCity | null>(null);
  const [editing, setEditing] = useState<{ tech: FavoriteTechnician; city: FavoriteCity } | null>(null);
  const [granting, setGranting] = useState<FavoriteTechnician | null>(null);
  const written = useDebounced(qInput.trim());

  // Recarregar ou mandar o link mantém a UF e a busca. A busca vai para a URL quando a digitação para.
  useEffect(() => {
    replaceSearch({ uf: uf || null, cidade: written || null });
  }, [uf, written]);
  // A URL mudou por fora com a aba aberta (o "Favorito em ..." do cadastro, Voltar): mostra o que ela diz.
  const urlChange = useSearchChange();
  if (urlChange) {
    const nextUf = (urlChange.get("uf") ?? "").trim().toUpperCase();
    const nextCity = urlChange.get("cidade") ?? "";
    if (nextUf !== uf) setUf(nextUf);
    if (nextCity.trim() !== written) setQInput(nextCity);
  }

  const out = favorites.data;
  const term = fold(qInput.trim());
  const ufOptions = useMemo(() => {
    const states = [...new Set((out?.cities ?? []).map((c) => c.state))].sort();
    return uf && !states.includes(uf) ? [uf, ...states] : states;
  }, [out, uf]);
  const { cards, inactiveCount, noneCount } = useMemo(() => {
    const all = out?.cities ?? [];
    const inUf = uf ? all.filter((c) => c.state === uf) : all;
    const byCity = (c: FavoriteCity) => fold(`${c.city}-${c.state}`).includes(term);
    const byTech = (c: FavoriteCity) => c.favorites.some((f) => fold(f.name).includes(term));
    // A busca acha a cidade pelo nome (com ou sem favorito) e a cidade de um favorito; as de nome primeiro.
    const searched = term ? [...inUf.filter(byCity), ...inUf.filter((c) => !byCity(c) && byTech(c))] : inUf;
    const withoutFavorite = (c: FavoriteCity) => c.visits > 0 && c.favorites.length === 0;
    const withInactive = (c: FavoriteCity) => c.favorites.some((f) => !f.is_active);
    return {
      inactiveCount: searched.reduce((n, c) => n + c.favorites.filter((f) => !f.is_active).length, 0),
      noneCount: searched.filter(withoutFavorite).length,
      cards:
        chip === "inactive"
          ? searched.filter(withInactive)
          : chip === "none"
            ? searched.filter(withoutFavorite)
            : term
              ? searched
              : searched.filter((c) => c.favorites.length > 0),
    };
  }, [out, uf, term, chip]);
  // Com "Sem acesso ao app", cada cartão mostra só os favoritos sem acesso.
  const rowsOf = (c: FavoriteCity) => (chip === "inactive" ? c.favorites.filter((f) => !f.is_active) : c.favorites);
  const favoriteCount = cards.reduce((n, c) => n + rowsOf(c).length, 0);
  const anyFavorite = (out?.cities ?? []).some((c) => c.favorites.length > 0);
  const filtered = Boolean(uf || term || chip);
  // Quantos cartões mostrar; volta ao começo quando os filtros mudam.
  const listKey = JSON.stringify([uf, term, chip]);
  const [shown, setShown] = useState({ key: listKey, count: PAGE });
  const shownCount = shown.key === listKey ? shown.count : PAGE;
  const windowLabel = out ? windowText(out.window_days) : "12 meses";
  const rule = out ? ruleText(out) : "";

  const clearFilters = () => {
    setUf("");
    setQInput("");
    setChip(null);
  };
  const exportCsv = () =>
    downloadCsv("favoritos-por-cidade.csv", [
      ["uf", "cidade", "tecnico", "email", "origem", "os_12_meses", "ultima_visita", "situacao", "acesso_app", "nota"],
      ...cards.flatMap((c) => {
        const rows = rowsOf(c);
        if (!rows.length) return [[c.state, c.city, "", "", "", "", "", "", "", ""]];
        return rows.map((f) => [
          c.state,
          c.city,
          f.name,
          f.email,
          originOf(f),
          f.visits,
          f.last_visit_at ? formatDate(f.last_visit_at) : "",
          OPERATIONAL_STATUS[f.operational_status ?? "active"],
          f.is_active ? APP_ACCESS.on : APP_ACCESS.off,
          f.note ?? "",
        ]);
      }),
    ]);
  const chips: { key: Chip; label: string; hint: string; count: number }[] = [
    {
      key: "inactive",
      label: "Sem acesso ao app",
      hint: "Favorito sem acesso ao app: não recebe OS até liberar o acesso",
      count: inactiveCount,
    },
    { key: "none", label: "Sem favorito", hint: `Cidades com OS nos últimos ${windowLabel} e nenhum favorito`, count: noneCount },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <div className="w-full sm:w-40">
            <Select value={uf} onChange={(e) => setUf(e.target.value)} aria-label="UF">
              <option value="">Todas as UFs</option>
              {ufOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <div className="relative w-full sm:w-auto sm:min-w-56 sm:flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
            <Input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Buscar cidade ou técnico"
              aria-label="Buscar cidade ou técnico"
              className="pl-9"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtros rápidos">
            {chips
              .filter((c) => c.count > 0 || chip === c.key)
              .map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={chip === c.key}
                  title={c.hint}
                  onClick={() => setChip(chip === c.key ? null : c.key)}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none",
                    chip === c.key ? "border-brand bg-nav-active text-ink" : "border-line bg-surface text-ink-muted hover:text-ink",
                  )}
                >
                  {c.label}
                  <span className="font-semibold text-ink tabular-nums">{c.count}</span>
                </button>
              ))}
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
            {out ? (
              <span className="tabular-nums">
                {plural(cards.length, "cidade", "cidades")} · {plural(favoriteCount, "favorito", "favoritos")}
              </span>
            ) : null}
            <Button size="sm" variant="ghost" onClick={exportCsv} disabled={!cards.length}>
              <Download aria-hidden className="size-3.5" />
              Exportar
            </Button>
            {out ? (
              <span
                role="img"
                tabIndex={0}
                aria-label={rule}
                title={rule}
                className="inline-flex size-8 cursor-help items-center justify-center rounded-lg text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                <Info aria-hidden className="size-4" />
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Uma releitura que falha com a lista já na tela não a esconde. */}
      {!out ? (
        favorites.error ? (
          <ErrorBox message={errorMessage(favorites.error)} onRetry={() => void favorites.refetch()} />
        ) : (
          <Card>
            <LoadingBlock rows={4} label="Carregando os favoritos..." />
          </Card>
        )
      ) : !cards.length ? (
        <Card>
          {filtered || anyFavorite ? (
            <EmptyState
              icon={<MapPin />}
              title="Nenhuma cidade com esses filtros"
              action={<Button onClick={clearFilters}>Limpar filtros</Button>}
            />
          ) : (
            <EmptyState icon={<Star />} title="Nenhum favorito ainda" />
          )}
        </Card>
      ) : (
        <>
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {cards.slice(0, shownCount).map((c) => (
              <CityCard
                key={`${c.state}-${c.key}`}
                city={c}
                rows={rowsOf(c)}
                windowLabel={windowLabel}
                top={out?.top ?? 3}
                actions={actions}
                canEdit={canEdit}
                onInclude={() => setIncluding(c)}
                onEditNote={(tech) => setEditing({ tech, city: c })}
                onGrant={setGranting}
              />
            ))}
          </div>
          {cards.length > shownCount ? (
            <div className="flex items-center justify-between gap-3 text-xs text-ink-muted">
              <span className="tabular-nums">
                Mostrando {shownCount} de {cards.length}
              </span>
              <Button size="sm" onClick={() => setShown({ key: listKey, count: shownCount + PAGE })}>
                Mostrar mais
              </Button>
            </div>
          ) : null}
        </>
      )}

      {including && canEdit ? <IncludeDialog city={including} onClose={() => setIncluding(null)} onSaved={actions.done} /> : null}
      {editing && canEdit ? (
        <NoteDialog
          key={`${editing.tech.id}-${editing.city.key}`}
          tech={editing.tech}
          city={editing.city}
          onClose={() => setEditing(null)}
          onSaved={actions.done}
        />
      ) : null}
      {granting && canEdit ? <GrantAccessDialog technician={granting} onClose={() => setGranting(null)} /> : null}
    </div>
  );
}

/** Uma cidade: os favoritos e, recolhidos no rodapé, os tirados da lista e os outros que atenderam. */
function CityCard({
  city,
  rows,
  windowLabel,
  top,
  actions,
  canEdit,
  onInclude,
  onEditNote,
  onGrant,
}: {
  city: FavoriteCity;
  rows: FavoriteTechnician[];
  windowLabel: string;
  top: number;
  actions: FavoriteActions;
  /** Técnicos: Editar (sem ele, a lista é só de consulta). */
  canEdit: boolean;
  onInclude: () => void;
  onEditNote: (t: FavoriteTechnician) => void;
  onGrant: (t: FavoriteTechnician) => void;
}) {
  const [openHidden, setOpenHidden] = useState(false);
  const [openOthers, setOpenOthers] = useState(false);
  const detail = useCityDetail(city, openHidden || openOthers);
  const row = (t: FavoriteTechnician, kind: RowKind) => (
    <FavoriteRow
      key={t.id}
      tech={t}
      kind={kind}
      city={city}
      windowLabel={windowLabel}
      top={top}
      actions={actions}
      canEdit={canEdit}
      onNote={onEditNote}
      onGrant={onGrant}
    />
  );
  const detailRows = (pick: (d: FavoriteCityDetail) => FavoriteTechnician[], kind: RowKind, total: number) => {
    if (!detail.data) {
      return detail.error ? (
        <div className="px-4 pb-3">
          <ErrorBox message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-4 pb-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      );
    }
    const list = pick(detail.data);
    if (!list.length) return <p className="px-4 pb-3 text-xs text-ink-muted">Nenhum.</p>;
    return (
      <>
        <ul className="divide-y divide-line border-t border-line">{list.map((t) => row(t, kind))}</ul>
        {total > list.length ? (
          <p className="border-t border-line px-4 py-2.5 text-xs text-ink-muted">
            Mais {total - list.length}: busque em “Incluir técnico”
          </p>
        ) : null}
      </>
    );
  };

  return (
    <Card>
      <div className="border-b border-line px-4 py-3">
        <SectionTitle
          size="lg"
          wrap
          aside={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs text-ink-muted tabular-nums" title={`OS atendidas nas lojas da cidade nos últimos ${windowLabel}`}>
                {city.visits.toLocaleString("pt-BR")} OS em {windowLabel} · {plural(city.stores, "loja", "lojas")}
              </span>
              {canEdit ? (
                <Button size="sm" variant="ghost" onClick={onInclude}>
                  <UserPlus aria-hidden className="size-3.5" />
                  Incluir técnico
                </Button>
              ) : null}
            </span>
          }
        >
          {placeLabel(placeOf(city))}
        </SectionTitle>
      </div>
      {rows.length ? (
        <ul className="divide-y divide-line">{rows.map((t) => row(t, "favorite"))}</ul>
      ) : (
        <p className="px-4 py-3 text-sm text-ink-muted">Sem favoritos</p>
      )}
      {city.hidden_count > 0 ? (
        <Disclosure title={`Tirados da lista (${city.hidden_count})`} open={openHidden} onToggle={() => setOpenHidden((v) => !v)}>
          {detailRows((d) => d.hidden, "hidden", city.hidden_count)}
        </Disclosure>
      ) : null}
      {city.others_count > 0 ? (
        <Disclosure title={`Outros que atenderam (${city.others_count})`} open={openOthers} onToggle={() => setOpenOthers((v) => !v)}>
          {detailRows((d) => d.others, "other", city.others_count)}
        </Disclosure>
      ) : null}
    </Card>
  );
}

/** Seção recolhida do rodapé do cartão. */
function Disclosure({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="border-t border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-b-xl px-4 py-2.5 text-left text-xs font-semibold text-ink-muted transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none focus-visible:ring-inset"
      >
        <ChevronDown aria-hidden className={clsx("size-3.5 shrink-0 transition-transform duration-150", !open && "-rotate-90")} />
        {title}
      </button>
      <div id={id} hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}

/** Linha de um favorito, de um tirado da lista ou de outro técnico que atendeu na cidade. */
type RowKind = "favorite" | "hidden" | "other";

function FavoriteRow({
  tech: t,
  kind,
  city,
  windowLabel,
  top,
  actions,
  canEdit,
  onNote,
  onGrant,
}: {
  tech: FavoriteTechnician;
  kind: RowKind;
  city: FavoriteCity;
  windowLabel: string;
  top: number;
  actions: FavoriteActions;
  /** Técnicos: Editar. Sem ele, a estrela é só indicação e as ações da linha somem. */
  canEdit: boolean;
  onNote: (t: FavoriteTechnician) => void;
  onGrant: (t: FavoriteTechnician) => void;
}) {
  const place = placeOf(city);
  const label = placeLabel(place);
  const pending = actions.isPending(t.id, place);
  const act = (change: Change, title: string) => actions.act({ tech: t, place, change, notice: { title, undo: undoOf(t) } });
  const starLabel = kind === "favorite" ? `Tirar ${t.name} dos favoritos de ${label}` : `Favoritar ${t.name} em ${label}`;

  const side: React.ReactNode[] = [];
  if (canEdit && kind === "favorite" && t.automatic && !t.pinned) {
    side.push(
      <button
        key="pin"
        type="button"
        onClick={() => act({ favorite: true, note: null }, `${t.name} fixado em ${label}`)}
        disabled={pending}
        aria-label={`Fixar ${t.name} em ${label}`}
        title={`Fixado continua favorito mesmo fora do top ${top}`}
        className={clsx(ICON_BUTTON, ICON_BORDERED)}
      >
        <Pin aria-hidden className="size-4" />
      </button>,
    );
  }
  if (canEdit && ((kind === "favorite" && t.pinned) || kind === "hidden")) {
    side.push(
      <button
        key="note"
        type="button"
        onClick={() => onNote(t)}
        disabled={pending}
        aria-label={`Editar nota de ${t.name}`}
        title="Editar nota"
        className={clsx(ICON_BUTTON, ICON_BORDERED)}
      >
        <Pencil aria-hidden className="size-4" />
      </button>,
    );
  }
  if (canEdit && kind === "hidden") {
    side.push(
      <Button
        key="restore"
        size="sm"
        variant="ghost"
        onClick={() => act(null, `${t.name} voltou para a regra`)}
        disabled={pending}
        title="Volta a valer a regra automática"
      >
        {pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Undo2 aria-hidden className="size-3.5" />}
        Voltar para a lista
      </Button>,
    );
  }
  if (canEdit && kind === "favorite" && !t.is_active) {
    side.push(
      <Button key="grant" size="sm" onClick={() => onGrant(t)}>
        <KeyRound aria-hidden className="size-3.5" />
        Liberar acesso
      </Button>,
    );
  }
  if (kind === "favorite" && t.is_active && t.phone) {
    side.push(
      <a
        key="whatsapp"
        href={whatsappUrl(t.phone, `Olá, ${firstName(t.name)}!`)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Conversar com ${t.name} no WhatsApp`}
        title={`Conversar com ${t.name} no WhatsApp`}
        className={clsx(ICON_BUTTON, ICON_BORDERED)}
      >
        <MessageCircle aria-hidden className="size-4" />
      </a>,
    );
  }
  if (kind === "favorite" && t.open_tickets > 0) {
    side.push(
      <Link
        key="open"
        href={ticketsListHref({ assignee_id: t.id, open_only: true })}
        title={`OS abertas de ${t.name}`}
        className={clsx(TEXT_LINK, "px-1 text-xs font-medium whitespace-nowrap tabular-nums")}
      >
        {t.open_tickets} em aberto
      </Link>,
    );
  }

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <span className="flex items-center gap-1">
        {kind === "hidden" ? null : !canEdit ? (
          // Só consulta: a estrela marca o favorito, sem virar botão.
          <span
            className={clsx(ICON_BUTTON, kind === "favorite" ? "text-brand" : "invisible")}
            title={kind === "favorite" ? `Favorito em ${label}` : undefined}
          >
            <Star aria-hidden className={clsx("size-4", kind === "favorite" && "fill-current")} />
            {kind === "favorite" ? <span className="sr-only">Favorito em {label}</span> : null}
          </span>
        ) : (
          <button
            type="button"
            aria-pressed={kind === "favorite"}
            aria-label={starLabel}
            title={starLabel}
            disabled={pending}
            onClick={() =>
              kind === "favorite"
                ? act({ favorite: false, note: null }, `${t.name} saiu dos favoritos de ${label}`)
                : act({ favorite: true, note: null }, `${t.name} é favorito em ${label}`)
            }
            className={clsx(ICON_BUTTON, "hover:bg-brand-soft", kind === "favorite" ? "text-brand" : "text-ink-subtle hover:text-brand")}
          >
            {pending ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Star aria-hidden className={clsx("size-4", kind === "favorite" && "fill-current")} />
            )}
          </button>
        )}
        <Avatar name={t.name} src={absoluteApiUrl(t.avatar_url)} />
      </span>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* A ficha na mesma aba (a cidade e a busca ficam na URL: o Voltar retorna aqui). */}
          <TechnicianLink id={t.id} className={clsx(TEXT_LINK, "max-w-full truncate text-sm font-semibold")}>
            {t.name}
          </TechnicianLink>
          {kind === "favorite" && t.pinned ? (
            <span className={CHIP} title={decisionTitle("Fixado", t)}>
              Fixado
            </span>
          ) : null}
          {/* "Inativo" / "Bloqueado" com o motivo: fora de Ativo, não recebe OS nem entra no automático (o fixado fica). */}
          <OperationalPill tech={t} />
          {t.is_active ? null : (
            <span className={CHIP} title="Não recebe OS até liberar o acesso">
              Sem acesso ao app
            </span>
          )}
          {t.on_shift ? (
            <span className={CHIP}>
              <span aria-hidden className="size-1.5 rounded-full bg-ink-subtle" />
              Em jornada
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs text-ink-muted" title={kind === "hidden" ? decisionTitle("Tirado", t) : undefined}>
          {factsOf(t, city, windowLabel)}
        </p>
        {t.note ? (
          <p className="mt-0.5 truncate text-xs text-ink" title={t.note}>
            {t.note}
          </p>
        ) : null}
      </div>
      {side.length ? (
        <div className="col-start-2 flex flex-wrap items-center gap-1.5 sm:col-start-3 sm:row-start-1 sm:justify-end">{side}</div>
      ) : null}
    </li>
  );
}

/** Foto do técnico; sem foto (ou link quebrado), as iniciais. */
function Avatar({ name, src }: { name: string; src: string | null }) {
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-soft text-xs font-semibold text-brand-ink">
      {src && broken !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(src)} className="size-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/** Contador da nota ("12/300"). */
export function NoteCounter({ value }: { value: string }) {
  return (
    <span className="self-end text-[11px] text-ink-subtle tabular-nums">
      {value.length}/{NOTE_MAX}
    </span>
  );
}

/** Nota de um fixado (ou o motivo de um tirado da lista); no fixado, também o "Desafixar". */
export function NoteDialog({
  tech,
  city,
  onClose,
  onSaved,
}: {
  tech: FavoriteTechnician;
  city: FavoriteCity;
  onClose: () => void;
  onSaved: (detail: FavoriteCityDetail, action: FavoriteAction) => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const place = placeOf(city);
  const label = placeLabel(place);
  const pinned = !tech.hidden;
  const [note, setNote] = useState(tech.note ?? "");
  const changed = note.trim() !== (tech.note ?? "");
  const save = useMutation({
    mutationFn: (change: Change) => sendFavorite(tech.id, place, change),
    onSuccess: (detail, change) => {
      if (change) {
        onSaved(detail, { tech, place, change });
        toast({ title: pinned ? "Nota salva" : "Motivo salvo", tone: "success" });
      } else {
        // Desafixado: continua favorito se ainda está entre os automáticos.
        onSaved(detail, {
          tech,
          place,
          change,
          notice: {
            title: tech.automatic ? `${tech.name} voltou para a regra` : `${tech.name} saiu dos favoritos de ${label}`,
            undo: undoOf(tech),
          },
        });
      }
      onClose();
    },
  });
  const unpinning = save.isPending && save.variables === null;

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={changed && !save.isPending}
      busy={save.isPending}
      title={tech.name}
      description={pinned ? `Fixado em ${label}` : `Tirado da lista de ${label}`}
      footer={
        <>
          {pinned ? (
            <Button variant="ghost" className="mr-auto" onClick={() => save.mutate(null)} loading={unpinning} disabled={save.isPending}>
              {unpinning ? null : <PinOff aria-hidden className="size-4" />}
              Desafixar
            </Button>
          ) : null}
          <Button onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={save.isPending && !unpinning} disabled={!changed || save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed && !save.isPending) save.mutate({ favorite: pinned, note: note.trim() || null });
        }}
      >
        <Field label={pinned ? "Nota" : "Motivo"}>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} autoFocus />
        </Field>
        <NoteCounter value={note} />
        {save.error ? <ErrorBox message={errorMessage(save.error)} /> : null}
      </form>
    </Dialog>
  );
}

/** Região de um técnico na busca: a de atuação (histórico) ou a da casa. */
function regionOf(t: Technician): string {
  if (t.base_city) return [t.base_city, t.base_state].filter(Boolean).join("-");
  if (t.home_city) return [t.home_city, t.home_state].filter(Boolean).join("-");
  return "Sem região";
}

/** "Incluir favorito": quem já atendeu na cidade (um clique) ou qualquer técnico da base, com nota. */
function IncludeDialog({
  city,
  onClose,
  onSaved,
}: {
  city: FavoriteCity;
  onClose: () => void;
  onSaved: (detail: FavoriteCityDetail, action: FavoriteAction) => void;
}) {
  const ids = useId();
  const place = placeOf(city);
  const label = placeLabel(place);
  const detail = useCityDetail(city, true);
  const [picked, setPicked] = useState<{ id: UUID; name: string } | null>(null);
  const [term, setTerm] = useState("");
  const [note, setNote] = useState("");
  const q = useDebounced(term.trim(), 300);
  const search = useQuery({
    queryKey: ["technicians", "search", q],
    queryFn: ({ signal }) => api.get<Technician[]>("/technicians", { q, limit: 20 }, { signal }),
    enabled: q.length >= 2,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const include = useMutation({
    mutationFn: (input: { tech: { id: UUID; name: string }; change: Change; before: FavoriteTechnician | null }) =>
      sendFavorite(input.tech.id, place, input.change),
    onSuccess: (saved, input) => {
      onSaved(saved, {
        tech: input.tech,
        place,
        change: input.change,
        notice: { title: `${input.tech.name} é favorito em ${label}`, undo: undoOf(input.before) },
      });
      onClose();
    },
  });
  const others = detail.data?.others ?? [];
  const submit = () => {
    if (!picked || include.isPending) return;
    // O estado de antes (para o Desfazer): favorito, tirado da lista ou nada.
    const known = [...(detail.data?.favorites ?? city.favorites), ...(detail.data?.hidden ?? [])];
    const before = known.find((f) => f.id === picked.id) ?? null;
    include.mutate({
      tech: picked,
      // Nota em branco num já fixado mantém a nota dele (trocar ou apagar fica no lápis); o motivo de um
      // tirado não vira nota.
      change: { favorite: true, note: note.trim() || (before?.pinned ? before.note : null) },
      before,
    });
  };
  const pickClass = (selected: boolean) =>
    clsx(
      "rounded-lg border text-left transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none",
      selected ? "border-brand bg-nav-active text-ink" : "border-line bg-surface text-ink hover:border-line-strong hover:bg-surface-2",
    );

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={Boolean(picked || note.trim()) && !include.isPending}
      busy={include.isPending}
      title={`Incluir favorito em ${label}`}
      footer={
        <>
          <Button onClick={onClose} disabled={include.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={submit} loading={include.isPending} disabled={!picked}>
            Incluir
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {detail.isLoading ? (
          <Skeleton className="h-14 w-full" />
        ) : others.length ? (
          <div className="flex flex-col gap-1.5">
            <span id={`${ids}-atenderam`} className="text-xs font-semibold text-ink/80">
              Atenderam aqui
            </span>
            <div role="group" aria-labelledby={`${ids}-atenderam`} className="flex flex-wrap gap-1.5">
              {others.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={picked?.id === t.id}
                  onClick={() => setPicked({ id: t.id, name: t.name })}
                  className={clsx(pickClass(picked?.id === t.id), "px-2.5 py-1 text-xs")}
                >
                  {t.name} · {t.visits} OS
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-busca`} className="text-xs font-semibold text-ink/80">
            Buscar técnico
          </label>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
            <Input
              id={`${ids}-busca`}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Nome, e-mail ou telefone"
              autoComplete="off"
              className="pl-9"
            />
          </div>
          {q.length < 2 ? null : search.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : search.error ? (
            <ErrorBox message={errorMessage(search.error)} onRetry={() => void search.refetch()} />
          ) : search.data?.length ? (
            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto" aria-label="Técnicos encontrados">
              {search.data.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-pressed={picked?.id === t.id}
                    onClick={() => setPicked({ id: t.id, name: t.name })}
                    className={clsx(pickClass(picked?.id === t.id), "flex w-full items-center gap-2 px-3 py-2")}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{t.name}</span>
                      <span className="block truncate text-xs text-ink-muted">{regionOf(t)}</span>
                    </span>
                    <OperationalPill tech={t} />
                    {t.is_active ? null : <span className={CHIP}>Sem acesso ao app</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-muted">Nenhum técnico com “{q}”.</p>
          )}
        </div>

        {picked ? (
          <p className="text-sm text-ink">
            Técnico: <strong className="font-semibold">{picked.name}</strong>
          </p>
        ) : null}
        <div className="flex flex-col gap-1">
          <Field label="Nota (opcional)">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} />
          </Field>
          <NoteCounter value={note} />
        </div>
        {include.error ? <ErrorBox message={errorMessage(include.error)} /> : null}
      </div>
    </Dialog>
  );
}
