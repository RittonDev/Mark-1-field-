// Resolução das sondas (registrada por resolve-ts.mjs): "./masks" vira "./masks.ts" quando o arquivo existe; o resto
// (pacotes, node:, caminhos com extensão) segue a resolução normal do Node.
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // cai na resolução normal
    }
  }
  return next(specifier, context);
}
