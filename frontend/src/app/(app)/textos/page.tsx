"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { useToast } from "@/components/Toaster";
import { Button, Card, ErrorBox, Field, Input, LoadingBlock, PageHeader, SectionTitle, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";

interface Template {
  key?: string | null;
  name: string;
  body: string;
}
interface TemplatesOut {
  templates: Template[];
  variables: { key: string; description: string }[];
}

// Exemplo para a prévia (na OS, a API preenche com os dados reais).
const SAMPLE: Record<string, string> = {
  tecnico: "Carlos Souza",
  tecnico_telefone: "(11) 90000-0000",
  os: "OS-000123",
  titulo: "PDV 3 sem rede",
  cliente: "Maxx Group",
  local: "Loja 27 - Shopping Morumbi",
  cidade: "São Paulo",
  endereco: "Av. Roque Petroni Jr., 1089, São Paulo-SP",
  mapa: "https://maps.google.com/?q=-23.62,-46.70",
  contato: "Ana (gerente) · (11) 3000-0000",
  agendamento: "13/11 às 10:00",
  hora_agendada: "10:00",
  chegada_prevista: "14:35",
  distancia: "6 km",
  agora: "14:10",
  hoje: "12/11",
  status: "Em deslocamento",
  prioridade: "P2 Alta",
  solucao: "Switch reiniciado e cabo do PDV substituído.",
  motivo_improdutiva: "Cliente ausente ou local fechado",
  projeto: "Recabeamento lojas Zona Sul",
  analista: "Bruno Martins",
};

const preview = (body: string) => body.replace(/\{(\w+)\}/g, (m, k: string) => SAMPLE[k] ?? m);

export default function TemplatesPage() {
  const { user } = useAuth();
  const data = useQuery({ queryKey: ["message-templates"], queryFn: () => api.get<TemplatesOut>("/message-templates") });
  if (user && !canManageTickets(user.role)) return <ErrorBox message="Os textos são mantidos pela gestão." />;
  if (data.isLoading || !data.data) return <LoadingBlock />;
  return <Editor key={JSON.stringify(data.data.templates)} initial={data.data} />;
}

function Editor({ initial }: { initial: TemplatesOut }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<Template[]>(initial.templates);
  const [focused, setFocused] = useState(0);
  const areas = useRef<(HTMLTextAreaElement | null)[]>([]);
  const done = (r: TemplatesOut, title: string) => {
    queryClient.setQueryData(["message-templates"], r);
    queryClient.invalidateQueries({ queryKey: ["ticket"] });
    toast({ title, tone: "success" });
  };
  const save = useMutation({
    mutationFn: () => api.put<TemplatesOut>("/message-templates", { templates: items }),
    onSuccess: (r) => done(r, "Textos salvos"),
  });
  const reset = useMutation({
    mutationFn: () => api.post<TemplatesOut>("/message-templates/reset"),
    onSuccess: (r) => {
      setItems(r.templates);
      done(r, "Textos padrão restaurados");
    },
  });
  const set = (i: number, patch: Partial<Template>) => setItems((list) => list.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const insert = (key: string) => {
    const area = areas.current[focused];
    const token = `{${key}}`;
    const body = items[focused]?.body ?? "";
    const start = area?.selectionStart ?? body.length;
    const end = area?.selectionEnd ?? body.length;
    set(focused, { body: body.slice(0, start) + token + body.slice(end) });
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const move = (i: number, d: number) =>
    setItems((list) => {
      const next = [...list];
      const j = i + d;
      if (j < 0 || j >= next.length) return list;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Textos do WhatsApp"
        description="Avisos que o analista copia na OS para o grupo dos técnicos. As palavras entre chaves são trocadas pelos dados da OS."
        actions={
          <>
            <Button variant="ghost" loading={reset.isPending} onClick={async () =>
                (await confirm({
                  title: "Voltar aos textos padrão?",
                  description: "Os textos que você editou serão substituídos pelos originais.",
                  confirmLabel: "Voltar ao padrão",
                  tone: "danger",
                })) && reset.mutate()
              }
            >
              <RotateCcw className="size-4" />
              Restaurar padrão
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Salvar textos
            </Button>
          </>
        }
      />
      {save.error ? (
        <div className="mb-4">
          <ErrorBox message={errorMessage(save.error)} />
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="flex flex-col gap-3">
          {items.map((t, i) => (
            <Card key={i} className="p-4">
              <div className="flex items-start gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <Field label="Nome do botão">
                    <Input value={t.name} onChange={(e) => set(i, { name: e.target.value })} maxLength={60} />
                  </Field>
                  <Field label="Texto">
                    <Textarea
                      ref={(el) => {
                        areas.current[i] = el;
                      }}
                      rows={3}
                      value={t.body}
                      onFocus={() => setFocused(i)}
                      onChange={(e) => set(i, { body: e.target.value })}
                      className="font-mono text-xs"
                    />
                  </Field>
                  <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap text-ink">
                    <span className="mb-1 block text-[11px] font-bold tracking-wide text-ink-muted uppercase">Prévia</span>
                    {preview(t.body)}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-ink-muted hover:text-ink disabled:opacity-30" aria-label="Subir">
                    <ArrowUp className="size-4" />
                  </button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} className="rounded p-1 text-ink-muted hover:text-ink disabled:opacity-30" aria-label="Descer">
                    <ArrowDown className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setItems((list) => list.filter((_, j) => j !== i))}
                    disabled={items.length === 1}
                    className="rounded p-1 text-ink-muted hover:text-red-600 disabled:opacity-30"
                    aria-label="Remover texto"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
            </Card>
          ))}
          <Button className="self-start" onClick={() => setItems((list) => [...list, { name: "Novo aviso", body: "*{os}* · {cliente}\n" }])}>
            <Plus className="size-4" />
            Novo texto
          </Button>
        </div>
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <Card className="p-3">
            <SectionTitle className="mb-2">Variáveis</SectionTitle>
            <p className="mb-2 text-xs text-ink-muted">Clique para inserir no texto que está em edição.</p>
            <ul className="flex flex-col gap-1">
              {initial.variables.map((v) => (
                <li key={v.key}>
                  <button type="button" onClick={() => insert(v.key)} className="w-full rounded-md px-2 py-1 text-left hover:bg-surface-2">
                    <code className="text-xs text-brand">{`{${v.key}}`}</code>
                    <span className="block text-[11px] text-ink-muted">{v.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}
