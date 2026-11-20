// A patente do técnico (o elo como medalha, lib/level.ts): a medalha hexagonal da faixa com o emblema que cresce (1, 2
// e 3 divisas e a pedra do Diamante), o selo com o nome e o chip do topo de Hoje. A forma e o emblema diferenciam a
// faixa sem depender da cor, e o nome vai sempre escrito junto; a pílula do selo é neutra, com a cor só na medalha.
// Paths e cores em lib/constants.ts (LEVEL_MEDAL_*), a mesma arte da central.

import { router } from "expo-router";
import { useId } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import {
  LEVEL_MEDAL_COLOR,
  LEVEL_MEDAL_EMBLEM,
  LEVEL_MEDAL_FACE_PATH,
  LEVEL_MEDAL_FACET_STROKE,
  LEVEL_MEDAL_FLAT_BELOW,
  LEVEL_MEDAL_GRADIENT,
  LEVEL_MEDAL_RELIEF,
  LEVEL_MEDAL_RIM_PATH,
  LEVEL_MEDAL_SHADE_PATH,
  LEVEL_MEDAL_SHEEN_PATH,
  LEVEL_MEDAL_SIZE,
  LEVEL_MEDAL_STROKE,
  LEVEL_MEDAL_VIEWBOX,
  LEVEL_TIER,
} from "../lib/constants";
import { useMyLevel } from "../lib/level";
import type { LevelMedalKind, LevelTier } from "../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { SVG_HIDDEN } from "./Icon";
import { PressableScale } from "./motion";
import { Text } from "./Text";

/**
 * A patente (medalha do elo). Decorativa: o nome da faixa vai sempre escrito junto. `tier` null: sem elo (apagada).
 * Abaixo de LEVEL_MEDAL_FLAT_BELOW sai lisa (aro cheio, face e emblema); de lá para cima, com o relevo do metal.
 */
export function LevelMedal({ tier, size = LEVEL_MEDAL_SIZE.chip }: { tier: LevelTier | null; size?: number }) {
  const c = useTheme();
  const kind: LevelMedalKind = tier ?? "none";
  const colors = LEVEL_MEDAL_COLOR[kind][c.scheme];
  const emblem = LEVEL_MEDAL_EMBLEM[kind];
  const relief = LEVEL_MEDAL_RELIEF[c.scheme];
  const flat = size < LEVEL_MEDAL_FLAT_BELOW;
  const gradient = !flat && LEVEL_MEDAL_GRADIENT;
  // Um id por medalha: duas na mesma tela (e a pré-visualização web) não trocam os degradês. O id do React traz
  // caracteres que quebram o url(#…).
  const id = useId().replace(/[^A-Za-z0-9]/g, "");
  const rim = flat ? colors.outline : gradient ? `url(#${id}rim)` : colors.rim[0];
  const face = gradient ? `url(#${id}face)` : colors.face[0];
  return (
    <Svg width={size} height={size} viewBox={LEVEL_MEDAL_VIEWBOX} {...SVG_HIDDEN}>
      {gradient ? (
        <Defs>
          <LinearGradient id={`${id}rim`} x1="0.15" y1="0.05" x2="0.85" y2="0.95">
            <Stop offset="0" stopColor={colors.rim[0]} />
            <Stop offset="1" stopColor={colors.rim[1]} />
          </LinearGradient>
          <LinearGradient id={`${id}face`} x1="0.5" y1="0" x2="0.5" y2="1">
            <Stop offset="0" stopColor={colors.face[0]} />
            <Stop offset="1" stopColor={colors.face[1]} />
          </LinearGradient>
        </Defs>
      ) : null}
      <Path
        d={LEVEL_MEDAL_RIM_PATH}
        fill={rim}
        stroke={flat ? "none" : colors.outline}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      {flat ? null : <Path d={LEVEL_MEDAL_SHEEN_PATH} fill="#FFFFFF" fillOpacity={relief.sheen} />}
      {flat ? null : <Path d={LEVEL_MEDAL_SHADE_PATH} fill="#000000" fillOpacity={relief.shade} />}
      <Path
        d={LEVEL_MEDAL_FACE_PATH}
        fill={face}
        stroke={flat ? "none" : colors.edge}
        strokeOpacity={0.6}
        strokeWidth={1}
      />
      {emblem.fills.map((d) => (
        <Path key={d} d={d} fill={colors.emblem} />
      ))}
      {flat
        ? null
        : emblem.facets.map((d) => (
            <Path
              key={d}
              d={d}
              fill="none"
              stroke={colors.face[0]}
              strokeWidth={LEVEL_MEDAL_FACET_STROKE}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
      {emblem.strokes.map((d) => (
        <Path
          key={d}
          d={d}
          fill="none"
          stroke={colors.emblem}
          strokeWidth={LEVEL_MEDAL_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

/**
 * Selo do elo: a medalha e o nome da faixa numa pílula neutra; ponto âmbar quando está em risco. Quem o põe num botão
 * dá ao botão o rótulo completo (o "em risco" do ponto não tem texto).
 */
export function LevelBadge({ tier, atRisk = false }: { tier: LevelTier; atRisk?: boolean }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.badge}>
      <LevelMedal tier={tier} size={LEVEL_MEDAL_SIZE.chip} />
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
      paddingLeft: 5,
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
