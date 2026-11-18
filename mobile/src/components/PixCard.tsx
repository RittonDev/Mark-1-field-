// Ganhos > recebimento por PIX: a chave em que a central paga os chamados, com atalho para o Meu cadastro (onde o
// técnico cadastra e troca a chave). Só aparece com o cadastro carregado: a chave fica na memória, nunca no aparelho.

import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { formatPixKey, PIX_KEY_TYPE } from "../lib/constants";
import { ensureProfile, loadProfile, useProfile } from "../lib/profile";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { Button, Card } from "./ui";

const openProfile = () => router.push("/meu-cadastro");

/** `refreshKey` muda a cada "puxar para atualizar" em Ganhos: o cadastro é relido junto (a central pode ter tirado a chave). */
export function PixCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const profile = useProfile();
  // O "puxar para atualizar" já tratado: voltar à aba Ganhos depois de um não relê de novo.
  const handledRefresh = useRef(refreshKey);

  useEffect(() => {
    if (refreshKey !== handledRefresh.current) {
      handledRefresh.current = refreshKey;
      void loadProfile().catch(() => undefined);
    } else {
      ensureProfile();
    }
  }, [refreshKey]);

  if (!profile) return null;
  const pix = profile.pix;

  if (!pix) {
    return (
      <Card style={styles.missing}>
        <View style={styles.row}>
          <Icon name="wallet" size={20} color={c.inkMuted} />
          <Text style={styles.missingText}>Sem chave PIX cadastrada</Text>
        </View>
        <Button title="Cadastrar chave PIX" compact onPress={openProfile} style={{ alignSelf: "flex-start" }} />
      </Card>
    );
  }

  const value = `${PIX_KEY_TYPE[pix.key_type]} · ${formatPixKey(pix.key_type, pix.key)}`;
  return (
    <Pressable
      onPress={openProfile}
      accessibilityRole="button"
      accessibilityLabel={`Recebimento por PIX: ${value}`}
      accessibilityHint="Abre o Meu cadastro"
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: c.surface2 }]}
    >
      <View style={styles.icon}>
        <Icon name="wallet" size={20} color={c.brandInk} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.label}>Recebimento por PIX</Text>
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <Icon name="chevronRight" size={18} color={c.inkSubtle} />
    </Pressable>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
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
    icon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.primarySoft,
    },
    label: { fontSize: 12, fontWeight: "600", color: c.inkMuted },
    value: { fontSize: 15, fontWeight: "600", color: c.ink },
    missing: { gap: 10 },
    row: { flexDirection: "row", alignItems: "center", gap: 10 },
    missingText: { fontSize: 15, fontWeight: "600", color: c.ink, flex: 1 },
  });
