"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { searchText } from "@/components/new-ticket/Combobox";
import { api } from "@/lib/api";
import type { Tag } from "@/lib/types";

// Cores das etiquetas com os nomes do Field Control: a cor é a identidade da etiqueta ("Ticket Avulso"
// verde, "Custo Extra" amarela, "Projeto" roxa), como lá. Fundo claro e texto escuro do mesmo tom (no
// escuro, o contrário): o texto passa de 4,5:1 nos dois temas.
const TONE: Record<string, string> = {
  red: "bg-red-50 text-red-800 ring-red-200 dark:bg-red-500/15 dark:text-red-200 dark:ring-red-400/30",
  pink: "bg-pink-50 text-pink-800 ring-pink-200 dark:bg-pink-500/15 dark:text-pink-200 dark:ring-pink-400/30",
  purple: "bg-purple-50 text-purple-800 ring-purple-200 dark:bg-purple-500/15 dark:text-purple-200 dark:ring-purple-400/30",
  indigo: "bg-indigo-50 text-indigo-800 ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-200 dark:ring-indigo-400/30",
  blue: "bg-blue-50 text-blue-800 ring-blue-200 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/30",
  "light-blue": "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:ring-sky-400/30",
  teal: "bg-teal-50 text-teal-800 ring-teal-200 dark:bg-teal-500/15 dark:text-teal-200 dark:ring-teal-400/30",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-400/30",
  yellow: "bg-yellow-50 text-yellow-800 ring-yellow-300 dark:bg-yellow-500/15 dark:text-yellow-200 dark:ring-yellow-400/30",
  orange: "bg-orange-50 text-orange-800 ring-orange-200 dark:bg-orange-500/15 dark:text-orange-200 dark:ring-orange-400/30",
  brown: "bg-amber-50 text-amber-900 ring-amber-300 dark:bg-amber-700/20 dark:text-amber-200 dark:ring-amber-500/30",
  "blue-grey": "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-500/15 dark:text-slate-200 dark:ring-slate-400/30",
  "field-pale": "bg-stone-100 text-stone-700 ring-stone-200 dark:bg-stone-500/15 dark:text-stone-200 dark:ring-stone-400/30",
  grey: "bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-200 dark:ring-zinc-400/30",
};
const NEUTRAL = "bg-surface-2 text-ink-muted ring-line";

/** Classes de cor da etiqueta (fundo, texto e contorno) pelo nome da cor do Field Control. */
export function tagTone(color: string | null | undefined): string {
  return TONE[color ?? ""] ?? NEUTRAL;
}

// Base das etiquetas (tamanho e espaçamento ficam com cada uso, sem classes que brigam entre si).
const CHIP_BASE = "inline-flex min-w-0 max-w-full items-center rounded-md font-medium whitespace-nowrap ring-1 ring-inset";
const CHIP = `${CHIP_BASE} px-1.5 py-0.5 text-[11px]`;

/**
 * Etiquetas da OS ou do cliente (ex.: "Ticket Avulso", "Pendente Envio PGTO"). Num espaço estreito com
 * `className="flex-nowrap overflow-hidden"`, cada etiqueta encolhe e corta o nome com reticências.
 */
export function TagChips({ tags, max = 3, className }: { tags?: Tag[] | null; max?: number; className?: string }) {
  if (!tags?.length) return null;
  const shown = tags.slice(0, max);
  const hidden = tags.slice(max).map((t) => t.name).join(", ");
  const rest = tags.length - shown.length;
  return (
    <span className={clsx("inline-flex min-w-0 flex-wrap gap-1", className)}>
      {shown.map((t) => (
        <span key={t.name} className={clsx(CHIP, tagTone(t.color))} title={t.name}>
          <span className="truncate">{t.name}</span>
        </span>
      ))}
      {rest > 0 ? (
        <span className={clsx(CHIP, "shrink-0", NEUTRAL)} title={hidden}>
          <span aria-hidden>+{rest}</span>
          <span className="sr-only">
            Mais {rest} {rest === 1 ? "etiqueta" : "etiquetas"}: {hidden}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** As etiquetas que dizem como a OS é cobrada: uma exclui a outra. */
export const BILLING_TAGS: Tag[] = [
  { name: "Ticket Avulso", color: "green" },
  { name: "Ticket Contratual", color: "pink" },
];

const MAX_TAGS = 20;
const NAME_MAX = 60;
const SUGGESTIONS = 12;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const tidyName = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);

type Suggestion = { key: string; tag: Tag; isNew: boolean };

/**
 * Etiquetas da OS para editar: as escolhidas (tira com o ×, ou Backspace no campo vazio) e um campo
 * que sugere as já usadas nas OS, com a cor de cada uma (as mais usadas primeiro). Enter inclui a
 * destacada ou cria uma nova com o texto digitado; Enter nunca envia o formulário em volta. "Ticket
 * Avulso" e "Ticket Contratual" se excluem: incluir uma tira a outra.
 */
export function TagsInput({
  value,
  onChange,
  inputId,
  labelledBy,
  describedBy,
  invalid,
}: {
  value: Tag[];
  onChange: (tags: Tag[]) => void;
  inputId?: string;
  /** id do rótulo visível do campo. */
  labelledBy?: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const listId = useId();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Aviso para o leitor de tela quando uma etiqueta de cobrança troca a outra.
  const [announce, setAnnounce] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const known = useQuery({ queryKey: ["ticket-tags"], queryFn: () => api.get<Tag[]>("/ticket-tags"), staleTime: 5 * 60_000 });
  const has = (name: string) => value.some((t) => same(t.name, name));
  const full = value.length >= MAX_TAGS;
  const typed = tidyName(draft);

  const suggestions = useMemo<Suggestion[]>(() => {
    const words = searchText(typed).split(/\s+/).filter(Boolean);
    const list: Suggestion[] = (known.data ?? [])
      .filter((t) => !value.some((v) => same(v.name, t.name)) && words.every((w) => searchText(t.name).includes(w)))
      .slice(0, SUGGESTIONS)
      .map((t) => ({ key: `tag-${t.name}`, tag: t, isNew: false }));
    const exists = typed && ((known.data ?? []).some((t) => same(t.name, typed)) || value.some((t) => same(t.name, typed)));
    if (typed && !exists) list.push({ key: "nova", tag: { name: typed, color: null }, isNew: true });
    return list;
  }, [known.data, typed, value]);
  const activeIndex = Math.max(0, Math.min(active, suggestions.length - 1));
  const showList = open && !full && suggestions.length > 0;
  const optionId = (i: number) => `${listId}-o${i}`;

  // A opção destacada pelas setas fica sempre à vista na lista.
  useEffect(() => {
    if (showList) document.getElementById(`${listId}-o${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [showList, activeIndex, listId]);

  const add = (tag: Tag) => {
    const name = tidyName(tag.name);
    setDraft("");
    setActive(0);
    if (!name || has(name) || full) return;
    const color = tag.color ?? known.data?.find((t) => same(t.name, name))?.color ?? null;
    const billing = BILLING_TAGS.find((b) => same(b.name, name));
    const replaced = billing ? value.filter((t) => BILLING_TAGS.some((b) => same(b.name, t.name))) : [];
    const rest = value.filter((t) => !replaced.includes(t));
    onChange([...rest, { name, color }]);
    setAnnounce(replaced.length ? `${name} incluída no lugar de ${replaced.map((t) => t.name).join(", ")}.` : `${name} incluída.`);
  };
  const remove = (tag: Tag) => {
    onChange(value.filter((t) => t !== tag));
    setAnnounce(`${tag.name} retirada.`);
  };

  return (
    <div className="relative">
      <div
        // Clicar no espaço vazio da caixa leva ao campo (como numa caixa de texto comum).
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
        className={clsx(
          "flex min-h-10 cursor-text flex-wrap items-center gap-1.5 rounded-lg border bg-surface px-2 py-1.5 shadow-elev-1 transition-[border-color,box-shadow] duration-150",
          "focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/15 dark:bg-surface-2",
          invalid ? "border-red-500" : "border-line dark:border-line-strong",
        )}
      >
        {value.length ? (
          <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Etiquetas escolhidas">
            {value.map((t) => (
              <li key={t.name} className={clsx(CHIP_BASE, "h-6 gap-0.5 pr-0.5 pl-1.5 text-xs", tagTone(t.color))}>
                <span className="truncate" title={t.name}>
                  {t.name}
                </span>
                <button
                  type="button"
                  onClick={() => remove(t)}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded hover:bg-ink/10 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                  aria-label={`Tirar a etiqueta ${t.name}`}
                >
                  <X aria-hidden className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          ref={inputRef}
          id={inputId}
          value={draft}
          disabled={full}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? optionId(activeIndex) : undefined}
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : "Incluir etiqueta"}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          onChange={(e) => {
            setDraft(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            // Saiu do campo com um nome digitado: a etiqueta entra (como ao apertar Enter).
            if (typed) add({ name: typed, color: null });
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!open) return setOpen(true);
              if (!suggestions.length) return;
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((activeIndex + step + suggestions.length) % suggestions.length);
            } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
              // Enter inclui a etiqueta (não envia o formulário).
              e.preventDefault();
              const pick = showList ? suggestions[activeIndex] : undefined;
              if (pick) add(pick.tag);
              else if (typed) add({ name: typed, color: null });
            } else if (e.key === "Enter" && typed) {
              // Ctrl+Enter com um nome digitado: a etiqueta entra primeiro (o formulário em volta não salva
              // sem ela); o próximo Ctrl+Enter salva.
              e.preventDefault();
              add({ name: typed, color: null });
            } else if (e.key === "Escape" && showList) {
              e.preventDefault();
              setOpen(false);
            } else if (e.key === "Backspace" && !draft && value.length) {
              remove(value[value.length - 1]);
            }
          }}
          maxLength={NAME_MAX}
          placeholder={full ? `Limite de ${MAX_TAGS} etiquetas` : value.length ? "Incluir etiqueta" : "Incluir etiqueta (ex.: Adicional Noturno)"}
          className="h-7 min-w-40 flex-1 bg-transparent px-1 text-sm text-ink outline-none placeholder:text-ink-subtle disabled:cursor-not-allowed"
        />
      </div>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Etiquetas sugeridas"
          // Clicar na lista não tira o foco do campo.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-pop"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              onClick={() => add(s.tag)}
              onMouseMove={() => {
                if (i !== activeIndex) setActive(i);
              }}
              className={clsx("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-ink", i === activeIndex && "bg-surface-2")}
            >
              {s.isNew ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-brand-ink">
                  <Plus aria-hidden className="size-3.5" />
                  Criar etiqueta “{s.tag.name}”
                </span>
              ) : (
                <span className={clsx(CHIP_BASE, "px-1.5 py-0.5 text-xs", tagTone(s.tag.color))}>
                  <span className="truncate">{s.tag.name}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
