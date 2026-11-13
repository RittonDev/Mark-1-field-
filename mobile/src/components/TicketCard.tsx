import { router } from "expo-router";
import { memo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { STATUS } from "../lib/constants";
import { addressOf } from "../lib/device-actions";
import { actualMinutes } from "../lib/duration";
import { arrivalUrgency } from "../lib/field";
import { finishedAt, isDone, isHelper } from "../lib/lists";
import { formatDate, formatMinutes, formatShort, formatTime, isSameDay, startOfDay } from "../lib/format";
import { haptic } from "../lib/haptics";
import type { LocalTicket } from "../lib/syncTypes";
import { RADIUS, statusFill, useStyles, useTheme, type Palette } from "../theme/theme";
import { StatusBadge } from "./badges";
import { Icon } from "./Icon";
import { PressableScale, useSwapMotion } from "./motion";
import { Text } from "./Text";
import { FieldClockLine } from "./ticket/FieldClock";
import { hasRoute, RouteSheet } from "./ticket/QuickActions";
import { HelperBadge } from "./ticket/VisitInfo";

const IN_FIELD = ["en_route", "in_progress"];
/** Dois toques rápidos não empilham a mesma OS duas vezes. */
const DOUBLE_TAP_MS = 600;

type Variant = "default" | "done";

export interface TicketCardProps {
  ticket: LocalTicket;
  now: number;
  /** Técnico logado (selo "Você vai junto"); vem da tela, para cada cartão não assinar a sessão. */
  userId?: string;
  showDate?: boolean;
  showTime?: boolean;
  /** "done": mostra quando foi concluída/cancelada e o tempo de atendimento, no lugar da agenda. */
  variant?: Variant;
  /** Botão de rota (Maps/Waze) no cartão: OS em deslocamento ou a próxima visita do dia. */
  showRoute?: boolean;
}

/** Texto do canto do cartão: horário da visita (ou fim dela, na linha do tempo) e o tempo em atendimento. */
function scheduleText(ticket: LocalTicket, now: number, showTime: boolean, showDate: boolean): string {
  const start = ticket.scheduled_start;
  const end = ticket.scheduled_end;
  const parts: string[] = [];
  if (showTime && start) {
    const range = end && isSameDay(end, start) ? `–${formatTime(end)}` : "";
    parts.push(`${showDate ? formatShort(start) : formatTime(start)}${range}`);
  } else if (!showTime && end && isSameDay(end, new Date(now)) && !ticket.work_started_at) {
    // Na linha do tempo o início já está no trilho: aqui só o fim, se for hoje.
    parts.push(`até ${formatTime(end)}`);
  }
  if (ticket.work_started_at) parts.push(`em atendimento ${formatMinutes(actualMinutes(ticket, now))}`);
  return parts.join(" · ");
}

function doneText(ticket: LocalTicket): string {
  const at = finishedAt(ticket);
  const label = ticket.status === "cancelled" ? "Cancelada" : "Concluída";
  return `${label} ${formatShort(at)}`;
}

/** Cartão da OS: loja, endereço, cliente e tipo de serviço, relógio de campo e selo de status. */
function TicketCardBase({ ticket, now, userId, showDate = false, showTime = true, variant = "default", showRoute = false }: TicketCardProps) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const swap = useSwapMotion();
  const lastPress = useRef(0);
  const [routeOpen, setRouteOpen] = useState(false);
  const status = STATUS[ticket.status];
  const helping = Boolean(userId && isHelper(ticket, { id: userId }));
  const site = ticket.location ? [ticket.location.code, ticket.location.name].filter(Boolean).join(" · ") : null;
  const address = ticket.service_address?.trim() || addressOf(ticket.location);
  const meta = [ticket.customer?.name, ticket.service_type?.name].filter(Boolean).join(" · ");
  const route = showRoute && hasRoute(ticket);
  const done = variant === "done";
  const corner = done ? doneText(ticket) : scheduleText(ticket, now, showTime, showDate);
  const workMinutes = done && ticket.work_seconds > 0 ? Math.round(ticket.work_seconds / 60) : 0;
  const urgency = done ? 2 : arrivalUrgency(ticket, now);
  const pending = ticket.pending_ops
    ? ticket.pending_ops === 1
      ? "1 ação aguardando envio"
      : `${ticket.pending_ops} ações aguardando envio`
    : null;
  const label = [
    corner,
    ticket.code,
    ticket.title,
    site,
    address,
    status?.label ?? ticket.status,
    urgency === 0 ? "chegada atrasada" : urgency === 1 ? "chegada em risco" : null,
    helping ? "você vai junto" : null,
    pending,
  ]
    .filter(Boolean)
    .join(", ");

  function open() {
    const at = Date.now();
    if (at - lastPress.current < DOUBLE_TAP_MS) return;
    lastPress.current = at;
    router.push({ pathname: "/ticket/[id]", params: { id: ticket.id } });
  }

  return (
    <>
      <PressableScale
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Abre a OS"
        style={styles.card}
        pressedStyle={{ backgroundColor: c.surface2 }}
      >
        <View style={[styles.accent, { backgroundColor: statusFill(status?.color ?? c.primary, c) }]} />
        <View style={styles.body}>
          <View style={styles.header}>
            <Text style={[styles.code, { flexShrink: 1 }]} numberOfLines={1}>
              {ticket.code}
            </Text>
            {corner ? (
              <Text style={styles.schedule} numberOfLines={1}>
                {corner}
              </Text>
            ) : null}
          </View>
          <Text style={styles.title} numberOfLines={2}>
            {ticket.title}
          </Text>
          <View style={styles.placeRow}>
            <View style={styles.place}>
              {site ? (
                <View style={styles.line}>
                  <Icon name="building" size={15} color={c.inkMuted} />
                  <Text style={styles.site} numberOfLines={1}>
                    {site}
                  </Text>
                </View>
              ) : null}
              {address ? (
                <View style={styles.lineTop}>
                  <Icon name="pin" size={15} color={c.inkMuted} />
                  <Text style={styles.address} numberOfLines={2}>
                    {address}
                  </Text>
                </View>
              ) : null}
              {meta ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {meta}
                </Text>
              ) : null}
            </View>
            {route ? (
              <Pressable
                onPress={() => {
                  haptic.select();
                  setRouteOpen(true);
                }}
                accessibilityRole="button"
                accessibilityLabel="Rota até a loja"
                accessibilityHint="Abre o Google Maps ou o Waze"
                hitSlop={4}
                style={({ pressed }) => [styles.routeButton, pressed && { backgroundColor: c.surface3 }]}
              >
                <Icon name="navigate" size={20} color={c.brandInk} strokeWidth={2} />
              </Pressable>
            ) : null}
          </View>
          {ticket.visit_note?.trim() && !done ? (
            <View style={styles.line}>
              <Icon name="note" size={14} color={c.inkMuted} />
              <Text style={styles.note} numberOfLines={1}>
                <Text style={styles.noteLabel}>Recado da central: </Text>
                {ticket.visit_note.trim()}
              </Text>
            </View>
          ) : null}
          {done ? (
            workMinutes > 0 ? (
              <View style={styles.line}>
                <Icon name="clock" size={14} color={c.inkMuted} />
                <Text style={styles.lineText}>Atendimento: {formatMinutes(workMinutes)}</Text>
              </View>
            ) : null
          ) : (
            <FieldClockLine ticket={ticket} now={now} />
          )}
          <View style={styles.badges}>
            <Animated.View key={ticket.status} entering={swap.entering} exiting={swap.exiting}>
              <StatusBadge status={ticket.status} />
            </Animated.View>
            {helping ? <HelperBadge /> : null}
          </View>
          {/* Aguardando envio é o normal sem sinal (fica salvo no aparelho): informação, sem cor de alerta. */}
          {pending ? (
            <View style={styles.line}>
              <Icon name="repeat" size={14} color={c.inkMuted} />
              <Text style={styles.pending}>{pending}</Text>
            </View>
          ) : null}
        </View>
      </PressableScale>
      {route ? <RouteSheet ticket={ticket} visible={routeOpen} onClose={() => setRouteOpen(false)} /> : null}
    </>
  );
}

// Campos que o cartão mostra: as OS chegam do banco local como objetos novos a cada leitura, então o
// cartão só redesenha quando um deles muda (ou o relógio anda).
const CARD_FIELDS = [
  "id",
  "updated_at",
  "status",
  "pending_ops",
  "title",
  "scheduled_start",
  "scheduled_end",
  "work_started_at",
  "work_seconds",
  "arrived_at",
  "arrival_due_at",
  "onsite_due_at",
  "arrival_status",
  "onsite_status",
  "resolved_at",
  "closed_at",
  "cancelled_at",
  "service_address",
  "visit_note",
] as const satisfies readonly (keyof LocalTicket)[];

const helperIds = (t: LocalTicket) => (t.helpers ?? []).map((h) => h.id).join(",");

function sameTicket(a: LocalTicket, b: LocalTicket) {
  if (a === b) return true;
  return (
    CARD_FIELDS.every((key) => a[key] === b[key]) &&
    a.location?.id === b.location?.id &&
    a.customer?.id === b.customer?.id &&
    a.service_type?.id === b.service_type?.id &&
    a.assignee?.id === b.assignee?.id &&
    helperIds(a) === helperIds(b)
  );
}

function sameCard(a: TicketCardProps, b: TicketCardProps) {
  return (
    a.now === b.now &&
    a.userId === b.userId &&
    a.showDate === b.showDate &&
    a.showTime === b.showTime &&
    a.variant === b.variant &&
    a.showRoute === b.showRoute &&
    sameTicket(a.ticket, b.ticket)
  );
}

export const TicketCard = memo(TicketCardBase, sameCard);

/** Linha do tempo de Hoje: horário à esquerda (com a data, se não for hoje), trilho com ponto e o cartão. */
function TimelineRowBase({
  ticket,
  now,
  last,
  userId,
  showRoute = false,
}: {
  ticket: LocalTicket;
  now: number;
  last: boolean;
  userId?: string;
  showRoute?: boolean;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const inField = IN_FIELD.includes(ticket.status);
  const start = ticket.scheduled_start;
  const otherDay = start && !isSameDay(start, new Date(now)) ? start : null;
  // Visita de um dia que já passou e a OS segue aberta (e ainda não foi a campo).
  const overdue = Boolean(otherDay && new Date(otherDay).getTime() < startOfDay(new Date(now)).getTime() && !inField && !isDone(ticket.status));
  // O ponto só ganha cor de alerta com chegada atrasada (vermelho) ou em risco (âmbar); em campo, a marca.
  const urgency = arrivalUrgency(ticket, now);
  const dot = urgency === 0 ? c.danger : urgency === 1 ? c.warning : start || inField ? c.primary : c.lineStrong;
  const filled = inField || urgency < 2;
  return (
    <View style={styles.timelineRow}>
      <View style={styles.rail}>
        {otherDay ? (
          <Text style={styles.railDate} maxFontSizeMultiplier={1.3}>
            {formatDate(otherDay)}
          </Text>
        ) : null}
        <Text style={[styles.railTime, !start && styles.railNoTime, otherDay ? styles.railTimeSmall : null]} maxFontSizeMultiplier={1.3}>
          {start ? formatTime(start) : "Sem hora"}
        </Text>
        {overdue ? (
          <Text style={styles.railLate} maxFontSizeMultiplier={1.3}>
            Atrasada
          </Text>
        ) : null}
        <View style={[styles.railDot, { borderColor: dot, backgroundColor: filled ? dot : c.canvas }]} />
        {last ? null : <View style={styles.railLine} />}
      </View>
      <View style={styles.timelineCard}>
        <TicketCard ticket={ticket} now={now} userId={userId} showTime={false} showRoute={showRoute} />
      </View>
    </View>
  );
}

export const TimelineRow = memo(
  TimelineRowBase,
  (a, b) => a.now === b.now && a.last === b.last && a.userId === b.userId && a.showRoute === b.showRoute && sameTicket(a.ticket, b.ticket),
);

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      flexDirection: "row",
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      overflow: "hidden",
      boxShadow: c.elevation,
    },
    accent: { width: 3 },
    body: { flex: 1, padding: 16, paddingLeft: 14, gap: 6 },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    code: { fontSize: 12, fontWeight: "700", color: c.inkMuted, fontVariant: ["tabular-nums"], letterSpacing: 0.3 },
    schedule: { fontSize: 14, fontWeight: "700", color: c.ink, flexShrink: 1, fontVariant: ["tabular-nums"] },
    title: { fontSize: 16, fontWeight: "600", color: c.ink, lineHeight: 22 },
    placeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    place: { flex: 1, gap: 4 },
    line: { flexDirection: "row", alignItems: "center", gap: 6 },
    lineTop: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
    site: { fontSize: 14, fontWeight: "600", color: c.ink, flex: 1 },
    address: { fontSize: 14, color: c.inkMuted, flex: 1, lineHeight: 19, marginTop: -2 },
    // Alinhado ao texto das linhas com ícone (15 do ícone + 6 de espaço).
    meta: { fontSize: 13, color: c.inkMuted, paddingLeft: 21 },
    lineText: { fontSize: 13, color: c.inkMuted, flex: 1 },
    routeButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.primarySoft,
    },
    note: { fontSize: 12, color: c.inkMuted, flex: 1 },
    noteLabel: { fontWeight: "700", color: c.inkMuted },
    badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
    pending: { fontSize: 12, fontWeight: "600", color: c.inkMuted, flex: 1 },
    timelineRow: { flexDirection: "row", gap: 10 },
    rail: { minWidth: 56, alignItems: "center", paddingTop: 16 },
    railDate: { fontSize: 11, fontWeight: "700", color: c.inkMuted, fontVariant: ["tabular-nums"] },
    railTime: { fontSize: 14, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    railTimeSmall: { fontSize: 12 },
    railNoTime: { fontSize: 11, fontWeight: "600", color: c.inkMuted },
    railLate: { fontSize: 11, fontWeight: "700", color: c.danger, marginTop: 2 },
    railDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, marginTop: 8 },
    railLine: { flex: 1, width: 2, backgroundColor: c.line, marginTop: 4, marginBottom: -12, borderRadius: 1 },
    timelineCard: { flex: 1, paddingBottom: 12 },
  });
