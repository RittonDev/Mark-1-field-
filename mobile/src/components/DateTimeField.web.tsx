// Pré-visualização no navegador: o seletor nativo (@react-native-community/datetimepicker)
// não existe na web, então usa <input type="datetime-local">. Mesmas props do DateTimeField.tsx.

import { View } from "react-native";
import { Button, colors } from "./ui";

const pad = (n: number) => String(n).padStart(2, "0");

function toLocalInput(date: Date | null | undefined): string {
  if (!date) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <input
        type="datetime-local"
        aria-label={placeholder}
        value={toLocalInput(value)}
        min={toLocalInput(minimumDate) || undefined}
        onChange={(event) => {
          const next = event.target.value ? new Date(event.target.value) : null;
          onChange(next && !Number.isNaN(next.getTime()) ? next : null);
        }}
        style={{
          flex: 1,
          minHeight: 44,
          border: `1px solid ${colors.line}`,
          borderRadius: 10,
          padding: "0 12px",
          fontSize: 15,
          color: colors.ink,
          backgroundColor: colors.surface,
          fontFamily: "inherit",
        }}
      />
      {clearable && value ? <Button compact title="Limpar" variant="ghost" onPress={() => onChange(null)} /> : null}
    </View>
  );
}
