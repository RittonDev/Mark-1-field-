"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Loader2, Pencil, Pin, Plus, Star, Undo2 } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { type ComboItem, Combobox, searchText } from "@/components/new-ticket/Combobox";
import { Button, Dialog, ErrorBox, Field, Skeleton, Textarea } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useFavorites } from "@/lib/queries";
import type { FavoriteCity, FavoriteCityDetail, FavoriteTechnician, Technician } from "@/lib/types";
import {
  detailKey,
  type FavoriteAction,
  type FavoriteActions,
  favoritesHref,
  NOTE_MAX,
  NoteCounter,
  NoteDialog,
  placeLabel,
  placeOf,
  sendFavorite,
  undoOf,
  useCityDetail,
  useFavoriteActions,
} from "../../FavoritesView";
import { fichaLabel } from "../FichaNav";
import { SectionCard, SubTitle } from "../SectionCard";

// Botão só com ícone, com o foco visível do sistema (o mesmo da aba Favoritos).
const ICON_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";
const ICON_BORDERED = "border border-line bg-surface text-ink-muted shadow-elev-1 hover:border-line-strong hover:text-ink";
const CITY_LINK =
  "rounded font-medium text-ink underline-offset-2 hover:text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none";

const collator = new Intl.Collator("pt-BR", { sensitivity: "base" });
const byLabel = (a: FavoriteCity, b: FavoriteCity) => collator.compare(placeLabel(a), placeLabel(b));
const firstName = (name: string) => name.trim().split(/\s+/)[0];

/**
 * Favoritos, geridos pela ficha: as cidades em que ele é favorito (pela regra, as OS atendidas, ou fixado pela central),
 * com a estrela, o fixar e a nota como na aba Favoritos (com "Desfazer"), e as cidades em que foi tirado da lista. Cada
 * cidade abre a aba Favoritos de Técnicos já nela. Toda mudança vai ao histórico do cadastro (a API grava). Só com
 * Técnicos Editar as ações aparecem.
 */
export function FavoritesSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const favorites = useFavorites({ technicianId: tech.id });
  const actions = useFavoriteActions();
  const [editing, setEditing] = useState<{ me: FavoriteTechnician; city: FavoriteCity } | null>(null);
  const [including, setIncluding] = useState(false);
  const { favoriteIn, removedFrom } = useMemo(() => {
    const cities = favorites.data?.cities ?? [];
    return {
      favoriteIn: cities
        .flatMap((city) => {
          const me = city.favorites.find((f) => f.id === tech.id);
          return me ? [{ city, me }] : [];
        })
        .sort((a, b) => byLabel(a.city, b.city)),
      // A consulta traz as cidades em que ele é favorito ou foi tirado: as outras são as tiradas.
      removedFrom: cities.filter((city) => !city.favorites.some((f) => f.id === tech.id)).sort(byLabel),
    };
  }, [favorites.data, tech.id]);
  const who = { id: tech.id, name: tech.name };

  return (
    <SectionCard
      title={fichaLabel("favoritos")}
      aside={
        canEdit && favorites.data ? (
          <Button size="sm" onClick={() => setIncluding(true)}>
            <Plus aria-hidden className="size-3.5" />
            Incluir cidade
          </Button>
        ) : undefined
      }
    >
      {favorites.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : favorites.error && !favorites.data ? (
        <ErrorBox message={errorMessage(favorites.error)} onRetry={() => void favorites.refetch()} />
      ) : (
        <>
          {!favoriteIn.length ? (
            <p className="text-sm text-ink-muted">Não é favorito em nenhuma cidade.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {favoriteIn.map(({ city, me }) => (
                <FavoriteCityRow
                  key={`${city.state}-${city.key}`}
                  tech={who}
                  city={city}
                  me={me}
                  actions={actions}
                  canEdit={canEdit}
                  onEditNote={() => setEditing({ me, city })}
                />
              ))}
            </ul>
          )}
          {removedFrom.length ? (
            <div className="flex flex-col gap-2">
              <SubTitle>Tirados da lista</SubTitle>
              <ul className="flex flex-col divide-y divide-line">
                {removedFrom.map((city) => (
                  <RemovedCityRow key={`${city.state}-${city.key}`} tech={who} city={city} actions={actions} canEdit={canEdit} />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}

      {editing && canEdit ? (
        <NoteDialog
          key={`${editing.city.state}-${editing.city.key}`}
          tech={editing.me}
          city={editing.city}
          onClose={() => setEditing(null)}
          onSaved={actions.done}
        />
      ) : null}
      {including && canEdit ? (
        <IncludeCityDialog
          tech={who}
          favoriteIn={favoriteIn.map(({ city }) => city)}
          onClose={() => setIncluding(false)}
          onSaved={actions.done}
        />
      ) : null}
    </SectionCard>
  );
}

/** Uma cidade em que ele é favorito: a estrela, a cidade (link da aba Favoritos), fixado ou as OS, a nota e as ações. */
function FavoriteCityRow({
  tech,
  city,
  me,
  actions,
  canEdit,
  onEditNote,
}: {
  tech: { id: string; name: string };
  city: FavoriteCity;
  me: FavoriteTechnician;
  actions: FavoriteActions;
  canEdit: boolean;
  onEditNote: () => void;
}) {
  const place = placeOf(city);
  const label = placeLabel(place);
  const pending = actions.isPending(tech.id, place);
  const act = (change: FavoriteAction["change"], title: string) =>
    actions.act({ tech, place, change, notice: { title, undo: undoOf(me) } });
  const starLabel = `Tirar ${tech.name} dos favoritos de ${label}`;

  return (
    <li className="flex flex-wrap items-start gap-x-2 gap-y-1 py-2 first:pt-0 last:pb-0">
      {canEdit ? (
        <button
          type="button"
          aria-pressed
          aria-label={starLabel}
          title={starLabel}
          disabled={pending}
          onClick={() => act({ favorite: false, note: null }, `${tech.name} saiu dos favoritos de ${label}`)}
          className={clsx(ICON_BUTTON, "-my-1 text-brand hover:bg-brand-soft")}
        >
          {pending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Star aria-hidden className="size-4 fill-current" />}
        </button>
      ) : (
        <span className="inline-flex size-6 shrink-0 items-center justify-center text-brand">
          <Star aria-hidden className="size-4 fill-current" />
        </span>
      )}
      <div className="min-w-0 flex-1 basis-48">
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-ink">
          <Link href={favoritesHref(city.state, city.city)} className={CITY_LINK}>
            {label}
          </Link>
          <span className="text-ink-muted">({me.pinned ? "fixado" : `${me.visits} OS`})</span>
        </p>
        {me.pinned && me.note ? <p className="mt-0.5 text-xs break-words text-ink-muted">{me.note}</p> : null}
      </div>
      {canEdit ? (
        <div className="flex items-center gap-1.5">
          {me.automatic && !me.pinned ? (
            <button
              type="button"
              onClick={() => act({ favorite: true, note: null }, `${tech.name} fixado em ${label}`)}
              disabled={pending}
              aria-label={`Fixar em ${label}`}
              title={`Fixar em ${label}`}
              className={clsx(ICON_BUTTON, ICON_BORDERED)}
            >
              <Pin aria-hidden className="size-4" />
            </button>
          ) : null}
          {me.pinned ? (
            <button
              type="button"
              onClick={onEditNote}
              disabled={pending}
              aria-label={`Editar nota de ${label}`}
              title="Editar nota"
              className={clsx(ICON_BUTTON, ICON_BORDERED)}
            >
              <Pencil aria-hidden className="size-4" />
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Uma cidade em que ele foi tirado da lista: a cidade, o motivo (quando há) e "Voltar para a lista" (volta a valer a regra). */
function RemovedCityRow({
  tech,
  city,
  actions,
  canEdit,
}: {
  tech: { id: string; name: string };
  city: FavoriteCity;
  actions: FavoriteActions;
  canEdit: boolean;
}) {
  const place = placeOf(city);
  const label = placeLabel(place);
  const pending = actions.isPending(tech.id, place);
  // O motivo fica no detalhe da cidade (a mesma consulta do rodapé do cartão na aba Favoritos).
  const detail = useCityDetail(city, true);
  const me = detail.data?.hidden.find((f) => f.id === tech.id) ?? null;
  const restore = () =>
    actions.act({
      tech,
      place,
      change: null,
      notice: {
        title: `${tech.name} voltou para a regra em ${label}`,
        undo: { favorite: false, note: me?.note ?? null, hide: true },
      },
    });

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-48">
        <Link href={favoritesHref(city.state, city.city)} className={clsx(CITY_LINK, "text-sm")}>
          {label}
        </Link>
        {me?.note ? <p className="mt-0.5 text-xs break-words text-ink-muted">{me.note}</p> : null}
      </div>
      {canEdit ? (
        <Button size="sm" variant="ghost" onClick={restore} disabled={pending} title="Volta a valer a regra automática">
          {pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Undo2 aria-hidden className="size-3.5" />}
          Voltar para a lista
        </Button>
      ) : null}
    </li>
  );
}

/**
 * "Incluir cidade": fixa o técnico como favorito numa cidade com loja (as de todas as lojas, a consulta da aba Favoritos,
 * menos as em que ele já é favorito), com a nota opcional. O limite de fixados por cidade vem do servidor.
 */
function IncludeCityDialog({
  tech,
  favoriteIn,
  onClose,
  onSaved,
}: {
  tech: { id: string; name: string };
  favoriteIn: FavoriteCity[];
  onClose: () => void;
  onSaved: (detail: FavoriteCityDetail, action: FavoriteAction) => void;
}) {
  const ids = useId();
  const queryClient = useQueryClient();
  const all = useFavorites();
  const [picked, setPicked] = useState<FavoriteCity | null>(null);
  const [note, setNote] = useState("");
  const items = useMemo(() => {
    const taken = new Set(favoriteIn.map((c) => `${c.state}|${c.key}`));
    return (all.data?.cities ?? [])
      .filter((c) => !taken.has(`${c.state}|${c.key}`))
      .sort(byLabel)
      .map((c): ComboItem<FavoriteCity> => ({ key: `${c.state}|${c.key}`, item: c, label: placeLabel(c), haystack: searchText(placeLabel(c)) }));
  }, [all.data, favoriteIn]);
  const include = useMutation({
    mutationFn: (city: FavoriteCity) => sendFavorite(tech.id, placeOf(city), { favorite: true, note: note.trim() || null }),
    onSuccess: (detail, city) => {
      const place = placeOf(city);
      // O estado de antes (para o Desfazer): tirado da lista (com o motivo, do detalhe que a seção já leu) ou nada.
      const cached = queryClient.getQueryData<FavoriteCityDetail>(detailKey(city.state, city.key));
      const before = cached?.hidden.find((f) => f.id === tech.id) ?? null;
      onSaved(detail, {
        tech,
        place,
        change: { favorite: true, note: note.trim() || null },
        notice: { title: `${tech.name} é favorito em ${placeLabel(place)}`, undo: undoOf(before) },
      });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={Boolean(picked || note.trim()) && !include.isPending}
      busy={include.isPending}
      title={`Incluir ${firstName(tech.name)} como favorito`}
      footer={
        <>
          <Button onClick={onClose} disabled={include.isPending}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={() => picked && !include.isPending && include.mutate(picked)}
            loading={include.isPending}
            disabled={!picked}
          >
            Incluir
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label id={`${ids}-cidade`} htmlFor={`${ids}-busca`} className="text-xs font-semibold text-ink/80">
            Cidade
          </label>
          {all.error && !all.data ? (
            <ErrorBox message={errorMessage(all.error)} onRetry={() => void all.refetch()} />
          ) : (
            <Combobox
              id={`${ids}-busca`}
              labelledBy={`${ids}-cidade`}
              items={items}
              value={picked ? `${picked.state}|${picked.key}` : ""}
              onChange={setPicked}
              renderItem={(city) => placeLabel(city)}
              placeholder="Buscar cidade"
              emptyText="Nenhuma cidade com loja com este nome"
              loading={all.isLoading}
            />
          )}
        </div>
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
