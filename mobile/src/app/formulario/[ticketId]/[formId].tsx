import * as ImagePicker from "expo-image-picker";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FieldInput } from "../../../components/forms/FieldInput";
import { Badge, Button, Card, EmptyState, ErrorBox } from "../../../components/ui";
import { errorMessage } from "../../../lib/api";
import { useLiveQuery } from "../../../lib/changes";
import { getAttachmentsCache, getFormError, getTicket, listPhotos, listSignatures, type PendingPhoto } from "../../../lib/db";
import { confirmAction, notify } from "../../../lib/dialogs";
import { formsLocked, isInputField, missingItems, normalizeAnswer, photoCounts, photoNeed } from "../../../lib/forms";
import {
  deleteFormPhoto,
  discardPhoto,
  enqueueFormAnswers,
  isOnline,
  queuePhoto,
  refreshAttachments,
  useSyncStatus,
} from "../../../lib/sync";
import type { LocalTicket } from "../../../lib/syncTypes";
import { showToast } from "../../../lib/toast";
import type { Attachment, FormAnswer, TicketForm } from "../../../lib/types";
import { useStyles, useTheme, type Palette } from "../../../theme/theme";

const STATUS_LABEL = { pending: "Não iniciado", in_progress: "Em preenchimento", completed: "Concluído" } as const;

export default function FormScreen() {
  const { ticketId, formId } = useLocalSearchParams<{ ticketId: string; formId: string }>();
  const c = useTheme();
  const load = useCallback(() => getTicket(String(ticketId)), [ticketId]);
  const ticket = useLiveQuery(load);

  if (ticket === undefined) return <ActivityIndicator style={{ marginTop: 40 }} color={c.primary} />;
  const form = ticket?.forms?.find((f) => f.id === formId);
  if (!ticket || !form) {
    return <EmptyState title="Formulário não encontrado" description="Ele pode ter sido removido da OS pelo analista." />;
  }
  return <FormEditor key={form.id} ticket={ticket} form={form} />;
}

function FormEditor({ ticket, form }: { ticket: LocalTicket; form: TicketForm }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const online = isOnline(useSyncStatus());
  const [draft, setDraft] = useState<Record<string, FormAnswer | null>>(() => ({ ...form.answers }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"save" | "complete" | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  const loadPhotos = useCallback(() => listPhotos(ticket.id), [ticket.id]);
  const loadAttachments = useCallback(() => getAttachmentsCache(ticket.id), [ticket.id]);
  const loadSignatures = useCallback(() => listSignatures(ticket.id), [ticket.id]);
  const loadError = useCallback(() => getFormError(form.id), [form.id]);
  const pendingPhotos = (useLiveQuery(loadPhotos) ?? []).filter((p) => p.form_id === form.id);
  const attachments = (useLiveQuery(loadAttachments) ?? []).filter((a) => a.form_id === form.id);
  const pendingSignature = (useLiveQuery(loadSignatures) ?? []).length > 0;
  const serverError = useLiveQuery(loadError);
  const locked = formsLocked(ticket, pendingSignature);

  // Online, atualiza a lista de anexos (fotos já enviadas de cada campo) e guarda para usar offline.
  useEffect(() => {
    if (online) refreshAttachments(ticket.id).catch(() => undefined);
  }, [online, ticket.id]);

  const counts = photoCounts(form.id, attachments, pendingPhotos);
  const normalized = useMemo(() => {
    const out: Record<string, FormAnswer | null> = {};
    for (const field of form.fields) if (isInputField(field)) out[field.id] = normalizeAnswer(field, draft[field.id]);
    return out;
  }, [draft, form.fields]);
  const missing = missingItems(form, counts, normalized);
  const dirty = form.fields.some(
    (f) => isInputField(f) && JSON.stringify(normalized[f.id] ?? null) !== JSON.stringify(form.answers[f.id] ?? null),
  );

  async function submit(complete: boolean) {
    setError(null);
    if (complete && missing.length) {
      setError(`Falta preencher: ${missing.join("; ")}`);
      return;
    }
    setSaving(complete ? "complete" : "save");
    try {
      await enqueueFormAnswers(ticket.id, { form_id: form.id, answers: normalized, complete });
      showToast(complete ? "Formulário concluído" : "Respostas salvas", {
        tone: "success",
        description: online ? undefined : "Salvo no aparelho; será enviado quando houver conexão.",
      });
      if (complete) router.back();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  async function addPhoto(fieldId: string, source: "camera" | "library") {
    setPhotoBusy(true);
    try {
      const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.7, exif: false };
      let result: ImagePicker.ImagePickerResult;
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          notify("Câmera bloqueada", "Libere o acesso à câmera nas configurações do aparelho.");
          return;
        }
        result = await ImagePicker.launchCameraAsync(options);
      } else {
        result = await ImagePicker.launchImageLibraryAsync(options);
      }
      if (result.canceled) return;
      for (const asset of result.assets) await queuePhoto(ticket.id, asset.uri, asset.mimeType, { formId: form.id, fieldId });
    } catch (e) {
      notify("Não foi possível adicionar a foto", errorMessage(e));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removeServerPhoto(attachment: Attachment) {
    if (!online) {
      notify("Sem conexão", "Para remover uma foto já enviada é preciso estar online.");
      return;
    }
    const ok = await confirmAction("Remover foto?", "A foto será apagada da OS.", { confirmText: "Remover", destructive: true });
    if (!ok) return;
    try {
      await deleteFormPhoto(ticket.id, form.id, attachment.id);
    } catch (e) {
      notify("Não foi possível remover", errorMessage(e));
    }
  }

  async function removePendingPhoto(photo: PendingPhoto) {
    const ok = await confirmAction("Remover foto?", "Ela ainda não foi enviada e será apagada do aparelho.", {
      confirmText: "Remover",
      destructive: true,
    });
    if (ok) await discardPhoto(photo.id, photo.file_uri);
  }

  const required = form.fields.filter((f) => f.type !== "section" && (f.required || (f.type === "photo" && photoNeed(f) > 0)));
  const doneCount = required.length - missing.length;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <Stack.Screen options={{ title: form.name }} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 120 }]} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 8 }}>
          <Text style={styles.code}>{ticket.code}</Text>
          <Text style={styles.title}>{form.name}</Text>
          <View style={styles.badges}>
            <Badge
              label={STATUS_LABEL[form.status]}
              color={form.status === "completed" ? c.success : form.status === "in_progress" ? c.warning : c.inkMuted}
            />
            {form.required ? <Badge label="Obrigatório" color={c.danger} /> : <Badge label="Opcional" color={c.inkMuted} />}
          </View>
          {required.length ? (
            <View style={{ gap: 6 }}>
              <Text style={styles.meta}>
                {doneCount} de {required.length} itens obrigatórios
              </Text>
              <View style={styles.progressTrack}>
                <View style={[styles.progressBar, { width: `${Math.round((doneCount / required.length) * 100)}%` }]} />
              </View>
            </View>
          ) : null}
        </Card>

        {locked ? (
          <Card style={styles.lockedCard}>
            <Text style={styles.lockedText}>
              {ticket.signed_at || pendingSignature
                ? "A assinatura do responsável já foi colhida: o formulário não pode mais ser alterado."
                : "A OS foi concluída: o formulário não pode mais ser alterado."}
            </Text>
          </Card>
        ) : null}
        {serverError && form.status !== "completed" ? <ErrorBox message={`O servidor não concluiu: ${serverError}`} /> : null}

        <Card style={{ gap: 20 }}>
          {form.fields.map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              value={draft[field.id]}
              onChange={(value) => setDraft((d) => ({ ...d, [field.id]: value }))}
              disabled={locked}
              photos={
                field.type === "photo"
                  ? {
                      server: attachments.filter((a) => a.field_id === field.id),
                      pending: pendingPhotos.filter((p) => p.field_id === field.id),
                    }
                  : undefined
              }
              onAddPhoto={(source) => void addPhoto(field.id, source)}
              onRemoveServerPhoto={(a) => void removeServerPhoto(a)}
              onRemovePendingPhoto={(p) => void removePendingPhoto(p)}
              photoBusy={photoBusy}
            />
          ))}
        </Card>
        {error ? <ErrorBox message={error} /> : null}
      </ScrollView>

      {!locked ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <Button title="Salvar" onPress={() => void submit(false)} loading={saving === "save"} disabled={!!saving || !dirty} style={{ flex: 1 }} />
          <Button
            title={form.status === "completed" && !dirty ? "Concluído" : "Concluir"}
            variant="primary"
            onPress={() => void submit(true)}
            loading={saving === "complete"}
            disabled={!!saving || (form.status === "completed" && !dirty)}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    content: { padding: 16, gap: 14, maxWidth: 720, width: "100%", alignSelf: "center" },
    code: { fontSize: 12, fontWeight: "700", color: c.inkMuted, letterSpacing: 0.3 },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    badges: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
    meta: { fontSize: 13, color: c.inkMuted },
    progressTrack: { height: 6, borderRadius: 3, backgroundColor: c.segment, overflow: "hidden" },
    progressBar: { height: 6, borderRadius: 3, backgroundColor: c.primary },
    lockedCard: { backgroundColor: c.surface2 },
    lockedText: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    footer: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 16,
      paddingTop: 12,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
  });
