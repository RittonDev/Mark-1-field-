// Pré-visualização no navegador: <input type="date">. Mesmas props do DateField.tsx; `min` e `max` vão para o campo
// (o seletor do navegador não deixa escolher fora deles). `todayShortcut` e `initial` não mudam nada aqui: o seletor é
// o do navegador.

import { brandFont } from "../../theme/fonts";
import { useTheme } from "../../theme/theme";

export function DateField({
  value,
  onChange,
  disabled = false,
  label,
  min,
  max,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  label?: string;
  /** Primeiro dia que o seletor deixa escolher ("YYYY-MM-DD"). */
  min?: string;
  /** Último dia que o seletor deixa escolher ("YYYY-MM-DD"). */
  max?: string;
  todayShortcut?: boolean;
  initial?: string;
}) {
  const c = useTheme();
  return (
    <input
      type="date"
      aria-label={label ?? "Data"}
      value={value ?? ""}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
      style={{
        minHeight: 44,
        border: `1px solid ${c.lineStrong}`,
        borderRadius: 10,
        padding: "0 12px",
        fontSize: 15,
        color: c.ink,
        backgroundColor: c.surface,
        colorScheme: c.scheme,
        fontFamily: brandFont("400") ?? "inherit",
      }}
    />
  );
}
