import { useFonts } from "expo-font";
import { SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
// Registra a tarefa de segundo plano do rastreamento assim que o app carrega.
import "../lib/trackingTask";
import { SuccessHost } from "../components/SuccessHost";
import { ToastHost } from "../components/ToastHost";
import { mustChangePassword } from "../lib/account";
import { restoreSession, startSession } from "../lib/auth";
import { session, useSession } from "../lib/session";
import { stopSync } from "../lib/sync";
import { stopTracking } from "../lib/tracking";
import { BRAND_FONTS, brandFont } from "../theme/fonts";
import { loadThemePreference, useTheme } from "../theme/theme";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { status, user } = useSession();
  const c = useTheme();
  // Se a fonte não carregar, segue com a do sistema em vez de travar na abertura.
  const [fontsLoaded, fontError] = useFonts(BRAND_FONTS);
  const fontsSettled = fontsLoaded || Boolean(fontError);
  const signedIn = status === "signedIn";
  // Técnico importado nasce com senha provisória: troca antes de entrar no app.
  const mustChange = signedIn && mustChangePassword(user);

  useEffect(() => {
    Promise.all([loadThemePreference(), restoreSession()]).catch((error: unknown) => {
      console.warn("Falha ao ler a sessão", error);
      return session.signOut();
    });
  }, []);

  useEffect(() => {
    if (fontError) console.warn("Falha ao carregar a fonte Manrope", fontError);
  }, [fontError]);

  // A splash só sai quando a sessão foi lida e a fonte resolvida, para não piscar texto sem estilo.
  const ready = status !== "loading" && fontsSettled;
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  useEffect(() => {
    if (signedIn && !mustChange) {
      startSession().catch((error: unknown) => console.warn("Falha ao iniciar a sessão", error));
    } else if (status === "signedOut" || mustChange) {
      stopSync();
      // Sessão encerrada pelo servidor (senha redefinida, usuário desativado) ou logout: nada de coleta.
      if (status === "signedOut") void stopTracking({ endOnServer: false });
    }
  }, [status, signedIn, mustChange]);

  if (!ready) return null;
  // Títulos em negrito, como os da web.
  const titleFont = brandFont("700");

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: c.canvas }}>
        <StatusBar style={c.scheme === "dark" ? "light" : "dark"} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: c.surface },
            headerTintColor: c.ink,
            headerTitleStyle: titleFont ? { fontFamily: titleFont, color: c.ink } : { fontWeight: "700", color: c.ink },
            headerBackTitleStyle: titleFont ? { fontFamily: brandFont("500") } : undefined,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: c.canvas },
            headerBackTitle: "Voltar",
          }}
        >
          <Stack.Protected guard={signedIn && !mustChange}>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="ticket/[id]" options={{ title: "OS" }} />
            <Stack.Screen name="conta" options={{ title: "Conta" }} />
            <Stack.Screen name="termo-rastreamento" options={{ title: "Uso da localização", presentation: "modal" }} />
            <Stack.Screen name="formulario/[ticketId]/[formId]" options={{ title: "Formulário" }} />
            <Stack.Screen name="assinatura/[ticketId]" options={{ title: "Assinatura" }} />
          </Stack.Protected>
          {/* Senha provisória: é a única tela até trocar. Depois, o técnico troca quando quiser (Conta). */}
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="trocar-senha" options={{ headerShown: !mustChange, title: "Trocar senha" }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="login" options={{ headerShown: false }} />
          </Stack.Protected>
        </Stack>
        <ToastHost />
        <SuccessHost />
      </View>
    </SafeAreaProvider>
  );
}
