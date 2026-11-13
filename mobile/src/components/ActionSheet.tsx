import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, { Easing, SlideInDown, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "../lib/haptics";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon, type IconName } from "./Icon";
import { PressableScale } from "./motion";
import { Text } from "./Text";

export interface SheetAction {
  key: string;
  label: string;
  icon?: IconName;
  tone?: "default" | "danger";
  disabledReason?: string | null;
  right?: ReactNode;
  onPress: () => void;
}

/** Entrada da folha: sobe em 220 ms, sem mola (nada de quique). */
const SHEET_IN = SlideInDown.duration(220).easing(Easing.out(Easing.cubic));

/**
 * Chama `onClosed` quando a folha termina de sair. No iOS, apresentar outro Modal enquanto um ainda
 * está saindo falha em silêncio: lá vale o `onDismiss` do Modal (com um tempo de garantia); no
 * Android e na web, logo depois de fechar. Devolve o handler para o `onDismiss`.
 */
export function useAfterClose(visible: boolean, onClosed?: () => void): (() => void) | undefined {
  const latest = useRef(onClosed);
  const wasVisible = useRef(visible);
  const fired = useRef(false);
  useEffect(() => {
    latest.current = onClosed;
  });
  const fire = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    latest.current?.();
  }, []);
  useEffect(() => {
    if (visible) {
      wasVisible.current = true;
      fired.current = false;
      return;
    }
    if (!wasVisible.current) return;
    wasVisible.current = false;
    const timer = setTimeout(fire, Platform.OS === "ios" ? 600 : 0);
    return () => clearTimeout(timer);
  }, [visible, fire]);
  return Platform.OS === "ios" ? fire : undefined;
}

/**
 * Folha inferior (fundo escurecido, alça e área segura). O pai controla `visible`; `onClosed` avisa
 * quando ela terminou de sair. `locked` impede fechar pelo fundo e pelo voltar do Android.
 */
export function BottomSheet({
  visible,
  title,
  onClose,
  onClosed,
  locked = false,
  children,
}: {
  visible: boolean;
  title?: string;
  onClose: () => void;
  onClosed?: () => void;
  locked?: boolean;
  children: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const onDismiss = useAfterClose(visible, onClosed);
  const close = locked ? () => undefined : onClose;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close} onDismiss={onDismiss} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel="Fechar" />
        <Animated.View
          entering={reduced ? undefined : SHEET_IN}
          style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
          accessibilityViewIsModal
        >
          <View style={styles.handle} />
          {title ? (
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

/**
 * Folha com as demais ações da OS (o passo principal fica na barra fixa). A ação escolhida roda
 * depois que a folha sai, para o próximo Modal (transição, visita improdutiva, peça) abrir no iPhone.
 */
export function ActionSheet({
  visible,
  title,
  actions,
  onClose,
}: {
  visible: boolean;
  title: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const chosen = useRef<(() => void) | null>(null);
  const runChosen = useCallback(() => {
    const action = chosen.current;
    chosen.current = null;
    action?.();
  }, []);
  return (
    <BottomSheet visible={visible} title={title} onClose={onClose} onClosed={runChosen}>
      {actions.map((action) => {
        const disabled = Boolean(action.disabledReason);
        const color = action.tone === "danger" ? c.danger : c.ink;
        return (
          <PressableScale
            key={action.key}
            scaleTo={0.98}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            accessibilityHint={action.disabledReason ?? undefined}
            onPress={() => {
              // Indisponível: avisa com a vibração e deixa o motivo à vista.
              if (disabled) return haptic.warning();
              chosen.current = action.onPress;
              onClose();
            }}
            style={styles.row}
            pressedStyle={{ backgroundColor: c.surface2 }}
          >
            {action.icon ? (
              <View style={disabled && styles.dimmed}>
                <Icon name={action.icon} size={20} color={color} />
              </View>
            ) : null}
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.label, { color }, disabled && styles.dimmed]}>{action.label}</Text>
              {action.disabledReason ? <Text style={styles.reason}>{action.disabledReason}</Text> : null}
            </View>
            {action.right}
          </PressableScale>
        );
      })}
      <PressableScale onPress={onClose} style={styles.cancel} pressedStyle={{ backgroundColor: c.surface3 }} accessibilityRole="button">
        <Text style={styles.cancelText}>Fechar</Text>
      </PressableScale>
    </BottomSheet>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    root: { flex: 1, justifyContent: "flex-end" },
    backdrop: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: c.scheme === "dark" ? "rgba(0,0,0,0.6)" : "rgba(27,31,38,0.32)",
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: RADIUS.card + 6,
      borderTopRightRadius: RADIUS.card + 6,
      paddingHorizontal: 12,
      paddingTop: 8,
      gap: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
    },
    handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: c.lineStrong, marginBottom: 8 },
    title: {
      fontSize: 12,
      fontWeight: "700",
      color: c.inkMuted,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      paddingHorizontal: 12,
      paddingBottom: 4,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 14,
      minHeight: 52,
      borderRadius: RADIUS.control,
    },
    label: { fontSize: 15, fontWeight: "600" },
    // Ação indisponível: só o ícone e o rótulo esmaecem; o motivo fica legível.
    dimmed: { opacity: 0.45 },
    reason: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    cancel: { marginTop: 4, paddingVertical: 14, borderRadius: RADIUS.control, alignItems: "center", backgroundColor: c.surface2 },
    cancelText: { fontSize: 15, fontWeight: "600", color: c.ink },
  });
