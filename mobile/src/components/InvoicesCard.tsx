// Ganhos > "Notas fiscais de <mês>": as notas que o técnico enviou com competência no mês da tela, a situação na central
// (aguardando conferência, conferida, recusada com o motivo) e o botão para enviar outra (/nota-fiscal). A lista fica no
// aparelho para abrir sem internet. Tocar numa nota abre o arquivo ou apaga a nota (só a que a central ainda não
// conferiu).

import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { ApiError, errorMessage } from "../lib/api";
import { INVOICE_STATUS } from "../lib/constants";
import { confirmAction } from "../lib/dialogs";
import { formatBRL } from "../lib/expenses";
import { formatDateTime } from "../lib/format";
import { haptic } from "../lib/haptics";
import {
  deleteInvoice,
  formatDayOf,
  formatIsoDay,
  isOffline,
  linksFresh,
  loadMyInvoices,
  openInvoiceFile,
  readCachedInvoices,
  useInvoicesVersion,
  type InvoicesEntry,
} from "../lib/invoices";
import { showToast } from "../lib/toast";
import type { MyInvoice } from "../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { ActionSheet, type SheetAction } from "./ActionSheet";
import { Skeleton } from "./Skeleton";
import { Text } from "./Text";
import { Badge, Button, Card, ErrorBox, SectionTitle } from "./ui";

const OFFLINE_TEXT = "Sem internet: as notas aparecem quando a conexão voltar.";
const OPEN_OFFLINE = "O arquivo abre quando a conexão voltar.";

type Setters = {
  setEntries: Dispatch<SetStateAction<Record<string, InvoicesEntry>>>;
  setErrors: Dispatch<SetStateAction<Record<string, string>>>;
  setSettled: Dispatch<SetStateAction<Record<string, string>>>;
};

/** Último pedido de cada mês: a resposta que chega atrasada não passa por cima da mais nova. */
const latest = new Map<string, number>();

function failureText(error: unknown) {
  return error instanceof ApiError && error.status !== 0 ? error.message : OFFLINE_TEXT;
}

/** Lista guardada enquanto a atualização falha: diz de quando é e por que não mudou. */
function staleText(error: string, at: string) {
  return `${error === OFFLINE_TEXT ? "Sem internet" : "Não deu para atualizar"} · notas de ${formatDateTime(at)}`;
}

function dropError(month: string, setErrors: Setters["setErrors"]) {
  setErrors((prev) => {
    if (!(month in prev)) return prev;
    const next = { ...prev };
    delete next[month];
    return next;
  });
}

/** A lista que acabou de chegar do servidor (e o aviso de falha do mês sai). */
function keepEntry(month: string, entry: InvoicesEntry, { setEntries, setErrors }: Pick<Setters, "setEntries" | "setErrors">) {
  setEntries((prev) => ({ ...prev, [month]: entry }));
  dropError(month, setErrors);
}

/**
 * Busca as notas da competência e guarda POR MÊS (um mês nunca aparece com as notas de outro). A cópia do aparelho
 * aparece enquanto isso; a resposta do servidor substitui. `round` diz qual atualização terminou (o indicador some).
 */
async function loadInto(month: string, round: string, { setEntries, setErrors, setSettled }: Setters): Promise<void> {
  const seq = (latest.get(month) ?? 0) + 1;
  latest.set(month, seq);
  void readCachedInvoices(month).then((stored) => {
    if (stored) setEntries((prev) => (prev[month] ? prev : { ...prev, [month]: stored }));
  });
  try {
    const entry = await loadMyInvoices(month);
    if (latest.get(month) !== seq) return;
    keepEntry(month, entry, { setEntries, setErrors });
  } catch (error) {
    if (latest.get(month) !== seq) return;
    setErrors((prev) => ({ ...prev, [month]: failureText(error) }));
  }
  setSettled((prev) => ({ ...prev, [month]: round }));
}

/** "Emitida em 05/11/2026 · 3 OS · conferida em 20/11/2026". */
function metaText(invoice: MyInvoice): string {
  const parts = [`Emitida em ${formatIsoDay(invoice.issue_date)}`];
  if (invoice.payouts.length) parts.push(`${invoice.payouts.length} OS`);
  if (invoice.status === "checked" && invoice.reviewed_at) parts.push(`conferida em ${formatDayOf(invoice.reviewed_at)}`);
  return parts.join(" · ");
}

/**
 * `month` é "AAAA-MM" (a competência), `monthName` o mês por extenso em minúsculas e `refreshKey` muda a cada "puxar
 * para atualizar" em Ganhos.
 */
export function InvoicesCard({ month, monthName, refreshKey = 0 }: { month: string; monthName: string; refreshKey?: number }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const version = useInvoicesVersion();
  const [entries, setEntries] = useState<Record<string, InvoicesEntry>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Atualização que já terminou para cada mês: enquanto a da tela não terminar, o título mostra que está atualizando.
  const [settled, setSettled] = useState<Record<string, string>>({});
  const [retry, setRetry] = useState(0);
  // A nota da folha de ações fica enquanto a folha sai (o título não pisca); `menuOpen` abre e fecha.
  const [menu, setMenu] = useState<MyInvoice | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const deleting = useRef(false);
  const round = `${refreshKey}#${version}#${retry}`;

  // Ao abrir Ganhos e ao voltar para a tela (da tela de envio, por exemplo), ao trocar de mês, ao puxar para
  // atualizar, em "Tentar de novo" e quando uma nota entra ou sai.
  useFocusEffect(
    useCallback(() => {
      void loadInto(month, round, { setEntries, setErrors, setSettled });
    }, [month, round]),
  );

  const entry = entries[month];
  const error = errors[month];
  const refreshing = Boolean(entry) && settled[month] !== round;

  function openMenu(invoice: MyInvoice) {
    setMenu(invoice);
    setMenuOpen(true);
  }

  /** O link vale 30 min: com a lista mais velha que 20 min, busca de novo antes de abrir. */
  async function openFile(invoice: MyInvoice) {
    if (await isOffline()) {
      showToast("Sem internet", { description: OPEN_OFFLINE });
      return;
    }
    let target: MyInvoice | undefined = invoice;
    const listed = entries[invoice.competence];
    if (!listed || !linksFresh(listed, Date.now())) {
      try {
        const fresh = await loadMyInvoices(invoice.competence);
        keepEntry(invoice.competence, fresh, { setEntries, setErrors });
        target = fresh.items.find((item) => item.id === invoice.id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) showToast("Sem internet", { description: OPEN_OFFLINE });
        else showToast("Não foi possível abrir o arquivo", { tone: "error", description: errorMessage(e) });
        return;
      }
    }
    if (!target) {
      showToast("Esta nota não está mais na lista", { description: "Ela foi apagada em outro aparelho." });
      return;
    }
    try {
      await openInvoiceFile(target.download_url);
    } catch {
      showToast("Não foi possível abrir o arquivo", { tone: "error", description: "Tente de novo em instantes." });
    }
  }

  async function remove(invoice: MyInvoice) {
    if (deleting.current) return;
    const ok = await confirmAction(`Apagar a nota nº ${invoice.number}?`, "A central deixa de ver esta nota.", {
      confirmText: "Apagar",
      destructive: true,
    });
    if (!ok) return;
    if (await isOffline()) {
      showToast("Sem internet", { description: "Conecte o aparelho para apagar a nota." });
      return;
    }
    deleting.current = true;
    try {
      await deleteInvoice(invoice);
      setEntries((prev) => {
        const listed = prev[invoice.competence];
        if (!listed) return prev;
        return { ...prev, [invoice.competence]: { ...listed, items: listed.items.filter((item) => item.id !== invoice.id) } };
      });
      haptic.success();
      showToast("Nota apagada", { tone: "success" });
    } catch (e) {
      showToast("Não foi possível apagar a nota", { tone: "error", description: errorMessage(e) });
      // Ex.: a central conferiu enquanto isso: a lista mostra como a nota ficou.
      if (!(e instanceof ApiError && e.status === 0)) setRetry((r) => r + 1);
    } finally {
      deleting.current = false;
    }
  }

  const actions: SheetAction[] = menu
    ? [
        { key: "open", label: "Abrir arquivo", icon: "note", onPress: () => void openFile(menu) },
        ...(menu.status !== "checked"
          ? [{ key: "delete", label: "Apagar nota", icon: "close", tone: "danger", onPress: () => void remove(menu) } satisfies SheetAction]
          : []),
      ]
    : [];

  return (
    <Card style={styles.card}>
      <SectionTitle
        accent
        right={refreshing ? <ActivityIndicator size="small" color={c.inkMuted} accessibilityLabel="Atualizando as notas" /> : undefined}
      >
        Notas fiscais de {monthName}
      </SectionTitle>
      {entry && error ? <Text style={styles.stale}>{staleText(error, entry.at)}</Text> : null}

      {!entry && error ? (
        <View style={styles.block}>
          <ErrorBox message={error} />
          <Button
            title="Tentar de novo"
            icon="repeat"
            onPress={() => {
              // O esqueleto volta enquanto busca de novo.
              dropError(month, setErrors);
              setRetry((r) => r + 1);
            }}
          />
        </View>
      ) : !entry ? (
        <View style={styles.block} accessibilityLabel="Carregando as notas">
          <Skeleton width={150} height={14} />
          <Skeleton width={220} height={12} />
        </View>
      ) : entry.items.length ? (
        <View>
          {entry.items.map((invoice, i) => {
            const status = INVOICE_STATUS[invoice.status];
            return (
              <Pressable
                key={invoice.id}
                onPress={() => openMenu(invoice)}
                accessibilityRole="button"
                accessibilityLabel={`Nota nº ${invoice.number}, ${formatBRL(invoice.amount)}, ${status.label}`}
                accessibilityHint={invoice.status === "checked" ? "Abre o arquivo da nota" : "Abre o arquivo ou apaga a nota"}
                style={({ pressed }) => [styles.line, i > 0 && styles.lineBorder, pressed && { backgroundColor: c.surface2 }]}
              >
                <View style={styles.lineHead}>
                  <Text style={styles.number} numberOfLines={1}>
                    Nota nº {invoice.number}
                  </Text>
                  <Text style={styles.amount}>{formatBRL(invoice.amount)}</Text>
                </View>
                <Badge label={status.label} color={status.color} />
                <Text style={styles.meta}>{metaText(invoice)}</Text>
                {invoice.status === "rejected" && invoice.reject_reason ? (
                  <Text style={[styles.reason, { color: c.dangerInk }]}>Motivo: {invoice.reject_reason}</Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Text style={styles.empty}>Nenhuma nota enviada para {monthName}.</Text>
      )}

      <Button title="Enviar nota fiscal" icon="plus" onPress={() => router.push({ pathname: "/nota-fiscal", params: { mes: month } })} />

      <ActionSheet
        visible={menuOpen}
        title={menu ? `Nota nº ${menu.number}` : "Nota fiscal"}
        actions={actions}
        onClose={() => setMenuOpen(false)}
      />
    </Card>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: { gap: 10 },
    block: { gap: 10 },
    stale: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    empty: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    line: { gap: 6, paddingVertical: 12, paddingHorizontal: 4, marginHorizontal: -4, borderRadius: RADIUS.control },
    lineBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line, borderRadius: 0 },
    lineHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    number: { fontSize: 15, fontWeight: "700", color: c.ink, flexShrink: 1 },
    amount: { fontSize: 15, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    meta: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    reason: { fontSize: 13, lineHeight: 18 },
  });
