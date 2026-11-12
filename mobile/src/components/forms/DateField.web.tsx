// Pré-visualização no navegador: <input type="date">. Mesmas props do DateField.tsx.

import { useTheme } from "../../theme/theme";

export function DateField({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const c = useTheme();
  return (
    <input
      type="date"
      aria-label="Data"
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
        fontFamily: "inherit",
      }}
    />
  );
}
