// Folha da forma de recebimento (Configurações › Formas de recebimento), para adicionar e para editar. Chave PIX: o tipo,
// a chave, o titular e, nas chaves e-mail, celular e aleatória, o CPF ou CNPJ do titular (na CPF e na CNPJ, é a própria
// chave). Conta bancária: o banco (com sugestões; fora da lista, o código), a agência, a conta e o dígito, o tipo, o
// titular e o documento. Começa com o cadastro: titular = o nome, documento = o CPF e, ao escolher o tipo da chave, a
// chave do cadastro (CPF, CNPJ da empresa, e-mail, celular). Ao adicionar, já havendo outra, "Usar como preferencial".
// A senha atual vai junto: o erro do servidor aparece no fim da folha e a senha volta limpa, com o foco. Os erros dos
// campos aparecem depois do primeiro toque no botão, na ordem da tela. Quem grava é a tela (onSubmit).

import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View, type KeyboardTypeOptions, type TextInputInstance } from "react-native";
import { bankByCode, bankSuggestions } from "../../lib/banks";
import { BANK_ACCOUNT_TYPE, BANK_ACCOUNT_TYPES, PAYOUT_KIND, PAYOUT_LIMITS, PIX_KEY_TYPE, PIX_KEY_TYPES } from "../../lib/constants";
import { formatTime } from "../../lib/format";
import { haptic } from "../../lib/haptics";
import { maskAccountDigit, maskAccountNumber, maskBranch, maskDocument, onlyDigits, splitAccount } from "../../lib/masks";
import {
  choosePixType,
  holderDocumentNeeded,
  payoutChanged,
  payoutDraftOf,
  payoutInput,
  payoutProblem,
  pickBank,
  typeBank,
  type PayoutDraft,
  type PayoutOwner,
} from "../../lib/payoutForm";
import { maskPixInput, pixKeyInputProps } from "../../lib/pix";
import { OFFLINE_SAVE } from "../../lib/technicalProfile";
import type { BankAccountType, PayoutMethod, PayoutMethodIn, PayoutMethodKind, PixKeyType } from "../../lib/types";
import { useStyles, type Palette } from "../../theme/theme";
import { Text } from "../Text";
import { Field, Input, SectionTitle } from "../ui";
import { CheckCard } from "./CheckCard";
import { ChoiceChips, type ChoiceOption } from "./ChoiceChips";
import { FormSheet } from "./FormSheet";
import { PasswordField } from "./PasswordField";

export type PayoutSheetTarget = { kind: "add" } | { kind: "edit"; method: PayoutMethod };

const KIND_OPTIONS: ChoiceOption<PayoutMethodKind>[] = (["pix", "bank"] as const).map((kind) => ({ value: kind, label: PAYOUT_KIND[kind] }));
const PIX_TYPE_OPTIONS: ChoiceOption<PixKeyType>[] = PIX_KEY_TYPES.map((type) => ({ value: type, label: PIX_KEY_TYPE[type] }));
const ACCOUNT_TYPE_OPTIONS: ChoiceOption<BankAccountType>[] = BANK_ACCOUNT_TYPES.map((type) => ({ value: type, label: BANK_ACCOUNT_TYPE[type] }));

/** Dígito da conta e documento do titular: números à frente, com as letras à mão (o X do dígito, o CNPJ com letras). */
const MIXED_KEYBOARD: KeyboardTypeOptions = Platform.OS === "ios" ? "numbers-and-punctuation" : "default";

const fullDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

/** "Alterada em 18/11/2026 às 14:30." */
function changedAtText(iso: string): string {
  return `Alterada em ${fullDate.format(new Date(iso))} às ${formatTime(iso)}.`;
}

/** O campo tem texto (o código do banco só é pedido depois do nome de um banco fora da lista). */
const filled = (text: string) => text.trim() !== "";

export function PayoutMethodSheet({
  visible,
  target,
  methods,
  owner,
  onSubmit,
  onClose,
  onClosed,
}: {
  visible: boolean;
  target: PayoutSheetTarget;
  /** As formas do técnico (a editada também): a chave e a conta não podem repetir. */
  methods: readonly PayoutMethod[];
  owner: PayoutOwner;
  /** Grava. Devolve a mensagem de erro, ou null quando gravou (a tela fecha a folha). */
  onSubmit: (input: PayoutMethodIn, options: { preferred: boolean; password: string }) => Promise<string | null>;
  onClose: () => void;
  onClosed: () => void;
}) {
  const styles = useStyles(makeStyles);
  const editing = target.kind === "edit" ? target.method : null;
  const [base] = useState(() => payoutDraftOf(editing, owner));
  const [draft, setDraft] = useState<PayoutDraft>(base);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Tocou em "Colar" com a área de transferência vazia. */
  const [pasteEmpty, setPasteEmpty] = useState(false);
  const holderRef = useRef<TextInputInstance>(null);
  const documentRef = useRef<TextInputInstance>(null);
  const accountRef = useRef<TextInputInstance>(null);
  const digitRef = useRef<TextInputInstance>(null);
  const passwordRef = useRef<TextInputInstance>(null);
  const sending = useRef(false);

  const others = editing ? methods.filter((m) => m.id !== editing.id) : methods;
  const problems = payoutProblem(draft, others);
  const shown = attempted ? problems : {};
  // Ao adicionar, só trocar entre chave e conta não é alteração (nada foi preenchido).
  const changed = payoutChanged(draft, editing ? base : { ...base, kind: draft.kind });
  const needsDocument = holderDocumentNeeded(draft);
  const changedAt = editing ? changedAtText(editing.changed_at) : undefined;
  const pixType = draft.kind === "pix" ? draft.pixType : null;
  const suggestions = draft.kind === "bank" ? bankSuggestions(draft.bankName) : [];
  const title = editing ? (editing.kind === "pix" ? "Editar chave PIX" : "Editar conta bancária") : "Adicionar forma de recebimento";

  function update(patch: Partial<PayoutDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  }

  /** Uma regra de lib/payoutForm.ts sobre a folha como está (trocar o tipo da chave, digitar ou escolher o banco). */
  function change(step: (current: PayoutDraft) => PayoutDraft) {
    setDraft(step);
    setError(null);
  }

  async function pasteKey() {
    const text = (await Clipboard.getStringAsync().catch(() => "")).trim();
    setPasteEmpty(!text);
    if (text) update({ pixKey: maskPixInput("random", text) });
  }

  /** Conta colada com o dígito ("12345-6") separa; digitou o hífen, o dígito vai no campo ao lado. */
  function typeAccount(text: string) {
    const split = splitAccount(text);
    if (split) {
      update({ accountNumber: split.number, accountDigit: split.digit });
      return;
    }
    update({ accountNumber: maskAccountNumber(text) });
    if (/-\s*$/.test(text)) digitRef.current?.focus();
  }

  async function submit() {
    // O "Concluído" do teclado na senha também envia: com um envio no ar, não manda outro.
    if (sending.current) return;
    setAttempted(true);
    setError(null);
    const input = Object.keys(problems).length ? null : payoutInput(draft);
    if (!input) {
      haptic.warning();
      return;
    }
    sending.current = true;
    setBusy(true);
    let message: string | null;
    try {
      message = await onSubmit(input, { preferred: draft.preferred, password: draft.password });
    } finally {
      sending.current = false;
      setBusy(false);
    }
    if (!message) return;
    haptic.warning();
    setError(message);
    // O servidor recusou (senha errada, chave repetida…): a senha não fica na tela. Sem internet, nada saiu: ela fica.
    if (message !== OFFLINE_SAVE) {
      setDraft((current) => ({ ...current, password: "" }));
      passwordRef.current?.focus();
    }
  }

  return (
    <FormSheet
      visible={visible}
      title={title}
      submitLabel={editing ? "Salvar" : "Adicionar"}
      onSubmit={() => void submit()}
      onClose={onClose}
      onClosed={onClosed}
      busy={busy}
      error={error}
      dirty={changed}
      submitDisabled={Boolean(editing) && !changed}
    >
      {editing ? null : (
        <Field label="Tipo" required>
          <ChoiceChips
            options={KIND_OPTIONS}
            value={draft.kind}
            accessibilityLabel="Tipo"
            onChange={(next) => {
              if (Array.isArray(next) || next === draft.kind) return;
              haptic.select();
              update({ kind: next });
            }}
          />
        </Field>
      )}

      {draft.kind === "pix" ? (
        <>
          <Field label="Tipo da chave" required error={shown.pixType}>
            <ChoiceChips
              options={PIX_TYPE_OPTIONS}
              value={draft.pixType}
              accessibilityLabel="Tipo da chave"
              onChange={(next) => {
                if (Array.isArray(next) || next === draft.pixType) return;
                haptic.select();
                setPasteEmpty(false);
                change((current) => choosePixType(current, next, owner, editing));
              }}
            />
          </Field>
          {pixType ? (
            <Field
              label="Chave PIX"
              required
              hint={pasteEmpty ? "Nada para colar: copie a chave no app do seu banco." : changedAt}
              error={shown.pixKey}
            >
              <Input
                // Teclado do tipo: o campo é refeito quando o tipo muda e, sem chave sugerida, já abre para digitar.
                key={pixType}
                autoFocus={!draft.pixKey}
                value={draft.pixKey}
                onChangeText={(text) => {
                  setPasteEmpty(false);
                  update({ pixKey: maskPixInput(pixType, text) });
                }}
                accessibilityLabel={`Chave PIX: ${PIX_KEY_TYPE[pixType]}`}
                {...pixKeyInputProps(pixType)}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => holderRef.current?.focus()}
                right={
                  pixType === "random" ? (
                    <Pressable onPress={() => void pasteKey()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Colar a chave">
                      <Text style={styles.paste}>Colar</Text>
                    </Pressable>
                  ) : undefined
                }
              />
            </Field>
          ) : null}
        </>
      ) : (
        <>
          <Field label="Banco" required hint={draft.bankPicked ? `Código ${draft.bankCode}` : undefined} error={shown.bankName}>
            <Input
              value={draft.bankName}
              onChangeText={(text) => change((current) => typeBank(current, text))}
              maxLength={PAYOUT_LIMITS.bankName}
              autoCapitalize="words"
              autoCorrect={false}
              accessibilityLabel="Banco"
              returnKeyType="done"
            />
          </Field>
          {suggestions.length ? (
            <View>
              <SectionTitle>Sugestões</SectionTitle>
              <ChoiceChips
                options={suggestions.map((bank) => ({ value: bank.code, label: bank.name }))}
                value={draft.bankPicked ? draft.bankCode : null}
                accessibilityLabel="Sugestões de banco"
                onChange={(code) => {
                  const bank = Array.isArray(code) ? null : bankByCode(code);
                  if (!bank) return;
                  haptic.select();
                  change((current) => pickBank(current, bank));
                }}
              />
            </View>
          ) : null}
          {!draft.bankPicked && filled(draft.bankName) ? (
            <View style={styles.short}>
              <Field label="Código do banco" required error={shown.bankCode}>
                <Input
                  value={draft.bankCode}
                  onChangeText={(text) => update({ bankCode: onlyDigits(text).slice(0, 3) })}
                  keyboardType="number-pad"
                  accessibilityLabel="Código do banco"
                />
              </Field>
            </View>
          ) : null}
          <View style={styles.short}>
            <Field label="Agência" required error={shown.branch}>
              <Input
                value={draft.branch}
                onChangeText={(text) => update({ branch: maskBranch(text) })}
                keyboardType="number-pad"
                accessibilityLabel="Agência"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => accountRef.current?.focus()}
              />
            </Field>
          </View>
          <View style={styles.row}>
            <View style={styles.grow}>
              <Field label="Conta" required hint={changedAt} error={shown.accountNumber}>
                <Input
                  ref={accountRef}
                  value={draft.accountNumber}
                  onChangeText={typeAccount}
                  keyboardType="number-pad"
                  accessibilityLabel="Conta, sem o dígito"
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => digitRef.current?.focus()}
                />
              </Field>
            </View>
            <View style={styles.digit}>
              <Field label="Dígito" required error={shown.accountDigit}>
                <Input
                  ref={digitRef}
                  value={draft.accountDigit}
                  onChangeText={(text) => update({ accountDigit: maskAccountDigit(text) })}
                  keyboardType={MIXED_KEYBOARD}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  accessibilityLabel="Dígito da conta"
                  returnKeyType="done"
                />
              </Field>
            </View>
          </View>
          <Field label="Tipo de conta" required error={shown.accountType}>
            <ChoiceChips
              options={ACCOUNT_TYPE_OPTIONS}
              value={draft.accountType}
              accessibilityLabel="Tipo de conta"
              onChange={(next) => {
                if (Array.isArray(next)) return;
                haptic.select();
                update({ accountType: next });
              }}
            />
          </Field>
        </>
      )}

      <Field label="Titular" required error={shown.holderName}>
        <Input
          ref={holderRef}
          value={draft.holderName}
          onChangeText={(holderName) => update({ holderName })}
          maxLength={PAYOUT_LIMITS.holderName}
          autoCapitalize="words"
          autoCorrect={false}
          accessibilityLabel="Titular"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => (needsDocument ? documentRef.current?.focus() : passwordRef.current?.focus())}
        />
      </Field>
      {needsDocument ? (
        <Field label="CPF ou CNPJ do titular" required error={shown.holderDocument}>
          <Input
            ref={documentRef}
            value={draft.holderDocument}
            onChangeText={(text) => update({ holderDocument: maskDocument(text) })}
            keyboardType={MIXED_KEYBOARD}
            autoCapitalize="characters"
            autoCorrect={false}
            accessibilityLabel="CPF ou CNPJ do titular"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
        </Field>
      ) : null}

      {!editing && methods.length > 0 ? (
        <CheckCard
          label="Usar como preferencial"
          checked={draft.preferred}
          onPress={() => {
            haptic.select();
            change((current) => ({ ...current, preferred: !current.preferred }));
          }}
        />
      ) : null}

      <PasswordField
        required
        value={draft.password}
        onChangeText={(password) => update({ password })}
        // Com o erro do servidor à vista (logo abaixo), o campo vazio não repete "Informe a senha atual".
        error={error ? null : shown.password}
        inputRef={passwordRef}
        onSubmitEditing={() => void submit()}
      />
    </FormSheet>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    paste: { fontSize: 14, fontWeight: "700", color: c.brandInk },
    // Agência e código do banco: até 4 números.
    short: { width: 110 },
    // Conta e dígito lado a lado.
    row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    grow: { flex: 1 },
    digit: { width: 84 },
  });
