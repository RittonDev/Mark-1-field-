// Faturamento › "Recebe no PIX" / "Recebe na conta": a forma de recebimento preferencial (onde a central paga as OS),
// mascarada (só o bastante para reconhecer), com atalho para Configurações › Formas de recebimento (onde o técnico
// cadastra chaves PIX e contas, com a senha). Sem nenhuma, "Cadastrar chave ou conta" em âmbar. Com a API antiga, a
// chave PIX de antes. Só aparece com o cadastro na memória: chave e conta nunca ficam no aparelho. Quem relê o cadastro
// no "puxar para atualizar" é a aba (BillingView). O nome do arquivo ficou o de antes.

import { router } from "expo-router";
import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { maskPixKey, payoutMethodText, PIX_KEY_TYPE } from "../../lib/constants";
import { preferredPayout } from "../../lib/payoutForm";
import { ensureProfile, useProfile } from "../../lib/profile";
import type { PayoutMethod } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

const openPayouts = () => router.push("/configuracoes/recebimento");

/** O rótulo, a forma mascarada e o que o leitor de tela fala (sem a chave nem a conta: o tipo ou o banco). */
function rowOf(method: PayoutMethod): { label: string; value: string; spoken: string } {
  if (method.kind === "pix") {
    const type = PIX_KEY_TYPE[method.pix_key_type];
    return { label: "Recebe no PIX", value: `${type} ${maskPixKey(method.pix_key_type, method.pix_key)}`, spoken: `Recebe no PIX: ${type}` };
  }
  return { label: "Recebe na conta", value: payoutMethodText(method), spoken: `Recebe na conta: ${method.bank_name}` };
}

export function PixRow() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const profile = useProfile();

  useEffect(() => {
    ensureProfile();
  }, []);

  if (!profile) return null;
  const method = preferredPayout(profile);
  const row = method ? rowOf(method) : null;

  return (
    <Pressable
      onPress={openPayouts}
      accessibilityRole="button"
      accessibilityLabel={row ? row.spoken : "Sem forma de recebimento. Cadastrar chave ou conta"}
      accessibilityHint={row ? "Abre as formas de recebimento" : undefined}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.surface2 }]}
    >
      <View style={[styles.icon, { backgroundColor: row ? c.primarySoft : c.warningSoft }]}>
        <Icon name={method ? (method.kind === "pix" ? "key" : "bank") : "wallet"} size={20} color={row ? c.brandInk : c.warningInk} />
      </View>
      {row ? (
        <View style={styles.body}>
          <Text style={styles.label}>{row.label}</Text>
          <Text style={styles.value} numberOfLines={1}>
            {row.value}
          </Text>
        </View>
      ) : (
        <View style={styles.body}>
          <Text style={styles.value}>Cadastrar chave ou conta</Text>
          <Text style={styles.missing}>Sem forma de recebimento</Text>
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
