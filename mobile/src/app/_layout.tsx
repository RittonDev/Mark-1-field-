import { SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
// Registra a tarefa de segundo plano do rastreamento assim que o app carrega.
import "../lib/trackingTask";
import { ToastHost } from "../components/ToastHost";
import { mustChangePassword } from "../lib/account";
import { restoreSession, startSession } from "../lib/auth";
import { session, useSession } from "../lib/session";
import { stopSync } from "../lib/sync";
import { loadThemePreference, useTheme } from "../theme/theme";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { status, user } = useSession();
  const c = useTheme();
  const signedIn = status === "signedIn";
  // Técnico importado nasce com senha provisória: troca antes de entrar no app.
  const mustChange = signedIn && mustChangePassword(user);

  useEffect(() => {
    Promise.all([loadThemePreference(), restoreSession()])
      .catch((error: unknown) => {
        console.warn("Falha ao ler a sessão", error);
        return session.signOut();
      })
      .finally(() => void SplashScreen.hideAsync());
  }, []);

  useEffect(() => {
    if (signedIn && !mustChange) {
      startSession().catch((error: unknown) => console.warn("Falha ao iniciar a sessão", error));
    } else if (status === "signedOut" || mustChange) {
      stopSync();
    }
  }, [status, signedIn, mustChange]);

  if (status === "loading") return null;

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: c.canvas }}>
        <StatusBar style={c.scheme === "dark" ? "light" : "dark"} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: c.surface },
            headerTintColor: c.ink,
            headerTitleStyle: { fontWeight: "600", color: c.ink },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: c.canvas },
            headerBackTitle: "Voltar",
          }}
        >
          <Stack.Protected guard={signedIn && !mustChange}>
            <Stack.Screen name="index" options={{ title: "" }} />
            <Stack.Screen name="ticket/[id]" options={{ title: "OS" }} />
            <Stack.Screen name="conta" options={{ title: "Conta" }} />
            <Stack.Screen name="termo-rastreamento" options={{ title: "Termo de rastreamento", presentation: "modal" }} />
          </Stack.Protected>
          <Stack.Protected guard={mustChange}>
            <Stack.Screen name="trocar-senha" options={{ headerShown: false }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="login" options={{ headerShown: false }} />
          </Stack.Protected>
        </Stack>
        <ToastHost />
      </View>
    </SafeAreaProvider>
  );
}
