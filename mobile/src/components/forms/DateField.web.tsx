// Pré-visualização no navegador: <input type="date">. Mesmas props do DateField.tsx.

import { brandFont } from "../../theme/fonts";
import { useTheme } from "../../theme/theme";

export function DateField({
  value,
  onChange,
  disabled = false,
  label,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const c = useTheme();
  return (
    <input
      type="date"
      aria-label={label ?? "Data"}
      value={value ?? ""}
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
