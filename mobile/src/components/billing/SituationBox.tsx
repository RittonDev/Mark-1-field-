// Topo do mês no Faturamento: a situação (o selo como título) e o que aconteceu, com o que o técnico pode fazer
// (earningsSituation, de lib/constants.ts). Neutro; só a nota recusada ganha cor. Sem botões: o "Enviar nota fiscal" é
// o das notas, logo abaixo.

import { StyleSheet, View } from "react-native";
import { EARNINGS_MONTH_STATE, earningsSituation } from "../../lib/constants";
import { formatBRL } from "../../lib/expenses";
import { formatDate } from "../../lib/format";
import { useHideValues, useMoney } from "../../lib/hideValues";
import type { EarningsMonth } from "../../lib/types";
import { tint, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Text } from "../Text";
import { StateIcon } from "./StateIcon";

export function SituationBox({ month }: { month: EarningsMonth }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const money = useMoney();
  const hidden = useHideValues();
  const label = EARNINGS_MONTH_STATE[month.state].label;
  const text = earningsSituation(month, { money, day: formatDate });
  // O leitor de tela não lê os pontos do valor oculto.
  const spoken = earningsSituation(month, { money: (value) => (hidden ? "valor oculto" : formatBRL(value)), day: formatDate });
  const rejected = month.state === "rejected";
  return (
    <View
      style={[styles.box, rejected && { backgroundColor: c.dangerSoft, borderColor: tint(c.danger, "40") }]}
      accessible
      accessibilityLabel={spoken ? `${label}. ${spoken}` : label}
      accessibilityLiveRegion="polite"
    >
      <StateIcon state={month.state} size={32} />
      <View style={styles.body}>
        <Text style={[styles.title, rejected && { color: c.dangerInk }]}>{label}</Text>
        {text ? <Text style={styles.text}>{text}</Text> : null}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    box: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      padding: 12,
      borderRadius: 10,
      backgroundColor: c.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
    },
    body: { flex: 1, gap: 2 },
    title: { fontSize: 14, fontWeight: "700", color: c.ink },
    text: { fontSize: 13, lineHeight: 18, color: c.ink },
  });
