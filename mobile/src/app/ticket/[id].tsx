import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionSheet, type SheetAction } from "../../components/ActionSheet";
import { PriorityBadge, ProjectBadge, SlaBadge, StatusBadge } from "../../components/badges";
import { ConnectionBar } from "../../components/ConnectionBar";
import { FieldStepper } from "../../components/FieldStepper";
import { Icon, type IconName } from "../../components/Icon";
import { PressableScale, useSwapMotion } from "../../components/motion";
import { DetailSkeleton } from "../../components/Skeleton";
import { Text } from "../../components/Text";
import { DurationCompare } from "../../components/ticket/DurationCompare";
import { ArrivalResult, AuthorizationNotice, FieldClockLine, OnsiteTimer } from "../../components/ticket/FieldClock";
import { FormsCard } from "../../components/ticket/FormsCard";
import { PartRequestSheet, PartRequestsCard } from "../../components/ticket/PartRequests";
import { QuickActions, RecurrenceCard } from "../../components/ticket/QuickActions";
import { ReportShareCard } from "../../components/ticket/ReportShareCard";
import { HelperBadge, VisitNoteCard, VisitTeamCard } from "../../components/ticket/VisitInfo";
import { InfoPanel } from "../../components/ticket/InfoPanel";
import { PhotosPanel } from "../../components/ticket/PhotosPanel";
import { WorklogsPanel } from "../../components/ticket/WorklogsPanel";
import { TransitionModal } from "../../components/TransitionModal";
import { Button, Card, EmptyState, Segmented } from "../../components/ui";
import { UnproductiveModal } from "../../components/UnproductiveModal";
import { useLiveQuery, useNow } from "../../lib/changes";
import { TRANSITION_ACTION } from "../../lib/constants";
import { getTicket, listSignatures } from "../../lib/db";
import { addressOf } from "../../lib/device-actions";
import { authorizationBlock } from "../../lib/field";
import { concludeBlock } from "../../lib/forms";
import { formatDateTime, formatRelative, formatShort } from "../../lib/format";
import { haptic } from "../../lib/haptics";
import { isDone, isHelper } from "../../lib/lists";
import { UNPRODUCTIVE_FROM } from "../../lib/ops";
import { useSession } from "../../lib/session";
import { isOnline, requestSync, useSyncStatus } from "../../lib/sync";
import type { TicketStatus } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";

type Tab = "info" | "worklogs" | "photos";

/** Ordem das ações: o próximo passo do atendimento em campo vem primeiro. */
const ACTION_ORDER: TicketStatus[] = [
  "en_route",
  "in_progress",
  "resolved",
  "scheduled",
  "assigned",
  "on_hold_customer",
  "on_hold_vendor",
  "reopened",
  "triage",
  "closed",
  "new",
  "cancelled",
];
const PRIMARY: TicketStatus[] = ["en_route", "in_progress", "resolved"];
const STEP_ICON: Partial<Record<TicketStatus, IconName>> = {
  en_route: "navigate",
  in_progress: "pin",
  resolved: "checkCircle",
  scheduled: "calendar",
  closed: "checkCircle",
};

export default function TicketScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const swap = useSwapMotion();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const load = useCallback(() => getTicket(String(id)), [id]);
  const ticket = useLiveQuery(load);
  const loadSignatures = useCallback(() => listSignatures(String(id)), [id]);
  const pendingSignatures = useLiveQuery(loadSignatures);
  const sync = useSyncStatus();
  const online = isOnline(sync);
  // Em atendimento o relógio anda a cada 15 s para o tempo real acompanhar; fora dele, 30 s bastam para o SLA.
  const now = useNow(ticket?.work_started_at ? 15_000 : 30_000);
  const [tab, setTab] = useState<Tab>("info");
  const [target, setTarget] = useState<TicketStatus | null>(null);
  const [unproductiveOpen, setUnproductiveOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [partOpen, setPartOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  if (!user) return null;
  if (ticket === undefined) return <DetailSkeleton />;
  if (ticket === null) {
    return (
      <View style={{ flex: 1 }}>
        <ConnectionBar />
        <EmptyState
          icon="alert"
          title="OS não está neste aparelho"
          description="Ela pode ter sido reatribuída a outro técnico ou ainda não foi sincronizada."
        />
      </View>
    );
  }

  const current = ticket;
  const actions = [...current.allowed_transitions].sort((a, b) => ACTION_ORDER.indexOf(a) - ACTION_ORDER.indexOf(b));
  const primary = actions.find((s) => PRIMARY.includes(s));
  // O técnico só trabalha nas OS atribuídas a ele pelo analista (não há "assumir").
  const isMine = current.assignee?.id === user.id;
  // Auxiliar da visita: vê a OS, aponta horas e manda fotos; status, formulários e assinatura são do responsável.
  const helping = isHelper(current, user);
  const clientRef = current.client_reference?.trim() || null;
  const conclude = concludeBlock(current, (pendingSignatures ?? []).length > 0);
  // Concluir espera formulários/assinatura; deslocamento e check-in esperam a autorização do cliente.
  const blockedFor = (to: TicketStatus) =>
    ((to === "resolved" || to === "closed") && conclude ? conclude : null) ?? authorizationBlock(current, to);
  const canRequestPart = isMine && !isDone(current.status) && current.status !== "cancelled";
  // Visita improdutiva: só o responsável, com a OS atribuída, agendada, em deslocamento ou em atendimento.
  const canUnproductive = isMine && UNPRODUCTIVE_FROM.includes(current.status);
  const others = actions.filter((to) => to !== primary);
  const showBar = isMine && (actions.length > 0 || canUnproductive || canRequestPart);
  const primaryBlocked = primary ? blockedFor(primary) : null;
  const site = current.location ? [current.location.code, current.location.name].filter(Boolean).join(" · ") : null;
  const client = [current.customer?.name, site].filter(Boolean).join(" · ");
  const address = current.service_address?.trim() || addressOf(current.location);
  const enter = (i: number) => (reduced ? undefined : FadeInDown.delay(i * 40).duration(260));

  async function refresh() {
    setRefreshing(true);
    await requestSync();
    setRefreshing(false);
  }

  function open(to: TicketStatus) {
    if (blockedFor(to)) {
      haptic.warning();
      return;
    }
    setTarget(to);
  }

  const sheetActions: SheetAction[] = [
    ...others.map((to) => ({
      key: to,
      label: TRANSITION_ACTION[to],
      icon: STEP_ICON[to] ?? ("chevronRight" as IconName),
      tone: to === "cancelled" ? ("danger" as const) : ("default" as const),
      disabledReason: blockedFor(to),
      right: <StatusBadge status={to} />,
      onPress: () => open(to),
    })),
    ...(canRequestPart
      ? [{ key: "part", label: "Pedir peça", icon: "package" as IconName, tone: "default" as const, onPress: () => setPartOpen(true) }]
      : []),
    ...(canUnproductive
      ? [
          {
            key: "unproductive",
            label: "Visita improdutiva",
            icon: "alert" as IconName,
            tone: "danger" as const,
            onPress: () => setUnproductiveOpen(true),
          },
        ]
      : []),
  ];

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: current.code }} />
      <ConnectionBar />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 100 : 0}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: showBar ? 120 + insets.bottom : 40 }]}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} tintColor={c.primary} />}
        >
          <Animated.View entering={enter(0)}>
            <Card style={{ gap: 12 }}>
              <View style={styles.topRow}>
                <Text style={[styles.code, { flexShrink: 1 }]} numberOfLines={1}>
                  {current.code}
                  {clientRef ? <Text style={styles.clientRef}> · Ref. cliente {clientRef}</Text> : null}
                </Text>
                <Animated.View key={current.status} entering={swap.entering} exiting={swap.exiting}>
                  <StatusBadge status={current.status} />
                </Animated.View>
              </View>
              <Text style={styles.title} selectable>
                {current.title}
              </Text>
              {client || address || current.scheduled_start ? (
                <View style={{ gap: 6 }}>
                  {client ? (
                    <View style={styles.line}>
                      <Icon name="building" size={16} color={c.inkSubtle} />
                      <Text style={styles.lineStrong} numberOfLines={2}>
                        {client}
                      </Text>
                    </View>
                  ) : null}
                  {address ? (
                    <View style={styles.line}>
                      <Icon name="pin" size={16} color={c.inkSubtle} />
                      <Text style={styles.lineText} numberOfLines={2}>
                        {address}
                      </Text>
                    </View>
                  ) : null}
                  {current.scheduled_start ? (
                    <View style={styles.line}>
                      <Icon name="clock" size={16} color={c.inkSubtle} />
                      <Text style={[styles.lineText, styles.tabular]}>Visita {formatShort(current.scheduled_start)}</Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
              <QuickActions ticket={current} />
              <View style={styles.badges}>
                {helping ? <HelperBadge /> : null}
                <PriorityBadge priority={current.priority} />
                <SlaBadge ticket={current} now={now} />
                <ProjectBadge project={current.project} />
              </View>
              {/* Promessa de campo: autorização do cliente, prazo de chegada e resultado do check-in. */}
              <AuthorizationNotice ticket={current} />
              {current.arrived_at ? <ArrivalResult ticket={current} /> : <FieldClockLine ticket={current} now={now} size={14} />}
              <View style={styles.divider} />
              <FieldStepper ticket={current} />
              <OnsiteTimer ticket={current} now={now} />
              {current.work_started_at ? <DurationCompare ticket={current} now={now} /> : null}
              {current.resolution_due_at && !current.resolved_at && !current.sla_paused_at ? (
                <Text style={[styles.meta, styles.tabular]}>Prazo de solução {formatRelative(current.resolution_due_at, now)}</Text>
              ) : null}
              {current.violation_reason_pending ? (
                <Text style={styles.violationPending}>Pendente de justificativa de SLA</Text>
              ) : null}
              {current.pending_ops > 0 ? (
                <Text style={styles.pending}>
                  {current.pending_ops === 1 ? "1 ação aguardando envio" : `${current.pending_ops} ações aguardando envio`}
                  {online ? "" : " (sem conexão)"}
                </Text>
              ) : null}
              {(current.unproductive_count ?? 0) > 0 ? (
                <Text style={styles.unproductive}>
                  {current.unproductive_count === 1 ? "1 visita improdutiva" : `${current.unproductive_count} visitas improdutivas`}
                  {current.last_unproductive_at ? ` · última em ${formatDateTime(current.last_unproductive_at)}` : ""}
                  {!current.scheduled_start && current.status === "assigned" ? " · aguardando reagendamento pela central" : ""}
                </Text>
              ) : null}
            </Card>
          </Animated.View>

          {/* Concluída: o próximo passo é mandar o relatório ao cliente. */}
          {isMine && (current.status === "resolved" || current.status === "closed") ? (
            <Animated.View entering={enter(1)}>
              <ReportShareCard ticket={current} />
            </Animated.View>
          ) : null}

          {/* Recado do analista para o técnico: antes de tudo o que vem depois do cabeçalho. */}
          <VisitNoteCard note={current.visit_note} />
          <VisitTeamCard ticket={current} userId={user.id} />
          <RecurrenceCard ticket={current} />

          {isMine ? (
            <Animated.View entering={enter(1)} style={{ gap: 12 }}>
              <FormsCard ticket={current} />
              <PartRequestsCard ticket={current} canRequest={canRequestPart} onRequest={() => setPartOpen(true)} />
            </Animated.View>
          ) : helping ? (
            <>
              <Card>
                <Text style={styles.meta}>
                  Você vai junto nesta visita. Iniciar, concluir, formulários e assinatura ficam com{" "}
                  {current.assignee?.name ?? "o responsável"}. Aqui você aponta suas horas e manda fotos.
                </Text>
              </Card>
              <PartRequestsCard ticket={current} canRequest={false} onRequest={() => undefined} />
            </>
          ) : (
            <Card>
              <Text style={styles.meta}>Esta OS não está atribuída a você. Só o responsável definido pelo analista pode atualizá-la.</Text>
            </Card>
          )}

          <Animated.View entering={enter(2)} style={{ gap: 12 }}>
            <Segmented<Tab>
              value={tab}
              onChange={setTab}
              options={[
                { value: "info", label: "Detalhes" },
                { value: "worklogs", label: "Horas" },
                { value: "photos", label: "Fotos" },
              ]}
            />
            {tab === "info" ? <InfoPanel ticket={current} now={now} /> : null}
            {tab === "worklogs" ? <WorklogsPanel ticket={current} user={user} /> : null}
            {tab === "photos" ? <PhotosPanel ticket={current} /> : null}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      {showBar ? (
        <View style={[styles.bar, { paddingBottom: insets.bottom + 12 }]}>
          {primaryBlocked ? (
            <View style={styles.blocked}>
              <Icon name="lock" size={14} color={c.inkMuted} />
              <Text style={styles.blockedText}>{primaryBlocked}</Text>
            </View>
          ) : null}
          <View style={styles.barRow}>
            {sheetActions.length > 0 ? (
              <PressableScale
                onPress={() => setSheetOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Mais ações"
                style={styles.more}
                pressedStyle={{ backgroundColor: c.surface2 }}
              >
                <Icon name="more" size={22} color={c.ink} strokeWidth={2.4} />
              </PressableScale>
            ) : null}
            {primary ? (
              <Button
                title={TRANSITION_ACTION[primary]}
                icon={STEP_ICON[primary]}
                variant="primary"
                onPress={() => open(primary)}
                disabled={Boolean(primaryBlocked)}
                style={{ flex: 1 }}
              />
            ) : (
              <Button title="Ações da OS" onPress={() => setSheetOpen(true)} style={{ flex: 1 }} />
            )}
          </View>
        </View>
      ) : null}

      {sheetOpen ? <ActionSheet title={`Ações · ${current.code}`} actions={sheetActions} onClose={() => setSheetOpen(false)} /> : null}
      {target ? <TransitionModal key={target} ticket={current} to={target} onClose={() => setTarget(null)} /> : null}
      {unproductiveOpen ? <UnproductiveModal ticket={current} onClose={() => setUnproductiveOpen(false)} /> : null}
      {partOpen ? <PartRequestSheet ticket={current} onClose={() => setPartOpen(false)} /> : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 12 },
    topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    code: { fontSize: 13, fontWeight: "700", color: c.inkMuted, fontVariant: ["tabular-nums"], letterSpacing: 0.3 },
    clientRef: { fontSize: 12, fontWeight: "500", color: c.inkSubtle, letterSpacing: 0 },
    title: { fontSize: 20, fontWeight: "700", color: c.ink, lineHeight: 26, letterSpacing: -0.2 },
    line: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    lineStrong: { fontSize: 14, fontWeight: "600", color: c.ink, flex: 1, lineHeight: 20 },
    lineText: { fontSize: 14, color: c.inkMuted, flex: 1, lineHeight: 20 },
    tabular: { fontVariant: ["tabular-nums"] },
    badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.line, marginVertical: 4 },
    meta: { fontSize: 13, color: c.inkMuted },
    pending: { fontSize: 13, fontWeight: "600", color: c.warning },
    violationPending: { fontSize: 12, color: c.inkMuted, fontStyle: "italic" },
    unproductive: { fontSize: 12, color: c.danger, fontWeight: "600" },
    bar: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: 16,
      paddingTop: 12,
      gap: 8,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
      boxShadow: c.scheme === "dark" ? undefined : "0px -1px 3px rgba(0, 0, 0, 0.04)",
    },
    barRow: { flexDirection: "row", gap: 8 },
    more: {
      width: 48,
      height: 48,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    blocked: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
    blockedText: { fontSize: 12, color: c.inkMuted, lineHeight: 17, flex: 1 },
  });
