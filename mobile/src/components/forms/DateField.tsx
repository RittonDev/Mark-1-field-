import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../Text";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Button } from "../ui";

const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isDay = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const label = (s: string) => s.split("-").reverse().join("/");

/**
 * Data sem hora ("YYYY-MM-DD"), para campos de formulário. Quase sempre é o dia da visita: o atalho "Hoje" preenche
 * com um toque (`todayShortcut`; só aparece com hoje entre `min` e `max`). `min` e `max` limitam o seletor; `initial` é
 * onde ele abre com o campo vazio (nascimento: 30 anos atrás). No iPhone o seletor abre abaixo do campo e cada mudança
 * grava: o calendário (`iosDisplay` "inline", o de sempre) fecha na mudança; as rodas ("spinner", o nascimento, longe
 * de hoje) ficam abertas até o "OK" ou um toque no campo. No Android, o diálogo do sistema (com o OK dele). Na web:
 * DateField.web.tsx.
 */
export function DateField({
  value,
  onChange,
  disabled = false,
  label: fieldLabel,
  min,
  max,
  todayShortcut = true,
  initial,
  iosDisplay = "inline",
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  /** Pergunta do campo, para o leitor de tela. */
  label?: string;
  /** Primeiro dia que o seletor deixa escolher ("YYYY-MM-DD"). */
  min?: string;
  /** Último dia que o seletor deixa escolher ("YYYY-MM-DD"). */
  max?: string;
  /** O atalho "Hoje" (padrão: sim). */
  todayShortcut?: boolean;
  /** O dia em que o seletor abre com o campo vazio ("YYYY-MM-DD"; padrão: hoje). */
  initial?: string;
  /** iPhone: o calendário ("inline", padrão) ou as rodas de dia, mês e ano ("spinner": datas longe de hoje). */
  iosDisplay?: "inline" | "spinner";
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const [iosOpen, setIosOpen] = useState(false);
  const today = toIso(new Date());
  const first = isDay(min) ? min : undefined;
  // Limites trocados (max antes de min) derrubariam o seletor, que exige min <= max: aí vale só o `min`.
  const last = isDay(max) && !(first && max < first) ? max : undefined;
  // O seletor abre no dia do campo (vazio: `initial` ou hoje), puxado para dentro dos limites.
  let opensAt = isDay(value) ? value : isDay(initial) ? initial : today;
  if (first && opensAt < first) opensAt = first;
  if (last && opensAt > last) opensAt = last;
  // Meio-dia: o horário de verão não muda o dia. Os limites cobrem os dias inteiros.
  const pickerValue = new Date(`${opensAt}T12:00:00`);
  const limits = {
    minimumDate: first ? new Date(`${first}T00:00:00`) : undefined,
    maximumDate: last ? new Date(`${last}T23:59:59`) : undefined,
  };
  const todayFits = (!first || today >= first) && (!last || today <= last);

  function open() {
    if (disabled) return;
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({ mode: "date", value: pickerValue, ...limits, onValueChange: (_e, d) => onChange(toIso(d)) });
    } else {
      setIosOpen((o) => !o);
    }
  }

  /**
   * iPhone: cada mudança grava (o campo mostra o que o seletor mostra). O calendário fecha na mudança, como sempre. As
   * rodas mandam uma mudança por roda, então ficam abertas até o "OK".
   */
  function pickIos(d: Date) {
    onChange(toIso(d));
    if (iosDisplay === "inline") setIosOpen(false);
  }

  /**
   * "OK" das rodas: só fecha. O que a pessoa girou já foi gravado; com o campo vazio e as rodas paradas, nada é gravado
   * (a data em que elas abrem, 30 anos atrás no nascimento, seria uma data plausível e errada).
   */
  function confirmIos() {
    setIosOpen(false);
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
        {todayShortcut && todayFits && !disabled && value !== today ? (
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
        <>
          <DateTimePicker
            mode="date"
            display={iosDisplay}
            locale="pt-BR"
            themeVariant={c.scheme}
            accentColor={c.primary}
            value={pickerValue}
            {...limits}
            onValueChange={(_e, d) => pickIos(d)}
          />
          {iosDisplay === "spinner" ? <Button compact title="OK" onPress={confirmIos} style={styles.ok} /> : null}
        </>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    ok: { alignSelf: "flex-end", minWidth: 72 },
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
