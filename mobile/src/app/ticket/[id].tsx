import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../../components/Text";
import { PriorityBadge, ProjectBadge, SlaBadge, StatusBadge } from "../../components/badges";
import { ConnectionBar } from "../../components/ConnectionBar";
import { DurationCompare } from "../../components/ticket/DurationCompare";
import { FormsCard } from "../../components/ticket/FormsCard";
import { InfoPanel } from "../../components/ticket/InfoPanel";
import { PhotosPanel } from "../../components/ticket/PhotosPanel";
import { WorklogsPanel } from "../../components/ticket/WorklogsPanel";
import { TransitionModal } from "../../components/TransitionModal";
import { UnproductiveModal } from "../../components/UnproductiveModal";
import { Button, Card, EmptyState, Segmented, SectionTitle } from "../../components/ui";
import { useLiveQuery, useNow } from "../../lib/changes";
import { TRANSITION_ACTION } from "../../lib/constants";
import { getTicket, listSignatures } from "../../lib/db";
import { concludeBlock } from "../../lib/forms";
import { formatDateTime, formatRelative, formatShort } from "../../lib/format";
import { UNPRODUCTIVE_FROM } from "../../lib/ops";
import { useSession } from "../../lib/session";
import { isOnline, requestSync, useSyncStatus } from "../../lib/sync";
import type { TicketStatus } from "../../lib/types";

type Tab = "info" | "worklogs" | "photos";

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
  const loadSignatures = useCallback(() => listSignatures(String(id)), [id]);
  const pendingSignatures = useLiveQuery(loadSignatures);
  const sync = useSyncStatus();
  const online = isOnline(sync);
  // Em atendimento o relógio anda a cada 15 s para o tempo real acompanhar; fora dele, 30 s bastam para o SLA.
  const now = useNow(ticket?.work_started_at ? 15_000 : 30_000);
  const [tab, setTab] = useState<Tab>("info");
  const [target, setTarget] = useState<TicketStatus | null>(null);
  const [unproductiveOpen, setUnproductiveOpen] = useState(false);
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
  // O técnico só trabalha nas OS atribuídas a ele pelo analista (não há "assumir").
  const isMine = current.assignee?.id === user.id;
  const conclude = concludeBlock(current, (pendingSignatures ?? []).length > 0);
  // Visita improdutiva: só o responsável, com a OS atribuída, agendada, em deslocamento ou em atendimento.
  const canUnproductive = isMine && UNPRODUCTIVE_FROM.includes(current.status);

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
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} tintColor={c.primary} />}
      >
        <Card style={{ gap: 8 }}>
          <Text style={styles.title} selectable>
            {current.title}
          </Text>
          <View style={styles.badges}>
            <StatusBadge status={current.status} />
            <PriorityBadge priority={current.priority} />
            <SlaBadge ticket={current} now={now} />
            <ProjectBadge project={current.project} />
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
          {(current.unproductive_count ?? 0) > 0 ? (
            <Text style={styles.unproductive}>
              {current.unproductive_count === 1 ? "1 visita improdutiva" : `${current.unproductive_count} visitas improdutivas`}
              {current.last_unproductive_at ? ` · última em ${formatDateTime(current.last_unproductive_at)}` : ""}
              {!current.scheduled_start && current.status === "assigned" ? " · aguardando reagendamento pela central" : ""}
            </Text>
          ) : null}
        </Card>

        {isMine ? <FormsCard ticket={current} /> : null}

        {isMine && (actions.length > 0 || canUnproductive) ? (
          <Card style={{ gap: 10 }}>
            <SectionTitle>Ações</SectionTitle>
            {actions.map((to) => {
              // Concluir exige formulários obrigatórios e, se pedida, a assinatura (o servidor também bloqueia).
              const blocked = (to === "resolved" || to === "closed") && Boolean(conclude);
              return (
                <View key={to} style={{ gap: 6 }}>
                  <Button
                    title={TRANSITION_ACTION[to]}
                    variant={to === "cancelled" ? "danger" : to === primary ? "primary" : "secondary"}
                    onPress={() => setTarget(to)}
                    disabled={blocked}
                  />
                  {blocked ? <Text style={styles.blocked}>{conclude}</Text> : null}
                </View>
              );
            })}
            {canUnproductive ? (
              <Button title="Visita improdutiva" variant="danger" onPress={() => setUnproductiveOpen(true)} />
            ) : null}
          </Card>
        ) : !isMine ? (
          <Card>
            <Text style={styles.meta}>
              Esta OS não está atribuída a você. Só o responsável definido pelo analista pode atualizá-la.
            </Text>
          </Card>
        ) : null}

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
      </ScrollView>

      {target ? <TransitionModal key={target} ticket={current} to={target} onClose={() => setTarget(null)} /> : null}
      {unproductiveOpen ? <UnproductiveModal ticket={current} onClose={() => setUnproductiveOpen(false)} /> : null}
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
    unproductive: { fontSize: 12, color: c.danger, fontWeight: "600" },
    blocked: { fontSize: 12, color: c.inkMuted, lineHeight: 17 },
});
