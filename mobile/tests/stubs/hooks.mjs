// Resolução da sonda da sessão (registrada por tests/session-last-email.test.mjs, só no processo dela): os módulos do
// app que puxam o Expo, o React Native ou o React viram os stubs desta pasta. Só vale para quem importa de dentro de
// src/lib; o resto segue para a resolução de antes (tests/resolve-ts-hooks.mjs).
const STUBS = {
  "./secureStorage": "secureStorage.mjs",
  "./config": "config.mjs",
  "./api": "api.mjs",
  "./photoFiles": "photoFiles.mjs",
  react: "react.mjs",
  "expo-image-manipulator": "expo-image-manipulator.mjs",
};

export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub && context.parentURL?.includes("/src/lib/")) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
