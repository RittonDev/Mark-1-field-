import { SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ToastHost } from "../components/ToastHost";
import { colors } from "../components/ui";
import { restoreSession, startSession } from "../lib/auth";
import { session, useSession } from "../lib/session";
import { stopSync } from "../lib/sync";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { status } = useSession();

  useEffect(() => {
    restoreSession()
      .catch((error: unknown) => {
        console.warn("Falha ao ler a sessão", error);
        return session.signOut();
      })
      .finally(() => void SplashScreen.hideAsync());
  }, []);

  useEffect(() => {
    if (status === "signedIn") {
      startSession().catch((error: unknown) => console.warn("Falha ao iniciar a sessão", error));
    } else if (status === "signedOut") {
      stopSync();
    }
  }, [status]);

  if (status === "loading") return null;
  const signedIn = status === "signedIn";

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.ink,
            headerTitleStyle: { fontWeight: "700" },
            contentStyle: { backgroundColor: colors.canvas },
            headerBackTitle: "Voltar",
          }}
        >
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="index" options={{ title: "Minhas OS" }} />
            <Stack.Screen name="ticket/[id]" options={{ title: "OS" }} />
            <Stack.Screen name="conta" options={{ title: "Conta e sincronização" }} />
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
