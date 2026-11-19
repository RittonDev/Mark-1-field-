// Aba Faturamento (substitui Ganhos): o técnico é parceiro e recebe por OS. No topo, o total pago e o que falta receber
// (com o previsto das OS em andamento), a chave PIX em que recebe e um cartão por mês de conclusão com a situação
// calculada no servidor (Em andamento, Sem nota, Nota em conferência, Nota recusada, A pagar, Pago em parte, Pago sem
// nota, Pago). A nota nunca trava o pagamento: "Sem nota" é só informativo. Tocar num mês abre as OS, os reembolsos e
// as notas dele (/faturamento/AAAA-MM). Sem internet, mostra os valores guardados com a hora em que chegaram.

import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useEffectEvent, useRef } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { EARNINGS_HISTORY_SINCE } from "../../lib/constants";
import {
  EARNINGS_FRESH_MS,
  EARNINGS_OFFLINE_TEXT,
  earningsStaleText,
  refreshAfterInvoices,
  refreshEarningsMonths,
  SYNC_REFRESH_MS,
  useEarningsMonths,
} from "../../lib/earnings";
import { useInvoicesVersion } from "../../lib/invoices";
import { loadProfile } from "../../lib/profile";
import { useSyncStatus } from "../../lib/sync";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { useListMotion } from "../motion";
import { Skeleton } from "../Skeleton";
import { Text } from "../Text";
import { Button, Card, EmptyState, ErrorBox, SectionTitle } from "../ui";
import { BillingMonthCard } from "./BillingMonthCard";
import { BillingTotals } from "./BillingTotals";
import { PixRow } from "./PixRow";

/** Dois toques rápidos não abrem o mês duas vezes. */
const DOUBLE_TAP_MS = 600;
/** "2026-11-13" → "13/11/2026". */
const HISTORY_SINCE_TEXT = EARNINGS_HISTORY_SINCE.split("-").reverse().join("/");
/** Antes deste mês os valores por OS não existiam (o Field Control não trazia): a janela mostra o aviso. */
const HISTORY_SINCE_MONTH = EARNINGS_HISTORY_SINCE.slice(0, 7);

/**
 * `refreshKey` muda a cada "puxar para atualizar" na aba (busca os meses e relê o cadastro, da chave PIX); `onSettled`
 * avisa quando essa atualização terminou.
 */
export function BillingView({ refreshKey = 0, onSettled }: { refreshKey?: number; onSettled?: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const motion = useListMotion();
  const { stored, error, refreshing } = useEarningsMonths();
  const { lastSyncAt } = useSyncStatus();
  const invoicesVersion = useInvoicesVersion();
  const handledRefresh = useRef(refreshKey);
  const handledInvoices = useRef(invoicesVersion);
  const lastOpen = useRef(0);

  const notifySettled = useEffectEvent(() => onSettled?.());

  // Ao abrir a aba e ao voltar a ela (do mês, por exemplo): a busca de até 30 s atrás ainda vale.
  useFocusEffect(
    useCallback(() => {
      void refreshEarningsMonths({ maxAgeMs: EARNINGS_FRESH_MS });
    }, []),
  );

  // "Puxar para atualizar": os meses e o cadastro (a chave PIX pode ter mudado), juntos.
  useEffect(() => {
    if (refreshKey === handledRefresh.current) return;
    handledRefresh.current = refreshKey;
    let alive = true;
    void Promise.allSettled([refreshEarningsMonths({ force: true }), loadProfile()]).then(() => {
      if (alive) notifySettled();
    });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  // Nota fiscal enviada ou apagada neste aparelho: a situação dos meses muda.
  useEffect(() => {
    if (invoicesVersion === handledInvoices.current) return;
    handledInvoices.current = invoicesVersion;
    void refreshAfterInvoices(invoicesVersion);
  }, [invoicesVersion]);

  // A central marcou como pago e o app sincronizou: confere de novo (no máximo a cada 2 min).
  useEffect(() => {
    if (lastSyncAt) void refreshEarningsMonths({ maxAgeMs: SYNC_REFRESH_MS });
  }, [lastSyncAt]);

  function openMonth(month: string) {
    const now = Date.now();
    if (now - lastOpen.current < DOUBLE_TAP_MS) return;
    lastOpen.current = now;
    router.push({ pathname: "/faturamento/[mes]", params: { mes: month } });
  }

  // Nada guardado: o esqueleto enquanto lê o aparelho e na primeira busca; sem rede ou com erro, o aviso.
  if (!stored) {
    return (
      <View style={styles.wrap}>
        {stored === null && error === EARNINGS_OFFLINE_TEXT ? (
          <EmptyState icon="wifiOff" title="Sem internet" description="O faturamento aparece quando a conexão voltar." />
        ) : stored === null && error ? (
          <View style={styles.failure}>
            <ErrorBox message={error} />
            <Button
              title="Tentar de novo"
              icon="repeat"
              loading={refreshing}
              onPress={() => void refreshEarningsMonths({ force: true })}
            />
          </View>
        ) : (
          <BillingSkeleton />
        )}
      </View>
    );
  }

  const { totals, months, since } = stored.data;
  const shown = months.filter((month) => month.state !== "empty");
  const stale = error ? earningsStaleText(error, stored.at) : null;

  return (
    <View style={styles.wrap}>
      <BillingTotals totals={totals} stale={stale} />
      <PixRow />
      {shown.length ? (
        <View style={styles.months}>
          <SectionTitle
            right={refreshing ? <ActivityIndicator size="small" color={c.inkMuted} accessibilityLabel="Atualizando" /> : undefined}
          >
            Por mês
          </SectionTitle>
          {shown.map((month, index) => (
            <Animated.View key={month.month} entering={motion.entering(index)}>
              <BillingMonthCard month={month} onPress={openMonth} />
            </Animated.View>
          ))}
        </View>
      ) : (
        <EmptyState
          icon="receipt"
          title="Nenhum valor ainda"
          description="O valor de cada OS aparece aqui quando a central coloca você nela."
        />
      )}
      {since && since < HISTORY_SINCE_MONTH ? (
        <Text style={styles.footnote}>{`Valores registrados no app desde ${HISTORY_SINCE_TEXT}.`}</Text>
      ) : null}
    </View>
  );
}

/** Lendo o aparelho ou na primeira busca sem nada guardado: o desenho da aba sem os valores. */
function BillingSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.skeleton} accessibilityLabel="Carregando o faturamento" accessibilityRole="progressbar">
      <View style={styles.skeletonTotals}>
        <Card style={styles.skeletonCard}>
          <Skeleton width={120} height={28} />
        </Card>
        <Card style={styles.skeletonCard}>
          <Skeleton width={120} height={28} />
        </Card>
      </View>
      <Skeleton height={112} radius={RADIUS.card} />
      <Skeleton height={112} radius={RADIUS.card} />
      <Skeleton height={112} radius={RADIUS.card} />
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 12 },
    months: { gap: 10 },
    failure: { gap: 10 },
    footnote: { fontSize: 12, color: c.inkMuted, textAlign: "center", lineHeight: 17 },
    skeleton: { gap: 12 },
    skeletonTotals: { flexDirection: "row", gap: 8 },
    skeletonCard: { flex: 1, minWidth: 0 },
  });
