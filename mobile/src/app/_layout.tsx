import { useFonts } from "expo-font";
import { SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
// As tarefas de segundo plano (rastreamento e sincronização) são definidas na entrada (index.ts), antes das
// rotas; o import aqui é só por garantia (o módulo roda uma vez e isTaskDefined evita definir duas vezes).
import "../lib/trackingTask";
import "../lib/backgroundSync";
import { SuccessHost } from "../components/SuccessHost";
import { ToastHost } from "../components/ToastHost";
import { mustChangePassword } from "../lib/account";
import { restoreSession, startSession } from "../lib/auth";
import { waitPrivacySeen } from "../lib/privacySeen";
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
  const userId = signedIn ? user?.id : undefined;
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

  // Abertura com técnico salvo: espera a versão vista do aviso de privacidade (lib/privacySeen.ts), no máximo
  // PRIVACY_SEEN_WAIT_MS, para Hoje já desenhar com o cartão "Aviso de privacidade atualizado" ou sem ele. Só na
  // abertura: depois, fica pronto de vez (o login espera a sua leitura em auth.login).
  const [privacyChecked, setPrivacyChecked] = useState(false);
  useEffect(() => {
    if (privacyChecked || status === "loading") return;
    let current = true;
    void (userId ? waitPrivacySeen(userId) : Promise.resolve()).then(() => {
      if (current) setPrivacyChecked(true);
    });
    return () => {
      current = false;
    };
  }, [privacyChecked, status, userId]);

  // A splash só sai quando a sessão foi lida, a fonte resolvida e a versão vista do aviso lida (ou o teto passou): nada
  // de texto sem estilo piscando nem o cartão de Hoje empurrando a tela depois.
  const ready = status !== "loading" && fontsSettled && privacyChecked;
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
            <Stack.Screen name="oferta/[id]" options={{ title: "Oferta" }} />
            <Stack.Screen name="conta" options={{ title: "Conta" }} />
            <Stack.Screen name="meu-cadastro" options={{ title: "Meu cadastro" }} />
            <Stack.Screen name="elo" options={{ title: "Meu elo" }} />
            <Stack.Screen name="nota-fiscal" options={{ title: "Enviar nota fiscal" }} />
            <Stack.Screen name="termo-rastreamento" options={{ title: "Uso da localização", presentation: "modal" }} />
            <Stack.Screen name="privacidade" options={{ title: "Aviso de privacidade" }} />
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
