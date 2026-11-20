// Cartão de um mês no Faturamento: a situação (ícone redondo e selo, que desce para baixo do valor quando não cabe ao
// lado), o valor total, a linha curta do que falta ou aconteceu e, no rodapé, o mês e quantas OS. O mês é o da
// conclusão das OS (a régua de Pagamentos); não há número de fatura. Tocar abre o mês (/faturamento/AAAA-MM).

import { StyleSheet, View } from "react-native";
import { EARNINGS_MONTH_STATE, earningsMonthLine, monthTitle, osCount } from "../../lib/constants";
import { formatBRL } from "../../lib/expenses";
import { formatDate } from "../../lib/format";
import { useHideValues, useMoney } from "../../lib/hideValues";
import type { EarningsMonth } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { PressableScale } from "../motion";
import { Text } from "../Text";
import { Badge } from "../ui";
import { StateIcon } from "./StateIcon";

export function BillingMonthCard({ month, onPress }: { month: EarningsMonth; onPress: (month: string) => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const money = useMoney();
  const hidden = useHideValues();
  const state = EARNINGS_MONTH_STATE[month.state];
  const rejected = month.state === "rejected";
  const title = monthTitle(month.month);
  const count = osCount(month.count);
  const line = earningsMonthLine(month, { money, day: formatDate });
  // O leitor de tela não lê os pontos do valor oculto.
  const spokenLine = earningsMonthLine(month, { money: (value) => (hidden ? "valor oculto" : formatBRL(value)), day: formatDate });
  const label = [title, `valor total ${hidden ? "oculto" : formatBRL(month.total)}`, count, state.label, spokenLine]
    .filter(Boolean)
    .join(", ");

  return (
    <PressableScale
      onPress={() => onPress(month.month)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={rejected ? "Abre o mês com o motivo da recusa" : "Abre o mês"}
      style={styles.card}
      pressedStyle={{ backgroundColor: c.surface2 }}
    >
      <View style={styles.head}>
        <StateIcon state={month.state} size={40} />
        {/* O selo fica à direita do valor quando os dois cabem na linha e desce para baixo dele quando não cabem (selo
            longo, fonte grande, tela estreita): quem decide é a largura do valor, que nunca é espremido. */}
        <View style={styles.headMain}>
          <View style={styles.amount}>
            <Text style={styles.amountLabel}>Valor total</Text>
            {/* Encolher é a última defesa (valor maior que a linha inteira): no RN 0.88 não há piso (minimumFontScale
                não vale). */}
            <Text style={styles.amountValue} numberOfLines={1} adjustsFontSizeToFit>
              {money(month.total)}
            </Text>
          </View>
          <Badge label={state.label} color={state.color} />
        </View>
      </View>
      {line ? (
        <Text style={[styles.line, rejected && { color: c.dangerInk, fontWeight: "600" }]} numberOfLines={2}>
          {line}
        </Text>
      ) : null}
      <View style={styles.divider} />
      <View style={styles.footer}>
        <Icon name="calendar" size={15} color={c.inkMuted} />
        <Text style={styles.footerText} numberOfLines={1}>
          {`${title} · ${count}`}
        </Text>
        <Icon name="chevronRight" size={16} color={c.inkSubtle} />
      </View>
    </PressableScale>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      padding: 16,
      gap: 10,
      boxShadow: c.elevation,
    },
    head: { flexDirection: "row", alignItems: "center", gap: 12 },
    // Quebra a linha pelo tamanho natural do valor e do selo (a base do valor é a largura dele, sem `flex: 1`).
    headMain: { flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 6 },
    amount: { flexGrow: 1, gap: 2 },
    amountLabel: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    amountValue: { fontSize: 22, fontWeight: "700", color: c.ink, letterSpacing: -0.3, fontVariant: ["tabular-nums"] },
    line: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.line },
    footer: { flexDirection: "row", alignItems: "center", gap: 8 },
    footerText: { flex: 1, fontSize: 13, fontWeight: "600", color: c.inkMuted },
  });
