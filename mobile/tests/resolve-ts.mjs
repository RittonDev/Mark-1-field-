// Gancho das sondas do app: registra a resolução de imports relativos sem extensão para ".ts" (o código do app importa
// "./masks", não "./masks.ts"). Na pasta mobile:
// node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import { register } from "node:module";

register("./resolve-ts-hooks.mjs", import.meta.url);
