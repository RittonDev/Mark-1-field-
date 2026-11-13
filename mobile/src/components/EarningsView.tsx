import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { api, ApiError } from "../lib/api";
import { formatBRL } from "../lib/expenses";
import { formatShort } from "../lib/format";
import type { MyEarnings, PayoutLine } from "../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { Badge, Card, EmptyState, ErrorBox } from "./ui";

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function lineStatus(line: PayoutLine): { label: string; tone: "paid" | "due" | "expected" } {
  if (line.status === "paid") return { label: `Pago ${line.paid_at ? formatShort(line.paid_at).split(",")[0] : ""}`.trim(), tone: "paid" };
  return line.concluded ? { label: "A receber", tone: "due" } : { label: "Previsto", tone: "expected" };
}

/**
 * Meus ganhos: o técnico é parceiro e recebe por chamado. Mostra, por mês, o que tem a receber das OS
 * concluídas, o previsto das que estão em andamento e o que já foi pago, além dos reembolsos.
 * Precisa de internet (os valores são da central); offline mostra o último resultado.
 */
export function EarningsView() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const [month, setMonth] = useState(() => new Date());
  const key = monthKey(month);
  // Resultado do último mês pedido; "carregando" é quando ainda não chegou o do mês na tela.
  const [result, setResult] = useState<{ key: string; data: MyEarnings | null; error: string | null }>({
    key: "",
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    api
      .get<MyEarnings>(`/me/earnings?month=${key}`)
      .then((data) => {
        if (!cancelled) setResult({ key, data, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const error = e instanceof ApiError ? e.message : "Sem conexão: os ganhos aparecem quando a internet voltar.";
        setResult((prev) => ({ key, data: prev.data, error }));
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const loading = result.key !== key;
  const { data, error } = result;

  const shift = (delta: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  const isCurrent = monthKey(month) === monthKey(new Date());
  const toneColor = { paid: c.success, due: c.warning, expected: c.inkMuted } as const;

  return (
    <View style={styles.wrap}>
      <View style={styles.monthNav}>
        <Pressable onPress={() => shift(-1)} accessibilityRole="button" accessibilityLabel="Mês anterior" hitSlop={8} style={styles.navButton}>
          <Icon name="chevronLeft" size={20} color={c.ink} />
        </Pressable>
        <Text style={styles.monthLabel}>
          {MONTHS[month.getMonth()].charAt(0).toUpperCase() + MONTHS[month.getMonth()].slice(1)} de {month.getFullYear()}
        </Text>
        <Pressable
          onPress={() => shift(1)}
          disabled={isCurrent}
          accessibilityRole="button"
          accessibilityLabel="Próximo mês"
          hitSlop={8}
          style={[styles.navButton, isCurrent && { opacity: 0.35 }]}
        >
          <Icon name="chevronRight" size={20} color={c.ink} />
        </Pressable>
      </View>

      {error ? <ErrorBox message={error} /> : null}

      {loading && !data ? (
        <View style={{ paddingVertical: 32 }}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : data ? (
        <>
          <Card style={styles.hero}>
            <Text style={styles.heroLabel}>A receber</Text>
            <Text style={styles.heroValue}>{formatBRL(data.summary.to_pay)}</Text>
            <Text style={styles.heroHint}>OS concluídas que a central ainda vai pagar</Text>
            <View style={styles.row}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Recebido no mês</Text>
                <Text style={styles.statValue}>{formatBRL(data.summary.paid)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Previsto</Text>
                <Text style={styles.statValue}>{formatBRL(data.summary.expected)}</Text>
              </View>
            </View>
            {data.reimbursement_to_receive > 0 || data.reimbursement_paid > 0 ? (
              <Text style={styles.heroHint}>
                Reembolsos: {formatBRL(data.reimbursement_to_receive)} a receber · {formatBRL(data.reimbursement_paid)} pagos no mês
              </Text>
            ) : null}
          </Card>

          {data.items.length ? (
            <Card style={{ paddingVertical: 4 }}>
              {data.items.map((line, i) => {
                const status = lineStatus(line);
                return (
                  <View key={line.id} style={[styles.line, i > 0 && styles.lineBorder]}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.code}>{line.ticket.code}</Text>
                      <Text style={styles.title} numberOfLines={2}>
                        {line.ticket.title}
                      </Text>
                      <Text style={styles.meta} numberOfLines={1}>
                        {[line.ticket.location, line.ticket.city].filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 6 }}>
                      <Text style={styles.amount}>{formatBRL(line.amount)}</Text>
                      <Badge label={status.label} color={toneColor[status.tone]} />
                    </View>
                  </View>
                );
              })}
            </Card>
          ) : (
            <EmptyState
              icon="wallet"
              title="Nenhum chamado neste mês"
              description="O valor de cada OS aparece aqui assim que a central te coloca nela."
            />
          )}
        </>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 12 },
    monthNav: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      padding: 6,
    },
    navButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: RADIUS.control },
    monthLabel: { fontSize: 15, fontWeight: "600", color: c.ink },
    hero: { gap: 4 },
    heroLabel: { fontSize: 13, fontWeight: "600", color: c.inkMuted },
    heroValue: { fontSize: 30, fontWeight: "700", color: c.ink, letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
    heroHint: { fontSize: 12, color: c.inkSubtle, marginTop: 2 },
    row: { flexDirection: "row", gap: 12, marginTop: 12 },
    stat: { flex: 1, backgroundColor: c.surface2, borderRadius: RADIUS.control, padding: 10, gap: 2 },
    statLabel: { fontSize: 12, color: c.inkMuted },
    statValue: { fontSize: 16, fontWeight: "600", color: c.ink, fontVariant: ["tabular-nums"] },
    line: { flexDirection: "row", gap: 12, paddingVertical: 12 },
    lineBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    code: { fontSize: 12, color: c.inkSubtle, fontVariant: ["tabular-nums"] },
    title: { fontSize: 15, fontWeight: "600", color: c.ink },
    meta: { fontSize: 12, color: c.inkMuted },
    amount: { fontSize: 15, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
  });
