"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Wrench } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { ActiveState, FieldError, fold, plural, RowEditButton, SearchField } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { TECH_PROFILE_LIMITS } from "@/lib/constants";
import { useCan } from "@/lib/permissions";
import { useTechnicianTools } from "@/lib/queries";
import type { TechnicianTool, TechnicianToolCreate, TechnicianToolUpdate } from "@/lib/types";

// Ferramental dos técnicos: a central mantém a lista (incluir, renomear, desativar) e o técnico marca no app as que
// tem. Sem excluir nem ordem manual: a API devolve em ordem alfabética, e a inativa sai do app e da ficha e volta para
// quem tinha marcado quando reativada.

/** A busca aparece com mais de 12 ferramentas. */
const SEARCH_FROM = 13;

/** O nome como a API grava: sem espaços nas pontas nem repetidos no meio. */
function cleanName(text: string): string {
  return text.normalize("NFC").split(/\s+/).filter(Boolean).join(" ");
}

/** Mensagem do erro; a API em uso ainda sem o catálogo (rota inexistente, 404 do próprio framework) ganha a sua. */
function toolsError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404 && error.detail === "Not Found") {
    return "O servidor ainda não tem o ferramental. Tente de novo mais tarde.";
  }
  return errorMessage(error);
}

/** Quantos técnicos marcaram: com a tela Técnicos, o link para a lista filtrada; a inativa não conta para ninguém. */
function TechniciansCell({ tool, canOpen }: { tool: TechnicianTool; canOpen: boolean }) {
  const count = tool.technicians;
  if (!tool.is_active || count == null) return <span className="text-ink-subtle">—</span>;
  if (count > 0 && canOpen) {
    const text = plural(count, "técnico", "técnicos");
    return (
      <Link
        href={`/tecnicos?ferramenta=${tool.id}`}
        aria-label={`${text} com ${tool.name}`}
        className="font-medium text-brand-ink tabular-nums hover:underline"
      >
        {text}
      </Link>
    );
  }
  return <span className="tabular-nums">{count.toLocaleString("pt-BR")}</span>;
}

/** Configurações › Técnicos: o catálogo de ferramentas que o técnico marca no app, com quantos marcaram cada uma. */
export function ToolCatalogCard({ readOnly = false }: { readOnly?: boolean }) {
  const tools = useTechnicianTools();
  const canOpen = useCan("base.technicians");
  const [editing, setEditing] = useState<TechnicianTool | "new" | null>(null);
  const [search, setSearch] = useState("");
  // Com a lista na tela, uma releitura que falha (rede caiu) não troca a lista pelo erro.
  const list = tools.data;
  const searchable = (list?.length ?? 0) >= SEARCH_FROM;
  const term = searchable ? fold(cleanName(search)) : "";
  const shown = (list ?? []).filter((t) => !term || fold(t.name).includes(term));
  // Incluir só com a lista carregada: é ela que avisa do nome repetido antes de salvar.
  const newButton =
    readOnly || !list ? null : (
      <Button size="sm" onClick={() => setEditing("new")}>
        <Plus className="size-3.5" />
        Nova ferramenta
      </Button>
    );

  return (
    <Card>
      <CardHeader title="Ferramental" description="Ferramentas que o técnico marca no app." actions={newButton} />
      {list ? (
        list.length === 0 ? (
          <EmptyState
            icon={<Wrench />}
            title="Nenhuma ferramenta cadastrada"
            description="O técnico marca no app as ferramentas que tem."
            action={newButton}
          />
        ) : (
          <>
            {searchable ? (
              <div className="border-b border-line p-3">
                <SearchField
                  className="sm:max-w-sm"
                  value={search}
                  onChange={setSearch}
                  placeholder="Buscar ferramenta"
                  label="Buscar ferramenta"
                />
              </div>
            ) : null}
            {shown.length === 0 ? (
              <p role="status" className="px-4 py-3 text-xs text-ink-muted">
                Nenhuma ferramenta com este nome.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Ferramenta</Th>
                    <Th>Técnicos</Th>
                    <Th>Situação</Th>
                    {readOnly ? null : <Th className="edit-col">Editar</Th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => (
                    <tr key={t.id} className="transition-colors hover:bg-[var(--row-hover)]">
                      <Td className="font-semibold">{t.name}</Td>
                      <Td>
                        <TechniciansCell tool={t} canOpen={canOpen} />
                      </Td>
                      <Td>
                        <ActiveState active={t.is_active} feminine />
                      </Td>
                      {readOnly ? null : (
                        <Td className="edit-col">
                          <RowEditButton label={`Editar a ferramenta ${t.name}`} onClick={() => setEditing(t)} />
                        </Td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )
      ) : tools.error ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <ErrorBox message={toolsError(tools.error)} />
          <Button size="sm" loading={tools.isFetching} onClick={() => void tools.refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : (
        <LoadingBlock />
      )}
      {editing && list ? (
        <ToolDialog tool={editing === "new" ? null : editing} tools={list} onClose={() => setEditing(null)} />
      ) : null}
    </Card>
  );
}

function ToolDialog({
  tool,
  tools,
  onClose,
}: {
  /** null: ferramenta nova. */
  tool: TechnicianTool | null;
  tools: TechnicianTool[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const nameErrorId = useId();
  const [initial] = useState(() => ({ name: tool?.name ?? "", is_active: tool?.is_active ?? true }));
  const [form, setForm] = useState(initial);
  const dirty = form.name !== initial.name || form.is_active !== initial.is_active;
  const name = cleanName(form.name);
  // O nome é único sem acento e sem maiúsculas (ativas e inativas): avisa aqui em vez do 409 da API.
  const duplicate = name.length > 0 && tools.some((t) => t.id !== tool?.id && fold(cleanName(t.name)) === fold(name));
  const renamed = tool !== null && name !== tool.name;
  const changed = tool === null || renamed || form.is_active !== tool.is_active;
  const ready = name.length >= TECH_PROFILE_LIMITS.textMin && !duplicate && changed;

  const save = useMutation({
    mutationFn: () => {
      if (!tool) {
        const body: TechnicianToolCreate = { name };
        return api.post<TechnicianTool>("/technician-tools", body);
      }
      // Só o que mudou.
      const patch: TechnicianToolUpdate = {};
      if (renamed) patch.name = name;
      if (form.is_active !== tool.is_active) patch.is_active = form.is_active;
      return api.patch<TechnicianTool>(`/technician-tools/${tool.id}`, patch);
    },
    onSuccess: (saved) => {
      // O catálogo e a base técnica (o filtro por ferramenta e a ficha usam os nomes do catálogo).
      void queryClient.invalidateQueries({ queryKey: ["technician-tools"] });
      void queryClient.invalidateQueries({ queryKey: ["technicians"] });
      toast({
        title: tool ? `Ferramenta “${saved.name}” atualizada` : `Ferramenta “${saved.name}” cadastrada`,
        description: "O app mostra na próxima vez que o técnico abrir o Ferramental.",
        tone: "success",
      });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={dirty}
      busy={save.isPending}
      title={tool ? "Editar ferramenta" : "Nova ferramenta"}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="tool-catalog-form" loading={save.isPending} disabled={!ready}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="tool-catalog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !save.isPending) save.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Nome" required hint={renamed && name.length > 0 && !duplicate ? "Muda também para quem já marcou." : undefined}>
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
            minLength={TECH_PROFILE_LIMITS.textMin}
            maxLength={TECH_PROFILE_LIMITS.toolName}
            autoFocus
            aria-invalid={duplicate ? true : undefined}
            aria-describedby={duplicate ? nameErrorId : undefined}
          />
          {duplicate ? <FieldError id={nameErrorId}>Já existe uma ferramenta com este nome.</FieldError> : null}
        </Field>
        {tool ? (
          <div className="flex flex-col gap-1">
            <Checkbox label="Ativa" checked={form.is_active} onChange={(v) => setForm((f) => ({ ...f, is_active: v }))} />
            <span className="text-xs text-ink-muted">
              Inativa sai do app e da ficha dos técnicos; reativada, volta para quem tinha marcado.
            </span>
          </div>
        ) : null}
        {save.error ? <ErrorBox message={toolsError(save.error)} /> : null}
      </form>
    </Dialog>
  );
}
