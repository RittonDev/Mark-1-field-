"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiErrorText } from "@/components/technicians/ficha/SectionCard";
import { Button, Card, CardHeader, ErrorBox, LoadingBlock } from "@/components/ui";
import { api } from "@/lib/api";
import { LEVEL_RULE_LABEL } from "@/lib/constants";
import { formatDate, formatTime } from "@/lib/format";
import type { LevelRuleChange, LevelRuleChangeItem, UUID } from "@/lib/types";

// "Histórico das regras" de Configurações › Elo: cada mudança das regras do elo, da mais nova para a mais antiga, com
// quando, quem (ou Sistema) e o quê. Salvar e aprovar (LevelRulesCard) mandam buscar de novo.

export const LEVEL_RULES_HISTORY_KEY = ["level-rules", "history"] as const;

/** Linhas por página da API (a cada "Mostrar mais"). */
const PAGE = 20;

const ACTION: Record<LevelRuleChange["action"], string> = {
  seed: "Sugestões preenchidas",
  save: "Alterou",
  approve: "Aprovou",
};

/** As páginas numa lista só, sem repetir linha (uma linha nova no topo empurra a última para a página seguinte). */
function joinPages(pages: LevelRuleChange[][]): LevelRuleChange[] {
  const seen = new Set<UUID>();
  const rows: LevelRuleChange[] = [];
  for (const page of pages) {
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * O `before` da página seguinte: a hora e o id da última linha recebida ("<created_at>|<id>"). Sem página seguinte
 * quando a última veio incompleta (o histórico acabou) ou sem nenhuma linha nova.
 */
function nextBefore(last: LevelRuleChange[], pages: LevelRuleChange[][]): string | undefined {
  if (last.length < PAGE) return undefined;
  const earlier = new Set(pages.slice(0, -1).flatMap((page) => page.map((row) => row.id)));
  if (last.every((row) => earlier.has(row.id))) return undefined;
  const tail = last[last.length - 1];
  return `${tail.created_at}|${tail.id}`;
}

/** "27/11/2026 14:05", no fuso da operação. */
const when = (iso: string) => `${formatDate(iso)} ${formatTime(iso)}`;

/** O texto de uma regra no histórico (em branco: "em branco"). */
const valueText = (value: string | null) => value ?? "em branco";

/** Salvar: "{rótulo}: {de} → {para}". Sugestões e aprovação: "{rótulo}: {texto}". */
function ChangeLine({ action, item }: { action: LevelRuleChange["action"]; item: LevelRuleChangeItem }) {
  const label = LEVEL_RULE_LABEL[item.item] ?? "Regra";
  return (
    <li className="break-words">
      <span className="font-medium">{label}:</span>{" "}
      {action === "save" ? `${valueText(item.from)} → ${valueText(item.to)}` : valueText(item.to)}
    </li>
  );
}

export function LevelRulesHistory() {
  const history = useInfiniteQuery({
    queryKey: LEVEL_RULES_HISTORY_KEY,
    queryFn: ({ pageParam, signal }) =>
      api.get<LevelRuleChange[]>("/level-rules/history", { limit: PAGE, before: pageParam || undefined }, { signal }),
    initialPageParam: "",
    getNextPageParam: (last, pages) => nextBefore(last, pages),
  });
  const rows = useMemo(() => joinPages(history.data?.pages ?? []), [history.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = history;
  // A página seguinte falhou: o aviso, com "Tentar de novo", fica no lugar do "Mostrar mais".
  const moreFailed = history.isFetchNextPageError && !isFetchingNextPage;

  return (
    <Card>
      <CardHeader title="Histórico das regras" />
      {history.isLoading ? (
        <LoadingBlock rows={2} />
      ) : (
        <div className="flex flex-col gap-3 px-5 py-4">
          {history.isError && !rows.length ? (
            <ErrorBox message={apiErrorText(history.error)} onRetry={() => void history.refetch()} />
          ) : !rows.length ? (
            <p className="text-sm text-ink-muted">Nenhuma mudança ainda.</p>
          ) : (
            <ol className="divide-y divide-line" aria-busy={isFetchingNextPage || undefined}>
              {rows.map((row) => (
                <li key={row.id} className="py-2.5 first:pt-0 last:pb-0">
                  <p className="text-xs text-ink-muted">
                    <time dateTime={row.created_at}>{when(row.created_at)}</time> · {row.actor?.name ?? "Sistema"} ·{" "}
                    <span className="font-semibold text-ink">{ACTION[row.action] ?? row.action}</span>
                  </p>
                  {row.changes.length ? (
                    <ul className="mt-1 flex flex-col gap-0.5 text-sm text-ink">
                      {row.changes.map((item, i) => (
                        <ChangeLine key={`${item.item}-${i}`} action={row.action} item={item} />
                      ))}
                    </ul>
                  ) : null}
                  {row.note ? <p className="mt-1 text-xs break-words text-ink-muted">{row.note}</p> : null}
                </li>
              ))}
            </ol>
          )}
          {moreFailed ? (
            <ErrorBox message={apiErrorText(history.error)} onRetry={() => void fetchNextPage()} />
          ) : hasNextPage && rows.length ? (
            <Button size="sm" variant="ghost" className="self-start" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
              Mostrar mais
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}
