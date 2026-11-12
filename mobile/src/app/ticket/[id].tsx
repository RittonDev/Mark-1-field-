import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { PriorityBadge, SlaBadge, StatusBadge } from "../../components/badges";
import { ConnectionBar } from "../../components/ConnectionBar";
import { CommentsPanel } from "../../components/ticket/CommentsPanel";
import { DurationCompare } from "../../components/ticket/DurationCompare";
import { InfoPanel } from "../../components/ticket/InfoPanel";
import { PhotosPanel } from "../../components/ticket/PhotosPanel";
import { WorklogsPanel } from "../../components/ticket/WorklogsPanel";
import { TransitionModal } from "../../components/TransitionModal";
import { Button, Card, EmptyState, Segmented, SectionTitle } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";
import { useLiveQuery, useNow } from "../../lib/changes";
import { canManageTickets, isStaff, STATUS, TRANSITION_ACTION } from "../../lib/constants";
import { getTicket } from "../../lib/db";
import { formatRelative, formatShort } from "../../lib/format";
import { useSession } from "../../lib/session";
import { isOnline, requestSync, storeServerTicket, useSyncStatus } from "../../lib/sync";
import { showToast } from "../../lib/toast";
import type { TicketDetail, TicketStatus } from "../../lib/types";

type Tab = "info" | "comments" | "worklogs" | "photos";

/** Ordem dos botões: o próximo passo do atendimento em campo vem primeiro. */
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

export default function TicketScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const load = useCallback(() => getTicket(String(id)), [id]);
  const ticket = useLiveQuery(load);
  const sync = useSyncStatus();
  const online = isOnline(sync);
  // Em atendimento o relógio anda a cada 15 s para o tempo real acompanhar; fora dele, 30 s bastam para o SLA.
  const now = useNow(ticket?.work_started_at ? 15_000 : 30_000);
  const [tab, setTab] = useState<Tab>("info");
  const [target, setTarget] = useState<TicketStatus | null>(null);
  const [taking, setTaking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  if (!user) return null;
  if (ticket === undefined) return <ActivityIndicator style={{ marginTop: 40 }} color={c.primary} />;
  if (ticket === null) {
    return (
      <View style={{ flex: 1 }}>
        <ConnectionBar />
        <EmptyState
          title="OS não está neste aparelho"
          description="Ela pode ter sido reatribuída a outro técnico ou ainda não foi sincronizada."
        />
      </View>
    );
  }

  const current = ticket;
  const actions = [...current.allowed_transitions].sort((a, b) => ACTION_ORDER.indexOf(a) - ACTION_ORDER.indexOf(b));
  const primary = actions.find((s) => PRIMARY.includes(s));
  // Espelho de tickets.py::can_take: quem gerencia OS pode tomar de outro responsável; o técnico só pega sem responsável.
  const canTake =
    isStaff(user.role) &&
    current.assignee?.id !== user.id &&
    (canManageTickets(user.role) || !current.assignee) &&
    (STATUS[current.status].group === "open" ||
      STATUS[current.status].group === "active" ||
      STATUS[current.status].group === "pending");

  async function take() {
    setTaking(true);
    try {
      const updated = await api.post<TicketDetail>(`/tickets/${current.id}/take`);
      await storeServerTicket(updated);
      showToast(`${updated.code} agora é sua`, { tone: "success" });
    } catch (error) {
      showToast("Não foi possível assumir a OS", { description: errorMessage(error), tone: "error" });
    } finally {
      setTaking(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    await requestSync();
    setRefreshing(false);
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 100 : 0}
    >
      <Stack.Screen options={{ title: current.code }} />
      <ConnectionBar />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} />}
      >
        <Card style={{ gap: 8 }}>
          <Text style={styles.title} selectable>
            {current.title}
          </Text>
          <View style={styles.badges}>
            <StatusBadge status={current.status} />
            <PriorityBadge priority={current.priority} />
            <SlaBadge ticket={current} now={now} />
          </View>
          {current.scheduled_start ? <Text style={styles.meta}>Visita: {formatShort(current.scheduled_start)}</Text> : null}
          {current.work_started_at ? <DurationCompare ticket={current} now={now} /> : null}
          {current.violation_reason_pending ? (
            <Text style={styles.violationPending} accessibilityRole="text">
              Pendente de justificativa de SLA
            </Text>
          ) : null}
          {current.resolution_due_at && !current.resolved_at && !current.sla_paused_at ? (
            <Text style={styles.meta}>Prazo de solução {formatRelative(current.resolution_due_at, now)}</Text>
          ) : null}
          {current.pending_ops > 0 ? (
            <Text style={styles.pending}>
              {current.pending_ops === 1 ? "1 ação aguardando envio" : `${current.pending_ops} ações aguardando envio`}
              {online ? "" : " (sem conexão)"}
            </Text>
          ) : null}
        </Card>

        {actions.length > 0 || canTake ? (
          <Card style={{ gap: 10 }}>
            <SectionTitle>Ações</SectionTitle>
            {canTake ? (
              <Button
                title={online ? "Assumir esta OS" : "Assumir esta OS (precisa de conexão)"}
                variant="primary"
                onPress={take}
                loading={taking}
                disabled={!online}
              />
            ) : null}
            {actions.map((to) => (
              <Button
                key={to}
                title={TRANSITION_ACTION[to]}
                variant={to === "cancelled" ? "danger" : to === primary && !canTake ? "primary" : "secondary"}
                onPress={() => setTarget(to)}
              />
            ))}
          </Card>
        ) : null}

        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "info", label: "Detalhes" },
            { value: "comments", label: "Acomp." },
            { value: "worklogs", label: "Horas" },
            { value: "photos", label: "Fotos" },
          ]}
        />

        {tab === "info" ? <InfoPanel ticket={current} now={now} /> : null}
        {tab === "comments" ? <CommentsPanel ticket={current} user={user} /> : null}
        {tab === "worklogs" ? <WorklogsPanel ticket={current} user={user} /> : null}
        {tab === "photos" ? <PhotosPanel ticket={current} /> : null}
      </ScrollView>

      {target ? <TransitionModal key={target} ticket={current} to={target} onClose={() => setTarget(null)} /> : null}
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  title: { fontSize: 19, fontWeight: "700", color: c.ink },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  meta: { fontSize: 13, color: c.inkMuted },
  pending: { fontSize: 13, fontWeight: "600", color: c.warning },
  violationPending: { fontSize: 12, color: c.inkMuted, fontStyle: "italic" },
});
