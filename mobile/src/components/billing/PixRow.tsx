// Faturamento > "Recebe no PIX": a chave em que a central paga as OS, mascarada (só o bastante para reconhecer), com
// atalho para Configurações > Chave PIX (onde o técnico cadastra e troca a chave, com a senha). Só aparece com o cadastro
// na memória: a chave nunca fica no aparelho. Quem relê o cadastro no "puxar para atualizar" é a aba (BillingView).

import { router } from "expo-router";
import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { maskPixKey, PIX_KEY_TYPE } from "../../lib/constants";
import { ensureProfile, useProfile } from "../../lib/profile";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

const openPix = () => router.push("/configuracoes/pix");

export function PixRow() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const profile = useProfile();

  useEffect(() => {
    ensureProfile();
  }, []);

  if (!profile) return null;
  const pix = profile.pix;
  const type = pix ? PIX_KEY_TYPE[pix.key_type] : null;

  return (
    <Pressable
      onPress={openPix}
      accessibilityRole="button"
      // A chave não é lida em voz alta: só o tipo.
      accessibilityLabel={pix ? `Chave PIX para receber: ${type}` : "Sem chave PIX cadastrada. Cadastrar chave PIX"}
      accessibilityHint={pix ? "Abre a chave PIX" : undefined}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.surface2 }]}
    >
      <View style={[styles.icon, { backgroundColor: pix ? c.primarySoft : c.warningSoft }]}>
        <Icon name="wallet" size={20} color={pix ? c.brandInk : c.warningInk} />
      </View>
      {pix ? (
        <View style={styles.body}>
          <Text style={styles.label}>Recebe no PIX</Text>
          <Text style={styles.value} numberOfLines={1}>
            {`${type} ${maskPixKey(pix.key_type, pix.key)}`}
          </Text>
        </View>
      ) : (
        <View style={styles.body}>
          <Text style={styles.value}>Cadastrar chave PIX</Text>
          <Text style={styles.missing}>Sem chave PIX cadastrada</Text>
        </View>
      )}
      <Icon name="chevronRight" size={18} color={c.inkSubtle} />
    </Pressable>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 64,
      paddingHorizontal: 14,
      paddingVertical: 12,
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.elevation,
    },
    icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
    body: { flex: 1, gap: 2 },
    label: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    value: { fontSize: 15, fontWeight: "600", color: c.ink },
    missing: { fontSize: 13, color: c.inkMuted },
  });
