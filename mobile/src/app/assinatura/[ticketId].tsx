import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { DetailSkeleton } from "../../components/Skeleton";
import { Text } from "../../components/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SignaturePad, type PadHandle, type Stroke } from "../../components/SignaturePad";
import { Button, Card, EmptyState, ErrorBox, Field, Input } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { useLiveQuery } from "../../lib/changes";
import { getTicket, listSignatures } from "../../lib/db";
import { currentPosition } from "../../lib/device-actions";
import { formatDateTime } from "../../lib/format";
import { signatureBlock } from "../../lib/forms";
import { exportSignature } from "../../lib/signatureImage";
import { isOnline, queueSignature, useSyncStatus } from "../../lib/sync";
import { haptic } from "../../lib/haptics";
import { showSuccess } from "../../lib/success";
import { useStyles, type Palette } from "../../theme/theme";

/** Assinatura do responsável no local (nome, cargo e o desenho). Funciona offline. */
export default function SignatureScreen() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const online = isOnline(useSyncStatus());
  const load = useCallback(() => getTicket(String(ticketId)), [ticketId]);
  const loadSignatures = useCallback(() => listSignatures(String(ticketId)), [ticketId]);
  const ticket = useLiveQuery(load);
  const pending = useLiveQuery(loadSignatures)?.[0] ?? null;
  const padRef = useRef<PadHandle>(null);
  const [padKey, setPadKey] = useState(0);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [name, setName] = useState<string | null>(null);
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawing, setDrawing] = useState(false);

  if (ticket === undefined) return <DetailSkeleton />;
  if (!ticket) return <EmptyState title="OS não encontrada neste aparelho" />;

  const block = signatureBlock(ticket);
  // Sugestão: o contato cadastrado do local (o técnico pode trocar).
  const signer = name ?? ticket.location?.contact_name ?? "";

  async function confirm() {
    setError(null);
    const cleanName = signer.trim().replace(/\s+/g, " ");
    if (cleanName.length < 3) return setError("Informe o nome de quem assina.");
    const points = strokes.reduce((n, s) => n + s.length, 0);
    if (points < 8) return setError("Peça para o responsável assinar na área branca.");
    setBusy(true);
    try {
      const uri = await exportSignature(padRef, strokes, size);
      const position = await currentPosition();
      await queueSignature(String(ticketId), uri, {
        name: cleanName,
        role: role.trim() || null,
        latitude: position?.latitude ?? null,
        longitude: position?.longitude ?? null,
      });
      haptic.success();
      showSuccess("Assinatura salva", online ? "Agora você já pode concluir a OS." : "Salva no aparelho; será enviada quando houver conexão.");
      if (router.canGoBack()) router.back();
      else router.replace({ pathname: "/ticket/[id]", params: { id: String(ticketId) } });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  function clear() {
    setStrokes([]);
    setPadKey((k) => k + 1);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen options={{ title: "Assinatura" }} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled" scrollEnabled={!drawing}>
        <View style={{ gap: 4 }}>
          <Text style={styles.code}>{ticket.code}</Text>
          <Text style={styles.title}>Assinatura do responsável no local</Text>
          <Text style={styles.lead}>
            Confirma o atendimento realizado. Depois dela os formulários ficam travados e a OS pode ser concluída.
          </Text>
        </View>

        {block ? (
          <ErrorBox message={block} />
        ) : (
          <>
            {ticket.signed_at || pending ? (
              <Card style={styles.previous}>
                <Text style={styles.previousText}>
                  {pending
                    ? `Assinatura de ${pending.signer_name} aguardando envio. Uma nova assinatura substitui esta.`
                    : `Assinada por ${ticket.signer_name}${ticket.signer_role ? ` (${ticket.signer_role})` : ""} em ${formatDateTime(ticket.signed_at)}. Uma nova assinatura substitui a anterior.`}
                </Text>
              </Card>
            ) : null}
            <Card style={{ gap: 14 }}>
              <Field label="Nome de quem assina" required>
                <Input value={signer} onChangeText={setName} autoCapitalize="words" placeholder="Nome completo" />
              </Field>
              <Field label="Cargo / função">
                <Input value={role} onChangeText={setRole} autoCapitalize="sentences" placeholder="Ex.: Gerente da loja" />
              </Field>
            </Card>
            {/* Enquanto o dedo está na área de assinar, a tela não rola (o traço não vira rolagem). */}
            <View
              onTouchStart={() => setDrawing(true)}
              onTouchEnd={() => setDrawing(false)}
              onTouchCancel={() => setDrawing(false)}
            >
              <SignaturePad key={padKey} ref={padRef} onChange={setStrokes} onSize={setSize} />
            </View>
            <View style={styles.row}>
              <Button title="Limpar" onPress={clear} disabled={busy} style={{ flex: 1 }} />
              <Button title="Confirmar assinatura" variant="primary" onPress={() => void confirm()} loading={busy} style={{ flex: 2 }} />
            </View>
            {error ? <ErrorBox message={error} /> : null}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 16, gap: 14, maxWidth: 720, width: "100%", alignSelf: "center" },
    code: { fontSize: 12, fontWeight: "700", color: c.inkMuted, letterSpacing: 0.3 },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    lead: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    previous: { backgroundColor: c.surface2 },
    previousText: { fontSize: 13, color: c.inkMuted, lineHeight: 19 },
    row: { flexDirection: "row", gap: 10 },
  });
