import { Image, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../Text";
import { Icon } from "../Icon";
import { absoluteApiUrl } from "../../lib/api";
import type { PendingPhoto } from "../../lib/db";
import { photoNeed } from "../../lib/forms";
import type { Attachment, FormAnswer, FormField } from "../../lib/types";
import { tint, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Badge, Button, Input } from "../ui";
import { DateField } from "./DateField";

export interface FieldPhotos {
  server: Attachment[];
  pending: PendingPhoto[];
}

/**
 * Um campo do formulário da OS, pelo tipo (section, text, yes_no, photo…).
 * `prominent`: modo uma pergunta por tela — pergunta grande e opções em linhas largas, fáceis de tocar.
 */
export function FieldInput({
  field,
  value,
  onChange,
  disabled,
  photos,
  onAddPhoto,
  onRemoveServerPhoto,
  onRemovePendingPhoto,
  photoBusy,
  prominent = false,
  autoFocus = false,
  onSubmit,
}: {
  field: FormField;
  value: FormAnswer | null | undefined;
  onChange: (value: FormAnswer | null) => void;
  disabled: boolean;
  photos?: FieldPhotos;
  onAddPhoto?: (source: "camera" | "library") => void;
  onRemoveServerPhoto?: (attachment: Attachment) => void;
  onRemovePendingPhoto?: (photo: PendingPhoto) => void;
  photoBusy?: boolean;
  prominent?: boolean;
  autoFocus?: boolean;
  /** Tecla "próximo" do teclado nos campos de uma linha. */
  onSubmit?: () => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);

  if (field.type === "section") {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{field.label}</Text>
        {field.help ? <Text style={styles.help}>{field.help}</Text> : null}
      </View>
    );
  }

  const required = field.required || (field.type === "photo" && photoNeed(field) > 0);
  const header = (
    <View style={{ gap: prominent ? 6 : 2 }}>
      <Text style={prominent ? styles.labelBig : styles.label}>
        {field.label}
        {required ? <Text style={{ color: c.danger }}> *</Text> : null}
      </Text>
      {field.help ? <Text style={prominent ? styles.helpBig : styles.help}>{field.help}</Text> : null}
    </View>
  );

  let control: React.ReactNode = null;
  switch (field.type) {
    case "text":
    case "textarea":
    case "number": {
      const singleLine = field.type !== "textarea";
      control = (
        <Input
          value={value === null || value === undefined ? "" : String(value)}
          onChangeText={(text) => onChange(text)}
          editable={!disabled}
          multiline={!singleLine}
          keyboardType={field.type === "number" ? "decimal-pad" : "default"}
          placeholder={field.type === "number" ? "0" : "Digite aqui"}
          autoFocus={autoFocus && !disabled}
          returnKeyType={singleLine && onSubmit ? "next" : undefined}
          onSubmitEditing={singleLine && onSubmit ? onSubmit : undefined}
          style={prominent && !singleLine ? { minHeight: 140 } : undefined}
        />
      );
      break;
    }
    case "yes_no":
      control = (
        <View style={styles.row}>
          {[
            { v: true, label: "Sim", color: c.success },
            { v: false, label: "Não", color: c.danger },
          ].map((opt) => {
            const selected = value === opt.v;
            return (
              <Pressable
                key={opt.label}
                disabled={disabled}
                onPress={() => onChange(selected ? null : opt.v)}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled }}
                style={[
                  styles.bigChoice,
                  prominent && styles.bigChoiceTall,
                  selected && { backgroundColor: tint(opt.color, c.scheme === "dark" ? "33" : "1a"), borderColor: opt.color },
                ]}
              >
                <Text style={[styles.bigChoiceText, selected && { color: opt.color }]}>{opt.label}</Text>
              </Pressable>
            );
          })}
        </View>
      );
      break;
    case "choice":
    case "multi_choice": {
      const multi = field.type === "multi_choice";
      const list = multi ? (Array.isArray(value) ? value : []) : [];
      const toggle = (option: string, selected: boolean) =>
        multi ? onChange(selected ? list.filter((o) => o !== option) : [...list, option]) : onChange(selected ? null : option);
      control = prominent ? (
        <View style={{ gap: 10 }}>
          {multi ? <Text style={styles.help}>Pode marcar mais de uma.</Text> : null}
          {field.options.map((option) => {
            const selected = multi ? list.includes(option) : value === option;
            return (
              <Pressable
                key={option}
                disabled={disabled}
                onPress={() => toggle(option, selected)}
                accessibilityRole={multi ? "checkbox" : "radio"}
                accessibilityState={{ checked: selected, disabled }}
                style={[styles.option, selected && styles.optionSelected]}
              >
                <View style={[multi ? styles.optionBox : styles.optionRadio, selected && styles.optionMarkOn]}>
                  {selected ? (
                    multi ? (
                      <Icon name="check" size={14} color={c.onPrimary} strokeWidth={3} />
                    ) : (
                      <View style={styles.optionDot} />
                    )
                  ) : null}
                </View>
                <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{option}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={styles.chips}>
          {field.options.map((option) => {
            const selected = multi ? list.includes(option) : value === option;
            return (
              <Pressable
                key={option}
                disabled={disabled}
                onPress={() => toggle(option, selected)}
                accessibilityRole={multi ? "checkbox" : "radio"}
                accessibilityState={{ checked: selected, disabled }}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                  {multi ? (selected ? "✓ " : "") : ""}
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>
      );
      break;
    }
    case "date":
      control = <DateField value={typeof value === "string" ? value : null} onChange={onChange} disabled={disabled} />;
      break;
    case "confirm":
      control = (
        <Pressable
          disabled={disabled}
          onPress={() => onChange(value === true ? null : true)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: value === true, disabled }}
          style={[styles.confirm, prominent && styles.confirmTall, value === true && styles.confirmOn]}
        >
          <View style={[styles.box, value === true && styles.boxOn]}>
            {value === true ? <Icon name="check" size={15} color="#fff" strokeWidth={3} /> : null}
          </View>
          <Text style={styles.confirmText}>Confirmo</Text>
        </Pressable>
      );
      break;
    case "photo": {
      const count = (photos?.server.length ?? 0) + (photos?.pending.length ?? 0);
      const need = photoNeed(field);
      const max = field.max_photos > 0 ? field.max_photos : null;
      const full = max !== null && count >= max;
      const thumb = prominent ? styles.thumbBig : styles.thumb;
      control = (
        <View style={{ gap: 10 }}>
          <View style={styles.row}>
            <Badge
              label={need ? `${count} de ${need} foto${need > 1 ? "s" : ""}` : `${count} foto${count === 1 ? "" : "s"}`}
              color={need && count >= need ? c.success : need ? c.warning : c.inkMuted}
            />
            {max !== null ? <Text style={styles.help}>máx. {max}</Text> : null}
          </View>
          {count ? (
            <View style={styles.thumbs}>
              {photos?.server.map((a) => {
                const url = absoluteApiUrl(a.download_url);
                return (
                  <View key={a.id}>
                    <Pressable
                      disabled={disabled}
                      onLongPress={() => onRemoveServerPhoto?.(a)}
                      accessibilityLabel={`Foto enviada${disabled ? "" : ". Toque e segure para remover"}`}
                    >
                      {url ? <Image source={{ uri: url }} style={thumb} /> : <View style={thumb} />}
                    </Pressable>
                    {!disabled ? <RemoveBadge onPress={() => onRemoveServerPhoto?.(a)} /> : null}
                  </View>
                );
              })}
              {photos?.pending.map((p) => (
                <View key={p.id}>
                  <Pressable
                    disabled={disabled}
                    onLongPress={() => onRemovePendingPhoto?.(p)}
                    accessibilityLabel="Foto aguardando envio. Toque e segure para remover"
                  >
                    <Image source={{ uri: p.file_uri }} style={[thumb, styles.thumbPending]} />
                    <Text style={styles.pendingTag}>na fila</Text>
                  </Pressable>
                  {!disabled ? <RemoveBadge onPress={() => onRemovePendingPhoto?.(p)} /> : null}
                </View>
              ))}
            </View>
          ) : null}
          {!disabled ? (
            <View style={styles.row}>
              <Button
                compact={!prominent}
                title="Tirar foto"
                icon={prominent ? "camera" : undefined}
                variant="primary"
                onPress={() => onAddPhoto?.("camera")}
                disabled={full || photoBusy}
                loading={prominent && photoBusy}
                style={{ flex: 1 }}
              />
              <Button
                compact={!prominent}
                title="Galeria"
                onPress={() => onAddPhoto?.("library")}
                disabled={full || photoBusy}
                style={{ flex: 1 }}
              />
            </View>
          ) : null}
          {full && !disabled ? <Text style={styles.help}>Limite de fotos atingido. Remova uma para trocar.</Text> : null}
        </View>
      );
      break;
    }
  }

  return (
    <View style={prominent ? styles.fieldBig : styles.field}>
      {header}
      {control}
    </View>
  );
}

/** "×" no canto da miniatura: remover a foto sem precisar descobrir o toque longo. */
function RemoveBadge({ onPress }: { onPress: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remover foto" style={styles.removeBadge}>
      <Icon name="close" size={12} color="#fff" strokeWidth={2.6} />
    </Pressable>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    field: { gap: 10 },
    fieldBig: { gap: 18 },
    section: { gap: 4, paddingTop: 6 },
    sectionTitle: { fontSize: 13, fontWeight: "700", color: c.primary, textTransform: "uppercase", letterSpacing: 0.5 },
    label: { fontSize: 15, fontWeight: "600", color: c.ink },
    labelBig: { fontSize: 20, fontWeight: "700", color: c.ink, lineHeight: 27 },
    help: { fontSize: 12, color: c.inkMuted, lineHeight: 17 },
    helpBig: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    row: { flexDirection: "row", alignItems: "center", gap: 10 },
    bigChoice: {
      flex: 1,
      minHeight: 56,
      borderRadius: 14,
      borderWidth: 1.5,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    bigChoiceTall: { minHeight: 72 },
    bigChoiceText: { fontSize: 17, fontWeight: "700", color: c.ink },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      borderWidth: 1,
      borderColor: c.lineStrong,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 9,
      backgroundColor: c.surface,
    },
    chipSelected: { borderColor: c.primary, backgroundColor: c.primarySoft },
    chipText: { fontSize: 14, color: c.ink },
    chipTextSelected: { color: c.primary, fontWeight: "600" },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 54,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
    },
    optionSelected: { borderColor: c.primary, backgroundColor: c.primarySoft },
    optionRadio: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: c.inkSubtle,
      alignItems: "center",
      justifyContent: "center",
    },
    optionBox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: c.inkSubtle,
      alignItems: "center",
      justifyContent: "center",
    },
    optionMarkOn: { borderColor: c.primary, backgroundColor: c.primary },
    optionDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.onPrimary },
    optionText: { flex: 1, fontSize: 16, color: c.ink, lineHeight: 22 },
    optionTextSelected: { color: c.brandInk, fontWeight: "600" },
    confirm: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
    },
    confirmTall: { minHeight: 64, borderRadius: 12, borderWidth: 1.5 },
    confirmOn: { borderColor: c.success, backgroundColor: c.successSoft },
    box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: c.inkSubtle, alignItems: "center", justifyContent: "center" },
    boxOn: { borderColor: c.success, backgroundColor: c.success },
    confirmText: { fontSize: 15, fontWeight: "600", color: c.ink },
    thumbs: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    thumb: { width: 76, height: 76, borderRadius: 10, backgroundColor: c.line },
    thumbBig: { width: 96, height: 96, borderRadius: 12, backgroundColor: c.line },
    thumbPending: { opacity: 0.75 },
    pendingTag: { position: "absolute", bottom: 4, left: 4, fontSize: 10, fontWeight: "700", color: "#fff", backgroundColor: "#0008", paddingHorizontal: 4, borderRadius: 4, overflow: "hidden" },
    removeBadge: {
      position: "absolute",
      top: -6,
      right: -6,
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: "#1B1F26E6",
      borderWidth: 1.5,
      borderColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
    },
  });
