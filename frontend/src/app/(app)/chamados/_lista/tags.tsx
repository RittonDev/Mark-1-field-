"use client";

// Etiquetas na lista de chamados com as cores do Field Control (a cor é a identidade de cada uma:
// "Ticket Avulso" verde, "Custo Extra" amarelo, "Projeto" roxo), em tons que passam do AA no claro e
// no escuro.

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { Input } from "@/components/ui";
import { api } from "@/lib/api";
import type { Tag } from "@/lib/types";
import { cleanTags, TAG_FILTER_MAX, TAG_NAME_MAX } from "./params";

// Nomes de cor do Field Control (os que a API guarda em cada etiqueta).
const TAG_TONES: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/25",
  pink: "bg-pink-50 text-pink-800 ring-pink-600/20 dark:bg-pink-400/10 dark:text-pink-300 dark:ring-pink-400/25",
  yellow: "bg-yellow-50 text-yellow-800 ring-yellow-600/25 dark:bg-yellow-400/10 dark:text-yellow-200 dark:ring-yellow-400/25",
  indigo: "bg-indigo-50 text-indigo-800 ring-indigo-600/20 dark:bg-indigo-400/10 dark:text-indigo-300 dark:ring-indigo-400/25",
  purple: "bg-purple-50 text-purple-800 ring-purple-600/20 dark:bg-purple-400/10 dark:text-purple-300 dark:ring-purple-400/25",
  "field-pale": "bg-stone-100 text-stone-700 ring-stone-500/20 dark:bg-stone-400/10 dark:text-stone-300 dark:ring-stone-400/25",
  "light-blue": "bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/25",
  brown: "bg-[#f3ebe4] text-[#5c3a1e] ring-[#8a5a33]/25 dark:bg-[#8a5a33]/20 dark:text-[#e6cdb4] dark:ring-[#b07a4f]/30",
  red: "bg-red-50 text-red-800 ring-red-600/20 dark:bg-red-400/10 dark:text-red-300 dark:ring-red-400/25",
  "blue-grey": "bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-400/10 dark:text-slate-300 dark:ring-slate-400/25",
  blue: "bg-blue-50 text-blue-800 ring-blue-600/20 dark:bg-blue-400/10 dark:text-blue-300 dark:ring-blue-400/25",
  teal: "bg-teal-50 text-teal-800 ring-teal-600/20 dark:bg-teal-400/10 dark:text-teal-300 dark:ring-teal-400/25",
  orange: "bg-orange-50 text-orange-800 ring-orange-600/20 dark:bg-orange-400/10 dark:text-orange-300 dark:ring-orange-400/25",
  grey: "bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-zinc-400/10 dark:text-zinc-300 dark:ring-zinc-400/25",
};
const NEUTRAL_TONE = "bg-surface-2 text-ink-muted ring-line";

const CHIP = "inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap ring-1 ring-inset";

export const sameTag = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Etiqueta com a cor dela (sem cor conhecida, neutra). */
export function TagChip({ tag, className, children }: { tag: Tag; className?: string; children?: React.ReactNode }) {
  return (
    <span className={clsx(CHIP, TAG_TONES[tag.color ?? ""] ?? NEUTRAL_TONE, className)}>
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
        <span className={clsx(CHIP, NEUTRAL_TONE, "shrink-0")}>
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
