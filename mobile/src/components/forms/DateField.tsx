import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../Text";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Button } from "../ui";

const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : null);
const label = (s: string) => s.split("-").reverse().join("/");

/**
 * Data sem hora ("YYYY-MM-DD"), para campos de formulário. Quase sempre é o dia da visita: o atalho
 * "Hoje" preenche com um toque. Na web: DateField.web.tsx.
 */
export function DateField({
  value,
  onChange,
  disabled = false,
  label: fieldLabel,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  /** Pergunta do campo, para o leitor de tela. */
  label?: string;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const [iosOpen, setIosOpen] = useState(false);
  const current = fromIso(value);
  const today = toIso(new Date());

  function open() {
    if (disabled) return;
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({ mode: "date", value: current ?? new Date(), onValueChange: (_e, d) => onChange(toIso(d)) });
    } else {
      setIosOpen((o) => !o);
    }
  }

  const spoken = value ? `${fieldLabel ? `${fieldLabel}: ` : "Data: "}${label(value)}` : `${fieldLabel ? `${fieldLabel}: ` : ""}selecionar data`;

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={spoken}
          accessibilityState={{ disabled, expanded: Platform.OS === "ios" ? iosOpen : undefined }}
          onPress={open}
          style={[styles.input, disabled && { opacity: 0.6 }]}
        >
          <Text style={[styles.text, !value && { color: c.placeholder }]}>{value ? label(value) : "Selecionar data"}</Text>
        </Pressable>
        {!disabled && value !== today ? (
          <Button
            compact
            title="Hoje"
            onPress={() => {
              setIosOpen(false);
              onChange(today);
            }}
          />
        ) : null}
        {value && !disabled ? <Button compact title="Limpar" variant="ghost" onPress={() => onChange(null)} /> : null}
      </View>
      {Platform.OS === "ios" && iosOpen ? (
        <DateTimePicker
          mode="date"
          display="inline"
          locale="pt-BR"
          themeVariant={c.scheme}
          accentColor={c.primary}
          value={current ?? new Date()}
          onValueChange={(_e, d) => {
            onChange(toIso(d));
            setIosOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    input: {
      flex: 1,
      minHeight: 46,
      borderWidth: 1,
      borderColor: c.lineStrong,
      borderRadius: 10,
      paddingHorizontal: 12,
      justifyContent: "center",
      backgroundColor: c.surface,
    },
    text: { fontSize: 15, color: c.ink },
  });
