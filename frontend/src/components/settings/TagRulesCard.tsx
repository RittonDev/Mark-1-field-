"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Info, Loader2, Plus, RotateCcw, Save, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FieldError, fold, useLeaveGuard } from "@/components/settings/shared";
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
// Sugestões à vista ao digitar (como no campo de etiquetas da OS).
const SUGGESTIONS = 12;

// Cores do Field Control no seletor: o nome em português e o ponto na cor cheia, na ordem do arco-íris.
// O chip da etiqueta usa os tons de tagTone (components/TagChips), os mesmos da Nova OS e do editor da OS.
// A lista Atividades (chamados/_lista/tags.tsx) ainda tem tons próprios, um pouco diferentes.
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

// Espaços como a API conta (str.split do Python): os do \s do JavaScript e mais os separadores U+001C a
// U+001F e U+0085. Assim o nome limpo aqui chega igual na API e a checagem de repetidos dá o mesmo lá.
const SPACES = new RegExp(`[\\s${String.fromCharCode(0x1c)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x85)}]+`, "g");
/** Nome como a API guarda: sem espaços sobrando. */
const clean = (name: string) => name.replace(SPACES, " ").trim();
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

/**
 * O que impede incluir o nome na lista (null: pode incluir). Com isto, as cores só da paleta e as
 * regras salvas já conferidas pela API, as listas nunca ficam fora das regras de PUT /ticket-tag-rules.
 */
function addProblem(name: string, names: string[]): string | null {
  if (name.length > MAX_NAME) return `Use até ${MAX_NAME} caracteres.`;
  if (names.some((n) => nameKey(n) === nameKey(name))) return `“${name}” já está nesta lista.`;
  if (names.length >= MAX_TAGS) return `No máximo ${MAX_TAGS} etiquetas por lista.`;
  return null;
}

/** Etiquetas que o sistema põe e tira sozinho nas OS (como no Field Control). */
export function TagRulesCard({ readOnly = false }: { readOnly?: boolean }) {
  // Releituras (voltar para a aba, reconexão do tempo real) só atualizam a tela quando não há alteração
  // por salvar: o formulário fica montado e decide (ver RulesForm).
  const rules = useQuery(tagRulesQuery);
  return (
    <Card>
      <CardHeader
        title="Etiquetas automáticas"
        description="O sistema põe e tira estas etiquetas sozinho. Vale daqui para frente: salvar não muda as OS que já existem."
      />
      {/* Com as regras na tela, uma releitura que falha (rede caiu) não troca o formulário pelo erro. */}
      {rules.data ? (
        <RulesForm server={rules.data} readOnly={readOnly} />
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

/**
 * O formulário fica montado enquanto a tela estiver aberta (salvar não o recria nem tira o foco do
 * botão). `server`: as regras como estão na API agora (a última leitura ou o que este formulário salvou).
 */
function RulesForm({ server, readOnly }: { server: TicketTagRules; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  // `baseline`: a versão salva em que a tela se baseia; `draft`: o que está na tela.
  const [baseline, setBaseline] = useState(server);
  const [draft, setDraft] = useState(server);
  // Descartar ou restaurar o padrão recria as listas (some o texto digitado e o erro de cada uma).
  const [round, setRound] = useState(0);
  // Aviso para o leitor de tela (etiqueta incluída ou tirada, erro ao incluir).
  const [news, setNews] = useState("");
  // Depois de descartar ou restaurar, o botão clicado some ou desabilita: o foco vai para a 1ª lista.
  const focusFirst = useRef(false);
  // Última versão da API já tratada aqui e a que este formulário acabou de salvar (para reconhecer a volta dela).
  const serverPrint = fingerprint(server);
  const [seen, setSeen] = useState(serverPrint);
  const [ownSave, setOwnSave] = useState<string | null>(null);
  const dirty = fingerprint(draft) !== fingerprint(baseline);
  if (serverPrint !== seen) {
    setSeen(serverPrint);
    if (serverPrint === ownSave || serverPrint === fingerprint(draft)) {
      // Voltou o que este formulário salvou (ou a mesma coisa que está na tela): vira a base. O que foi
      // mexido durante o envio continua como alteração por salvar.
      setBaseline(server);
      setOwnSave(null);
    } else if (!dirty) {
      // Outra pessoa salvou e aqui nada foi mexido: a tela passa para a versão nova.
      setBaseline(server);
      setDraft(server);
    }
    // Com alteração por salvar, o rascunho fica como está; o aviso abaixo oferece ver a versão nova.
  } else if (!dirty && serverPrint !== fingerprint(baseline)) {
    // Depois do aviso, as alterações foram desfeitas à mão: a tela passa para a versão nova.
    setBaseline(server);
    setDraft(server);
  }
  // Outra pessoa salvou outras regras enquanto esta tela tinha alterações por salvar.
  const outdated = dirty && serverPrint !== fingerprint(baseline);
  const known = useQuery({
    queryKey: ["ticket-tags"],
    queryFn: ({ signal }) => api.get<Tag[]>("/ticket-tags", undefined, { signal }),
    staleTime: 5 * 60_000,
    enabled: !readOnly,
  });

  const isDefault = fingerprint(draft) === DEFAULT_FINGERPRINT;
  useLeaveGuard(dirty && !readOnly, "As etiquetas automáticas alteradas ainda não foram salvas.");

  useEffect(() => {
    if (!focusFirst.current) return;
    focusFirst.current = false;
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  });

  // Sugestões ao digitar: as etiquetas já usadas nas OS (as mais usadas primeiro) e as das listas, cada
  // uma na cor escolhida nas listas ou, se não houver, na usada nas OS.
  const suggestionPool = useMemo(() => {
    const inLists = [...draft.on_create, ...draft.on_project, ...draft.on_extra_cost];
    const listColor = new Map<string, string | null>();
    for (const t of inLists) if (!listColor.has(nameKey(t.name))) listColor.set(nameKey(t.name), t.color);
    const done = new Set<string>();
    const out: TagRule[] = [];
    for (const t of [...(known.data ?? []), ...inLists]) {
      const name = clean(t.name);
      const key = nameKey(name);
      if (!name || name.length > MAX_NAME || done.has(key)) continue;
      done.add(key);
      const color = listColor.has(key) ? (listColor.get(key) ?? null) : t.color;
      out.push({ name, color: color && TAG_COLOR_NAMES.includes(color) ? color : null });
    }
    return out;
  }, [known.data, draft]);
  const suggestionsFor = (taken: string[]) => {
    const used = new Set(taken.map(nameKey));
    return suggestionPool.filter((t) => !used.has(nameKey(t.name)));
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
    onSuccess: async (saved, sent) => {
      // Uma releitura que saiu antes de salvar (volta para a aba, reconexão) traria a versão antiga depois
      // desta: é cancelada antes de gravar a resposta no cache.
      await queryClient.cancelQueries({ queryKey: tagRulesQuery.queryKey });
      // Antes de a resposta entrar no cache, o formulário já sabe que ela é desta tela (e não de outra
      // pessoa). A API pode ajustar os nomes: a tela fica com o gravado, e o que foi mexido durante o envio
      // continua como alteração por salvar.
      flushSync(() => {
        setOwnSave(fingerprint(saved));
        setDraft((d) => (fingerprint(d) === fingerprint(sent) ? saved : d));
      });
      queryClient.setQueryData(tagRulesQuery.queryKey, saved);
      toast({
        title: "Etiquetas automáticas salvas",
        description: "Valem para as próximas OS, custos extras e pagamentos.",
        tone: "success",
      });
    },
  });

  // Descartar: a tela volta para a versão da API (a mais nova, se outra pessoa salvou no meio).
  const discard = () => {
    save.reset();
    setBaseline(server);
    reset(server, outdated ? "Alterações descartadas. Na tela, a versão salva por último." : "Alterações descartadas.");
  };

  return (
    <form
      ref={formRef}
      className="grid gap-x-8 gap-y-6 p-5 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        // O botão Salvar fica só com aria-disabled (continua focável): o Enter nele chega aqui.
        if (dirty && !save.isPending) save.mutate(draft);
      }}
    >
      {outdated ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted md:col-span-2"
        >
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            Outra pessoa salvou estas etiquetas enquanto você editava. <strong className="font-semibold text-ink">Descartar</strong>{" "}
            mostra a versão nova; <strong className="font-semibold text-ink">Salvar</strong> troca pela sua.
          </p>
        </div>
      ) : null}
      {TAG_GROUPS.map((g) => (
        <TagList
          key={`${g.key}-${round}`}
          group={g}
          kind="tags"
          tags={draft[g.key]}
          readOnly={readOnly}
          suggestions={suggestionsFor(draft[g.key].map((t) => t.name))}
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
              <Button variant="ghost" onClick={discard} disabled={save.isPending}>
                Descartar
              </Button>
            ) : null}
            {/* Sem `disabled` (nem `loading`, que desabilita): ao salvar, o botão sai do ar e o foco cairia no
                <body>. Com aria-disabled ele continua focável e o teclado segue de onde estava. */}
            <Button
              type="submit"
              variant="primary"
              aria-disabled={!dirty || save.isPending || undefined}
              aria-busy={save.isPending || undefined}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-disabled:active:translate-y-0"
            >
              {save.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Save aria-hidden className="size-4" />}
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

/** Ponto com a cor cheia da etiqueta; sem cor, um círculo tracejado. */
function ColorDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "size-2.5 shrink-0 rounded-full",
        color === null ? "border border-dashed border-ink-subtle" : (COLORS[color]?.dot ?? "bg-ink-subtle"),
      )}
    />
  );
}

// Etiqueta dentro da lista de sugestões (menor que o chip da lista de regras).
const OPTION_CHIP =
  "inline-flex min-w-0 max-w-full items-center rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset";

type Option = { key: string; tag: TagRule; isNew: boolean };

/**
 * Uma lista de etiquetas: os chips (na cor de cada uma, com o ponto para trocar a cor e o × para tirar)
 * e o campo para incluir. O campo funciona como o de etiquetas da OS (TagsInput): sugere as etiquetas já
 * usadas, na cor de cada uma; clique ou Enter inclui a destacada (ou cria com o texto digitado), as setas
 * andam, Esc fecha as sugestões e Backspace no campo vazio tira a última. `kind="names"`: só nomes (a
 * lista de remover); o chip mostra a cor conhecida da etiqueta, sem trocar.
 */
function TagList({
  group,
  kind,
  tags,
  readOnly,
  suggestions,
  onAdd,
  onRemove,
  onRecolor,
}: {
  group: GroupText;
  kind: "tags" | "names";
  tags: TagRule[];
  readOnly: boolean;
  /** Etiquetas conhecidas que ainda não estão nesta lista. */
  suggestions: TagRule[];
  /** Inclui o nome; devolve o motivo quando não dá. */
  onAdd: (name: string) => string | null;
  onRemove: (name: string) => void;
  onRecolor?: (name: string, color: string | null) => void;
}) {
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();
  const listboxId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const full = tags.length >= MAX_TAGS;
  const typed = clean(text);

  // Sugestões que têm todas as palavras digitadas (sem acento); a de nome igual ao digitado vem primeiro.
  // Nome novo: no fim, a opção de criar (ou, na lista de remover, de incluir só o nome).
  const words = fold(typed).split(" ").filter(Boolean);
  const hits = suggestions.filter((t) => words.every((w) => fold(t.name).includes(w)));
  const exact = hits.findIndex((t) => nameKey(t.name) === nameKey(typed));
  if (exact > 0) hits.unshift(...hits.splice(exact, 1));
  const options: Option[] = hits.slice(0, SUGGESTIONS).map((t) => ({ key: `tag-${nameKey(t.name)}`, tag: t, isNew: false }));
  if (typed && exact < 0 && !tags.some((t) => nameKey(t.name) === nameKey(typed))) {
    options.push({ key: "nova", tag: { name: typed, color: null }, isNew: true });
  }
  const activeIndex = Math.max(0, Math.min(active, options.length - 1));
  const showList = open && !full && options.length > 0;
  const optionId = (i: number) => `${listboxId}-o${i}`;

  // A opção destacada pelas setas fica sempre à vista na lista.
  useEffect(() => {
    if (showList) document.getElementById(`${listboxId}-o${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [showList, activeIndex, listboxId]);

  const add = (raw: string) => {
    setActive(0);
    if (!clean(raw)) {
      setText("");
      return;
    }
    const issue = onAdd(raw);
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
          {/* A lista de sugestões abre logo abaixo da caixa, por cima do que vem depois. */}
          <div className="relative">
            <div
              // Clicar no espaço vazio da caixa leva ao campo (como numa caixa de texto comum).
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  e.preventDefault();
                  input.current?.focus();
                  setOpen(true);
                }
              }}
              className={clsx(
                "flex min-h-9 cursor-text flex-wrap items-center gap-1.5 rounded-lg border bg-surface px-1.5 py-1 shadow-elev-1",
                "transition-[border-color,box-shadow] duration-150 focus-within:ring-4 dark:bg-surface-2",
                error
                  ? "border-red-500 focus-within:border-red-500 focus-within:ring-red-500/15"
                  : "border-line focus-within:border-brand focus-within:ring-brand/15 dark:border-line-strong",
              )}
            >
              {tags.length ? (
                <ul ref={list} aria-labelledby={titleId} className="flex max-w-full flex-wrap gap-1.5">
                  {tags.map((t, i) => (
                    <li
                      key={t.name}
                      className={clsx(CHIP, "cursor-default gap-0.5 pr-0.5", kind === "tags" ? "pl-0.5" : "pl-2", tagTone(t.color))}
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
                value={text}
                maxLength={MAX_NAME}
                autoComplete="off"
                role="combobox"
                aria-expanded={showList}
                aria-controls={showList ? listboxId : undefined}
                aria-autocomplete="list"
                aria-activedescendant={showList ? optionId(activeIndex) : undefined}
                onChange={(e) => {
                  setText(e.target.value);
                  setError(null);
                  setActive(0);
                  setOpen(true);
                }}
                onClick={() => setOpen(true)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    if (!showList) {
                      setOpen(true);
                      setActive(e.key === "ArrowDown" ? 0 : options.length - 1);
                      return;
                    }
                    const step = e.key === "ArrowDown" ? 1 : -1;
                    setActive((activeIndex + step + options.length) % options.length);
                  } else if (e.key === "Enter") {
                    // Enter inclui a sugestão destacada ou o texto digitado (nunca envia o formulário).
                    e.preventDefault();
                    const pick = showList ? options[activeIndex] : undefined;
                    if (pick) add(pick.tag.name);
                    else if (typed) add(typed);
                  } else if (e.key === "Escape" && showList) {
                    // Esc fecha só as sugestões.
                    e.preventDefault();
                    setOpen(false);
                  } else if (e.key === "Backspace" && !text && tags.length) {
                    onRemove(tags[tags.length - 1].name);
                    setError(null);
                  }
                }}
                onBlur={() => {
                  setOpen(false);
                  // Saiu do campo com um nome digitado: a etiqueta entra (como ao apertar Enter).
                  if (typed) add(typed);
                }}
                placeholder={
                  full ? `Limite de ${MAX_TAGS} etiquetas` : tags.length ? "Incluir etiqueta" : `Incluir etiqueta (ex.: ${group.example})`
                }
                aria-label={`Incluir etiqueta na lista “${group.title}”`}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${hintId} ${errorId}` : hintId}
                className="h-7 min-w-40 flex-1 bg-transparent px-1 text-sm text-ink outline-none placeholder:text-ink-subtle"
              />
            </div>
            {showList ? (
              <ul
                id={listboxId}
                role="listbox"
                aria-label={`Sugestões para “${group.title}”`}
                // Clicar na lista não tira o foco do campo.
                onMouseDown={(e) => e.preventDefault()}
                className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-pop"
              >
                {options.map((o, i) => (
                  <li
                    key={o.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === activeIndex}
                    onClick={() => add(o.tag.name)}
                    onMouseMove={() => {
                      if (i !== activeIndex) setActive(i);
                    }}
                    className={clsx("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-ink", i === activeIndex && "bg-surface-2")}
                  >
                    {o.isNew ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-brand-ink">
                        <Plus aria-hidden className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {kind === "tags" ? "Criar etiqueta" : "Incluir"} “{o.tag.name}”
                        </span>
                      </span>
                    ) : (
                      <span className={clsx(OPTION_CHIP, tagTone(o.tag.color))}>
                        <span className="truncate">{o.tag.name}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {error ? (
            <FieldError id={errorId}>{error}</FieldError>
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
