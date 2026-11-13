import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStyles, type Palette } from "../../theme/theme";
import { useAfterClose } from "../ActionSheet";
import { Text } from "../Text";

/**
 * Folha de página inteira das ações da OS (concluir, visita improdutiva, pedir peça): título, código,
 * descrição, conteúdo rolável e rodapé fixo acima da área segura. O pai controla `visible`;
 * `onClosed` avisa quando a folha terminou de sair (para abrir outra sem disputar a tela no iOS).
 * `onRequestClose` é o voltar do Android e o gesto de descer a folha no iOS.
 */
export function SheetScaffold({
  visible,
  title,
  code,
  description,
  header,
  footer,
  children,
  onRequestClose,
  onClosed,
}: {
  visible: boolean;
  title: string;
  code?: string;
  description?: string;
  /** Conteúdo extra do cabeçalho (ex.: status de origem e de destino). */
  header?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  onRequestClose: () => void;
  onClosed?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const onDismiss = useAfterClose(visible, onClosed);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onRequestClose} onDismiss={onDismiss}>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.header, { paddingTop: Platform.OS === "android" ? insets.top + 12 : 20 }]}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {code ? <Text style={styles.code}>{code}</Text> : null}
          {header}
          {description ? <Text style={styles.description}>{description}</Text> : null}
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>{footer}</View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    header: {
      paddingHorizontal: 20,
      paddingBottom: 14,
      gap: 6,
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
    },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    code: { fontSize: 13, fontWeight: "700", color: c.inkMuted, letterSpacing: 0.3, fontVariant: ["tabular-nums"] },
    description: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    body: { padding: 20, gap: 16 },
    footer: {
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 20,
      paddingTop: 12,
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
  });
