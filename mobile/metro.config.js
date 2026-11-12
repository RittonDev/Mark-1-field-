// https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Pré-visualização web: o expo-sqlite roda o SQLite em WebAssembly (wa-sqlite.wasm).
// No Android/iOS nada muda.
config.resolver.assetExts.push("wasm");

module.exports = config;
