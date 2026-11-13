import { useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DARK } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

export interface ViewerPhoto {
  key: string;
  uri: string;
  caption?: string | null;
}

/**
 * Foto em tela cheia dentro do app (sem sair para o navegador), com anterior/próxima. Fundo sempre
 * escuro, como em qualquer visualizador de fotos. `index` null = fechado.
 */
export function PhotoViewer({
  photos,
  index,
  onChange,
}: {
  photos: ViewerPhoto[];
  index: number | null;
  onChange: (index: number | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const open = index !== null && photos.length > 0;
  const i = open ? Math.min(Math.max(0, index), photos.length - 1) : 0;
  const photo = open ? photos[i] : null;
  const close = () => onChange(null);

  return (
    <Modal visible={open} animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View style={styles.root}>
        <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.counter} accessibilityRole="header">
              Foto {i + 1} de {photos.length}
            </Text>
            {photo?.caption ? (
              <Text style={styles.caption} numberOfLines={2}>
                {photo.caption}
              </Text>
            ) : null}
          </View>
          <Pressable onPress={close} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Fechar foto" hitSlop={4}>
            <Icon name="close" size={24} color={DARK.ink} strokeWidth={2.2} />
          </Pressable>
        </View>
        <View style={styles.stage}>
          {photo ? (
            <Image
              key={photo.uri}
              source={{ uri: photo.uri }}
              style={styles.image}
              resizeMode="contain"
              onLoad={() => setLoaded(photo.uri)}
              onError={() => setFailed(photo.uri)}
              accessibilityIgnoresInvertColors
              accessibilityLabel={photo.caption ?? `Foto ${i + 1}`}
            />
          ) : null}
          {photo && failed === photo.uri ? (
            <Text style={styles.message}>Não foi possível carregar a foto. Confira a conexão e abra de novo.</Text>
          ) : photo && loaded !== photo.uri ? (
            <ActivityIndicator style={StyleSheet.absoluteFill} color={DARK.ink} />
          ) : null}
        </View>
        {photos.length > 1 ? (
          <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
            <Pressable
              onPress={() => onChange(i - 1)}
              disabled={i === 0}
              style={[styles.navButton, i === 0 && styles.navDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Foto anterior"
              accessibilityState={{ disabled: i === 0 }}
            >
              <Icon name="chevronLeft" size={26} color={DARK.ink} strokeWidth={2.2} />
            </Pressable>
            <Pressable
              onPress={() => onChange(i + 1)}
              disabled={i === photos.length - 1}
              style={[styles.navButton, i === photos.length - 1 && styles.navDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Próxima foto"
              accessibilityState={{ disabled: i === photos.length - 1 }}
            >
              <Icon name="chevronRight" size={26} color={DARK.ink} strokeWidth={2.2} />
            </Pressable>
          </View>
        ) : (
          <View style={{ height: insets.bottom + 12 }} />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: DARK.backdrop },
  top: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  counter: { fontSize: 15, fontWeight: "700", color: DARK.ink, fontVariant: ["tabular-nums"] },
  caption: { fontSize: 13, color: DARK.inkMuted, lineHeight: 18 },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: DARK.surface3,
  },
  stage: { flex: 1, justifyContent: "center" },
  image: { width: "100%", height: "100%" },
  message: { position: "absolute", left: 24, right: 24, textAlign: "center", fontSize: 15, color: DARK.inkMuted, lineHeight: 21 },
  bottom: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 12 },
  navButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: DARK.surface3,
  },
  navDisabled: { opacity: 0.35 },
});
