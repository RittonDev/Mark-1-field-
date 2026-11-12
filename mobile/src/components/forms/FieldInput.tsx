import { Image, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../Text";
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

/** Um campo do formulário da OS, pelo tipo (section, text, yes_no, photo…). */
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

  const header = (
    <View style={{ gap: 2 }}>
      <Text style={styles.label}>
        {field.label}
        {field.required || (field.type === "photo" && photoNeed(field) > 0) ? <Text style={{ color: c.danger }}> *</Text> : null}
      </Text>
      {field.help ? <Text style={styles.help}>{field.help}</Text> : null}
    </View>
  );

  let control: React.ReactNode = null;
  switch (field.type) {
    case "text":
    case "textarea":
    case "number":
      control = (
        <Input
          value={value === null || value === undefined ? "" : String(value)}
          onChangeText={(text) => onChange(text)}
          editable={!disabled}
          multiline={field.type === "textarea"}
          keyboardType={field.type === "number" ? "decimal-pad" : "default"}
          placeholder={field.type === "number" ? "0" : "Digite aqui"}
        />
      );
      break;
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
      control = (
        <View style={styles.chips}>
          {field.options.map((option) => {
            const selected = multi ? list.includes(option) : value === option;
            return (
              <Pressable
                key={option}
                disabled={disabled}
                onPress={() =>
                  multi
                    ? onChange(selected ? list.filter((o) => o !== option) : [...list, option])
                    : onChange(selected ? null : option)
                }
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
          style={[styles.confirm, value === true && styles.confirmOn]}
        >
          <View style={[styles.box, value === true && styles.boxOn]}>
            {value === true ? <Text style={styles.check}>✓</Text> : null}
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
                  <Pressable
                    key={a.id}
                    disabled={disabled}
                    onLongPress={() => onRemoveServerPhoto?.(a)}
                    accessibilityLabel={`Foto enviada${disabled ? "" : ". Toque e segure para remover"}`}
                  >
                    {url ? <Image source={{ uri: url }} style={styles.thumb} /> : <View style={styles.thumb} />}
                  </Pressable>
                );
              })}
              {photos?.pending.map((p) => (
                <Pressable
                  key={p.id}
                  disabled={disabled}
                  onLongPress={() => onRemovePendingPhoto?.(p)}
                  accessibilityLabel="Foto aguardando envio. Toque e segure para remover"
                >
                  <Image source={{ uri: p.file_uri }} style={[styles.thumb, styles.thumbPending]} />
                  <Text style={styles.pendingTag}>na fila</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {!disabled ? (
            <View style={styles.row}>
              <Button
                compact
                title="Tirar foto"
                variant="primary"
                onPress={() => onAddPhoto?.("camera")}
                disabled={full || photoBusy}
                style={{ flex: 1 }}
              />
              <Button compact title="Galeria" onPress={() => onAddPhoto?.("library")} disabled={full || photoBusy} style={{ flex: 1 }} />
            </View>
          ) : null}
          {count && !disabled ? <Text style={styles.help}>Toque e segure uma foto para removê-la.</Text> : null}
        </View>
      );
      break;
    }
  }

  return (
    <View style={styles.field}>
      {header}
      {control}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    field: { gap: 10 },
    section: { gap: 4, paddingTop: 6 },
    sectionTitle: { fontSize: 13, fontWeight: "700", color: c.primary, textTransform: "uppercase", letterSpacing: 0.5 },
    label: { fontSize: 15, fontWeight: "600", color: c.ink },
    help: { fontSize: 12, color: c.inkMuted, lineHeight: 17 },
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
    confirmOn: { borderColor: c.success, backgroundColor: c.successSoft },
    box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: c.inkSubtle, alignItems: "center", justifyContent: "center" },
    boxOn: { borderColor: c.success, backgroundColor: c.success },
    check: { color: "#fff", fontWeight: "800", fontSize: 14, lineHeight: 16 },
    confirmText: { fontSize: 15, fontWeight: "600", color: c.ink },
    thumbs: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    thumb: { width: 76, height: 76, borderRadius: 10, backgroundColor: c.line },
    thumbPending: { opacity: 0.75 },
    pendingTag: { position: "absolute", bottom: 4, left: 4, fontSize: 10, fontWeight: "700", color: "#fff", backgroundColor: "#0008", paddingHorizontal: 4, borderRadius: 4, overflow: "hidden" },
  });
