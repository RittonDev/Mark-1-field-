import { StyleSheet, Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { EXPENSE_KIND, EXPENSE_STATUS, formatBRL, formatQty } from "../../lib/expenses";
import { formatDateTime } from "../../lib/format";
import type { Expense } from "../../lib/types";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Badge, Card, SectionTitle } from "../ui";

function LockIcon({ color }: { color: string }) {
  return (
    <Svg width={12} height={14} viewBox="0 0 12 14" accessibilityElementsHidden>
      <Rect x={1} y={6} width={10} height={7.5} rx={1.6} fill={color} />
      <Path d="M3.5 6V4.2a2.5 2.5 0 0 1 5 0V6" stroke={color} strokeWidth={1.5} fill="none" />
    </Svg>
  );
}

/** Custos extras da OS: o técnico vê (para acompanhar o reembolso), mas não lança nem altera. */
export function ExpensesCard({ expenses }: { expenses: Expense[] }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  if (!expenses.length) return null;
  const tone = { muted: c.inkMuted, info: c.info, success: c.success, danger: c.danger };
  const total = expenses.filter((e) => e.status !== "rejected").reduce((sum, e) => sum + (e.total ?? 0), 0);

  return (
    <Card style={{ gap: 10 }}>
      <SectionTitle
        right={
          <View style={styles.readonly} accessibilityLabel="Somente leitura">
            <LockIcon color={c.inkSubtle} />
            <Text style={styles.readonlyText}>Somente leitura</Text>
          </View>
        }
      >
        Custos extras
      </SectionTitle>
      {expenses.map((expense) => {
        const status = EXPENSE_STATUS[expense.status];
        return (
          <View key={expense.id} style={styles.item}>
            <View style={styles.row}>
              <Text style={styles.kind}>{EXPENSE_KIND[expense.kind] ?? expense.kind}</Text>
              <Text style={[styles.value, expense.status === "rejected" && styles.struck]}>{formatBRL(expense.total)}</Text>
            </View>
            {expense.description ? <Text style={styles.description}>{expense.description}</Text> : null}
            <Text style={styles.meta}>
              {formatQty(expense.quantity)} × {formatBRL(expense.unit_value)}
              {expense.technician ? ` · reembolso a ${expense.technician.name}` : ""}
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
    readonlyText: { fontSize: 11, color: c.inkSubtle, fontWeight: "600" },
    item: {
      gap: 4,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    kind: { fontSize: 15, fontWeight: "600", color: c.ink },
    value: { fontSize: 15, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    struck: { textDecorationLine: "line-through", color: c.inkSubtle },
    description: { fontSize: 14, color: c.ink },
    meta: { fontSize: 12, color: c.inkMuted },
    totalRow: { paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.lineStrong },
    totalLabel: { fontSize: 13, color: c.inkMuted, fontWeight: "600" },
    totalValue: { fontSize: 17, fontWeight: "800", color: c.ink, fontVariant: ["tabular-nums"] },
  });
