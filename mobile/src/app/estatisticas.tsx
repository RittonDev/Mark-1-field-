// Estatísticas (Perfil › Estatísticas e o total do herói do Perfil): o total de atendimentos desde sempre, a chegada no
// horário dos últimos 12 meses (a mesma conta de Meu elo) e quatro gráficos de 12 meses: atendimentos, chegadas fora do
// horário, retornos e visitas perdidas. Só os números do próprio técnico: sem meta, sem comparação, sem cor de status.
// Mostra o guardado no aparelho (lib/stats.ts, com a hora em que chegou) e busca de novo ao abrir, se o guardado passou
// de 2 min, e ao puxar para atualizar. As regras são as do elo; dúvida é com a central, no grupo de WhatsApp.

import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HeroHalf, HeroPair } from "../components/HeroPair";
import { Icon } from "../components/Icon";
import { MonthBars } from "../components/MonthBars";
import { Skeleton } from "../components/Skeleton";
import { Text } from "../components/Text";
import { Button, Card, ErrorBox, SectionTitle } from "../components/ui";
import { competenceLabel, monthAbbr, monthTitle } from "../lib/constants";
import { levelMoment } from "../lib/level";
import { countText, formatCount, type Noun } from "../lib/monthBars";
import { refreshStatsNow, STATS_FRESH_MS, statsStoredAfter, useMyStats, type StoredStats } from "../lib/stats";
import type { StatsMonth } from "../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";

const OFFLINE_TEXT = "Sem internet: as estatísticas aparecem quando a conexão voltar.";

const SERVICES: Noun = { one: "atendimento", many: "atendimentos", none: "Nenhum atendimento" };
const LATE: Noun = {
  one: "chegada fora do horário",
  many: "chegadas fora do horário",
  none: "Nenhuma chegada fora do horário",
};
const REWORKS: Noun = { one: "retorno", many: "retornos", none: "Nenhum retorno" };
const LOST: Noun = { one: "visita perdida", many: "visitas perdidas", none: "Nenhuma visita perdida" };

interface Chart {
  title: string;
  subtitle: string;
  noun: Noun;
  value: (month: StatsMonth) => number;
  quality: boolean;
}

/** Sem números de regra nos textos ("30 min", "30 dias"): as regras vêm do servidor, em Meu elo. */
const CHARTS: Chart[] = [
  {
    title: "Atendimentos",
    subtitle: "Como responsável ou junto, pelo mês da conclusão",
    noun: SERVICES,
    value: (month) => month.services,
    quality: false,
  },
  {
    title: "Chegadas fora do horário",
    subtitle: "Pelo mês da chegada, só nas OS com horário combinado",
    noun: LATE,
    value: (month) => month.late,
    quality: true,
  },
  {
    title: "Retornos",
    subtitle: "OS concluída e reaberta, pelo mês da reabertura",
    noun: REWORKS,
    value: (month) => month.reworks,
    quality: true,
  },
  {
    title: "Visitas perdidas",
    subtitle: "Visita improdutiva por motivo do técnico, pelo mês da visita",
    noun: LOST,
    value: (month) => month.lost,
    quality: true,
  },
];

/** A última busca da tela falhou (`at`: quando; o guardado depois disso já não está velho). */
interface Failure {
  offline: boolean;
  message: string;
  at: number;
}

type RefreshMode = "open" | "pull" | "retry";

/** "mar/2019": o mês abreviado com o ano de 4 dígitos. */
const monthYear = (month: string) => {
  const year = /^(\d{4})-\d{2}$/.exec(month)?.[1];
  return year ? `${monthAbbr(month)}/${year}` : month;
};

export default function StatsScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const stored = useMyStats();
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const refresh = useCallback(async (mode: RefreshMode) => {
    if (mode === "pull") setRefreshing(true);
    if (mode === "retry") setRetrying(true);
    const result = await refreshStatsNow();
    setFailure(result.ok ? null : { offline: result.offline, message: result.message, at: Date.now() });
    setRefreshing(false);
    setRetrying(false);
  }, []);

  // Ao abrir e ao voltar para a tela: busca de novo se nada está guardado ou se o guardado passou de 2 min.
  const at = stored === undefined ? undefined : (stored?.at ?? null);
  useFocusEffect(
    useCallback(() => {
      if (at === undefined) return;
      if (at && Date.now() - new Date(at).getTime() < STATS_FRESH_MS) return;
      void refresh("open");
    }, [at, refresh]),
  );

  // A falha só vale para o que já estava guardado quando ela aconteceu.
  const failed = failure && (!stored || !statsStoredAfter(stored, failure.at)) ? failure : null;

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void refresh("pull")} colors={[c.primary]} tintColor={c.primary} />
      }
    >
      {stored ? (
        <StatsContent stored={stored} failed={failed} />
      ) : stored === null && failed ? (
        <View style={styles.errorState}>
          <ErrorBox message={failed.offline ? OFFLINE_TEXT : failed.message} />
          <Button title="Tentar de novo" icon="repeat" onPress={() => void refresh("retry")} loading={retrying} />
        </View>
      ) : (
        <StatsSkeleton />
      )}
    </ScrollView>
  );
}

function StatsContent({ stored, failed }: { stored: StoredStats; failed: Failure | null }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const { lifetime, metrics, months } = stored.data;
  const total = formatCount(lifetime.services);
  const since = lifetime.first_month;
  const pct = metrics.on_time_pct;
  const updated = failed
    ? `${failed.offline ? "Sem internet" : "Não deu para atualizar"} · dados de ${levelMoment(stored.at)}`
    : `Atualizado em ${levelMoment(stored.at)}`;
  const first = months[0]?.month;
  const last = months[months.length - 1]?.month;
  const anyLegacy = months.some((month) => month.legacy_only);

  return (
    <>
      <HeroPair
        left={
          <HeroHalf
            side="left"
            accessibilityLabel={`Total de atendimentos: ${total}${since ? `, desde ${competenceLabel(since)}` : ""}`}
          >
            <Text style={styles.heroNumber} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1.3}>
              {total}
            </Text>
            <Text style={styles.heroCaption}>Total de atendimentos</Text>
            {since ? <Text style={styles.heroNote}>desde {monthYear(since)}</Text> : null}
          </HeroHalf>
        }
        right={
          <HeroHalf
            side="right"
            accessibilityLabel={
              pct === null
                ? "Chegada no horário: ainda sem dados suficientes"
                : `Chegada no horário: ${pct}% nos últimos 12 meses`
            }
          >
            <Text style={styles.heroNumber} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1.3}>
              {pct === null ? "—" : `${pct}%`}
            </Text>
            <Text style={styles.heroCaption}>Chegada no horário</Text>
            <Text style={styles.heroNote}>{pct === null ? "Ainda sem dados suficientes" : "nos últimos 12 meses"}</Text>
          </HeroHalf>
        }
      />
      <Text style={failed ? styles.stale : styles.updated} accessibilityLiveRegion="polite">
        {updated}
      </Text>

      <View style={styles.charts}>
        <SectionTitle right={first && last ? <Text style={styles.range}>{`${monthAbbr(first, true)} a ${monthAbbr(last, true)}`}</Text> : null}>
          Últimos 12 meses
        </SectionTitle>
        {anyLegacy ? (
          <View style={styles.legend}>
            <View style={styles.legendSwatch} />
            <Text style={styles.legendText}>
              Meses do sistema antigo: contam os atendimentos, sem medir chegada, retorno nem visita perdida.
            </Text>
          </View>
        ) : null}
        {CHARTS.map((chart) => (
          <MonthBars
            key={chart.title}
            title={chart.title}
            subtitle={chart.subtitle}
            noun={chart.noun}
            months={months}
            value={chart.value}
            quality={chart.quality}
          />
        ))}
      </View>

      <MonthList months={months} />

      <View style={styles.footer}>
        <Text style={styles.footerText}>Os números seguem as regras do elo.</Text>
        <Pressable
          onPress={() => router.push("/elo")}
          hitSlop={14}
          accessibilityRole="link"
          style={({ pressed }) => [styles.link, pressed && { opacity: 0.6 }]}
        >
          <Text style={[styles.footerText, { color: c.brandInk }]}>Como funciona o elo</Text>
        </Pressable>
        <Text style={styles.footerText}>Dúvida? Fale com a central no grupo.</Text>
      </View>
    </>
  );
}

/** "Ver mês a mês": os 12 meses em texto, do atual para o mais antigo (o equivalente completo dos gráficos). */
function MonthList({ months }: { months: StatsMonth[] }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const rows = [...months].reverse();
  return (
    <Card style={styles.listCard}>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.listHead, pressed && { backgroundColor: c.surface2 }]}
      >
        <Text style={styles.listTitle}>Ver mês a mês</Text>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={18} color={c.inkMuted} />
      </Pressable>
      {open
        ? rows.map((month) => {
            const head = `${monthTitle(month.month)}${month.current ? " · até hoje" : ""}`;
            const services =
              month.services > 0
                ? `${countText(month.services, SERVICES)} · ${month.as_assignee} como responsável, ${month.as_helper} junto`
                : SERVICES.none;
            const quality = month.legacy_only
              ? "Sistema antigo: sem medição de chegada, retorno e visita perdida"
              : `Chegadas fora do horário: ${month.late} · Retornos: ${month.reworks} · Visitas perdidas: ${month.lost}`;
            return (
              <View key={month.month} style={styles.monthRow} accessible accessibilityLabel={`${head}. ${services}. ${quality}`}>
                <Text style={styles.monthHead}>{head}</Text>
                <Text style={styles.monthLine}>{services}</Text>
                <Text style={styles.monthLine}>{quality}</Text>
              </View>
            );
          })
        : null}
    </Card>
  );
}

/** Nada guardado, enquanto a primeira busca não volta. */
function StatsSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.skeleton} accessible accessibilityLabel="Carregando as estatísticas" accessibilityRole="progressbar">
      <HeroPair
        left={
          <HeroHalf side="left" accessibilityLabel="Total de atendimentos">
            <Skeleton width={72} height={32} radius={8} />
            <Skeleton width={100} height={12} />
          </HeroHalf>
        }
        right={
          <HeroHalf side="right" accessibilityLabel="Chegada no horário">
            <Skeleton width={72} height={32} radius={8} />
            <Skeleton width={100} height={12} />
          </HeroHalf>
        }
      />
      {[0, 1].map((key) => (
        <Card key={key} style={styles.skeletonCard}>
          <Skeleton width={120} height={14} />
          <Skeleton height={148} radius={10} />
        </Card>
      ))}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 16, gap: 14 },
    errorState: { gap: 10 },
    skeleton: { gap: 14 },
    skeletonCard: { gap: 12 },
    heroNumber: { fontSize: 32, fontWeight: "700", color: c.ink, letterSpacing: -0.5, textAlign: "center" },
    heroCaption: { fontSize: 13, fontWeight: "600", color: c.inkMuted, textAlign: "center" },
    heroNote: { fontSize: 12, color: c.inkMuted, textAlign: "center" },
    updated: { fontSize: 12, color: c.inkMuted, textAlign: "center", marginTop: -4 },
    stale: { fontSize: 12, fontWeight: "600", color: c.inkMuted, textAlign: "center", marginTop: -4 },
    charts: { gap: 12 },
    range: { fontSize: 12, fontWeight: "600", color: c.inkMuted, fontVariant: ["tabular-nums"] },
    legend: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: -4 },
    legendSwatch: {
      width: 14,
      height: 10,
      borderRadius: 3,
      backgroundColor: c.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.lineStrong,
      marginTop: 4,
    },
    legendText: { flex: 1, fontSize: 13, lineHeight: 18, color: c.inkMuted },
    listCard: { padding: 0, overflow: "hidden" },
    listHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      minHeight: 44,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    listTitle: { fontSize: 14, fontWeight: "700", color: c.ink },
    monthRow: {
      gap: 3,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    monthHead: { fontSize: 14, fontWeight: "700", color: c.ink },
    monthLine: { fontSize: 13, lineHeight: 18, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    footer: { alignItems: "center", gap: 6, paddingTop: 4 },
    footerText: { fontSize: 13, fontWeight: "600", color: c.inkMuted, textAlign: "center" },
    link: { borderRadius: RADIUS.control },
  });
