/** Cor da barra do navegador e da janela do app instalado em cada tema (a mesma da moldura). */
export const THEME_COLOR = { light: "#f0f2f5", dark: "#08090b" } as const;

/**
 * Roda no <head> antes da pintura: aplica o tema salvo (ou o do sistema) sem piscar e acerta a cor da
 * barra (theme-color) pelo tema escolhido, não pelo do sistema.
 */
export const THEME_BOOT_SCRIPT = `(function(){var d=document,t;try{t=localStorage.getItem("theme")}catch(e){}if(t!=="light"&&t!=="dark"){try{t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){t="light"}}d.documentElement.dataset.theme=t;try{var m=d.querySelector('meta[name="theme-color"]');if(!m){m=d.createElement("meta");m.name="theme-color";d.head.appendChild(m)}m.content=t==="dark"?"${THEME_COLOR.dark}":"${THEME_COLOR.light}"}catch(e){}})();`;
