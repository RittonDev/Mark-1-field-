// Topo da oferta: o desenho de mapa com a área do atendimento e, embaixo, o bairro e a cidade num chip. Ilustração:
// nunca o endereço nem o pino exato, que só chegam com a OS depois do aceite. Decorativo para o leitor de tela (a área
// é lida no cartão "Área do atendimento").

import { StyleSheet, View } from "react-native";
import { placeLine } from "../../lib/offers";
import type { FieldOfferTicket } from "../../lib/types";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { RouteMapPattern } from "../RouteMapPattern";
import { Text } from "../Text";

const HEIGHT = 168;

export function OfferHero({ ticket }: { ticket: Pick<FieldOfferTicket, "district" | "city" | "state"> }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const place = placeLine(ticket);
  return (
    <View style={styles.hero} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <RouteMapPattern height={HEIGHT} variant="area" />
      {place ? (
        <View style={styles.chipRow}>
          <View style={styles.chip}>
            <Icon name="pin" size={14} color={c.brandInk} />
            <Text style={styles.chipText} numberOfLines={1} maxFontSizeMultiplier={1.3}>
              {place}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    hero: { height: HEIGHT, overflow: "hidden", pointerEvents: "none" },
    chipRow: { position: "absolute", left: 16, right: 16, bottom: 14, alignItems: "center" },
    chip: {
      maxWidth: "100%",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.elevation,
    },
    chipText: { flexShrink: 1, fontSize: 13, fontWeight: "600", color: c.ink },
  });
