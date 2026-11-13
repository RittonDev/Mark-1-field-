import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { Easing, Keyframe, useReducedMotion } from "react-native-reanimated";
import type { FormStep } from "../../lib/forms";
import { tint, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { toneInk } from "../ticket/tones";
import { SectionLabel } from "./FieldInput";

// Peças do formulário "uma pergunta por tela": barra de passos, troca de pergunta e revisão final.

export type StepState = "answered" | "missing" | "empty";
export type StepDirection = "forward" | "back" | "none";

/** Muitas perguntas: a barra vira contínua (traços ficariam finos demais). */
const MAX_SEGMENTS = 30;

/** "Pergunta 3 de 12", atalho para a revisão e um traço por pergunta (respondida, pendente, em branco). */
export function StepProgress({ index, states, onReview }: { index: number; states: StepState[]; onReview: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const total = states.length;
  const color = (state: StepState, current: boolean) =>
    current ? c.primary : state === "answered" ? tint(c.primary, "66") : state === "missing" ? c.warning : c.segment;
  return (
    <View style={styles.progress}>
      <View style={styles.progressTop}>
        <Text style={styles.counter} accessibilityRole="header">
          Pergunta <Text style={styles.counterStrong}>{index + 1}</Text> de {total}
        </Text>
        <Pressable onPress={onReview} hitSlop={10} accessibilityRole="button" style={styles.reviewLink}>
          <Icon name="note" size={16} color={c.brandInk} />
          <Text style={styles.reviewLinkText}>Revisar</Text>
        </Pressable>
      </View>
      {total <= MAX_SEGMENTS ? (
        <View style={styles.segments} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {states.map((state, i) => (
            <View key={i} style={[styles.segment, { backgroundColor: color(state, i === index) }]} />
          ))}
        </View>
      ) : (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(((index + 1) / total) * 100)}%` }]} />
        </View>
      )}
    </View>
  );
}

/** Entrada curta (200 ms, 6 px), sem quique: a pergunta desliza de leve no sentido da navegação. */
const slideFrom = (dx: number) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateX: dx }] },
    100: { opacity: 1, transform: [{ translateX: 0 }], easing: Easing.out(Easing.cubic) },
  }).duration(200);
const FROM_RIGHT = slideFrom(6);
const FROM_LEFT = slideFrom(-6);

/** Entrada da pergunta: vem da direita ao avançar e da esquerda ao voltar. O pai troca a `key`. */
export function StepSlide({ direction, children }: { direction: StepDirection; children: ReactNode }) {
  const reduced = useReducedMotion();
  const entering = reduced || direction === "none" ? undefined : direction === "back" ? FROM_LEFT : FROM_RIGHT;
  return <Animated.View entering={entering}>{children}</Animated.View>;
}

export interface ReviewRow {
  answer: string | null;
  problem: string | null;
  required: boolean;
}

/**
 * Revisão antes de concluir: cada pergunta com a resposta; tocar abre a pergunta. Sem `onOpen`
 * (formulário travado), só leitura.
 */
export function ReviewList({
  steps,
  rows,
  onOpen,
}: {
  steps: FormStep[];
  rows: ReviewRow[];
  onOpen?: (index: number) => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  if (!steps.length) return <Text style={styles.emptyReview}>Este formulário não tem perguntas para responder.</Text>;
  const warning = toneInk(c, "warning");
  return (
    <View>
      {steps.map((step, i) => {
        const row = rows[i];
        const showSection = step.section && step.section !== steps[i - 1]?.section;
        const done = Boolean(row.answer) && !row.problem;
        const answer = row.problem && row.answer ? `${row.answer} · ${row.problem}` : (row.answer ?? row.problem ?? "Sem resposta");
        const content = (
          <>
            <View
              style={[
                styles.mark,
                done && { backgroundColor: c.successSoft, borderColor: c.success },
                row.problem && { backgroundColor: c.warningSoft, borderColor: c.warning },
              ]}
            >
              {done ? (
                <Icon name="check" size={13} color={toneInk(c, "success")} strokeWidth={2.8} />
              ) : row.problem ? (
                <Text style={[styles.markText, { color: warning }]}>!</Text>
              ) : (
                <Text style={styles.markText}>{i + 1}</Text>
              )}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.reviewLabel} numberOfLines={onOpen ? 2 : undefined}>
                {step.field.label}
                {row.required ? <Text style={{ color: c.danger }}> *</Text> : null}
              </Text>
              <Text
                style={[styles.reviewAnswer, !row.answer && styles.reviewEmpty, row.problem && { color: warning }]}
                numberOfLines={onOpen ? 2 : undefined}
                selectable={!onOpen}
              >
                {answer}
              </Text>
            </View>
            {onOpen ? <Icon name="chevronRight" size={18} color={c.inkMuted} /> : null}
          </>
        );
        return (
          <View key={step.field.id}>
            {showSection ? (
              <View style={[styles.reviewSection, i === 0 && { paddingTop: 0 }]}>
                <SectionLabel>{step.section ?? ""}</SectionLabel>
              </View>
            ) : null}
            {onOpen ? (
              <Pressable
                onPress={() => onOpen(i)}
                accessibilityRole="button"
                accessibilityLabel={`${step.field.label}: ${answer}`}
                accessibilityHint="Abre a pergunta para responder ou alterar"
                style={({ pressed }) => [styles.reviewRow, i > 0 && !showSection && styles.reviewDivider, pressed && styles.reviewPressed]}
              >
                {content}
              </Pressable>
            ) : (
              <View style={[styles.reviewRow, i > 0 && !showSection && styles.reviewDivider]}>{content}</View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    progress: { gap: 10 },
    progressTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    counter: { fontSize: 14, color: c.inkMuted },
    counterStrong: { fontWeight: "700", color: c.ink },
    reviewLink: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
    reviewLinkText: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    segments: { flexDirection: "row", gap: 3 },
    segment: { flex: 1, height: 5, borderRadius: 3 },
    track: { height: 5, borderRadius: 3, backgroundColor: c.segment, overflow: "hidden" },
    fill: { height: 5, borderRadius: 3, backgroundColor: c.primary },
    emptyReview: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    reviewSection: { paddingTop: 16, paddingBottom: 4 },
    reviewRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderRadius: 8 },
    reviewDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    reviewPressed: { backgroundColor: c.surface2 },
    mark: {
      width: 26,
      height: 26,
      borderRadius: 13,
      borderWidth: 1.5,
      borderColor: c.lineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    markText: { fontSize: 12, fontWeight: "700", color: c.inkMuted },
    reviewLabel: { fontSize: 15, fontWeight: "600", color: c.ink, lineHeight: 20 },
    reviewAnswer: { fontSize: 14, color: c.ink, lineHeight: 19 },
    reviewEmpty: { color: c.inkMuted },
  });
