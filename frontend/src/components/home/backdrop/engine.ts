/**
 * Motor do fundo animado da Início ("galáxia neural"): estrelas em dois braços espirais girando devagar em
 * volta de um núcleo no alto à direita, uma rede de nós ligados ao longo dos braços e, de vez
 * em quando, uma "sinapse" que percorre a rede rumo ao núcleo. É decoração pura: não codifica dado nenhum.
 *
 * TypeScript puro, sem React. Canvas 2D com sprites pré-desenhados (refeitos só na troca de tema), até
 * 30 quadros por segundo, nada alocado por quadro (só arrays tipados criados na montagem), sem shadowBlur
 * nem filter, e as cores do tema lidas só na montagem e na troca de tema. Quem decide quando anima
 * (preferência, "reduzir movimento", aba oculta, painel aberto, ociosidade) é o HomeBackdrop.
 */

export type Rgb = readonly [number, number, number];

/** Cores da marca no tema atual; só tokens em hex (o que não for hex cai na cor padrão da marca). */
export interface BackdropPalette {
  dark: boolean;
  brand: Rgb;
  cyan: Rgb;
  mint: Rgb;
}

export interface BackdropOptions {
  /** Semente do PRNG: o mesmo céu a cada visita. */
  seed: number;
  /** 1 = cheia; 0,5 = tela estreita ou economia de dados. */
  density: number;
}

export interface BackdropEngine {
  /** Tamanho em px CSS e densidade da tela: só refaz o bitmap quando muda, e redesenha na mesma hora. */
  resize(width: number, height: number, dpr: number): void;
  /** Troca de tema: refaz os sprites e, parado, redesenha o estado atual. */
  setPalette(palette: BackdropPalette): void;
  setDensity(density: number): void;
  start(): void;
  /** Para no último quadro desenhado. */
  stop(): void;
  /** Desenha o estado atual sem avançar o tempo. */
  render(): void;
  /** Dados relidos: adianta a sinapse (no máximo uma a cada 10 s). */
  pulse(): void;
  destroy(): void;
  readonly running: boolean;
  /** Desempenho ruim: ficou estático até recarregar a página. */
  readonly degraded: boolean;
}

/** Ajuste fino do brilho de tudo (0,6 a 1,2, a pedido), sempre dentro dos tetos de contraste. */
const INTENSITY = 1;

const TAU = Math.PI * 2;
/** Volta dos braços do núcleo até a borda (rad). */
const TWIST = 3.4;
/** Achatamento do disco inclinado. */
const TILT = 0.62;
/** Velocidade linear na borda (px/s): v(ρ) = 7·√ρ, cerca de 2 px/s perto do núcleo. */
const SPEED = 7;
/** Núcleo em fração da largura e da altura (o brilho estático .mf-galaxy-glow e a máscara usam o mesmo ponto). */
const CORE_X = 0.8;
const CORE_Y = 0.2;

const MIN_STARS = 260;
const MAX_STARS = 720;
const MIN_NODES = 36;
const MAX_NODES = 96;
/** Pares de nós (i < j) cabem aqui; o índice do par é i * MAX_NODES + j. */
const PAIRS = (MAX_NODES * MAX_NODES) / 2;
/** Cada nó liga com até 3 vizinhos mais próximos. */
const NEIGHBORS = 3;

/** Raio das estrelas por tamanho (60%, 30% e 10% delas), dos nós e do ponto da sinapse, em px. */
const STAR_RADII = [0.7, 1.1, 1.7] as const;
const NODE_RADIUS = 1.4;
const DOT_RADIUS = 1.8;
/** Halo do escuro: 3× o raio, de 35% a 0. */
const HALO_SCALE = 3;
const HALO_ALPHA = 0.35;
/** Sprites desenhados em 2× (acima do dpr máximo de 1,5): nítidos sem refazer quando o dpr muda. */
const SPRITE_SCALE = 2;
const LINE_WIDTH = 0.75;
/** Alpha de cada balde de ligações, em fração do alpha máximo. */
const LINK_LEVELS = [0.25, 0.5, 0.75, 1] as const;

/** Até 30 quadros por segundo; passo máximo de 50 ms (sem salto ao voltar). */
const FRAME_MS = 33;
const MAX_STEP_MS = 50;
/** Nenhum brilho muda mais rápido que isto: ligações que entram ou saem, envelope da sinapse. */
const FADE_S = 0.8;
const HOP_S = 1.6;
/** O nó de chegada da sinapse volta ao normal neste tempo. */
const ARRIVAL_S = 1.2;
/** Intervalo mínimo entre sinapses adiantadas pelos dados. */
const PULSE_GAP_S = 10;
/** Custo médio do quadro (ms) que corta a densidade pela metade e, depois, que deixa o fundo estático. */
const SLOW_MS = 6;
const TOO_SLOW_MS = 10;
const COST_WINDOW = 60;

const BRAND = 0;
const CYAN = 1;
const MINT = 2;

type Mix = readonly [number, number, number];

interface ThemeStyle {
  /** "source-over" no claro; "lighter" (brilho aditivo) no escuro. */
  composite: GlobalCompositeOperation;
  /** Alpha das estrelas por tamanho. */
  star: Mix;
  /** Partilha de azul, ciano e menta. */
  starMix: Mix;
  node: number;
  nodeMix: Mix;
  /** Halo na estrela grande e nos nós. */
  halo: boolean;
  /** Alpha máximo das ligações (--brand). */
  link: number;
  /** Ponto da sinapse e a cor dele. */
  dot: number;
  dotColor: typeof CYAN | typeof MINT;
  /** Ligação do salto atual da sinapse (--brand-cyan), cerca de 2,5× a ligação comum. */
  synapse: number;
}

// Claro: só azul e ciano (menta some na folha clara), pontos um pouco mais escuros que a folha.
const LIGHT: ThemeStyle = {
  composite: "source-over",
  star: [0.09, 0.14, 0.2],
  starMix: [0.85, 0.15, 0],
  node: 0.2,
  nodeMix: [0.75, 0.25, 0],
  halo: false,
  link: 0.12,
  dot: 0.34,
  dotColor: CYAN,
  synapse: 0.22,
};

// Escuro: brilho aditivo, azul predominante, um pouco de ciano e um toque de menta. Halo dos nós: 0,24 × 35%.
const DARK: ThemeStyle = {
  composite: "lighter",
  star: [0.14, 0.22, 0.32],
  starMix: [0.7, 0.2, 0.1],
  node: 0.3,
  nodeMix: [0.8, 0.15, 0.05],
  halo: true,
  link: 0.17,
  dot: 0.55,
  dotColor: MINT,
  synapse: 0.36,
};

const FALLBACK_BRAND: Rgb = [0x24, 0x47, 0xff];
const FALLBACK_CYAN: Rgb = [0x00, 0xb7, 0xdf];
const FALLBACK_MINT: Rgb = [0x76, 0xf6, 0xc6];

/** "#2447ff" ou "#24f" → [r, g, b]; qualquer outra coisa (color-mix, rgb com /) → `fallback`. */
function hexToRgb(value: string, fallback: Rgb): Rgb {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return fallback;
  let hex = match[1];
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Cores da marca do tema atual (html[data-theme], nunca prefers-color-scheme). Uma vez por troca de tema. */
export function readPalette(): BackdropPalette {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return {
    dark: root.dataset.theme === "dark",
    brand: hexToRgb(style.getPropertyValue("--brand"), FALLBACK_BRAND),
    cyan: hexToRgb(style.getPropertyValue("--brand-cyan"), FALLBACK_CYAN),
    mint: hexToRgb(style.getPropertyValue("--brand-mint"), FALLBACK_MINT),
  };
}

/** PRNG mulberry32: sequência fixa para a mesma semente (nada de Math.random). */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal padrão (Box-Muller), cortada em ±3. */
function gauss(rand: () => number): number {
  const u = 1 - rand();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rand());
  return Math.max(-3, Math.min(3, g));
}

/** Ângulo dentro de um dos dois braços (offset π), com espalhamento que afina para a borda. */
function armAngle(rand: () => number, rho: number, spread: number): number {
  const arm = rand() < 0.5 ? 0 : Math.PI;
  const sigma = 0.32 * (1 - 0.5 * rho) * spread;
  const angle = (arm + TWIST * rho + sigma * gauss(rand)) % TAU;
  return angle < 0 ? angle + TAU : angle;
}

/** Índice da cor (azul, ciano, menta) para um sorteio uniforme `u`. */
function pickColor(mix: Mix, u: number): number {
  if (u < mix[0]) return BRAND;
  return u < mix[0] + mix[1] || mix[2] === 0 ? CYAN : MINT;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 3t² − 2t³: sai e chega devagar, sem quique. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

interface Sprite {
  image: HTMLCanvasElement;
  /** Lado em px CSS e a metade dele (para centrar no ponto). */
  size: number;
  half: number;
}

/** Círculo cheio (e, no escuro, halo radial de 3× o raio, de 35% a 0) num canvas fora da tela. */
function makeSprite(rgb: Rgb, radius: number, halo: boolean): Sprite {
  const outer = halo ? radius * HALO_SCALE : radius;
  // 1 px de folga para a borda suavizada não ser cortada.
  const px = Math.ceil((outer + 1) * 2 * SPRITE_SCALE);
  const image = document.createElement("canvas");
  image.width = px;
  image.height = px;
  const ctx = image.getContext("2d");
  if (ctx) {
    const center = px / 2;
    const [r, g, b] = rgb;
    if (halo) {
      const glow = ctx.createRadialGradient(center, center, radius * SPRITE_SCALE, center, center, outer * SPRITE_SCALE);
      glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${HALO_ALPHA})`);
      glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(center, center, outer * SPRITE_SCALE, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.beginPath();
    ctx.arc(center, center, radius * SPRITE_SCALE, 0, TAU);
    ctx.fill();
  }
  const size = px / SPRITE_SCALE;
  return { image, size, half: size / 2 };
}

function releaseSprite(sprite: Sprite | null) {
  if (!sprite) return;
  sprite.image.width = 0;
  sprite.image.height = 0;
}

function inertEngine(): BackdropEngine {
  const noop = () => {};
  return {
    resize: noop,
    setPalette: noop,
    setDensity: noop,
    start: noop,
    stop: noop,
    render: noop,
    pulse: noop,
    destroy: noop,
    running: false,
    degraded: true,
  };
}

export function createBackdropEngine(canvas: HTMLCanvasElement, options: BackdropOptions): BackdropEngine {
  const context = canvas.getContext("2d");
  if (!context) return inertEngine();
  const ctx = context;
  const rand = mulberry32(options.seed);

  // Estrelas: posição normalizada (ρ, θ), então o resize não sorteia de novo.
  const starRho = new Float32Array(MAX_STARS);
  const starTheta = new Float64Array(MAX_STARS);
  const starOmega = new Float32Array(MAX_STARS);
  const starRadius = new Float32Array(MAX_STARS);
  const starSize = new Uint8Array(MAX_STARS);
  const starTone = new Float32Array(MAX_STARS);
  const starGroup = new Uint8Array(MAX_STARS);
  const starX = new Float32Array(MAX_STARS);
  const starY = new Float32Array(MAX_STARS);
  // Estrelas ordenadas por grupo (tamanho × cor): um globalAlpha por grupo, cerca de 9 trocas por quadro.
  const order = new Uint16Array(MAX_STARS);
  const groupStart = new Uint16Array(10);
  const groupFill = new Uint16Array(9);

  const nodeRho = new Float32Array(MAX_NODES);
  const nodeTheta = new Float64Array(MAX_NODES);
  const nodeOmega = new Float32Array(MAX_NODES);
  const nodeRadius = new Float32Array(MAX_NODES);
  const nodeAmp = new Float32Array(MAX_NODES);
  const nodeFreq = new Float32Array(MAX_NODES);
  const nodePhaseX = new Float32Array(MAX_NODES);
  const nodePhaseY = new Float32Array(MAX_NODES);
  const nodeTone = new Float32Array(MAX_NODES);
  const nodeColor = new Uint8Array(MAX_NODES);
  const nodeX = new Float32Array(MAX_NODES);
  const nodeY = new Float32Array(MAX_NODES);
  /** Brilho extra do nó de chegada da sinapse (0 a 1 = até 2× mais claro). */
  const boost = new Float32Array(MAX_NODES);

  // Ligações: vizinhos mais próximos, força suavizada de cada par e os 4 baldes de alpha do quadro.
  const knnIndex = new Int16Array(MAX_NODES * NEIGHBORS);
  const knnDist = new Float32Array(MAX_NODES * NEIGHBORS);
  const pairDist = new Float32Array(MAX_NODES * MAX_NODES);
  const strength = new Float32Array(MAX_NODES * MAX_NODES);
  const bucketPairs = new Uint16Array(LINK_LEVELS.length * PAIRS);
  const bucketCount = new Uint16Array(LINK_LEVELS.length);

  // Sinapse: caminho (início + até 4 saltos) e candidatos a ponto de partida.
  const path = new Int16Array(5);
  const candidates = new Int16Array(MAX_NODES);

  // Gerado uma vez por montagem, sempre na mesma ordem: todas as estrelas e depois todos os nós.
  for (let i = 0; i < MAX_STARS; i++) {
    // Bem mais densas perto do núcleo (u^1,7: a densidade cai com o raio, como num disco de galáxia);
    // 15% fora dos braços, com θ uniforme.
    const rho = 0.03 + 0.97 * Math.pow(rand(), 1.7);
    starRho[i] = rho;
    starTheta[i] = rand() < 0.15 ? rand() * TAU : armAngle(rand, rho, 1);
    const size = rand();
    starSize[i] = size < 0.6 ? 0 : size < 0.9 ? 1 : 2;
    starTone[i] = rand();
  }
  for (let i = 0; i < MAX_NODES; i++) {
    const rho = 0.1 + 0.7 * rand();
    nodeRho[i] = rho;
    nodeTheta[i] = armAngle(rand, rho, 0.5);
    // Oscilação própria: 4 a 10 px, 0,05 a 0,12 rad/s.
    nodeAmp[i] = 4 + 6 * rand();
    nodeFreq[i] = 0.05 + 0.07 * rand();
    nodePhaseX[i] = rand() * TAU;
    nodePhaseY[i] = rand() * TAU;
    nodeTone[i] = rand();
  }

  let style = LIGHT;
  const starSprites: (Sprite | null)[] = Array.from({ length: 9 }, () => null);
  const nodeSprites: (Sprite | null)[] = [null, null, null];
  let dotSprite: Sprite | null = null;
  let linkStroke = "";
  let synapseStroke = "";
  let hasPalette = false;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let sizeKey = "";
  let sized = false;
  let coreX = 0;
  let coreY = 0;
  let linkLength = 90;

  let density = options.density;
  let halved = false;
  let degraded = false;
  let activeStars = 0;
  let activeNodes = 0;

  /** Tempo simulado (s): só anda com o laço rodando, então parar e voltar não pula nada. */
  let time = 0;
  let raf = 0;
  let last = -1;
  let frameCost = -1;
  let measured = 0;
  let shown = false;
  let destroyed = false;

  let synActive = false;
  let synHops = 0;
  let synStart = 0;
  let synLastStart = -Infinity;
  let synNext = 6 + 4 * rand();
  let synHop = 0;
  let synT = 0;
  let synEnv = 0;

  function releaseSprites() {
    for (let i = 0; i < starSprites.length; i++) {
      releaseSprite(starSprites[i]);
      starSprites[i] = null;
    }
    for (let i = 0; i < nodeSprites.length; i++) {
      releaseSprite(nodeSprites[i]);
      nodeSprites[i] = null;
    }
    releaseSprite(dotSprite);
    dotSprite = null;
  }

  /** Cor de cada estrela e nó no tema atual, e as estrelas reordenadas por grupo (contagem estável). */
  function assignColors() {
    groupStart.fill(0);
    for (let i = 0; i < MAX_STARS; i++) {
      const group = starSize[i] * 3 + pickColor(style.starMix, starTone[i]);
      starGroup[i] = group;
      groupStart[group + 1]++;
    }
    for (let g = 0; g < 9; g++) {
      groupStart[g + 1] += groupStart[g];
      groupFill[g] = groupStart[g];
    }
    for (let i = 0; i < MAX_STARS; i++) order[groupFill[starGroup[i]]++] = i;
    for (let i = 0; i < MAX_NODES; i++) nodeColor[i] = pickColor(style.nodeMix, nodeTone[i]);
  }

  function setPalette(palette: BackdropPalette) {
    if (destroyed) return;
    releaseSprites();
    style = palette.dark ? DARK : LIGHT;
    const colors = [palette.brand, palette.cyan, palette.mint];
    for (let size = 0; size < 3; size++) {
      for (let color = 0; color < 3; color++) {
        starSprites[size * 3 + color] =
          style.starMix[color] > 0 ? makeSprite(colors[color], STAR_RADII[size], style.halo && size === 2) : null;
      }
    }
    for (let color = 0; color < 3; color++) {
      nodeSprites[color] = style.nodeMix[color] > 0 ? makeSprite(colors[color], NODE_RADIUS, style.halo) : null;
    }
    dotSprite = makeSprite(colors[style.dotColor], DOT_RADIUS, false);
    linkStroke = `rgb(${palette.brand.join(", ")})`;
    synapseStroke = `rgb(${palette.cyan.join(", ")})`;
    assignColors();
    hasPalette = true;
    if (!raf) render();
  }

  /** Quantas estrelas e nós aparecem: pela área, pela densidade e pelo corte de desempenho. */
  function recount() {
    const area = width * height;
    const share = density * (halved ? 0.5 : 1);
    activeStars = Math.max(1, Math.round(clamp(Math.round(area / 2400), MIN_STARS, MAX_STARS) * share));
    const nodes = Math.max(2, Math.round(clamp(Math.round(area / 15000), MIN_NODES, MAX_NODES) * share));
    if (nodes === activeNodes) return;
    activeNodes = nodes;
    // Pares com um nó que saiu ficam zerados: se ele voltar, a ligação entra aos poucos.
    for (let i = 0; i < MAX_NODES; i++) {
      for (let j = Math.max(i + 1, nodes); j < MAX_NODES; j++) strength[i * MAX_NODES + j] = 0;
    }
    if (synActive && pathUses(nodes)) endSynapse();
  }

  function resize(w: number, h: number, ratio: number) {
    if (destroyed) return;
    const nextWidth = Math.round(w);
    const nextHeight = Math.round(h);
    const nextDpr = Math.min(ratio > 0 ? ratio : 1, 1.5);
    const key = `${nextWidth}x${nextHeight}@${nextDpr}`;
    if (key === sizeKey) return;
    sizeKey = key;
    if (nextWidth < 1 || nextHeight < 1) {
      // Camada escondida (cores forçadas, alto contraste): nada para desenhar.
      sized = false;
      stop();
      return;
    }
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    // Núcleo dentro do quadro, no alto à direita (atrás do espaço livre ao lado do herói), e braços que
    // chegam até a borda esquerda: a galáxia aparece inteira, não só a ponta de um braço.
    coreX = CORE_X * width;
    coreY = CORE_Y * height;
    const radius = 0.62 * Math.hypot(width, height);
    linkLength = clamp(0.11 * Math.min(width, height) + 40, 90, 140);
    // Rotação diferencial: ω = v / (ρ·R), com v = 7·√ρ px/s.
    for (let i = 0; i < MAX_STARS; i++) {
      starRadius[i] = starRho[i] * radius;
      starOmega[i] = SPEED / (Math.sqrt(starRho[i]) * radius);
    }
    for (let i = 0; i < MAX_NODES; i++) {
      nodeRadius[i] = nodeRho[i] * radius;
      nodeOmega[i] = SPEED / (Math.sqrt(nodeRho[i]) * radius);
    }
    sized = true;
    recount();
    // Redesenha no mesmo callback: trocar o tamanho apaga o canvas e não pode sobrar quadro em branco.
    render();
  }

  function setDensity(next: number) {
    if (next === density) return;
    density = next;
    if (!sized) return;
    recount();
    if (!raf) render();
  }

  function advance(dt: number) {
    time += dt;
    for (let i = 0; i < MAX_STARS; i++) {
      const theta = starTheta[i] + starOmega[i] * dt;
      starTheta[i] = theta >= TAU ? theta - TAU : theta;
    }
    for (let i = 0; i < MAX_NODES; i++) {
      const theta = nodeTheta[i] + nodeOmega[i] * dt;
      nodeTheta[i] = theta >= TAU ? theta - TAU : theta;
    }
    const fade = dt / ARRIVAL_S;
    for (let i = 0; i < MAX_NODES; i++) {
      if (boost[i] > 0) boost[i] = Math.max(0, boost[i] - fade);
    }
  }

  /** Posição na tela: disco inclinado em volta do núcleo, mais a oscilação própria dos nós. */
  function layout() {
    for (let i = 0; i < activeStars; i++) {
      const theta = starTheta[i];
      const r = starRadius[i];
      starX[i] = coreX + r * Math.cos(theta);
      starY[i] = coreY + r * Math.sin(theta) * TILT;
    }
    for (let i = 0; i < activeNodes; i++) {
      const theta = nodeTheta[i];
      const r = nodeRadius[i];
      const wave = nodeFreq[i] * time;
      nodeX[i] = coreX + r * Math.cos(theta) + nodeAmp[i] * Math.sin(wave + nodePhaseX[i]);
      nodeY[i] = coreY + r * Math.sin(theta) * TILT + nodeAmp[i] * Math.sin(wave + nodePhaseY[i]);
    }
  }

  /** Guarda b entre os 3 vizinhos mais próximos de a (lista ordenada por distância). */
  function offer(a: number, b: number, d2: number) {
    const k = a * NEIGHBORS;
    if (d2 >= knnDist[k + 2]) return;
    if (d2 >= knnDist[k + 1]) {
      knnDist[k + 2] = d2;
      knnIndex[k + 2] = b;
      return;
    }
    knnDist[k + 2] = knnDist[k + 1];
    knnIndex[k + 2] = knnIndex[k + 1];
    if (d2 >= knnDist[k]) {
      knnDist[k + 1] = d2;
      knnIndex[k + 1] = b;
      return;
    }
    knnDist[k + 1] = knnDist[k];
    knnIndex[k + 1] = knnIndex[k];
    knnDist[k] = d2;
    knnIndex[k] = b;
  }

  function isNeighbor(a: number, b: number): boolean {
    const k = a * NEIGHBORS;
    return knnIndex[k] === b || knnIndex[k + 1] === b || knnIndex[k + 2] === b;
  }

  /** Os dois nós do par estão além da mesma borda: a linha não aparece. */
  function offscreen(a: number, b: number): boolean {
    const ax = nodeX[a];
    const ay = nodeY[a];
    const bx = nodeX[b];
    const by = nodeY[b];
    return (ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax > width && bx > width) || (ay > height && by > height);
  }

  /**
   * Cada nó liga com até 3 vizinhos mais próximos a menos de L (força bruta, até 3.160 pares). A força
   * de cada par, (1 − d/L)², anda no máximo 1/0,8 por segundo: ligação que entra ou sai aparece e some
   * aos poucos. `snap` (quadro estático) vai direto ao valor certo.
   */
  function links(dt: number, snap: boolean) {
    const n = activeNodes;
    const reach = linkLength * linkLength;
    knnIndex.fill(-1, 0, n * NEIGHBORS);
    knnDist.fill(Infinity, 0, n * NEIGHBORS);
    for (let i = 0; i < n; i++) {
      const xi = nodeX[i];
      const yi = nodeY[i];
      for (let j = i + 1; j < n; j++) {
        const dx = nodeX[j] - xi;
        const dy = nodeY[j] - yi;
        const d2 = dx * dx + dy * dy;
        pairDist[i * MAX_NODES + j] = d2;
        if (d2 < reach) {
          offer(i, j, d2);
          offer(j, i, d2);
        }
      }
    }
    bucketCount.fill(0);
    const step = dt / FADE_S;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const p = i * MAX_NODES + j;
        let target = 0;
        if (isNeighbor(i, j) || isNeighbor(j, i)) {
          const f = 1 - Math.sqrt(pairDist[p]) / linkLength;
          target = f * f;
        }
        let s = strength[p];
        if (snap) s = target;
        else if (s < target) s = Math.min(target, s + step);
        else if (s > target) s = Math.max(target, s - step);
        strength[p] = s;
        const level = Math.round(s * LINK_LEVELS.length);
        if (level === 0 || offscreen(i, j)) continue;
        const bucket = level - 1;
        bucketPairs[bucket * PAIRS + bucketCount[bucket]++] = p;
      }
    }
  }

  /** O par está ligado na rede, mesmo que a linha esteja apagada demais para aparecer (a sinapse desenha a dela). */
  function linked(a: number, b: number): boolean {
    const p = a < b ? a * MAX_NODES + b : b * MAX_NODES + a;
    return strength[p] > 0;
  }

  function visited(node: number, length: number): boolean {
    for (let k = 0; k <= length; k++) if (path[k] === node) return true;
    return false;
  }

  /** Caminho a partir de `from`: sempre pela ligação mais alinhada com a direção do núcleo, sem repetir nó. */
  function walk(from: number, hops: number): number {
    path[0] = from;
    let length = 0;
    let current = from;
    while (length < hops) {
      const x = nodeX[current];
      const y = nodeY[current];
      const toCore = Math.hypot(coreX - x, coreY - y) || 1;
      const ux = (coreX - x) / toCore;
      const uy = (coreY - y) / toCore;
      let best = -1;
      let bestAlign = 0;
      for (let j = 0; j < activeNodes; j++) {
        if (j === current || visited(j, length) || !linked(current, j)) continue;
        const ex = nodeX[j] - x;
        const ey = nodeY[j] - y;
        const align = (ex * ux + ey * uy) / (Math.hypot(ex, ey) || 1);
        if (align > bestAlign) {
          bestAlign = align;
          best = j;
        }
      }
      if (best < 0) break;
      path[++length] = best;
      current = best;
    }
    return length;
  }

  function pathUses(limit: number): boolean {
    for (let k = 0; k <= synHops; k++) if (path[k] >= limit) return true;
    return false;
  }

  function endSynapse() {
    synActive = false;
    synEnv = 0;
    // A próxima vem U[6, 10] s depois do fim desta.
    synNext = time + 6 + 4 * rand();
  }

  /** Começa num nó visível no alto à direita (onde a máscara vale 0,6 ou mais) e anda 2 a 4 saltos. */
  function startSynapse() {
    let count = 0;
    for (let i = 0; i < activeNodes; i++) {
      const x = nodeX[i];
      const y = nodeY[i];
      if (x > 0.55 * width && x < width && y > 0 && y < 0.55 * height) candidates[count++] = i;
    }
    if (count) {
      const hops = 2 + Math.floor(rand() * 3);
      const first = Math.floor(rand() * count);
      for (let k = 0; k < count; k++) {
        const length = walk(candidates[(first + k) % count], hops);
        if (length < 2) continue;
        synActive = true;
        synHops = length;
        synStart = time;
        synLastStart = time;
        synHop = 0;
        synT = 0;
        synEnv = 0;
        return;
      }
    }
    // Nenhum caminho agora (rede fora da área): tenta de novo daqui a 1 s.
    synNext = time + 1;
  }

  function updateSynapse() {
    if (synActive) {
      const elapsed = time - synStart;
      const total = synHops * HOP_S;
      if (elapsed >= total) {
        endSynapse();
      } else {
        synHop = Math.min(synHops - 1, Math.floor(elapsed / HOP_S));
        const local = elapsed - synHop * HOP_S;
        synT = local / HOP_S;
        // Envelope: sobe em 0,8 s e desce em 0,8 s no fim do último salto.
        synEnv = Math.min(1, elapsed / FADE_S, (total - elapsed) / FADE_S);
        // O nó de chegada clareia aos poucos na reta final do salto (até 2×) e depois volta em 1,2 s.
        const arriving = path[synHop + 1];
        const glow = smoothstep(clamp((local - (HOP_S - FADE_S)) / FADE_S, 0, 1));
        if (glow > boost[arriving]) boost[arriving] = glow;
      }
    }
    if (!synActive && time >= synNext) startSynapse();
  }

  function draw() {
    // 1. Limpa o bitmap inteiro (sem a escala do dpr).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 2. Composição do tema.
    ctx.globalCompositeOperation = style.composite;

    // 3. Estrelas, agrupadas por sprite e alpha.
    for (let g = 0; g < 9; g++) {
      const sprite = starSprites[g];
      const from = groupStart[g];
      const to = groupStart[g + 1];
      if (!sprite || from === to) continue;
      const { image, size, half } = sprite;
      ctx.globalAlpha = style.star[(g / 3) | 0] * INTENSITY;
      for (let k = from; k < to; k++) {
        const i = order[k];
        if (i >= activeStars) break;
        const x = starX[i];
        const y = starY[i];
        if (x < -half || y < -half || x > width + half || y > height + half) continue;
        ctx.drawImage(image, x - half, y - half, size, size);
      }
    }

    // 4. Ligações: um stroke() por balde de alpha.
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = "round";
    ctx.strokeStyle = linkStroke;
    for (let b = 0; b < LINK_LEVELS.length; b++) {
      const count = bucketCount[b];
      if (!count) continue;
      ctx.globalAlpha = style.link * LINK_LEVELS[b] * INTENSITY;
      ctx.beginPath();
      const base = b * PAIRS;
      for (let k = 0; k < count; k++) {
        const p = bucketPairs[base + k];
        const i = (p / MAX_NODES) | 0;
        const j = p - i * MAX_NODES;
        ctx.moveTo(nodeX[i], nodeY[i]);
        ctx.lineTo(nodeX[j], nodeY[j]);
      }
      ctx.stroke();
    }

    // 5. Nós; o de chegada da sinapse ganha uma segunda passada (até 2× mais claro).
    ctx.globalAlpha = style.node * INTENSITY;
    for (let i = 0; i < activeNodes; i++) {
      const sprite = nodeSprites[nodeColor[i]];
      if (!sprite) continue;
      const x = nodeX[i];
      const y = nodeY[i];
      if (x < -sprite.half || y < -sprite.half || x > width + sprite.half || y > height + sprite.half) continue;
      ctx.drawImage(sprite.image, x - sprite.half, y - sprite.half, sprite.size, sprite.size);
    }
    for (let i = 0; i < activeNodes; i++) {
      const sprite = nodeSprites[nodeColor[i]];
      if (!sprite || boost[i] < 0.01) continue;
      ctx.globalAlpha = style.node * boost[i] * INTENSITY;
      ctx.drawImage(sprite.image, nodeX[i] - sprite.half, nodeY[i] - sprite.half, sprite.size, sprite.size);
    }

    // 6. Sinapse: a ligação do salto atual e o ponto andando nela.
    if (synActive && synEnv > 0 && dotSprite) {
      const a = path[synHop];
      const b = path[synHop + 1];
      ctx.strokeStyle = synapseStroke;
      ctx.globalAlpha = style.synapse * synEnv * INTENSITY;
      ctx.beginPath();
      ctx.moveTo(nodeX[a], nodeY[a]);
      ctx.lineTo(nodeX[b], nodeY[b]);
      ctx.stroke();
      const p = smoothstep(synT);
      const x = nodeX[a] + (nodeX[b] - nodeX[a]) * p;
      const y = nodeY[a] + (nodeY[b] - nodeY[a]) * p;
      ctx.globalAlpha = style.dot * synEnv * INTENSITY;
      ctx.drawImage(dotSprite.image, x - dotSprite.half, y - dotSprite.half, dotSprite.size, dotSprite.size);
    }

    // 7. Volta a composição ao normal.
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  function render() {
    if (destroyed || !sized || !hasPalette) return;
    layout();
    links(0, true);
    draw();
    if (!shown) {
      // 1º quadro pronto: entra com o fade de 400 ms do CSS (anulado por "reduzir movimento").
      shown = true;
      canvas.style.opacity = "1";
    }
  }

  /** Média móvel do custo do quadro: lento corta a densidade pela metade (uma vez); muito lento, para. */
  function measure(cost: number) {
    frameCost = frameCost < 0 ? cost : frameCost + (cost - frameCost) * 0.05;
    measured++;
    if (measured < COST_WINDOW) return;
    if (!halved && frameCost > SLOW_MS) {
      halved = true;
      measured = 0;
      recount();
    } else if (halved && frameCost > TOO_SLOW_MS) {
      degraded = true;
      stop();
    }
  }

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    // 1º quadro depois do start: a tela já mostra este estado; só marca o relógio.
    if (last < 0) {
      last = now;
      return;
    }
    const elapsed = now - last;
    if (elapsed < FRAME_MS) return;
    last = now;
    const dt = Math.min(elapsed, MAX_STEP_MS) / 1000;
    const begin = performance.now();
    advance(dt);
    layout();
    links(dt, false);
    updateSynapse();
    draw();
    measure(performance.now() - begin);
  };

  function start() {
    if (raf || destroyed || degraded || !sized || !hasPalette) return;
    last = -1;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function pulse() {
    if (!raf || synActive || time - synLastStart < PULSE_GAP_S) return;
    synNext = time;
  }

  function destroy() {
    stop();
    destroyed = true;
    releaseSprites();
    canvas.style.opacity = "";
    canvas.width = 0;
    canvas.height = 0;
  }

  return {
    resize,
    setPalette,
    setDensity,
    start,
    stop,
    render,
    pulse,
    destroy,
    get running() {
      return raf !== 0;
    },
    get degraded() {
      return degraded;
    },
  };
}
