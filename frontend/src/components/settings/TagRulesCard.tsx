"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, RotateCcw, Save, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FieldError, useLeaveGuard } from "@/components/settings/shared";
import { tagTone } from "@/components/TagChips";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, ErrorBox, LoadingBlock, SectionTitle } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { DEFAULT_TAG_RULES, TAG_COLOR_NAMES, tagRulesQuery, type TagRule, type TicketTagRules } from "@/lib/tagRules";
import type { Tag } from "@/lib/types";

// Limites de PUT /ticket-tag-rules: nome de 1 a 40 caracteres, sem repetir na lista (maiúsculas não
// contam) e até 10 etiquetas por lista.
const MAX_TAGS = 10;
const MAX_NAME = 40;

// Cores do Field Control no seletor: o nome em português e o ponto na cor cheia, na ordem do arco-íris.
// O chip da etiqueta usa os tons de tagTone (os mesmos das listas de OS e da Nova OS).
const COLORS: Record<string, { label: string; dot: string }> = {
  red: { label: "Vermelho", dot: "bg-red-500" },
  orange: { label: "Laranja", dot: "bg-orange-500" },
  yellow: { label: "Amarelo", dot: "bg-yellow-400" },
  brown: { label: "Marrom", dot: "bg-amber-700" },
  green: { label: "Verde", dot: "bg-emerald-500" },
  teal: { label: "Verde-azulado", dot: "bg-teal-500" },
  "light-blue": { label: "Azul-claro", dot: "bg-sky-500" },
  blue: { label: "Azul", dot: "bg-blue-500" },
  indigo: { label: "Índigo", dot: "bg-indigo-500" },
  purple: { label: "Roxo", dot: "bg-purple-500" },
  pink: { label: "Rosa", dot: "bg-pink-500" },
  "blue-grey": { label: "Cinza-azulado", dot: "bg-slate-500" },
  grey: { label: "Cinza", dot: "bg-zinc-500" },
  "field-pale": { label: "Cinza-claro", dot: "bg-stone-400" },
};

/** Cores do seletor: só as que a API aceita, mais "Sem cor" no fim. */
const PALETTE: (string | null)[] = [...Object.keys(COLORS).filter((c) => TAG_COLOR_NAMES.includes(c)), null];
// A grade de cores desce pela 1ª coluna e continua na 2ª: as setas para cima e para baixo seguem essa
// ordem; as para os lados pulam de coluna.
const PALETTE_ROWS = 8;
// Largura da paleta em px (a classe w-72 do menu).
const MENU_WIDTH = 288;

type TagListKey = "on_create" | "on_project" | "on_extra_cost";

interface GroupText {
  title: string;
  hint: string;
  /** O que acontece com a lista vazia. */
  empty: string;
  example: string;
}

const TAG_GROUPS: (GroupText & { key: TagListKey })[] = [
  {
    key: "on_create",
    title: "Toda OS nova (avulsa)",
    hint: "Entram em toda OS criada sem projeto. Na Nova OS, o analista ainda pode mudar.",
    empty: "Nenhuma: a OS sem projeto sai sem etiqueta.",
    example: "Ticket Avulso",
  },
  {
    key: "on_project",
    title: "OS de projeto",
    hint: "A OS criada dentro de um projeto recebe estas, e não as da avulsa.",
    empty: "Nenhuma: a OS de projeto sai sem etiqueta.",
    example: "Projeto",
  },
  {
    key: "on_extra_cost",
    title: "Ao lançar custo extra",
    hint: "Entram na OS quando um custo extra é lançado nela.",
    empty: "Nenhuma: o custo extra não mexe nas etiquetas.",
    example: "Custo Extra",
  },
];

const REMOVE_GROUP: GroupText = {
  title: "Ao marcar o técnico como pago, remover",
  hint: "Saem da OS quando todos os pagamentos ao técnico dela ficam pagos.",
  empty: "Nenhuma: as etiquetas só saem à mão, na OS.",
  example: "Pendente Envio PGTO",
};

/** Nome como a API guarda: sem espaços sobrando. */
const clean = (name: string) => name.replace(/\s+/g, " ").trim();
/** Chave de comparação: a API trata "ticket avulso" e "Ticket Avulso" como a mesma etiqueta. */
const nameKey = (name: string) => clean(name).toLowerCase();
const colorLabel = (color: string | null) => (color === null ? "Sem cor" : (COLORS[color]?.label ?? color));

/** Conteúdo das regras para comparar (nomes, cores e ordem), sem depender da ordem das chaves do JSON. */
const fingerprint = (r: TicketTagRules) =>
  JSON.stringify([
    ...[r.on_create, r.on_project, r.on_extra_cost].map((list) => list.map((t) => [t.name, t.color])),
    r.remove_on_payout_paid,
  ]);
const DEFAULT_FINGERPRINT = fingerprint(DEFAULT_TAG_RULES);

/** O que impede incluir o nome na lista (null: pode incluir). */
function addProblem(name: string, names: string[]): string | null {
  if (name.length > MAX_NAME) return `Use até ${MAX_NAME} caracteres.`;
  if (names.some((n) => nameKey(n) === nameKey(name))) return `“${name}” já está nesta lista.`;
  if (names.length >= MAX_TAGS) return `No máximo ${MAX_TAGS} etiquetas por lista.`;
  return null;
}

/** Confere a lista inteira com as regras da API antes de salvar (null: tudo certo). */
function listProblem(names: string[], colors: (string | null)[] = []): string | null {
  if (names.length > MAX_TAGS) return `No máximo ${MAX_TAGS} etiquetas por lista: tire ${names.length - MAX_TAGS}.`;
  const seen = new Set<string>();
  for (const raw of names) {
    const name = clean(raw);
    if (!name) return "Há uma etiqueta sem nome.";
    if (name.length > MAX_NAME) return `“${name}” passa de ${MAX_NAME} caracteres.`;
    if (seen.has(nameKey(name))) return `“${name}” aparece duas vezes.`;
    seen.add(nameKey(name));
  }
  if (colors.some((c) => c !== null && !TAG_COLOR_NAMES.includes(c))) return "Uma das cores não é aceita: escolha outra.";
  return null;
}

const tagsProblem = (list: TagRule[]) =>
  listProblem(
    list.map((t) => t.name),
    list.map((t) => t.color),
  );

/** Etiquetas que o sistema põe e tira sozinho nas OS (como no Field Control). */
export function TagRulesCard({ readOnly = false }: { readOnly?: boolean }) {
  const rules = useQuery({
    ...tagRulesQuery,
    // Voltar para a aba no meio da edição não relê: outra versão salva recriaria o formulário e apagaria o digitado.
    refetchOnWindowFocus: false,
  });
  return (
    <Card>
      <CardHeader
        title="Etiquetas automáticas"
        description="O sistema põe e tira estas etiquetas sozinho. Vale daqui para frente: salvar não muda as OS que já existem."
      />
      {/* Com as regras na tela, uma releitura que falha (rede caiu) não troca o formulário pelo erro. */}
      {rules.data ? (
        <RulesForm key={fingerprint(rules.data)} initial={rules.data} readOnly={readOnly} />
      ) : rules.isError ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <ErrorBox message={errorMessage(rules.error)} />
          <Button size="sm" loading={rules.isFetching} onClick={() => rules.refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : (
        <LoadingBlock rows={2} />
      )}
    </Card>
  );
}

function RulesForm({ initial, readOnly }: { initial: TicketTagRules; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(initial);
  // Descartar ou restaurar o padrão recria as listas (some o texto digitado e o erro de cada uma).
  const [round, setRound] = useState(0);
  // Aviso para o leitor de tela (etiqueta incluída ou tirada, erro ao incluir).
  const [news, setNews] = useState("");
  // Depois de descartar ou restaurar, o botão clicado some ou desabilita: o foco vai para a 1ª lista.
  const focusFirst = useRef(false);
  const known = useQuery({
    queryKey: ["ticket-tags"],
    queryFn: ({ signal }) => api.get<Tag[]>("/ticket-tags", undefined, { signal }),
    staleTime: 5 * 60_000,
    enabled: !readOnly,
  });

  const dirty = fingerprint(draft) !== fingerprint(initial);
  const isDefault = fingerprint(draft) === DEFAULT_FINGERPRINT;
  useLeaveGuard(dirty && !readOnly, "As etiquetas automáticas alteradas ainda não foram salvas.");

  useEffect(() => {
    if (!focusFirst.current) return;
    focusFirst.current = false;
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  });

  const problems = {
    on_create: tagsProblem(draft.on_create),
    on_project: tagsProblem(draft.on_project),
    on_extra_cost: tagsProblem(draft.on_extra_cost),
    remove_on_payout_paid: listProblem(draft.remove_on_payout_paid),
  };
  const invalid = Object.values(problems).some(Boolean);

  // Sugestões ao digitar: as etiquetas já usadas nas OS (as mais usadas primeiro) e as das listas.
  const suggestionPool = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [...(known.data ?? []), ...draft.on_create, ...draft.on_project, ...draft.on_extra_cost]) {
      const name = clean(t.name);
      if (!name || name.length > MAX_NAME || seen.has(nameKey(name))) continue;
      seen.add(nameKey(name));
      out.push(name);
    }
    return out;
  }, [known.data, draft]);
  const suggestionsFor = (taken: string[]) => {
    const used = new Set(taken.map(nameKey));
    return suggestionPool.filter((n) => !used.has(nameKey(n)));
  };

  /** A etiqueta pelo nome, com a cor escolhida nas listas ou, se não houver, a usada nas OS. */
  const lookup = (name: string): TagRule | null => {
    const key = nameKey(name);
    const found =
      [...draft.on_create, ...draft.on_project, ...draft.on_extra_cost].find((t) => nameKey(t.name) === key) ??
      known.data?.find((t) => nameKey(t.name) === key);
    if (!found) return null;
    return { name: clean(found.name), color: found.color && TAG_COLOR_NAMES.includes(found.color) ? found.color : null };
  };

  const addTag = (key: TagListKey, title: string, raw: string): string | null => {
    const name = clean(raw);
    const problem = addProblem(name, draft[key].map((t) => t.name));
    if (problem) {
      setNews(problem);
      return problem;
    }
    const tag = lookup(name) ?? { name, color: null };
    setDraft((d) => ({ ...d, [key]: [...d[key], tag] }));
    setNews(`Lista “${title}”: ${tag.name} incluída.`);
    return null;
  };
  const removeTag = (key: TagListKey, title: string, name: string) => {
    setDraft((d) => ({ ...d, [key]: d[key].filter((t) => t.name !== name) }));
    setNews(`Lista “${title}”: ${name} tirada.`);
  };
  // A cor é da etiqueta: trocar numa lista troca nas outras (a mesma etiqueta não fica com duas cores).
  const recolor = (name: string, color: string | null) => {
    const key = nameKey(name);
    const paint = (list: TagRule[]) => list.map((t) => (nameKey(t.name) === key ? { ...t, color } : t));
    setDraft((d) => ({ ...d, on_create: paint(d.on_create), on_project: paint(d.on_project), on_extra_cost: paint(d.on_extra_cost) }));
  };
  const addName = (raw: string): string | null => {
    const name = clean(raw);
    const problem = addProblem(name, draft.remove_on_payout_paid);
    if (problem) {
      setNews(problem);
      return problem;
    }
    const canonical = lookup(name)?.name ?? name;
    setDraft((d) => ({ ...d, remove_on_payout_paid: [...d.remove_on_payout_paid, canonical] }));
    setNews(`Lista “${REMOVE_GROUP.title}”: ${canonical} incluída.`);
    return null;
  };
  const removeName = (name: string) => {
    setDraft((d) => ({ ...d, remove_on_payout_paid: d.remove_on_payout_paid.filter((n) => n !== name) }));
    setNews(`Lista “${REMOVE_GROUP.title}”: ${name} tirada.`);
  };

  const reset = (next: TicketTagRules, message: string) => {
    setDraft(next);
    setRound((r) => r + 1);
    setNews(message);
    focusFirst.current = true;
  };

  const save = useMutation({
    mutationFn: (body: TicketTagRules) => api.put<TicketTagRules>("/ticket-tag-rules", body),
    onSuccess: (saved) => {
      queryClient.setQueryData(tagRulesQuery.queryKey, saved);
      toast({
        title: "Etiquetas automáticas salvas",
        description: "Valem para as próximas OS, custos extras e pagamentos.",
        tone: "success",
      });
    },
  });

  return (
    <form
      ref={formRef}
      className="grid gap-x-8 gap-y-6 p-5 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) save.mutate(draft);
      }}
    >
      {TAG_GROUPS.map((g) => (
        <TagList
          key={`${g.key}-${round}`}
          group={g}
          kind="tags"
          tags={draft[g.key]}
          readOnly={readOnly}
          suggestions={suggestionsFor(draft[g.key].map((t) => t.name))}
          problem={problems[g.key]}
          onAdd={(name) => addTag(g.key, g.title, name)}
          onRemove={(name) => removeTag(g.key, g.title, name)}
          onRecolor={recolor}
        />
      ))}
      <TagList
        key={`remove-${round}`}
        group={REMOVE_GROUP}
        kind="names"
        tags={draft.remove_on_payout_paid.map((name) => ({ name, color: lookup(name)?.color ?? null }))}
        readOnly={readOnly}
        suggestions={suggestionsFor(draft.remove_on_payout_paid)}
        problem={problems.remove_on_payout_paid}
        onAdd={addName}
        onRemove={removeName}
      />
      {readOnly ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3 md:col-span-2">
          <p aria-live="polite" className="sr-only">
            {news}
          </p>
          <Button
            variant="ghost"
            onClick={() => reset(DEFAULT_TAG_RULES, "Etiquetas padrão na tela. Salve para valer.")}
            disabled={isDefault || save.isPending}
          >
            <RotateCcw className="size-4" />
            Restaurar padrão
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span aria-live="polite" className="text-xs font-semibold text-ink-muted">
              {dirty ? "Alterações não salvas" : null}
            </span>
            {dirty ? (
              <Button variant="ghost" onClick={() => reset(initial, "Alterações descartadas.")} disabled={save.isPending}>
                Descartar
              </Button>
            ) : null}
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
              <Save className="size-4" />
              Salvar etiquetas
            </Button>
          </div>
        </div>
      )}
      {save.error ? (
        <div className="md:col-span-2">
          <ErrorBox message={errorMessage(save.error)} />
        </div>
      ) : null}
    </form>
  );
}

// Chip da etiqueta; a cor (fundo, texto e contorno) vem de tagTone.
const CHIP = "inline-flex h-7 max-w-full min-w-0 items-center rounded-md text-xs font-medium whitespace-nowrap ring-1 ring-inset";

/** Ponto com a cor da etiqueta; sem cor, um círculo tracejado. */
function ColorDot({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "size-2.5 shrink-0 rounded-full",
        color === null ? "border border-dashed border-ink-subtle" : (COLORS[color]?.dot ?? "bg-ink-subtle"),
        className,
      )}
    />
  );
}

/**
 * Uma lista de etiquetas: os chips (na cor de cada uma, com o ponto para trocar a cor e o × para tirar)
 * e o campo para incluir, com as etiquetas já usadas como sugestão. `kind="names"`: só nomes (a lista
 * de remover); o chip mostra a cor conhecida da etiqueta, sem trocar.
 */
function TagList({
  group,
  kind,
  tags,
  readOnly,
  suggestions,
  problem,
  onAdd,
  onRemove,
  onRecolor,
}: {
  group: GroupText;
  kind: "tags" | "names";
  tags: TagRule[];
  readOnly: boolean;
  suggestions: string[];
  /** Problema da lista inteira (impede salvar). */
  problem: string | null;
  /** Inclui o nome; devolve o motivo quando não dá. */
  onAdd: (name: string) => string | null;
  onRemove: (name: string) => void;
  onRecolor?: (name: string, color: string | null) => void;
}) {
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const shownError = error ?? problem;
  const full = tags.length >= MAX_TAGS;

  const add = () => {
    if (!clean(text)) {
      setText("");
      return;
    }
    const issue = onAdd(text);
    setError(issue);
    if (!issue) setText("");
  };
  // Tirou um chip: o foco vai para o × do seguinte (ou do anterior, ou para o campo), não se perde.
  const remove = (index: number, name: string) => {
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>("[data-remove]");
    const next = buttons?.[index + 1] ?? buttons?.[index - 1] ?? input.current;
    onRemove(name);
    setError(null);
    next?.focus();
  };

  return (
    <div role="group" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2.5">
      <div>
        <SectionTitle wrap>
          <span id={titleId}>{group.title}</span>
        </SectionTitle>
        <p id={hintId} className="mt-1 text-xs text-ink-muted">
          {group.hint}
        </p>
      </div>
      {readOnly ? (
        tags.length ? (
          <ul aria-labelledby={titleId} className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <li key={t.name} className={clsx(CHIP, "px-2", tagTone(t.color))}>
                <span className="min-w-0 truncate" title={t.name}>
                  {t.name}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-subtle">{group.empty}</p>
        )
      ) : (
        <>
          <div
            className={clsx(
              "flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border bg-surface px-1.5 py-1 shadow-elev-1 focus-within:ring-4",
              shownError
                ? "border-red-500 focus-within:border-red-500 focus-within:ring-red-500/15"
                : "border-line focus-within:border-brand focus-within:ring-brand/15",
            )}
          >
            {tags.length ? (
              <ul ref={list} aria-labelledby={titleId} className="flex max-w-full flex-wrap gap-1.5">
                {tags.map((t, i) => (
                  <li
                    key={t.name}
                    className={clsx(CHIP, "gap-0.5 pr-0.5", kind === "tags" ? "pl-0.5" : "pl-2", tagTone(t.color))}
                  >
                    {kind === "tags" ? <ColorMenu tag={t} onPick={(color) => onRecolor?.(t.name, color)} /> : null}
                    <span className="min-w-0 truncate px-0.5" title={t.name}>
                      {t.name}
                    </span>
                    <button
                      type="button"
                      data-remove
                      onClick={() => remove(i, t.name)}
                      aria-label={`Tirar ${t.name} da lista “${group.title}”`}
                      title="Tirar da lista"
                      className="flex size-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-ink/10 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <input
              ref={input}
              list={listId}
              value={text}
              maxLength={MAX_NAME}
              autoComplete="off"
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                // Enter inclui a etiqueta (não envia o formulário).
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  add();
                }
              }}
              onBlur={() => {
                if (clean(text)) add();
              }}
              placeholder={
                full ? `Limite de ${MAX_TAGS} etiquetas` : tags.length ? "Incluir etiqueta" : `Incluir etiqueta (ex.: ${group.example})`
              }
              aria-label={`Incluir etiqueta na lista “${group.title}”`}
              aria-invalid={shownError ? true : undefined}
              aria-describedby={shownError ? `${hintId} ${errorId}` : hintId}
              className="h-7 min-w-40 flex-1 bg-transparent px-1 text-sm text-ink outline-none placeholder:text-ink-subtle"
            />
            <datalist id={listId}>
              {suggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          {shownError ? (
            <FieldError id={errorId}>{shownError}</FieldError>
          ) : tags.length === 0 ? (
            <p className="text-xs text-ink-subtle">{group.empty}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

const menuItems = (root: HTMLElement | null) =>
  Array.from(root?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);

/**
 * Cor da etiqueta: o ponto do chip abre a paleta do Field Control. Teclado no padrão de menu: abre com
 * o foco na cor atual, setas, Home e End andam, Enter ou espaço escolhem, Esc fecha e devolve o foco
 * ao ponto, e sair com o Tab fecha a paleta.
 */
function ColorMenu({ tag, onPick }: { tag: TagRule; onPick: (color: string | null) => void }) {
  const [open, setOpen] = useState(false);
  // Deslocamento para a esquerda (px) quando a paleta passaria da borda direita da tela.
  const [shift, setShift] = useState(0);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const items = menuItems(wrap.current);
    (items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    // A paleta tem no máximo a largura da tela menos 16 px de cada lado (como a classe max-w do menu).
    const width = Math.min(MENU_WIDTH, window.innerWidth - 32);
    setShift(rect ? Math.min(0, window.innerWidth - 16 - width - rect.left) : 0);
    setOpen(true);
  };
  const hide = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" && e.target === trigger.current) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      // Esc fecha só a paleta (e não o que estiver em volta).
      e.preventDefault();
      hide(true);
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    const items = menuItems(wrap.current);
    const last = items.length - 1;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = i < 0 || i === last ? 0 : i + 1;
    else if (e.key === "ArrowUp") next = i <= 0 ? last : i - 1;
    else if (e.key === "ArrowRight") next = i >= 0 && i + PALETTE_ROWS <= last ? i + PALETTE_ROWS : Math.max(i, 0);
    else if (e.key === "ArrowLeft") next = i - PALETTE_ROWS >= 0 ? i - PALETTE_ROWS : Math.max(i, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <span
      ref={wrap}
      className="relative inline-flex"
      onKeyDown={onKeyDown}
      // Foco foi para fora (Tab, clique em outro campo): a paleta fecha.
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (open && next && !e.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        onClick={() => (open ? hide(false) : show())}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Trocar a cor de ${tag.name} (agora: ${colorLabel(tag.color).toLowerCase()})`}
        title="Trocar a cor"
        className="flex size-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-ink/10 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none aria-expanded:bg-ink/10"
      >
        <ColorDot color={tag.color} />
      </button>
      {open ? (
        // role="menu": a paleta conta como a camada de cima (o Esc dos diálogos e do painel da OS espera por ela).
        <div
          id={menuId}
          role="menu"
          aria-label={`Cor de ${tag.name}`}
          style={{ left: shift }}
          className="absolute top-full z-40 mt-1.5 grid w-72 max-w-[calc(100vw-2rem)] animate-pop auto-cols-fr grid-flow-col grid-rows-8 gap-0.5 rounded-xl border border-line bg-surface p-1.5 shadow-pop"
        >
          {PALETTE.map((color) => {
            const checked = color === tag.color;
            return (
              <button
                key={color ?? "none"}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                tabIndex={-1}
                onClick={() => {
                  onPick(color);
                  hide(true);
                }}
                className={clsx(
                  "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink outline-none",
                  "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus",
                  checked && "font-semibold",
                )}
              >
                <ColorDot color={color} />
                <span className="truncate">{colorLabel(color)}</span>
                {checked ? <Check aria-hidden className="ml-auto size-3.5 shrink-0 text-brand" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
