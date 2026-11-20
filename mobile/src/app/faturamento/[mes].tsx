// Um mês do Faturamento (abre pelo cartão do mês na aba): no topo, a situação calculada pela central (o que aconteceu e
// o que o técnico pode fazer); depois as OS com os valores, os reembolsos e as notas fiscais (MonthEarnings). O título
// é o mês por extenso e o olho que oculta os valores fica no cabeçalho.

import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HideValuesButton } from "../../components/billing/HideValuesButton";
import { MonthEarnings } from "../../components/billing/MonthEarnings";
import { SituationBox } from "../../components/billing/SituationBox";
import { ConnectionBar } from "../../components/ConnectionBar";
import { Button, EmptyState } from "../../components/ui";
import { monthTitle } from "../../lib/constants";
import { EARNINGS_FRESH_MS, refreshAfterInvoices, refreshEarningsMonths, SYNC_REFRESH_MS, useEarningsMonths } from "../../lib/earnings";
import { useInvoicesVersion } from "../../lib/invoices";
import { useSyncStatus } from "../../lib/sync";
import { useStyles, useTheme, type Palette } from "../../theme/theme";

/** "AAAA-MM". */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** O "puxar para atualizar" não gira para sempre (o mesmo teto da aba). */
const REFRESH_TIMEOUT_MS = 25_000;

const headerRight = () => <HideValuesButton />;

function leave() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

export default function EarningsMonthRoute() {
  const params = useLocalSearchParams<{ mes: string }>();
  const month = typeof params.mes === "string" ? params.mes : "";
  if (!MONTH.test(month)) return <InvalidMonth />;
  return <EarningsMonthScreen key={month} month={month} />;
}

function InvalidMonth() {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.screen, styles.invalid]}>
      <EmptyState icon="alert" title="Mês inválido" />
      <Button title="Voltar" onPress={leave} />
    </View>
  );
}

function EarningsMonthScreen({ month }: { month: string }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { stored } = useEarningsMonths();
  const { lastSyncAt } = useSyncStatus();
  const invoicesVersion = useInvoicesVersion();
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const monthSettled = useRef<(() => void) | null>(null);
  const handledInvoices = useRef(invoicesVersion);

  // Ao abrir e ao voltar para a tela (do envio da nota, por exemplo): a busca de até 30 s atrás ainda vale.
  useFocusEffect(
    useCallback(() => {
      void refreshEarningsMonths({ maxAgeMs: EARNINGS_FRESH_MS });
    }, []),
  );

  // Nota fiscal enviada ou apagada neste aparelho: a situação do mês muda (uma busca por nota, com a aba).
  useEffect(() => {
    if (invoicesVersion === handledInvoices.current) return;
    handledInvoices.current = invoicesVersion;
    void refreshAfterInvoices(invoicesVersion);
  }, [invoicesVersion]);

  // A central marcou como pago e o app sincronizou: confere de novo (no máximo a cada 2 min).
  useEffect(() => {
    if (lastSyncAt) void refreshEarningsMonths({ maxAgeMs: SYNC_REFRESH_MS });
  }, [lastSyncAt]);

  const settleMonth = useCallback(() => {
    monthSettled.current?.();
    monthSettled.current = null;
  }, []);

  async function refresh() {
    setRefreshing(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // O indicador espera a situação dos meses e as OS do mês (com um teto).
      const monthDone = new Promise<void>((resolve) => {
        monthSettled.current = resolve;
      });
      setRefreshKey((k) => k + 1);
      await Promise.race([
        Promise.allSettled([refreshEarningsMonths({ force: true }), monthDone]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, REFRESH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      settleMonth();
      setRefreshing(false);
    }
  }

  // A situação vem dos meses guardados da aba; mês fora da janela ou sem valores não tem.
  const situation = stored?.data.months.find((m) => m.month === month && m.state !== "empty") ?? null;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: monthTitle(month), headerRight }} />
      <ConnectionBar />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} colors={[c.primary]} tintColor={c.primary} />}
      >
        {situation ? <SituationBox month={situation} /> : null}
        <MonthEarnings month={month} refreshKey={refreshKey} onSettled={settleMonth} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 12 },
    invalid: { justifyContent: "center", paddingHorizontal: 16, gap: 8 },
  });
