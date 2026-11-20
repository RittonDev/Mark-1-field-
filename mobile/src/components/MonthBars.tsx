// Gráfico de colunas de 12 meses das Estatísticas (um por cartão, uma série só, na cor viz1 dos dois temas). As contas
// ficam em lib/monthBars.ts (puro, com sonda em Node). Meses só do sistema antigo ganham uma faixa cinza rotulada
// "Sistema antigo"; nos gráficos de qualidade eles ficam sem barra ("sem medição"). Nada de texto dentro do SVG: os
// rótulos são o Text do app (Manrope e fonte ampliada); os nomes dos meses que aparecem vão cada um na sua caixa
// (axisLabelBoxes), inteiros e sem encostar no vizinho. Tocar num mês mostra o número dele na linha de leitura (até 2
// linhas, com a altura guardada); o leitor de tela trata o gráfico como um elemento ajustável, mês a mês, e a lista
// "Ver mês a mês" da tela é o equivalente completo.

import { useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View, type AccessibilityActionEvent } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { competenceLabel, monthAbbr } from "../lib/constants";
import { haptic } from "../lib/haptics";
import {
  axisLabelBoxes,
  axisTicks,
  barPath,
  barRects,
  formatCount,
  legacyRuns,
  monthReadout,
  stepSelection,
  totalReadout,
  type Noun,
} from "../lib/monthBars";
import type { StatsMonth } from "../lib/types";
import { useStyles, useTheme, type Palette } from "../theme/theme";
import { SVG_HIDDEN } from "./Icon";
import { Text } from "./Text";
import { Card, SectionTitle } from "./ui";

/** Altura da área das barras. */
const PLOT_HEIGHT = 112;
/** Faixa acima das barras: com mês do sistema antigo, cabe o rótulo dele; sem, só o ar da marca de cima. */
const LABEL_BAND = 16;
const LABEL_BAND_PLAIN = 6;
/** Entre a linha de base e os nomes dos meses. */
const AXIS_GAP = 4;
/** A faixa do sistema antigo só leva o rótulo com esta largura ou mais. */
const LEGACY_LABEL_MIN = 64;
/** Com um mês escolhido, as outras barras ficam apagadas assim (sem animação). */
const DIMMED = 0.35;
/** Teto da fonte ampliada nos textos do eixo. */
const AXIS_FONT_MAX = 1.3;

export interface MonthBarsProps {
  title: string;
  subtitle: string;
  noun: Noun;
  /** Os 12 de /me/stats, do mais antigo ao atual. */
  months: StatsMonth[];
  value: (month: StatsMonth) => number;
  /** Gráfico de qualidade: mês só do sistema antigo fica sem barra ("sem medição"). */
  quality: boolean;
}

export function MonthBars({ title, subtitle, noun, months, value, quality }: MonthBarsProps) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const [labelWidth, setLabelWidth] = useState(0);
  // A escolha vale para esta lista de meses: dados novos (ou o mês que virou) voltam ao total.
  const [selection, setSelection] = useState<{ months: StatsMonth[]; index: number } | null>(null);
  const selected = selection && selection.months === months && selection.index < months.length ? selection.index : null;

  const values = months.map((month) => (quality && month.legacy_only ? null : value(month)));
  const legacy = months.map((month) => month.legacy_only);
  const hasLegacy = legacy.some(Boolean);
  const ticks = axisTicks(Math.max(0, ...values.map((v) => v ?? 0)));
  const scale = Math.min(Math.max(fontScale, 1), AXIS_FONT_MAX);
  // A calha do eixo Y: 32, ou 40 quando o maior rótulo tem 4 caracteres ou mais ("1.000"); cresce com a fonte.
  const gutter = Math.round((formatCount(ticks[2]).length >= 4 ? 40 : 32) * scale);
  const band = hasLegacy ? LABEL_BAND : LABEL_BAND_PLAIN;
  const plotWidth = Math.max(0, width - gutter);
  const slot = months.length ? plotWidth / months.length : 0;
  const base = band + PLOT_HEIGHT;
  const bars = barRects(values, gutter, plotWidth, band, PLOT_HEIGHT, ticks[2]);
  const runs = legacyRuns(legacy);
  // Sem a medida do rótulo (o primeiro desenho), nenhum nome: entram na volta seguinte, já nas caixas certas.
  const axisBoxes = labelWidth > 0 ? axisLabelBoxes(months.length, slot, labelWidth) : [];
  const tickY = (tick: number) => base - (ticks[2] > 0 ? (tick / ticks[2]) * PLOT_HEIGHT : 0);

  const readout =
    selected === null
      ? totalReadout(values, noun)
      : monthReadout(values[selected], noun, competenceLabel(months[selected].month), months[selected].current);

  function choose(index: number) {
    haptic.select();
    setSelection(selected === index ? null : { months, index });
  }

  function onAccessibilityAction(event: AccessibilityActionEvent) {
    const action = event.nativeEvent.actionName;
    if (action !== "increment" && action !== "decrement") return;
    setSelection({ months, index: stepSelection(selected, months.length, action === "increment" ? 1 : -1) });
  }

  return (
    <Card>
      <SectionTitle accent>{title}</SectionTitle>
      <Text style={styles.subtitle}>{subtitle}</Text>
      {/* O leitor de tela ouve o mesmo pelo valor do gráfico. A frase vai até 2 linhas (o mês tocado não some no
          corte); duas linhas invisíveis guardam a altura, para o gráfico não pular ao tocar. */}
      <View style={styles.readoutRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text style={[styles.readout, styles.readoutStrong, styles.readoutHold]}>{"0\n0"}</Text>
        <Text style={[styles.readout, styles.readoutText]} numberOfLines={2}>
          <Text style={styles.readoutStrong}>{readout.strong}</Text>
          {readout.rest}
        </Text>
      </View>
      <View
        style={styles.chart}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`${title} por mês, últimos 12 meses`}
        accessibilityValue={{ text: `${readout.strong}${readout.rest}` }}
        accessibilityHint="Deslize para cima ou para baixo para ouvir mês a mês"
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={onAccessibilityAction}
      >
        <View style={{ height: base + 1 }}>
          {width > 0 ? (
            <>
              <Svg width={width} height={base + 1} {...SVG_HIDDEN}>
                {runs.map(([first, last]) => (
                  <Rect
                    key={first}
                    x={gutter + first * slot}
                    y={0}
                    width={(last - first + 1) * slot}
                    height={base}
                    rx={6}
                    fill={c.surface2}
                  />
                ))}
                {[ticks[1], ticks[2]].map((tick) => (
                  <Rect key={tick} x={gutter} y={tickY(tick) - 0.5} width={plotWidth} height={1} fill={c.vizGrid} />
                ))}
                {bars.map((bar, index) =>
                  bar ? (
                    <Path
                      key={months[index].month}
                      d={barPath(bar)}
                      fill={c.viz1}
                      fillOpacity={selected === null || selected === index ? 1 : DIMMED}
                    />
                  ) : null,
                )}
                <Rect x={gutter} y={base - 0.5} width={plotWidth} height={1} fill={c.lineStrong} />
              </Svg>
              {ticks.map((tick) => (
                <View key={tick} style={[styles.tick, { top: tickY(tick), width: gutter - 6 }]}>
                  <Text style={styles.tickText} numberOfLines={1} maxFontSizeMultiplier={AXIS_FONT_MAX}>
                    {formatCount(tick)}
                  </Text>
                </View>
              ))}
              {runs.map(([first, last]) =>
                (last - first + 1) * slot >= LEGACY_LABEL_MIN ? (
                  <Text
                    key={first}
                    style={[styles.legacyLabel, { left: gutter + first * slot, width: (last - first + 1) * slot }]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.1}
                  >
                    Sistema antigo
                  </Text>
                ) : null,
              )}
            </>
          ) : null}
        </View>
        <View style={[styles.axis, { marginLeft: gutter }]}>
          {/* A largura de um rótulo ("dez", no peso do mês atual), medida com a fonte do aparelho. Invisível, ele também
              dá a altura da linha dos meses: os nomes ficam por cima, cada um na sua caixa. */}
          <Text
            style={[styles.month, styles.monthCurrent, styles.measure]}
            maxFontSizeMultiplier={AXIS_FONT_MAX}
            onLayout={(event) => setLabelWidth(event.nativeEvent.layout.width)}
          >
            dez
          </Text>
          {axisBoxes.map((box) => {
            const month = months[box.index];
            return (
              <Text
                key={month.month}
                style={[
                  styles.month,
                  styles.monthLabel,
                  month.current && styles.monthCurrent,
                  { left: box.left, width: box.width, textAlign: box.align },
                ]}
                maxFontSizeMultiplier={AXIS_FONT_MAX}
              >
                {monthAbbr(month.month)}
              </Text>
            );
          })}
        </View>
        {/* Um toque por mês, do tamanho da faixa pela altura toda (o leitor de tela usa o ajustável). */}
        <View
          style={[styles.touch, { left: gutter }]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {months.map((month, index) => (
            <Pressable key={month.month} style={styles.touchSlot} onPress={() => choose(index)} />
          ))}
        </View>
      </View>
    </Card>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    subtitle: { fontSize: 13, lineHeight: 18, color: c.inkMuted, marginTop: -4 },
    readoutRow: { marginTop: 10 },
    readout: { fontSize: 14, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    readoutStrong: { fontWeight: "700", color: c.ink },
    readoutHold: { opacity: 0 },
    readoutText: { position: "absolute", top: 0, left: 0, right: 0 },
    chart: { marginTop: 10 },
    // Uma caixa de altura zero na linha: o rótulo fica centrado nela, qualquer que seja a fonte.
    tick: { position: "absolute", left: 0, height: 0, justifyContent: "center" },
    tickText: { fontSize: 11, color: c.inkMuted, textAlign: "right", fontVariant: ["tabular-nums"] },
    legacyLabel: {
      position: "absolute",
      top: 1,
      fontSize: 10,
      lineHeight: 14,
      fontWeight: "600",
      color: c.inkMuted,
      textAlign: "center",
    },
    axis: { marginTop: AXIS_GAP },
    month: { fontSize: 11, color: c.inkMuted },
    monthLabel: { position: "absolute", top: 0 },
    monthCurrent: { fontWeight: "700", color: c.ink },
    measure: { alignSelf: "flex-start", opacity: 0 },
    touch: { position: "absolute", top: 0, right: 0, bottom: 0, flexDirection: "row" },
    touchSlot: { flex: 1 },
  });
