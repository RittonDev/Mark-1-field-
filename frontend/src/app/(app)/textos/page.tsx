"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { FieldError, fold, plural, SearchField, UnsavedBar, useLeaveGuard } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import { Button, Card, ErrorBox, Field, Input, LoadingBlock, PageHeader, SectionTitle, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";

interface Template {
  key?: string | null;
  name: string;
  body: string;
}
interface Variable {
  key: string;
  description: string;
}
interface TemplatesOut {
  templates: Template[];
  variables: Variable[];
}
/** Texto em edição. `uid` identifica o cartão na tela (não vai para a API). */
interface Item extends Template {
  uid: string;
}

// Limites de backend/app/schemas/messages.py.
const MAX_TEMPLATES = 30;
const MAX_NAME = 60;
const MAX_BODY = 2000;

/** Exemplo para a prévia, com dados inventados (na OS, a API preenche com os dados reais). */
function sampleValues(origin: string): Record<string, string> {
  return {
    tecnico: "Carlos Souza",
    equipe: "Carlos Souza e Diego Lima",
    tecnico_telefone: "(11) 90000-0000",
    os: "OS-000123",
    titulo: "PDV 3 sem rede",
    cliente: "Rede Exemplo",
    local: "Loja 27 - Shopping Centro",
    cidade: "São Paulo",
    endereco: "Rua das Flores, 100, Centro, São Paulo-SP",
    mapa: "https://maps.google.com/?q=-23.55,-46.63",
    contato: "Ana (gerente) · (11) 3000-0000",
    agendamento: "13/11 às 10:00",
    hora_agendada: "10:00",
    chegada_prevista: "14:35",
    distancia: "6 km",
    agora: "14:10",
    hoje: "13/11",
    status: "Em deslocamento",
    prioridade: "P2 Alta",
    solucao: "Switch reiniciado e cabo do PDV substituído.",
    motivo_improdutiva: "Cliente ausente ou local fechado",
    projeto: "Recabeamento lojas Zona Sul",
    analista: "Bruno Martins",
    link_relatorio: `${origin}/relatorio/exemplo`,
    prazo_chegada: "14:30",
  };
}

// Grupos da lista de variáveis (as que a API mandar e não estiverem aqui vão para "Outras").
const GROUPS: { label: string; keys: string[] }[] = [
  { label: "OS", keys: ["os", "titulo", "status", "prioridade", "analista", "projeto", "solucao", "motivo_improdutiva"] },
  { label: "Técnico", keys: ["tecnico", "equipe", "tecnico_telefone", "chegada_prevista", "distancia"] },
  { label: "Cliente e local", keys: ["cliente", "local", "cidade", "endereco", "mapa", "contato"] },
  { label: "Datas e horários", keys: ["agendamento", "hora_agendada", "prazo_chegada", "agora", "hoje"] },
  { label: "Links", keys: ["link_relatorio"] },
];

// Variável entre chaves (como o \w da API, com as letras acentuadas).
const VAR_RE = /\{([0-9A-Za-z_À-ÿ]+)\}/g;
// Marcas do WhatsApp: ```mono```, *negrito*, _itálico_ e ~riscado~.
const FORMAT_RE = /```([\s\S]+?)```|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~/g;
// Na prévia, cada variável vira uma marca de posição (caracteres de uso privado, que ninguém
// digita): assim o "_" de {link_relatorio} não vira itálico.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);

let uidSeq = 0;
const newUid = () => `t${(uidSeq += 1)}`;
const withUids = (templates: Template[], keep: Item[] = []): Item[] =>
  templates.map((t, i) => ({ ...t, uid: keep[i]?.uid ?? newUid() }));

const plain = (list: Template[]) => JSON.stringify(list.map((t) => ({ key: t.key ?? null, name: t.name, body: t.body })));
const sameTemplates = (a: Template[], b: Template[]) => plain(a) === plain(b);

/** Variáveis do texto que a API não conhece (sairiam cruas na mensagem). */
function unknownVariables(body: string, known: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(VAR_RE)) if (!known.has(m[1])) found.add(m[1]);
  return [...found];
}

interface Token {
  key: string;
  raw: string;
}

/** Prévia como no WhatsApp: variáveis trocadas pelo exemplo e as marcas de formatação aplicadas. */
function renderPreview(body: string, values: Record<string, string>, variables: Map<string, string>): React.ReactNode {
  const tokens: Token[] = [];
  const text = body
    .replace(VAR_RE, (raw, key: string) => {
      tokens.push({ key, raw });
      return `${OPEN}${tokens.length - 1}${CLOSE}`;
    })
    // Como a API: parênteses vazios de variável em branco saem (ex.: cidade não cadastrada).
    .replace(/ \(\)/g, "")
    .trim();

  const tokenNode = (token: Token, key: string) => {
    const value = values[token.key];
    if (value !== undefined) {
      return (
        <span key={key} title={`{${token.key}}`} className="underline decoration-ink-subtle/50 decoration-dotted underline-offset-2">
          {value}
        </span>
      );
    }
    if (variables.has(token.key)) {
      return (
        <code key={key} title={variables.get(token.key)} className="rounded bg-ink/[0.06] px-1 text-[0.92em]">
          {token.raw}
        </code>
      );
    }
    return (
      <mark key={key} title="Variável desconhecida: sai assim na mensagem" className="rounded bg-red-50 px-0.5 text-red-700 dark:bg-red-500/10 dark:text-red-300">
        {token.raw}
      </mark>
    );
  };

  const expand = (chunk: string, prefix: string): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    chunk.split(OPEN).forEach((part, i) => {
      if (i === 0) {
        if (part) out.push(part);
        return;
      }
      const end = part.indexOf(CLOSE);
      const token = end > 0 ? tokens[Number(part.slice(0, end))] : undefined;
      if (!token) {
        out.push(part);
        return;
      }
      out.push(tokenNode(token, `${prefix}-v${i}`));
      if (part.length > end + 1) out.push(part.slice(end + 1));
    });
    return out;
  };

  const format = (chunk: string, prefix: string): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    let last = 0;
    for (const m of chunk.matchAll(FORMAT_RE)) {
      const start = m.index ?? 0;
      const key = `${prefix}-${start}`;
      if (start > last) out.push(...expand(chunk.slice(last, start), `${key}a`));
      const [whole, mono, bold, italic, strike] = m;
      if (mono !== undefined) {
        out.push(
          <code key={key} className="rounded bg-ink/[0.06] px-1 font-mono text-[0.92em]">
            {expand(mono, key)}
          </code>,
        );
      } else if (bold !== undefined) {
        out.push(
          <strong key={key} className="font-semibold">
            {format(bold, key)}
          </strong>,
        );
      } else if (italic !== undefined) {
        out.push(<em key={key}>{format(italic, key)}</em>);
      } else {
        out.push(<s key={key}>{format(strike, key)}</s>);
      }
      last = start + whole.length;
    }
    if (last < chunk.length) out.push(...expand(chunk.slice(last), `${prefix}-${last}z`));
    return out;
  };

  return format(text, "p");
}

export default function TemplatesPage() {
  const { user } = useAuth();
  const allowed = !user || canManageTickets(user.role);
  const data = useQuery({
    queryKey: ["message-templates"],
    queryFn: () => api.get<TemplatesOut>("/message-templates"),
    enabled: allowed,
    // Sem releitura ao voltar para a aba no meio da edição (o editor avisa se outra pessoa salvou).
    refetchOnWindowFocus: false,
  });
  if (user && !allowed) return <ErrorBox message="Os textos do WhatsApp são mantidos por analistas e gestores." />;
  if (data.isLoading) return <LoadingBlock />;
  if (!data.data) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Textos do WhatsApp" />
        <Card className="flex flex-col items-start gap-3 p-4">
          <ErrorBox message={data.error ? errorMessage(data.error) : "Não foi possível carregar os textos."} />
          <Button size="sm" loading={data.isFetching} onClick={() => data.refetch()}>
            Tentar de novo
          </Button>
        </Card>
      </div>
    );
  }
  return <Editor server={data.data} />;
}

/** Variáveis por grupo, filtradas pelo texto digitado (sem acento). */
function groupVariables(variables: Variable[], filter: string) {
  const q = fold(filter.trim());
  const match = (v: Variable) => !q || fold(`${v.key} ${v.description}`).includes(q);
  const byKey = new Map(variables.map((v) => [v.key, v]));
  const grouped = new Set(GROUPS.flatMap((g) => g.keys));
  const list = GROUPS.map((g) => ({
    label: g.label,
    vars: g.keys.map((k) => byKey.get(k)).filter((v): v is Variable => !!v && match(v)),
  }));
  list.push({ label: "Outras", vars: variables.filter((v) => !grouped.has(v.key) && match(v)) });
  return list.filter((g) => g.vars.length > 0);
}

/** O que vai para a API: textos aparados (o uid fica só na tela). */
const outgoing = (list: Template[]): Template[] =>
  list.map((t) => ({ key: t.key ?? null, name: t.name.trim(), body: t.body.trim() }));

type FocusTarget = "name" | "up" | "down";

interface ItemProblems {
  name?: string;
  body?: string;
}

function Editor({ server }: { server: TemplatesOut }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<Item[]>(() => withUids(server.templates));
  // A última versão salva (para saber o que mudou) e a última que chegou da API.
  const [baseline, setBaseline] = useState<Template[]>(server.templates);
  const [seen, setSeen] = useState<Template[]>(server.templates);
  const [remoteChanged, setRemoteChanged] = useState(false);
  // Cartão que recebe as variáveis clicadas na lateral (o último texto em que o cursor esteve).
  const [targetUid, setTargetUid] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ item: Item; index: number } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [filter, setFilter] = useState("");
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  const cards = useRef(new Map<string, HTMLDivElement>());
  const pendingFocus = useRef<{ uid: string; target: FocusTarget } | "undo" | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);

  const dirty = !sameTemplates(items, baseline);
  useLeaveGuard(dirty, "Os textos editados ainda não foram salvos.");

  // Outra pessoa salvou enquanto a tela estava aberta: sem edição aqui, a tela adota a versão
  // nova; com edição, avisa (salvar agora substitui a versão dela).
  if (server.templates !== seen) {
    setSeen(server.templates);
    if (!sameTemplates(server.templates, baseline)) {
      if (dirty) {
        setRemoteChanged(true);
      } else {
        setItems(withUids(server.templates));
        setBaseline(server.templates);
      }
    }
  }

  const values = useMemo(() => sampleValues(typeof window === "undefined" ? "" : window.location.origin), []);
  const variables = useMemo(() => new Map(server.variables.map((v) => [v.key, v.description])), [server.variables]);
  const known = useMemo(() => new Set(server.variables.map((v) => v.key)), [server.variables]);
  const allGroups = useMemo(() => groupVariables(server.variables, ""), [server.variables]);
  const shownGroups = useMemo(() => groupVariables(server.variables, filter), [server.variables, filter]);
  const problems = useMemo(() => {
    const out = new Map<string, ItemProblems>();
    // Nome do botão como a API guarda (espaços seguidos viram um), sem acento e sem maiúscula.
    const nameKey = (t: Template) => fold(t.name.trim().replace(/\s+/g, " "));
    const uses = new Map<string, number>();
    for (const t of items) uses.set(nameKey(t), (uses.get(nameKey(t)) ?? 0) + 1);
    for (const t of items) {
      const p: ItemProblems = {};
      if (!t.name.trim()) p.name = "Dê um nome ao botão.";
      else if ((uses.get(nameKey(t)) ?? 0) > 1) p.name = "Outro texto já tem este nome: na OS, os dois botões ficariam iguais.";
      if (!t.body.trim()) p.body = "Escreva o texto do aviso.";
      if (p.name || p.body) out.set(t.uid, p);
    }
    return out;
  }, [items]);
  const unknown = useMemo(() => new Map(items.map((t) => [t.uid, unknownVariables(t.body, known)])), [items, known]);
  const target = items.find((t) => t.uid === targetUid) ?? items[0];
  const labelOf = (t: Item) => t.name.trim() || `texto ${items.indexOf(t) + 1}`;
  const full = items.length >= MAX_TEMPLATES;

  // Foco depois de mover, remover ou incluir (sem isso ele caía no <body> quando o botão sumia).
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    if (pending === "undo") {
      undoButton.current?.focus();
      return;
    }
    const card = cards.current.get(pending.uid);
    if (!card) return;
    const pick = (t: FocusTarget) => card.querySelector<HTMLInputElement | HTMLButtonElement>(`[data-focus="${t}"]`);
    const el = pick(pending.target);
    if (el && !el.disabled) el.focus();
    else pick(pending.target === "up" ? "down" : "up")?.focus();
  });

  /** Versão que a API devolveu vira a referência (o que está salvo) e vale para as OS. */
  const adopt = (r: TemplatesOut) => {
    setBaseline(r.templates);
    setSeen(r.templates);
    setRemoteChanged(false);
    setRemoved(null);
    setShowErrors(false);
    queryClient.setQueryData(["message-templates"], r);
    // O painel de textos de cada OS relê com os modelos novos.
    queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "ticket" && q.queryKey[2] === "messages" });
  };
  const save = useMutation({
    mutationFn: (templates: Template[]) => api.put<TemplatesOut>("/message-templates", { templates }),
    onSuccess: (r, sent) => {
      // Quem digitou enquanto salvava continua com o que digitou (e com o aviso de não salvo).
      setItems((current) => (sameTemplates(outgoing(current), sent) ? withUids(r.templates, current) : current));
      adopt(r);
      toast({ title: "Textos salvos", description: "Os textos novos já aparecem nas OS.", tone: "success" });
    },
  });
  const reset = useMutation({
    mutationFn: () => api.post<TemplatesOut>("/message-templates/reset"),
    onSuccess: (r) => {
      setItems(withUids(r.templates));
      adopt(r);
      toast({ title: "Textos padrão restaurados", tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível restaurar os textos padrão", description: errorMessage(e), tone: "error" }),
  });

  const update = (uid: string, patch: Partial<Template>) =>
    setItems((list) => list.map((t) => (t.uid === uid ? { ...t, ...patch } : t)));

  const insert = (varKey: string, uid: string) => {
    const item = items.find((t) => t.uid === uid);
    if (!item) return;
    const area = areas.current.get(uid);
    const token = `{${varKey}}`;
    const start = area?.selectionStart ?? item.body.length;
    const end = area?.selectionEnd ?? item.body.length;
    if (item.body.length - (end - start) + token.length > MAX_BODY) {
      toast({ title: `O texto passaria de ${MAX_BODY.toLocaleString("pt-BR")} caracteres`, tone: "error" });
      return;
    }
    update(uid, { body: item.body.slice(0, start) + token + item.body.slice(end) });
    setTargetUid(uid);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const restructure = (next: Item[], focus: { uid: string; target: FocusTarget } | "undo") => {
    setItems(next);
    pendingFocus.current = focus;
  };
  const move = (index: number, delta: -1 | 1) => {
    const j = index + delta;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[index], next[j]] = [next[j], next[index]];
    setRemoved(null);
    restructure(next, { uid: next[j].uid, target: delta < 0 ? "up" : "down" });
  };
  const remove = (index: number) => {
    setRemoved({ item: items[index], index });
    restructure(
      items.filter((_, i) => i !== index),
      "undo",
    );
  };
  const undo = () => {
    if (!removed) return;
    const index = Math.min(removed.index, items.length);
    setRemoved(null);
    restructure([...items.slice(0, index), removed.item, ...items.slice(index)], { uid: removed.item.uid, target: "name" });
  };
  const add = () => {
    const item: Item = { uid: newUid(), key: null, name: "", body: "*{os}* · {cliente}\n" };
    setRemoved(null);
    setTargetUid(item.uid);
    restructure([...items, item], { uid: item.uid, target: "name" });
  };

  const trySave = async () => {
    if (problems.size) {
      setShowErrors(true);
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>('[data-textos] [aria-invalid="true"]');
        el?.scrollIntoView({ block: "center" });
        el?.focus({ preventScroll: true });
      });
      return;
    }
    const withUnknown = items.filter((t) => (unknown.get(t.uid) ?? []).length > 0);
    if (withUnknown.length) {
      const ok = await confirm({
        title: "Salvar com variável desconhecida?",
        description: (
          <div className="flex flex-col gap-2">
            <p>Estas variáveis não existem e vão sair assim, sem trocar, na mensagem:</p>
            <ul className="list-disc pl-5">
              {withUnknown.map((t) => (
                <li key={t.uid}>
                  “{labelOf(t)}”: {(unknown.get(t.uid) ?? []).map((k) => `{${k}}`).join(", ")}
                </li>
              ))}
            </ul>
          </div>
        ),
        confirmLabel: "Salvar assim",
        cancelLabel: "Voltar e corrigir",
      });
      if (!ok) return;
    }
    save.mutate(outgoing(items));
  };

  const discard = async () => {
    const ok = await confirm({
      title: "Descartar as alterações?",
      description: "Os textos voltam a ficar como estão salvos.",
      confirmLabel: "Descartar",
      cancelLabel: "Continuar editando",
      tone: "danger",
    });
    if (!ok) return;
    setItems(withUids(server.templates));
    setBaseline(server.templates);
    setSeen(server.templates);
    setRemoteChanged(false);
    setRemoved(null);
    setShowErrors(false);
  };

  const askReset = async () => {
    const ok = await confirm({
      title: "Voltar aos textos padrão?",
      description: "Todos os textos voltam aos originais: os editados e os criados aqui são substituídos.",
      confirmLabel: "Voltar ao padrão",
      tone: "danger",
    });
    if (ok) reset.mutate();
  };

  const removedNotice = (r: { item: Item }) => (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-line-strong px-4 py-2 text-sm text-ink-muted"
    >
      <span className="min-w-0 truncate">Texto removido{r.item.name.trim() ? `: “${r.item.name.trim()}”` : ""}</span>
      <Button ref={undoButton} size="sm" variant="ghost" onClick={undo}>
        Desfazer
      </Button>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl" data-textos>
      <PageHeader
        title="Textos do WhatsApp"
        description="Avisos que o analista copia na OS para o grupo de WhatsApp dos técnicos. As palavras entre chaves, como {tecnico}, são trocadas pelos dados da OS."
        actions={
          <>
            <Button variant="ghost" loading={reset.isPending} onClick={askReset}>
              <RotateCcw className="size-4" />
              Restaurar padrão
            </Button>
            <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={trySave}>
              Salvar textos
            </Button>
          </>
        }
      />
      {remoteChanged ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <p>Outra pessoa salvou os textos enquanto você editava. Se você salvar agora, a versão dela será substituída.</p>
          <Button size="sm" variant="ghost" onClick={discard}>
            Ver a versão salva
          </Button>
        </div>
      ) : null}
      {showErrors && problems.size ? (
        <div className="mb-4">
          <ErrorBox
            message={`Antes de salvar, corrija ${plural(problems.size, "texto", "textos")}: cada um precisa de um nome só dele e de conteúdo.`}
          />
        </div>
      ) : null}
      {save.error ? (
        <div className="mb-4">
          <ErrorBox message={errorMessage(save.error)} />
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-w-0 flex-col gap-3">
          {items.map((t, i) => {
            const p = showErrors ? problems.get(t.uid) : undefined;
            const missing = unknown.get(t.uid) ?? [];
            const label = labelOf(t);
            const isTarget = items.length > 1 && t.uid === target.uid;
            const bodyHelp = [p?.body ? `${t.uid}-texto-erro` : null, missing.length ? `${t.uid}-variaveis` : null]
              .filter(Boolean)
              .join(" ");
            return (
              <Fragment key={t.uid}>
                {removed && removed.index === i ? removedNotice(removed) : null}
                <div
                  ref={(el) => {
                    if (el) cards.current.set(t.uid, el);
                    else cards.current.delete(t.uid);
                  }}
                  className={clsx(
                    "rounded-xl border bg-surface p-4 shadow-elev-1 transition-[border-color,box-shadow] duration-150",
                    isTarget ? "border-brand/40 ring-1 ring-brand/20" : "border-line",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-3">
                      <Field label="Nome do botão" required>
                        <Input
                          data-focus="name"
                          value={t.name}
                          maxLength={MAX_NAME}
                          placeholder="Ex.: Material a caminho"
                          onFocus={() => setTargetUid(t.uid)}
                          onChange={(e) => update(t.uid, { name: e.target.value })}
                          aria-invalid={p?.name ? true : undefined}
                          aria-describedby={p?.name ? `${t.uid}-nome-erro` : undefined}
                        />
                        {p?.name ? <FieldError id={`${t.uid}-nome-erro`}>{p.name}</FieldError> : null}
                      </Field>
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-end justify-between gap-2">
                          <label htmlFor={`${t.uid}-texto`} className="text-xs font-semibold text-ink/80">
                            Texto<span className="text-red-600 dark:text-red-400"> *</span>
                          </label>
                          <span className="text-[11px] text-ink-subtle tabular-nums">
                            {t.body.length.toLocaleString("pt-BR")} / {MAX_BODY.toLocaleString("pt-BR")}
                          </span>
                        </div>
                        {/* Na tela estreita a lista de variáveis fica longe: um seletor em cada texto. */}
                        <Select
                          className="lg:hidden"
                          value=""
                          aria-label={`Inserir variável em “${label}”`}
                          onChange={(e) => {
                            if (e.target.value) insert(e.target.value, t.uid);
                          }}
                        >
                          <option value="">Inserir variável…</option>
                          {allGroups.map((g) => (
                            <optgroup key={g.label} label={g.label}>
                              {g.vars.map((v) => (
                                <option key={v.key} value={v.key}>
                                  {`{${v.key}} · ${v.description}`}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </Select>
                        <Textarea
                          id={`${t.uid}-texto`}
                          ref={(el) => {
                            if (el) areas.current.set(t.uid, el);
                            else areas.current.delete(t.uid);
                          }}
                          rows={4}
                          value={t.body}
                          maxLength={MAX_BODY}
                          onFocus={() => setTargetUid(t.uid)}
                          onChange={(e) => update(t.uid, { body: e.target.value })}
                          className="font-mono text-xs"
                          aria-invalid={p?.body ? true : undefined}
                          aria-describedby={bodyHelp || undefined}
                        />
                        {p?.body ? <FieldError id={`${t.uid}-texto-erro`}>{p.body}</FieldError> : null}
                        {missing.length ? (
                          <FieldError id={`${t.uid}-variaveis`}>
                            {missing.length === 1 ? "Variável desconhecida" : "Variáveis desconhecidas"}:{" "}
                            {missing.map((k) => `{${k}}`).join(", ")}. Confira o nome na lista: assim ela sai sem trocar na mensagem.
                          </FieldError>
                        ) : null}
                      </div>
                      <div className="rounded-lg bg-surface-2 px-3 py-2">
                        <span className="mb-1 block text-[11px] font-bold tracking-wide text-ink-muted uppercase">Prévia</span>
                        {t.body.trim() ? (
                          <p className="text-sm break-words whitespace-pre-wrap text-ink">{renderPreview(t.body, values, variables)}</p>
                        ) : (
                          <p className="text-sm text-ink-muted">Escreva o texto para ver a prévia.</p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-0.5">
                      <IconButton focusKey="up" label={`Subir “${label}”`} onClick={() => move(i, -1)} disabled={i === 0}>
                        <ArrowUp className="size-4" />
                      </IconButton>
                      <IconButton
                        focusKey="down"
                        label={`Descer “${label}”`}
                        onClick={() => move(i, 1)}
                        disabled={i === items.length - 1}
                      >
                        <ArrowDown className="size-4" />
                      </IconButton>
                      <IconButton danger label={`Remover “${label}”`} onClick={() => remove(i)} disabled={items.length === 1}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  </div>
                </div>
              </Fragment>
            );
          })}
          {removed && removed.index >= items.length ? removedNotice(removed) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={add} disabled={full}>
              <Plus className="size-4" />
              Novo texto
            </Button>
            <span className="text-xs text-ink-muted">
              {full
                ? `Limite de ${MAX_TEMPLATES} textos: remova um para criar outro.`
                : `${plural(items.length, "texto", "textos")} (até ${MAX_TEMPLATES})`}
            </span>
          </div>
        </div>
        <aside className="hidden lg:sticky lg:top-20 lg:block lg:self-start">
          <Card className="flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden">
            <div className="flex flex-col gap-2 border-b border-line p-3">
              <SectionTitle as="h2">Variáveis</SectionTitle>
              <p className="text-xs text-ink-muted">
                Clique para inserir{" "}
                {items.length > 1 ? (
                  <>
                    em <strong className="font-semibold text-ink">“{labelOf(target)}”</strong>
                  </>
                ) : (
                  "no texto"
                )}
                , onde o cursor estava.
              </p>
              <SearchField value={filter} onChange={setFilter} placeholder="Filtrar variáveis" label="Filtrar variáveis" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {shownGroups.length === 0 ? (
                <p className="px-2 py-3 text-xs text-ink-muted">Nenhuma variável encontrada.</p>
              ) : (
                shownGroups.map((g) => (
                  <div key={g.label} className="mb-2 last:mb-0">
                    <p className="px-2 pt-1 pb-0.5 text-[11px] font-bold tracking-wide text-ink-muted uppercase">{g.label}</p>
                    <ul>
                      {g.vars.map((v) => (
                        <li key={v.key}>
                          <button
                            type="button"
                            onClick={() => insert(v.key, target.uid)}
                            aria-label={`Inserir {${v.key}}: ${v.description}`}
                            className="w-full rounded-md px-2 py-1 text-left hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                          >
                            <code className="text-xs font-semibold text-brand-ink">{`{${v.key}}`}</code>
                            <span className="block text-[11px] text-ink-muted">{v.description}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          </Card>
        </aside>
      </div>
      {dirty ? (
        <UnsavedBar message="Alterações não salvas">
          <Button variant="ghost" onClick={discard}>
            Descartar
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={trySave}>
            Salvar textos
          </Button>
        </UnsavedBar>
      ) : null}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  focusKey,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  focusKey?: FocusTarget;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      data-focus={focusKey}
      className={clsx(
        "inline-flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-30",
        "focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
        danger ? "hover:text-red-600 dark:hover:text-red-400" : "hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
