// Agenda do técnico: visão de mês (grade com marcadores) e de semana (dia a dia).
// Mostra as visitas agendadas (scheduled_start/scheduled_end) e, no dia de hoje, o mesmo trabalho da
// aba Hoje (em campo, sem agenda, atrasadas). Tocar no dia lista as OS; tocar na OS abre o detalhe.

import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { STATUS } from "../lib/constants";
import { addDays, formatTime, startOfDay } from "../lib/format";
import { isDone, LOCAL_HISTORY_DAYS, ticketsByDay } from "../lib/lists";
import type { LocalTicket } from "../lib/syncTypes";
import type { User } from "../lib/types";
import { RADIUS, statusFill, useStyles, useTheme, type Palette } from "../theme/theme";
import { StatusBadge } from "./badges";
import { Icon } from "./Icon";
import { TicketCard } from "./TicketCard";
import { Button, Card, EmptyState, InfoBox, Segmented } from "./ui";

type Mode = "month" | "week";

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const monthFmt = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
const dayLongFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
const dayShortFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });

const sameDay = (a: Date, b: Date) => startOfDay(a).getTime() === startOfDay(b).getTime();
const sameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
const startOfWeek = (d: Date) => addDays(startOfDay(d), -startOfDay(d).getDay());
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const countLabel = (n: number) => (n === 0 ? "nenhuma OS" : n === 1 ? "1 OS" : `${n} OS`);

function monthGrid(anchor: Date): Date[] {
  const start = startOfWeek(startOfMonth(anchor));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Aviso para dias que o aparelho não guarda mais (as encerradas saem depois de 30 dias). */
function HistoryNote() {
  return <InfoBox icon="clock" message={`O aparelho guarda só os últimos ${LOCAL_HISTORY_DAYS} dias. O histórico completo fica com a central.`} />;
}

export function Calendar({ tickets, user, now }: { tickets: LocalTicket[]; user: User; now: number }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  // O relógio anda a cada 30 s, mas a agenda só muda quando vira o dia.
  const dayKey = startOfDay(new Date(now)).getTime();
  const today = useMemo(() => new Date(dayKey), [dayKey]);
  const historyStart = useMemo(() => addDays(new Date(dayKey), -LOCAL_HISTORY_DAYS).getTime(), [dayKey]);
  const [mode, setMode] = useState<Mode>("month");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date(now)));
  const [selected, setSelected] = useState(() => startOfDay(new Date(now)));

  const days = useMemo(
    () => (mode === "month" ? monthGrid(anchor) : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i))),
    [mode, anchor],
  );
  const byDay = useMemo(() => ticketsByDay(tickets, user, days, today), [tickets, user, days, today]);

  // Mês: o dia escolhido vai junto (hoje, se for o mês atual; senão o dia 1º). Semana: anda 7 dias.
  function shift(step: number) {
    if (mode === "month") {
      const next = new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
      setAnchor(next);
      setSelected(sameMonth(next, today) ? today : next);
    } else {
      setAnchor(addDays(anchor, 7 * step));
      setSelected(addDays(selected, 7 * step));
    }
  }

  function changeMode(next: Mode) {
    setMode(next);
    // A semana (ou o mês) mostrada é a do dia escolhido.
    setAnchor(selected);
  }

  function pick(day: Date) {
    setSelected(day);
    if (!sameMonth(day, anchor)) setAnchor(startOfMonth(day));
  }

  function goToday() {
    setAnchor(today);
    setSelected(today);
  }

  const title =
    mode === "month"
      ? capitalize(monthFmt.format(anchor))
      : `${dayShortFmt.format(days[0])} – ${dayShortFmt.format(days[6])}`;
  const showingToday = mode === "month" ? sameMonth(anchor, today) && sameDay(selected, today) : days.some((d) => sameDay(d, today));

  const selectedTickets = byDay.get(startOfDay(selected).getTime()) ?? [];
  const selectedOld = selected.getTime() < historyStart;

  return (
    <View style={styles.wrap}>
      <Segmented<Mode>
        value={mode}
        onChange={changeMode}
        options={[
          { value: "month", label: "Mês" },
          { value: "week", label: "Semana" },
        ]}
      />

      <View style={styles.toolbar}>
        <Pressable
          onPress={() => shift(-1)}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={mode === "month" ? "Mês anterior" : "Semana anterior"}
          style={({ pressed }) => [styles.nav, pressed && { backgroundColor: c.surface3 }]}
        >
          <Icon name="chevronLeft" size={20} color={c.ink} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        <Pressable
          onPress={() => shift(1)}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={mode === "month" ? "Próximo mês" : "Próxima semana"}
          style={({ pressed }) => [styles.nav, pressed && { backgroundColor: c.surface3 }]}
        >
          <Icon name="chevronRight" size={20} color={c.ink} />
        </Pressable>
        <Button compact variant="ghost" title="Hoje" onPress={goToday} disabled={showingToday} />
      </View>

      {mode === "month" ? (
        <>
          <Card style={styles.card}>
            <View style={styles.weekHeader}>
              {WEEKDAYS.map((w) => (
                <Text key={w} style={styles.weekday} maxFontSizeMultiplier={1.3}>
                  {w}
                </Text>
              ))}
            </View>
            <View style={styles.grid}>
              {days.map((day) => {
                const items = byDay.get(day.getTime()) ?? [];
                const inMonth = day.getMonth() === anchor.getMonth();
                const isToday = sameDay(day, today);
                const isSelected = sameDay(day, selected);
                return (
                  <Pressable
                    key={day.getTime()}
                    onPress={() => pick(day)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={`${dayLongFmt.format(day)}${isToday ? ", hoje" : ""}, ${countLabel(items.length)}`}
                    style={styles.cell}
                  >
                    <View style={[styles.dayBubble, isToday && styles.today, isSelected && styles.selected]}>
                      <Text
                        maxFontSizeMultiplier={1.3}
                        style={[
                          styles.dayText,
                          !inMonth && styles.outside,
                          isToday && !isSelected && { color: c.brandInk, fontWeight: "700" },
                          isSelected && { color: c.onPrimary, fontWeight: "700" },
                        ]}
                      >
                        {day.getDate()}
                      </Text>
                    </View>
                    <View style={styles.dots}>
                      {items.slice(0, 3).map((t) => (
                        <View
                          key={t.id}
                          style={[
                            styles.dot,
                            { backgroundColor: isDone(t.status) ? c.inkSubtle : statusFill(STATUS[t.status]?.color ?? c.inkSubtle, c) },
                          ]}
                        />
                      ))}
                      {items.length > 3 ? (
                        <Text style={styles.more} maxFontSizeMultiplier={1.2}>
                          +
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </Card>

          <Text style={styles.dayTitle} accessibilityRole="header">
            {capitalize(dayLongFmt.format(selected))}
            {selectedTickets.length ? ` · ${countLabel(selectedTickets.length)}` : ""}
          </Text>
          {selectedOld ? <HistoryNote /> : null}
          {selectedTickets.length === 0 ? (
            selectedOld ? null : (
              <EmptyState title="Nenhuma OS neste dia" />
            )
          ) : (
            selectedTickets.map((t) => (
              <TicketCard key={t.id} ticket={t} now={now} userId={user.id} variant={isDone(t.status) ? "done" : "default"} />
            ))
          )}
        </>
      ) : (
        <>
          {days[0].getTime() < historyStart ? <HistoryNote /> : null}
          {days.map((day) => {
            const items = byDay.get(day.getTime()) ?? [];
            const isToday = sameDay(day, today);
            return (
              <Card key={day.getTime()} style={styles.card}>
                <View style={styles.weekDayRow}>
                  <Text style={[styles.weekDayTitle, isToday && { color: c.brandInk }]} accessibilityRole="header">
                    {capitalize(dayLongFmt.format(day))}
                    {isToday ? " · hoje" : ""}
                  </Text>
                  <Text style={styles.count}>{items.length ? countLabel(items.length) : "livre"}</Text>
                </View>
                {items.map((t) => (
                  <Pressable
                    key={t.id}
                    onPress={() => router.push({ pathname: "/ticket/[id]", params: { id: t.id } })}
                    accessibilityRole="button"
                    accessibilityLabel={`${t.code}, ${t.title}, ${STATUS[t.status]?.label ?? t.status}`}
                    accessibilityHint="Abre a OS"
                    style={({ pressed }) => [styles.slot, pressed && { backgroundColor: c.surface3 }]}
                  >
                    <View style={[styles.slotBar, { backgroundColor: statusFill(STATUS[t.status]?.color ?? c.inkSubtle, c) }]} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={styles.slotTime}>
                        {t.scheduled_start && sameDay(new Date(t.scheduled_start), day)
                          ? `${formatTime(t.scheduled_start)}${t.scheduled_end && sameDay(new Date(t.scheduled_end), day) ? ` – ${formatTime(t.scheduled_end)}` : ""}`
                          : t.scheduled_start
                            ? "Visita de vários dias"
                            : "Sem horário"}
                        {"  "}
                        <Text style={styles.slotCode}>{t.code}</Text>
                      </Text>
                      <Text style={styles.slotTitle} numberOfLines={1}>
                        {t.title}
                      </Text>
                      {t.location ? (
                        <Text style={styles.slotPlace} numberOfLines={1}>
                          {[t.location.code, t.location.name].filter(Boolean).join(" · ")}
                        </Text>
                      ) : null}
                      <StatusBadge status={t.status} />
                    </View>
                  </Pressable>
                ))}
              </Card>
            );
          })}
        </>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { gap: 12 },
    toolbar: { flexDirection: "row", alignItems: "center", gap: 6 },
    nav: {
      width: 44,
      height: 44,
      borderRadius: RADIUS.control,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
    },
    title: { flex: 1, textAlign: "center", fontSize: 16, fontWeight: "700", color: c.ink },
    card: { padding: 12, gap: 8 },
    weekHeader: { flexDirection: "row" },
    weekday: { flex: 1, textAlign: "center", fontSize: 11, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase" },
    grid: { flexDirection: "row", flexWrap: "wrap" },
    cell: { width: `${100 / 7}%`, alignItems: "center", paddingVertical: 4, gap: 3, minHeight: 48 },
    dayBubble: { minWidth: 36, minHeight: 36, borderRadius: 18, paddingHorizontal: 2, alignItems: "center", justifyContent: "center" },
    today: { borderWidth: 1.5, borderColor: c.primary },
    selected: { backgroundColor: c.primaryFill, borderColor: c.primaryFill },
    dayText: { fontSize: 15, color: c.ink, fontVariant: ["tabular-nums"] },
    outside: { color: c.inkSubtle },
    dots: { flexDirection: "row", gap: 3, minHeight: 6, alignItems: "center" },
    dot: { width: 6, height: 6, borderRadius: 3 },
    more: { fontSize: 10, fontWeight: "700", color: c.inkMuted, lineHeight: 10 },
    dayTitle: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6, marginTop: 4 },
    weekDayRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    weekDayTitle: { fontSize: 14, fontWeight: "700", color: c.ink, flexShrink: 1 },
    count: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    slot: { flexDirection: "row", gap: 10, padding: 10, borderRadius: RADIUS.control, backgroundColor: c.surface2, minHeight: 44 },
    slotBar: { width: 3, borderRadius: 2 },
    slotTime: { fontSize: 14, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    slotCode: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    slotTitle: { fontSize: 14, color: c.ink },
    slotPlace: { fontSize: 13, color: c.inkMuted },
  });
