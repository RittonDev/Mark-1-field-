"use client";

import { type QueryClient, type QueryKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, Check, Circle, ExternalLink, Info } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { useToast } from "@/components/Toaster";
import { Button, ErrorBox, Field, Input, SectionTitle, Skeleton } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { LEVEL_OCCURRENCE, LEVEL_TIER } from "@/lib/constants";
import { formatDate, formatShort } from "@/lib/format";
import { useCan } from "@/lib/permissions";
import { technicianLevelKey as levelKey } from "@/lib/realtime";
import type {
  CentralLevelOccurrence,
  LevelCriterion,
  LevelMetrics,
  LevelSummary,
  LevelWaiverCreate,
  Technician,
  TechnicianLevelDetail,
  UUID,
} from "@/lib/types";
import { LevelMedal } from "./LevelBadge";

/** Motivo de desconsiderar uma ocorrência: até 300 caracteres (o mesmo limite da API). */
const NOTE_MAX = 300;
/** Ocorrências na primeira vista e a cada "Ver mais" (a API manda até 200, as mais recentes primeiro). */
const FIRST = 10;
const MORE = 20;
/** A OS da ocorrência quando é de outra fila (quem pede vê só a própria): a API manda só o tipo, a data e o detalhe. */
const HIDDEN_TICKET = "OS de outra fila";

/** OS de outra fila: sem link e sem desconsiderar nem voltar a contar (a API responde 403). */
const isHidden = (o: CentralLevelOccurrence) => o.ticket.hidden || !o.ticket.id;

/** O selo das listas (faixa, desde quando e risco) a partir do detalhe recalculado. */
function summaryOf(detail: TechnicianLevelDetail): LevelSummary {
  return { tier: detail.tier, since: detail.since, at_risk: detail.at_risk !== null };
}

function withLevel(t: Technician, technicianId: UUID, level: LevelSummary): Technician {
  if (t.id !== technicianId || !t.level) return t;
  const same = t.level.tier === level.tier && t.level.at_risk === level.at_risk && t.level.since === level.since;
  return same ? t : { ...t, level };
}

/**
 * Leva o elo recalculado para o selo das listas já carregadas (Técnicos, a busca da oferta e o cadastro aberto
 * por link), sem reler a base inteira e sem marcar essas listas como recém-buscadas.
 */
function syncLevelCaches(queryClient: QueryClient, technicianId: UUID, detail: TechnicianLevelDetail) {
  const level = summaryOf(detail);
  const write = (key: QueryKey, data: Technician | Technician[]) =>
    queryClient.setQueryData(key, data, { updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt });
  for (const prefix of [
    ["technicians", "list"],
    ["technicians", "search"],
  ]) {
    for (const [key, list] of queryClient.getQueriesData<Technician[]>({ queryKey: prefix })) {
      if (!Array.isArray(list) || !list.some((t) => withLevel(t, technicianId, level) !== t)) continue;
      write(key, list.map((t) => withLevel(t, technicianId, level)));
    }
  }
  const oneKey = ["technicians", "one", technicianId];
  const one = queryClient.getQueryData<Technician>(oneKey);
  const patched = one ? withLevel(one, technicianId, level) : one;
  if (patched && patched !== one) write(oneKey, patched);
}

/**
 * O elo do técnico na central (GET /technicians/{id}/level): a API recalcula na hora. O selo das listas, que
 * pode ter até 6 h, acompanha o que veio. A chave fica fora de ["technicians"], que quase todo evento de OS relê:
 * o tempo real relê só o elo do técnico que está no evento (lib/realtime.tsx).
 */
export function useTechnicianLevel(technicianId: UUID) {
  const queryClient = useQueryClient();
  const canView = useCan("base.technicians");
  return useQuery({
    queryKey: levelKey(technicianId),
    queryFn: async ({ signal }) => {
      const detail = await api.get<TechnicianLevelDetail>(`/technicians/${technicianId}/level`, undefined, { signal });
      syncLevelCaches(queryClient, technicianId, detail);
      return detail;
    },
    enabled: canView,
    // Cada leitura recalcula (e grava) o técnico: não relê a cada volta para a janela.
    staleTime: 60_000,
  });
}

const occurrenceKey = (o: Pick<CentralLevelOccurrence, "kind" | "ref_id">) => `${o.kind}:${o.ref_id}`;

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Taxa dos números (null com menos de 5 casos). */
function Rate({ value }: { value: number | null }) {
  return value === null ? <span title="Ainda sem dados suficientes">—</span> : <>{value}%</>;
}

/** "Últimos 12 meses: 38 atendimentos (30 como responsável, 8 junto) · 25 medidos · chegada no horário 92% ·…". */
function MetricsLine({ metrics: m }: { metrics: LevelMetrics }) {
  return (
    <p className="text-xs text-ink-muted">
      <span className="font-semibold text-ink/80">Últimos 12 meses:</span> {plural(m.services, "atendimento", "atendimentos")}
      {m.as_helper > 0 ? ` (${m.as_assignee} como responsável, ${m.as_helper} junto)` : ""} ·{" "}
      {plural(m.measured, "medido", "medidos")} · chegada no horário <Rate value={m.on_time_pct} /> · retorno{" "}
      <Rate value={m.rework_pct} /> · visitas perdidas <Rate value={m.lost_pct} />
    </p>
  );
}

/** Os critérios de uma faixa: cumprido (verde) ou não (círculo), com o texto da API e o que falta. */
function CriteriaList({ title, criteria }: { title: string; criteria: LevelCriterion[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs font-semibold text-ink/80">{title}</p>
      <ul className="flex flex-col gap-1.5">
        {criteria.map((c) => (
          <li key={c.key} className="flex items-start gap-2">
            {c.met ? (
              <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
            )}
            <span className="min-w-0">
              <span className="sr-only">{c.met ? "Cumprido: " : "Não cumprido: "}</span>
              <span className="block text-sm font-medium text-ink">{c.label}</span>
              <span className="block text-xs text-ink-muted">
                {c.text}
                {c.missing ? (
                  <>
                    {" · "}
                    <span className="font-medium text-ink">{c.missing}</span>
                  </>
                ) : null}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Elo" no cadastro do técnico: a faixa e desde quando, o risco de descer, o que falta para a próxima faixa,
 * os números dos últimos 12 meses e as ocorrências que pesaram (com o link para a OS). Com Técnicos em Editar,
 * a central desconsidera uma ocorrência (com o motivo) e faz a desconsiderada voltar a contar. A ocorrência de
 * OS de outra fila (quem pede vê só a própria) fica sem link e sem essas ações. Os textos chegam prontos da API.
 * Fica fora do fieldset travado do cadastro: só com Visualizar, ainda dá para ver mais.
 * `dirty`: o cadastro tem alteração não salva (o link para Configurações abre em outra aba).
 * `hideTitle`: dentro de um cartão que já tem o título "Elo" (a seção da ficha do técnico), o título daqui some.
 */
export function LevelSection({
  tech,
  readOnly,
  dirty,
  onDraftChange,
  hideTitle = false,
}: {
  tech: Pick<Technician, "id" | "name">;
  readOnly: boolean;
  dirty: boolean;
  /** Há um motivo digitado e ainda não enviado: o cadastro pergunta antes de fechar. */
  onDraftChange?: (draft: boolean) => void;
  hideTitle?: boolean;
}) {
  const title = hideTitle ? null : <SectionTitle>Elo</SectionTitle>;
  const ids = useId();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  // Os motivos de visita improdutiva ficam em Configurações (editáveis já com Visualizar).
  const canSettings = useCan("setup.settings");
  const level = useTechnicianLevel(tech.id);
  const [shown, setShown] = useState(FIRST);
  const [waiving, setWaivingState] = useState<{ key: string; note: string } | null>(null);
  const detail = level.data;
  const firstName = tech.name.trim().split(/\s+/)[0] || tech.name;
  const pending = dirty || Boolean(waiving?.note.trim());

  const actionId = (key: string) => `${ids}-${key}`;
  // Depois de fechar o campo ou de concluir, o foco volta ao botão da linha (o "Desconsiderar" vira "Voltar a
  // contar" e vice-versa) assim que ele estiver na tela e habilitado.
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const key = focusNext.current;
    const button = key ? document.getElementById(actionId(key)) : null;
    if (button instanceof HTMLButtonElement && !button.disabled) {
      button.focus();
      focusNext.current = null;
    }
  });
  const setWaiving = (next: { key: string; note: string } | null) => {
    setWaivingState(next);
    onDraftChange?.(Boolean(next?.note.trim()));
  };

  const applied = (next: TechnicianLevelDetail, title: string, key: string) => {
    const before = detail?.tier;
    queryClient.setQueryData(levelKey(tech.id), next);
    syncLevelCaches(queryClient, tech.id, next);
    void queryClient.invalidateQueries({ queryKey: ["technician-suggest"] });
    toast({
      title,
      description: before && before !== next.tier ? `Elo de ${firstName} agora: ${LEVEL_TIER[next.tier].label}` : undefined,
      tone: "success",
    });
    focusNext.current = key;
  };
  const waive = useMutation({
    mutationFn: (body: LevelWaiverCreate) =>
      api.post<TechnicianLevelDetail>(`/technicians/${tech.id}/level/waivers`, body),
    onSuccess: (next, body) => {
      setWaiving(null);
      applied(next, "Ocorrência desconsiderada", occurrenceKey(body));
    },
    onError: (error, body) => {
      // Já desconsiderada por outra pessoa (409), saiu dos 12 meses (422) ou a OS foi para outra fila (403): o campo
      // fecha e a lista volta como está agora. Falha de rede ou do servidor: o campo fica, com o motivo, para tentar
      // de novo.
      if (error instanceof ApiError && (error.status === 403 || error.status === 409 || error.status === 422)) {
        toast({ title: errorMessage(error), tone: "error" });
        setWaiving(null);
        focusNext.current = occurrenceKey(body);
      }
      void queryClient.invalidateQueries({ queryKey: levelKey(tech.id) });
    },
  });
  const restore = useMutation({
    mutationFn: ({ waiverId }: { waiverId: UUID; key: string }) =>
      api.delete<TechnicianLevelDetail>(`/technicians/${tech.id}/level/waivers/${waiverId}`),
    onSuccess: (next, { key }) => applied(next, "A ocorrência voltou a contar", key),
    onError: (error) => {
      toast({ title: "A ocorrência continua desconsiderada", description: errorMessage(error), tone: "error" });
      void queryClient.invalidateQueries({ queryKey: levelKey(tech.id) });
    },
  });
  const busy = waive.isPending || restore.isPending;

  const openWaiving = (key: string) => {
    waive.reset();
    setWaiving({ key, note: "" });
  };
  const cancelWaiving = () => {
    focusNext.current = waiving?.key ?? null;
    waive.reset();
    setWaiving(null);
  };
  const submitWaiver = (o: CentralLevelOccurrence) => {
    const note = waiving?.note.trim() ?? "";
    if (note && !waive.isPending) waive.mutate({ kind: o.kind, ref_id: o.ref_id, note });
  };
  const askRestore = async (o: CentralLevelOccurrence, waiverId: UUID) => {
    const ok = await confirm({
      title: "Voltar a contar esta ocorrência?",
      description: `Ela volta a pesar no elo de ${firstName}, e a desconsideração (com o motivo) é apagada.`,
      confirmLabel: "Voltar a contar",
    });
    if (ok) restore.mutate({ waiverId, key: occurrenceKey(o) });
  };

  if (level.isLoading) {
    return (
      <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
        {title}
        <Skeleton className="h-16 w-full" />
      </section>
    );
  }
  if (!detail) {
    // Sem a busca (sem Técnicos) ou com a API ainda sem o elo (404): a seção não aparece.
    if (!level.error || (level.error instanceof ApiError && level.error.status === 404)) return null;
    return (
      <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
        {title}
        <ErrorBox message={errorMessage(level.error)} onRetry={() => void level.refetch()} />
      </section>
    );
  }

  const tier = LEVEL_TIER[detail.tier];
  // Em risco, primeiro o que falta para continuar na faixa; depois, o caminho para a próxima (no Diamante,
  // o que pede para continuar nele).
  const blocks: { title: string; criteria: LevelCriterion[] }[] = [];
  if (detail.at_risk && detail.criteria.length) blocks.push({ title: `Para continuar ${tier.at}`, criteria: detail.criteria });
  if (detail.next) blocks.push({ title: `Para chegar ${LEVEL_TIER[detail.next.tier].to}`, criteria: detail.next.criteria });
  else if (!detail.at_risk && detail.criteria.length) blocks.push({ title: `Para continuar ${tier.at}`, criteria: detail.criteria });
  const occurrences = detail.occurrences;
  const columns = readOnly ? 4 : 5;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
      {/* A patente em relevo e, ao lado, a faixa (o nome sempre escrito junto da medalha), desde quando e o risco. */}
      <div className="flex items-center gap-3">
        <LevelMedal tier={detail.tier} size={40} />
        <div className="flex min-w-0 flex-col gap-0.5">
          {title}
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
            <span>
              <span className="font-semibold text-ink">{tier.label}</span> · desde {formatDate(detail.since)}
            </span>
            {detail.at_risk ? (
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" />
                em risco
              </span>
            ) : null}
          </p>
        </div>
      </div>

      {detail.at_risk ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
          <p className="min-w-0">
            <span className="block font-semibold">Elo {tier.label} em risco</span>
            {detail.at_risk.text}
          </p>
        </div>
      ) : null}

      {blocks.length ? (
        <div className={clsx("grid gap-3", blocks.length > 1 && "sm:grid-cols-2")}>
          {blocks.map((b) => (
            <CriteriaList key={b.title} title={b.title} criteria={b.criteria} />
          ))}
        </div>
      ) : null}

      <MetricsLine metrics={detail.metrics} />

      {detail.technician_reasons === 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">
            Nenhum motivo de visita improdutiva está com responsabilidade Técnico: visitas perdidas não contam.
            {canSettings ? (
              <>
                {" "}
                {/* Com alteração pendente no cadastro, em outra aba: sair daqui descartaria o que foi feito. */}
                <Link
                  href="/configuracoes#motivos"
                  target={pending ? "_blank" : undefined}
                  rel={pending ? "noreferrer" : undefined}
                  className="rounded font-semibold whitespace-nowrap text-brand-ink underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                >
                  Configurar motivos
                </Link>
              </>
            ) : null}
          </span>
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-xs font-semibold text-ink/80">
            Ocorrências <span className="font-normal text-ink-muted tabular-nums">({detail.occurrences_total})</span>
          </p>
          {detail.waived ? (
            <p className="text-xs text-ink-muted tabular-nums">{plural(detail.waived, "desconsiderada", "desconsideradas")}</p>
          ) : null}
        </div>
        {occurrences.length ? (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-2 text-ink-muted">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-semibold">
                    Ocorrência
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-semibold">
                    OS
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-semibold">
                    Quando
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-semibold">
                    Detalhe
                  </th>
                  {readOnly ? null : (
                    <th scope="col" className="px-2 py-1.5">
                      <span className="sr-only">Ação</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {occurrences.slice(0, shown).map((o) => {
                  const key = occurrenceKey(o);
                  const hidden = isHidden(o);
                  const open = !readOnly && !hidden && !o.waiver && waiving?.key === key;
                  const what = `${LEVEL_OCCURRENCE[o.kind].toLowerCase()} · ${o.ticket.code ?? HIDDEN_TICKET}`;
                  return (
                    <Fragment key={key}>
                      <tr className={clsx(o.waiver ? "bg-surface-2/50 text-ink-muted" : "text-ink")}>
                        <td className={clsx("min-w-28 px-2 py-1.5 align-top", !o.waiver && "font-medium")}>
                          {LEVEL_OCCURRENCE[o.kind]}
                        </td>
                        <td className="px-2 py-1.5 align-top whitespace-nowrap">
                          {hidden ? (
                            <span className="text-ink-muted">{HIDDEN_TICKET}</span>
                          ) : (
                            <Link
                              href={`/chamados/${o.ticket.id}`}
                              target="_blank"
                              rel="noreferrer"
                              title={o.ticket.title}
                              className="inline-flex items-center gap-1 rounded font-medium underline-offset-2 hover:text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                            >
                              {o.ticket.code}
                              <ExternalLink aria-hidden className="size-3" />
                              <span className="sr-only"> (abre em outra aba)</span>
                            </Link>
                          )}
                        </td>
                        <td className="px-2 py-1.5 align-top whitespace-nowrap tabular-nums">{formatDate(o.at)}</td>
                        <td className="min-w-40 px-2 py-1.5 align-top">
                          <span className="break-words">{o.detail}</span>
                          {o.waiver ? (
                            <span className="mt-0.5 block break-words">
                              Desconsiderada{o.waiver.created_by ? ` por ${o.waiver.created_by.name}` : ""} em{" "}
                              {formatDate(o.waiver.created_at)}
                              {o.waiver.note ? `: ${o.waiver.note}` : null}
                            </span>
                          ) : null}
                        </td>
                        {readOnly ? null : (
                          <td className="px-2 py-1 text-right align-top whitespace-nowrap">
                            {hidden ? null : o.waiver ? (
                              <Button
                                id={actionId(key)}
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                loading={restore.isPending && restore.variables?.key === key}
                                disabled={busy}
                                onClick={() => {
                                  if (o.waiver) void askRestore(o, o.waiver.id);
                                }}
                                aria-label={`Voltar a contar: ${what}`}
                              >
                                Voltar a contar
                              </Button>
                            ) : (
                              <Button
                                id={actionId(key)}
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                disabled={busy}
                                aria-expanded={open}
                                onClick={() => (open ? cancelWaiving() : openWaiving(key))}
                                aria-label={`Desconsiderar: ${what}`}
                              >
                                Desconsiderar
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                      {open && waiving ? (
                        <tr>
                          <td colSpan={columns} className="bg-surface-2/60 px-2 pt-1.5 pb-2.5">
                            <div className="flex flex-col gap-2">
                              <Field label="Motivo" required>
                                <Input
                                  value={waiving.note}
                                  onChange={(e) => setWaiving({ key, note: e.target.value })}
                                  onKeyDown={(e) => {
                                    // Enter desconsidera (não salva o cadastro); Esc fecha só o campo.
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      submitWaiver(o);
                                    } else if (e.key === "Escape") {
                                      e.preventDefault();
                                      cancelWaiving();
                                    }
                                  }}
                                  maxLength={NOTE_MAX}
                                  autoComplete="off"
                                  autoFocus
                                />
                              </Field>
                              {waive.error ? <ErrorBox message={errorMessage(waive.error)} /> : null}
                              <div className="flex flex-wrap justify-end gap-2">
                                <Button size="sm" onClick={cancelWaiving} disabled={waive.isPending}>
                                  Cancelar
                                </Button>
                                <Button
                                  size="sm"
                                  variant="primary"
                                  loading={waive.isPending}
                                  disabled={!waiving.note.trim()}
                                  onClick={() => submitWaiver(o)}
                                >
                                  Desconsiderar
                                </Button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-ink-muted">Nenhuma ocorrência nos últimos 12 meses.</p>
        )}
        {occurrences.length > shown ? (
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setShown((n) => n + MORE)}>
            Ver mais
          </Button>
        ) : detail.occurrences_total > occurrences.length ? (
          <p className="text-xs text-ink-muted tabular-nums">
            Mostrando as {occurrences.length} mais recentes de {detail.occurrences_total}.
          </p>
        ) : null}
      </div>

      <details className="text-xs">
        <summary className="w-fit cursor-pointer rounded font-semibold text-ink-muted select-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none">
          Como funciona o elo
        </summary>
        <div className="mt-2 flex flex-col gap-2.5">
          <ul className="flex flex-col gap-1.5">
            {detail.tiers.map((rule) => (
              <li key={rule.tier} className="flex items-start gap-2">
                <LevelMedal tier={rule.tier} size={20} />
                <span className="min-w-0 text-ink-muted">
                  <span className="font-semibold text-ink">{LEVEL_TIER[rule.tier].label}</span> · {rule.summary}
                </span>
              </li>
            ))}
          </ul>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-ink-muted">
            {detail.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
      </details>

      <p className="text-xs text-ink-subtle">Atualizado em {formatShort(detail.computed_at)}</p>
    </section>
  );
}
