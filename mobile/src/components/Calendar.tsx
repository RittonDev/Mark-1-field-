// Agenda do técnico: visão de mês (grade com marcadores) e de semana (dia a dia).
// Mostra as visitas agendadas (scheduled_start/scheduled_end) e, no dia de hoje, as OS em aberto.
// Tocar no dia lista as OS; tocar na OS abre o detalhe.

import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { STATUS } from "../lib/constants";
import { addDays, formatTime, startOfDay } from "../lib/format";
import { isDone, ticketsOnDay } from "../lib/lists";
import type { LocalTicket } from "../lib/syncTypes";
import type { User } from "../lib/types";
import { readable, useStyles, useTheme, type Palette } from "../theme/theme";
import { StatusBadge } from "./badges";
import { TicketCard } from "./TicketCard";
import { Button, EmptyState, Segmented } from "./ui";

type Mode = "month" | "week";

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const monthFmt = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
const dayLongFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
const dayShortFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });

const sameDay = (a: Date, b: Date) => startOfDay(a).getTime() === startOfDay(b).getTime();
const startOfWeek = (d: Date) => addDays(startOfDay(d), -startOfDay(d).getDay());
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function Calendar({ tickets, user, now }: { tickets: LocalTicket[]; user: User; now: number }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const today = useMemo(() => startOfDay(new Date(now)), [now]);
  const [mode, setMode] = useState<Mode>("month");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date(now)));
  const [selected, setSelected] = useState(() => startOfDay(new Date(now)));

  const days = useMemo(
    () => (mode === "month" ? monthGrid(anchor) : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i))),
    [mode, anchor],
  );
  const byDay = useMemo(() => {
    const map = new Map<number, LocalTicket[]>();
    for (const day of days) map.set(day.getTime(), ticketsOnDay(tickets, user, day, new Date(now)));
    return map;
  }, [days, tickets, user, now]);

  function shift(step: number) {
    const next =
      mode === "month"
        ? new Date(anchor.getFullYear(), anchor.getMonth() + step, 1)
        : addDays(anchor, 7 * step);
    setAnchor(startOfDay(next));
  }

  function goToday() {
    setAnchor(today);
    setSelected(today);
  }

  const title =
    mode === "month"
      ? capitalize(monthFmt.format(anchor))
      : `${dayShortFmt.format(days[0])} – ${dayShortFmt.format(days[6])}`;

  const selectedTickets = byDay.get(selected.getTime()) ?? ticketsOnDay(tickets, user, selected, new Date(now));

  return (
    <View style={styles.wrap}>
      <Segmented<Mode>
        value={mode}
        onChange={setMode}
        options={[
          { value: "month", label: "Mês" },
          { value: "week", label: "Semana" },
        ]}
      />

      <View style={styles.toolbar}>
        <Pressable onPress={() => shift(-1)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Anterior" style={styles.nav}>
          <Text style={styles.navText}>‹</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <Pressable onPress={() => shift(1)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Próximo" style={styles.nav}>
          <Text style={styles.navText}>›</Text>
        </Pressable>
        <Button compact variant="ghost" title="Hoje" onPress={goToday} />
      </View>

      {mode === "month" ? (
        <>
          <View style={styles.card}>
            <View style={styles.weekHeader}>
              {WEEKDAYS.map((w) => (
                <Text key={w} style={styles.weekday}>
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
                    onPress={() => setSelected(day)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={`${dayLongFmt.format(day)}, ${items.length} OS`}
                    style={styles.cell}
                  >
                    <View style={[styles.dayBubble, isToday && styles.today, isSelected && styles.selected]}>
                      <Text
                        style={[
                          styles.dayText,
                          !inMonth && styles.outside,
                          isToday && !isSelected && { color: c.primary, fontWeight: "700" },
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
                            { backgroundColor: isDone(t.status) ? c.inkSubtle : readable(STATUS[t.status].color, c) },
                          ]}
                        />
                      ))}
                      {items.length > 3 ? <Text style={styles.more}>+</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <Text style={styles.dayTitle}>{capitalize(dayLongFmt.format(selected))}</Text>
          {selectedTickets.length === 0 ? (
            <EmptyState title="Nenhuma OS neste dia" />
          ) : (
            selectedTickets.map((t) => <TicketCard key={t.id} ticket={t} now={now} />)
          )}
        </>
      ) : (
        days.map((day) => {
          const items = byDay.get(day.getTime()) ?? [];
          const isToday = sameDay(day, today);
          return (
            <View key={day.getTime()} style={styles.card}>
              <View style={styles.weekDayRow}>
                <Text style={[styles.weekDayTitle, isToday && { color: c.primary }]}>
                  {capitalize(dayLongFmt.format(day))}
                  {isToday ? " · hoje" : ""}
                </Text>
                <Text style={styles.count}>{items.length ? `${items.length} OS` : "livre"}</Text>
              </View>
              {items.map((t) => (
                <Pressable
                  key={t.id}
                  onPress={() => router.push({ pathname: "/ticket/[id]", params: { id: t.id } })}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.code}, ${t.title}`}
                  style={({ pressed }) => [styles.slot, pressed && { backgroundColor: c.surface2 }]}
                >
                  <View style={[styles.slotBar, { backgroundColor: readable(STATUS[t.status].color, c) }]} />
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={styles.slotTime}>
                      {t.scheduled_start && sameDay(new Date(t.scheduled_start), day)
                        ? `${formatTime(t.scheduled_start)}${t.scheduled_end ? ` – ${formatTime(t.scheduled_end)}` : ""}`
                        : "Sem horário"}
                      {"  "}
                      <Text style={styles.slotCode}>{t.code}</Text>
                    </Text>
                    <Text style={styles.slotTitle} numberOfLines={1}>
                      {t.title}
                    </Text>
                    <StatusBadge status={t.status} />
                  </View>
                </Pressable>
              ))}
            </View>
          );
        })
      )}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { gap: 12 },
    toolbar: { flexDirection: "row", alignItems: "center", gap: 4 },
    nav: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
    },
    navText: { fontSize: 22, color: c.ink, lineHeight: 24 },
    title: { flex: 1, textAlign: "center", fontSize: 16, fontWeight: "700", color: c.ink },
    card: {
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      padding: 12,
      gap: 8,
    },
    weekHeader: { flexDirection: "row" },
    weekday: { flex: 1, textAlign: "center", fontSize: 11, fontWeight: "700", color: c.inkSubtle, textTransform: "uppercase" },
    grid: { flexDirection: "row", flexWrap: "wrap" },
    cell: { width: `${100 / 7}%`, alignItems: "center", paddingVertical: 4, gap: 3 },
    dayBubble: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
    today: { borderWidth: 1.5, borderColor: c.primary },
    selected: { backgroundColor: c.primary, borderColor: c.primary },
    dayText: { fontSize: 14, color: c.ink, fontVariant: ["tabular-nums"] },
    outside: { color: c.inkSubtle },
    dots: { flexDirection: "row", gap: 3, height: 6, alignItems: "center" },
    dot: { width: 5, height: 5, borderRadius: 3 },
    more: { fontSize: 9, color: c.inkMuted, lineHeight: 9 },
    dayTitle: { fontSize: 13, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 },
    weekDayRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    weekDayTitle: { fontSize: 14, fontWeight: "700", color: c.ink },
    count: { fontSize: 12, color: c.inkMuted },
    slot: { flexDirection: "row", gap: 10, padding: 8, borderRadius: 10, backgroundColor: c.surface2 },
    slotBar: { width: 3, borderRadius: 2 },
    slotTime: { fontSize: 13, fontWeight: "600", color: c.ink, fontVariant: ["tabular-nums"] },
    slotCode: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    slotTitle: { fontSize: 14, color: c.ink },
  });
