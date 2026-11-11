import { router, Stack } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { ConnectionBar } from "../components/ConnectionBar";
import { TicketCard } from "../components/TicketCard";
import { colors, EmptyState, Segmented } from "../components/ui";
import { useLiveQuery, useNow } from "../lib/changes";
import { listNotices, listTickets } from "../lib/db";
import { addDays, formatDay, startOfDay } from "../lib/format";
import { buildLists } from "../lib/lists";
import { useSession } from "../lib/session";
import { requestSync, useSyncStatus } from "../lib/sync";
import type { LocalTicket } from "../lib/syncTypes";

type Tab = "today" | "agenda" | "team";

function dayTitle(day: Date, now: number): string {
  const today = startOfDay(new Date(now)).getTime();
  if (day.getTime() === today) return `Hoje · ${formatDay(day)}`;
  if (day.getTime() === addDays(new Date(today), 1).getTime()) return `Amanhã · ${formatDay(day)}`;
  return formatDay(day);
}

export default function MyTicketsScreen() {
  const { user } = useSession();
  const tickets = useLiveQuery(listTickets);
  const notices = useLiveQuery(listNotices);
  const sync = useSyncStatus();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("today");
  const [refreshing, setRefreshing] = useState(false);

  const lists = useMemo(() => (user ? buildLists(tickets ?? [], user, new Date(now)) : null), [tickets, user, now]);
  if (!user || !lists) return null;

  async function refresh() {
    setRefreshing(true);
    await requestSync();
    setRefreshing(false);
  }

  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.brand]} />;
  const neverSynced = tickets !== undefined && tickets.length === 0 && !sync.lastSyncAt;
  const emptyText = neverSynced
    ? sync.network === "offline"
      ? "Conecte o aparelho à internet para baixar suas OS pela primeira vez."
      : "Baixando suas OS…"
    : undefined;

  const header = (
    <View style={styles.header}>
      <Text style={styles.greeting}>Olá, {user.name.split(" ")[0]}</Text>
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
          { value: "agenda", label: "Agenda", count: lists.agenda.reduce((n, d) => n + d.items.length, 0) },
          { value: "team", label: "Equipe", count: lists.team.length },
        ]}
      />
    </View>
  );

  const renderTicket = ({ item }: { item: LocalTicket }) => (
    <View style={styles.item}>
      <TicketCard ticket={item} now={now} showDate={tab === "team"} />
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => router.push("/conta")} hitSlop={12} accessibilityRole="button">
              <Text style={styles.headerLink}>Conta</Text>
            </Pressable>
          ),
        }}
      />
      <ConnectionBar />
      {tickets === undefined ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.brand} />
      ) : tab === "agenda" ? (
        <SectionList
          sections={lists.agenda.map((d) => ({ title: dayTitle(d.day, now), data: d.items }))}
          keyExtractor={(item) => item.id}
          renderItem={renderTicket}
          renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <EmptyState title="Nenhuma visita agendada" description={emptyText ?? "As OS agendadas para você aparecem aqui, por dia."} />
          }
          refreshControl={refreshControl}
          contentContainerStyle={styles.list}
          stickySectionHeadersEnabled={false}
        />
      ) : (
        <FlatList
          data={tab === "today" ? lists.today : lists.team}
          keyExtractor={(item) => item.id}
          renderItem={renderTicket}
          ListHeaderComponent={header}
          ListEmptyComponent={
            tab === "today" ? (
              <EmptyState title="Nada para hoje" description={emptyText ?? "Você não tem OS em aberto para hoje."} />
            ) : (
              <EmptyState
                title="Fila da equipe vazia"
                description={emptyText ?? "OS do seu grupo ou sem grupo que ainda não estão com você."}
              />
            )
          }
          refreshControl={refreshControl}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: 32 },
  header: { padding: 16, gap: 12 },
  greeting: { fontSize: 22, fontWeight: "700", color: colors.ink },
  notice: { backgroundColor: "#fef2f2", borderColor: "#fecaca", borderWidth: 1, borderRadius: 10, padding: 10 },
  noticeText: { color: colors.danger, fontSize: 13, fontWeight: "600" },
  item: { paddingHorizontal: 16, paddingBottom: 10 },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 13,
    fontWeight: "700",
    color: colors.inkMuted,
    textTransform: "uppercase",
  },
  headerLink: { color: colors.brand, fontSize: 16, fontWeight: "600" },
});
