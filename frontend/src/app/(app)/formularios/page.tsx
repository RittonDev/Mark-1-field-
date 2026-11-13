"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ClipboardList, Copy, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { Tabs } from "@/components/motion";
import { ActiveState, fold, RowEditButton, SearchField } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import { Button, Card, EmptyState, ErrorBox, LoadingBlock, PageHeader, Table, Td, Th } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { useServiceTypes } from "@/lib/queries";
import type { FormTemplate, ServiceType } from "@/lib/types";
import {
  type Draft,
  duplicateOf,
  emptyDraft,
  EXAMPLES,
  invalidateForms,
  NEW_KEY,
  storedChanges,
  type StoredDraft,
  writeStored,
} from "./draft";
import { FormEditor } from "./FormEditor";

type Situation = "active" | "inactive" | "all";

/** Nome do rascunho guardado (um formulário novo pode ainda não ter nome). */
const draftName = (stored: StoredDraft) =>
  stored.draft.name.trim() || stored.initial.name.trim() || "Formulário novo";

export default function FormsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <FormsView />
    </Suspense>
  );
}

/**
 * Lista de formulários e o construtor. O construtor tem endereço (?editar=<id> ou ?editar=novo):
 * recarregar a página ou usar o Voltar do navegador não perde a edição (o rascunho fica na aba).
 */
function FormsView() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const confirm = useConfirm();
  const editKey = params.get("editar");
  const allowed = !user || canManageTickets(user.role);
  const templates = useQuery({
    queryKey: ["form-templates"],
    queryFn: () => api.get<FormTemplate[]>("/form-templates"),
    enabled: allowed,
  });
  // Todos os tipos, inclusive os inativos: o nome sai certo na lista e no editor.
  const serviceTypes = useServiceTypes({ enabled: allowed });
  // Onde a lista estava ao abrir o editor (volta ao mesmo ponto) e se o editor foi aberto por aqui:
  // aí "voltar" usa o histórico; aberto por link ou depois de recarregar, troca o endereço.
  const listScroll = useRef<number | null>(null);
  const openedHere = useRef(false);

  useEffect(() => {
    if (editKey || listScroll.current === null) return;
    const top = listScroll.current;
    listScroll.current = null;
    requestAnimationFrame(() => window.scrollTo({ top }));
  }, [editKey]);

  const urlFor = (key: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (key) next.set("editar", key);
    else next.delete("editar");
    const qs = next.toString();
    return qs ? `/formularios?${qs}` : "/formularios";
  };

  /** Abre o editor. `start`: ponto de partida de um formulário novo (em branco, exemplo ou cópia). */
  const open = async (key: string, start?: Draft) => {
    const pending = storedChanges();
    // Um rascunho não salvo só dá lugar a outro com a confirmação de quem estava editando.
    if (pending && (pending.key !== key || start)) {
      const ok = await confirm({
        title: "Descartar o rascunho não salvo?",
        description: `“${draftName(pending)}” tem alterações que ainda não foram salvas.`,
        confirmLabel: "Descartar e continuar",
        cancelLabel: "Voltar",
        tone: "danger",
      });
      if (!ok) return;
      writeStored(null);
    }
    if (start) writeStored({ key, initial: start, draft: start });
    listScroll.current = window.scrollY;
    openedHere.current = true;
    router.push(urlFor(key), { scroll: false });
  };

  const leave = () => {
    if (openedHere.current) {
      openedHere.current = false;
      router.back();
    } else {
      router.replace(urlFor(null), { scroll: false });
    }
  };

  if (user && !allowed) {
    return <ErrorBox message="Os formulários são montados por analistas e gestores." />;
  }

  if (editKey) {
    const isNew = editKey === NEW_KEY;
    if ((!isNew && templates.isLoading) || serviceTypes.isLoading) return <LoadingBlock />;
    const template = isNew ? null : (templates.data?.find((t) => t.id === editKey) ?? null);
    if (!isNew && !template) {
      return (
        <div className="mx-auto max-w-6xl">
          <PageHeader title="Editar formulário" />
          <Card className="flex flex-col items-start gap-3 p-4">
            <ErrorBox message={templates.error ? errorMessage(templates.error) : "Este formulário não foi encontrado."} />
            <div className="flex flex-wrap gap-2">
              {templates.error ? (
                <Button size="sm" loading={templates.isFetching} onClick={() => templates.refetch()}>
                  Tentar de novo
                </Button>
              ) : null}
              <Button size="sm" onClick={leave}>
                Voltar para a lista
              </Button>
            </div>
          </Card>
        </div>
      );
    }
    return (
      <FormEditor
        key={editKey}
        editKey={editKey}
        template={template}
        serviceTypes={serviceTypes.data ?? null}
        onLeave={leave}
      />
    );
  }

  return <FormsList templates={templates} serviceTypes={serviceTypes.data ?? []} onOpen={open} />;
}

function FormsList({
  templates,
  serviceTypes,
  onOpen,
}: {
  templates: UseQueryResult<FormTemplate[]>;
  serviceTypes: ServiceType[];
  onOpen: (key: string, start?: Draft) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const [situation, setSituation] = useState<Situation>("active");
  // Rascunho que ficou na aba (o editor fechou pelo Voltar do navegador, pelo menu ou recarregando).
  const [pending, setPending] = useState(() => storedChanges());
  const all = useMemo(() => templates.data ?? [], [templates.data]);
  const typeName = useMemo(
    () => new Map(serviceTypes.map((t) => [t.id, t.is_active ? t.name : `${t.name} (inativo)`])),
    [serviceTypes],
  );
  const counts = useMemo(() => {
    const active = all.filter((t) => t.is_active).length;
    return { active, inactive: all.length - active, all: all.length };
  }, [all]);
  const query = search.trim();
  const rows = useMemo(() => {
    const q = fold(query);
    return all.filter(
      (t) =>
        (situation === "all" || t.is_active === (situation === "active")) &&
        (!q || fold(`${t.name} ${t.description ?? ""}`).includes(q)),
    );
  }, [all, situation, query]);

  // Desativar no lugar de excluir: some da lista de anexar, e as OS que já têm o formulário não mudam.
  const toggle = useMutation({
    // Mesmas perguntas, só a situação: a versão não muda.
    mutationFn: (t: FormTemplate) =>
      api.put<FormTemplate>(`/form-templates/${t.id}`, {
        name: t.name,
        description: t.description,
        fields: t.fields,
        service_type_ids: t.service_type_ids,
        requires_signature: t.requires_signature,
        is_active: !t.is_active,
      }),
    onSuccess: (saved) => {
      invalidateForms(queryClient);
      toast({
        title: saved.is_active ? `“${saved.name}” reativado` : `“${saved.name}” desativado`,
        description: saved.is_active
          ? "Volta a aparecer para anexar nas OS."
          : "Não aparece mais para anexar. As OS que já têm este formulário continuam com ele.",
        tone: "success",
      });
    },
    onError: (e) => toast({ title: "Não foi possível alterar o formulário", description: errorMessage(e), tone: "error" }),
  });

  const discardPending = async () => {
    if (!pending) return;
    const ok = await confirm({
      title: "Descartar as alterações?",
      description: `As alterações de “${draftName(pending)}” que ainda não foram salvas serão perdidas.`,
      confirmLabel: "Descartar",
      cancelLabel: "Voltar",
      tone: "danger",
    });
    if (!ok) return;
    writeStored(null);
    setPending(null);
  };

  const suggested = (t: FormTemplate) => {
    const names = t.service_type_ids.map((id) => typeName.get(id) ?? "tipo removido");
    if (!names.length) return <span className="text-ink-subtle">—</span>;
    const shown = names.slice(0, 2).join(", ");
    return <span title={names.join(", ")}>{names.length > 2 ? `${shown} e mais ${names.length - 2}` : shown}</span>;
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Formulários"
        description="Checklists que o técnico preenche no app. Você decide, em cada OS, se anexa e se é obrigatório."
        actions={
          <Button variant="primary" onClick={() => onOpen(NEW_KEY, emptyDraft())}>
            <Plus className="size-4" />
            Novo formulário
          </Button>
        }
      />

      {pending ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <p>
            <strong className="font-semibold">“{draftName(pending)}”</strong> tem alterações que ainda não foram salvas.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={discardPending}>
              Descartar
            </Button>
            <Button size="sm" onClick={() => onOpen(pending.key)}>
              Continuar editando
            </Button>
          </div>
        </div>
      ) : null}

      {templates.isLoading ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : templates.error ? (
        <Card className="flex flex-col items-start gap-3 p-4">
          <ErrorBox message={errorMessage(templates.error)} />
          <Button size="sm" loading={templates.isFetching} onClick={() => templates.refetch()}>
            Tentar de novo
          </Button>
        </Card>
      ) : all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardList className="size-6" />}
            title="Nenhum formulário ainda"
            description="Comece de um exemplo e ajuste, ou crie do zero."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((ex) => (
                  <Button key={ex.name} onClick={() => onOpen(NEW_KEY, ex.build())}>
                    {ex.name}
                  </Button>
                ))}
              </div>
            }
          />
        </Card>
      ) : (
        <>
          <Card>
            <div className="flex flex-col gap-2 border-b border-line p-3 sm:flex-row sm:items-center">
              <SearchField
                className="sm:max-w-sm sm:flex-1"
                value={search}
                onChange={setSearch}
                placeholder="Buscar por nome ou descrição"
                label="Buscar formulário"
              />
              <Tabs<Situation>
                variant="segmented"
                ariaLabel="Situação"
                className="self-start sm:ml-auto sm:self-auto"
                value={situation}
                onChange={setSituation}
                items={[
                  { key: "active", label: "Ativos", count: counts.active },
                  { key: "inactive", label: "Inativos", count: counts.inactive },
                  { key: "all", label: "Todos", count: counts.all },
                ]}
              />
            </div>
            {rows.length === 0 ? (
              <EmptyState
                icon={<ClipboardList className="size-6" />}
                title={query ? "Nenhum formulário encontrado" : situation === "inactive" ? "Nenhum formulário inativo" : "Nenhum formulário ativo"}
                description={query ? "Confira a busca ou procure também nos inativos (Todos)." : undefined}
                action={
                  query ? (
                    <Button size="sm" onClick={() => setSearch("")}>
                      Limpar busca
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Formulário</Th>
                    <Th className="text-right">Perguntas</Th>
                    <Th className="text-right">Fotos</Th>
                    <Th>Sugerido nas OS de</Th>
                    <Th className="text-right">Versão</Th>
                    <Th>Situação</Th>
                    <Th>Ações</Th>
                    <Th className="edit-col">Editar</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => {
                    const questions = t.fields.filter((f) => f.type !== "section").length;
                    const photos = t.fields.filter((f) => f.type === "photo").length;
                    return (
                      <tr key={t.id} className="transition-colors hover:bg-[var(--row-hover)]">
                        <Td className="max-w-md min-w-56">
                          <button
                            type="button"
                            onClick={() => onOpen(t.id)}
                            className="rounded text-left font-semibold text-ink hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                          >
                            {t.name}
                          </button>
                          {t.description ? <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{t.description}</p> : null}
                        </Td>
                        <Td className="text-right tabular-nums">{questions}</Td>
                        <Td className="text-right tabular-nums">{photos || <span className="text-ink-subtle">—</span>}</Td>
                        <Td className="max-w-xs text-xs text-ink-muted">{suggested(t)}</Td>
                        <Td className="text-right text-ink-muted tabular-nums">{t.version}</Td>
                        <Td>
                          <ActiveState active={t.is_active} />
                        </Td>
                        <Td className="whitespace-nowrap">
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => onOpen(NEW_KEY, duplicateOf(t))}
                              aria-label={`Duplicar “${t.name}”`}
                            >
                              <Copy className="size-3.5" />
                              Duplicar
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={toggle.isPending && toggle.variables?.id === t.id}
                              disabled={toggle.isPending}
                              onClick={() => toggle.mutate(t)}
                              aria-label={`${t.is_active ? "Desativar" : "Reativar"} “${t.name}”`}
                            >
                              {t.is_active ? <Archive className="size-3.5" /> : <ArchiveRestore className="size-3.5" />}
                              {t.is_active ? "Desativar" : "Reativar"}
                            </Button>
                          </div>
                        </Td>
                        <Td className="edit-col">
                          <RowEditButton label={`Editar “${t.name}”`} onClick={() => onOpen(t.id)} />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
          <p className="mt-4 text-xs text-ink-muted">
            Exemplos para começar:{" "}
            {EXAMPLES.map((ex, i) => (
              <span key={ex.name}>
                {i ? " · " : ""}
                <button
                  type="button"
                  className="rounded font-medium text-brand hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                  onClick={() => onOpen(NEW_KEY, ex.build())}
                >
                  {ex.name}
                </button>
              </span>
            ))}
          </p>
        </>
      )}
    </div>
  );
}
