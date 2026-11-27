"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { LEVEL_RULES_HISTORY_KEY } from "@/components/settings/LevelRulesHistory";
import { FieldError, NeutralChip, UnsavedBar, useLeaveGuard } from "@/components/settings/shared";
import { apiErrorText } from "@/components/technicians/ficha/SectionCard";
import { LevelBadge } from "@/components/technicians/LevelBadge";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, ErrorBox, Field, Input, LoadingBlock, SectionTitle, Select, Table, Td, Th } from "@/components/ui";
import { api, apiErrorCode, errorMessage } from "@/lib/api";
import { LEVEL_ARRIVAL_TIME, LEVEL_LATE_MODE, LEVEL_MIN_BALANCE, LEVEL_RULE_LABEL, LEVEL_RULE_STATE } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import {
  countBandRows,
  draftOf,
  formatPoints,
  LEVEL_RULE_FIELDS,
  LEVEL_TIER_OF,
  type LevelBandRow,
  type LevelCountTier,
  type LevelRuleDraft,
  type LevelRuleField,
  type LevelRuleProblems,
  levelRuleProblems,
  openingBalance,
  openingLine,
  pointsBandRows,
  previewBands,
  readInt,
  sameLevelValues,
  tierForBalance,
  tierForCount,
  valuesOf,
} from "@/lib/levelRules";
import { useCan } from "@/lib/permissions";
import type {
  LevelArrivalTime,
  LevelLateMode,
  LevelMinBalance,
  LevelRuleKey,
  LevelRules,
  LevelRulesApprove,
  LevelRulesIn,
  LevelRuleStamp,
  LevelRuleStatus,
  LevelTier,
} from "@/lib/types";

// Configurações › Elo (elo por pontos, Etapa 1): as 13 regras com o estado de cada uma (falta definir, a validar,
// aprovado), a aprovação com quem e quando, a prévia (não grava) e a situação da ativação. Só a central vê pontos. Até a
// ativação (Etapa 2), o elo de 12 meses continua valendo.

export const LEVEL_RULES_KEY = ["level-rules", "current"] as const;

/** GET /level-rules: as regras, o estado de cada uma e o que falta para ativar. */
export function useLevelRules() {
  return useQuery({
    queryKey: LEVEL_RULES_KEY,
    queryFn: ({ signal }) => api.get<LevelRules>("/level-rules", undefined, { signal }),
    // Voltar para a aba no meio da edição não relê (o formulário fica com o que foi digitado).
    refetchOnWindowFocus: false,
  });
}

const ruleId = (key: LevelRuleKey) => `elo-${key}`;
const fieldId = (field: LevelRuleField) => `elo-campo-${field.replace(".", "-")}`;
const ruleLabel = (key: LevelRuleKey) => LEVEL_RULE_LABEL[key] ?? key;

/** "Ana Exemplo em 27/11/2026" (sem o nome quando a API não manda quem). */
const stampText = (verb: string, stamp: LevelRuleStamp) =>
  `${verb}${stamp.by ? ` por ${stamp.by.name}` : ""} em ${formatDate(stamp.at)}`;

/** A linha de apoio da regra: quem aprovou, que mudou depois da aprovação, quem alterou, ou de onde veio o valor. */
function supportText(key: LevelRuleKey, status: LevelRuleStatus | undefined): string | null {
  if (!status) return null;
  if (status.state === "approved" && status.approved) return stampText("Aprovado", status.approved);
  if (status.approved) return key === "confirmers" ? "Os perfis mudaram depois da aprovação" : "Mudou depois da aprovação";
  if (status.changed) return stampText("Alterado", status.changed);
  if (key === "confirmers") return "Pelos perfis de acesso";
  if (status.origin === "qa") return "Sugestão do QA";
  if (status.origin === "default") return "Padrão do sistema";
  return null;
}

/**
 * O cartão "Elo por pontos". Com alteração não salva, uma versão nova das regras (outra tela salvou; a reconexão relê
 * tudo) não apaga o que foi digitado: o formulário fica na versão em que se baseia e avisa que as regras mudaram.
 */
export function LevelRulesCard() {
  const rules = useLevelRules();
  const { toast } = useToast();
  const latest = rules.data;
  const [dirty, setDirty] = useState(false);
  // A versão do formulário e as recargas (Recarregar recria o formulário mesmo na mesma versão).
  const [base, setBase] = useState<LevelRules | undefined>(latest);
  const [round, setRound] = useState(0);
  if (latest && latest !== base && (!base || !dirty || latest.version === base.version)) setBase(latest);
  const stale = !!latest && !!base && latest.version !== base.version;

  const reload = async () => {
    const result = await rules.refetch();
    if (result.isSuccess) {
      setBase(result.data);
      setRound((r) => r + 1);
    } else {
      toast({ title: "Não foi possível recarregar", description: apiErrorText(result.error), tone: "error" });
    }
  };

  return (
    <Card>
      <CardHeader title="Elo por pontos" />
      {base ? (
        <LevelRulesForm
          key={`${base.version}:${round}`}
          rules={base}
          stale={stale}
          reloading={rules.isFetching}
          onDirtyChange={setDirty}
          onSaved={setBase}
          onReload={() => void reload()}
        />
      ) : rules.isError ? (
        <div className="p-4">
          <ErrorBox message={apiErrorText(rules.error)} onRetry={() => void rules.refetch()} />
        </div>
      ) : (
        <LoadingBlock rows={4} />
      )}
    </Card>
  );
}

function LevelRulesForm({
  rules,
  stale,
  reloading,
  onDirtyChange,
  onSaved,
  onReload,
}: {
  rules: LevelRules;
  /** Outra versão chegou enquanto havia alteração não salva aqui. */
  stale: boolean;
  reloading: boolean;
  onDirtyChange: (dirty: boolean) => void;
  /** A versão que a API devolveu ao salvar ou aprovar. */
  onSaved: (rules: LevelRules) => void;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const formId = useId();
  const canEdit = rules.can_edit;
  const [draft, setDraft] = useState(() => draftOf(rules.values));
  const problems = useMemo(() => levelRuleProblems(draft), [draft]);
  const values = useMemo(() => valuesOf(draft), [draft]);
  const dirty = canEdit && !sameLevelValues(values, rules.values);
  useLeaveGuard(dirty, "As regras do elo alteradas ainda não foram salvas.");
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const set = (patch: Partial<LevelRuleDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setCount = (tier: LevelCountTier, value: string) =>
    setDraft((d) => ({ ...d, count_bands: { ...d.count_bands, [tier]: value } }));
  const setPoints = (tier: LevelTier, value: string) => setDraft((d) => ({ ...d, points_bands: { ...d.points_bands, [tier]: value } }));
  const setLate = (patch: Partial<LevelRuleDraft["late"]>) => setDraft((d) => ({ ...d, late: { ...d.late, ...patch } }));
  const conflict = (error: unknown) => apiErrorCode(error) === "LEVEL_RULES_CHANGED";
  const adopt = (saved: LevelRules) => {
    queryClient.setQueryData(LEVEL_RULES_KEY, saved);
    void queryClient.invalidateQueries({ queryKey: LEVEL_RULES_HISTORY_KEY });
    onSaved(saved);
  };

  const save = useMutation({
    mutationFn: (body: LevelRulesIn) => api.put<LevelRules>("/level-rules", body),
    onSuccess: (saved) => {
      adopt(saved);
      toast({ title: "Regras do elo salvas", tone: "success" });
    },
    onError: (error) => {
      if (!conflict(error)) toast({ title: "Não foi possível salvar as regras", description: errorMessage(error), tone: "error" });
    },
  });

  const approve = useMutation({
    mutationFn: (key: LevelRuleKey) => {
      const body: LevelRulesApprove = { version: rules.version, keys: [key] };
      return api.post<LevelRules>("/level-rules/approve", body);
    },
    onSuccess: (saved, key) => {
      adopt(saved);
      toast({ title: `Aprovado: ${ruleLabel(key)}`, tone: "success" });
    },
    onError: (error) => {
      if (!conflict(error)) toast({ title: "Não foi possível aprovar", description: errorMessage(error), tone: "error" });
    },
  });

  const busy = save.isPending || approve.isPending;
  const changedElsewhere = stale || conflict(save.error) || conflict(approve.error);

  const submit = () => {
    if (!dirty || busy) return;
    // Com erro, o Salvar leva ao primeiro campo a corrigir (a mensagem já está embaixo dele).
    const first = LEVEL_RULE_FIELDS.find((field) => problems[field]);
    if (first || !values) {
      if (first) document.getElementById(fieldId(first))?.focus();
      return;
    }
    save.mutate({ ...values, version: rules.version });
  };

  const discard = () => {
    save.reset();
    setDraft(draftOf(rules.values));
  };

  const askApprove = async (key: LevelRuleKey) => {
    const text = rules.items[key]?.text ?? LEVEL_RULE_STATE.pending;
    const ok = await confirm({
      title: `Aprovar ${ruleLabel(key)}?`,
      description: `${text}. Fica no histórico com o seu nome.`,
      confirmLabel: "Aprovar",
    });
    if (ok) approve.mutate(key);
  };

  /** A regra: o nome em negrito, a linha de apoio, o estado e o Aprovar (o conteúdo vem em `children`). */
  const rule = (key: LevelRuleKey, children: React.ReactNode) => {
    const status = rules.items[key];
    const state = status?.state ?? "pending";
    const support = supportText(key, status);
    return (
      <div
        id={ruleId(key)}
        role="group"
        aria-labelledby={`${ruleId(key)}-nome`}
        className="flex min-w-0 scroll-mt-32 flex-col gap-2.5 rounded-lg border border-line p-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          <div className="min-w-0">
            <p id={`${ruleId(key)}-nome`} className="text-sm font-bold text-ink">
              {ruleLabel(key)}
            </p>
            {support ? <p className="mt-0.5 text-xs text-ink-muted">{support}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <NeutralChip>{LEVEL_RULE_STATE[state] ?? state}</NeutralChip>
            {canEdit && state === "to_validate" ? (
              // O title fica no envoltório: no botão desabilitado ele não aparece.
              <span title={dirty ? "Salve antes de aprovar" : undefined}>
                <Button size="sm" onClick={() => void askApprove(key)} disabled={dirty || busy} loading={approve.isPending && approve.variables === key}>
                  Aprovar
                </Button>
              </span>
            ) : null}
          </div>
        </div>
        {children}
      </div>
    );
  };

  /** Sem `can_edit`: o texto da regra (ou "Falta definir"). */
  const readText = (key: LevelRuleKey) => <p className="text-sm text-ink">{rules.items[key]?.text ?? LEVEL_RULE_STATE.pending}</p>;

  const numberField = (field: LevelRuleField, value: string, onChange: (value: string) => void, unit: string, labelledBy: string) => (
    <NumberField id={fieldId(field)} value={value} onChange={onChange} unit={unit} problem={problems[field]} labelledBy={labelledBy} />
  );
  const nameOf = (key: LevelRuleKey) => `${ruleId(key)}-nome`;

  const opening = openingLine(draft);

  return (
    // A barra de alteração não salva é filha direta do formulário: presa ao rodapé enquanto o cartão está na tela.
    <form
      id={formId}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col px-5 pt-4 pb-5"
    >
      <Situation rules={rules} />
      {changedElsewhere ? (
        <div className="flex flex-col items-start gap-2 pt-4">
          <ErrorBox message="As regras do elo mudaram em outra tela." />
          <Button size="sm" onClick={onReload} loading={reloading}>
            Recarregar
          </Button>
        </div>
      ) : null}
      <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0 pt-5">
        <Block title="Categorias">
          <div className="grid gap-3 lg:grid-cols-2">
            {rule(
              "count_bands",
              <BandTable
                label={ruleLabel("count_bands")}
                rows={countBandRows(draft.count_bands)}
                last="ou mais"
                input={
                  canEdit
                    ? (tier) => {
                        // O Bronze das contagens começa em 0 (sem campo).
                        if (tier === "bronze") return null;
                        const field: LevelRuleField = `count_bands.${tier}`;
                        return (
                          <NumberField
                            id={fieldId(field)}
                            value={draft.count_bands[tier]}
                            onChange={(value) => setCount(tier, value)}
                            problem={problems[field]}
                            label={`${ruleLabel("count_bands")}: início ${LEVEL_TIER_OF[tier]}`}
                          />
                        );
                      }
                    : undefined
                }
              />,
            )}
            {rule(
              "points_bands",
              <BandTable
                label={ruleLabel("points_bands")}
                rows={pointsBandRows(draft.points_bands)}
                last="sem limite"
                input={
                  canEdit
                    ? (tier) => {
                        const field: LevelRuleField = `points_bands.${tier}`;
                        return (
                          <NumberField
                            id={fieldId(field)}
                            value={draft.points_bands[tier]}
                            onChange={(value) => setPoints(tier, value)}
                            problem={problems[field]}
                            label={`${ruleLabel("points_bands")}: início ${LEVEL_TIER_OF[tier]}`}
                          />
                        );
                      }
                    : undefined
                }
              />,
            )}
          </div>
          {rule(
            "opening_bonus",
            canEdit ? (
              <div className="flex flex-col gap-1.5">
                {numberField("opening_bonus", draft.opening_bonus, (v) => set({ opening_bonus: v }), "pontos", nameOf("opening_bonus"))}
                {opening ? <p className="text-xs text-ink-muted tabular-nums">Abertura: {opening}</p> : null}
              </div>
            ) : (
              readText("opening_bonus")
            ),
          )}
        </Block>

        <Block title="Prévia">
          <Preview draft={draft} problems={problems} />
        </Block>

        <Block title="Ganhos e perdas">
          <div className="grid gap-3 md:grid-cols-2">
            {rule(
              "completion_gain",
              canEdit
                ? numberField("completion_gain", draft.completion_gain, (v) => set({ completion_gain: v }), "pontos", nameOf("completion_gain"))
                : readText("completion_gain"),
            )}
            {rule(
              "on_time_gain",
              canEdit
                ? numberField("on_time_gain", draft.on_time_gain, (v) => set({ on_time_gain: v }), "pontos", nameOf("on_time_gain"))
                : readText("on_time_gain"),
            )}
            {rule(
              "late",
              canEdit ? (
                <div className="flex flex-wrap items-start gap-2">
                  <div className="flex flex-col gap-1">
                    <Select
                      id={fieldId("late.mode")}
                      value={draft.late.mode}
                      onChange={(e) => setLate({ mode: e.target.value as LevelLateMode | "" })}
                      className="w-52"
                      aria-labelledby={nameOf("late")}
                      aria-invalid={problems["late.mode"] ? true : undefined}
                      aria-describedby={problems["late.mode"] ? `${fieldId("late.mode")}-erro` : undefined}
                    >
                      <option value="">{LEVEL_RULE_STATE.pending}</option>
                      {(Object.keys(LEVEL_LATE_MODE) as LevelLateMode[]).map((mode) => (
                        <option key={mode} value={mode}>
                          {LEVEL_LATE_MODE[mode]}
                        </option>
                      ))}
                    </Select>
                    {problems["late.mode"] ? <FieldError id={`${fieldId("late.mode")}-erro`}>{problems["late.mode"]}</FieldError> : null}
                  </div>
                  {draft.late.mode === "deduct" ? (
                    <NumberField
                      id={fieldId("late.points")}
                      value={draft.late.points}
                      onChange={(v) => setLate({ points: v })}
                      unit="pontos"
                      problem={problems["late.points"]}
                      label={`${ruleLabel("late")}: pontos descontados`}
                    />
                  ) : null}
                </div>
              ) : (
                readText("late")
              ),
            )}
            {rule(
              "abandonment_loss",
              canEdit
                ? numberField("abandonment_loss", draft.abandonment_loss, (v) => set({ abandonment_loss: v }), "pontos", nameOf("abandonment_loss"))
                : readText("abandonment_loss"),
            )}
            {rule(
              "rework_loss",
              canEdit
                ? numberField("rework_loss", draft.rework_loss, (v) => set({ rework_loss: v }), "pontos", nameOf("rework_loss"))
                : readText("rework_loss"),
            )}
            {rule(
              "min_balance",
              canEdit ? (
                <ListField<LevelMinBalance>
                  labelledBy={nameOf("min_balance")}
                  value={draft.min_balance}
                  options={LEVEL_MIN_BALANCE}
                  onChange={(v) => set({ min_balance: v })}
                />
              ) : (
                readText("min_balance")
              ),
            )}
          </div>
        </Block>

        <Block title="Operação">
          <div className="grid gap-3 md:grid-cols-2">
            {rule(
              "arrival_tolerance",
              canEdit
                ? numberField("arrival_tolerance", draft.arrival_tolerance, (v) => set({ arrival_tolerance: v }), "min", nameOf("arrival_tolerance"))
                : readText("arrival_tolerance"),
            )}
            {rule(
              "arrival_time",
              canEdit ? (
                <ListField<LevelArrivalTime>
                  labelledBy={nameOf("arrival_time")}
                  value={draft.arrival_time}
                  options={LEVEL_ARRIVAL_TIME}
                  onChange={(v) => set({ arrival_time: v })}
                />
              ) : (
                readText("arrival_time")
              ),
            )}
            {rule("confirmers", <ConfirmersText text={rules.items.confirmers?.text ?? null} />)}
            {rule(
              "app_reasons",
              canEdit ? (
                <Select
                  value={draft.app_reasons ? "on" : "off"}
                  onChange={(e) => set({ app_reasons: e.target.value === "on" })}
                  className="w-52"
                  aria-labelledby={nameOf("app_reasons")}
                >
                  <option value="off">Desligado</option>
                  <option value="on">Ligado (sem pontos)</option>
                </Select>
              ) : (
                readText("app_reasons")
              ),
            )}
          </div>
        </Block>
      </fieldset>
      {dirty ? (
        <UnsavedBar message="Regras do elo alteradas e não salvas">
          <Button onClick={discard} disabled={busy}>
            Descartar
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={approve.isPending}>
            Salvar regras
          </Button>
        </UnsavedBar>
      ) : null}
    </form>
  );
}

/** Situação: ainda não ativo, o que falta definir e aprovar (com o link para cada regra) e quem altera. */
function Situation({ rules }: { rules: LevelRules }) {
  const define = rules.missing?.define ?? [];
  const approve = rules.missing?.approve ?? [];
  return (
    <section aria-label="Situação" className="flex flex-col gap-1 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted">
      {rules.active ? null : (
        <p>
          <strong className="font-semibold text-ink">Ainda não ativo.</strong> O elo de 12 meses continua valendo.
        </p>
      )}
      {define.length ? (
        <p>
          <strong className="font-semibold text-ink">Falta definir:</strong> <RuleLinks keys={define} />.
        </p>
      ) : null}
      {approve.length ? (
        <p>
          <strong className="font-semibold text-ink">Falta aprovar:</strong> <RuleLinks keys={approve} />.
        </p>
      ) : null}
      {!define.length && !approve.length ? (
        <p>{rules.active ? "Tudo aprovado." : "Tudo aprovado. A ativação entra com a abertura pelo histórico."}</p>
      ) : null}
      {rules.can_edit ? null : <p>Só supervisor e administrador alteram e aprovam.</p>}
    </section>
  );
}

/** "Atendimento concluído, Chegada dentro do SLA e Saldo mínimo", cada uma levando à regra (e ao campo dela). */
function RuleLinks({ keys }: { keys: LevelRuleKey[] }) {
  return (
    <>
      {keys.map((key, i) => (
        <Fragment key={key}>
          {i === 0 ? null : i === keys.length - 1 ? " e " : ", "}
          <a
            href={`#${ruleId(key)}`}
            onClick={() => {
              // A âncora rola até a regra; o foco vai junto para o campo dela (o teclado continua de lá).
              document
                .getElementById(ruleId(key))
                ?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled])")
                ?.focus({ preventScroll: true });
            }}
            className="font-medium text-brand-ink underline-offset-2 hover:underline"
          >
            {ruleLabel(key)}
          </a>
        </Fragment>
      ))}
    </>
  );
}

/** Um bloco do cartão (Categorias, Prévia, Ganhos e perdas, Operação). */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle as="h3">{title}</SectionTitle>
      {children}
    </section>
  );
}

/** Campo de número com a unidade ao lado e o erro embaixo. */
function NumberField({
  id,
  value,
  onChange,
  unit,
  problem,
  labelledBy,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  unit?: string;
  problem?: string;
  /** O nome do campo: o da regra (aria-labelledby) ou um próprio (aria-label). */
  labelledBy?: string;
  label?: string;
}) {
  const errorId = `${id}-erro`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          maxLength={12}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-28 tabular-nums"
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : label}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? errorId : undefined}
        />
        {unit ? <span className="text-xs text-ink-muted">{unit}</span> : null}
      </div>
      {problem ? <FieldError id={errorId}>{problem}</FieldError> : null}
    </div>
  );
}

/** Lista que começa em "Falta definir" (em branco). */
function ListField<T extends string>({
  labelledBy,
  value,
  options,
  onChange,
}: {
  labelledBy: string;
  value: T | "";
  options: Record<T, string>;
  onChange: (value: T | "") => void;
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as T | "")} className="w-52" aria-labelledby={labelledBy}>
      <option value="">{LEVEL_RULE_STATE.pending}</option>
      {(Object.keys(options) as T[]).map((key) => (
        <option key={key} value={key}>
          {options[key]}
        </option>
      ))}
    </Select>
  );
}

/**
 * Tabela De | Até de uma regra de categorias. `input`: o campo do início de cada categoria (null no Bronze das
 * contagens, que começa em 0); sem ele, os números. O fim é o início da seguinte menos 1; o Diamante, `last`.
 */
function BandTable({
  label,
  rows,
  last,
  input,
}: {
  label: string;
  rows: LevelBandRow[];
  last: string;
  input?: (tier: LevelTier) => React.ReactNode | null;
}) {
  const number = (n: number | null) => (n === null ? <span className="text-ink-subtle">—</span> : formatPoints(n));
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <Table label={label}>
        <thead>
          <tr>
            <Th>Categoria</Th>
            <Th>De</Th>
            <Th>Até</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const field = input?.(row.tier) ?? null;
            return (
              <tr key={row.tier}>
                <Td className="align-top">
                  <LevelBadge tier={row.tier} size="md" className="mt-1.5" />
                </Td>
                {/* Os textos na altura do meio do campo (o selo e o número alinhados com ele). */}
                <Td className="align-top tabular-nums">{field ?? <span className="inline-block pt-2">{number(row.from)}</span>}</Td>
                <Td className="align-top text-ink-muted tabular-nums">
                  <span className="inline-block pt-2">{i === rows.length - 1 ? last : number(row.to)}</span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

/** Quem confirma abandono e retorno: sai dos perfis de acesso (e dos ajustes por pessoa); muda lá. */
function ConfirmersText({ text }: { text: string | null }) {
  const canUsers = useCan("setup.users");
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-ink">{text ?? LEVEL_RULE_STATE.pending}</p>
      {canUsers ? (
        <Link href="/usuarios?aba=perfis" className="self-start text-xs font-semibold text-brand-ink underline-offset-2 hover:underline">
          Perfis de acesso
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Prévia com as faixas da tela (nada é gravado): a categoria e o saldo de abertura por quantidade de atendimentos, e a
 * categoria por saldo (aceita negativo). Com erro nas faixas ou no bônus, "Corrija as faixas.".
 */
function Preview({ draft, problems }: { draft: LevelRuleDraft; problems: LevelRuleProblems }) {
  const [count, setCount] = useState("");
  const [balance, setBalance] = useState("");
  const bands = previewBands(draft, problems);
  const countValue = readInt(count);
  const balanceValue = readInt(balance);
  const countBad = countValue !== null && (Number.isNaN(countValue) || countValue < 0);
  const balanceBad = balanceValue !== null && Number.isNaN(balanceValue);
  const countTier = bands && countValue !== null && !countBad ? tierForCount(countValue, bands.count) : null;
  const balanceTier = bands && balanceValue !== null && !balanceBad ? tierForBalance(balanceValue, bands.points) : null;
  // Enter na prévia não envia as regras.
  const stay = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.preventDefault();
  };
  return (
    <div className="flex flex-col gap-3">
      {bands ? null : <p className="text-xs font-medium text-red-600 dark:text-red-400">Corrija as faixas.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Field label="Atendimentos concluídos" error={countBad ? "Use um número inteiro." : null}>
            <Input
              inputMode="numeric"
              autoComplete="off"
              maxLength={12}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              onKeyDown={stay}
              className="w-28 tabular-nums"
              aria-invalid={countBad ? true : undefined}
            />
          </Field>
          {countTier && bands ? (
            <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
              <LevelBadge tier={countTier} size="md" />
              <span className="tabular-nums">abre com {formatPoints(openingBalance(countTier, bands.points, bands.bonus))} pontos</span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Field label="Saldo" error={balanceBad ? "Use um número inteiro." : null}>
            <Input
              autoComplete="off"
              maxLength={14}
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              onKeyDown={stay}
              className="w-28 tabular-nums"
              aria-invalid={balanceBad ? true : undefined}
            />
          </Field>
          {balanceTier ? (
            <p className="flex items-center gap-2 text-sm text-ink">
              <LevelBadge tier={balanceTier} size="md" />
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
