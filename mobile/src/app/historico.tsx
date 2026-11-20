// Histórico de atendimentos (Perfil › Histórico de atendimentos): as OS concluídas em que o técnico atuou, como
// responsável ou junto, em seções pelo mês da conclusão (com o total do mês), das mais recentes para as mais antigas e
// com rolagem infinita (lib/history.ts, páginas de 30). O número do topo é o mesmo "Total de atendimentos" do Perfil.
// A primeira página fica no aparelho: sem internet, a tela mostra a guardada com a hora em que chegou. Tocar abre a OS
// (openTicketAnywhere): na hora, se ela está no aparelho; senão, com internet, a tela da OS busca na central.

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { Text } from "../components/Text";
import { Badge, Button, EmptyState, ErrorBox, InfoBox } from "../components/ui";
import { monthTitle } from "../lib/constants";
import { formatDate } from "../lib/format";
import {
  fetchHistoryPage,
  HISTORY_FRESH_MS,
  historyFailure,
  loadHistoryFirstPage,
  refreshHistoryFirstPage,
  type StoredHistory,
} from "../lib/history";
import { historySections, mergeCounts, mergeItems } from "../lib/historySections";
import { levelDate, levelMoment } from "../lib/level";
import { countText, type Noun } from "../lib/monthBars";
import { openTicketAnywhere } from "../lib/navigation";
import { isOnline, useSyncStatus } from "../lib/sync";
import type { HistoryItem, HistoryMonthCount } from "../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";

const SERVICES: Noun = { one: "atendimento", many: "atendimentos", none: "Nenhum atendimento" };

/** Dois toques rápidos não abrem a OS duas vezes. */
const DOUBLE_TAP_MS = 600;

/** A lista na tela: a primeira página (guardada ou nova) mais as que vieram ao rolar. */
interface HistoryList {
  /** Quando a primeira página chegou ao aparelho: o "dados de…" do aviso. */
  at: string;
  items: HistoryItem[];
  counts: HistoryMonthCount[];
  total: number;
  /** O cursor da próxima página; null no fim. */
  next: string | null;
}

/** A última busca da primeira página falhou. */
interface Failure {
  offline: boolean;
  message: string;
}

type RefreshMode = "open" | "pull" | "retry";
type MoreState = "idle" | "loading" | "failed";

const fromStored = (stored: StoredHistory): HistoryList => ({
  at: stored.at,
  items: stored.data.items,
  counts: stored.data.months,
  total: stored.data.total ?? stored.data.items.length,
  next: stored.data.next_cursor,
});

/** "0123 · Loja Exemplo" e "Santos/SP"; o que não veio fica de fora. */
function placeOf(item: HistoryItem): { site: string | null; city: string | null } {
  const site = [item.location_code, item.location_name].filter(Boolean).join(" · ") || null;
  const city = item.city ? (item.state ? `${item.city}/${item.state}` : item.city) : null;
  return { site, city };
}

export default function HistoryScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const sync = useSyncStatus();
  const online = isOnline(sync);
  // undefined: lendo o aparelho; null: nada guardado.
  const [list, setList] = useState<HistoryList | null | undefined>(undefined);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [more, setMore] = useState<MoreState>("idle");
  const mounted = useRef(true);
  // Muda quando a primeira página é trocada: uma página seguinte pedida antes disso não entra na lista nova.
  const generation = useRef(0);
  const moreBusy = useRef(false);
  // Chegou ao fim da lista sem internet: busca a próxima página quando a conexão voltar.
  const pendingEnd = useRef(false);
  const lastOpen = useRef(0);

  const refreshFirst = useCallback(async (mode: RefreshMode) => {
    if (mode === "pull") setRefreshing(true);
    if (mode === "retry") setRetrying(true);
    const result = await refreshHistoryFirstPage();
    if (!mounted.current) return;
    if (result.ok) {
      generation.current += 1;
      pendingEnd.current = false;
      setList(fromStored(result.stored));
      setMore("idle");
      setFailure(null);
    } else {
      setFailure({ offline: result.offline, message: result.message });
    }
    setRefreshing(false);
    setRetrying(false);
  }, []);

  // Ao abrir: o guardado primeiro; a primeira página de novo se nada está guardado ou se passou de 2 min.
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    loadHistoryFirstPage().then(
      (stored) => {
        if (!alive) return;
        setList(stored ? fromStored(stored) : null);
        if (!stored || Date.now() - new Date(stored.at).getTime() >= HISTORY_FRESH_MS) void refreshFirst("open");
      },
      (error: unknown) => {
        console.warn("Falha ao ler o histórico guardado", error);
        if (!alive) return;
        setList(null);
        void refreshFirst("open");
      },
    );
    return () => {
      alive = false;
      mounted.current = false;
    };
  }, [refreshFirst]);

  /** A próxima página (ao chegar perto do fim, ou "Tentar de novo"): junta sem repetir. */
  async function loadMore(manual: boolean) {
    const current = list;
    if (!current?.next || moreBusy.current) return;
    if (more === "failed" && !manual) return;
    if (!isOnline()) {
      pendingEnd.current = true;
      return;
    }
    pendingEnd.current = false;
    moreBusy.current = true;
    const round = generation.current;
    const cursor = current.next;
    setMore("loading");
    try {
      const page = await fetchHistoryPage(cursor);
      if (!mounted.current || round !== generation.current) return;
      setList((now) =>
        now && now.next === cursor
          ? { ...now, items: mergeItems(now.items, page.items), counts: mergeCounts(now.counts, page.months), next: page.next_cursor }
          : now,
      );
      setMore("idle");
    } catch (error) {
      if (!mounted.current || round !== generation.current) return;
      if (historyFailure(error).offline) pendingEnd.current = true;
      setMore("failed");
    } finally {
      moreBusy.current = false;
    }
  }

  // A internet voltou e a lista tinha parado no fim: segue de onde parou.
  const resumeMore = useEffectEvent(() => {
    if (!pendingEnd.current) return;
    setTimeout(() => void loadMore(true), 0);
  });
  useEffect(() => {
    if (online) resumeMore();
  }, [online]);

  function open(id: string) {
    const now = Date.now();
    if (now - lastOpen.current < DOUBLE_TAP_MS) return;
    lastOpen.current = now;
    void openTicketAnywhere(id);
  }

  const refreshControl = (
    <RefreshControl refreshing={refreshing} onRefresh={() => void refreshFirst("pull")} colors={[c.primary]} tintColor={c.primary} />
  );

  if (!list) {
    // Nada guardado: o esqueleto enquanto lê o aparelho e na primeira busca; sem internet ou com erro, o aviso.
    return (
      <ScrollView contentContainerStyle={[styles.state, { paddingBottom: insets.bottom + 24 }]} refreshControl={refreshControl}>
        {list === null && failure?.offline ? (
          <EmptyState
            icon="wifiOff"
            title="Sem internet"
            description="O histórico aparece quando a conexão voltar."
            action={{ label: "Tentar de novo", onPress: () => void refreshFirst("retry") }}
          />
        ) : list === null && failure ? (
          <View style={styles.errorState}>
            <ErrorBox message={failure.message} />
            <Button title="Tentar de novo" icon="repeat" onPress={() => void refreshFirst("retry")} loading={retrying} />
          </View>
        ) : (
          <HistorySkeleton />
        )}
      </ScrollView>
    );
  }

  const sections = historySections(list.items, list.counts);
  const when = levelMoment(list.at);
  const notice = failure
    ? failure.offline
      ? list.next
        ? `Sem internet · mostrando os ${list.items.length} mais recentes, de ${when}`
        : `Sem internet · dados de ${when}`
      : `Não deu para atualizar · dados de ${when}`
    : null;
  const totalText = countText(list.total, SERVICES);

  const header = (
    <View style={styles.listHeader}>
      {notice && failure ? <InfoBox message={notice} icon={failure.offline ? "wifiOff" : "alert"} /> : null}
      {list.items.length ? (
        <View accessible accessibilityLabel={`${totalText}, como responsável ou junto`}>
          <Text style={styles.total}>{totalText}</Text>
          <Text style={styles.totalNote}>como responsável ou junto</Text>
        </View>
      ) : null}
    </View>
  );

  const footer = !list.items.length ? undefined : more === "loading" ? (
    <View style={styles.footerRow} accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={c.inkMuted} />
      <Text style={styles.footerText}>Carregando mais…</Text>
    </View>
  ) : list.next && !online ? (
    <Text style={[styles.footerText, styles.footerAlone]}>Conecte-se à internet para ver os mais antigos.</Text>
  ) : more === "failed" ? (
    <View style={styles.footerFailed}>
      <Text style={styles.footerText}>Não deu para carregar mais.</Text>
      <Button compact variant="ghost" title="Tentar de novo" onPress={() => void loadMore(true)} />
    </View>
  ) : list.next ? undefined : (
    <Text style={[styles.end, styles.footerAlone]}>Fim do histórico</Text>
  );

  return (
    <SectionList
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      sections={sections}
      keyExtractor={(item) => item.id}
      renderItem={({ item, index, section }) => (
        <HistoryRow item={item} first={index === 0} last={index === section.data.length - 1} onOpen={open} />
      )}
      renderSectionHeader={({ section }) => <MonthHeader month={section.month} count={section.count} />}
      stickySectionHeadersEnabled
      onEndReached={() => void loadMore(false)}
      onEndReachedThreshold={0.5}
      initialNumToRender={12}
      windowSize={9}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <EmptyState icon="history" title="Nenhum atendimento ainda" description="As OS que você concluir aparecem aqui, separadas por mês." />
      }
      ListFooterComponent={footer}
      refreshControl={refreshControl}
    />
  );
}

function MonthHeader({ month, count }: { month: string; count: number }) {
  const styles = useStyles(makeStyles);
  const title = monthTitle(month);
  const label = countText(count, SERVICES);
  // O título (com o ano, que separa as seções do sistema antigo) vai sempre inteiro: sem espaço, a contagem desce.
  return (
    <View style={styles.monthHeader} accessible accessibilityRole="header" accessibilityLabel={`${title}, ${label}`}>
      <Text style={styles.monthTitle}>{title}</Text>
      <Text style={styles.monthCount}>{label}</Text>
    </View>
  );
}

function HistoryRow({
  item,
  first,
  last,
  onOpen,
}: {
  item: HistoryItem;
  first: boolean;
  last: boolean;
  onOpen: (id: string) => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const { site, city } = placeOf(item);
  const place = [site, city].filter(Boolean).join(" · ");
  const helper = item.role === "helper";
  const spoken = [
    item.code,
    item.service,
    site,
    city,
    `concluída em ${levelDate(item.resolved_at)}`,
    helper ? "você foi junto" : null,
    item.legacy ? "sistema antigo" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Pressable
      onPress={() => onOpen(item.id)}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Abre a OS"
      style={({ pressed }) => [
        styles.row,
        first ? styles.rowFirst : styles.rowDivider,
        last && styles.rowLast,
        pressed && { backgroundColor: c.surface2 },
      ]}
    >
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.code}>{item.code}</Text>
          <Text style={styles.date}>{formatDate(item.resolved_at)}</Text>
        </View>
        <Text style={styles.service} numberOfLines={1}>
          {item.service}
        </Text>
        {place ? (
          <Text style={styles.place} numberOfLines={1}>
            {place}
          </Text>
        ) : null}
        {helper || item.legacy ? (
          <View style={styles.badges}>
            {helper ? <Badge label="Junto" color={c.inkSubtle} /> : null}
            {item.legacy ? <Badge label="Sistema antigo" color={c.inkSubtle} /> : null}
          </View>
        ) : null}
      </View>
      <Icon name="chevronRight" size={18} color={c.inkSubtle} />
    </Pressable>
  );
}

/** Nada guardado, enquanto a primeira busca não volta. */
function HistorySkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.skeleton} accessible accessibilityLabel="Carregando o histórico" accessibilityRole="progressbar">
      <Skeleton width={160} height={16} />
      <Skeleton width={120} height={14} style={styles.skeletonTitle} />
      <View style={styles.skeletonRows}>
        {[0, 1, 2, 3, 4, 5].map((key) => (
          <Skeleton key={key} height={72} radius={RADIUS.control} />
        ))}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { paddingHorizontal: 16, paddingTop: 16 },
    state: { padding: 16, gap: 14, flexGrow: 1 },
    errorState: { gap: 10 },
    listHeader: { gap: 12, paddingBottom: 6 },
    total: { fontSize: 16, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    totalNote: { fontSize: 13, color: c.inkMuted, marginTop: 2 },
    monthHeader: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      columnGap: 8,
      rowGap: 2,
      paddingVertical: 8,
      backgroundColor: c.canvas,
    },
    monthTitle: { fontSize: 14, fontWeight: "700", color: c.ink },
    monthCount: { fontSize: 12, fontWeight: "600", color: c.inkMuted, fontVariant: ["tabular-nums"] },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 72,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: c.surface,
      borderColor: c.line,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderRightWidth: StyleSheet.hairlineWidth,
    },
    rowFirst: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopLeftRadius: RADIUS.card,
      borderTopRightRadius: RADIUS.card,
    },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth },
    rowLast: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomLeftRadius: RADIUS.card,
      borderBottomRightRadius: RADIUS.card,
      marginBottom: 12,
    },
    rowBody: { flex: 1, gap: 3 },
    rowHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
    code: { flexShrink: 1, fontSize: 13, fontWeight: "700", color: c.inkMuted, fontVariant: ["tabular-nums"] },
    date: { fontSize: 12, fontWeight: "600", color: c.inkMuted, fontVariant: ["tabular-nums"] },
    service: { fontSize: 15, fontWeight: "600", color: c.ink },
    place: { fontSize: 13, color: c.inkMuted },
    badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
    footerRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12 },
    footerFailed: { alignItems: "center", gap: 4, paddingVertical: 8 },
    footerAlone: { paddingVertical: 12 },
    footerText: { fontSize: 13, color: c.inkMuted, textAlign: "center" },
    end: { fontSize: 12, color: c.inkSubtle, textAlign: "center" },
    skeleton: { gap: 10 },
    skeletonTitle: { marginTop: 10 },
    skeletonRows: { gap: 8 },
  });
