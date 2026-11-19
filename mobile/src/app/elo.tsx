// Meu elo (lib/level.ts): o brasão do técnico, o que falta para a próxima faixa, os números dos últimos 12 meses, o que
// pesou e "Como funciona". Mostra o elo guardado no aparelho (offline, com a hora em que chegou) e busca de novo ao
// abrir, se o guardado não é recente, e ao puxar para atualizar. Textos e regras vêm prontos do servidor; dúvida sobre
// o elo é com a central, no grupo de WhatsApp.

import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle } from "react-native-svg";
import { Icon, SVG_HIDDEN } from "../components/Icon";
import { LevelShield } from "../components/LevelBadge";
import { useListMotion } from "../components/motion";
import { Skeleton } from "../components/Skeleton";
import { Text } from "../components/Text";
import { Button, Card, ErrorBox, SectionTitle } from "../components/ui";
import { LEVEL_OCCURRENCE, LEVEL_TIER } from "../lib/constants";
import { getTicket } from "../lib/db";
import { isLevelTier, levelDate, levelMoment, notEnoughText, storedAfter, useMyLevel, type StoredLevel } from "../lib/level";
import { refreshLevelNow } from "../lib/sync";
import { showToast } from "../lib/toast";
import type { LevelCriterion, LevelOccurrence, LevelTier, MyLevel } from "../lib/types";
import { RADIUS, tint, useStyles, useTheme, type Palette } from "../theme/theme";

/** O guardado mais novo que isto não é buscado de novo ao abrir a tela (voltar de uma OS não refaz a busca). */
const FRESH_MS = 2 * 60_000;
const OFFLINE_TEXT = "Sem internet: o elo aparece quando a conexão voltar.";
/** As contagens têm barra de progresso; as taxas já trazem a porcentagem no texto. */
const PROGRESS_KEYS = new Set<string>(["services", "measured"]);

/** A última busca da tela falhou (`at`: quando; um elo guardado depois disso já não está velho). */
interface Failure {
  offline: boolean;
  message: string;
  at: number;
}

type RefreshMode = "open" | "pull" | "retry";

interface CriteriaBlock {
  key: string;
  title: string;
  tier: LevelTier;
  criteria: LevelCriterion[];
}

/**
 * O que olhar agora: a próxima faixa ("Para chegar ao Ouro") e, antes dela, o que a faixa em vigor pede ("Para
 * continuar no Ouro") quando o elo está em risco ou já é o Diamante.
 */
function criteriaBlocks(data: MyLevel): CriteriaBlock[] {
  const blocks: CriteriaBlock[] = [];
  if ((data.at_risk || !data.next) && data.criteria.length) {
    blocks.push({ key: "current", title: `Para continuar ${LEVEL_TIER[data.tier].at}`, tier: data.tier, criteria: data.criteria });
  }
  if (data.next && isLevelTier(data.next.tier) && data.next.criteria.length) {
    const next = data.next.tier;
    blocks.push({ key: "next", title: `Para chegar ${LEVEL_TIER[next].to}`, tier: next, criteria: data.next.criteria });
  }
  return blocks;
}

const reworkText = (n: number) =>
  n === 0 ? "Nenhuma OS reaberta em até 30 dias" : n === 1 ? "1 OS reaberta em até 30 dias" : `${n} OS reabertas em até 30 dias`;

const lostText = (n: number) => (n === 0 ? "Nenhuma por motivo do técnico" : `${n} por motivo do técnico`);

/** Abre a OS se ela ainda está no aparelho (as encerradas saem depois de 30 dias). */
async function openTicket(id: string) {
  if (await getTicket(id)) router.push({ pathname: "/ticket/[id]", params: { id } });
  else showToast("Esta OS não está mais no aparelho", { description: "O histórico completo fica com a central." });
}

export default function MyLevelScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const stored = useMyLevel();
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const refresh = useCallback(async (mode: RefreshMode) => {
    if (mode === "pull") setRefreshing(true);
    if (mode === "retry") setRetrying(true);
    const result = await refreshLevelNow();
    setFailure(result.ok ? null : { offline: result.offline, message: result.message, at: Date.now() });
    setRefreshing(false);
    setRetrying(false);
  }, []);

  // Ao abrir e ao voltar para a tela: busca de novo se não há elo guardado ou se ele não é recente.
  const at = stored === undefined ? undefined : (stored?.at ?? null);
  useFocusEffect(
    useCallback(() => {
      if (at === undefined) return;
      if (at && Date.now() - new Date(at).getTime() < FRESH_MS) return;
      void refresh("open");
    }, [at, refresh]),
  );

  // A falha só vale para o elo que já estava guardado quando ela aconteceu.
  const failed = failure && (!stored || !storedAfter(stored, failure.at)) ? failure : null;

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void refresh("pull")} colors={[c.primary]} tintColor={c.primary} />
      }
    >
      {stored ? (
        <LevelContent stored={stored} failed={failed} />
      ) : stored === null && failed ? (
        <View style={styles.errorState}>
          <ErrorBox message={failed.offline ? OFFLINE_TEXT : failed.message} />
          <Button title="Tentar de novo" icon="repeat" onPress={() => void refresh("retry")} loading={retrying} />
        </View>
      ) : (
        <LevelSkeleton />
      )}
    </ScrollView>
  );
}

function LevelContent({ stored, failed }: { stored: StoredLevel; failed: Failure | null }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const motion = useListMotion();
  const { data } = stored;
  const label = LEVEL_TIER[data.tier].label;
  const blocks = criteriaBlocks(data);
  const updated = failed
    ? `${failed.offline ? "Sem internet" : "Não deu para atualizar"} · dados de ${levelMoment(stored.at)}`
    : `Atualizado em ${levelMoment(stored.at)}`;

  return (
    <>
      <Animated.View entering={motion.entering(0)}>
        <Card style={styles.hero}>
          <LevelShield tier={data.tier} size={72} />
          <Text style={styles.heroTitle} accessibilityRole="header">
            Elo {label}
          </Text>
          <Text style={styles.heroMeta}>Desde {levelDate(data.since)}</Text>
          <Text style={failed ? styles.heroStale : styles.heroUpdated}>{updated}</Text>
          {data.at_risk ? (
            <View style={styles.risk} accessible accessibilityLabel={`Elo ${label} em risco. ${data.at_risk.text}`}>
              <View style={styles.riskHead}>
                <Icon name="alert" size={18} color={c.warningInk} />
                <Text style={styles.riskTitle}>Elo {label} em risco</Text>
              </View>
              <Text style={styles.riskText}>{data.at_risk.text}</Text>
            </View>
          ) : null}
        </Card>
      </Animated.View>

      {blocks.map((block, index) => (
        <Animated.View key={block.key} entering={motion.entering(index + 1)}>
          <CriteriaCard block={block} />
        </Animated.View>
      ))}

      <Animated.View entering={motion.entering(blocks.length + 1)}>
        <NumbersCard data={data} />
      </Animated.View>

      {data.occurrences.length ? <OccurrencesCard data={data} /> : null}

      <HowItWorksCard data={data} />
    </>
  );
}

function CriteriaCard({ block }: { block: CriteriaBlock }) {
  return (
    <Card>
      <SectionTitle accent>{block.title}</SectionTitle>
      {block.criteria.map((criterion, index) => (
        <CriterionRow key={criterion.key} criterion={criterion} tier={block.tier} first={index === 0} />
      ))}
    </Card>
  );
}

function CriterionRow({ criterion, tier, first }: { criterion: LevelCriterion; tier: LevelTier; first: boolean }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const progress =
    PROGRESS_KEYS.has(criterion.key) && criterion.target > 0 ? Math.min(1, Math.max(0, criterion.value / criterion.target)) : null;
  const spoken = [criterion.label, criterion.met ? "cumprido" : "ainda não cumprido", criterion.text, criterion.missing];
  return (
    <View style={[styles.criterion, !first && styles.rowBorder]} accessible accessibilityLabel={spoken.filter(Boolean).join(". ")}>
      {criterion.met ? (
        <Icon name="checkCircle" size={22} color={c.success} />
      ) : (
        <Svg width={22} height={22} viewBox="0 0 24 24" {...SVG_HIDDEN}>
          <Circle cx={12} cy={12} r={8.5} fill="none" stroke={c.inkSubtle} strokeWidth={1.8} />
        </Svg>
      )}
      <View style={styles.criterionBody}>
        <Text style={styles.criterionLabel}>{criterion.label}</Text>
        <Text style={styles.criterionText}>{criterion.text}</Text>
        {progress !== null ? (
          <View style={styles.track}>
            <View
              style={[styles.fill, { width: `${Math.round(progress * 100)}%` as const, backgroundColor: LEVEL_TIER[tier].color[c.scheme] }]}
            />
          </View>
        ) : null}
        {criterion.missing ? <Text style={styles.missing}>{criterion.missing}</Text> : null}
      </View>
    </View>
  );
}

interface NumberLine {
  label: string;
  value: string;
  detail: string | null;
}

/** Uma taxa: a porcentagem com os casos, ou "—" com o "Ainda sem dados suficientes" do servidor. */
function rateLine(label: string, pct: number | null, detail: string, notEnough: string | null): NumberLine {
  return pct === null
    ? { label, value: "—", detail: notEnough ?? "Ainda sem dados suficientes" }
    : { label, value: `${pct}%`, detail };
}

function NumbersCard({ data }: { data: MyLevel }) {
  const styles = useStyles(makeStyles);
  const m = data.metrics;
  const lines: NumberLine[] = [
    { label: "Atendimentos", value: String(m.services), detail: `${m.as_assignee} como responsável · ${m.as_helper} junto` },
    { label: "Atendimentos medidos", value: String(m.measured), detail: null },
    rateLine("Chegada no horário combinado", m.on_time_pct, `${m.on_time} de ${m.arrivals} chegadas`, notEnoughText(data, "on_time")),
    rateLine("Retorno", m.rework_pct, reworkText(m.reworks), notEnoughText(data, "rework")),
    rateLine("Visitas perdidas", m.lost_pct, lostText(m.lost), notEnoughText(data, "lost")),
  ];
  return (
    <Card>
      <SectionTitle accent right={<Text style={styles.sectionHint}>Últimos 12 meses</Text>}>
        Seus números
      </SectionTitle>
      {lines.map((line, index) => (
        <View
          key={line.label}
          style={[styles.number, index > 0 && styles.rowBorder]}
          accessible
          accessibilityLabel={line.value === "—" ? `${line.label}: ${line.detail}` : `${line.label}: ${line.value}${line.detail ? `. ${line.detail}` : ""}`}
        >
          <View style={styles.numberBody}>
            <Text style={styles.numberLabel}>{line.label}</Text>
            {line.detail ? <Text style={styles.numberDetail}>{line.detail}</Text> : null}
          </View>
          <Text style={styles.numberValue}>{line.value}</Text>
        </View>
      ))}
    </Card>
  );
}

function OccurrencesCard({ data }: { data: MyLevel }) {
  const styles = useStyles(makeStyles);
  const shown = data.occurrences.length;
  return (
    <Card>
      <SectionTitle accent>O que pesou</SectionTitle>
      {data.occurrences.map((occurrence, index) => (
        <OccurrenceRow key={`${occurrence.kind}:${occurrence.ref_id}`} occurrence={occurrence} first={index === 0} />
      ))}
      {data.occurrences_total > shown ? (
        <Text style={styles.more}>
          Mostrando as {shown} mais recentes de {data.occurrences_total}
        </Text>
      ) : null}
    </Card>
  );
}

function OccurrenceRow({ occurrence, first }: { occurrence: LevelOccurrence; first: boolean }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const kind = LEVEL_OCCURRENCE[occurrence.kind] ?? "Ocorrência";
  const when = levelDate(occurrence.at);
  return (
    <Pressable
      onPress={() => void openTicket(occurrence.ticket.id)}
      accessibilityRole="button"
      accessibilityLabel={`${kind}, ${occurrence.ticket.code}, ${occurrence.ticket.title}. ${occurrence.detail}. ${when}`}
      accessibilityHint="Abre a OS"
      style={({ pressed }) => [styles.occurrence, !first && styles.occurrenceBorder, pressed && { backgroundColor: c.surface2 }]}
    >
      <View style={styles.occurrenceBody}>
        <View style={styles.occurrenceHead}>
          <Text style={styles.occurrenceKind}>
            {kind} · {occurrence.ticket.code}
          </Text>
          <Text style={styles.occurrenceDate}>{when}</Text>
        </View>
        <Text style={styles.occurrenceTitle} numberOfLines={1}>
          {occurrence.ticket.title}
        </Text>
        <Text style={styles.occurrenceDetail}>{occurrence.detail}</Text>
      </View>
      <Icon name="chevronRight" size={18} color={c.inkSubtle} />
    </Pressable>
  );
}

function HowItWorksCard({ data }: { data: MyLevel }) {
  const styles = useStyles(makeStyles);
  return (
    <Card>
      <SectionTitle accent>Como funciona</SectionTitle>
      <View style={styles.tiers}>
        {data.tiers
          .filter((rule) => isLevelTier(rule.tier))
          .map((rule) => {
            const mine = rule.tier === data.tier;
            const name = LEVEL_TIER[rule.tier].label;
            return (
              <View key={rule.tier} style={styles.tier} accessible accessibilityLabel={`${name}${mine ? ", o seu elo" : ""}. ${rule.summary}`}>
                <LevelShield tier={rule.tier} size={22} />
                <View style={styles.tierBody}>
                  <Text style={styles.tierName}>
                    {name}
                    {mine ? <Text style={styles.tierMine}> · seu elo</Text> : null}
                  </Text>
                  <Text style={styles.tierSummary}>{rule.summary}</Text>
                </View>
              </View>
            );
          })}
      </View>
      <View style={styles.rules}>
        {data.rules.map((rule) => (
          <View key={rule} style={styles.rule}>
            <View style={styles.bullet} />
            <Text style={styles.ruleText}>{rule}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.help}>Dúvida sobre o seu elo? Fale com a central no grupo.</Text>
    </Card>
  );
}

/** Sem elo guardado, enquanto a primeira busca não volta. */
function LevelSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.skeleton} accessibilityLabel="Carregando o seu elo" accessibilityRole="progressbar">
      <Card style={styles.hero}>
        <Skeleton width={72} height={72} radius={20} />
        <Skeleton width={150} height={22} style={{ marginTop: 6 }} />
        <Skeleton width={120} height={12} />
      </Card>
      <Card style={styles.skeletonCard}>
        <Skeleton width={170} height={14} />
        <Skeleton height={44} radius={RADIUS.control} />
        <Skeleton height={44} radius={RADIUS.control} />
        <Skeleton height={44} radius={RADIUS.control} />
      </Card>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 16, gap: 14 },
    errorState: { gap: 10 },
    skeleton: { gap: 14 },
    skeletonCard: { gap: 12 },
    hero: { alignItems: "center", gap: 6, paddingVertical: 20 },
    heroTitle: { fontSize: 24, fontWeight: "700", color: c.ink, letterSpacing: -0.3, marginTop: 6, textAlign: "center" },
    heroMeta: { fontSize: 13, color: c.inkMuted, textAlign: "center" },
    heroUpdated: { fontSize: 12, color: c.inkMuted, textAlign: "center" },
    heroStale: { fontSize: 12, fontWeight: "600", color: c.inkMuted, textAlign: "center" },
    risk: {
      alignSelf: "stretch",
      marginTop: 10,
      gap: 6,
      padding: 12,
      borderRadius: RADIUS.control,
      backgroundColor: c.warningSoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tint(c.warning, "40"),
    },
    riskHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    riskTitle: { flex: 1, fontSize: 14, fontWeight: "700", color: c.warningInk },
    riskText: { fontSize: 13, lineHeight: 18, color: c.ink },
    rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    criterion: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10 },
    criterionBody: { flex: 1, gap: 3 },
    criterionLabel: { fontSize: 14, fontWeight: "700", color: c.ink },
    criterionText: { fontSize: 13, lineHeight: 18, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    missing: { fontSize: 13, lineHeight: 18, fontWeight: "600", color: c.ink },
    track: { height: 6, borderRadius: 3, backgroundColor: c.surface3, overflow: "hidden", marginTop: 4, marginBottom: 2 },
    fill: { height: 6, borderRadius: 3 },
    sectionHint: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    number: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
    numberBody: { flex: 1, gap: 2 },
    numberLabel: { fontSize: 14, fontWeight: "600", color: c.ink },
    numberDetail: { fontSize: 12, lineHeight: 17, color: c.inkMuted },
    numberValue: { fontSize: 17, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    occurrence: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 4,
      marginHorizontal: -4,
      borderRadius: RADIUS.control,
    },
    occurrenceBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line, borderRadius: 0 },
    occurrenceBody: { flex: 1, gap: 2 },
    occurrenceHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", columnGap: 8 },
    occurrenceKind: { flexShrink: 1, fontSize: 14, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    occurrenceDate: { fontSize: 12, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    occurrenceTitle: { fontSize: 13, color: c.inkMuted },
    occurrenceDetail: { fontSize: 13, lineHeight: 18, color: c.ink },
    more: {
      fontSize: 12,
      color: c.inkMuted,
      paddingTop: 10,
      marginTop: 2,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    tiers: { gap: 12 },
    tier: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    tierBody: { flex: 1, gap: 2 },
    tierName: { fontSize: 14, fontWeight: "700", color: c.ink },
    tierMine: { fontWeight: "500", color: c.inkMuted },
    tierSummary: { fontSize: 13, lineHeight: 18, color: c.inkMuted },
    rules: { gap: 8, marginTop: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    rule: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    bullet: { width: 5, height: 5, borderRadius: 3, backgroundColor: c.inkSubtle, marginTop: 7 },
    ruleText: { flex: 1, fontSize: 13, lineHeight: 18, color: c.ink },
    help: { fontSize: 13, fontWeight: "600", color: c.inkMuted, marginTop: 14 },
  });
