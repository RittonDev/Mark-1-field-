import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { quickPosition, requestLocationPermission, type PositionFix } from "../../lib/device-actions";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { Button } from "../ui";
import { toneInk } from "./tones";

/**
 * Posição para registrar a ação, buscada assim que a tela abre: no toque de Confirmar ela já está
 * pronta (ou perto disso). `fix` null = ainda buscando. `wait()` devolve a busca em andamento.
 */
export function useLocationFix() {
  const [fix, setFix] = useState<PositionFix | null>(null);
  const current = useRef<Promise<PositionFix> | null>(null);

  const start = useCallback(() => {
    const search = quickPosition();
    current.current = search;
    void search.then((result) => {
      if (current.current === search) setFix(result);
    });
    return search;
  }, []);

  useEffect(() => {
    start();
    return () => {
      current.current = null;
    };
  }, [start]);

  const wait = useCallback(() => current.current ?? start(), [start]);

  /** "Permitir": pede a permissão (ou abre as configurações) e busca de novo se liberou. */
  const allow = useCallback(async () => {
    if (!(await requestLocationPermission())) return;
    setFix(null);
    start();
  }, [start]);

  return { fix, wait, allow };
}

/**
 * Estado da localização na confirmação: pronta, buscando, sem sinal ou sem permissão. `place`
 * troca o "Localização pronta" pela conferência com a loja ("No local (a 120 m da loja)").
 */
export function LocationLine({ fix, place, onAllow }: { fix: PositionFix | null; place?: string | null; onAllow: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  if (fix?.status === "denied") {
    const color = toneInk(c, "warning");
    return (
      <View style={styles.row}>
        <Icon name="pin" size={18} color={color} strokeWidth={2} />
        <Text style={[styles.text, { color }]}>Sem permissão de localização: a central verá a ação sem GPS.</Text>
        <Button title="Permitir" compact variant="ghost" onPress={onAllow} />
      </View>
    );
  }
  const text =
    fix === null
      ? "Buscando localização…"
      : fix.status === "unavailable"
        ? "Sem sinal de GPS: segue sem localização."
        : place
          ? place
          : fix.accuracy !== null
          ? `Localização pronta (±${Math.max(5, Math.round(fix.accuracy))} m)`
          : "Localização pronta";
  return (
    <View style={styles.row} accessibilityLiveRegion="polite">
      {fix === null ? <ActivityIndicator size="small" color={c.inkMuted} /> : <Icon name="pin" size={18} color={c.inkMuted} strokeWidth={2} />}
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
    text: { flex: 1, fontSize: 13, color: c.inkMuted, lineHeight: 18 },
  });
