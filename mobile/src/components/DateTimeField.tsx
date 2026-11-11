import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { formatDateTime } from "../lib/format";
import { Button, colors } from "./ui";

/**
 * Data + hora. No Android abre os diálogos nativos (data e depois hora);
 * no iOS mostra o seletor embutido ao tocar.
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
          <Text style={[styles.text, !value && { color: "#94a3b8" }]}>{label}</Text>
        </Pressable>
        {clearable && value ? <Button compact title="Limpar" variant="ghost" onPress={() => onChange(null)} /> : null}
      </View>
      {Platform.OS === "ios" && iosOpen ? (
        <DateTimePicker
          mode="datetime"
          display="inline"
          locale="pt-BR"
          value={value ?? new Date()}
          minimumDate={minimumDate}
          onValueChange={(_event, date) => onChange(date)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  text: { fontSize: 15, color: colors.ink },
});
