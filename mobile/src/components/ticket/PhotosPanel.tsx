import { memo, useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { absoluteApiUrl, errorMessage } from "../../lib/api";
import type { PendingPhoto } from "../../lib/db";
import { confirmAction, notify } from "../../lib/dialogs";
import { dayMonth } from "../../lib/field";
import { formatTime } from "../../lib/format";
import { discardPhoto, isOnline, queuePhoto, requestSync, useSyncStatus } from "../../lib/sync";
import type { LocalTicket } from "../../lib/syncTypes";
import type { Attachment } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { Button, Card, EmptyState, ErrorBox, SectionTitle } from "../ui";
import { attachmentsStale, reloadAttachments } from "./attachments";
import { capturePhotos } from "./photoCapture";
import { PhotoViewer, type ViewerPhoto } from "./PhotoViewer";

const LIBRARY_LIMIT = 10;

/** De onde é a foto da fila: campo de formulário, pedido de peça ou avulsa. */
function origin(ticket: LocalTicket, photo: PendingPhoto): string {
  if (photo.part_op_id) return "Pedido de peça";
  if (photo.form_id) {
    const form = (ticket.forms ?? []).find((f) => f.id === photo.form_id);
    const field = form?.fields.find((f) => f.id === photo.field_id);
    return form ? [form.name, field?.label].filter(Boolean).join(" · ") : "Formulário";
  }
  return "Foto avulsa";
}

/**
 * Fotos do atendimento. As tiradas em campo ficam numa fila no aparelho e sobem por
 * POST /tickets/{id}/attachments (kind=photo) quando houver conexão; as já enviadas vêm da lista
 * guardada no aparelho (aparecem também offline). Tocar abre a foto no próprio app.
 * A tela da OS passa a fila (`pending`) e a lista guardada (`cached`); undefined = ainda lendo.
 */
export const PhotosPanel = memo(function PhotosPanel({
  ticket,
  pending,
  cached,
}: {
  ticket: LocalTicket;
  pending: PendingPhoto[] | undefined;
  cached: Attachment[] | undefined;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const sync = useSyncStatus();
  const online = isOnline(sync);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ list: "sent" | "queue"; index: number } | null>(null);
  const pendingCount = pending?.length ?? 0;
  const previousPending = useRef(pendingCount);

  // Atualiza a lista do servidor ao abrir, quando a OS muda (anexo novo) e quando a conexão volta.
  useEffect(() => {
    if (!online) return;
    let alive = true;
    reloadAttachments(ticket.id).then(
      () => {
        if (alive) setLoadError(null);
      },
      (error: unknown) => {
        if (alive) setLoadError(errorMessage(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [ticket.id, ticket.updated_at, online]);

  // Uma foto da fila acabou de subir: busca de novo para ela aparecer entre as enviadas.
  useEffect(() => {
    const before = previousPending.current;
    previousPending.current = pendingCount;
    if (online && pendingCount < before) reloadAttachments(ticket.id).catch(() => undefined);
  }, [pendingCount, online, ticket.id]);

  async function pick(source: "camera" | "library") {
    setBusy(true);
    try {
      const assets = await capturePhotos(source, { kind: "loose", ticketId: ticket.id }, source === "library" ? LIBRARY_LIMIT : 1);
      for (const asset of assets) await queuePhoto(ticket.id, asset.uri, asset.mimeType);
    } catch (error) {
      notify("Não foi possível guardar a foto", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function confirmDiscard(photo: PendingPhoto) {
    const message = photo.form_id
      ? "Ela ainda não foi enviada e será apagada do aparelho. O formulário pode voltar a ficar incompleto."
      : photo.part_op_id
        ? "Ela ainda não foi enviada e será apagada do aparelho. O pedido de peça segue sem ela."
        : "Ela ainda não foi enviada e será apagada do aparelho.";
    void confirmAction("Remover foto?", message, { confirmText: "Remover", destructive: true }).then((ok) => {
      if (ok) void discardPhoto(photo.id, photo.file_uri);
    });
  }

  async function openSent(index: number) {
    // Os links das fotos vencem: lista antiga é atualizada antes de abrir.
    if (online && attachmentsStale(ticket.id)) await reloadAttachments(ticket.id).catch(() => undefined);
    setViewer({ list: "sent", index });
  }

  const sent = (cached ?? []).filter((a) => a.kind === "photo");
  const queue = pending ?? [];
  const viewerPhotos: ViewerPhoto[] =
    viewer?.list === "queue"
      ? queue.map((p) => ({ key: p.id, uri: p.file_uri, caption: `${origin(ticket, p)} · aguardando envio` }))
      : sent.map((a) => ({
          key: a.id,
          uri: absoluteApiUrl(a.download_url) ?? "",
          caption: [a.description, a.uploaded_by?.name, `${dayMonth(a.created_at)} ${formatTime(a.created_at)}`].filter(Boolean).join(" · "),
        }));
  const failed = queue.some((p) => p.attempts > 0);

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.actions}>
        <Button title="Tirar foto" icon="camera" variant="primary" onPress={() => void pick("camera")} disabled={busy} style={{ flex: 1 }} />
        <Button title="Da galeria" onPress={() => void pick("library")} disabled={busy} style={{ flex: 1 }} />
      </View>

      {queue.length > 0 ? (
        <Card style={{ gap: 12 }}>
          <SectionTitle
            accent
            right={
              <Button
                title="Enviar agora"
                icon="repeat"
                compact
                variant="ghost"
                onPress={() => void requestSync({ manual: true })}
                disabled={!online || sync.syncing}
                loading={sync.syncing}
              />
            }
          >
            Aguardando envio
          </SectionTitle>
          {!online ? <Text style={styles.note}>Sem conexão: as fotos ficam guardadas e sobem quando a conexão voltar.</Text> : null}
          {queue.map((photo, i) => {
            const state =
              photo.attempts > 0
                ? `Falhou ${photo.attempts}x${photo.last_error ? `: ${photo.last_error}` : ""}. Nova tentativa automática.`
                : !online
                  ? "Sem conexão: envia quando voltar"
                  : sync.syncing
                    ? "Enviando…"
                    : "Na fila";
            return (
              <View key={photo.id} style={styles.pendingRow}>
                <Pressable
                  onPress={() => setViewer({ list: "queue", index: i })}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={`Foto de ${origin(ticket, photo)}, tirada às ${formatTime(photo.created_at)}. Toque para ampliar`}
                >
                  <Image source={{ uri: photo.file_uri }} style={styles.thumb} resizeMethod="resize" />
                </Pressable>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name}>Tirada às {formatTime(photo.created_at)}</Text>
                  <Text style={styles.meta} numberOfLines={2}>
                    {origin(ticket, photo)}
                  </Text>
                  <Text style={[styles.meta, photo.attempts > 0 && styles.failed]} numberOfLines={3}>
                    {state}
                  </Text>
                </View>
                <Button compact title="Remover" variant="ghost" onPress={() => confirmDiscard(photo)} />
              </View>
            );
          })}
          {failed ? (
            <Text style={styles.note}>Se continuar falhando, confira a conexão ou toque em Enviar agora.</Text>
          ) : null}
        </Card>
      ) : null}

      <SectionTitle>Fotos da OS</SectionTitle>
      {!online ? <Text style={styles.note}>Sem conexão: fotos novas da OS aparecem quando a conexão voltar.</Text> : null}
      {online && loadError && !sent.length ? <ErrorBox message={loadError} /> : null}
      {cached === undefined ? null : sent.length === 0 ? (
        <EmptyState icon="camera" title="Nenhuma foto enviada ainda" description="Fotografe o antes e o depois do atendimento." />
      ) : (
        <View style={styles.grid}>
          {sent.map((photo, i) => {
            const url = absoluteApiUrl(photo.download_url);
            return (
              <Pressable
                key={photo.id}
                onPress={() => void openSent(i)}
                accessibilityRole="imagebutton"
                accessibilityLabel={`Foto ${i + 1}${photo.description ? `, ${photo.description}` : ""}. Toque para ampliar`}
                style={styles.tile}
              >
                {url ? (
                  <Image source={{ uri: url }} style={styles.tileImage} resizeMethod="resize" />
                ) : (
                  <View style={[styles.tileImage, styles.tileMissing]}>
                    <Icon name="camera" size={22} color={c.inkMuted} />
                  </View>
                )}
                <Text style={styles.tileText} numberOfLines={1}>
                  {[photo.uploaded_by?.name, `${dayMonth(photo.created_at)} ${formatTime(photo.created_at)}`].filter(Boolean).join(" · ")}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      <PhotoViewer
        photos={viewerPhotos}
        index={viewer?.index ?? null}
        onChange={(index) => setViewer(index === null || !viewer ? null : { ...viewer, index })}
      />
    </View>
  );
});

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    actions: { flexDirection: "row", gap: 10 },
    pendingRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    thumb: { width: 64, height: 64, borderRadius: RADIUS.control, backgroundColor: c.line },
    name: { fontSize: 14, fontWeight: "600", color: c.ink },
    meta: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    failed: { color: c.danger, fontWeight: "600" },
    note: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    tile: { width: "48%", gap: 4 },
    tileImage: { width: "100%", aspectRatio: 1, borderRadius: RADIUS.control, backgroundColor: c.line },
    tileMissing: { alignItems: "center", justifyContent: "center" },
    tileText: { fontSize: 12, color: c.inkMuted },
  });
