import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "../lib/haptics";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";
import { usePill } from "./ui";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon: IconName;
  count?: number;
}

/**
 * Barra de abas inferior com a pílula da aba ativa deslizando. Tocar de novo na aba ativa chama
 * `onReselect` (ex.: voltar ao dia de hoje e ao topo da lista).
 */
export function TabBar<T extends string>({
  items,
  value,
  onChange,
  onReselect,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  onReselect?: (value: T) => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { pillStyle, measure, ready } = usePill(value);
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]} accessibilityRole="tablist">
      <View style={styles.row}>
        <Animated.View style={[styles.pill, pillStyle, !ready && { opacity: 0 }]} />
        {items.map((item) => {
          const active = item.value === value;
          const color = active ? c.brandInk : c.inkMuted;
          return (
            <Pressable
              key={item.value}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={item.count ? `${item.label}, ${item.count} OS` : item.label}
              onLayout={(e) => measure(item.value)(e.nativeEvent.layout)}
              onPress={() => {
                if (active) {
                  onReselect?.(item.value);
                  return;
                }
                haptic.select();
                onChange(item.value);
              }}
              style={styles.tab}
            >
              <View>
                <Icon name={item.icon} size={22} color={color} strokeWidth={active ? 2 : 1.8} />
                {item.count ? (
                  <View
                    style={[styles.count, active ? { backgroundColor: c.primaryFill } : { backgroundColor: c.inkMuted }]}
                  >
                    <Text style={[styles.countText, { color: active ? c.onPrimary : c.surface }]} maxFontSizeMultiplier={1.2}>
                      {item.count > 99 ? "99+" : item.count}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.label, { color }, active && styles.labelActive]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    bar: {
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
      paddingTop: 8,
      paddingHorizontal: 12,
    },
    row: { flexDirection: "row" },
    pill: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      borderRadius: RADIUS.control + 2,
      backgroundColor: c.primarySoft,
    },
    tab: { flex: 1, alignItems: "center", gap: 4, paddingVertical: 8, paddingHorizontal: 2, minHeight: 52 },
    label: { fontSize: 12, fontWeight: "600" },
    labelActive: { fontWeight: "700" },
    count: {
      position: "absolute",
      top: -6,
      right: -12,
      minWidth: 18,
      minHeight: 18,
      borderRadius: 9,
      paddingHorizontal: 4,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: c.surface,
    },
    countText: { fontSize: 10, fontWeight: "700", fontVariant: ["tabular-nums"] },
  });
