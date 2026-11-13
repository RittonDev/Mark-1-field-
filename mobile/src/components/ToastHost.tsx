import { router } from "expo-router";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeInUp, FadeOut, LinearTransition, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dismissToast, useToasts, type Toast } from "../lib/toast";
import { mix, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon } from "./Icon";
import { ENTER_OFFSET } from "./motion";
import { Text } from "./Text";

/** Altura do cabeçalho nativo das telas: o aviso fica logo abaixo dele, sem cobrir o "Voltar". */
const HEADER_HEIGHT = Platform.OS === "ios" ? 44 : 56;

/**
 * Avisos rápidos no alto da tela: embaixo eles cobriam a barra de abas e a barra do próximo passo da OS
 * justamente quando ela é necessária; logo abaixo da altura do cabeçalho, não cobrem o "Voltar" nem a
 * faixa de conexão da tela inicial. Tocar fecha; aviso de uma OS abre a OS.
 */
export function ToastHost() {
  const toasts = useToasts();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  if (!toasts.length) return null;
  // A faixa colorida contrasta com o fundo escuro do aviso (cores de alerta claras no grafite).
  const tone = {
    info: c.scheme === "dark" ? c.brandInk : mix(c.primary, "#FFFFFF", 0.35),
    success: c.scheme === "dark" ? c.success : mix(c.success, "#FFFFFF", 0.45),
    error: c.scheme === "dark" ? c.danger : mix(c.danger, "#FFFFFF", 0.4),
  };

  function press(toast: Toast) {
    dismissToast(toast.id);
    if (toast.ticketId) router.push({ pathname: "/ticket/[id]", params: { id: toast.ticketId } });
  }

  return (
    <View style={[styles.host, { top: insets.top + HEADER_HEIGHT + 4 }]}>
      {toasts.map((toast) => (
        <Animated.View
          key={toast.id}
          entering={reduced ? undefined : FadeInUp.duration(180).withInitialValues({ opacity: 0, transform: [{ translateY: -ENTER_OFFSET }] })}
          exiting={reduced ? undefined : FadeOut.duration(140)}
          layout={reduced ? undefined : LinearTransition.duration(180)}
          style={styles.item}
        >
          <Pressable
            onPress={() => press(toast)}
            accessibilityRole={toast.ticketId ? "button" : "alert"}
            accessibilityLiveRegion="polite"
            accessibilityHint={toast.ticketId ? "Abre a OS" : "Fecha o aviso"}
            style={[styles.toast, { borderLeftColor: tone[toast.tone] }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{toast.title}</Text>
              {toast.description ? <Text style={styles.description}>{toast.description}</Text> : null}
              {toast.ticketId ? <Text style={styles.open}>Toque para abrir</Text> : null}
            </View>
            {toast.ticketId ? <Icon name="chevronRight" size={18} color={c.toastMuted} /> : null}
          </Pressable>
        </Animated.View>
      ))}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    // Só os avisos recebem toque: o resto da faixa deixa passar para a tela embaixo.
    host: { position: "absolute", left: 16, right: 16, gap: 8, alignItems: "center", pointerEvents: "box-none" },
    item: { width: "100%", maxWidth: 520 },
    toast: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 48,
      backgroundColor: c.toast,
      borderRadius: 10,
      borderLeftWidth: 4,
      paddingHorizontal: 14,
      paddingVertical: 12,
      boxShadow: "0px 4px 12px rgba(0, 0, 0, 0.14)",
    },
    title: { color: c.toastInk, fontSize: 14, fontWeight: "600" },
    description: { color: c.toastMuted, fontSize: 13, marginTop: 2, lineHeight: 18 },
    open: { color: c.toastInk, fontSize: 12, fontWeight: "600", marginTop: 4 },
  });
