"use client";

import clsx from "clsx";
import { ChevronRight, Lock } from "lucide-react";
import { useId, useState } from "react";
import { AccessMatrix, type LevelPatch } from "@/components/access/AccessMatrix";
import { Field, SectionTitle, Select } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ACCESS_ITEM_KEYS, accessOf, LEVEL_RANK, queuesLabel, ROLE_DEFAULTS } from "@/lib/permissions";
import { useAccessCatalog, useAccessProfiles } from "@/lib/queries";
import type {
  AccessItemKey,
  AccessLevel,
  AccessOverrides,
  AccessProfile,
  EffectiveAccess,
  QueueScope,
  UserAccessIn,
  UserRole,
  UUID,
} from "@/lib/types";

/** O acesso no cadastro: o perfil (null = padrão do papel) e os ajustes por cima dele. */
export interface AccessDraft {
  profileId: UUID | null;
  overrides: AccessOverrides | null;
}

type Levels = Record<AccessItemKey, AccessLevel>;
type QueueChoice = "profile" | "all" | "own_unowned" | "own";

/** Papéis com perfil de acesso (o administrador é total; técnico e cliente ficam fora). */
export const usesAccessProfile = (role: UserRole) => role === "supervisor" || role === "analyst";

/** O perfil escolhido ou, sem escolha, o padrão do papel. */
export function profileFor(profiles: AccessProfile[] | undefined, role: UserRole, profileId: UUID | null): AccessProfile | null {
  const list = profiles ?? [];
  return (profileId ? list.find((p) => p.id === profileId) : null) ?? list.find((p) => p.system_key === role) ?? null;
}

function baseLevels(profile: AccessProfile | null, role: UserRole): Levels {
  return profile?.effective_items ?? ROLE_DEFAULTS[role === "supervisor" ? "supervisor" : "analyst"];
}

function profileQueue(profile: AccessProfile | null): { scope: QueueScope; unowned: boolean } {
  const scope = profile?.queue_scope ?? "all";
  return { scope, unowned: scope === "all" ? true : (profile?.queue_unowned ?? true) };
}

/** Fila que vale com o perfil e os ajustes ("todas as filas" já inclui as sem analista). */
function effectiveQueue(profile: AccessProfile | null, overrides: AccessOverrides | null) {
  const base = profileQueue(profile);
  const scope = overrides?.queue_scope ?? base.scope;
  const unowned = scope === "all" ? true : (overrides?.queue_unowned ?? (base.scope === "own" ? base.unowned : true));
  return { scope, unowned };
}

/**
 * O que vai para a API: só os ajustes que mudam algo em relação ao perfil (a API limpa do mesmo jeito).
 * null quando o acesso fica igual ao do perfil.
 */
export function accessPayload(draft: AccessDraft, profile: AccessProfile | null, role: UserRole): UserAccessIn {
  const base = baseLevels(profile, role);
  const items: Partial<Levels> = {};
  for (const [key, level] of Object.entries(draft.overrides?.items ?? {})) {
    const k = key as AccessItemKey;
    if (level && level !== base[k]) items[k] = level;
  }
  const out: AccessOverrides = {};
  if (Object.keys(items).length) out.items = items;
  const queue = draft.overrides;
  if (queue?.queue_scope != null || queue?.queue_unowned != null) {
    const before = profileQueue(profile);
    const after = effectiveQueue(profile, queue);
    if (after.scope !== before.scope) out.queue_scope = after.scope;
    if (after.scope === "own" && after.unowned !== before.unowned) out.queue_unowned = after.unowned;
  }
  return { profile_id: draft.profileId, overrides: Object.keys(out).length ? out : null };
}

/** Quantas telas o ajuste deixa diferentes do perfil. */
function adjustedCount(draft: AccessDraft, base: Levels): number {
  return Object.entries(draft.overrides?.items ?? {}).filter(([k, level]) => level && level !== base[k as AccessItemKey]).length;
}

const higher = (a: AccessLevel, b: AccessLevel) => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);

/** "Analista · todas as filas · 2 telas ajustadas". */
function summaryOf(profile: AccessProfile, queue: { scope: QueueScope; unowned: boolean }, count: number): string {
  const parts = [profile.name, queuesLabel(queue).toLowerCase()];
  if (count) parts.push(count === 1 ? "1 tela ajustada" : `${count} telas ajustadas`);
  return parts.join(" · ");
}

/**
 * Seção "Acesso" do cadastro de supervisor e analista: o perfil, as filas que a pessoa vê e, recolhidos,
 * os ajustes por tela (a matriz com "Igual ao perfil"). O administrador tem acesso total; técnico e
 * cliente não têm esta seção. O supervisor só dá até o acesso que ele mesmo tem (a API confere).
 */
export function UserAccessFields({
  role,
  draft,
  onChange,
  before,
  disabled = false,
}: {
  role: UserRole;
  draft: AccessDraft;
  onChange: (next: AccessDraft) => void;
  /** O acesso da pessoa antes desta edição (null: cadastro novo). */
  before: EffectiveAccess | null;
  disabled?: boolean;
}) {
  const { user: me } = useAuth();
  const profiles = useAccessProfiles(usesAccessProfile(role));
  const catalog = useAccessCatalog(usesAccessProfile(role));
  const [open, setOpen] = useState(() => Object.keys(draft.overrides?.items ?? {}).length > 0);
  const regionId = useId();

  if (role === "admin") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2.5 sm:col-span-2">
        <Lock aria-hidden className="size-4 shrink-0 text-ink-subtle" />
        <p className="text-sm text-ink">
          <span className="font-semibold">Acesso total.</span>{" "}
          <span className="text-ink-muted">O administrador vê e altera todas as telas e filas.</span>
        </p>
      </div>
    );
  }
  if (!usesAccessProfile(role)) return null;

  const list = profiles.data ?? [];
  const profile = profileFor(list, role, draft.profileId);
  const roleDefault = list.find((p) => p.system_key === role) ?? null;
  const base = baseLevels(profile, role);
  const adjusted = draft.overrides?.items ?? {};
  const value = { ...base, ...adjusted } as Levels;
  const count = adjustedCount(draft, base);

  // Teto de quem edita: o supervisor não dá mais do que tem (nem tira de quem já tinha).
  const mine = accessOf(me);
  const capped = !!mine && !mine.full;
  const capOf = (k: AccessItemKey): AccessLevel => {
    const own = mine?.items[k] ?? "none";
    return before ? higher(own, before.items[k] ?? "none") : own;
  };
  const cap: Partial<Levels> | undefined = capped ? Object.fromEntries(ACCESS_ITEM_KEYS.map((k) => [k, capOf(k)])) : undefined;
  const exceeds = (p: AccessProfile) => capped && ACCESS_ITEM_KEYS.some((k) => LEVEL_RANK[p.effective_items[k]] > LEVEL_RANK[capOf(k)]);
  const mineQueue = mine && !mine.full ? mine.queues : { scope: "all" as QueueScope, unowned: true };
  const queueAllowed = (scope: QueueScope, unowned: boolean) => {
    if (!capped || mineQueue.scope === "all") return true;
    if (scope === "all") return before?.queues.scope === "all";
    return !unowned || mineQueue.unowned || !!before?.queues.unowned;
  };

  const queue = effectiveQueue(profile, draft.overrides);
  const queueChoice: QueueChoice =
    draft.overrides?.queue_scope == null && draft.overrides?.queue_unowned == null
      ? "profile"
      : queue.scope === "all"
        ? "all"
        : queue.unowned
          ? "own_unowned"
          : "own";
  const setQueue = (choice: QueueChoice) => {
    const rest: AccessOverrides = { ...(draft.overrides ?? {}) };
    delete rest.queue_scope;
    delete rest.queue_unowned;
    if (choice === "all") rest.queue_scope = "all";
    else if (choice === "own_unowned") Object.assign(rest, { queue_scope: "own", queue_unowned: true });
    else if (choice === "own") Object.assign(rest, { queue_scope: "own", queue_unowned: false });
    onChange({ ...draft, overrides: rest });
  };
  const onMatrix = (patch: LevelPatch) => {
    const items: Partial<Levels> = { ...(draft.overrides?.items ?? {}) };
    for (const [key, level] of Object.entries(patch)) {
      if (level) items[key as AccessItemKey] = level;
      else delete items[key as AccessItemKey];
    }
    onChange({ ...draft, overrides: { ...(draft.overrides ?? {}), items } });
  };

  // No celular, sem a moldura própria: a matriz usa a largura toda do diálogo.
  return (
    <section aria-label="Acesso" className="flex flex-col gap-4 sm:col-span-2 sm:rounded-xl sm:border sm:border-line sm:p-4">
      <SectionTitle aside={profile ? <span className="text-xs text-ink-muted">{summaryOf(profile, queue, count)}</span> : null} wrap>
        Acesso
      </SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Perfil de acesso"
          hint="As telas e a fila que a pessoa vê. Os perfis ficam na aba Perfis de acesso."
          error={profiles.error && !profiles.data ? `Não foi possível carregar os perfis: ${errorMessage(profiles.error)}` : null}
        >
          <Select
            value={profile?.id ?? ""}
            onChange={(e) => onChange({ ...draft, profileId: e.target.value === roleDefault?.id ? null : e.target.value || null })}
            disabled={disabled || profiles.isLoading}
          >
            {profiles.isLoading ? <option value="">Carregando perfis...</option> : null}
            {list.map((p) => (
              <option key={p.id} value={p.id} disabled={exceeds(p) && p.id !== profile?.id}>
                {p.name}
                {p.system_key === role ? " (padrão do papel)" : ""}
                {exceeds(p) && p.id !== profile?.id ? " — acima do seu acesso" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Filas que vê">
          <Select value={queueChoice} onChange={(e) => setQueue(e.target.value as QueueChoice)} disabled={disabled}>
            <option value="profile">Igual ao perfil ({queuesLabel(profileQueue(profile)).toLowerCase()})</option>
            <option value="all" disabled={!queueAllowed("all", true)}>
              Todas as filas da equipe
            </option>
            <option value="own_unowned" disabled={!queueAllowed("own", true)}>
              Só a própria fila e as sem analista
            </option>
            <option value="own">Só a própria fila</option>
          </Select>
        </Field>
      </div>

      <div className="rounded-lg border border-line">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
        >
          <ChevronRight aria-hidden className={clsx("size-4 shrink-0 text-ink-muted transition-transform duration-150", open && "rotate-90")} />
          Ajustes por tela ({count})
          <span className="font-normal text-ink-muted">· só para esta pessoa</span>
        </button>
        <div id={regionId} hidden={!open} className="border-t border-line">
          {open ? (
            <AccessMatrix
              catalog={catalog.data ?? null}
              label="Ajustes por tela desta pessoa"
              mode="override"
              value={value}
              base={base}
              adjusted={adjusted}
              cap={cap}
              onChange={onMatrix}
              disabled={disabled}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
