// Um mês do Faturamento (/faturamento/AAAA-MM): o que as OS concluídas no mês têm a receber, o que já foi pago e o
// previsto das que estão em andamento, os reembolsos, as notas fiscais da competência (InvoicesCard, com "Enviar nota
// fiscal") e as OS com o valor de cada uma (a coberta por uma nota mostra "NF 1234"). Os valores são da central: a
// cópia guardada no aparelho aparece primeiro e a resposta do servidor substitui; sem internet, fica a cópia com a hora
// em que chegou. Com os valores ocultos (o olho), "R$ •••••".

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { competenceLabel } from "../../lib/constants";
import {
  earningsFailureText,
  earningsStaleText,
  loadMonthEarnings,
  readCachedMonth,
  SYNC_REFRESH_MS,
  type MonthEntry,
} from "../../lib/earnings";
import { formatBRL } from "../../lib/expenses";
import { formatDate } from "../../lib/format";
import { useHideValues, useMoney } from "../../lib/hideValues";
import { useInvoicesVersion } from "../../lib/invoices";
import { openTicketAnywhere } from "../../lib/navigation";
import { useSyncStatus } from "../../lib/sync";
import type { PayoutLine } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { InvoicesCard } from "../InvoicesCard";
import { Skeleton } from "../Skeleton";
import { Text } from "../Text";
import { Badge, Button, Card, EmptyState, ErrorBox, SectionTitle } from "../ui";

/** Dois toques rápidos não abrem a mesma OS duas vezes. */
const DOUBLE_TAP_MS = 600;

function lineStatus(line: PayoutLine): { label: string; tone: "paid" | "due" | "expected" } {
  if (line.status === "paid") return { label: line.paid_at ? `Pago ${formatDate(line.paid_at)}` : "Pago", tone: "paid" };
  return line.concluded ? { label: "A receber", tone: "due" } : { label: "Previsto", tone: "expected" };
}

/**
 * `month` é "AAAA-MM"; `refreshKey` muda a cada "puxar para atualizar" na tela do mês e `onSettled` avisa quando a
 * busca dessa atualização terminou.
 */
export function MonthEarnings({ month, refreshKey = 0, onSettled }: { month: string; refreshKey?: number; onSettled?: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const money = useMoney();
  const hidden = useHideValues();
  const { lastSyncAt } = useSyncStatus();
  // Nota fiscal enviada ou apagada neste aparelho: as OS voltam com o "NF" em dia.
  const invoicesVersion = useInvoicesVersion();
  const [entry, setEntry] = useState<MonthEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A rodada que já terminou: enquanto a da tela não terminar, o título mostra que está atualizando.
  const [settled, setSettled] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const latest = useRef(0);
  const lastFetchAt = useRef(0);
  const lastOpen = useRef(0);
  const round = `${refreshKey}#${retry}#${invoicesVersion}`;

  /** Busca o mês. A resposta que chega atrasada não passa por cima da mais nova. */
  const load = useEffectEvent((notify: boolean) => {
    const seq = latest.current + 1;
    latest.current = seq;
    lastFetchAt.current = Date.now();
    const shown = round;
    void readCachedMonth(month).then((stored) => {
      if (stored) setEntry((prev) => prev ?? stored);
    });
    void loadMonthEarnings(month)
      .then(
        (fresh) => {
          if (latest.current !== seq) return;
          setEntry(fresh);
          setError(null);
        },
        (failure: unknown) => {
          if (latest.current !== seq) return;
          setError(earningsFailureText(failure));
        },
      )
      .finally(() => {
        if (latest.current === seq) setSettled(shown);
        if (notify) onSettled?.();
      });
  });

  // Ao abrir, ao puxar para atualizar, em "Tentar de novo" e quando uma nota fiscal entra ou sai.
  useEffect(() => {
    load(refreshKey > 0);
  }, [month, refreshKey, retry, invoicesVersion]);

  // A central marcou como pago e o app sincronizou: confere de novo (no máximo a cada 2 min).
  useEffect(() => {
    if (!lastSyncAt || Date.now() - lastFetchAt.current < SYNC_REFRESH_MS) return;
    load(false);
  }, [lastSyncAt]);

  function openTicket(id: string) {
    const now = Date.now();
    if (now - lastOpen.current < DOUBLE_TAP_MS) return;
    lastOpen.current = now;
    void openTicketAnywhere(id);
  }

  // "novembro de 2026" → "novembro" ("Chamados de novembro", "Notas fiscais de novembro").
  const monthName = competenceLabel(month).replace(/ de \d{4}$/, "");
  const refreshing = Boolean(entry) && settled !== round;
  const toneColor = { paid: c.success, due: c.primary, expected: c.inkMuted } as const;
  const spoken = (value: number) => (hidden ? "valor oculto" : formatBRL(value));
  const reimbursements = entry ? entry.data.reimbursement_to_receive > 0 || entry.data.reimbursement_paid > 0 : false;

  return (
    <View style={styles.wrap}>
      {!entry && error ? (
        <View style={styles.block}>
          <ErrorBox message={error} />
          <Button title="Tentar de novo" icon="repeat" loading={settled !== round} onPress={() => setRetry((r) => r + 1)} />
        </View>
      ) : !entry ? (
        <Card style={styles.block}>
          <Skeleton width={140} height={12} />
          <View style={styles.stats}>
            <Skeleton height={48} radius={RADIUS.control} style={{ flex: 1 }} />
            <Skeleton height={48} radius={RADIUS.control} style={{ flex: 1 }} />
            <Skeleton height={48} radius={RADIUS.control} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : (
        <>
          {error ? (
            <Text style={styles.stale} accessibilityLiveRegion="polite">
              {earningsStaleText(error, entry.at)}
            </Text>
          ) : null}
          <Card style={styles.summary}>
            <SectionTitle
              accent
              right={refreshing ? <ActivityIndicator size="small" color={c.inkMuted} accessibilityLabel="Atualizando" /> : undefined}
            >
              Chamados de {monthName}
            </SectionTitle>
            <View style={styles.stats}>
              <View style={styles.stat} accessible accessibilityLabel={`A receber: ${spoken(entry.data.summary.to_pay)}`}>
                <Text style={styles.statLabel}>A receber</Text>
                <Text style={styles.statValue}>{money(entry.data.summary.to_pay)}</Text>
              </View>
              <View style={styles.stat} accessible accessibilityLabel={`Já pago: ${spoken(entry.data.summary.paid)}`}>
                <Text style={styles.statLabel}>Já pago</Text>
                <Text style={styles.statValue}>{money(entry.data.summary.paid)}</Text>
              </View>
              <View style={styles.stat} accessible accessibilityLabel={`Previsto: ${spoken(entry.data.summary.expected)}`}>
                <Text style={styles.statLabel}>Previsto</Text>
                <Text style={styles.statValue}>{money(entry.data.summary.expected)}</Text>
              </View>
            </View>
            <Text style={styles.hint}>OS concluídas neste mês. Previsto: OS em que você está e que ainda não foram concluídas.</Text>
            {reimbursements ? (
              <View style={styles.reimbursements}>
                <View
                  style={styles.reimbursementRow}
                  accessible
                  accessibilityLabel={`Reembolsos a receber (todos os meses): ${spoken(entry.data.reimbursement_to_receive)}`}
                >
                  <Text style={styles.reimbursementLabel}>Reembolsos a receber (todos os meses)</Text>
                  <Text style={styles.reimbursementValue}>{money(entry.data.reimbursement_to_receive)}</Text>
                </View>
                <View
                  style={styles.reimbursementRow}
                  accessible
                  accessibilityLabel={`Reembolsos pagos neste mês: ${spoken(entry.data.reimbursement_paid)}`}
                >
                  <Text style={styles.reimbursementLabel}>Reembolsos pagos neste mês</Text>
                  <Text style={styles.reimbursementValue}>{money(entry.data.reimbursement_paid)}</Text>
                </View>
              </View>
            ) : null}
          </Card>
        </>
      )}

      {/* Notas fiscais da competência: no mesmo lugar com os valores, carregando ou com erro (o cartão não é refeito). */}
      <InvoicesCard month={month} monthName={monthName} refreshKey={refreshKey} hidden={hidden} />

      {entry ? (
        entry.data.items.length ? (
          <Card style={styles.lines}>
            {entry.data.items.map((line, i) => {
              const status = lineStatus(line);
              const place = [line.ticket.customer, line.ticket.location, line.ticket.city].filter(Boolean).join(" · ");
              return (
                <Pressable
                  key={line.id}
                  onPress={() => openTicket(line.ticket.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${line.ticket.code}, ${line.ticket.title}, ${spoken(line.amount)}, ${status.label}${line.invoice ? `, nota fiscal ${line.invoice.number}` : ""}`}
                  accessibilityHint="Abre a OS"
                  style={({ pressed }) => [styles.line, i > 0 && styles.lineBorder, pressed && { backgroundColor: c.surface2 }]}
                >
                  <View style={styles.lineBody}>
                    <Text style={styles.code}>
                      {line.ticket.code}
                      {line.ticket.resolved_at ? ` · concluída ${formatDate(line.ticket.resolved_at)}` : ""}
                      {line.invoice ? ` · NF ${line.invoice.number}` : ""}
                    </Text>
                    <Text style={styles.title} numberOfLines={2}>
                      {line.ticket.title}
                    </Text>
                    {place ? (
                      <Text style={styles.meta} numberOfLines={1}>
                        {place}
                      </Text>
                    ) : null}
                    {line.note ? <Text style={styles.note}>{line.note}</Text> : null}
                  </View>
                  <View style={styles.lineSide}>
                    <Text style={styles.amount}>{money(line.amount)}</Text>
                    <Badge label={status.label} color={toneColor[status.tone]} />
                  </View>
                </Pressable>
              );
            })}
          </Card>
        ) : (
          <EmptyState
            icon="wallet"
            title="Nenhum chamado neste mês"
            description="O valor de cada OS aparece aqui assim que a central te coloca nela."
          />
        )
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { gap: 12 },
    block: { gap: 12 },
    stale: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    summary: { gap: 4 },
    stats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    stat: { flexGrow: 1, flexBasis: 96, backgroundColor: c.surface2, borderRadius: RADIUS.control, padding: 10, gap: 2 },
    statLabel: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    statValue: { fontSize: 16, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    hint: { fontSize: 12, color: c.inkMuted, lineHeight: 17, marginTop: 8 },
    reimbursements: {
      marginTop: 10,
      paddingTop: 10,
      gap: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    reimbursementRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    reimbursementLabel: { fontSize: 13, color: c.inkMuted, flex: 1 },
    reimbursementValue: { fontSize: 14, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    lines: { paddingVertical: 4 },
    line: { flexDirection: "row", gap: 12, paddingVertical: 12, paddingHorizontal: 4, marginHorizontal: -4, borderRadius: RADIUS.control },
    lineBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line, borderRadius: 0 },
    lineBody: { flex: 1, gap: 2 },
    lineSide: { alignItems: "flex-end", gap: 6 },
    code: { fontSize: 12, fontWeight: "600", color: c.inkMuted, fontVariant: ["tabular-nums"] },
    title: { fontSize: 15, fontWeight: "600", color: c.ink },
    meta: { fontSize: 13, color: c.inkMuted },
    note: { fontSize: 12, color: c.inkMuted, lineHeight: 17 },
    amount: { fontSize: 15, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
  });
