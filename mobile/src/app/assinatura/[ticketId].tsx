import { router, Stack, useLocalSearchParams, usePreventRemove } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fitStrokes, SignaturePad, type PadHandle, type PadSize, type Stroke } from "../../components/SignaturePad";
import { DetailSkeleton } from "../../components/Skeleton";
import { Text } from "../../components/Text";
import { useLocationFix } from "../../components/ticket/LocationLine";
import { Button, Card, EmptyState, ErrorBox, Field, Input, SectionTitle } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { useLiveQuery, useNow } from "../../lib/changes";
import { getTicket, listSignatures } from "../../lib/db";
import { confirmAction } from "../../lib/dialogs";
import { formatDateTime } from "../../lib/format";
import { signatureBlock } from "../../lib/forms";
import { haptic } from "../../lib/haptics";
import { requestConclude } from "../../lib/progress";
import { useSession } from "../../lib/session";
import { exportSignature } from "../../lib/signatureImage";
import { showSuccess } from "../../lib/success";
import { isOnline, queueSignature, useSyncStatus } from "../../lib/sync";
import type { LocalTicket } from "../../lib/syncTypes";
import { useStyles, useTheme, type Palette } from "../../theme/theme";

/** Assinatura do responsável no local (nome, cargo e o desenho). Funciona offline. */
export default function SignatureScreen() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  const load = useCallback(() => getTicket(String(ticketId)), [ticketId]);
  const ticket = useLiveQuery(load);
  if (ticket === undefined) return <DetailSkeleton />;
  if (!ticket) {
    return (
      <View style={{ flex: 1, padding: 16 }}>
        <EmptyState icon="alert" title="OS não encontrada neste aparelho" description="Volte para a lista e abra a OS de novo." />
        <Button title="Voltar para a lista" onPress={() => router.replace("/")} />
      </View>
    );
  }
  return <SignatureEditor ticket={ticket} />;
}

const backToTicket = (ticketId: string) => {
  if (router.canGoBack()) router.back();
  else router.replace({ pathname: "/ticket/[id]", params: { id: ticketId } });
};

function SignatureEditor({ ticket }: { ticket: LocalTicket }) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const online = isOnline(useSyncStatus());
  const { user } = useSession();
  const now = useNow(30_000);
  const location = useLocationFix();
  const loadSignatures = useCallback(() => listSignatures(ticket.id), [ticket.id]);
  const pending = useLiveQuery(loadSignatures)?.[0] ?? null;
  const padRef = useRef<PadHandle>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [size, setSize] = useState<PadSize>({ width: 0, height: 0 });
  const [full, setFull] = useState<{ strokes: Stroke[]; size: PadSize | null } | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // Com o teclado aberto (digitando o nome) a área de assinar sai da frente; volta quando ele fecha.
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboardOpen(true));
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Sair com assinatura ou nome preenchidos pergunta antes (o cliente pode já ter ido embora).
  const dirty = !done && (strokes.length > 0 || name.trim().length > 0 || role.trim().length > 0);
  const allowLeave = usePreventRemove(dirty, ({ repeat }) => {
    void confirmAction("Descartar a assinatura?", "O desenho e o nome digitado serão perdidos.", {
      confirmText: "Descartar",
      destructive: true,
    }).then((ok) => {
      if (!ok) return;
      setDone(true);
      repeat();
    });
  });

  const block = signatureBlock(ticket);
  // Só o responsável colhe (o auxiliar que abre por link vê o aviso).
  const canSign = ticket.assignee?.id === user?.id;
  const site = ticket.location ? [ticket.location.code, ticket.location.name].filter(Boolean).join(" · ") : null;
  const client = [ticket.customer?.name, site].filter(Boolean).join(" · ");
  const formsDone = (ticket.forms ?? []).filter((f) => f.status === "completed").map((f) => f.name);
  const padHeight = Math.round(Math.min(360, Math.max(200, windowHeight * 0.34)));

  async function confirm() {
    setError(null);
    const cleanName = name.trim().replace(/\s+/g, " ");
    if (cleanName.length < 3) {
      haptic.warning();
      setError("Informe o nome de quem assina.");
      return;
    }
    if (strokes.reduce((n, s) => n + s.length, 0) < 8) {
      haptic.warning();
      setError("Peça para o responsável assinar na área branca.");
      return;
    }
    setBusy(true);
    try {
      const uri = await exportSignature(padRef, strokes, size);
      // A posição foi buscada ao abrir a tela; o responsável não fica esperando o GPS.
      const position = await Promise.race([
        location.wait(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      await queueSignature(ticket.id, uri, {
        name: cleanName,
        role: role.trim() || null,
        latitude: position?.status === "ok" ? position.latitude : null,
        longitude: position?.status === "ok" ? position.longitude : null,
      });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    haptic.success();
    // Em atendimento, o próximo passo é concluir: a OS abre direto a conclusão.
    const concludeNext = ticket.status === "in_progress";
    if (concludeNext) requestConclude(ticket.id);
    showSuccess(
      "Assinatura salva",
      !online ? "Salva no aparelho; vai para a central quando houver conexão." : concludeNext ? "Agora conclua a OS." : undefined,
    );
    setDone(true);
    allowLeave();
    backToTicket(ticket.id);
  }

  function undo() {
    setStrokes((prev) => prev.slice(0, -1));
  }

  function openFull() {
    Keyboard.dismiss();
    setFull({ strokes: [], size: null });
  }

  function fullSize(next: PadSize) {
    // Os traços já feitos vão para a área grande na mesma proporção.
    setFull((f) => (f && !f.size ? { size: next, strokes: fitStrokes(strokes, size, next) } : f));
  }

  function closeFull() {
    if (full?.size) setStrokes(fitStrokes(full.strokes, full.size, size));
    setFull(null);
  }

  const header = (
    <View style={{ gap: 4 }}>
      <Text style={styles.code}>{ticket.code}</Text>
      <Text style={styles.title} accessibilityRole="header">
        Assinatura do responsável no local
      </Text>
      <Text style={styles.lead}>Confirma o atendimento realizado. Depois dela os formulários ficam travados.</Text>
    </View>
  );

  if (block || !canSign) {
    return (
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <Stack.Screen options={{ title: "Assinatura" }} />
        {header}
        {block ? <ErrorBox message={block} /> : (
          <Card>
            <Text style={styles.previousText}>
              Só o técnico responsável ({ticket.assignee?.name ?? "definido pela central"}) colhe a assinatura desta OS.
            </Text>
          </Card>
        )}
        <Button title="Voltar para a OS" onPress={() => backToTicket(ticket.id)} />
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {/* Sem o gesto de voltar pela borda: um traço perto da borda esquerda não pode fechar a tela. */}
      <Stack.Screen options={{ title: "Assinatura", gestureEnabled: false }} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {header}
        {ticket.signed_at || pending ? (
          <Card style={styles.previous}>
            <Text style={styles.previousText}>
              {pending
                ? `Assinatura de ${pending.signer_name} aguardando envio. Uma nova assinatura substitui esta.`
                : `Assinada por ${ticket.signer_name}${ticket.signer_role ? ` (${ticket.signer_role})` : ""} em ${formatDateTime(ticket.signed_at)}. Uma nova assinatura substitui a anterior.`}
            </Text>
          </Card>
        ) : null}
        {/* O técnico digita o nome de quem assina (o app não recebe o contato da loja). */}
        <Card style={{ gap: 14 }}>
          <Field label="Nome de quem assina" required>
            <Input value={name} onChangeText={setName} autoCapitalize="words" placeholder="Nome completo" editable={!busy} returnKeyType="done" />
          </Field>
          <Field label="Cargo / função">
            <Input value={role} onChangeText={setRole} autoCapitalize="sentences" placeholder="Ex.: Gerente da loja" editable={!busy} returnKeyType="done" />
          </Field>
        </Card>
        <Card style={{ gap: 6 }}>
          <SectionTitle>O que está sendo assinado</SectionTitle>
          <Text style={styles.summaryTitle}>{ticket.title}</Text>
          {client ? <Text style={styles.summaryLine}>{client}</Text> : null}
          {ticket.service_type ? <Text style={styles.summaryLine}>{ticket.service_type.name}</Text> : null}
          <Text style={styles.summaryLine}>{formatDateTime(new Date(now).toISOString())}</Text>
          {formsDone.length ? <Text style={styles.summaryLine}>Formulários concluídos: {formsDone.join(", ")}</Text> : null}
          <Text style={styles.declaration}>Declaro que o atendimento acima foi realizado.</Text>
        </Card>
      </ScrollView>

      {keyboardOpen ? null : (
        <View style={[styles.panel, { paddingBottom: insets.bottom + 12 }]}>
          <SignaturePad ref={padRef} strokes={strokes} onChange={setStrokes} onSize={setSize} height={padHeight} />
          <View style={styles.tools}>
            <Button title="Desfazer" compact variant="ghost" onPress={undo} disabled={busy || !strokes.length} style={{ flex: 1 }} />
            <Button title="Limpar" compact variant="ghost" onPress={() => setStrokes([])} disabled={busy || !strokes.length} style={{ flex: 1 }} />
            {Platform.OS === "web" ? null : (
              <Button title="Tela cheia" compact variant="ghost" onPress={openFull} disabled={busy} style={{ flex: 1 }} />
            )}
          </View>
          {error ? <ErrorBox message={error} /> : null}
          <Button title="Confirmar assinatura" variant="primary" onPress={() => void confirm()} loading={busy} />
        </View>
      )}

      {full ? (
        <FullscreenPad
          signer={name.trim()}
          code={ticket.code}
          strokes={full.strokes}
          onChange={(next) => setFull((f) => (f ? { ...f, strokes: next } : f))}
          onSize={fullSize}
          onUndo={() => setFull((f) => (f ? { ...f, strokes: f.strokes.slice(0, -1) } : f))}
          onClear={() => setFull((f) => (f ? { ...f, strokes: [] } : f))}
          onDone={closeFull}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

/**
 * Assinar com o celular deitado, sem girar o app (ele é travado em retrato): o conteúdo vai girado
 * 90° para quem segura o aparelho com o topo para a esquerda. A captura continua sendo a da área
 * normal: ao sair, os traços voltam para ela na mesma proporção.
 */
function FullscreenPad({
  signer,
  code,
  strokes,
  onChange,
  onSize,
  onUndo,
  onClear,
  onDone,
}: {
  signer: string;
  code: string;
  strokes: Stroke[];
  onChange: (strokes: Stroke[]) => void;
  onSize: (size: PadSize) => void;
  onUndo: () => void;
  onClear: () => void;
  onDone: () => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  return (
    <Modal visible animationType="fade" onRequestClose={onDone} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: c.canvas }}>
        <View
          style={[
            styles.rotated,
            {
              width: height,
              height: width,
              left: (width - height) / 2,
              top: (height - width) / 2,
              // Girado 90°: a borda de cima do aparelho fica à esquerda e a de baixo à direita.
              paddingLeft: insets.top + 12,
              paddingRight: insets.bottom + 12,
            },
          ]}
        >
          <View style={styles.fullHead}>
            <Text style={styles.fullTitle} numberOfLines={1}>
              {signer ? `Assinatura de ${signer}` : "Assinatura do responsável"} · {code}
            </Text>
            <Text style={styles.fullHint}>Vire o celular de lado</Text>
          </View>
          <SignaturePad strokes={strokes} onChange={onChange} onSize={onSize} style={{ flex: 1 }} />
          <View style={styles.fullTools}>
            <Button title="Desfazer" compact variant="ghost" onPress={onUndo} disabled={!strokes.length} />
            <Button title="Limpar" compact variant="ghost" onPress={onClear} disabled={!strokes.length} />
            <View style={{ flex: 1 }} />
            <Button title="Pronto" variant="primary" onPress={onDone} style={{ minWidth: 140 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 16, gap: 14, maxWidth: 720, width: "100%", alignSelf: "center" },
    code: { fontSize: 13, fontWeight: "700", color: c.inkMuted, letterSpacing: 0.3, fontVariant: ["tabular-nums"] },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    lead: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    previous: { backgroundColor: c.surface2 },
    previousText: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    summaryTitle: { fontSize: 16, fontWeight: "700", color: c.ink, lineHeight: 22 },
    summaryLine: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    declaration: { fontSize: 14, fontWeight: "600", color: c.ink, lineHeight: 20, marginTop: 6 },
    panel: {
      gap: 10,
      paddingHorizontal: 16,
      paddingTop: 12,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    tools: { flexDirection: "row", gap: 8 },
    rotated: { position: "absolute", transform: [{ rotate: "90deg" }], paddingVertical: 12, gap: 10 },
    fullHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    fullTitle: { flex: 1, fontSize: 15, fontWeight: "700", color: c.ink },
    fullHint: { fontSize: 13, color: c.inkMuted },
    fullTools: { flexDirection: "row", alignItems: "center", gap: 8 },
  });
