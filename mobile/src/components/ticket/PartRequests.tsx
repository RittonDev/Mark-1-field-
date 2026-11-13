import type { ImagePickerAsset } from "expo-image-picker";
import { memo, useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LinearTransition, useReducedMotion } from "react-native-reanimated";
import { errorMessage } from "../../lib/api";
import { confirmAction } from "../../lib/dialogs";
import { dayMonth, PART_STATUS, PART_UNITS } from "../../lib/field";
import { formatTime } from "../../lib/format";
import { haptic } from "../../lib/haptics";
import { enqueuePartRequest, isOnline, useSyncStatus } from "../../lib/sync";
import type { LocalPartRequest, LocalTicket } from "../../lib/syncTypes";
import { showToast } from "../../lib/toast";
import { RADIUS, tint, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { PressableScale } from "../motion";
import { Text } from "../Text";
import { Badge, Button, Card, ErrorBox, Field, Input, SectionTitle } from "../ui";
import { capturePhotos } from "./photoCapture";
import { SheetScaffold } from "./SheetScaffold";
import { toneInk } from "./tones";

const MAX_PHOTOS = 4;
/** Até 9.999 com 3 casas (o servidor guarda decimal). */
const MAX_QTY = 9999;

type PartTone = (typeof PART_STATUS)[keyof typeof PART_STATUS]["tone"];

function useToneColor() {
  const c = useTheme();
  return (tone: PartTone) => (tone === "muted" ? c.inkMuted : toneInk(c, tone));
}

/** "2,5" → 2.5; vazio, zero ou inválido → null. */
function parseQty(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : null;
}

const formatQtyText = (n: number) => String(Math.round(n * 1000) / 1000).replace(".", ",");

/** Peças pedidas em campo: viram orçamento, que o cliente aprova e assina antes da instalação. */
export const PartRequestsCard = memo(function PartRequestsCard({
  ticket,
  canRequest,
  onRequest,
}: {
  ticket: LocalTicket;
  canRequest: boolean;
  onRequest: () => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const reduced = useReducedMotion();
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
        requests.map((request) => {
          const info = PART_STATUS[request.status] ?? PART_STATUS.open;
          const color = toneColor(info.tone);
          const approved = request.status === "approved";
          return (
            <Animated.View
              key={request.id}
              entering={reduced ? undefined : FadeIn.duration(200)}
              layout={reduced ? undefined : LinearTransition.duration(200)}
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
                  {request.pending ? <Badge label="Aguardando envio" color={c.inkMuted} /> : null}
                </View>
                {request.note ? <Text style={styles.meta}>{request.note}</Text> : null}
                {request.quote_code ? <Text style={styles.meta}>Orçamento {request.quote_code}</Text> : null}
                {request.response_note ? <Text style={[styles.meta, { color: c.ink }]}>Central: {request.response_note}</Text> : null}
                <Text style={styles.when}>
                  Pedido em {dayMonth(request.created_at)} às {formatTime(request.created_at)}
                  {request.attachments?.length ? ` · ${request.attachments.length === 1 ? "1 foto" : `${request.attachments.length} fotos`}` : ""}
                </Text>
              </View>
            </Animated.View>
          );
        })
      )}
    </Card>
  );
});

export interface PartPhoto {
  uri: string;
  mimeType?: string | null;
}

const toPartPhoto = (asset: Pick<ImagePickerAsset, "uri" | "mimeType">): PartPhoto => ({ uri: asset.uri, mimeType: asset.mimeType });

/**
 * Folha "Pedir peça": descrição, quantidade (aceita decimal: 2,5 m de cabo), unidade, observação e
 * fotos. Funciona offline. `initialPhotos`: foto recuperada depois de o Android fechar o app.
 */
export function PartRequestSheet({
  ticket,
  initialPhotos,
  onClose,
}: {
  ticket: LocalTicket;
  initialPhotos?: PartPhoto[];
  onClose: () => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const online = isOnline(useSyncStatus());
  const [open, setOpen] = useState(true);
  const [description, setDescription] = useState("");
  const [qtyText, setQtyText] = useState("1");
  const [unit, setUnit] = useState<string>("un");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<PartPhoto[]>(() => (initialPhotos ?? []).slice(0, MAX_PHOTOS));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const step = unit === "m" ? 0.5 : 1;
  const room = MAX_PHOTOS - photos.length;

  async function requestClose() {
    if (busy) return;
    const filled = description.trim() || note.trim() || photos.length || qtyText.trim() !== "1";
    if (filled) {
      const ok = await confirmAction("Descartar o pedido?", "A descrição e as fotos deste pedido serão perdidas.", {
        confirmText: "Descartar",
        cancelText: "Continuar",
        destructive: true,
      });
      if (!ok) return;
    }
    setOpen(false);
  }

  function bump(delta: number) {
    haptic.select();
    const current = parseQty(qtyText) ?? 0;
    setQtyText(formatQtyText(Math.min(MAX_QTY, Math.max(step, current + delta))));
  }

  async function addPhoto(source: "camera" | "library") {
    if (room <= 0) return;
    setPhotoBusy(true);
    const assets = await capturePhotos(source, { kind: "part", ticketId: ticket.id }, source === "library" ? room : 1);
    setPhotoBusy(false);
    if (assets.length) setPhotos((prev) => [...prev, ...assets.map(toPartPhoto)].slice(0, MAX_PHOTOS));
  }

  async function submit() {
    setError(null);
    if (description.trim().length < 2) return setError("Descreva a peça (modelo, medida ou código, se souber).");
    const quantity = parseQty(qtyText);
    if (quantity === null) return setError("Informe a quantidade (ex.: 2 ou 2,5).");
    if (quantity > MAX_QTY) return setError(`A quantidade máxima é ${MAX_QTY}.`);
    setBusy(true);
    try {
      await enqueuePartRequest(ticket.id, { description: description.trim(), quantity, unit, note: note.trim() || null }, photos);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    haptic.step();
    showToast(`${ticket.code}: pedido de peça registrado`, {
      tone: "success",
      description: online
        ? "A central monta o orçamento para o cliente aprovar. Você recebe um aviso quando puder instalar."
        : "Salvo no aparelho; vai para a central com as fotos quando houver conexão.",
    });
    setOpen(false);
  }

  return (
    <SheetScaffold
      visible={open}
      title="Pedir peça"
      code={ticket.code}
      description="A central transforma o pedido em orçamento. A peça só é instalada depois que o cliente aprovar e assinar."
      onRequestClose={() => void requestClose()}
      onClosed={onClose}
      footer={
        <>
          <Button title="Voltar" onPress={() => void requestClose()} disabled={busy} style={{ flex: 1 }} />
          <Button title="Enviar pedido" icon="package" variant="primary" onPress={() => void submit()} loading={busy} style={{ flex: 1.4 }} />
        </>
      }
    >
      <Field label="Peça" required>
        <Input
          value={description}
          onChangeText={setDescription}
          placeholder="Ex.: Fonte 12V 5A para câmera"
          icon="package"
          autoFocus={!initialPhotos?.length}
        />
      </Field>
      <Field label="Quantidade" required hint={unit === "m" ? "Aceita meio metro: 2,5." : undefined}>
        <View style={styles.qtyRow}>
          <PressableScale
            onPress={() => bump(-step)}
            style={styles.qtyButton}
            pressedStyle={{ backgroundColor: c.surface2 }}
            accessibilityRole="button"
            accessibilityLabel="Diminuir quantidade"
          >
            <Icon name="minus" size={20} color={c.ink} strokeWidth={2.2} />
          </PressableScale>
          <Input
            value={qtyText}
            onChangeText={(text) => setQtyText(text.replace(/[^\d.,]/g, ""))}
            keyboardType="decimal-pad"
            selectTextOnFocus
            maxLength={9}
            accessibilityLabel={`Quantidade em ${unit}`}
            style={styles.qtyInput}
          />
          <PressableScale
            onPress={() => bump(step)}
            style={styles.qtyButton}
            pressedStyle={{ backgroundColor: c.surface2 }}
            accessibilityRole="button"
            accessibilityLabel="Aumentar quantidade"
          >
            <Icon name="plus" size={20} color={c.ink} strokeWidth={2.2} />
          </PressableScale>
        </View>
      </Field>
      <Field label="Unidade">
        <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Unidade">
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
                accessibilityState={{ checked: selected }}
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
              <Image source={{ uri: p.uri }} style={styles.thumb} resizeMethod="resize" accessibilityLabel={`Foto ${i + 1}`} />
              <Pressable
                onPress={() => setPhotos((prev) => prev.filter((x) => x.uri !== p.uri))}
                style={styles.thumbRemove}
                accessibilityRole="button"
                accessibilityLabel={`Remover foto ${i + 1}`}
                hitSlop={10}
              >
                <Icon name="close" size={14} color="#fff" strokeWidth={2.6} />
              </Pressable>
            </View>
          ))}
          {room > 0 ? (
            <>
              <PressableScale
                onPress={() => void addPhoto("camera")}
                disabled={photoBusy}
                style={styles.addPhoto}
                pressedStyle={{ backgroundColor: c.surface2 }}
                accessibilityRole="button"
                accessibilityLabel="Tirar foto da peça"
              >
                <Icon name="camera" size={22} color={c.brandInk} />
                <Text style={styles.addPhotoText}>Câmera</Text>
              </PressableScale>
              <PressableScale
                onPress={() => void addPhoto("library")}
                disabled={photoBusy}
                style={styles.addPhoto}
                pressedStyle={{ backgroundColor: c.surface2 }}
                accessibilityRole="button"
                accessibilityLabel="Escolher fotos da galeria"
              >
                <Icon name="plus" size={22} color={c.brandInk} />
                <Text style={styles.addPhotoText}>Galeria</Text>
              </PressableScale>
            </>
          ) : null}
        </View>
      </Field>
      {error ? <ErrorBox message={error} /> : null}
    </SheetScaffold>
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
    when: { fontSize: 13, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    qtyRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    qtyButton: {
      width: 48,
      height: 48,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    qtyInput: { width: 104, textAlign: "center", fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      paddingHorizontal: 16,
      minWidth: 48,
      height: 44,
      borderRadius: RADIUS.chip,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    chipSelected: { borderColor: c.primary, backgroundColor: c.primarySoft },
    chipText: { fontSize: 15, fontWeight: "600", color: c.ink },
    photos: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    thumbWrap: { width: 76, height: 76 },
    thumb: { width: 76, height: 76, borderRadius: RADIUS.control, backgroundColor: c.surface3 },
    thumbRemove: {
      position: "absolute",
      top: -8,
      right: -8,
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: "#1B1F26E6",
      borderWidth: 1.5,
      borderColor: c.surface,
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
  });
