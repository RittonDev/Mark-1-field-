"use client";

import clsx from "clsx";
import { Check } from "lucide-react";
import { useId } from "react";
import { Tabs } from "@/components/motion";
import { NAV_ICONS } from "@/components/nav";
import { useMediaQuery } from "@/components/useMediaQuery";
import { ACCESS_ITEMS, ACCESS_LEVELS, ACCESS_MODULES, LEVEL_HINT, LEVEL_LABEL, LEVEL_RANK, MODULE_LABEL } from "@/lib/permissions";
import type { AccessCatalog, AccessItemKey, AccessLevel, AccessModuleKey } from "@/lib/types";

/** Uma tela da matriz: do catálogo da API ou, enquanto ele carrega, do espelho em lib/permissions. */
interface MatrixItem {
  key: AccessItemKey;
  label: string;
  levels: AccessLevel[];
  hint?: string | null;
}

interface MatrixModule {
  key: AccessModuleKey;
  label: string;
  items: MatrixItem[];
}

/** Níveis por tela; em "override", null devolve a tela ao nível do perfil. */
export type LevelPatch = Partial<Record<AccessItemKey, AccessLevel | null>>;

/** Os módulos e as telas na ordem do menu. */
export function matrixModules(catalog?: AccessCatalog | null): MatrixModule[] {
  if (catalog?.modules?.length) {
    return catalog.modules.map((m) => ({
      key: m.key,
      label: m.label,
      items: m.items.map((i) => ({ key: i.key, label: i.label, levels: i.levels, hint: i.hint })),
    }));
  }
  return ACCESS_MODULES.map((key) => ({ key, label: MODULE_LABEL[key], items: ACCESS_ITEMS.filter((i) => i.module === key) }));
}

/** O maior nível que a tela aceita sem passar do pedido (Editar numa tela só de leitura vira Visualizar). */
function clamp(item: MatrixItem, level: AccessLevel): AccessLevel {
  const allowed = item.levels.filter((l) => LEVEL_RANK[l] <= LEVEL_RANK[level]);
  return allowed[allowed.length - 1] ?? "none";
}

const INHERIT = "perfil";
type Choice = AccessLevel | typeof INHERIT;

/**
 * Matriz "Tela x Nível": uma linha por tela, agrupadas por módulo, com Sem acesso | Visualizar | Editar.
 * A linha do módulo aplica o nível a todas as telas dele (cada uma até onde aceita); com níveis
 * diferentes, nenhum fica marcado e aparece "Misto". Em "override" (ajustes de um usuário), a coluna
 * "Igual ao perfil" segue o perfil, que aparece como referência. No celular, cada linha vira o nome da
 * tela com os níveis lado a lado.
 */
export function AccessMatrix({
  catalog,
  label,
  value,
  onChange,
  disabled = false,
  readOnly = false,
  mode = "profile",
  base,
  adjusted,
  cap,
}: {
  catalog?: AccessCatalog | null;
  /** Nome do conjunto para o leitor de tela (ex.: "Acesso do perfil Analista"). */
  label: string;
  /** Nível que vale em cada tela. */
  value: Record<AccessItemKey, AccessLevel>;
  onChange: (patch: LevelPatch) => void;
  /** Momentaneamente sem edição (salvando). */
  disabled?: boolean;
  /** Só de consulta (quem não altera perfis): o nível de cada tela aparece marcado, sem rádios. */
  readOnly?: boolean;
  /** "profile": níveis do perfil; "override": ajustes de um usuário por cima do perfil. */
  mode?: "profile" | "override";
  /** Override: o nível do perfil em cada tela (a referência da coluna "Igual ao perfil"). */
  base?: Record<AccessItemKey, AccessLevel>;
  /** Override: as telas com nível próprio. */
  adjusted?: Partial<Record<AccessItemKey, AccessLevel>>;
  /** Teto de quem edita (supervisor): níveis acima ficam desabilitados, salvo o que a pessoa já tem. */
  cap?: Partial<Record<AccessItemKey, AccessLevel>>;
}) {
  const uid = useId();
  const wide = useMediaQuery("(min-width: 640px)", true);
  const modules = matrixModules(catalog);
  const override = mode === "override";

  const levelOf = (key: AccessItemKey): AccessLevel => (override ? (adjusted?.[key] ?? base?.[key] ?? value[key]) : value[key]);
  const isAdjusted = (key: AccessItemKey) => override && adjusted?.[key] !== undefined && adjusted[key] !== base?.[key];
  const choiceOf = (key: AccessItemKey): Choice => (override && adjusted?.[key] === undefined ? INHERIT : levelOf(key));
  // O que já está gravado continua escolhível mesmo acima do teto (só não dá para subir mais).
  const allowed = (item: MatrixItem, level: AccessLevel) => {
    const top = cap?.[item.key];
    return !top || LEVEL_RANK[level] <= LEVEL_RANK[top] || level === levelOf(item.key);
  };

  const moduleState = (m: MatrixModule): { choice: Choice | null; levels: AccessLevel[] } => {
    const levels = ACCESS_LEVELS.filter((l) => m.items.some((i) => i.levels.includes(l)));
    if (override && m.items.every((i) => adjusted?.[i.key] === undefined)) return { choice: INHERIT, levels };
    const uniform = levels.find((l) => m.items.every((i) => levelOf(i.key) === clamp(i, l)));
    return { choice: uniform ?? null, levels };
  };
  const applyModule = (m: MatrixModule, choice: Choice) => {
    const patch: LevelPatch = {};
    for (const item of m.items) patch[item.key] = choice === INHERIT ? null : clamp(item, choice);
    onChange(patch);
  };
  const moduleAllowed = (m: MatrixModule, level: AccessLevel) => m.items.every((i) => allowed(i, clamp(i, level)));

  // A coluna "Igual ao perfil" leva também o nível do perfil ao lado do rádio ("Sem acesso" inteiro).
  const grid = override
    ? "grid grid-cols-[minmax(0,1fr)_7rem_repeat(3,5.5rem)] items-stretch"
    : "grid grid-cols-[minmax(0,1fr)_repeat(3,5.5rem)] items-stretch";

  if (!wide) {
    return (
      <div role="group" aria-label={label} className="flex flex-col divide-y divide-line text-sm">
        {modules.map((m) => {
          const state = moduleState(m);
          return (
            <div key={m.key} className="flex flex-col divide-y divide-line">
              <NarrowRow
                title={<ModuleTitle label={m.label} mixed={state.choice === null} />}
                ariaLabel={`${m.label}: todas as telas`}
                options={state.levels.filter((l) => moduleAllowed(m, l) || state.choice === l)}
                current={state.choice === INHERIT ? null : state.choice}
                disabled={disabled || readOnly}
                onPick={(level) => applyModule(m, level)}
                override={override}
                inherited={state.choice === INHERIT}
                onInherit={() => applyModule(m, INHERIT)}
                className="bg-[var(--table-head)]"
              />
              {m.items.map((item) => (
                <NarrowRow
                  key={item.key}
                  title={<ItemTitle item={item} adjusted={isAdjusted(item.key)} />}
                  ariaLabel={item.label}
                  options={item.levels.filter((l) => allowed(item, l))}
                  current={levelOf(item.key)}
                  disabled={disabled || readOnly}
                  onPick={(level) => onChange({ [item.key]: level })}
                  override={override}
                  inherited={choiceOf(item.key) === INHERIT}
                  onInherit={() => onChange({ [item.key]: null })}
                  reference={base?.[item.key]}
                />
              ))}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div role="group" aria-label={label} className="text-sm">
      {/* Cabeçalho só visual: cada opção já tem o nome do nível e cada linha, o nome da tela. */}
      <div aria-hidden className={clsx(grid, "border-b border-line text-[11px] font-bold tracking-[0.06em] text-ink-muted uppercase")}>
        <span className="px-4 py-2.5">Tela</span>
        {override ? (
          <span className="px-1 py-2.5 text-center" title="Segue o nível do perfil (muda junto com ele)">
            Igual ao perfil
          </span>
        ) : null}
        {ACCESS_LEVELS.map((l) => (
          <span key={l} className="px-1 py-2.5 text-center" title={LEVEL_HINT[l]}>
            {LEVEL_LABEL[l]}
          </span>
        ))}
      </div>
      {modules.map((m) => {
        const state = moduleState(m);
        const moduleName = `${uid}-modulo-${m.key}`;
        return (
          <div key={m.key} className="border-b border-line last:border-b-0">
            <div
              role={readOnly ? "group" : "radiogroup"}
              aria-label={`${m.label}: todas as telas`}
              className={clsx(grid, "bg-[var(--table-head)]")}
            >
              <div className="flex min-h-10 items-center px-4 py-2">
                <ModuleTitle label={m.label} mixed={state.choice === null} />
              </div>
              {override ? (
                <RadioCell
                  name={moduleName}
                  label="Igual ao perfil"
                  checked={state.choice === INHERIT}
                  disabled={disabled}
                  readOnly={readOnly}
                  onPick={() => applyModule(m, INHERIT)}
                />
              ) : null}
              {ACCESS_LEVELS.map((l) =>
                state.levels.includes(l) ? (
                  <RadioCell
                    key={l}
                    name={moduleName}
                    label={`${LEVEL_LABEL[l]} em todas`}
                    title={`${LEVEL_LABEL[l]} em todas as telas de ${m.label} (cada uma até onde aceita)`}
                    checked={state.choice === l}
                    disabled={disabled || (!moduleAllowed(m, l) && state.choice !== l)}
                    readOnly={readOnly}
                    onPick={() => applyModule(m, l)}
                  />
                ) : (
                  <Dash key={l} title={`${m.label} não tem ${LEVEL_LABEL[l]}`} />
                ),
              )}
            </div>
            {m.items.map((item) => {
              const name = `${uid}-${item.key}`;
              const choice = choiceOf(item.key);
              return (
                <div
                  key={item.key}
                  role={readOnly ? "group" : "radiogroup"}
                  aria-label={item.label}
                  className={clsx(grid, "border-t border-line transition-colors hover:bg-[var(--row-hover)]")}
                >
                  <div className="flex min-h-11 items-center px-4 py-2">
                    <ItemTitle item={item} adjusted={isAdjusted(item.key)} />
                  </div>
                  {override ? (
                    <RadioCell
                      name={name}
                      label={`Igual ao perfil (${LEVEL_LABEL[base?.[item.key] ?? "none"]})`}
                      checked={choice === INHERIT}
                      disabled={disabled}
                      readOnly={readOnly}
                      onPick={() => onChange({ [item.key]: null })}
                      note={base ? LEVEL_LABEL[base[item.key]] : undefined}
                    />
                  ) : null}
                  {ACCESS_LEVELS.map((l) =>
                    item.levels.includes(l) ? (
                      <RadioCell
                        key={l}
                        name={name}
                        label={LEVEL_LABEL[l]}
                        title={allowed(item, l) ? LEVEL_HINT[l] : "Acima do seu próprio acesso"}
                        checked={choice === l}
                        disabled={disabled || !allowed(item, l)}
                        readOnly={readOnly}
                        onPick={() => onChange({ [item.key]: l })}
                      />
                    ) : (
                      <Dash key={l} title={`${item.label} é só de consulta: não tem ${LEVEL_LABEL[l]}`} />
                    ),
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Nome do módulo no padrão do título de grupo do menu; "Misto" quando as telas têm níveis diferentes. */
function ModuleTitle({ label, mixed }: { label: string; mixed: boolean }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-[11px] font-bold tracking-[0.08em] text-ink uppercase">{label}</span>
      {mixed ? (
        <span className="text-xs text-ink-muted" title="As telas deste módulo têm níveis diferentes">
          Misto
        </span>
      ) : null}
    </span>
  );
}

/** Ícone do menu, nome da tela, "ajustado" e a dica do catálogo. */
function ItemTitle({ item, adjusted }: { item: MatrixItem; adjusted: boolean }) {
  const Icon = NAV_ICONS[item.key];
  return (
    <span className="flex min-w-0 items-start gap-2.5">
      {Icon ? <Icon className="mt-0.5 size-4 shrink-0 text-ink-subtle" /> : null}
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium text-ink">{item.label}</span>
          {adjusted ? (
            <span
              className="inline-flex items-center rounded-full border border-line px-1.5 text-[11px] leading-[18px] font-medium whitespace-nowrap text-ink-muted"
              title="Nível próprio deste usuário, diferente do perfil"
            >
              ajustado
            </span>
          ) : null}
        </span>
        {item.hint ? <span className="block text-[11px] leading-4 text-ink-subtle">{item.hint}</span> : null}
      </span>
    </span>
  );
}

/**
 * Célula com um rádio nativo (a célula toda é clicável). Só de consulta, o nível marcado vira um visto
 * da marca (o rádio desabilitado quase some, ainda mais no tema escuro).
 */
function RadioCell({
  name,
  label,
  title,
  checked,
  disabled,
  readOnly = false,
  onPick,
  note,
}: {
  name: string;
  label: string;
  title?: string;
  checked: boolean;
  disabled: boolean;
  readOnly?: boolean;
  onPick: () => void;
  /** Texto pequeno ao lado (o nível do perfil, na coluna "Igual ao perfil"). */
  note?: string;
}) {
  if (readOnly) {
    return (
      <span className="flex min-h-10 items-center justify-center gap-1.5 px-1" title={title ?? label}>
        {checked ? (
          <>
            <Check aria-hidden className="size-4 shrink-0 text-brand" />
            <span className="sr-only">{label}</span>
            {note ? (
              <span aria-hidden className="truncate text-[11px] text-ink-muted">
                {note}
              </span>
            ) : null}
          </>
        ) : (
          <span aria-hidden className="size-1.5 rounded-full bg-line-strong" />
        )}
      </span>
    );
  }
  return (
    <label
      title={title ?? label}
      className={clsx(
        "flex min-h-10 items-center justify-center gap-1.5 px-1",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onPick}
        aria-label={label}
        className="size-4 shrink-0 accent-[var(--brand)] disabled:opacity-50"
      />
      {note ? (
        <span aria-hidden className="truncate text-[11px] text-ink-muted">
          {note}
        </span>
      ) : null}
    </label>
  );
}

/** Nível que a tela não tem (ex.: Editar no Dashboard, que é só de consulta). */
function Dash({ title }: { title: string }) {
  return (
    <span className="flex min-h-10 items-center justify-center text-ink-subtle" title={title}>
      <span aria-hidden>—</span>
    </span>
  );
}

/** Linha do celular: o nome e os níveis lado a lado (o mesmo controle segmentado das outras telas). */
function NarrowRow({
  title,
  ariaLabel,
  options,
  current,
  disabled,
  onPick,
  override,
  inherited,
  onInherit,
  reference,
  className,
}: {
  title: React.ReactNode;
  ariaLabel: string;
  options: AccessLevel[];
  /** O nível que vale; null = "Misto" (ou o módulo todo igual ao perfil). */
  current: AccessLevel | null;
  disabled: boolean;
  onPick: (level: AccessLevel) => void;
  /** Ajustes de um usuário: mostra se a linha segue o perfil e como voltar a seguir. */
  override: boolean;
  inherited: boolean;
  onInherit: () => void;
  /** O nível do perfil, como referência. */
  reference?: AccessLevel;
  className?: string;
}) {
  const profileText = `Igual ao perfil${reference ? ` (${LEVEL_LABEL[reference]})` : ""}`;
  return (
    <div className={clsx("flex flex-col gap-2 px-3 py-3", className)}>
      {title}
      {disabled ? (
        <p className="text-xs text-ink-muted">
          {override && inherited ? profileText : current ? LEVEL_LABEL[current] : "Misto"}
        </p>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* Em tela muito estreita (fonte grande), os níveis rolam dentro da linha, não a página. */}
          <Tabs<AccessLevel | "nenhum">
            variant="segmented"
            className="max-w-full overflow-x-auto"
            ariaLabel={ariaLabel}
            items={options.map((l) => ({ key: l, label: LEVEL_LABEL[l] }))}
            value={current ?? "nenhum"}
            onChange={(key) => {
              // Tocar no nível que já vale (o do perfil) não vira ajuste.
              if (key !== "nenhum" && !(inherited && key === current)) onPick(key);
            }}
          />
          {!override ? null : inherited ? (
            <span className="text-xs text-ink-muted">{profileText}</span>
          ) : (
            <button type="button" onClick={onInherit} className="text-xs font-semibold text-brand-ink hover:underline">
              Voltar ao perfil{reference ? ` (${LEVEL_LABEL[reference]})` : ""}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
