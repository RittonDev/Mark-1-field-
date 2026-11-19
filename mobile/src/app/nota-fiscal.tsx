// Enviar nota fiscal (cartão "Notas fiscais de <mês>" em Ganhos). O técnico escolhe o arquivo (PDF ou XML do portal da
// prefeitura, ou uma foto), informa número, emissão, valor e competência e marca as OS que a nota cobre (as concluídas
// no mês e ainda sem nota vêm marcadas). Só online: a nota não entra na fila; sem rede, o formulário fica preenchido
// para tentar de novo. O mesmo `client_upload_id` vai em cada tentativa: a resposta perdida não vira nota repetida.

import { randomUUID } from "expo-crypto";
import { router, useLocalSearchParams, usePreventRemove } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { useContext, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionSheet, type SheetAction } from "../components/ActionSheet";
import { DateField } from "../components/forms/DateField";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { Text } from "../components/Text";
import { capturePhotos, recoverCapture } from "../components/ticket/photoCapture";
import { Badge, Button, ErrorBox, Field, Input } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { competenceLabel, INVOICE_FILE_KIND, INVOICE_LIMITS } from "../lib/constants";
import { confirmAction } from "../lib/dialogs";
import { formatBRL, parseBRL } from "../lib/expenses";
import { formatBytes } from "../lib/format";
import { haptic } from "../lib/haptics";
import { discardPicked, invoiceFromPhoto, pickInvoiceDocument, sweepInvoiceFiles, type PickedInvoiceFile } from "../lib/invoiceFile";
import { isoDay, isOffline, loadInvoicePayouts, monthKeyOf, sendInvoice, shiftMonth, type InvoiceInput } from "../lib/invoices";
import { showToast } from "../lib/toast";
import type { InvoicePayoutCandidate, MyInvoice } from "../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";

/** Os mesmos limites do servidor (backend/app/services/invoices.py), que confere de novo. */
const MAX_PAYOUTS = 200;
const MAX_AMOUNT = 10_000_000_000;
const FIRST_MONTH = "2000-01";

const MSG = {
  file: "Escolha o arquivo da nota.",
  number: "Informe o número da nota.",
  issueDate: "Informe a data de emissão.",
  futureDate: "A data de emissão não pode ser no futuro.",
  amount: "Informe o valor da nota.",
  badAmount: "Valor inválido.",
  zero: "O valor da nota precisa ser maior que zero.",
  payouts: `Escolha até ${MAX_PAYOUTS} OS por nota.`,
} as const;

const OFFLINE = "Sem internet. A nota só é enviada com conexão: tente de novo quando tiver sinal.";
const LIST_OFFLINE = "Sem internet: as OS aparecem quando a conexão voltar.";

type FieldKey = "file" | "number" | "issueDate" | "amount" | "payouts";
type Errors = Partial<Record<FieldKey, string>>;
/** Ordem da tela: o primeiro erro vai para o rodapé. */
const FIELD_ORDER: FieldKey[] = ["file", "number", "issueDate", "amount", "payouts"];

/** "1.234,56" para o campo do valor (o parseBRL lê de volta). */
const plainBRL = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Draft {
  file: PickedInvoiceFile | null;
  number: string;
  issueDate: string | null;
  amountText: string;
  payoutCount: number;
}

/** O que falta ou está errado (as mesmas regras e mensagens do servidor) e o valor lido. */
function review(draft: Draft, today: string): { errors: Errors; amount: number | null } {
  const errors: Errors = {};
  if (!draft.file) errors.file = MSG.file;
  if (!draft.number.trim()) errors.number = MSG.number;
  if (!draft.issueDate) errors.issueDate = MSG.issueDate;
  else if (draft.issueDate > today) errors.issueDate = MSG.futureDate;
  let amount: number | null = null;
  if (!draft.amountText.trim()) {
    errors.amount = MSG.amount;
  } else {
    amount = parseBRL(draft.amountText);
    if (amount === null || amount >= MAX_AMOUNT) errors.amount = MSG.badAmount;
    else if (amount <= 0) errors.amount = MSG.zero;
  }
  if (draft.payoutCount > MAX_PAYOUTS) errors.payouts = MSG.payouts;
  return { errors, amount };
}

const firstError = (errors: Errors) => FIELD_ORDER.map((key) => errors[key]).find(Boolean) ?? null;

/** A competência pedida pelo cartão (o mês de Ganhos), se for um mês válido e que já chegou; senão, o mês atual. */
function initialCompetence(param: unknown, current: string): string {
  const value = typeof param === "string" ? param : "";
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= FIRST_MONTH && value <= current ? value : current;
}

/** "novembro de 2026" → "Novembro de 2026". */
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Vêm marcadas as do mês da competência que ainda não estão em outra nota. */
const defaultChecked = (items: InvoicePayoutCandidate[]) =>
  new Set(items.filter((item) => item.in_month && !item.invoice).map((item) => item.payout_id));

function listFailure(error: unknown) {
  return error instanceof ApiError && error.status !== 0 ? error.message : LIST_OFFLINE;
}

async function sendFailure(error: unknown): Promise<string> {
  if (error instanceof ApiError && error.status === 0 && (await isOffline())) return OFFLINE;
  if (error instanceof ApiError && error.status === 408) return "O envio demorou demais e foi interrompido. Tente de novo.";
  return errorMessage(error);
}

/** Envio em andamento: a cópia do arquivo só sai do cache depois que ele termina. */
let uploading: Promise<unknown> | null = null;

async function sendTracked(input: InvoiceInput): Promise<MyInvoice> {
  const job = sendInvoice(input);
  uploading = job;
  try {
    return await job;
  } finally {
    if (uploading === job) uploading = null;
  }
}

/** Arquivo trocado ou tela fechada: apaga a cópia (esperando o envio que ainda a lê). */
function releaseFile(file: PickedInvoiceFile) {
  const pending = uploading;
  const drop = () => discardPicked(file);
  if (pending) void pending.then(drop, drop);
  else drop();
}

export default function InvoiceScreen() {
  const params = useLocalSearchParams<{ mes?: string }>();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  // O teclado sobe a partir do cabeçalho.
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const [today] = useState(() => isoDay(new Date()));
  const [current] = useState(() => monthKeyOf(new Date()));
  const [competence, setCompetence] = useState(() => initialCompetence(params.mes, current));
  const [file, setFile] = useState<PickedInvoiceFile | null>(null);
  const [number, setNumber] = useState("");
  const [issueDate, setIssueDate] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  const [note, setNote] = useState("");
  const [payouts, setPayouts] = useState<{ month: string; items: InvoicePayoutCandidate[] } | null>(null);
  const [payoutsError, setPayoutsError] = useState<{ month: string; message: string } | null>(null);
  const [payoutsAttempt, setPayoutsAttempt] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  // Depois do primeiro "Enviar nota", os erros aparecem nos campos e acompanham a digitação.
  const [attempted, setAttempted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Enviou ou descartou: sai sem perguntar.
  const [done, setDone] = useState(false);
  const [fileMenu, setFileMenu] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  const picking = useRef(false);
  // Uma por abertura da tela, repetida em cada tentativa (criada no primeiro envio).
  const uploadId = useRef<string | null>(null);

  const list = payouts?.month === competence ? payouts.items : null;
  const listError = !list && payoutsError?.month === competence ? payoutsError.message : null;
  const loadingList = !list && !listError;
  const selectable = list ? list.filter((item) => !item.invoice) : [];
  const chosen = selectable.filter((item) => checked.has(item.payout_id));
  const sum = chosen.reduce((total, item) => total + item.amount, 0);
  const allChecked = selectable.length > 0 && chosen.length === selectable.length;
  const inMonth = list ? list.filter((item) => item.in_month) : [];
  const earlier = list ? list.filter((item) => !item.in_month) : [];
  const isCurrent = competence >= current;
  const isFirst = competence <= FIRST_MONTH;
  const monthWord = competenceLabel(competence).replace(/ de \d{4}$/, "");

  const check = review({ file, number, issueDate, amountText, payoutCount: chosen.length }, today);
  const errors: Errors = attempted ? check.errors : {};
  const footerError = submitError ?? (attempted ? firstError(check.errors) : null);
  const differs = check.amount !== null && check.amount > 0 && sum > 0 && Math.abs(check.amount - sum) > 0.005;
  const sumHint = sum > 0 ? `Soma das OS marcadas: ${formatBRL(sum)}${differs ? " · diferente do valor da nota" : ""}` : undefined;
  const dirty = Boolean(file || number.trim() || issueDate || amountText.trim() || note.trim());

  const allowLeave = usePreventRemove(dirty && !done, ({ repeat }) => {
    if (sending) {
      showToast("Enviando a nota", { description: "Aguarde terminar para sair." });
      return;
    }
    void confirmAction("Descartar a nota?", "O que você preencheu não foi enviado.", { confirmText: "Descartar", destructive: true }).then(
      (ok) => {
        if (!ok) return;
        setDone(true);
        repeat();
      },
    );
  });

  useEffect(() => {
    mounted.current = true;
    // Cópias de uma tela que o sistema fechou no meio saem do cache.
    sweepInvoiceFiles();
    return () => {
      mounted.current = false;
    };
  }, []);

  // A cópia do arquivo sai quando ele é trocado e quando a tela fecha.
  useEffect(() => {
    if (!file) return;
    return () => releaseFile(file);
  }, [file]);

  // OS da competência: ao abrir, ao trocar de mês e em "Tentar de novo" (as marcações voltam ao padrão).
  useEffect(() => {
    let alive = true;
    loadInvoicePayouts(competence)
      .then((items) => {
        if (!alive) return;
        setPayouts({ month: competence, items });
        setChecked(defaultChecked(items));
        setPayoutsError(null);
      })
      .catch((error: unknown) => {
        if (alive) setPayoutsError({ month: competence, message: listFailure(error) });
      });
    return () => {
      alive = false;
    };
  }, [competence, payoutsAttempt]);

  // Android: a foto tirada antes de o sistema fechar o app com a câmera aberta volta para a nota.
  useEffect(() => {
    let alive = true;
    recoverCapture((target) => target.kind === "invoice")
      .then(async (found) => {
        const asset = found?.assets[0];
        if (!asset) return;
        const picked = await invoiceFromPhoto(asset);
        if (!picked) return;
        if (!alive) {
          discardPicked(picked);
          return;
        }
        setFile(picked);
        showToast("Foto recuperada", { tone: "success", description: "A foto tirada antes de o app fechar está na nota." });
      })
      .catch((error: unknown) => console.warn("Não foi possível recuperar a foto da nota", error));
    return () => {
      alive = false;
    };
  }, []);

  async function choose(source: "document" | "camera" | "library") {
    // Um seletor por vez; durante o envio o arquivo não muda.
    if (picking.current || busy.current) return;
    picking.current = true;
    try {
      let picked: PickedInvoiceFile | null = null;
      if (source === "document") {
        picked = await pickInvoiceDocument();
      } else {
        const [asset] = await capturePhotos(source, { kind: "invoice" });
        if (asset) picked = await invoiceFromPhoto(asset);
      }
      if (!picked) return;
      if (!mounted.current) {
        discardPicked(picked);
        return;
      }
      setFile(picked);
      setSubmitError(null);
    } finally {
      picking.current = false;
    }
  }

  function changeCompetence(delta: number) {
    const next = shiftMonth(competence, delta);
    if (next < FIRST_MONTH || next > current) return;
    haptic.select();
    setCompetence(next);
    setSubmitError(null);
  }

  function toggle(item: InvoicePayoutCandidate) {
    if (item.invoice) return;
    haptic.select();
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(item.payout_id)) next.delete(item.payout_id);
      else next.add(item.payout_id);
      return next;
    });
    setSubmitError(null);
  }

  function toggleAll() {
    haptic.select();
    setChecked(allChecked ? new Set() : new Set(selectable.map((item) => item.payout_id)));
    setSubmitError(null);
  }

  async function submit() {
    // Dois toques seguidos não mandam dois envios.
    if (busy.current || picking.current) return;
    setAttempted(true);
    setSubmitError(null);
    if (firstError(check.errors) || !file || !issueDate || check.amount === null) {
      haptic.warning();
      return;
    }
    busy.current = true;
    setSending(true);
    try {
      if (await isOffline()) {
        setSubmitError(OFFLINE);
        return;
      }
      uploadId.current ??= randomUUID();
      const invoice = await sendTracked({
        file,
        number,
        issueDate,
        amount: check.amount,
        competence,
        note,
        payoutIds: chosen.map((item) => item.payout_id),
        clientUploadId: uploadId.current,
      });
      haptic.success();
      showToast("Nota enviada", { tone: "success", description: `Nota nº ${invoice.number} · ${formatBRL(invoice.amount)}` });
      if (!mounted.current) return;
      setDone(true);
      allowLeave();
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } catch (error) {
      const message = await sendFailure(error);
      if (mounted.current) setSubmitError(message);
    } finally {
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }

  const fileActions: SheetAction[] = [
    { key: "document", label: "Escolher PDF ou XML", icon: "note", onPress: () => void choose("document") },
    { key: "camera", label: "Tirar foto", icon: "camera", onPress: () => void choose("camera") },
    { key: "library", label: "Da galeria", icon: "plus", onPress: () => void choose("library") },
  ];

  const renderPayout = (item: InvoicePayoutCandidate) => {
    const locked = Boolean(item.invoice);
    const on = !locked && checked.has(item.payout_id);
    const paid = item.status === "paid";
    return (
      <Pressable
        key={item.payout_id}
        disabled={locked || sending}
        onPress={() => toggle(item)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on, disabled: locked || sending }}
        accessibilityLabel={`${item.code}, ${formatBRL(item.amount)}, ${item.title}, ${paid ? "Pago" : "A receber"}${item.invoice ? `, na nota nº ${item.invoice.number}` : ""}`}
        style={({ pressed }) => [styles.payout, pressed && { backgroundColor: c.surface2 }]}
      >
        <View style={[styles.box, on && styles.boxOn, locked && styles.boxLocked]}>
          {on ? <Icon name="check" size={15} color={c.onPrimary} strokeWidth={3} /> : null}
        </View>
        <View style={[styles.payoutText, locked && styles.dimmed]}>
          <Text style={styles.payoutCode}>
            {item.code} · {formatBRL(item.amount)}
          </Text>
          <Text style={styles.payoutTitle} numberOfLines={1}>
            {item.title}
          </Text>
          {item.invoice ? <Text style={styles.payoutMeta}>Na nota nº {item.invoice.number}</Text> : null}
        </View>
        <Badge label={paid ? "Pago" : "A receber"} color={paid ? c.success : c.primary} />
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      >
        <View style={styles.card}>
          <Field label="Arquivo da nota" required error={errors.file}>
            {file ? (
              <View style={styles.fileRow}>
                <View style={styles.fileIcon}>
                  <Icon name={file.kind === "image" ? "camera" : "note"} size={20} color={c.brandInk} />
                </View>
                <View style={styles.fileText}>
                  <Text style={styles.fileName} numberOfLines={1}>
                    {file.name}
                  </Text>
                  <Text style={styles.muted}>
                    {INVOICE_FILE_KIND[file.kind]}
                    {file.size ? ` · ${formatBytes(file.size)}` : ""}
                  </Text>
                </View>
                <Button compact variant="ghost" title="Trocar" onPress={() => setFileMenu(true)} disabled={sending} />
              </View>
            ) : (
              <View style={styles.fileChoices}>
                <Button title="Escolher PDF ou XML" icon="note" variant="primary" onPress={() => void choose("document")} />
                <View style={styles.photoRow}>
                  <Button title="Tirar foto" icon="camera" onPress={() => void choose("camera")} style={styles.half} />
                  <Button title="Da galeria" onPress={() => void choose("library")} style={styles.half} />
                </View>
              </View>
            )}
          </Field>

          <Field label="Número da nota" required error={errors.number}>
            <Input
              value={number}
              onChangeText={(text) => {
                setNumber(text);
                setSubmitError(null);
              }}
              accessibilityLabel="Número da nota"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={INVOICE_LIMITS.numberMax}
            />
          </Field>

          <Field label="Data de emissão" required error={errors.issueDate}>
            <DateField
              value={issueDate}
              onChange={(value) => {
                setIssueDate(value);
                setSubmitError(null);
              }}
              label="Data de emissão"
              disabled={sending}
            />
          </Field>

          <Field label="Valor da nota" required hint={sumHint} error={errors.amount}>
            <Input
              value={amountText}
              onChangeText={(text) => {
                setAmountText(text);
                setSubmitError(null);
              }}
              accessibilityLabel="Valor da nota em reais"
              keyboardType="decimal-pad"
              maxLength={20}
              right={
                !amountText.trim() && sum > 0 ? (
                  <Button compact variant="ghost" title="Usar a soma" onPress={() => setAmountText(plainBRL.format(sum))} />
                ) : undefined
              }
            />
          </Field>

          <Field label="Competência" required>
            <View style={styles.monthNav}>
              <Pressable
                onPress={() => changeCompetence(-1)}
                disabled={isFirst || sending}
                accessibilityRole="button"
                accessibilityLabel="Mês anterior"
                accessibilityState={{ disabled: isFirst || sending }}
                hitSlop={4}
                style={({ pressed }) => [styles.navButton, isFirst && styles.navDisabled, pressed && { backgroundColor: c.surface3 }]}
              >
                <Icon name="chevronLeft" size={20} color={c.ink} />
              </Pressable>
              <Text
                style={styles.monthLabel}
                accessibilityLabel={`Competência: ${competenceLabel(competence)}`}
                accessibilityLiveRegion="polite"
              >
                {capitalized(competenceLabel(competence))}
              </Text>
              <Pressable
                onPress={() => changeCompetence(1)}
                disabled={isCurrent || sending}
                accessibilityRole="button"
                accessibilityLabel="Próximo mês"
                accessibilityState={{ disabled: isCurrent || sending }}
                hitSlop={4}
                style={({ pressed }) => [styles.navButton, isCurrent && styles.navDisabled, pressed && { backgroundColor: c.surface3 }]}
              >
                <Icon name="chevronRight" size={20} color={c.ink} />
              </Pressable>
            </View>
          </Field>
        </View>

        <View style={styles.card}>
          <View style={styles.payoutsHead}>
            <Text style={styles.label} accessibilityRole="header">
              OS desta nota
            </Text>
            {selectable.length ? (
              <Button compact variant="ghost" title={allChecked ? "Desmarcar todas" : "Marcar todas"} onPress={toggleAll} disabled={sending} />
            ) : null}
          </View>
          {listError ? (
            <View style={styles.listState}>
              <ErrorBox message={listError} />
              <Button title="Tentar de novo" icon="repeat" onPress={() => setPayoutsAttempt((n) => n + 1)} />
            </View>
          ) : !list ? (
            <View style={styles.listState}>
              <Skeleton height={44} radius={RADIUS.control} />
              <Skeleton height={44} radius={RADIUS.control} />
            </View>
          ) : (
            <View>
              {inMonth.length ? inMonth.map(renderPayout) : <Text style={styles.muted}>Nenhuma OS concluída em {monthWord}.</Text>}
              {earlier.length ? (
                <>
                  <Text style={styles.groupLabel}>De meses anteriores, a receber</Text>
                  {earlier.map(renderPayout)}
                </>
              ) : null}
            </View>
          )}
          {errors.payouts ? <Text style={styles.fieldError}>{errors.payouts}</Text> : null}
        </View>

        <View style={styles.card}>
          <Field label="Observação">
            <Input
              value={note}
              onChangeText={setNote}
              accessibilityLabel="Observação"
              multiline
              maxLength={INVOICE_LIMITS.noteMax}
            />
          </Field>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        {footerError ? <ErrorBox message={footerError} /> : null}
        <Button title="Enviar nota" variant="primary" onPress={() => void submit()} loading={sending} disabled={loadingList} />
      </View>

      <ActionSheet visible={fileMenu} title="Arquivo da nota" actions={fileActions} onClose={() => setFileMenu(false)} />
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 14 },
    card: {
      gap: 16,
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      padding: 16,
      boxShadow: c.elevation,
    },
    label: { fontSize: 13, fontWeight: "600", color: c.ink },
    muted: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    fieldError: { fontSize: 12, color: c.danger },
    fileChoices: { gap: 8 },
    photoRow: { flexDirection: "row", gap: 8 },
    half: { flex: 1 },
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 12,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
    },
    fileIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.primarySoft,
    },
    fileText: { flex: 1, gap: 2 },
    fileName: { fontSize: 15, fontWeight: "600", color: c.ink },
    monthNav: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      padding: 2,
    },
    navButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: RADIUS.control },
    navDisabled: { opacity: 0.35 },
    monthLabel: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "700", color: c.ink },
    payoutsHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 36 },
    listState: { gap: 10 },
    groupLabel: {
      fontSize: 12,
      fontWeight: "700",
      color: c.inkMuted,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginTop: 12,
      marginBottom: 4,
    },
    payout: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 56,
      paddingVertical: 10,
      paddingHorizontal: 4,
      marginHorizontal: -4,
      borderRadius: RADIUS.control,
    },
    box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: c.inkMuted, alignItems: "center", justifyContent: "center" },
    boxOn: { borderColor: c.primary, backgroundColor: c.primary },
    boxLocked: { borderColor: c.line, backgroundColor: c.surface3 },
    payoutText: { flex: 1, gap: 2 },
    dimmed: { opacity: 0.6 },
    payoutCode: { fontSize: 14, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    payoutTitle: { fontSize: 13, color: c.inkMuted },
    payoutMeta: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    footer: {
      gap: 10,
      paddingHorizontal: 16,
      paddingTop: 12,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
  });
