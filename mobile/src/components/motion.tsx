// Movimento do app: entrada das listas, transições de layout e o "aperto" dos toques.
// Tudo respeita o "Reduzir movimento" do sistema (useReducedMotion).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";

/** Mola com amortecimento crítico (√(4·k·m) ≈ 27,7): chega ao alvo sem passar e voltar. */
export const SPRING = { damping: 28, stiffness: 320, mass: 0.6 } as const;
const STAGGER_MS = 30;
/** Depois de alguns itens a entrada não espera mais: a cascata inteira fica em ~320 ms. */
const MAX_STAGGER = 4;

/** Deslocamento das entradas: curto (8 pt), só para dar direção. */
export const ENTER_OFFSET = 8;

/**
 * Entrada em cascata curta (sobe 8 pt e aparece, 30 ms por item, 200 ms) e transição de layout para
 * listas. O objeto é estável enquanto a preferência de movimento não muda (pode entrar em useCallback).
 */
export function useListMotion() {
  const reduced = useReducedMotion();
  return useMemo(
    () => ({
      reduced,
      entering: (index: number) =>
        reduced
          ? undefined
          : FadeInDown.delay(Math.min(index, MAX_STAGGER) * STAGGER_MS)
              .duration(200)
              .withInitialValues({ opacity: 0, transform: [{ translateY: ENTER_OFFSET }] }),
      layout: reduced ? undefined : LinearTransition.duration(220),
    }),
    [reduced],
  );
}

/** Troca suave de conteúdo (ex.: o selo de status quando a OS muda). */
export function useSwapMotion() {
  const reduced = useReducedMotion();
  return reduced ? { entering: undefined, exiting: undefined } : { entering: FadeIn.duration(200), exiting: FadeOut.duration(120) };
}

/**
 * Ponto "ao vivo" (jornada ativa, etapa em curso): ao ativar, o anel se expande e some três vezes e o
 * ponto fica parado. Nada pulsa o dia inteiro (distrai e gasta bateria de quem já está com o GPS ligado).
 */
export function Pulse({ color, size = 10, active = true }: { color: string; size?: number; active?: boolean }) {
  const reduced = useReducedMotion();
  const wave = useSharedValue(0);
  useEffect(() => {
    if (!active || reduced) return;
    wave.set(0);
    wave.set(withRepeat(withTiming(1, { duration: 1600, easing: Easing.out(Easing.quad) }), 3, false));
    return () => cancelAnimation(wave);
  }, [active, reduced, wave]);
  const ring = useAnimatedStyle(() => ({
    opacity: 0.45 * (1 - wave.get()),
    transform: [{ scale: 1 + wave.get() * 1.6 }],
  }));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {active && !reduced ? (
        <Animated.View
          style={[{ position: "absolute", width: size, height: size, borderRadius: size / 2, backgroundColor: color }, ring]}
        />
      ) : null}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type ScaleProps = Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  scaleTo?: number;
  children?: ReactNode;
};

/** Pressable com retorno de toque: encolhe para 0,97 com mola e volta ao soltar. */
export function PressableScale({ style, pressedStyle, scaleTo = 0.97, onPressIn, onPressOut, children, ...rest }: ScaleProps) {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const [pressed, setPressed] = useState(false);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(event) => {
        setPressed(true);
        if (!reduced) scale.set(withSpring(scaleTo, SPRING));
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        scale.set(withSpring(1, SPRING));
        onPressOut?.(event);
      }}
      style={[style, pressed ? pressedStyle : null, animated]}
    >
      {children}
    </AnimatedPressable>
  );
}
