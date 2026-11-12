import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useState } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { absoluteApiUrl, api, errorMessage } from "../../lib/api";
import { useLiveQuery } from "../../lib/changes";
import { confirmAction, notify } from "../../lib/dialogs";
import { listPhotos } from "../../lib/db";
import { formatDateTime } from "../../lib/format";
import { discardPhoto, isOnline, queuePhoto, useSyncStatus } from "../../lib/sync";
import type { LocalTicket } from "../../lib/syncTypes";
import type { Attachment } from "../../lib/types";
import { Badge, Button, Card, colors, EmptyState, ErrorBox, SectionTitle } from "../ui";

const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.7, exif: false };

/**
 * Fotos tiradas em campo ficam numa fila no aparelho e sobem por
 * POST /tickets/{id}/attachments (kind=photo) quando houver conexão.
 */
export function PhotosPanel({ ticket }: { ticket: LocalTicket }) {
  const load = useCallback(() => listPhotos(ticket.id), [ticket.id]);
  const pending = useLiveQuery(load);
  const online = isOnline(useSyncStatus());
  const [remote, setRemote] = useState<{ ticketId: string; items: Attachment[] } | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingCount = pending?.length ?? 0;

  useEffect(() => {
    if (!online) return;
    let alive = true;
    api.get<Attachment[]>(`/tickets/${ticket.id}/attachments`).then(
      (items) => {
        if (!alive) return;
        setRemote({ ticketId: ticket.id, items });
        setRemoteError(null);
      },
      (error: unknown) => {
        if (alive) setRemoteError(errorMessage(error));
      },
    );
    return () => {
      alive = false;
    };
    // updated_at muda quando chega um anexo novo (evento + pull); pendingCount, quando uma foto sobe.
  }, [ticket.id, ticket.updated_at, online, pendingCount]);

  async function pick(source: "camera" | "library") {
    setBusy(true);
    try {
      let result: ImagePicker.ImagePickerResult;
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          notify("Câmera bloqueada", "Libere o acesso à câmera nas configurações do aparelho para fotografar o atendimento.");
          return;
        }
        result = await ImagePicker.launchCameraAsync(PICKER_OPTIONS);
      } else {
        result = await ImagePicker.launchImageLibraryAsync({ ...PICKER_OPTIONS, allowsMultipleSelection: true, selectionLimit: 5 });
      }
      if (result.canceled) return;
      for (const asset of result.assets) await queuePhoto(ticket.id, asset.uri, asset.mimeType);
    } catch (error) {
      notify("Não foi possível adicionar a foto", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function confirmDiscard(id: string, uri: string) {
    void confirmAction("Remover foto?", "Ela ainda não foi enviada e será apagada do aparelho.", {
      confirmText: "Remover",
      destructive: true,
    }).then((ok) => {
      if (ok) void discardPhoto(id, uri);
    });
  }

  const photos = remote?.ticketId === ticket.id ? remote.items.filter((a) => a.kind === "photo") : [];

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.actions}>
        <Button title="Tirar foto" variant="primary" onPress={() => void pick("camera")} disabled={busy} style={{ flex: 1 }} />
        <Button title="Da galeria" onPress={() => void pick("library")} disabled={busy} style={{ flex: 1 }} />
      </View>

      {pending && pending.length > 0 ? (
        <Card style={{ gap: 10 }}>
          <SectionTitle>Aguardando envio</SectionTitle>
          {pending.map((photo) => (
            <View key={photo.id} style={styles.pendingRow}>
              <Image source={{ uri: photo.file_uri }} style={styles.thumb} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {photo.filename}
                </Text>
                <Badge label={online ? "Enviando…" : "Sem conexão"} color={colors.warning} />
                {photo.last_error ? <Text style={styles.error}>Última tentativa: {photo.last_error}</Text> : null}
              </View>
              <Button compact title="Remover" variant="ghost" onPress={() => confirmDiscard(photo.id, photo.file_uri)} />
            </View>
          ))}
        </Card>
      ) : null}

      <SectionTitle>Fotos da OS</SectionTitle>
      {!online ? (
        <EmptyState title="Sem conexão" description="As fotos já enviadas aparecem quando o aparelho voltar a ficar online." />
      ) : remoteError ? (
        <ErrorBox message={remoteError} />
      ) : remote === null ? null : photos.length === 0 ? (
        <EmptyState title="Nenhuma foto enviada ainda" />
      ) : (
        <View style={styles.grid}>
          {photos.map((photo) => {
            const url = absoluteApiUrl(photo.download_url);
            return (
              <Pressable
                key={photo.id}
                onPress={() => url && void Linking.openURL(url)}
                accessibilityRole="imagebutton"
                accessibilityLabel={`Foto ${photo.filename}`}
                style={styles.tile}
              >
                {url ? <Image source={{ uri: url }} style={styles.tileImage} /> : null}
                <Text style={styles.tileText} numberOfLines={1}>
                  {photo.uploaded_by?.name ?? ""} · {formatDateTime(photo.created_at)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: 10 },
  pendingRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: colors.line },
  name: { fontSize: 13, color: colors.ink },
  error: { fontSize: 12, color: colors.danger },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: { width: "48%", gap: 4 },
  tileImage: { width: "100%", aspectRatio: 1, borderRadius: 10, backgroundColor: colors.line },
  tileText: { fontSize: 11, color: colors.inkMuted },
});
