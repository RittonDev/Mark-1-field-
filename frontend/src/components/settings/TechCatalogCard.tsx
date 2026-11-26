"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { ActiveState, FieldError, fold, plural, RowEditButton, SearchField } from "@/components/settings/shared";
import { apiErrorText } from "@/components/technicians/ficha/SectionCard";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Checkbox, Dialog, EmptyState, ErrorBox, Field, Input, LoadingBlock, Table, Td, Th } from "@/components/ui";
import { api, apiErrorCode } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { useTechCatalog } from "@/lib/queries";
import {
  activeHint,
  CATALOG_NAME,
  canDeleteCatalogItem,
  catalogListHref,
  catalogNameLength,
  catalogUsageText,
  cleanCatalogName,
  renameHint,
  sameCatalogName,
  TECH_CATALOGS,
  type TechCatalogConfig,
} from "@/lib/techCatalog";
import type { TechCatalogItem, TechCatalogItemCreate, TechCatalogItemUpdate, TechCatalogKind } from "@/lib/types";

// Os catálogos dos técnicos em Configurações › Técnicos (Áreas de atuação, Aptidões e Ferramental), um cartão por
// catálogo: incluir, renomear, desativar e reativar; excluir só o que nunca foi usado (o resto desativa: sai das
// escolhas do app, da ficha e dos filtros e fica guardado em quem tinha). A API devolve em ordem alfabética.

/** A busca aparece a partir de 13 itens. */
const SEARCH_FROM = 13;

/**
 * Quantos técnicos têm o item (ativo ou não no catálogo): do ativo, com alguém e com a tela Técnicos, o link para a lista
 * filtrada; senão o número (o desativado, sem link: a lista só filtra pelos ativos).
 */
function TechniciansCell({ kind, item, canOpen }: { kind: TechCatalogKind; item: TechCatalogItem; canOpen: boolean }) {
  const count = item.technicians;
  if (count === null || count === undefined) return <span className="text-ink-subtle">—</span>;
  const href = canOpen ? catalogListHref(kind, item) : null;
  if (href) {
    const text = plural(count, "técnico", "técnicos");
    return (
      <Link href={href} aria-label={`${text} com ${item.name}`} className="font-medium text-brand-ink tabular-nums hover:underline">
        {text}
      </Link>
    );
  }
  return <span className="tabular-nums">{count.toLocaleString("pt-BR")}</span>;
}

/**
 * Um catálogo dos técnicos (Configurações › Técnicos): a lista com quantos técnicos têm cada item e a situação, a busca
 * (a partir de 13), incluir e editar (com Configurações em Editar). A API de antes da Entrega 2 não tem áreas nem
 * aptidões: o cartão avisa e oferece tentar de novo.
 */
export function TechCatalogCard({ kind, readOnly = false }: { kind: TechCatalogKind; readOnly?: boolean }) {
  const cfg = TECH_CATALOGS[kind];
  const catalog = useTechCatalog(kind);
  const canOpen = useCan("base.technicians");
  const [editing, setEditing] = useState<TechCatalogItem | "new" | null>(null);
  const [search, setSearch] = useState("");
  // Com a lista na tela, uma releitura que falha (rede caiu) não troca a lista pelo erro.
  const list = catalog.data;
  const searchable = (list?.length ?? 0) >= SEARCH_FROM;
  const term = searchable ? fold(cleanCatalogName(search)) : "";
  const shown = (list ?? []).filter((item) => !term || fold(item.name).includes(term));
  const full = (list?.length ?? 0) >= cfg.max;
  // Incluir só com a lista carregada: é ela que avisa do nome repetido antes de salvar.
  const newButton =
    readOnly || !list ? null : (
      <Button
        size="sm"
        onClick={() => setEditing("new")}
        disabled={full}
        title={full ? `O catálogo aceita até ${cfg.max} itens.` : undefined}
      >
        <Plus aria-hidden className="size-3.5" />
        {cfg.newLabel}
      </Button>
    );

  return (
    <Card>
      <CardHeader title={cfg.title} actions={newButton} />
      {list ? (
        list.length === 0 ? (
          <EmptyState title={cfg.empty} action={newButton} />
        ) : (
          <>
            {searchable ? (
              <div className="border-b border-line p-3">
                <SearchField className="sm:max-w-sm" value={search} onChange={setSearch} placeholder={cfg.search} label={cfg.search} />
              </div>
            ) : null}
            {shown.length === 0 ? (
              <p role="status" className="px-4 py-3 text-xs text-ink-muted">
                {cfg.noMatch}
              </p>
            ) : (
              <Table label={cfg.title}>
                <thead>
                  <tr>
                    <Th>{cfg.column}</Th>
                    <Th>Técnicos</Th>
                    <Th>Situação</Th>
                    {readOnly ? null : <Th edit>Editar</Th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => (
                    <tr key={item.id} className="transition-colors hover:bg-[var(--row-hover)]">
                      <Td className="font-semibold">{item.name}</Td>
                      <Td>
                        <TechniciansCell kind={kind} item={item} canOpen={canOpen} />
                      </Td>
                      <Td>
                        <ActiveState active={item.is_active} feminine />
                      </Td>
                      {readOnly ? null : (
                        <Td edit>
                          <RowEditButton label={`${cfg.editTitle}: ${item.name}`} onClick={() => setEditing(item)} />
                        </Td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )
      ) : catalog.error ? (
        <div className="p-4">
          <ErrorBox message={apiErrorText(catalog.error)} onRetry={() => void catalog.refetch()} />
        </div>
      ) : (
        <LoadingBlock />
      )}
      {editing && list ? (
        <CatalogDialog
          cfg={cfg}
          item={editing === "new" ? null : editing}
          list={list}
          onClose={() => setEditing(null)}
          onStale={() => void catalog.refetch()}
        />
      ) : null}
    </Card>
  );
}

/**
 * Incluir (o nome) ou editar (o nome e "Ativa") um item. O nome repetido (sem acento e sem maiúsculas, também entre os
 * desativados) é avisado aqui antes do 409. Sem uso (nunca usado), editar oferece Excluir; com uso, a linha de uso
 * (desativar tira das escolhas). As dicas aparecem só com dado: quantos técnicos o novo nome ou a desativação alcançam.
 */
function CatalogDialog({
  cfg,
  item,
  list,
  onClose,
  onStale,
}: {
  cfg: TechCatalogConfig;
  /** null: item novo. */
  item: TechCatalogItem | null;
  list: TechCatalogItem[];
  onClose: () => void;
  /** O servidor recusou por algo que a lista na tela não sabia (usado agora, excluído): relê a lista. */
  onStale: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const formId = useId();
  const nameErrorId = useId();
  const [initial] = useState(() => ({ name: item?.name ?? "", is_active: item?.is_active ?? true }));
  const [form, setForm] = useState(initial);
  const dirty = form.name !== initial.name || form.is_active !== initial.is_active;
  const name = cleanCatalogName(form.name);
  const length = catalogNameLength(form.name);
  // O nome é único sem acento e sem maiúsculas (ativos e desativados): avisa aqui em vez do 409 da API.
  const duplicate = length > 0 && list.some((other) => other.id !== item?.id && sameCatalogName(other.name, name));
  const renamed = item !== null && name !== item.name;
  const changed = item === null || renamed || form.is_active !== item.is_active;
  const ready = length >= CATALOG_NAME.min && length <= CATALOG_NAME.max && !duplicate && changed;
  const usage = item ? catalogUsageText(item) : null;
  const deletable = item !== null && canDeleteCatalogItem(item);
  // Só as dicas com dado: o novo nome e a desativação (ou a volta) alcançam quantos técnicos.
  const hints = item
    ? [
        renamed && !duplicate && length >= CATALOG_NAME.min ? renameHint(item.technicians) : null,
        activeHint(item.is_active, form.is_active, item.technicians),
      ].filter((hint): hint is string => Boolean(hint))
    : [];

  const done = (title: string) => {
    // O catálogo, a base técnica (os nomes na ficha e nos filtros) e as escolhas da ficha pública.
    for (const key of [cfg.queryKey, "technicians"]) void queryClient.invalidateQueries({ queryKey: [key] });
    void queryClient.invalidateQueries({ queryKey: ["onboarding", "catalog"] });
    toast({ title, tone: "success" });
    onClose();
  };

  const save = useMutation({
    mutationFn: () => {
      if (!item) {
        const body: TechCatalogItemCreate = { name };
        return api.post<TechCatalogItem>(cfg.path, body);
      }
      // Só o que mudou.
      const patch: TechCatalogItemUpdate = {};
      if (renamed) patch.name = name;
      if (form.is_active !== item.is_active) patch.is_active = form.is_active;
      return api.patch<TechCatalogItem>(`${cfg.path}/${item.id}`, patch);
    },
    onSuccess: (saved) => done(`${cfg.noun} “${saved.name}” ${item ? "atualizada" : "cadastrada"}`),
    onError: (error) => {
      if (apiErrorCode(error) === "CATALOG_IN_USE") onStale();
    },
  });

  const remove = useMutation({
    mutationFn: (target: TechCatalogItem) => api.delete<void>(`${cfg.path}/${target.id}`),
    onSuccess: (_, target) => done(`${cfg.noun} “${target.name}” excluída`),
    // Usado enquanto o diálogo estava aberto: a lista relê (com o uso novo, o Excluir some).
    onError: () => onStale(),
  });

  const askRemove = async () => {
    if (!item) return;
    const ok = await confirm({
      tone: "danger",
      title: `Excluir ${item.name}?`,
      description: "Sem uso: sai do catálogo de vez.",
      confirmLabel: "Excluir",
    });
    if (ok) remove.mutate(item);
  };

  const busy = save.isPending || remove.isPending;
  const error = save.error ?? remove.error;

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      title={item ? cfg.editTitle : cfg.newLabel}
      footer={
        <>
          {deletable ? (
            <Button variant="ghost" className="mr-auto" onClick={() => void askRemove()} loading={remove.isPending} disabled={save.isPending}>
              <Trash2 aria-hidden className="size-3.5" />
              Excluir
            </Button>
          ) : null}
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={save.isPending} disabled={!ready || remove.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) save.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Nome" required>
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
            minLength={CATALOG_NAME.min}
            maxLength={CATALOG_NAME.max}
            autoComplete="off"
            autoFocus
            aria-invalid={duplicate ? true : undefined}
            aria-describedby={duplicate ? nameErrorId : undefined}
          />
          {duplicate ? <FieldError id={nameErrorId}>{cfg.duplicate}</FieldError> : null}
        </Field>
        {item ? <Checkbox label="Ativa" checked={form.is_active} onChange={(v) => setForm((f) => ({ ...f, is_active: v }))} /> : null}
        {usage || hints.length ? (
          <div className="flex flex-col gap-1 text-xs text-ink-muted">
            {usage ? <p>{usage}</p> : null}
            {hints.map((hint) => (
              <p key={hint}>{hint}</p>
            ))}
          </div>
        ) : null}
        {error ? <ErrorBox message={apiErrorText(error)} /> : null}
      </form>
    </Dialog>
  );
}
