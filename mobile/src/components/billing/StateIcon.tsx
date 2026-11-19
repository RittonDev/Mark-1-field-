// Ícone redondo da situação do mês no Faturamento (cartão do mês e topo do mês). A cor vem de EARNINGS_MONTH_STATE (a
// mesma da central); o fundo é o do Badge e o traço passa de 4,5:1 sobre ele, no claro e no escuro. Decorativo: o selo ao
// lado diz o nome da situação.

import { StyleSheet, View } from "react-native";
import { EARNINGS_MONTH_STATE } from "../../lib/constants";
import type { EarningsMonthState } from "../../lib/types";
import { mix, readable, statusFill, tint, useTheme } from "../../theme/theme";
import { Icon, type IconName } from "../Icon";

const STATE_ICON: Record<EarningsMonthState, IconName> = {
  empty: "clock",
  in_progress: "clock",
  no_invoice: "note",
  in_review: "hourglass",
  rejected: "alert",
  to_pay: "wallet",
  partial: "pie",
  paid_no_invoice: "checkCircle",
  paid: "checkCircle",
};

export function StateIcon({ state, size = 40 }: { state: EarningsMonthState; size?: number }) {
  const c = useTheme();
  const base = EARNINGS_MONTH_STATE[state].color;
  const fill = statusFill(base, c);
  const dark = c.scheme === "dark";
  const ink = readable(base, c, mix(c.surface, fill, dark ? 0.14 : 0.09));
  return (
    <View
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: tint(fill, dark ? "24" : "17") }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon name={STATE_ICON[state]} size={Math.round(size * 0.5)} color={ink} strokeWidth={2} />
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: "center", justifyContent: "center" },
});
