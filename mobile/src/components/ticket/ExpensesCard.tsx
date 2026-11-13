import { StyleSheet, View } from "react-native";
import { EXPENSE_KIND, EXPENSE_STATUS, formatBRL, formatQty } from "../../lib/expenses";
import { formatDateTime } from "../../lib/format";
import type { Expense } from "../../lib/types";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { Badge, Card, SectionTitle } from "../ui";

/** Custos extras da OS: o técnico vê (para acompanhar o reembolso), mas não lança nem altera. */
export function ExpensesCard({ expenses, userId }: { expenses: Expense[]; userId?: string }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  if (!expenses.length) return null;
  const tone = { muted: c.inkMuted, info: c.info, success: c.success, danger: c.danger };
  const total = expenses.filter((e) => e.status !== "rejected").reduce((sum, e) => sum + (e.total ?? 0), 0);

  return (
    <Card style={{ gap: 10 }}>
      <SectionTitle
        right={
          <View style={styles.readonly} accessible accessibilityLabel="Somente leitura">
            <Icon name="lock" size={14} color={c.inkMuted} />
            <Text style={styles.readonlyText}>Somente leitura</Text>
          </View>
        }
      >
        Custos extras
      </SectionTitle>
      {expenses.map((expense) => {
        const status = EXPENSE_STATUS[expense.status];
        const refund = expense.technician
          ? expense.technician.id === userId
            ? " · reembolso para você"
            : ` · reembolso a ${expense.technician.name}`
          : "";
        return (
          <View key={expense.id} style={styles.item}>
            <View style={styles.row}>
              <Text style={styles.kind}>{EXPENSE_KIND[expense.kind] ?? expense.kind}</Text>
              <Text style={[styles.value, expense.status === "rejected" && styles.struck]}>{formatBRL(expense.total)}</Text>
            </View>
            {expense.description ? <Text style={styles.description}>{expense.description}</Text> : null}
            <Text style={styles.meta}>
              {formatQty(expense.quantity)} × {formatBRL(expense.unit_value)}
              {refund}
            </Text>
            <View style={styles.row}>
              <Badge label={status?.label ?? expense.status} color={tone[status?.tone ?? "muted"]} />
              {expense.paid_at ? <Text style={styles.meta}>pago em {formatDateTime(expense.paid_at)}</Text> : null}
            </View>
            {expense.notes ? <Text style={styles.meta}>{expense.notes}</Text> : null}
          </View>
        );
      })}
      <View style={[styles.row, styles.totalRow]}>
        <Text style={styles.totalLabel}>Total (sem os recusados)</Text>
        <Text style={styles.totalValue}>{formatBRL(total)}</Text>
      </View>
    </Card>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    readonly: { flexDirection: "row", alignItems: "center", gap: 5 },
    readonlyText: { fontSize: 12, color: c.inkMuted, fontWeight: "600" },
    item: {
      gap: 4,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    kind: { fontSize: 15, fontWeight: "600", color: c.ink },
    value: { fontSize: 15, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    struck: { textDecorationLine: "line-through", color: c.inkMuted },
    description: { fontSize: 14, color: c.ink },
    meta: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    totalRow: { paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.lineStrong },
    totalLabel: { fontSize: 13, color: c.inkMuted, fontWeight: "600" },
    totalValue: { fontSize: 17, fontWeight: "800", color: c.ink, fontVariant: ["tabular-nums"] },
  });
