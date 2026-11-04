// Ícones SVG próprios (sem dependência, sem emoji: o desenho não muda de aparelho para aparelho).
// Traço de 2 px em 24×24 com currentColor (a cor vem do CSS: contraste AA nos temas claro e escuro).
// Uso: CopilotoIcones.svg("pedagio", { rotulo: "Pedágio" }) → string; CopilotoIcones.no(...) → elemento SVG.
// Com `rotulo` o ícone é uma imagem para o leitor de tela (role="img", aria-label); sem ele é decoração (aria-hidden).
// Regra de uso: ícone só ao lado de texto curto quando houver ambiguidade; nunca no lugar do rótulo de uma ação crítica.
(function (raiz) {
  "use strict";
  const T = (x, y, s, t) => '<text x="' + x + '" y="' + y + '" font-size="' + s + '" font-weight="800" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">' + t + "</text>";
  const ICONES = {
    bomba: '<path d="M4 21V5a2 2 0 012-2h7a2 2 0 012 2v16M3 21h13M6 8h7M15 9h2a2 2 0 012 2v6a1.5 1.5 0 003 0V8l-3-3"/>',
    caminhao: '<path d="M2 6h11v10H2zM13 9.5h4.5L21 13v3h-8"/><circle cx="6.5" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
    diesel_caminhao: '<path d="M3 5a2 2 0 012-2h6a2 2 0 012 2v13H3zM3 21h11M5.5 7h5"/><path d="M15 12h3.5l2.5 3v3h-6z"/><circle cx="17" cy="20" r="1.3"/>',
    arla32: '<path d="M12 2.5s6.5 6.8 6.5 11.5a6.5 6.5 0 01-13 0C5.5 9.300 12 2.500 12 2.500z"/>' + T(12, 17, 7.5, "32"),
    h24: '<circle cx="12" cy="12" r="9.5"/>' + T(12, 15, 8.5, "24"),
    banheiro: '<rect x="2.5" y="4.500" width="19" height="15" rx="3"/>' + T(12, 15, 8.5, "WC"),
    banho: '<path d="M4 11a8 8 0 0116 0zM12 3V2M8 15v2.500M12 15v4M16 15v2.500"/>',
    gnv: '<rect x="2.500" y="5" width="19" height="14" rx="3"/>' + T(12, 15, 7.5, "GNV"),
    etanol: '<path d="M5 20C4.500 11 9.500 5 20 4c-.5 10-6 15.500-15 16zM5 20l8.500-8.500"/>',
    restaurante: '<path d="M7 3v7a2.500 2.500 0 002.500 2.500M12 3v7a2.500 2.500 0 01-2.500 2.500M9.500 3v18M18 21V3c-2.500 1.500-3.500 5-3.500 8.500H18"/>',
    estacionamento: '<rect x="3" y="3" width="18" height="18" rx="3.500"/><path d="M9.500 17.500V7h3.700a3.200 3.200 0 010 6.400H9.500"/>',
    borracharia: '<circle cx="12" cy="12" r="9.500"/><circle cx="12" cy="12" r="3.500"/><path d="M12 2.500V8.500M12 15.500v6M2.500 12H8.500M15.500 12h6"/>',
    loja: '<path d="M4 9.500L5.500 4h13L20 9.500M4 9.500V20h16V9.500M4 9.500a2.700 2.700 0 005.300 0 2.700 2.700 0 005.400 0 2.700 2.700 0 005.300 0M10 20v-6h4v6"/>',
    pernoite: '<path d="M3 19V6M3 15h18v4M21 15v-2.500a3 3 0 00-3-3h-8V15"/><circle cx="6.500" cy="11.500" r="1.800"/>',
    ar: '<path d="M4 17a8 8 0 1116 0"/><path d="M12 17l3.500-5M5 17h14"/>',
    wifi: '<path d="M2 9a15 15 0 0120 0M5 12.500a10.500 10.500 0 0114 0M8.500 16a5.500 5.500 0 017 0"/><circle cx="12" cy="19.500" r="1" fill="currentColor"/>',
    relogio: '<circle cx="12" cy="12" r="9.500"/><path d="M12 6.500V12l3.500 2"/>',
    distancia: '<path d="M3.500 5v14M3.500 12H19M14.500 7l5 5-5 5"/>',
    rota: '<circle cx="6" cy="18" r="2.200"/><circle cx="18" cy="6" r="2.200"/><path d="M8.200 18H15a3.500 3.500 0 000-7H9a3.500 3.500 0 010-7h6.800"/>',
    reta: '<path d="M4.500 19.500l15-15M10 4.500h9.500V14"/>',
    pedagio: '<circle cx="12" cy="12" r="9.500"/><path d="M14.800 9.200c-.5-1-1.500-1.600-2.800-1.600-1.600 0-2.700.9-2.700 2.100s1 1.700 2.700 2.100c1.700.4 2.700.9 2.700 2.100s-1.100 2.100-2.700 2.100c-1.300 0-2.300-.6-2.800-1.600M12 5.800v1.800M12 16.400v1.800"/>',
    balanca: '<path d="M12 3v18M6.500 21h11M4.500 7h15M4.500 7l-2.800 7a3.300 3.300 0 005.600 0zM19.500 7l-2.800 7a3.300 3.300 0 005.600 0z"/>',
    aviso: '<path d="M12 3L22 20.500H2z"/><path d="M12 10v5M12 17.600v.4"/>',
    obras: '<path d="M9.500 4h5l4 15.500H5.500z"/><path d="M8 10.500h8M6.800 15h10.400M3 20h18"/>',
    chuva: '<path d="M7 14.500a4 4 0 010-8 5.200 5.200 0 019.800 1.200A3.400 3.400 0 0116.500 14.500zM8 17.500l-1 3M12 17.500l-1 3M16 17.500l-1 3"/>',
    telefone: '<path d="M5 3h3.800l1.900 4.800-2.400 1.500a11 11 0 005.400 5.400l1.500-2.400L20 14.200V18a2.500 2.500 0 01-2.700 2.500A16.500 16.500 0 013 5.700 2.500 2.500 0 015 3z"/>',
    ir: '<path d="M12 2.500l7.500 18.500-7.500-3.800L4.500 21z"/>',
    bandeira: '<path d="M5.500 21V3.500M5.500 4h12.500l-2.500 4.500 2.500 4.500H5.500"/>',
    ajuda: '<circle cx="12" cy="12" r="9.500"/><path d="M9.300 9.500a2.700 2.700 0 115.400 0c0 1.800-2.700 2.200-2.700 4.200M12 17.200v.4"/>',
    ok: '<path d="M4.500 12.500l5 5L19.500 7"/>',
    fechar: '<path d="M6 6l12 12M18 6L6 18"/>',
    voltar: '<path d="M15 5l-7 7 7 7"/>',
    filtro: '<path d="M3 5h18l-7 8.500V20l-4-2v-4.500z"/>',
  };
  const NOMES = Object.keys(ICONES);

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
  function svg(nome, o) {
    o = o || {};
    const dentro = ICONES[nome] || ICONES.ajuda;
    const a11y = o.rotulo ? 'role="img" aria-label="' + esc(o.rotulo) + '"' : 'aria-hidden="true"';
    return '<svg class="ico ico-' + esc(nome) + (o.classe ? " " + esc(o.classe) : "") + '" viewBox="0 0 24 24" ' + a11y +
      ' focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + dentro + "</svg>";
  }
  // Elemento SVG pronto (só no navegador).
  function no(nome, o) {
    const t = document.createElement("template");
    t.innerHTML = svg(nome, o);
    return t.content.firstChild;
  }

  const api = { NOMES, svg, no };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoIcones = api;
})(typeof window !== "undefined" ? window : globalThis);
