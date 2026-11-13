import { StyleSheet, View } from "react-native";
import { initials } from "../../lib/format";
import type { LocalTicket } from "../../lib/syncTypes";
import { RADIUS, tint, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { Badge, Card, SectionTitle } from "../ui";

/** Observação da visita: o recado do analista (com quem falar, acesso, o que levar). Em destaque no topo. */
export function VisitNoteCard({ note }: { note: string | null | undefined }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const text = note?.trim();
  if (!text) return null;
  return (
    <View style={styles.note} accessibilityRole="summary">
      <View style={styles.noteHead}>
        <Icon name="note" size={18} color={c.brandInk} strokeWidth={2} />
        <Text style={styles.noteTitle}>Observação da visita</Text>
      </View>
      <Text style={styles.noteText} selectable>
        {text}
      </Text>
    </View>
  );
}

/** Equipe da visita: o responsável e os outros técnicos que vão junto. */
export function VisitTeamCard({ ticket, userId }: { ticket: LocalTicket; userId: string }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const helpers = (ticket.helpers ?? []).filter((h) => h.id !== ticket.assignee?.id);
  if (!helpers.length) return null;
  const people = [
    ...(ticket.assignee ? [{ id: ticket.assignee.id, name: ticket.assignee.name, role: "Responsável" }] : []),
    ...helpers.map((h) => ({ id: h.id, name: h.name, role: "Vai junto" })),
  ];
  return (
    <Card style={{ gap: 10 }}>
      <SectionTitle right={<Icon name="users" size={18} color={c.inkMuted} />}>Equipe da visita</SectionTitle>
      {people.map((p) => {
        const me = p.id === userId;
        return (
          <View key={p.id} style={styles.person}>
            <View style={[styles.avatar, me && { backgroundColor: c.primarySoft, borderColor: tint(c.primary, "40") }]}>
              <Text style={[styles.avatarText, me && { color: c.brandInk }]}>{initials(p.name)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>
                {p.name}
                {me ? <Text style={styles.me}> (você)</Text> : null}
              </Text>
              <Text style={styles.role}>{p.role}</Text>
            </View>
          </View>
        );
      })}
    </Card>
  );
}

/** Selo de quem é auxiliar na visita. */
export function HelperBadge() {
  const c = useTheme();
  return <Badge label="Você vai junto" color={c.primary} />;
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    note: {
      gap: 6,
      padding: 14,
      borderRadius: RADIUS.card,
      backgroundColor: c.primarySoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tint(c.primary, "40"),
    },
    noteHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    noteTitle: { fontSize: 13, fontWeight: "700", color: c.brandInk, letterSpacing: 0.2 },
    noteText: { fontSize: 15, color: c.ink, lineHeight: 21 },
    person: { flexDirection: "row", alignItems: "center", gap: 10 },
    avatar: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.lineStrong,
    },
    avatarText: { fontSize: 12, fontWeight: "700", color: c.ink },
    name: { fontSize: 15, fontWeight: "600", color: c.ink },
    me: { fontWeight: "500", color: c.inkMuted },
    role: { fontSize: 13, color: c.inkMuted },
  });
