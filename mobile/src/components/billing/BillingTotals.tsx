// Topo do Faturamento: "Total pago" e "A receber" (com o previsto e o que ficou de meses anteriores), os reembolsos à
// parte e, quando a atualização falhou, de quando são os valores. Lado a lado; empilhados com a fonte a partir de 1,25 ou
// em tela estreita. Com os valores ocultos (o olho), "R$ •••••" e o leitor de tela diz "oculto".

import { StyleSheet, useWindowDimensions, View } from "react-native";
import { formatBRL } from "../../lib/expenses";
import { formatDate } from "../../lib/format";
import { useHideValues, useMoney } from "../../lib/hideValues";
import type { EarningsTotals } from "../../lib/types";
import { useStyles, type Palette } from "../../theme/theme";
import { Text } from "../Text";
import { Card } from "../ui";

export function BillingTotals({ totals, stale }: { totals: EarningsTotals; stale?: string | null }) {
  const styles = useStyles(makeStyles);
  const money = useMoney();
  const hidden = useHideValues();
  const { width, fontScale } = useWindowDimensions();
  // A partir de 1,25 (pega o "Maior" do Android, 1,3, que chega como 1,2999…) ou em tela estreita: um embaixo do outro.
  const stacked = fontScale >= 1.25 || width < 340;
  const spoken = (value: number) => (hidden ? "oculto" : formatBRL(value));

  const lastPaid = totals.last_paid_at ? `Último pagamento em ${formatDate(totals.last_paid_at)}` : null;
  const expected = totals.expected > 0 ? `+ ${money(totals.expected)} previsto` : null;
  const older = totals.to_pay_older > 0 ? `Inclui ${money(totals.to_pay_older)} de meses anteriores` : null;
  const reimbursements = [
    totals.reimbursement_to_receive > 0 ? `${money(totals.reimbursement_to_receive)} a receber` : null,
    totals.reimbursement_paid > 0 ? `${money(totals.reimbursement_paid)} pagos` : null,
  ].filter(Boolean);

  const paidLabel = [`Total pago: ${spoken(totals.paid)}`, lastPaid].filter(Boolean).join(". ");
  const dueLabel = [
    `A receber: ${spoken(totals.to_pay)}`,
    expected ? (hidden ? "Com valor previsto" : `Mais ${formatBRL(totals.expected)} previsto`) : null,
    older ? (hidden ? "Inclui meses anteriores" : `Inclui ${formatBRL(totals.to_pay_older)} de meses anteriores`) : null,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <View style={styles.wrap}>
      <View style={[styles.cards, stacked && styles.cardsStacked]}>
        <Card style={[styles.card, !stacked && styles.cardSide]}>
          <View accessible accessibilityLabel={paidLabel} style={styles.cardBody}>
            <Text style={styles.label}>Total pago</Text>
            {/* Valor maior que o cartão encolhe sem piso (o RN 0.88 ignora o minimumFontScale); com a fonte grande, empilha. */}
            <Text style={styles.value} numberOfLines={1} adjustsFontSizeToFit>
              {money(totals.paid)}
            </Text>
            {lastPaid ? <Text style={styles.caption}>{lastPaid}</Text> : null}
          </View>
        </Card>
        <Card style={[styles.card, !stacked && styles.cardSide]}>
          <View accessible accessibilityLabel={dueLabel} style={styles.cardBody}>
            <Text style={styles.label}>A receber</Text>
            <Text style={styles.value} numberOfLines={1} adjustsFontSizeToFit>
              {money(totals.to_pay)}
            </Text>
            {expected ? <Text style={styles.caption}>{expected}</Text> : null}
            {older ? <Text style={styles.caption}>{older}</Text> : null}
          </View>
        </Card>
      </View>
      {reimbursements.length ? (
        <Text style={styles.reimbursements} accessibilityLabel={hidden ? "Reembolsos: valores ocultos" : undefined}>
          {`Reembolsos · ${reimbursements.join(" · ")}`}
        </Text>
      ) : null}
      {stale ? (
        <Text style={styles.stale} accessibilityLiveRegion="polite">
          {stale}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { gap: 8 },
    cards: { flexDirection: "row", gap: 8 },
    cardsStacked: { flexDirection: "column" },
    card: { paddingVertical: 14 },
    cardSide: { flex: 1 },
    cardBody: { gap: 2 },
    label: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    value: { fontSize: 24, fontWeight: "700", color: c.ink, letterSpacing: -0.4, fontVariant: ["tabular-nums"], marginTop: 2 },
    caption: { fontSize: 12, color: c.inkMuted, lineHeight: 16 },
    reimbursements: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    stale: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
  });
