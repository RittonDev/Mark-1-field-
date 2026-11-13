import NetInfo from "@react-native-community/netinfo";
import { router, Stack, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Pressable, RefreshControl, StyleSheet, View, type FlatList } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLogo, BrandRule } from "../components/Brand";
import { Calendar } from "../components/Calendar";
import { ConnectionBar } from "../components/ConnectionBar";
import { EarningsView } from "../components/EarningsView";
import { Icon } from "../components/Icon";
import { PressableScale, useListMotion } from "../components/motion";
import { ShiftCard } from "../components/ShiftCard";
import { TicketListSkeleton } from "../components/Skeleton";
import { TabBar } from "../components/TabBar";
import { Text } from "../components/Text";
import { TicketCard, TimelineRow } from "../components/TicketCard";
import { EmptyState, SectionTitle } from "../components/ui";
import { ensurePushRegistration } from "../lib/auth";
import { useLiveQuery, useNow } from "../lib/changes";
import { getKv, listNotices, listTickets, setKv } from "../lib/db";
import { arrivalUrgency } from "../lib/field";
import { addDays, formatDay, formatTime, initials, startOfDay } from "../lib/format";
import { buildLists, ticketsOnDay, waitingReason } from "../lib/lists";
import { useSession } from "../lib/session";
import { requestSync, useSyncStatus } from "../lib/sync";
import type { LocalTicket } from "../lib/syncTypes";
import { showToast } from "../lib/toast";
import { hasConsent, shouldPromptConsent } from "../lib/tracking";
import { RADIUS, tint, useStyles, useTheme, type Palette } from "../theme/theme";

type Tab = "today" | "agenda" | "done" | "earnings";

// Título das abas que não são a do dia (a de Hoje é a saudação). Uma aba nova sem título não compila.
const TAB_TITLE: Record<Exclude<Tab, "today">, string> = {
  agenda: "Agenda",
  done: "Concluídas",
  earnings: "Meus ganhos",
};

/** A lista do dia volta no máximo 7 dias: antes disso o aparelho pode não ter as OS (pull inicial de 7 dias). */
const MIN_DAY_OFFSET = -7;
/** Dia em que o termo de localização foi oferecido sozinho (no máximo uma vez por dia). */
const CONSENT_PROMPT_KEY = "consent_prompt_day";
/** Tempo máximo esperando os ganhos no "puxar para atualizar". */
const EARNINGS_REFRESH_TIMEOUT_MS = 25_000;

const countLabel = (n: number) => (n === 1 ? "1 OS" : `${n} OS`);

function greetingFor(date: Date) {
  const hour = date.getHours();
  return hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
}

function localDayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * Vazio de Hoje e de Concluídas. Fica num componente próprio porque depende do estado do sync: só ele
 * redesenha a cada mudança do sync, não a tela inteira.
 */
function HomeEmpty({
  variant,
  hasTickets,
  next,
  onAgenda,
}: {
  variant: "today" | "done";
  hasTickets: boolean;
  next?: LocalTicket;
  onAgenda: () => void;
}) {
  const sync = useSyncStatus();
  const neverSynced = !hasTickets && !sync.lastSyncAt;
  const serverTrouble = sync.network !== "offline" && (sync.server === "unreachable" || Boolean(sync.lastError));
  // Primeiro download: o banco local responde vazio na hora; o esqueleto fica até a primeira rodada.
  if (variant === "today" && neverSynced && sync.syncing) return <TicketListSkeleton />;
  const syncText =
    neverSynced && sync.network === "offline"
      ? "Conecte o aparelho à internet para baixar suas OS pela primeira vez."
      : serverTrouble
        ? "Não deu para falar com o servidor. Puxe a tela para baixo para tentar de novo."
        : neverSynced
          ? "Baixando suas OS…"
          : null;
  if (variant === "done") {
    return <EmptyState icon="checkCircle" title="Nada concluído nos últimos 7 dias" description={syncText ?? undefined} />;
  }
  const site = next?.location ? [next.location.code, next.location.name].filter(Boolean).join(" · ") : null;
  const nextText =
    next?.scheduled_start
      ? `Próxima visita: ${formatDay(new Date(next.scheduled_start))} às ${formatTime(next.scheduled_start)}${site ? ` · ${site}` : ""}`
      : null;
  return (
    <EmptyState
      icon="today"
      title="Nada para hoje"
      description={syncText ?? nextText ?? "Quando a central atribuir uma OS a você, ela aparece aqui."}
      action={next && !syncText ? { label: "Ver agenda", onPress: onAgenda } : undefined}
    />
  );
}

export default function MyTicketsScreen() {
  const { user } = useSession();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const motion = useListMotion();
  const tickets = useLiveQuery(listTickets);
  const notices = useLiveQuery(listNotices);
  const now = useNow();
  const [tab, setTab] = useState<Tab>("today");
  const [refreshing, setRefreshing] = useState(false);
  // Dia da lista "Hoje": dá para voltar e avançar os dias (como no app que a equipe já usa).
  const [dayOffset, setDayOffset] = useState(0);
  // A entrada animada é só da primeira carga: trocar de aba ou de dia não refaz a cascata.
  const [intro, setIntro] = useState(true);
  const [earningsKey, setEarningsKey] = useState(0);
  const listRef = useRef<FlatList>(null);
  const earningsSettled = useRef<(() => void) | null>(null);
  const userId = user?.id;
  const loaded = tickets !== undefined;

  // As listas mudam com os dados ou quando vira o dia (o relógio de 30 s só atualiza os cartões).
  const dayKey = startOfDay(new Date(now)).getTime();
  const lists = useMemo(() => (user ? buildLists(tickets ?? [], user, new Date(dayKey)) : null), [tickets, user, dayKey]);
  const selectedDay = useMemo(() => addDays(new Date(dayKey), dayOffset), [dayKey, dayOffset]);
  const otherDay = useMemo(
    () => (user && tickets && dayOffset !== 0 ? ticketsOnDay(tickets, user, selectedDay, new Date(dayKey)) : null),
    [tickets, user, selectedDay, dayOffset, dayKey],
  );
  // Rota direto do cartão: a OS em deslocamento ou, sem ela, a próxima visita ainda não iniciada.
  const routeIds = useMemo(() => {
    if (!lists) return new Set<string>();
    const enRoute = lists.today.filter((t) => t.status === "en_route");
    if (enRoute.length) return new Set(enRoute.map((t) => t.id));
    const next = lists.today.find((t) => t.status === "assigned" || t.status === "scheduled" || t.status === "reopened");
    return new Set(next ? [next.id] : []);
  }, [lists]);

  useEffect(() => {
    if (!loaded || !intro) return;
    const id = setTimeout(() => setIntro(false), 700);
    return () => clearTimeout(id);
  }, [loaded, intro]);

  // LGPD: sem aceite, o termo de localização abre sozinho no máximo uma vez por dia (dá para adiar).
  // O pedido de notificações vem depois do termo (ao fechá-lo), nunca junto com o de localização.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    void (async () => {
      if (hasConsent()) {
        await ensurePushRegistration();
        return;
      }
      const today = localDayKey(new Date());
      const last = await getKv(CONSENT_PROMPT_KEY).catch(() => null);
      if (!alive) return;
      if (last !== today && shouldPromptConsent()) {
        await setKv(CONSENT_PROMPT_KEY, today).catch(() => undefined);
        router.push("/termo-rastreamento");
      } else {
        await ensurePushRegistration();
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  // Voltar do Android: de outra aba volta para Hoje; de outro dia volta para hoje; só então sai do app.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (tab !== "today") {
          setTab("today");
          return true;
        }
        if (dayOffset !== 0) {
          setDayOffset(0);
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [tab, dayOffset]),
  );

  const timeline = tab === "today" && dayOffset === 0;
  const dayList = dayOffset === 0 ? (lists?.today ?? []) : (otherDay ?? []);
  // Agenda e Ganhos não são listas de OS: a lista fica vazia e o conteúdo vem no cabeçalho.
  const data = tab === "today" ? dayList : tab === "done" ? (lists?.done ?? []) : [];
  const count = data.length;

  const renderItem = useCallback(
    ({ item, index }: { item: LocalTicket; index: number }) => (
      <Animated.View entering={intro && index < 4 ? motion.entering(index) : undefined} style={styles.item}>
        {timeline ? (
          <TimelineRow ticket={item} now={now} last={index === count - 1} userId={userId} showRoute={routeIds.has(item.id)} />
        ) : (
          <View style={styles.cardGap}>
            <TicketCard
              ticket={item}
              now={now}
              userId={userId}
              showDate={tab === "done"}
              variant={tab === "done" ? "done" : "default"}
            />
          </View>
        )}
      </Animated.View>
    ),
    [intro, motion, styles, timeline, now, count, userId, routeIds, tab],
  );

  const settleEarnings = useCallback(() => {
    earningsSettled.current?.();
    earningsSettled.current = null;
  }, []);

  if (!user || !lists) return null;

  async function refresh() {
    setRefreshing(true);
    try {
      const net = await NetInfo.fetch();
      if (net.isConnected === false || net.isInternetReachable === false) {
        showToast("Sem internet", { description: "Mostrando o que está no aparelho." });
        return;
      }
      if (tab === "earnings") {
        // Ganhos vêm da central: o indicador espera a consulta terminar, não só o sync das OS.
        const settled = new Promise<void>((resolve) => {
          earningsSettled.current = resolve;
          setTimeout(resolve, EARNINGS_REFRESH_TIMEOUT_MS);
        });
        setEarningsKey((k) => k + 1);
        await Promise.all([requestSync(), settled]);
      } else {
        await requestSync();
      }
    } finally {
      setRefreshing(false);
    }
  }

  function changeTab(next: Tab) {
    setTab(next);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }

  // Tocar de novo na aba ativa: Hoje volta ao dia de hoje; todas voltam ao topo.
  function reselect(value: Tab) {
    if (value === "today") setDayOffset(0);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }

  const today = new Date(now);
  const relativeDay = dayOffset === 0 ? "Hoje" : dayOffset === 1 ? "Amanhã" : dayOffset === -1 ? "Ontem" : null;
  const atOldest = dayOffset <= MIN_DAY_OFFSET;
  // Resumo do dia: só o que existe (zero não ocupa espaço); atraso de chegada em vermelho.
  const working = lists.today.filter((t) => t.status === "in_progress").length;
  const late = lists.today.filter((t) => arrivalUrgency(t, now) === 0).length;
  const firstName = user.name.split(" ")[0];

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
          <Text style={styles.avatarText} maxFontSizeMultiplier={1.2}>
            {initials(user.name)}
          </Text>
        </PressableScale>
      </View>
      <View style={styles.titleBlock}>
        <Text style={styles.pageTitle} accessibilityRole="header" numberOfLines={2}>
          {tab === "today" ? `${greetingFor(today)}, ${firstName}` : TAB_TITLE[tab]}
        </Text>
        <BrandRule width={28} />
        {tab === "done" ? <Text style={styles.pageSubtitle}>Últimos 7 dias · {countLabel(lists.done.length)}</Text> : null}
      </View>
      {tab === "today" ? <ShiftCard /> : null}
      {notices && notices.length > 0 ? (
        <Pressable
          onPress={() => router.push("/conta")}
          style={({ pressed }) => [styles.notice, pressed && { opacity: 0.8 }]}
          accessibilityRole="button"
          accessibilityHint="Abre a conta para ver os avisos"
        >
          <Icon name="alert" size={16} color={c.danger} />
          <Text style={styles.noticeText}>
            {notices.length === 1 ? "1 ação não foi aceita pela central" : `${notices.length} ações não foram aceitas pela central`}
          </Text>
          <Icon name="chevronRight" size={16} color={c.danger} />
        </Pressable>
      ) : null}
      {tab === "today" ? (
        <View style={{ gap: 10 }}>
          <View style={styles.dayNav}>
            <PressableScale
              onPress={() => setDayOffset((d) => Math.max(MIN_DAY_OFFSET, d - 1))}
              disabled={atOldest}
              accessibilityRole="button"
              accessibilityLabel="Dia anterior"
              accessibilityState={{ disabled: atOldest }}
              hitSlop={4}
              style={[styles.dayButton, atOldest && { opacity: 0.35 }]}
              pressedStyle={{ backgroundColor: c.surface3 }}
            >
              <Icon name="chevronLeft" size={20} color={c.ink} />
            </PressableScale>
            <Pressable
              onPress={() => setDayOffset(0)}
              disabled={dayOffset === 0}
              accessibilityRole="button"
              accessibilityLabel={dayOffset === 0 ? `Hoje, ${formatDay(selectedDay)}` : `${formatDay(selectedDay)}. Voltar para hoje`}
              style={styles.dayCenter}
            >
              <Text style={styles.dayTitle}>{relativeDay ?? formatDay(selectedDay)}</Text>
              <Text style={styles.daySubtitle}>{relativeDay ? formatDay(selectedDay) : "toque para voltar a hoje"}</Text>
            </Pressable>
            <PressableScale
              onPress={() => setDayOffset((d) => d + 1)}
              accessibilityRole="button"
              accessibilityLabel="Próximo dia"
              hitSlop={4}
              style={styles.dayButton}
              pressedStyle={{ backgroundColor: c.surface3 }}
            >
              <Icon name="chevronRight" size={20} color={c.ink} />
            </PressableScale>
          </View>
          {dayOffset === 0 ? (
            lists.today.length ? (
              <View style={styles.sectionRow} accessibilityRole="summary">
                <Text style={styles.summary}>
                  <Text style={styles.summaryStrong}>{countLabel(lists.today.length)}</Text>
                  {working ? ` · ${working} em atendimento` : ""}
                  {late ? (
                    <Text style={[styles.summaryStrong, { color: c.danger }]}>
                      {" · "}
                      {late === 1 ? "1 chegada atrasada" : `${late} chegadas atrasadas`}
                    </Text>
                  ) : null}
                </Text>
              </View>
            ) : null
          ) : (
            <View style={styles.sectionRow}>
              <Text style={styles.summary}>
                <Text style={styles.summaryStrong}>{countLabel(dayList.length)}</Text>
                {dayOffset > 0 ? " agendadas" : " no dia"}
              </Text>
              <Pressable onPress={() => setDayOffset(0)} accessibilityRole="button" hitSlop={4} style={styles.backToday}>
                <Text style={styles.backTodayText}>Voltar para hoje</Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : null}
    </View>
  );

  const empty =
    tab === "today" ? (
      dayOffset === 0 ? (
        <HomeEmpty variant="today" hasTickets={Boolean(tickets?.length)} next={lists.upcoming[0]} onAgenda={() => changeTab("agenda")} />
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
      <HomeEmpty variant="done" hasTickets={Boolean(tickets?.length)} onAgenda={() => changeTab("agenda")} />
    );

  const footer =
    timeline && (lists.cancelledToday.length || lists.waiting.length) ? (
      <View style={styles.footer}>
        {lists.cancelledToday.length ? (
          <View style={styles.footerSection}>
            <SectionTitle>Canceladas pela central</SectionTitle>
            <Text style={styles.footerHint}>Não vá a estas visitas. Dúvidas, fale com a central no grupo.</Text>
            {lists.cancelledToday.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} now={now} userId={userId} variant="done" />
            ))}
          </View>
        ) : null}
        {lists.waiting.length ? (
          <View style={styles.footerSection}>
            <SectionTitle>Aguardando a central</SectionTitle>
            <Text style={styles.footerHint}>Sem nada a fazer até a central marcar uma nova visita.</Text>
            {lists.waiting.map((ticket) => (
              <View key={ticket.id} style={{ gap: 6 }}>
                <View style={styles.reason}>
                  <Icon name="hourglass" size={14} color={c.inkMuted} />
                  <Text style={styles.reasonText}>{waitingReason(ticket)}</Text>
                </View>
                <TicketCard ticket={ticket} now={now} userId={userId} />
              </View>
            ))}
          </View>
        ) : null}
      </View>
    ) : undefined;

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
          ref={listRef}
          data={data}
          keyExtractor={(item: LocalTicket) => item.id}
          itemLayoutAnimation={motion.layout}
          renderItem={renderItem}
          initialNumToRender={8}
          windowSize={9}
          ListHeaderComponent={
            <>
              {header}
              {tab === "agenda" ? (
                <View style={styles.calendar}>
                  <Calendar tickets={tickets} user={user} now={now} />
                </View>
              ) : null}
              {tab === "earnings" ? <EarningsView refreshKey={earningsKey} onSettled={settleEarnings} /> : null}
            </>
          }
          ListEmptyComponent={tab === "agenda" || tab === "earnings" ? undefined : empty}
          ListFooterComponent={footer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} tintColor={c.primary} />}
          contentContainerStyle={styles.list}
        />
      )}
      <TabBar<Tab>
        value={tab}
        onChange={changeTab}
        onReselect={reselect}
        items={[
          { value: "today", label: "Hoje", icon: "today", count: lists.today.length },
          { value: "agenda", label: "Agenda", icon: "calendar" },
          { value: "done", label: "Concluídas", icon: "checkCircle" },
          { value: "earnings", label: "Ganhos", icon: "wallet" },
        ]}
      />
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    list: { paddingBottom: 24 },
    header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4, gap: 14 },
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
    titleBlock: { gap: 6 },
    pageTitle: { fontSize: 22, fontWeight: "700", color: c.ink, letterSpacing: -0.3 },
    pageSubtitle: { fontSize: 13, color: c.inkMuted, marginTop: 2 },
    notice: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 44,
      backgroundColor: c.dangerSoft,
      borderColor: tint(c.danger, "40"),
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: RADIUS.control,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    noticeText: { color: c.danger, fontSize: 13, fontWeight: "600", flex: 1 },
    sectionRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 },
    summary: { fontSize: 14, color: c.inkMuted, fontVariant: ["tabular-nums"], flexShrink: 1 },
    summaryStrong: { fontWeight: "700", color: c.ink },
    dayNav: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: c.surface,
      borderColor: c.line,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: RADIUS.card,
      padding: 4,
    },
    dayButton: {
      width: 44,
      height: 44,
      borderRadius: RADIUS.control,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface2,
    },
    dayCenter: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 44 },
    dayTitle: { fontSize: 16, fontWeight: "700", color: c.ink, textTransform: "capitalize" },
    daySubtitle: { fontSize: 12, color: c.inkMuted, textTransform: "capitalize" },
    backToday: { marginLeft: "auto", paddingVertical: 10, paddingHorizontal: 4 },
    backTodayText: { fontSize: 14, fontWeight: "700", color: c.brandInk },
    item: { paddingHorizontal: 16 },
    cardGap: { paddingBottom: 12 },
    calendar: { paddingHorizontal: 16 },
    footer: { paddingHorizontal: 16, paddingTop: 12, gap: 20 },
    footerSection: { gap: 8 },
    footerHint: { fontSize: 13, color: c.inkMuted, lineHeight: 18, marginTop: -4 },
    reason: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
    reasonText: { fontSize: 12, fontWeight: "700", color: c.inkMuted },
  });
