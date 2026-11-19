// Contas do gráfico de colunas das Estatísticas (components/MonthBars.tsx): o eixo, as barras, as faixas dos meses do
// sistema antigo, os rótulos dos meses e as frases da leitura. Puro e sem import: as sondas em Node importam direto
// (mobile/tests/month-bars.test.mjs). O nome do mês ("outubro de 2026") vem pronto de quem chama.

/** Como contar o que o gráfico mostra: "1 retorno", "3 retornos", "Nenhum retorno". */
export interface Noun {
  one: string;
  many: string;
  none: string;
}

export interface BarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A leitura do gráfico: a parte forte (o número, em negrito) e o resto da frase. */
export interface Readout {
  strong: string;
  rest: string;
}

/** Valor acima de zero nunca some: a barra tem pelo menos esta altura. */
export const MIN_BAR_HEIGHT = 3;
/** Raio dos cantos de cima da barra (a base é reta). */
export const BAR_RADIUS = 4;

const numbers = new Intl.NumberFormat("pt-BR");

/** "1.284": o número com o ponto de milhar (Perfil, Estatísticas e Histórico). */
export function formatCount(n: number): string {
  return numbers.format(n);
}

/**
 * As três marcas do eixo Y: 0, o passo e o dobro dele, com o dobro cobrindo o maior valor. Passos 1, 2, 5, 10, 20, 25,
 * 50, 100, 200, 250, 500, 1000… (18 → 0/10/20; 3 → 0/2/4; 0 → 0/1/2).
 */
export function axisTicks(max: number): [number, number, number] {
  const top = Number.isFinite(max) && max > 0 ? max : 0;
  for (let scale = 1; scale < Number.MAX_SAFE_INTEGER; scale *= 10) {
    for (const mult of scale === 1 ? [1, 2, 5] : [1, 2, 2.5, 5]) {
      const step = mult * scale;
      if (step * 2 >= top) return [0, step, step * 2];
    }
  }
  return [0, top / 2, top];
}

/** A largura da barra na faixa do mês: 55% dela, entre 6 e 16. */
export function barWidth(slot: number): number {
  return Math.min(16, Math.max(6, Math.round(slot * 0.55)));
}

/**
 * Uma barra por mês, centrada na faixa dele e apoiada na base (plotTop + plotHeight); null sem barra (zero ou sem
 * medição). `max` é o topo do eixo. Valor acima de zero tem pelo menos MIN_BAR_HEIGHT de altura.
 */
export function barRects(
  values: (number | null)[],
  plotLeft: number,
  plotWidth: number,
  plotTop: number,
  plotHeight: number,
  max: number,
): (BarRect | null)[] {
  const slot = values.length ? plotWidth / values.length : 0;
  const width = Math.min(barWidth(slot), slot);
  const base = plotTop + plotHeight;
  const top = max > 0 ? max : 1;
  return values.map((value, index) => {
    if (value === null || !(value > 0)) return null;
    const height = Math.min(plotHeight, Math.max(MIN_BAR_HEIGHT, (value / top) * plotHeight));
    return { x: plotLeft + index * slot + (slot - width) / 2, y: base - height, width, height };
  });
}

/** Até duas casas: o caminho não carrega 12.000000000001. */
const coord = (value: number) => String(Math.round(value * 100) / 100);

/** O desenho da barra: começa e termina na base (reta), com os dois cantos de cima arredondados (raio até 4). */
export function barPath({ x, y, width, height }: BarRect): string {
  const r = Math.max(0, Math.min(BAR_RADIUS, width / 2, height));
  const base = y + height;
  const right = x + width;
  return [
    `M ${coord(x)} ${coord(base)}`,
    `V ${coord(y + r)}`,
    `A ${coord(r)} ${coord(r)} 0 0 1 ${coord(x + r)} ${coord(y)}`,
    `H ${coord(right - r)}`,
    `A ${coord(r)} ${coord(r)} 0 0 1 ${coord(right)} ${coord(y + r)}`,
    `V ${coord(base)}`,
    "Z",
  ].join(" ");
}

/** Sequências de meses marcados, como [início, fim] (índices inclusivos): as faixas dos meses do sistema antigo. */
export function legacyRuns(flags: boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  flags.forEach((flag, index) => {
    if (!flag) return;
    const last = runs[runs.length - 1];
    if (last && last[1] === index - 1) last[1] = index;
    else runs.push([index, index]);
  });
  return runs;
}

/**
 * Quais rótulos de mês aparecem: todos quando cabem na faixa (com 2 de folga); senão um sim e um não (ou mais espaçados,
 * com a fonte bem grande), contando do mês atual, o último.
 */
export function axisLabelsShown(count: number, slot: number, labelWidth: number): boolean[] {
  const every = slot > 0 ? Math.max(1, Math.ceil((labelWidth + 2) / slot)) : 1;
  return Array.from({ length: count }, (_, index) => (count - 1 - index) % every === 0);
}

/** "1 retorno", "1.284 atendimentos", "Nenhum retorno". */
export function countText(n: number, noun: Noun): string {
  if (n === 0) return noun.none;
  return `${formatCount(n)} ${n === 1 ? noun.one : noun.many}`;
}

/** A contagem em duas partes: o número em negrito; sem nada, "Nenhum retorno" inteiro. */
function countReadout(n: number, noun: Noun): Readout {
  if (n === 0) return { strong: noun.none, rest: "" };
  return { strong: formatCount(n), rest: ` ${n === 1 ? noun.one : noun.many}` };
}

const monthsText = (count: number) => (count === 1 ? "1 mês" : `${count} meses`);

/**
 * Sem mês escolhido: a soma dos meses medidos ("143 atendimentos em 12 meses", "Nenhum retorno em 12 meses"); sem
 * nenhum mês medido, "Sem medição nos 12 meses (sistema antigo)".
 */
export function totalReadout(values: (number | null)[], noun: Noun): Readout {
  const measured = values.filter((value): value is number => value !== null);
  const span = monthsText(values.length);
  if (!measured.length) return { strong: "Sem medição", rest: ` nos ${span} (sistema antigo)` };
  const total = countReadout(measured.reduce((sum, value) => sum + value, 0), noun);
  return { strong: total.strong, rest: `${total.rest} em ${span}` };
}

/**
 * Com um mês escolhido: "18 atendimentos · outubro de 2026", "4 atendimentos · novembro de 2026, até hoje", "Nenhum
 * retorno · outubro de 2026" ou, sem medição, "Sem medição · outubro de 2026 (sistema antigo)".
 */
export function monthReadout(value: number | null, noun: Noun, monthName: string, current: boolean): Readout {
  const when = `${monthName}${current ? ", até hoje" : ""}`;
  if (value === null) return { strong: "Sem medição", rest: ` · ${when} (sistema antigo)` };
  const count = countReadout(value, noun);
  return { strong: count.strong, rest: `${count.rest} · ${when}` };
}

/**
 * O próximo mês escolhido pelo leitor de tela (deslizar para cima: o seguinte; para baixo: o anterior), sem passar das
 * pontas. Sem escolha, os dois sentidos começam no mês atual (o último).
 */
export function stepSelection(selected: number | null, count: number, direction: 1 | -1): number {
  if (count <= 0) return 0;
  if (selected === null) return count - 1;
  return Math.min(count - 1, Math.max(0, selected + direction));
}
