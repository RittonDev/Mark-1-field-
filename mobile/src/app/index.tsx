import { router, Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLogo } from "../components/Brand";
import { Calendar } from "../components/Calendar";
import { ConnectionBar } from "../components/ConnectionBar";
import { Icon } from "../components/Icon";
import { PressableScale, useListMotion } from "../components/motion";
import { ShiftCard } from "../components/ShiftCard";
import { TicketListSkeleton } from "../components/Skeleton";
import { TabBar } from "../components/TabBar";
import { Text } from "../components/Text";
import { TicketCard, TimelineRow } from "../components/TicketCard";
import { EmptyState } from "../components/ui";
import { useLiveQuery, useNow } from "../lib/changes";
import { listNotices, listTickets } from "../lib/db";
import { arrivalUrgency } from "../lib/field";
import { addDays, formatDay, initials, startOfDay } from "../lib/format";
import { buildLists, ticketsOnDay } from "../lib/lists";
import { useSession } from "../lib/session";
import { requestSync, useSyncStatus } from "../lib/sync";
import type { LocalTicket } from "../lib/syncTypes";
import { shouldPromptConsent } from "../lib/tracking";
import { RADIUS, tint, useStyles, useTheme, type Palette } from "../theme/theme";

type Tab = "today" | "agenda" | "done";

function greetingFor(date: Date) {
  const hour = date.getHours();
  return hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
}

export default function MyTicketsScreen() {
  const { user } = useSession();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const motion = useListMotion();
  const tickets = useLiveQuery(listTickets);
  const notices = useLiveQuery(listNotices);
  const sync = useSyncStatus();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("today");
  const [refreshing, setRefreshing] = useState(false);
  // Dia da lista "Hoje": dá para voltar e avançar os dias (como no app que a equipe já usa).
  const [dayOffset, setDayOffset] = useState(0);

  const lists = useMemo(() => (user ? buildLists(tickets ?? [], user, new Date(now)) : null), [tickets, user, now]);
  const selectedDay = useMemo(() => addDays(startOfDay(new Date(now)), dayOffset), [now, dayOffset]);
  const otherDay = useMemo(
    () => (user && tickets && dayOffset !== 0 ? ticketsOnDay(tickets, user, selectedDay, new Date(now)) : null),
    [tickets, user, selectedDay, dayOffset, now],
  );

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
  const dayList = dayOffset === 0 ? lists.today : (otherDay ?? []);
  const data = tab === "today" ? dayList : tab === "done" ? lists.done : [];
  const today = new Date(now);
  const relativeDay = dayOffset === 0 ? "Hoje" : dayOffset === 1 ? "Amanhã" : dayOffset === -1 ? "Ontem" : null;
  const sectionTitle = tab === "done" ? "Concluídas nos últimos 7 dias" : "Agenda";
  // Resumo do dia; a lista já vem por urgência (chegada atrasada, em risco, depois a agenda).
  const summary = {
    total: lists.today.length,
    working: lists.today.filter((t) => t.status === "in_progress").length,
    late: lists.today.filter((t) => arrivalUrgency(t, now) === 0).length,
  };

  const header = (
    <View style={styles.header}>
      <View style={styles.topBar}>
        <BrandLogo size="sm" underline={false} />
        <PressableScale
          onPress={() => router.push("/conta")}
          accessibilityRole="button"
          accessibilityLabel="Conta e sincronização"
          hitSlop={8}
          style={styles.avatar}
          pressedStyle={{ backgroundColor: c.surface3 }}
        >
          <Text style={styles.avatarText}>{initials(user.name)}</Text>
        </PressableScale>
      </View>
      <View style={{ gap: 4 }}>
        <Text style={styles.greeting}>
          {greetingFor(today)}, {user.name.split(" ")[0]}
        </Text>
        <Text style={styles.date}>{formatDay(today)}</Text>
      </View>
      <ShiftCard />
      {notices && notices.length > 0 ? (
        <Pressable onPress={() => router.push("/conta")} style={styles.notice} accessibilityRole="button">
          <Icon name="alert" size={16} color={c.danger} />
          <Text style={styles.noticeText}>
            {notices.length === 1 ? "1 aviso de sincronização" : `${notices.length} avisos de sincronização`} — toque para ver
          </Text>
        </Pressable>
      ) : null}
      {tab === "today" ? (
        <View style={{ gap: 10 }}>
          <View style={styles.dayNav}>
            <PressableScale
              onPress={() => setDayOffset((d) => d - 1)}
              accessibilityRole="button"
              accessibilityLabel="Dia anterior"
              hitSlop={6}
              style={styles.dayButton}
              pressedStyle={{ backgroundColor: c.surface3 }}
            >
              <Icon name="chevronLeft" size={20} color={c.ink} />
            </PressableScale>
            <Pressable
              onPress={() => setDayOffset(0)}
              disabled={dayOffset === 0}
              accessibilityRole="button"
              accessibilityLabel={dayOffset === 0 ? "Hoje" : "Voltar para hoje"}
              style={styles.dayCenter}
            >
              <Text style={styles.dayTitle}>{relativeDay ?? formatDay(selectedDay)}</Text>
              <Text style={styles.daySubtitle}>
                {relativeDay ? formatDay(selectedDay) : "toque para voltar a hoje"}
              </Text>
            </Pressable>
            <PressableScale
              onPress={() => setDayOffset((d) => d + 1)}
              accessibilityRole="button"
              accessibilityLabel="Próximo dia"
              hitSlop={6}
              style={styles.dayButton}
              pressedStyle={{ backgroundColor: c.surface3 }}
            >
              <Icon name="chevronRight" size={20} color={c.ink} />
            </PressableScale>
          </View>
          {dayOffset === 0 ? (
            <View style={styles.sectionRow} accessibilityRole="summary">
              <Text style={styles.summary}>
                <Text style={styles.summaryStrong}>{summary.total === 1 ? "1 OS" : `${summary.total} OS`}</Text>
                {" · "}
                <Text style={styles.summaryStrong}>{summary.working} em atendimento</Text>
                {summary.late ? (
                  <Text style={[styles.summaryStrong, { color: c.danger }]}>
                    {" · "}
                    {summary.late === 1 ? "1 chegada atrasada" : `${summary.late} chegadas atrasadas`}
                  </Text>
                ) : null}
              </Text>
            </View>
          ) : (
            <View style={styles.sectionRow}>
              <Text style={styles.summary}>
                <Text style={styles.summaryStrong}>{dayList.length === 1 ? "1 OS" : `${dayList.length} OS`}</Text>
                {dayOffset > 0 ? " agendadas" : " no dia"}
              </Text>
              <Pressable onPress={() => setDayOffset(0)} accessibilityRole="button" hitSlop={8} style={{ marginLeft: "auto" }}>
                <Text style={styles.backToday}>Voltar para hoje</Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : (
        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>{sectionTitle}</Text>
          {tab !== "agenda" ? <Text style={styles.sectionCount}>{data.length}</Text> : null}
        </View>
      )}
    </View>
  );

  const empty =
    tab === "today" ? (
      dayOffset === 0 ? (
        <EmptyState
          icon="today"
          title="Nada para hoje"
          description={emptyText ?? "Quando o analista atribuir uma OS a você, ela aparece aqui."}
        />
      ) : (
        <EmptyState
          icon="calendar"
          title={
            dayOffset > 0
              ? `Nenhuma OS agendada para ${relativeDay ? relativeDay.toLowerCase() : formatDay(selectedDay)}`
              : `Nenhuma OS ${relativeDay ? relativeDay.toLowerCase() : `em ${formatDay(selectedDay)}`}`
          }
          description={dayOffset > 0 ? "Quando a central agendar uma visita para este dia, ela aparece aqui." : undefined}
        />
      )
    ) : (
      <EmptyState icon="checkCircle" title="Nada concluído nos últimos 7 dias" description={emptyText} />
    );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ConnectionBar />
      {tickets === undefined ? (
        <View style={{ flex: 1 }}>
          {header}
          <TicketListSkeleton />
        </View>
      ) : (
        <Animated.FlatList
          data={data}
          keyExtractor={(item: LocalTicket) => item.id}
          itemLayoutAnimation={motion.layout}
          renderItem={({ item, index }) => (
            <Animated.View entering={motion.entering(index)} style={styles.item}>
              {tab === "today" && dayOffset === 0 ? (
                <TimelineRow ticket={item} now={now} last={index === data.length - 1} />
              ) : tab === "today" ? (
                <View style={{ paddingBottom: 12 }}>
                  <TicketCard ticket={item} now={now} />
                </View>
              ) : (
                <View style={{ paddingBottom: 12 }}>
                  <TicketCard ticket={item} now={now} showDate />
                </View>
              )}
            </Animated.View>
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
            tab === "today" && dayOffset === 0 && lists.reschedule.length ? (
              <View style={styles.footerSection}>
                <Text style={styles.sectionTitle}>Aguardando reagendamento pela central</Text>
                <Text style={styles.footerHint}>Visita improdutiva registrada. A OS volta para a agenda quando for reagendada.</Text>
                {lists.reschedule.map((ticket, i) => (
                  <Animated.View key={ticket.id} entering={motion.entering(i)} style={styles.footerItem}>
                    <TicketCard ticket={ticket} now={now} />
                  </Animated.View>
                ))}
              </View>
            ) : undefined
          }
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} tintColor={c.primary} />}
          contentContainerStyle={styles.list}
        />
      )}
      <TabBar<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { value: "today", label: "Hoje", icon: "today", count: lists.today.length },
          { value: "agenda", label: "Agenda", icon: "calendar" },
          { value: "done", label: "Concluídas", icon: "checkCircle" },
        ]}
      />
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    list: { paddingBottom: 24 },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 16 },
    topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.lineStrong,
    },
    avatarText: { fontSize: 13, fontWeight: "700", color: c.ink },
    greeting: { fontSize: 26, fontWeight: "700", color: c.ink, letterSpacing: -0.4 },
    date: { fontSize: 14, color: c.inkMuted, textTransform: "capitalize" },
    notice: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: c.dangerSoft,
      borderColor: tint(c.danger, "40"),
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: RADIUS.control,
      padding: 12,
    },
    noticeText: { color: c.danger, fontSize: 13, fontWeight: "600", flex: 1 },
    sectionRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
    sectionTitle: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    sectionCount: { fontSize: 12, fontWeight: "700", color: c.inkSubtle, fontVariant: ["tabular-nums"] },
    summary: { fontSize: 14, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    summaryStrong: { fontWeight: "700", color: c.ink },
    dayNav: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: c.surface,
      borderColor: c.line,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: RADIUS.card,
      padding: 6,
    },
    dayButton: {
      width: 40,
      height: 40,
      borderRadius: RADIUS.control,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface2,
    },
    dayCenter: { flex: 1, alignItems: "center", paddingVertical: 2 },
    dayTitle: { fontSize: 16, fontWeight: "700", color: c.ink, textTransform: "capitalize" },
    daySubtitle: { fontSize: 12, color: c.inkMuted, textTransform: "capitalize" },
    backToday: { fontSize: 13, fontWeight: "700", color: c.primary },
    item: { paddingHorizontal: 16 },
    calendar: { paddingHorizontal: 16 },
    footerSection: { paddingHorizontal: 16, paddingTop: 16, gap: 8 },
    footerHint: { fontSize: 12, color: c.inkSubtle, marginBottom: 4 },
    footerItem: { paddingBottom: 4, opacity: 0.85 },
  });
