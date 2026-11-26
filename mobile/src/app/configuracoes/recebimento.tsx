// Formas de recebimento (Configurações › Dados financeiros e empresariais): as chaves PIX e as contas bancárias em que o
// técnico recebe pelos chamados, com uma preferencial (onde a central paga). Adicionar, editar, tornar preferencial e
// excluir pedem a senha atual (conta invadida não desvia o pagamento); cada ação sai pela rota própria, na fila das
// gravações (lib/payoutMethods.ts), e a central é avisada na hora. A preferencial vem primeiro, depois as mais novas;
// excluir a preferencial passa a preferência para a mais nova das que ficam (a folha diz qual antes). Até 10. Uma
// gravação por vez, como na Formação: a trava vale também depois de sair e voltar (lib/technicalProfile.ts). Só online e
// só na memória: chave, conta e documento nunca ficam no aparelho. Sem a API nova (hasCadastroV2), "Indisponível".

import { router } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { ActionSheet, type SheetAction } from "../../components/ActionSheet";
import { Icon } from "../../components/Icon";
import { useListMotion } from "../../components/motion";
import { FixedFooter } from "../../components/settings/FixedFooter";
import { OfflineNotice } from "../../components/settings/OfflineNotice";
import { PasswordSheet } from "../../components/settings/PasswordSheet";
import { PayoutMethodSheet, type PayoutSheetTarget } from "../../components/settings/PayoutMethodSheet";
import { ProfileGate } from "../../components/settings/ProfileGate";
import { Text } from "../../components/Text";
import { Button, EmptyState, InfoBox } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { PAYOUT_LIMITS, payoutMethodText } from "../../lib/constants";
import { haptic } from "../../lib/haptics";
import { noNetwork, offlineFailure } from "../../lib/net";
import { hasCadastroV2, loadProfile } from "../../lib/profile";
import { nextPreferred, PAYOUT_MSG, payoutCard, payoutOwnerOf, payoutSpoken, preferredPayout } from "../../lib/payoutForm";
import { addPayoutMethod, payoutMethodGone, preferPayoutMethod, removePayoutMethod, updatePayoutMethod } from "../../lib/payoutMethods";
import { OFFLINE_SAVE, trackListWrite, UNAVAILABLE, useListWrite } from "../../lib/technicalProfile";
import { showToast } from "../../lib/toast";
import type { PayoutMethod, PayoutMethodIn } from "../../lib/types";
import { useProfileLoad } from "../../lib/useProfileForm";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";

interface FormState {
  /** Uma folha nova a cada abertura (o formulário começa do zero). */
  key: number;
  open: boolean;
  target: PayoutSheetTarget;
}

type ConfirmAction = "prefer" | "remove";

/** Título, texto e botão da folha da senha de uma ação. */
interface ConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
}

/** A folha da senha de "Tornar preferencial" e "Excluir". */
interface ConfirmState {
  key: number;
  open: boolean;
  action: ConfirmAction;
  method: PayoutMethod;
  /** Fixo ao abrir: a lista muda quando a gravação volta e a folha ainda está saindo. */
  copy: ConfirmCopy;
  password: string;
  error: string | null;
  saving: boolean;
}

const NO_METHODS: PayoutMethod[] = [];

/** O texto de cada ação diz para onde os pagamentos passam a ir. */
function confirmCopy(action: ConfirmAction, method: PayoutMethod, methods: readonly PayoutMethod[]): ConfirmCopy {
  const text = payoutMethodText(method);
  if (action === "prefer") {
    return {
      title: "Tornar preferencial?",
      description: `Os pagamentos passam a ir para ${text}.`,
      confirmLabel: "Tornar preferencial",
      destructive: false,
    };
  }
  const next = nextPreferred(methods, method.id);
  const description = next
    ? `${text} sai da lista. Os pagamentos passam a ir para ${payoutMethodText(next)}.`
    : method.preferred
      ? `${text} sai da lista. Você fica sem forma de recebimento.`
      : `${text} sai da lista.`;
  return {
    title: method.kind === "pix" ? "Excluir a chave PIX?" : "Excluir a conta?",
    description,
    confirmLabel: "Excluir",
    destructive: true,
  };
}

export default function PayoutMethodsScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const motion = useListMotion();
  const { profile, load, retry, refresh, refreshing } = useProfileLoad();
  // Uma gravação da lista no ar (`writing`): adicionar, editar, tornar preferencial e excluir ficam desligados.
  // `removing`: as formas que estão saindo, pelo id.
  const { busy: writing, removing } = useListWrite("payout");
  const [form, setForm] = useState<FormState | null>(null);
  const [menu, setMenu] = useState<{ open: boolean; method: PayoutMethod } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // Dois toques seguidos em "Confirmar" não mandam dois pedidos (a conferência da rede já é assíncrona).
  const confirming = useRef(false);

  if (!profile || !hasCadastroV2(profile)) {
    if (load.status === "error") return <ProfileGate load={load} onRetry={retry} />;
    if (profile && load.status === "ok") {
      return (
        <View style={styles.center}>
          <EmptyState icon="alert" title={UNAVAILABLE.title} description={UNAVAILABLE.description} action={{ label: "Tentar de novo", onPress: retry }} />
        </View>
      );
    }
    return <ProfileGate load={{ status: "loading" }} onRetry={retry} />;
  }

  const methods = profile.payout_methods ?? NO_METHODS;
  const full = methods.length >= PAYOUT_LIMITS.methods;
  const stale = load.status === "error" && !load.offline;
  const owner = payoutOwnerOf(profile);

  function openForm(target: PayoutSheetTarget) {
    if (writing) return;
    setForm((current) => ({ key: (current?.key ?? 0) + 1, open: true, target }));
  }

  function closeForm() {
    setForm((current) => (current ? { ...current, open: false } : current));
  }

  function formClosed() {
    setForm((current) => (current && !current.open ? null : current));
  }

  async function submitForm(target: PayoutSheetTarget, input: PayoutMethodIn, options: { preferred: boolean; password: string }) {
    if (await noNetwork()) return OFFLINE_SAVE;
    try {
      await trackListWrite("payout", null, () =>
        target.kind === "edit" ? updatePayoutMethod(target.method.id, input, options.password) : addPayoutMethod(input, options),
      );
      haptic.success();
      const pix = input.kind === "pix";
      const title = target.kind === "edit" ? (pix ? "Chave PIX atualizada" : "Conta atualizada") : pix ? "Chave PIX adicionada" : "Conta adicionada";
      showToast(title, { tone: "success", description: "A central foi avisada." });
      closeForm();
      return null;
    } catch (error) {
      // A central excluiu a forma enquanto a folha estava aberta: a lista atrás já se atualiza.
      if (payoutMethodGone(error)) void loadProfile().catch(() => undefined);
      return (await offlineFailure(error)) ? OFFLINE_SAVE : errorMessage(error);
    }
  }

  function openMenu(method: PayoutMethod) {
    if (writing) return;
    haptic.select();
    setMenu({ open: true, method });
  }

  function ask(action: ConfirmAction, method: PayoutMethod) {
    if (writing) return;
    const copy = confirmCopy(action, method, methods);
    setConfirm((current) => ({ key: (current?.key ?? 0) + 1, open: true, action, method, copy, password: "", error: null, saving: false }));
  }

  function patchConfirm(patch: Partial<ConfirmState>) {
    setConfirm((current) => (current ? { ...current, ...patch } : current));
  }

  function closeConfirm() {
    setConfirm((current) => (current && !current.saving ? { ...current, open: false, password: "", error: null } : current));
  }

  function confirmClosed() {
    setConfirm((current) => (current && !current.open ? null : current));
  }

  async function runConfirm() {
    const current = confirm;
    if (!current || current.saving || confirming.current) return;
    if (!current.password) {
      patchConfirm({ error: PAYOUT_MSG.password });
      return;
    }
    confirming.current = true;
    try {
      if (await noNetwork()) {
        patchConfirm({ error: OFFLINE_SAVE });
        return;
      }
      patchConfirm({ saving: true, error: null });
      const { action, method, password } = current;
      try {
        const saved = await trackListWrite("payout", action === "remove" ? method.id : null, () =>
          action === "prefer" ? preferPayoutMethod(method.id, password) : removePayoutMethod(method.id, password),
        );
        haptic.success();
        if (action === "prefer") {
          showToast("Preferencial atualizada", { tone: "success", description: `Os pagamentos vão para ${payoutMethodText(method)}.` });
        } else {
          // Era a preferencial: diz para onde os pagamentos foram (a que o servidor escolheu).
          const now = method.preferred ? preferredPayout(saved) : null;
          showToast(method.kind === "pix" ? "Chave PIX excluída" : "Conta excluída", {
            tone: "success",
            description: now ? `Os pagamentos vão para ${payoutMethodText(now)}.` : undefined,
          });
        }
        patchConfirm({ open: false, saving: false, password: "" });
      } catch (error) {
        if (payoutMethodGone(error)) void loadProfile().catch(() => undefined);
        const offline = await offlineFailure(error);
        // A senha volta limpa e o campo ganha o foco (PasswordSheet).
        patchConfirm({ saving: false, password: "", error: offline ? OFFLINE_SAVE : errorMessage(error) });
      }
    } finally {
      confirming.current = false;
    }
  }

  const menuActions: SheetAction[] = menu
    ? [
        { key: "edit", label: "Editar", icon: "pencil", onPress: () => openForm({ kind: "edit", method: menu.method }) },
        ...(menu.method.preferred
          ? []
          : [{ key: "prefer", label: "Tornar preferencial", icon: "checkCircle", onPress: () => ask("prefer", menu.method) } satisfies SheetAction]),
        { key: "remove", label: "Excluir", icon: "trash", tone: "danger", onPress: () => ask("remove", menu.method) },
      ]
    : [];

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[c.primary]} tintColor={c.primary} />}
      >
        <OfflineNotice />
        {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}
        {methods.length ? (
          methods.map((method, index) => {
            const card = payoutCard(method);
            const leaving = removing.includes(method.id);
            return (
              <Animated.View
                key={method.id}
                entering={motion.entering(index)}
                exiting={motion.reduced ? undefined : FadeOut.duration(150)}
                layout={motion.layout}
              >
                <Pressable
                  onPress={() => openMenu(method)}
                  disabled={writing}
                  accessibilityRole="button"
                  accessibilityLabel={method.preferred ? `${payoutSpoken(method)}, preferencial` : payoutSpoken(method)}
                  accessibilityHint="Abre as ações"
                  accessibilityState={{ disabled: writing, busy: leaving }}
                  style={({ pressed }) => [styles.card, pressed && { backgroundColor: c.surface2 }, leaving && styles.leaving]}
                >
                  <View style={styles.icon}>
                    <Icon name={method.kind === "pix" ? "key" : "bank"} size={20} color={c.brandInk} />
                  </View>
                  <View style={styles.cardText}>
                    <View style={styles.titleRow}>
                      <Text style={styles.title}>{card.title}</Text>
                      {method.preferred ? (
                        <View style={styles.chip}>
                          <Icon name="check" size={12} color={c.ink} strokeWidth={2.4} />
                          <Text style={styles.chipText} maxFontSizeMultiplier={1.4}>
                            Preferencial
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.detail}>{card.detail}</Text>
                    {card.holder ? <Text style={styles.holder}>{card.holder}</Text> : null}
                  </View>
                  {leaving ? (
                    <ActivityIndicator size="small" color={c.inkMuted} />
                  ) : (
                    <Icon name="more" size={20} color={writing ? c.line : c.inkSubtle} />
                  )}
                </Pressable>
              </Animated.View>
            );
          })
        ) : (
          <EmptyState icon="wallet" title="Nenhuma forma de recebimento" description="Adicione uma chave PIX ou uma conta bancária." />
        )}
        <Pressable
          onPress={() => router.push("/privacidade")}
          hitSlop={14}
          accessibilityRole="link"
          style={({ pressed }) => [styles.privacy, pressed && styles.linkPressed]}
        >
          <Text style={styles.link}>Aviso de privacidade</Text>
        </Pressable>
      </ScrollView>

      <FixedFooter>
        {full ? <InfoBox message={PAYOUT_MSG.limit} /> : null}
        <Button
          title="Adicionar chave ou conta"
          icon="plus"
          variant="primary"
          onPress={() => openForm({ kind: "add" })}
          disabled={full || writing}
        />
      </FixedFooter>

      <ActionSheet
        visible={Boolean(menu?.open)}
        title={menu ? payoutMethodText(menu.method) : ""}
        actions={menuActions}
        onClose={() => setMenu((current) => (current ? { ...current, open: false } : current))}
      />

      {form ? (
        <PayoutMethodSheet
          key={form.key}
          visible={form.open}
          target={form.target}
          methods={methods}
          owner={owner}
          onSubmit={(input, options) => submitForm(form.target, input, options)}
          onClose={closeForm}
          onClosed={formClosed}
        />
      ) : null}

      {confirm ? (
        <PasswordSheet
          key={confirm.key}
          visible={confirm.open}
          title={confirm.copy.title}
          description={confirm.copy.description}
          password={confirm.password}
          onChangePassword={(password) => patchConfirm({ password, error: null })}
          error={confirm.error}
          saving={confirm.saving}
          confirmLabel={confirm.copy.confirmLabel}
          destructive={confirm.copy.destructive}
          onConfirm={() => void runConfirm()}
          onClose={closeConfirm}
          onClosed={confirmClosed}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    scroll: { flex: 1 },
    content: { padding: 16, gap: 10 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.canvas },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 64,
      paddingVertical: 14,
      paddingHorizontal: 16,
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.elevation,
    },
    leaving: { opacity: 0.6 },
    icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: c.primarySoft },
    cardText: { flex: 1, gap: 3 },
    titleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
    title: { fontSize: 15, fontWeight: "700", color: c.ink, flexShrink: 1 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: RADIUS.chip,
      backgroundColor: c.surface3,
    },
    chipText: { fontSize: 12, fontWeight: "700", color: c.ink },
    detail: { fontSize: 13, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    holder: { fontSize: 13, color: c.ink },
    privacy: { alignSelf: "flex-start", marginTop: 6 },
    link: { fontSize: 13, fontWeight: "600", color: c.brandInk },
    linkPressed: { opacity: 0.6 },
  });
