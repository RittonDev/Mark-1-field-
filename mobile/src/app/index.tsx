import { router, Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Text } from "../components/Text";
import { BrandLogo, BrandRule } from "../components/Brand";
import { Calendar } from "../components/Calendar";
import { ConnectionBar } from "../components/ConnectionBar";
import { ShiftCard } from "../components/ShiftCard";
import { TicketCard } from "../components/TicketCard";
import { EmptyState, Segmented } from "../components/ui";
import { useLiveQuery, useNow } from "../lib/changes";
import { listNotices, listTickets } from "../lib/db";
import { formatDay } from "../lib/format";
import { buildLists } from "../lib/lists";
import { useSession } from "../lib/session";
import { requestSync, useSyncStatus } from "../lib/sync";
import { shouldPromptConsent } from "../lib/tracking";
import type { LocalTicket } from "../lib/syncTypes";
import { useStyles, useTheme, type Palette } from "../theme/theme";

type Tab = "today" | "agenda" | "done";

export default function MyTicketsScreen() {
  const { user } = useSession();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const tickets = useLiveQuery(listTickets);
  const notices = useLiveQuery(listNotices);
  const sync = useSyncStatus();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("today");
  const [refreshing, setRefreshing] = useState(false);

  const lists = useMemo(() => (user ? buildLists(tickets ?? [], user, new Date(now)) : null), [tickets, user, now]);

  // LGPD: no primeiro acesso sem aceite, o termo de localização abre sozinho (dá para adiar).
  useEffect(() => {
    if (user && shouldPromptConsent()) router.push("/termo-rastreamento");
  }, [user]);

  if (!user || !lists) return null;

  async function refresh() {
    setRefreshing(true);
    await requestSync();
    setRefreshing(false);
  }

  const neverSynced = tickets !== undefined && tickets.length === 0 && !sync.lastSyncAt;
  const emptyText = neverSynced
    ? sync.network === "offline"
      ? "Conecte o aparelho à internet para baixar suas OS pela primeira vez."
      : "Baixando suas OS…"
    : undefined;

  // A aba Agenda é o calendário (mês/semana); as outras são listas.
  const data = tab === "today" ? lists.today : tab === "done" ? lists.done : [];

  const header = (
    <View style={styles.header}>
      <View style={{ gap: 6 }}>
        <Text style={styles.date}>{formatDay(new Date(now))}</Text>
        <Text style={styles.greeting}>Olá, {user.name.split(" ")[0]}</Text>
        <BrandRule width={36} />
      </View>
      <ShiftCard />
      {notices && notices.length > 0 ? (
        <Pressable onPress={() => router.push("/conta")} style={styles.notice} accessibilityRole="button">
          <Text style={styles.noticeText}>
            {notices.length === 1 ? "1 aviso de sincronização" : `${notices.length} avisos de sincronização`} — toque para ver
          </Text>
        </Pressable>
      ) : null}
      <Segmented<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "today", label: "Hoje", count: lists.today.length },
          { value: "agenda", label: "Agenda" },
          { value: "done", label: "Concluídas", count: lists.done.length },
        ]}
      />
    </View>
  );

  const empty =
    tab === "today" ? (
      <EmptyState title="Nada para hoje" description={emptyText ?? "Quando o analista atribuir uma OS a você, ela aparece aqui."} />
    ) : (
      <EmptyState title="Nada concluído nos últimos 7 dias" description={emptyText} />
    );

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerTitle: () => <BrandLogo size="sm" underline={false} />,
          headerRight: () => (
            <Pressable onPress={() => router.push("/conta")} hitSlop={12} accessibilityRole="button" accessibilityLabel="Conta">
              <Text style={styles.headerLink}>Conta</Text>
            </Pressable>
          ),
        }}
      />
      <ConnectionBar />
      {tickets === undefined ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={c.primary} />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item: LocalTicket) => item.id}
          renderItem={({ item }) => (
            <View style={styles.item}>
              <TicketCard ticket={item} now={now} showDate={tab !== "today"} />
            </View>
          )}
          ListHeaderComponent={
            <>
              {header}
              {tab === "agenda" ? (
                <View style={styles.calendar}>
                  <Calendar tickets={tickets} user={user} now={now} />
                </View>
              ) : null}
            </>
          }
          ListEmptyComponent={tab === "agenda" ? undefined : empty}
          ListFooterComponent={
            tab === "today" && lists.reschedule.length ? (
              <View style={styles.footerSection}>
                <Text style={styles.footerTitle}>Aguardando reagendamento pela central</Text>
                <Text style={styles.footerHint}>Visita improdutiva registrada. A OS volta para a agenda quando for reagendada.</Text>
                {lists.reschedule.map((ticket) => (
                  <View key={ticket.id} style={styles.footerItem}>
                    <TicketCard ticket={ticket} now={now} />
                  </View>
                ))}
              </View>
            ) : undefined
          }
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} tintColor={c.primary} />}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    list: { paddingBottom: 32 },
    header: { padding: 16, paddingTop: 20, gap: 16 },
    date: { fontSize: 13, color: c.inkMuted, textTransform: "capitalize" },
    greeting: { fontSize: 24, fontWeight: "700", color: c.ink, letterSpacing: -0.3 },
    notice: { backgroundColor: c.dangerSoft, borderColor: c.danger + "44", borderWidth: 1, borderRadius: 12, padding: 12 },
    noticeText: { color: c.danger, fontSize: 13, fontWeight: "600" },
    item: { paddingHorizontal: 16, paddingBottom: 10 },
    calendar: { paddingHorizontal: 16 },
    footerSection: { paddingHorizontal: 16, paddingTop: 12, gap: 6 },
    footerTitle: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.5 },
    footerHint: { fontSize: 12, color: c.inkSubtle, marginBottom: 4 },
    footerItem: { paddingBottom: 10, opacity: 0.85 },
    headerLink: { color: c.primary, fontSize: 16, fontWeight: "600" },
  });
