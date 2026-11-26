// Folha "Adicionar aptidão" (Configurações › Aptidões): as aptidões do catálogo que a central mantém (GET
// /technician-skills), várias de uma vez, todas com o mesmo nível. Nesta ordem: o nível, a busca, quantas estão
// escolhidas e as aptidões que o técnico ainda não tem (availableSkills, na ordem de searchCatalog). Para no limite de
// 30 aptidões, contando as que ele já tem. A aptidão que não está na lista, ele pede à central pelo WhatsApp (o texto
// livre saiu). Os erros aparecem depois de tocar no botão; o do servidor, no fim da folha. Quem grava é a tela
// (onSubmit), que fecha a folha quando dá certo.

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { TECH_PROFILE_LIMITS } from "../../lib/constants";
import { haptic } from "../../lib/haptics";
import type { CatalogState } from "../../lib/technicalProfile";
import { availableSkills, searchCatalog, SKILL_MSG, type SkillRef } from "../../lib/techProfileForm";
import type { SkillLevel, TechCatalogItem } from "../../lib/types";
import { useStyles, type Palette } from "../../theme/theme";
import { Skeleton } from "../Skeleton";
import { Text } from "../Text";
import { EmptyState, Field, InfoBox, Input } from "../ui";
import { CheckCard } from "./CheckCard";
import { ChoiceChips } from "./ChoiceChips";
import { FormSheet } from "./FormSheet";
import { SKILL_LEVEL_OPTIONS } from "./SkillSheet";

const LIMIT_TEXT = `Limite de ${TECH_PROFILE_LIMITS.skills} aptidões.`;

/** "1 escolhida" / "3 escolhidas". */
const chosenText = (n: number) => (n === 1 ? "1 escolhida" : `${n} escolhidas`);

export function SkillCatalogSheet({
  visible,
  catalog,
  mine,
  onRetry,
  onSubmit,
  onClose,
  onClosed,
}: {
  visible: boolean;
  /** O catálogo na memória (useSkillCatalog): lendo, com erro ou a lista das ativas. */
  catalog: CatalogState<TechCatalogItem[]>;
  /** As aptidões do técnico agora: saem da lista e contam no limite. */
  mine: readonly SkillRef[];
  /** "Tentar de novo" quando a lista não veio. */
  onRetry: () => void;
  /** Grava as escolhidas com o nível. Devolve a mensagem de erro, ou null quando gravou. */
  onSubmit: (picked: TechCatalogItem[], level: SkillLevel) => Promise<string | null>;
  onClose: () => void;
  onClosed: () => void;
}) {
  const styles = useStyles(makeStyles);
  const [level, setLevel] = useState<SkillLevel | null>(null);
  const [query, setQuery] = useState("");
  /** Os ids marcados (os que saírem da lista relida deixam de contar). */
  const [picked, setPicked] = useState<string[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offered = catalog.data ? availableSkills(catalog.data, mine) : null;
  const chosen = offered ? offered.filter((item) => picked.includes(item.id)) : [];
  const room = Math.max(0, TECH_PROFILE_LIMITS.skills - mine.length);
  const full = chosen.length >= room;
  const search = query.trim();
  const shown = offered ? searchCatalog(offered, search) : [];
  const usable = Boolean(offered?.length);
  /** O nível aparece com a lista para escolher ou ainda lendo (dá para escolher o nível enquanto ela chega). */
  const withLevel = usable || (!catalog.data && !catalog.error);
  const levelError = attempted && !level ? SKILL_MSG.level : null;
  const pickError = attempted && !chosen.length ? SKILL_MSG.pick : null;

  function toggle(item: TechCatalogItem) {
    haptic.select();
    setError(null);
    setPicked((ids) => (ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id]));
  }

  async function submit() {
    setAttempted(true);
    setError(null);
    if (!chosen.length || !level) {
      haptic.warning();
      return;
    }
    setBusy(true);
    const message = await onSubmit(chosen, level);
    setBusy(false);
    if (message) {
      haptic.warning();
      setError(message);
    }
  }

  let body: ReactNode;
  if (!catalog.data) {
    body = catalog.error ? (
      <CatalogFailure offline={catalog.error.offline} missing={catalog.error.missing} message={catalog.error.message} onRetry={onRetry} />
    ) : (
      <View style={styles.list}>
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} height={56} radius={12} />
        ))}
      </View>
    );
  } else if (!catalog.data.length) {
    body = <EmptyState icon="target" title="Lista vazia" description="A central ainda não cadastrou as aptidões." />;
  } else if (!offered?.length) {
    body = (
      <EmptyState
        icon="target"
        title="Você já tem todas as aptidões da lista"
        description="Peça a inclusão de outra à central pelo WhatsApp."
      />
    );
  } else {
    body = (
      <View style={styles.block}>
        <Input
          icon="search"
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar aptidão"
          accessibilityLabel="Buscar aptidão"
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          right={
            query ? (
              <Pressable onPress={() => setQuery("")} hitSlop={12} accessibilityRole="button" accessibilityLabel="Limpar a busca">
                <Text style={styles.clear}>Limpar</Text>
              </Pressable>
            ) : null
          }
        />
        {pickError ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {pickError}
          </Text>
        ) : chosen.length ? (
          <Text style={styles.count} accessibilityLiveRegion="polite">
            {chosenText(chosen.length)}
          </Text>
        ) : null}
        {full ? <InfoBox message={LIMIT_TEXT} /> : null}
        {shown.length ? (
          <View style={styles.list}>
            {shown.map((item) => {
              const checked = picked.includes(item.id);
              return (
                <CheckCard
                  key={item.id}
                  label={item.name}
                  checked={checked}
                  disabled={busy || (full && !checked)}
                  onPress={() => toggle(item)}
                />
              );
            })}
          </View>
        ) : (
          <Text style={styles.none}>{`Nenhuma aptidão com “${search}”. Peça a inclusão à central pelo WhatsApp.`}</Text>
        )}
      </View>
    );
  }

  return (
    <FormSheet
      visible={visible}
      title="Adicionar aptidão"
      submitLabel={chosen.length > 1 ? `Adicionar ${chosen.length}` : "Adicionar"}
      onSubmit={() => void submit()}
      onClose={onClose}
      onClosed={onClosed}
      busy={busy}
      error={error}
      dirty={picked.length > 0 || level !== null}
      submitDisabled={!usable}
    >
      {withLevel ? (
        <Field label="Nível" required error={levelError}>
          <ChoiceChips
            options={SKILL_LEVEL_OPTIONS}
            value={level}
            accessibilityLabel="Nível"
            disabled={busy}
            onChange={(next) => {
              if (Array.isArray(next)) return;
              haptic.select();
              setLevel(next);
              setError(null);
            }}
          />
        </Field>
      ) : null}
      {body}
    </FormSheet>
  );
}

/** A lista não veio: sem internet, servidor sem a rota (404, o de antes da gestão) ou erro. */
function CatalogFailure({ offline, missing, message, onRetry }: { offline: boolean; missing: boolean; message: string; onRetry: () => void }) {
  const action = { label: "Tentar de novo", onPress: onRetry };
  if (offline) {
    return <EmptyState icon="wifiOff" title="Sem internet" description="Conecte o aparelho para ver a lista de aptidões." action={action} />;
  }
  return (
    <EmptyState
      icon="alert"
      title="Não foi possível abrir a lista de aptidões"
      description={missing ? "O servidor ainda não tem a lista de aptidões. Tente de novo mais tarde." : message}
      action={action}
    />
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    block: { gap: 10 },
    list: { gap: 8 },
    clear: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    count: { fontSize: 13, color: c.inkMuted },
    error: { fontSize: 12, color: c.danger },
    none: { fontSize: 14, color: c.inkMuted, textAlign: "center", paddingVertical: 16 },
  });
