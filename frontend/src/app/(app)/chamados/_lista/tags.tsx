"use client";

// Etiquetas na lista de chamados com as cores do Field Control (a cor é a identidade de cada uma:
// "Ticket Avulso" verde, "Custo Extra" amarelo, "Projeto" roxo). A paleta é a de TagChips, a mesma do
// editor da OS, do painel e da Nova OS: a etiqueta tem a mesma cor em todas as telas.

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { tagTone } from "@/components/TagChips";
import { Input } from "@/components/ui";
import { api } from "@/lib/api";
import type { Tag } from "@/lib/types";
import { cleanTags, TAG_FILTER_MAX, TAG_NAME_MAX } from "./params";

const CHIP = "inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap ring-1 ring-inset";

export const sameTag = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Etiqueta com a cor dela (sem cor conhecida, neutra). */
export function TagChip({ tag, className, children }: { tag: Tag; className?: string; children?: React.ReactNode }) {
  return (
    <span className={clsx(CHIP, tagTone(tag.color), className)}>
      <span className="truncate">{tag.name}</span>
      {children}
    </span>
  );
}

/** Coluna "Etiquetas": no máximo duas à vista e "+N" com as outras (a lista inteira no título). */
export function TagsCell({ tags }: { tags?: Tag[] | null }) {
  if (!tags?.length) return <span className="text-xs text-ink-subtle">—</span>;
  const shown = tags.slice(0, 2);
  const rest = tags.length - shown.length;
  const all = tags.map((t) => t.name).join(", ");
  return (
    <span className="flex max-w-[16rem] min-w-0 items-center gap-1" title={all}>
      {shown.map((t) => (
        <TagChip key={t.name} tag={t} className="max-w-[8.5rem]" />
      ))}
      {rest > 0 ? (
        <span className={clsx(CHIP, tagTone(null), "shrink-0")}>
          <span aria-hidden>+{rest}</span>
          <span className="sr-only">
            e mais {rest} {rest === 1 ? "etiqueta" : "etiquetas"}: {tags.slice(2).map((t) => t.name).join(", ")}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** Etiquetas já usadas nas OS (as mais usadas primeiro), com a cor de cada uma. */
export function useKnownTags(enabled = true) {
  return useQuery({
    queryKey: ["ticket-tags"],
    queryFn: ({ signal }) => api.get<Tag[]>("/ticket-tags", undefined, { signal }),
    staleTime: 5 * 60_000,
    enabled,
  });
}

/** A etiqueta com a cor cadastrada (a escrita como a pessoa digitou, sem cor, quando é nova). */
export function withColor(name: string, known: Tag[] | undefined): Tag {
  return known?.find((t) => sameTag(t.name, name)) ?? { name, color: null };
}

/**
 * Escolha de etiquetas: as escolhidas (tira com o ×), as mais usadas para um clique e um campo para
 * achar outra (as já usadas aparecem como sugestão; Enter inclui).
 */
export function TagPicker({
  value,
  onChange,
  known,
  suggestions,
  allowNew = true,
  labelledBy,
  placeholder = "Buscar etiqueta",
}: {
  value: string[];
  onChange: (names: string[]) => void;
  /** Etiquetas já usadas (com as cores). */
  known: Tag[] | undefined;
  /** Atalhos de um clique (sem eles, as mais usadas). */
  suggestions?: Tag[];
  /** Aceita uma etiqueta que nenhuma OS tem ainda. */
  allowNew?: boolean;
  labelledBy?: string;
  placeholder?: string;
}) {
  const listId = useId();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const has = (name: string) => value.some((v) => sameTag(v, name));
  const full = value.length >= TAG_FILTER_MAX;
  const quick = (suggestions ?? known?.slice(0, 8) ?? []).filter((t) => !has(t.name));

  const add = (raw: string) => {
    const name = raw.replace(/\s+/g, " ").trim();
    setDraft("");
    if (!name) return;
    const existing = known?.find((t) => sameTag(t.name, name));
    if (!existing && !allowNew) {
      setNote(`Nenhuma OS tem a etiqueta “${name}”.`);
      return;
    }
    setNote(null);
    onChange(cleanTags([...value, existing?.name ?? name]));
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length ? (
        <ul role="list" aria-labelledby={labelledBy} className="flex flex-wrap gap-1.5">
          {value.map((name) => (
            <li key={name}>
              <TagChip tag={withColor(name, known)} className="py-0.5 pr-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => onChange(value.filter((v) => !sameTag(v, name)))}
                  className="shrink-0 rounded p-0.5 transition-colors hover:bg-ink/10 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                  aria-label={`Tirar a etiqueta ${name}`}
                >
                  <X aria-hidden className="size-3" />
                </button>
              </TagChip>
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        list={listId}
        value={draft}
        disabled={full}
        onChange={(e) => {
          setDraft(e.target.value);
          setNote(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            // Enter inclui a etiqueta (não envia o formulário em volta).
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        maxLength={TAG_NAME_MAX}
        placeholder={full ? `Limite de ${TAG_FILTER_MAX} etiquetas` : placeholder}
        aria-labelledby={labelledBy}
        aria-describedby={note ? `${listId}-nota` : undefined}
        autoComplete="off"
      />
      <datalist id={listId}>
        {(known ?? [])
          .filter((t) => !has(t.name))
          .map((t) => (
            <option key={t.name} value={t.name} />
          ))}
      </datalist>
      {note ? (
        <p id={`${listId}-nota`} role="status" className="text-xs text-ink-muted">
          {note}
        </p>
      ) : null}
      {quick.length && !full ? (
        <div className="flex flex-wrap gap-1.5">
          {quick.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => add(t.name)}
              className="group inline-flex rounded-md focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              aria-label={`Incluir a etiqueta ${t.name}`}
            >
              <TagChip tag={t} className="py-0.5 text-xs transition-opacity group-hover:opacity-80">
                <Plus aria-hidden className="size-3 shrink-0" />
              </TagChip>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Atalho de etiqueta que liga e desliga (usado para tirar etiquetas das OS escolhidas). */
export function TagToggle({ tag, on, onToggle }: { tag: Tag; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition-colors",
        "focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none",
        on ? "border-brand/50 bg-brand-soft text-brand-ink" : "border-line bg-surface text-ink hover:border-line-strong",
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "flex size-3.5 shrink-0 items-center justify-center rounded border",
          on ? "border-brand bg-brand text-white dark:border-brand-strong dark:bg-brand-strong" : "border-line-strong",
        )}
      >
        {on ? <Check className="size-2.5" /> : null}
      </span>
      <TagChip tag={tag} />
    </button>
  );
}
