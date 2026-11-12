import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { formatDateTime } from "../lib/format";
import { useStyles, useTheme, type Palette } from "../theme/theme";
import { Button } from "./ui";

/**
 * Data + hora. No Android abre os diálogos nativos (data e depois hora);
 * no iOS mostra o seletor embutido ao tocar. Na web: DateTimeField.web.tsx.
 */
export function DateTimeField({
  value,
  onChange,
  placeholder = "Selecionar data e hora",
  minimumDate,
  clearable = false,
}: {
  value: Date | null;
  onChange: (value: Date | null) => void;
  placeholder?: string;
  minimumDate?: Date;
  clearable?: boolean;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const [iosOpen, setIosOpen] = useState(false);

  function openAndroid() {
    const base = value ?? new Date();
    DateTimePickerAndroid.open({
      mode: "date",
      value: base,
      minimumDate,
      onValueChange: (_event, date) => {
        DateTimePickerAndroid.open({
          mode: "time",
          is24Hour: true,
          value: date,
          onValueChange: (_e, time) => onChange(time),
        });
      },
    });
  }

  const label = value ? formatDateTime(value.toISOString()) : placeholder;

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (Platform.OS === "android" ? openAndroid() : setIosOpen((open) => !open))}
          style={styles.input}
        >
          <Text style={[styles.text, !value && { color: c.placeholder }]}>{label}</Text>
        </Pressable>
        {clearable && value ? <Button compact title="Limpar" variant="ghost" onPress={() => onChange(null)} /> : null}
      </View>
      {Platform.OS === "ios" && iosOpen ? (
        <DateTimePicker
          mode="datetime"
          display="inline"
          locale="pt-BR"
          themeVariant={c.scheme}
          accentColor={c.primary}
          value={value ?? new Date()}
          minimumDate={minimumDate}
          onValueChange={(_event, date) => onChange(date)}
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
      borderRadius: 12,
      paddingHorizontal: 12,
      justifyContent: "center",
      backgroundColor: c.surface,
    },
    text: { fontSize: 15, color: c.ink },
  });
