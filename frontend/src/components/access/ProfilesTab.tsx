"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Lock, Plus, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { AccessMatrix, type LevelPatch } from "@/components/access/AccessMatrix";
import { useConfirm } from "@/components/Confirm";
import { NeutralChip, plural, UnsavedBar, useLeaveGuard } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Checkbox, Dialog, EmptyState, ErrorBox, Field, Input, LoadingBlock, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ACCESS_ITEM_KEYS, QUEUE_SCOPE_LABEL, ROLE_DEFAULTS } from "@/lib/permissions";
import { useAccessCatalog, useAccessProfiles } from "@/lib/queries";
import type {
  AccessCatalog,
  AccessItemKey,
  AccessLevel,
  AccessProfile,
  AccessProfileCreate,
  AccessProfileUpdate,
  QueueScope,
  UUID,
} from "@/lib/types";

type Levels = Record<AccessItemKey, AccessLevel>;

/**
 * Mudanças de perfil mexem no menu de quem o usa, na lista de usuários e no próprio acesso. Com o
 * perfil salvo, a lista já troca na hora (o editor recomeça dele, sem piscar o "não salvo").
 */
function useRefreshAccess() {
  const queryClient = useQueryClient();
  return (saved?: AccessProfile) => {
    if (saved) {
      queryClient.setQueryData<AccessProfile[]>(["access", "profiles"], (list) =>
        list?.some((p) => p.id === saved.id) ? list.map((p) => (p.id === saved.id ? saved : p)) : [...(list ?? []), saved],
      );
    }
    void queryClient.invalidateQueries({ queryKey: ["access", "profiles"] });
    void queryClient.invalidateQueries({ queryKey: ["users"] });
    void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
  };
}

const peopleLabel = (n: number) => plural(n, "pessoa", "pessoas");

/**
 * Aba "Perfis de acesso" de Configuração > Usuários: à esquerda o Administrador (acesso total, fixo),
 * os perfis padrão (Supervisor e Analista) e os criados aqui; à direita a matriz Tela x Nível e a
 * visibilidade de filas do perfil escolhido. Só o administrador altera; os demais consultam.
 */
export function ProfilesTab() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";
  const confirm = useConfirm();
  const catalog = useAccessCatalog();
  const profiles = useAccessProfiles();
  const [selectedId, setSelectedId] = useState<UUID | null>(null);
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const list = profiles.data ?? [];
  const selected = list.find((p) => p.id === selectedId) ?? list[0] ?? null;

  const pick = async (id: UUID) => {
    if (id === selected?.id) return;
    if (
      dirty &&
      !(await confirm({
        title: "Trocar de perfil sem salvar?",
        description: `As alterações em ${selected?.name ?? "este perfil"} se perdem.`,
        confirmLabel: "Trocar sem salvar",
        cancelLabel: "Continuar editando",
        tone: "danger",
      }))
    ) {
      return;
    }
    setDirty(false);
    setSelectedId(id);
  };

  if (profiles.isLoading) {
    return (
      <Card>
        <LoadingBlock rows={4} label="Carregando os perfis de acesso..." />
      </Card>
    );
  }
  if (profiles.error && !profiles.data) {
    return <ErrorBox message={errorMessage(profiles.error)} onRetry={() => void profiles.refetch()} />;
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[17rem_minmax(0,1fr)]">
      <Card className="xl:sticky xl:top-20">
        <CardHeader
          title="Perfis"
          actions={
            isAdmin ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" />
                Novo perfil
              </Button>
            ) : null
          }
        />
        <ul className="flex flex-col gap-px p-1.5" aria-label="Perfis de acesso">
          <li
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
            title="O administrador vê e altera tudo, sempre: não tem perfil nem ajustes."
          >
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-muted ring-1 ring-line">
              <Lock className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-ink">Administrador</span>
              <span className="block text-[11px] text-ink-muted">Acesso total</span>
            </span>
          </li>
          {list.map((p) => {
            const active = p.id === selected?.id;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => void pick(p.id)}
                  aria-pressed={active}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    active ? "bg-brand-soft" : "hover:bg-surface-2",
                  )}
                >
                  <span
                    aria-hidden
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-muted ring-1 ring-line"
                  >
                    <ShieldCheck className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={clsx("block truncate text-[13px] text-ink", active ? "font-bold" : "font-semibold")}>{p.name}</span>
                    <span className="block text-[11px] text-ink-muted">
                      {p.system_key ? "Padrão · " : ""}
                      {peopleLabel(p.users_count)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {selected ? (
        <ProfileEditor
          key={`${selected.id}-${selected.updated_at}`}
          profile={selected}
          catalog={catalog.data ?? null}
          editable={isAdmin}
          onDirtyChange={setDirty}
          onDeleted={() => {
            setDirty(false);
            setSelectedId(null);
          }}
        />
      ) : (
        <Card>
          <EmptyState icon={<ShieldCheck />} title="Nenhum perfil" />
        </Card>
      )}

      {creating ? (
        <NewProfileDialog
          profiles={list}
          defaultFrom={list.find((p) => p.system_key === "analyst")?.id ?? list[0]?.id ?? ""}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setDirty(false);
            setSelectedId(created.id);
          }}
        />
      ) : null}
    </div>
  );
}

/** O nível padrão de cada tela no perfil (padrão do papel; os criados na tela partem do Analista). */
function defaultsOf(profile: AccessProfile, catalog: AccessCatalog | null): Levels {
  const key = profile.system_key ?? "analyst";
  return (catalog?.defaults?.[key] as Levels | undefined) ?? ROLE_DEFAULTS[key];
}

function ProfileEditor({
  profile,
  catalog,
  editable,
  onDirtyChange,
  onDeleted,
}: {
  profile: AccessProfile;
  catalog: AccessCatalog | null;
  editable: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const refresh = useRefreshAccess();
  const nameId = useId();
  const deleteHintId = useId();
  const custom = profile.system_key === null;
  const [name, setName] = useState(profile.name);
  const [items, setItems] = useState<Levels>(profile.effective_items);
  const [scope, setScope] = useState<QueueScope>(profile.queue_scope);
  const [unowned, setUnowned] = useState(profile.queue_scope === "all" ? true : profile.queue_unowned);

  const changedItems = ACCESS_ITEM_KEYS.filter((k) => items[k] !== profile.effective_items[k]);
  const queueChanged = scope !== profile.queue_scope || (scope === "own" && unowned !== profile.queue_unowned);
  const nameChanged = custom && name.trim() !== profile.name;
  const dirty = editable && (changedItems.length > 0 || queueChanged || nameChanged);
  useLeaveGuard(dirty, `As alterações do perfil ${profile.name} ainda não foram salvas.`);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const save = useMutation({
    mutationFn: () => {
      const defaults = defaultsOf(profile, catalog);
      const body: AccessProfileUpdate = {};
      if (nameChanged) body.name = name.trim();
      if (changedItems.length) {
        // No perfil padrão, voltar ao nível padrão tira a tela do perfil (ela segue o padrão do código).
        body.items = Object.fromEntries(
          changedItems.map((k) => [k, !custom && items[k] === defaults[k] ? null : items[k]]),
        ) as AccessProfileUpdate["items"];
      }
      if (queueChanged) {
        body.queue_scope = scope;
        body.queue_unowned = scope === "all" ? true : unowned;
      }
      return api.patch<AccessProfile>(`/access/profiles/${profile.id}`, body);
    },
    onSuccess: (saved) => {
      refresh(saved);
      toast({ title: `Perfil ${saved.name} salvo`, description: "Vale na hora para quem usa o perfil.", tone: "success" });
    },
  });

  const reset = useMutation({
    mutationFn: () => api.post<AccessProfile>(`/access/profiles/${profile.id}/reset`),
    onSuccess: (saved) => {
      refresh(saved);
      toast({ title: `Perfil ${saved.name} de volta ao padrão`, tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível restaurar", description: errorMessage(e), tone: "error" }),
  });

  const remove = useMutation({
    mutationFn: () => api.delete<void>(`/access/profiles/${profile.id}`),
    onSuccess: () => {
      refresh();
      toast({ title: `Perfil ${profile.name} excluído`, tone: "success" });
      onDeleted();
    },
    onError: (e) => toast({ title: "Não foi possível excluir", description: errorMessage(e), tone: "error" }),
  });

  const discard = () => {
    setName(profile.name);
    setItems(profile.effective_items);
    setScope(profile.queue_scope);
    setUnowned(profile.queue_scope === "all" ? true : profile.queue_unowned);
    save.reset();
  };

  const askReset = async () => {
    const ok = await confirm({
      title: `Restaurar o padrão de ${profile.name}?`,
      description: "Todas as telas voltam ao nível padrão do papel e a fila volta a ser a da equipe toda.",
      confirmLabel: "Restaurar padrão",
    });
    if (ok) reset.mutate();
  };

  const askDelete = async () => {
    const ok = await confirm({
      title: `Excluir o perfil ${profile.name}?`,
      description: "Ninguém usa este perfil. Não dá para desfazer.",
      confirmLabel: "Excluir",
      tone: "danger",
    });
    if (ok) remove.mutate();
  };

  const onMatrix = (patch: LevelPatch) =>
    setItems((current) => {
      const next = { ...current };
      for (const [key, level] of Object.entries(patch)) if (level) next[key as AccessItemKey] = level;
      return next;
    });

  const inUse = profile.users_count > 0;
  const usersHref = `/usuarios?${new URLSearchParams({ aba: "usuarios", perfil: profile.id }).toString()}`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card className="min-w-0">
        <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            {custom && editable ? (
              <div className="flex max-w-sm flex-col gap-1.5">
                <label htmlFor={nameId} className="text-xs font-semibold text-ink/80">
                  Nome do perfil
                </label>
                <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={80} required />
              </div>
            ) : (
              <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-bold tracking-[-0.01em] text-ink">
                {profile.name}
                {profile.system_key ? <NeutralChip>Padrão</NeutralChip> : null}
              </h2>
            )}
            {profile.description ? <p className="mt-1 text-xs text-ink-muted">{profile.description}</p> : null}
            <p className="mt-1.5 text-xs text-ink-muted">
              {inUse ? (
                <Link href={usersHref} className="font-semibold text-brand-ink underline-offset-2 hover:underline">
                  Usado por {peopleLabel(profile.users_count)}
                </Link>
              ) : (
                "Ninguém usa este perfil"
              )}
            </p>
          </div>
          {editable ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {profile.system_key ? (
                <Button size="sm" variant="ghost" onClick={() => void askReset()} loading={reset.isPending} disabled={dirty}>
                  <RotateCcw className="size-3.5" />
                  Restaurar padrão
                </Button>
              ) : (
                <>
                  {/* O motivo à vista (o title não chega ao teclado nem ao leitor de tela). */}
                  {inUse ? (
                    <span id={deleteHintId} className="text-xs text-ink-muted">
                      Em uso: troque o perfil dessas pessoas antes de excluir.
                    </span>
                  ) : null}
                  <span title={inUse ? `Em uso por ${peopleLabel(profile.users_count)}: troque o perfil delas antes.` : undefined}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void askDelete()}
                      loading={remove.isPending}
                      disabled={inUse}
                      aria-describedby={inUse ? deleteHintId : undefined}
                    >
                      <Trash2 className="size-3.5" />
                      Excluir
                    </Button>
                  </span>
                </>
              )}
            </div>
          ) : null}
        </div>
        {editable ? null : (
          <p className="border-b border-line bg-surface-2/60 px-5 py-2.5 text-xs text-ink-muted">Só o administrador altera os perfis.</p>
        )}
        <AccessMatrix
          catalog={catalog}
          label={`Acesso por tela do perfil ${profile.name}`}
          value={items}
          onChange={onMatrix}
          readOnly={!editable}
          disabled={save.isPending}
        />
      </Card>

      <Card>
        <CardHeader
          title="Visibilidade de filas"
          description="Vale para a Minha fila, as listas, a busca, os contadores e os relatórios."
        />
        {editable ? (
          <QueueFields
            scope={scope}
            unowned={scope === "all" ? true : unowned}
            disabled={save.isPending}
            onScope={setScope}
            onUnowned={setUnowned}
          />
        ) : (
          <div className="px-5 py-4">
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              <Check aria-hidden className="size-4 shrink-0 text-brand" />
              {QUEUE_SCOPE_LABEL[scope]}
            </p>
            <p className="mt-0.5 pl-6 text-xs text-ink-muted">
              {scope === "all"
                ? "Inclui as OS sem analista."
                : unowned
                  ? "Vê também as OS sem analista."
                  : "Não vê as OS sem analista."}
            </p>
          </div>
        )}
      </Card>

      {save.error ? <ErrorBox message={errorMessage(save.error)} /> : null}
      {dirty ? (
        <UnsavedBar message={`Alterações não salvas em ${profile.name}`}>
          <Button onClick={discard} disabled={save.isPending}>
            Descartar
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={custom && name.trim().length < 2}>
            Salvar
          </Button>
        </UnsavedBar>
      ) : null}
    </div>
  );
}

/** "Todas as filas da equipe" ou "Somente a própria fila", com as OS sem analista como opção. */
function QueueFields({
  scope,
  unowned,
  disabled,
  onScope,
  onUnowned,
}: {
  scope: QueueScope;
  unowned: boolean;
  disabled: boolean;
  onScope: (scope: QueueScope) => void;
  onUnowned: (value: boolean) => void;
}) {
  const name = useId();
  const options: { value: QueueScope; hint: string }[] = [
    { value: "all", hint: "Vê as OS de todos os analistas e as sem analista." },
    { value: "own", hint: "Vê só as OS em que é o analista responsável ou o técnico." },
  ];
  return (
    <fieldset className="flex flex-col gap-3 px-5 py-4" disabled={disabled}>
      <legend className="sr-only">Filas que o perfil vê</legend>
      {options.map((o) => (
        <label key={o.value} className={clsx("flex items-start gap-2.5", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
          <input
            type="radio"
            name={name}
            checked={scope === o.value}
            onChange={() => onScope(o.value)}
            className="mt-0.5 size-4 shrink-0 accent-[var(--brand)] disabled:opacity-50"
          />
          <span>
            <span className="block text-sm font-medium text-ink">{QUEUE_SCOPE_LABEL[o.value]}</span>
            <span className="block text-xs text-ink-muted">{o.hint}</span>
          </span>
        </label>
      ))}
      <div className="pl-6.5">
        <Checkbox
          label="Ver também as OS sem analista"
          checked={unowned}
          onChange={onUnowned}
          disabled={disabled || scope !== "own"}
        />
        <p className="mt-0.5 pl-6 text-xs text-ink-muted">
          {scope === "own"
            ? "Para puxar para a própria fila as OS que estão sem dono."
            : "Com todas as filas, as sem analista já entram."}
        </p>
      </div>
    </fieldset>
  );
}

/** Novo perfil: o nome e de qual começar (as telas e a fila vêm iguais às dele). */
function NewProfileDialog({
  profiles,
  defaultFrom,
  onClose,
  onCreated,
}: {
  profiles: AccessProfile[];
  defaultFrom: UUID;
  onClose: () => void;
  onCreated: (profile: AccessProfile) => void;
}) {
  const { toast } = useToast();
  const refresh = useRefreshAccess();
  const [name, setName] = useState("");
  const [from, setFrom] = useState<UUID>(defaultFrom);
  const create = useMutation({
    mutationFn: () => {
      const source = profiles.find((p) => p.id === from);
      const body: AccessProfileCreate = {
        name: name.trim(),
        copy_from_id: from || null,
        // A fila também começa igual à do perfil de origem.
        queue_scope: source?.queue_scope ?? null,
        queue_unowned: source ? source.queue_unowned : null,
      };
      return api.post<AccessProfile>("/access/profiles", body);
    },
    onSuccess: (created) => {
      refresh(created);
      toast({ title: `Perfil ${created.name} criado`, tone: "success" });
      onCreated(created);
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      dirty={name.trim() !== ""}
      busy={create.isPending}
      title="Novo perfil de acesso"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="novo-perfil" loading={create.isPending}>
            Criar perfil
          </Button>
        </>
      }
    >
      <form
        id="novo-perfil"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Nome" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} autoFocus />
        </Field>
        <Field label="Começar igual a" hint="Depois é só ajustar as telas e a fila.">
          <Select value={from} onChange={(e) => setFrom(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {create.error ? <ErrorBox message={errorMessage(create.error)} /> : null}
      </form>
    </Dialog>
  );
}
