// Brasão do elo do técnico (lib/level.ts): o escudo na cor da faixa com as marcas (1, 2 ou 3 divisas e a pedra do
// Diamante), o selo com o nome e o chip do topo de Hoje. A forma diferencia a faixa sem depender da cor, e o nome vai
// sempre escrito junto; a pílula é neutra, com a cor só no escudo.

import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { LEVEL_MARK_COLOR, LEVEL_MARKS, LEVEL_SHIELD_PATH, LEVEL_TIER } from "../lib/constants";
import { useMyLevel } from "../lib/level";
import type { LevelTier } from "../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { SVG_HIDDEN } from "./Icon";
import { PressableScale } from "./motion";
import { Text } from "./Text";

/** O escudo do brasão. Decorativo: o nome da faixa vai escrito ao lado. */
export function LevelShield({ tier, size = 16 }: { tier: LevelTier; size?: number }) {
  const c = useTheme();
  const marks = LEVEL_MARK_COLOR[c.scheme];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" {...SVG_HIDDEN}>
      <Path d={LEVEL_SHIELD_PATH} fill={LEVEL_TIER[tier].color[c.scheme]} />
      {LEVEL_MARKS[tier].map((d) => (
        <Path key={d} d={d} fill="none" stroke={marks} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}

/**
 * Selo do elo: o escudo e o nome da faixa numa pílula neutra; ponto âmbar quando está em risco. Quem o põe num botão
 * dá ao botão o rótulo completo (o "em risco" do ponto não tem texto).
 */
export function LevelBadge({ tier, atRisk = false }: { tier: LevelTier; atRisk?: boolean }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.badge}>
      <LevelShield tier={tier} size={16} />
      <Text style={styles.label} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {LEVEL_TIER[tier].label}
      </Text>
      {atRisk ? <View style={[styles.dot, { backgroundColor: c.warning }]} /> : null}
    </View>
  );
}

/** O chip do topo de Hoje: o elo guardado, que abre Meu elo. Some enquanto não há elo guardado. */
export function LevelChip() {
  const stored = useMyLevel();
  if (!stored) return null;
  const { tier, at_risk: risk } = stored.data;
  return (
    <PressableScale
      onPress={() => router.push("/elo")}
      accessibilityRole="button"
      accessibilityLabel={`Elo ${LEVEL_TIER[tier].label}${risk ? ", em risco" : ""}. Abre Meu elo`}
      hitSlop={CHIP_HIT_SLOP}
      style={chipStyle}
    >
      <LevelBadge tier={tier} atRisk={Boolean(risk)} />
    </PressableScale>
  );
}

const chipStyle = { borderRadius: RADIUS.chip, flexShrink: 1 } as const;
/** 28 pt de altura: o toque cresce até 44 pt sem invadir o da foto ao lado (10 pt de distância, 8 pt de folga nela). */
const CHIP_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 2 } as const;

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      minHeight: 28,
      paddingLeft: 6,
      paddingRight: 10,
      borderRadius: RADIUS.chip,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.lineStrong,
      backgroundColor: c.surface2,
      alignSelf: "flex-start",
      flexShrink: 1,
    },
    label: { fontSize: 13, fontWeight: "700", color: c.ink, flexShrink: 1 },
    dot: { width: 7, height: 7, borderRadius: 4 },
  });
