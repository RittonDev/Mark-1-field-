import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorMessage } from "../../lib/api";
import { notify } from "../../lib/dialogs";
import { PART_STATUS, PART_UNITS } from "../../lib/field";
import { formatShort } from "../../lib/format";
import { haptic } from "../../lib/haptics";
import { enqueuePartRequest, isOnline, useSyncStatus } from "../../lib/sync";
import type { LocalPartRequest, LocalTicket } from "../../lib/syncTypes";
import { showToast } from "../../lib/toast";
import { RADIUS, tint, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { PressableScale, useListMotion } from "../motion";
import { Text } from "../Text";
import { Badge, Button, Card, ErrorBox, Field, Input, SectionTitle } from "../ui";

const MAX_PHOTOS = 4;
const PICKER: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.7, exif: false };

function useToneColor() {
  const c = useTheme();
  return (tone: (typeof PART_STATUS)[keyof typeof PART_STATUS]["tone"]) =>
    tone === "warning" ? c.warning : tone === "info" ? c.info : tone === "success" ? c.success : tone === "danger" ? c.danger : c.inkSubtle;
}

/** Peças pedidas em campo: viram orçamento, que o cliente aprova e assina antes da instalação. */
export function PartRequestsCard({ ticket, canRequest, onRequest }: { ticket: LocalTicket; canRequest: boolean; onRequest: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const motion = useListMotion();
  const toneColor = useToneColor();
  const requests = (ticket.part_requests ?? []) as LocalPartRequest[];
  if (!requests.length && !canRequest) return null;

  return (
    <Card style={{ gap: 12 }}>
      <SectionTitle
        right={
          canRequest ? <Button title="Pedir peça" icon="plus" compact variant="ghost" onPress={onRequest} /> : undefined
        }
      >
        Peças
      </SectionTitle>
      {requests.length === 0 ? (
        <Text style={styles.hint}>
          Precisa trocar alguma peça? Peça aqui com foto. Ela só é instalada com o orçamento aprovado e assinado pelo cliente.
        </Text>
      ) : (
        requests.map((request, i) => {
          const info = PART_STATUS[request.status] ?? PART_STATUS.open;
          const color = toneColor(info.tone);
          const approved = request.status === "approved";
          return (
            <Animated.View
              key={request.id}
              entering={motion.entering(i)}
              layout={motion.layout}
              style={[styles.row, approved && { backgroundColor: c.successSoft, borderColor: tint(c.success, "40") }]}
            >
              <View style={[styles.rowIcon, { backgroundColor: tint(color, "1a") }]}>
                <Icon name={approved ? "checkCircle" : "package"} size={18} color={color} strokeWidth={2} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={styles.rowTop}>
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    {request.description}
                  </Text>
                  <Text style={styles.qty}>
                    {String(Number(request.quantity)).replace(".", ",")} {request.unit}
                  </Text>
                </View>
                <View style={styles.badges}>
                  <Badge label={info.label} color={color} />
                  {request.pending ? <Badge label="Aguardando envio" color={c.inkSubtle} /> : null}
                </View>
                {request.note ? <Text style={styles.meta}>{request.note}</Text> : null}
                {request.quote_code ? <Text style={styles.meta}>Orçamento {request.quote_code}</Text> : null}
                {request.response_note ? <Text style={[styles.meta, { color: c.ink }]}>Central: {request.response_note}</Text> : null}
                <Text style={styles.when}>
                  Pedido {formatShort(request.created_at)}
                  {request.attachments?.length ? ` · ${request.attachments.length === 1 ? "1 foto" : `${request.attachments.length} fotos`}` : ""}
                </Text>
              </View>
            </Animated.View>
          );
        })
      )}
    </Card>
  );
}

/** Folha "Pedir peça": descrição, quantidade, unidade, observação e fotos da câmera. Funciona offline. */
export function PartRequestSheet({ ticket, onClose }: { ticket: LocalTicket; onClose: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const online = isOnline(useSyncStatus());
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [unit, setUnit] = useState<string>("un");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<{ uri: string; mimeType?: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function addPhoto(source: "camera" | "library") {
    try {
      let result: ImagePicker.ImagePickerResult;
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          notify("Câmera bloqueada", "Libere o acesso à câmera nas configurações do aparelho para fotografar a peça.");
          return;
        }
        result = await ImagePicker.launchCameraAsync(PICKER);
      } else {
        result = await ImagePicker.launchImageLibraryAsync({ ...PICKER, allowsMultipleSelection: true, selectionLimit: MAX_PHOTOS });
      }
      if (result.canceled) return;
      setPhotos((prev) => [...prev, ...result.assets.map((a) => ({ uri: a.uri, mimeType: a.mimeType }))].slice(0, MAX_PHOTOS));
    } catch (e) {
      notify("Não foi possível adicionar a foto", errorMessage(e));
    }
  }

  async function submit() {
    setError(null);
    if (description.trim().length < 2) return setError("Descreva a peça (modelo, medida ou código, se souber).");
    if (!Number.isFinite(quantity) || quantity <= 0) return setError("Informe a quantidade.");
    setBusy(true);
    try {
      await enqueuePartRequest(
        ticket.id,
        { description: description.trim(), quantity, unit, note: note.trim() || null },
        photos,
      );
      haptic.step();
      showToast(`${ticket.code}: pedido de peça registrado`, {
        tone: "success",
        description: online
          ? "A central monta o orçamento para o cliente aprovar. Você recebe um aviso quando puder instalar."
          : "Salvo no aparelho; será enviado com as fotos quando houver conexão.",
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.canvas }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.header, { paddingTop: Platform.OS === "android" ? insets.top + 12 : 20 }]}>
          <Text style={styles.title}>Pedir peça</Text>
          <Text style={styles.code}>{ticket.code}</Text>
          <Text style={styles.hint}>
            A central transforma o pedido em orçamento. A peça só é instalada depois que o cliente aprovar e assinar.
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Field label="Peça" required>
            <Input
              value={description}
              onChangeText={setDescription}
              placeholder="Ex.: Fonte 12V 5A para câmera"
              icon="package"
              autoFocus
            />
          </Field>
          <Field label="Quantidade" required>
            <View style={styles.qtyRow}>
              <PressableScale
                onPress={() => setQuantity((q) => Math.max(1, q - 1))}
                style={styles.qtyButton}
                pressedStyle={{ backgroundColor: c.surface2 }}
                accessibilityRole="button"
                accessibilityLabel="Diminuir quantidade"
              >
                <Icon name="minus" size={18} color={c.ink} strokeWidth={2.2} />
              </PressableScale>
              <Text style={styles.qtyValue} accessibilityLiveRegion="polite">
                {quantity}
              </Text>
              <PressableScale
                onPress={() => setQuantity((q) => Math.min(999, q + 1))}
                style={styles.qtyButton}
                pressedStyle={{ backgroundColor: c.surface2 }}
                accessibilityRole="button"
                accessibilityLabel="Aumentar quantidade"
              >
                <Icon name="plus" size={18} color={c.ink} strokeWidth={2.2} />
              </PressableScale>
            </View>
          </Field>
          <Field label="Unidade">
            <View style={styles.chips} accessibilityRole="radiogroup">
              {PART_UNITS.map((u) => {
                const selected = unit === u;
                return (
                  <Pressable
                    key={u}
                    onPress={() => {
                      haptic.select();
                      setUnit(u);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    style={[styles.chip, selected && styles.chipSelected]}
                  >
                    <Text style={[styles.chipText, selected && { color: c.brandInk }]}>{u}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Field>
          <Field label="Observação">
            <Input value={note} onChangeText={setNote} multiline placeholder="Opcional: onde fica, defeito, urgência" />
          </Field>
          <Field label="Fotos" hint={`Até ${MAX_PHOTOS}. Mostre a etiqueta ou o defeito; ajuda a central a cotar certo.`}>
            <View style={styles.photos}>
              {photos.map((p, i) => (
                <View key={p.uri} style={styles.thumbWrap}>
                  <Image source={{ uri: p.uri }} style={styles.thumb} accessibilityLabel={`Foto ${i + 1}`} />
                  <Pressable
                    onPress={() => setPhotos((prev) => prev.filter((x) => x.uri !== p.uri))}
                    style={styles.thumbRemove}
                    accessibilityRole="button"
                    accessibilityLabel={`Remover foto ${i + 1}`}
                    hitSlop={8}
                  >
                    <Icon name="close" size={12} color={c.canvas} strokeWidth={2.6} />
                  </Pressable>
                </View>
              ))}
              {photos.length < MAX_PHOTOS ? (
                <PressableScale
                  onPress={() => void addPhoto("camera")}
                  style={styles.addPhoto}
                  pressedStyle={{ backgroundColor: c.surface2 }}
                  accessibilityRole="button"
                  accessibilityLabel="Tirar foto da peça"
                >
                  <Icon name="camera" size={22} color={c.brandInk} />
                  <Text style={styles.addPhotoText}>Câmera</Text>
                </PressableScale>
              ) : null}
            </View>
            {photos.length < MAX_PHOTOS ? (
              <Pressable onPress={() => void addPhoto("library")} accessibilityRole="button" hitSlop={6}>
                <Text style={styles.link}>Escolher da galeria</Text>
              </Pressable>
            ) : null}
          </Field>
          {error ? <ErrorBox message={error} /> : null}
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <Button title="Voltar" onPress={onClose} disabled={busy} style={{ flex: 1 }} />
          <Button title="Enviar pedido" icon="package" variant="primary" onPress={() => void submit()} loading={busy} style={{ flex: 1.4 }} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    hint: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    row: {
      flexDirection: "row",
      gap: 12,
      padding: 12,
      borderRadius: RADIUS.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      backgroundColor: c.surface2,
    },
    rowIcon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
    rowTop: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
    rowTitle: { flex: 1, fontSize: 15, fontWeight: "600", color: c.ink, lineHeight: 20 },
    qty: { fontSize: 13, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    meta: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    when: { fontSize: 12, color: c.inkSubtle, fontVariant: ["tabular-nums"] },
    header: {
      paddingHorizontal: 20,
      paddingBottom: 14,
      gap: 6,
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
    },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    code: { fontSize: 12, fontWeight: "700", color: c.inkMuted },
    body: { padding: 20, gap: 16 },
    qtyRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    qtyButton: {
      width: 44,
      height: 44,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    qtyValue: { minWidth: 40, textAlign: "center", fontSize: 20, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      paddingHorizontal: 14,
      height: 36,
      borderRadius: RADIUS.chip,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    chipSelected: { borderColor: c.primary, backgroundColor: c.primarySoft },
    chipText: { fontSize: 14, fontWeight: "600", color: c.ink },
    photos: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    thumbWrap: { width: 76, height: 76 },
    thumb: { width: 76, height: 76, borderRadius: RADIUS.control, backgroundColor: c.surface3 },
    thumbRemove: {
      position: "absolute",
      top: -6,
      right: -6,
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: c.ink,
      alignItems: "center",
      justifyContent: "center",
    },
    addPhoto: {
      width: 76,
      height: 76,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: c.primary,
      backgroundColor: c.primarySoft,
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
    },
    addPhotoText: { fontSize: 12, fontWeight: "600", color: c.brandInk },
    link: { fontSize: 13, fontWeight: "600", color: c.brandInk, marginTop: 8 },
    footer: {
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 20,
      paddingTop: 12,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
  });
