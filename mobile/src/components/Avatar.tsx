import { useState } from "react";
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { absoluteApiUrl } from "../lib/api";
import { initials } from "../lib/format";
import { useStyles, type Palette } from "../theme/theme";
import { Text } from "./Text";

/**
 * Foto do técnico num círculo. As iniciais ficam por baixo: aparecem sem foto, enquanto a imagem carrega e quando
 * ela não abre (link vencido, sem internet). Decorativo: o nome está ao lado ou no rótulo do botão.
 */
export function Avatar({
  name,
  uri,
  size = 36,
  style,
}: {
  name: string | null | undefined;
  /** avatar_url do Meu cadastro (link assinado da API ou a foto do Field Control). */
  uri?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles);
  const source = absoluteApiUrl(uri);
  // O link que falhou: um link novo (cadastro relido) tenta de novo.
  const [failed, setFailed] = useState<string | null>(null);
  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={[styles.frame, round, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text style={[styles.initials, { fontSize: Math.round(size * 0.36) }]} maxFontSizeMultiplier={1.2}>
        {initials(name)}
      </Text>
      {source && failed !== source ? (
        <Image
          source={{ uri: source }}
          style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
          resizeMode="cover"
          onError={() => setFailed(source)}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    frame: {
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      backgroundColor: c.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.lineStrong,
    },
    initials: { fontWeight: "700", color: c.ink },
  });
