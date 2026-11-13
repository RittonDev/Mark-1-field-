import { router } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { api, ApiError } from "../lib/api";
import { getKv, getTicket, setKv } from "../lib/db";
import { formatBRL } from "../lib/expenses";
import { formatDate, formatDateTime } from "../lib/format";
import { useSyncStatus } from "../lib/sync";
import { showToast } from "../lib/toast";
import type { MyEarnings, PayoutLine } from "../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon } from "./Icon";
import { Skeleton } from "./Skeleton";
import { Text } from "./Text";
import { Badge, Button, Card, EmptyState, ErrorBox, SectionTitle } from "./ui";

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** Chave do total de todos os meses (GET /me/earnings sem `month`). */
const ALL = "all";
/** Depois de uma sincronização, os valores são conferidos de novo no máximo a cada 2 min. */
const SYNC_REFRESH_MS = 2 * 60_000;

type Entry = { at: string; data: MyEarnings };
type Setters = {
  setEntries: Dispatch<SetStateAction<Record<string, Entry>>>;
  setErrors: Dispatch<SetStateAction<Record<string, string>>>;
};

const storeKey = (key: string) => `earnings:${key}`;

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthName(d: Date) {
  const name = MONTHS[d.getMonth()];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const OFFLINE_TEXT = "Sem internet: os ganhos aparecem quando a conexão voltar.";

function failureText(e: unknown) {
  return e instanceof ApiError && e.status !== 0 ? e.message : OFFLINE_TEXT;
}

/** Valores guardados na tela enquanto a atualização falha: diz de quando são e por que não mudaram. */
function staleText(error: string, at: string) {
  return `${error === OFFLINE_TEXT ? "Sem internet" : "Não deu para atualizar"} · valores de ${formatDateTime(at)}`;
}

function lineStatus(line: PayoutLine): { label: string; tone: "paid" | "due" | "expected" } {
  if (line.status === "paid") return { label: line.paid_at ? `Pago ${formatDate(line.paid_at)}` : "Pago", tone: "paid" };
  return line.concluded ? { label: "A receber", tone: "due" } : { label: "Previsto", tone: "expected" };
}

/**
 * Busca os ganhos de um mês (ou de todos) e guarda POR CHAVE: um mês nunca aparece com os valores de
 * outro. O último resultado fica no aparelho, para abrir sem internet; a resposta do servidor substitui.
 * Do total de todos os meses só o resumo é usado: as linhas não ficam na memória nem no aparelho.
 */
async function loadInto(key: string, { setEntries, setErrors }: Setters): Promise<void> {
  void getKv(storeKey(key))
    .then((raw) => {
      if (!raw) return;
      const stored = JSON.parse(raw) as Entry;
      setEntries((prev) => (prev[key] ? prev : { ...prev, [key]: stored }));
    })
    .catch(() => undefined);
  try {
    const data = await api.get<MyEarnings>(key === ALL ? "/me/earnings" : `/me/earnings?month=${key}`);
    const entry: Entry = { at: new Date().toISOString(), data: key === ALL ? { ...data, items: [] } : data };
    setEntries((prev) => ({ ...prev, [key]: entry }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    // Escrita silenciosa: nenhuma lista do aparelho depende dos ganhos (não recarrega as OS à toa).
    void setKv(storeKey(key), JSON.stringify(entry), undefined, { notify: false }).catch(() => undefined);
  } catch (e) {
    setErrors((prev) => ({ ...prev, [key]: failureText(e) }));
  }
}

/** Abre a OS da linha se ela ainda está no aparelho (as encerradas saem depois de 30 dias). */
async function openTicket(id: string) {
  if (await getTicket(id)) router.push({ pathname: "/ticket/[id]", params: { id } });
  else showToast("Esta OS não está mais no aparelho", { description: "O histórico completo fica com a central." });
}

/**
 * Meus ganhos: o técnico é parceiro e recebe por chamado. No topo, o total a receber de todos os meses;
 * por mês, o que as OS concluídas no mês têm a receber, o que já foi pago e o previsto das que estão em
 * andamento, além dos reembolsos. Os valores são da central; sem internet, mostra o último resultado
 * guardado com a hora em que foi atualizado.
 *
 * `refreshKey` muda a cada "puxar para atualizar" na aba; `onSettled` avisa quando essa atualização terminou.
 */
export function EarningsView({ refreshKey = 0, onSettled }: { refreshKey?: number; onSettled?: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const { lastSyncAt } = useSyncStatus();
  const [currentKey] = useState(() => monthKey(new Date()));
  const [month, setMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const key = monthKey(month);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Pedido que já terminou para cada mês: enquanto o da tela não terminar, o mês mostra que está atualizando.
  const [settled, setSettled] = useState<Record<string, string>>({});
  const [retry, setRetry] = useState(0);
  const lastFetchAt = useRef(0);
  const allFor = useRef<string | null>(null);
  const settledRefresh = useRef(0);
  const token = `${key}#${refreshKey}#${retry}`;

  const notifySettled = useEffectEvent((round: number) => {
    if (round > settledRefresh.current) {
      settledRefresh.current = round;
      onSettled?.();
    }
  });

  // Mês na tela: ao abrir, ao trocar de mês, ao puxar para atualizar e em "Tentar de novo".
  useEffect(() => {
    const request = `${key}#${refreshKey}#${retry}`;
    const jobs = [loadInto(key, { setEntries, setErrors })];
    // O total de todos os meses não muda com o mês na tela: só ao abrir e ao atualizar.
    const allRound = `${refreshKey}#${retry}`;
    if (allFor.current !== allRound) {
      allFor.current = allRound;
      jobs.push(loadInto(ALL, { setEntries, setErrors }));
    }
    lastFetchAt.current = Date.now();
    void Promise.all(jobs).then(() => {
      setSettled((prev) => ({ ...prev, [key]: request }));
      if (refreshKey > 0) notifySettled(refreshKey);
    });
  }, [key, refreshKey, retry]);

  // A central marcou como pago e o app sincronizou: confere de novo (no máximo a cada 2 min).
  useEffect(() => {
    if (!lastSyncAt || Date.now() - lastFetchAt.current < SYNC_REFRESH_MS) return;
    lastFetchAt.current = Date.now();
    void loadInto(key, { setEntries, setErrors });
    void loadInto(ALL, { setEntries, setErrors });
  }, [lastSyncAt, key]);

  const entry = entries[key];
  const all = entries[ALL];
  const error = errors[key];
  const refreshing = Boolean(entry) && settled[key] !== token;
  const isCurrent = key === currentKey;
  const shift = (delta: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  const toneColor = { paid: c.success, due: c.primary, expected: c.inkMuted } as const;

  // Total a receber: o que ficou de meses anteriores também conta (OS concluída em outubro e ainda não paga).
  const current = entries[currentKey];
  const earlier = all && current ? all.data.summary.to_pay - current.data.summary.to_pay : 0;
  const reimbursements = entry ? entry.data.reimbursement_to_receive > 0 || entry.data.reimbursement_paid > 0 : false;

  return (
    <View style={styles.wrap}>
      <Card style={styles.hero}>
        <Text style={styles.heroLabel}>Total a receber</Text>
        {all ? (
          <Text style={styles.heroValue} accessibilityLabel={`Total a receber: ${formatBRL(all.data.summary.to_pay)}`}>
            {formatBRL(all.data.summary.to_pay)}
          </Text>
        ) : errors[ALL] ? (
          <Text style={styles.heroValue}>—</Text>
        ) : (
          <Skeleton width={168} height={34} radius={8} style={{ marginVertical: 2 }} />
        )}
        <Text style={styles.heroHint}>
          {earlier > 0.005
            ? `Inclui ${formatBRL(earlier)} de meses anteriores. É o que a central ainda vai pagar das OS concluídas.`
            : "OS concluídas que a central ainda vai pagar."}
        </Text>
        {all && errors[ALL] ? <Text style={styles.stale}>{staleText(errors[ALL], all.at)}</Text> : null}
      </Card>

      <View style={styles.monthNav}>
        <Pressable
          onPress={() => shift(-1)}
          accessibilityRole="button"
          accessibilityLabel="Mês anterior"
          hitSlop={4}
          style={({ pressed }) => [styles.navButton, pressed && { backgroundColor: c.surface3 }]}
        >
          <Icon name="chevronLeft" size={20} color={c.ink} />
        </Pressable>
        <View style={styles.monthCenter}>
          <Text style={styles.monthLabel} accessibilityRole="header">
            {monthName(month)} de {month.getFullYear()}
          </Text>
          {refreshing ? <ActivityIndicator size="small" color={c.inkMuted} accessibilityLabel="Atualizando" /> : null}
        </View>
        <Pressable
          onPress={() => shift(1)}
          disabled={isCurrent}
          accessibilityRole="button"
          accessibilityLabel="Próximo mês"
          accessibilityState={{ disabled: isCurrent }}
          hitSlop={4}
          style={({ pressed }) => [styles.navButton, isCurrent && { opacity: 0.35 }, pressed && { backgroundColor: c.surface3 }]}
        >
          <Icon name="chevronRight" size={20} color={c.ink} />
        </Pressable>
      </View>

      {!entry && error ? (
        <View style={{ gap: 10 }}>
          <ErrorBox message={error} />
          <Button title="Tentar de novo" icon="repeat" onPress={() => setRetry((r) => r + 1)} />
        </View>
      ) : !entry ? (
        <Card style={{ gap: 12 }}>
          <Skeleton width={140} height={12} />
          <View style={styles.stats}>
            <Skeleton height={48} radius={RADIUS.control} style={{ flex: 1 }} />
            <Skeleton height={48} radius={RADIUS.control} style={{ flex: 1 }} />
            <Skeleton height={48} radius={RADIUS.control} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : (
        <>
          {error ? <Text style={styles.stale}>{staleText(error, entry.at)}</Text> : null}
          <Card style={{ gap: 4 }}>
            <SectionTitle accent>Chamados de {MONTHS[month.getMonth()]}</SectionTitle>
            <View style={styles.stats}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>A receber</Text>
                <Text style={styles.statValue}>{formatBRL(entry.data.summary.to_pay)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Já pago</Text>
                <Text style={styles.statValue}>{formatBRL(entry.data.summary.paid)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Previsto</Text>
                <Text style={styles.statValue}>{formatBRL(entry.data.summary.expected)}</Text>
              </View>
            </View>
            <Text style={styles.hint}>OS concluídas neste mês. Previsto: OS em que você está e que ainda não foram concluídas.</Text>
            {reimbursements ? (
              <View style={styles.reimbursements}>
                <View style={styles.reimbursementRow}>
                  <Text style={styles.reimbursementLabel}>Reembolsos a receber (todos os meses)</Text>
                  <Text style={styles.reimbursementValue}>{formatBRL(entry.data.reimbursement_to_receive)}</Text>
                </View>
                <View style={styles.reimbursementRow}>
                  <Text style={styles.reimbursementLabel}>Reembolsos pagos neste mês</Text>
                  <Text style={styles.reimbursementValue}>{formatBRL(entry.data.reimbursement_paid)}</Text>
                </View>
              </View>
            ) : null}
          </Card>

          {entry.data.items.length ? (
            <Card style={{ paddingVertical: 4 }}>
              {entry.data.items.map((line, i) => {
                const status = lineStatus(line);
                const place = [line.ticket.customer, line.ticket.location, line.ticket.city].filter(Boolean).join(" · ");
                return (
                  <Pressable
                    key={line.id}
                    onPress={() => void openTicket(line.ticket.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`${line.ticket.code}, ${line.ticket.title}, ${formatBRL(line.amount)}, ${status.label}`}
                    accessibilityHint="Abre a OS"
                    style={({ pressed }) => [styles.line, i > 0 && styles.lineBorder, pressed && { backgroundColor: c.surface2 }]}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.code}>
                        {line.ticket.code}
                        {line.ticket.resolved_at ? ` · concluída ${formatDate(line.ticket.resolved_at)}` : ""}
                      </Text>
                      <Text style={styles.title} numberOfLines={2}>
                        {line.ticket.title}
                      </Text>
                      {place ? (
                        <Text style={styles.meta} numberOfLines={1}>
                          {place}
                        </Text>
                      ) : null}
                      {line.note ? <Text style={styles.note}>{line.note}</Text> : null}
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 6 }}>
                      <Text style={styles.amount}>{formatBRL(line.amount)}</Text>
                      <Badge label={status.label} color={toneColor[status.tone]} />
                    </View>
                  </Pressable>
                );
              })}
            </Card>
          ) : (
            <EmptyState
              icon="wallet"
              title="Nenhum chamado neste mês"
              description="O valor de cada OS aparece aqui assim que a central te coloca nela."
            />
          )}
        </>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 12 },
    monthNav: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      padding: 4,
    },
    navButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: RADIUS.control },
    monthCenter: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
    monthLabel: { fontSize: 16, fontWeight: "700", color: c.ink },
    hero: { gap: 4 },
    heroLabel: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    heroValue: { fontSize: 32, fontWeight: "700", color: c.ink, letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
    heroHint: { fontSize: 13, color: c.inkMuted, lineHeight: 18, marginTop: 2 },
    stale: { fontSize: 12, fontWeight: "600", color: c.inkMuted, marginTop: 4 },
    stats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    stat: { flexGrow: 1, flexBasis: 96, backgroundColor: c.surface2, borderRadius: RADIUS.control, padding: 10, gap: 2 },
    statLabel: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    statValue: { fontSize: 16, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    hint: { fontSize: 12, color: c.inkMuted, lineHeight: 17, marginTop: 8 },
    reimbursements: {
      marginTop: 10,
      paddingTop: 10,
      gap: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    reimbursementRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    reimbursementLabel: { fontSize: 13, color: c.inkMuted, flex: 1 },
    reimbursementValue: { fontSize: 14, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    line: { flexDirection: "row", gap: 12, paddingVertical: 12, paddingHorizontal: 4, marginHorizontal: -4, borderRadius: RADIUS.control },
    lineBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line, borderRadius: 0 },
    code: { fontSize: 12, fontWeight: "600", color: c.inkMuted, fontVariant: ["tabular-nums"] },
    title: { fontSize: 15, fontWeight: "600", color: c.ink },
    meta: { fontSize: 13, color: c.inkMuted },
    note: { fontSize: 12, color: c.inkMuted, lineHeight: 17 },
    amount: { fontSize: 15, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
  });
