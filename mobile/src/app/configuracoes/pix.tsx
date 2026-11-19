// Configurações › Chave PIX: o tipo, a chave e o titular da conta em que o técnico recebe pelos chamados. Cadastrar,
// trocar e remover pedem a senha atual (conta invadida não desvia o pagamento) e a central é avisada na hora. Só
// online, como todo o cadastro.

import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useRef } from "react";
import { Pressable, StyleSheet, View, type TextInputInstance } from "react-native";
import { ChoiceChips, type ChoiceOption } from "../../components/settings/ChoiceChips";
import { FormCard, ProfileFormScreen } from "../../components/settings/ProfileFormScreen";
import { Text } from "../../components/Text";
import { Button, Field, InfoBox, Input } from "../../components/ui";
import { PIX_KEY_TYPE, PIX_KEY_TYPES } from "../../lib/constants";
import { formatTime } from "../../lib/format";
import { haptic } from "../../lib/haptics";
import { maskPixInput, pixKeyInputProps } from "../../lib/pix";
import { collapse, PIX_SECTION } from "../../lib/profileForm";
import { showToast } from "../../lib/toast";
import type { PixKeyType } from "../../lib/types";
import { useProfileForm } from "../../lib/useProfileForm";
import { useStyles, type Palette } from "../../theme/theme";

const TYPE_OPTIONS: ChoiceOption<PixKeyType>[] = PIX_KEY_TYPES.map((type) => ({ value: type, label: PIX_KEY_TYPE[type] }));

const fullDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

/** "Chave alterada em 18/11/2026 às 14:30." */
function changedAtText(iso: string): string {
  return `Chave alterada em ${fullDate.format(new Date(iso))} às ${formatTime(iso)}.`;
}

export default function PixScreen() {
  const styles = useStyles(makeStyles);
  const state = useProfileForm(PIX_SECTION);
  const { profile, base, errors, update, saving } = state;
  const holderRef = useRef<TextInputInstance>(null);

  /** Trocar o tipo limpa a chave (voltar ao tipo gravado traz a chave gravada); o titular começa com o nome. */
  function chooseType(type: PixKeyType) {
    const form = state.form;
    if (!form || !base || !profile || form.pixType === type) return;
    haptic.select();
    update({
      pixType: type,
      pixKey: type === base.pixType ? base.pixKey : "",
      pixHolder: form.pixHolder.trim() ? form.pixHolder : collapse(profile.name),
    });
  }

  async function pasteKey() {
    const text = (await Clipboard.getStringAsync().catch(() => "")).trim();
    if (!text) {
      showToast("Nada para colar", { description: "Copie a chave aleatória no app do seu banco." });
      return;
    }
    update({ pixKey: maskPixInput("random", text) });
  }

  const savedPix = profile?.pix ?? null;
  const changedAt = savedPix?.updated_at ? changedAtText(savedPix.updated_at) : undefined;

  return (
    <ProfileFormScreen state={state}>
      {(form) => {
        const pixType = form.pixType;
        return (
          <>
            <FormCard>
              {form.pixRemoved ? (
                <View style={styles.removed}>
                  <InfoBox message="A chave PIX sai do cadastro quando você salvar." />
                  <Button compact variant="ghost" title="Desfazer" onPress={() => update({ pixRemoved: false })} style={styles.inline} />
                </View>
              ) : (
                <>
                  <Field label="Tipo da chave PIX">
                    <ChoiceChips
                      options={TYPE_OPTIONS}
                      value={pixType}
                      onChange={(next) => {
                        if (typeof next === "string") chooseType(next);
                      }}
                      accessibilityLabel="Tipo da chave PIX"
                    />
                  </Field>
                  {pixType ? (
                    <>
                      <Field label="Chave PIX" required hint={changedAt} error={errors.pixKey}>
                        <Input
                          // Teclado do tipo: o campo é refeito quando o tipo muda e, num tipo novo, já abre para digitar.
                          key={pixType}
                          autoFocus={pixType !== (savedPix?.key_type ?? null)}
                          value={form.pixKey}
                          onChangeText={(text) => update({ pixKey: maskPixInput(pixType, text) })}
                          accessibilityLabel={`Chave PIX: ${PIX_KEY_TYPE[pixType]}`}
                          {...pixKeyInputProps(pixType)}
                          returnKeyType="next"
                          submitBehavior="submit"
                          onSubmitEditing={() => holderRef.current?.focus()}
                          right={
                            pixType === "random" ? (
                              <Pressable
                                onPress={() => void pasteKey()}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel="Colar a chave"
                              >
                                <Text style={styles.paste}>Colar</Text>
                              </Pressable>
                            ) : undefined
                          }
                        />
                      </Field>
                      <Field label="Nome do titular da conta" required error={errors.pixHolder}>
                        <Input
                          ref={holderRef}
                          value={form.pixHolder}
                          onChangeText={(pixHolder) => update({ pixHolder })}
                          accessibilityLabel="Nome do titular da conta"
                          autoCapitalize="words"
                          maxLength={160}
                        />
                      </Field>
                    </>
                  ) : null}
                  {savedPix ? (
                    <Button
                      compact
                      variant="danger"
                      title="Remover chave PIX"
                      onPress={() => update({ pixRemoved: true })}
                      style={styles.inline}
                    />
                  ) : null}
                </>
              )}
            </FormCard>
            <Pressable
              // Salvando, não sai da tela: ao terminar, o "voltar" fecharia o aviso em vez da chave PIX.
              onPress={() => router.push("/privacidade")}
              disabled={saving}
              hitSlop={14}
              accessibilityRole="link"
              accessibilityState={{ disabled: saving }}
              style={({ pressed }) => [styles.privacy, (pressed || saving) && styles.linkPressed]}
            >
              <Text style={styles.link}>Aviso de privacidade</Text>
            </Pressable>
          </>
        );
      }}
    </ProfileFormScreen>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    removed: { gap: 6 },
    inline: { alignSelf: "flex-start" },
    paste: { fontSize: 14, fontWeight: "700", color: c.brandInk },
    privacy: { alignSelf: "flex-start" },
    link: { fontSize: 13, fontWeight: "600", color: c.brandInk },
    linkPressed: { opacity: 0.6 },
  });
