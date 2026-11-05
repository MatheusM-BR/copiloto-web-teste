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
    // r6 (símbolos nas telas restantes): voz, busca, configurações e os tipos de relato
    voz_tudo: '<path d="M4 9.500h3.500L12 5.500v13l-4.500-4H4z"/><path d="M15.500 9a4 4 0 010 6M18.200 6.500a8 8 0 010 11"/>',
    voz_alertas: '<path d="M6 17v-6a6 6 0 0112 0v6l1.500 2h-15zM10 21.500h4"/>',
    lupa: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="M15.500 15.500L21 21"/>',
    pino: '<path d="M12 21.500s-7-6.200-7-11.800a7 7 0 0114 0c0 5.600-7 11.800-7 11.800z"/><circle cx="12" cy="9.700" r="2.500"/>',
    casa: '<path d="M3.500 11L12 3.500 20.500 11M5.500 9.500V20.500h13V9.500M10 20.500v-6h4v6"/>',
    mapa: '<path d="M3 6.500l6-2.500 6 2.500 6-2.500v14l-6 2.500-6-2.500-6 2.500zM9 4v14M15 6.500v14"/>',
    engrenagem: '<circle cx="12" cy="12" r="3"/><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3M5.300 5.300l2.100 2.100M16.600 16.600l2.100 2.100M5.300 18.700l2.100-2.100M16.600 7.400l2.100-2.100"/>',
    sol: '<circle cx="12" cy="12" r="4"/><path d="M12 2.500v2.500M12 19v2.500M2.500 12H5M19 12h2.500M5.300 5.300l1.800 1.800M16.900 16.900l1.800 1.800M5.300 18.700l1.800-1.800M16.900 7.100l1.800-1.800"/>',
    lua: '<path d="M20 14.500A8.500 8.500 0 019.500 4 8.500 8.500 0 1020 14.500z"/>',
    tema_auto: '<circle cx="12" cy="12" r="9.500"/><path d="M12 2.500a9.500 9.500 0 000 19z" fill="currentColor"/>',
    escudo: '<path d="M12 3l7.500 3v5.500c0 4.700-3.200 8.200-7.500 9.500-4.300-1.300-7.500-4.800-7.500-9.500V6z"/>',
    pessoa: '<circle cx="12" cy="8" r="4"/><path d="M4.500 21a7.500 7.500 0 0115 0"/>',
    celular: '<rect x="7" y="2.500" width="10" height="19" rx="2.500"/><path d="M11 18.500h2"/>',
    pulso: '<path d="M3 12h4l2.500-6 4 12 2.500-6H21"/>',
    predio: '<path d="M5 21V4h9v17M14 9h5v12M8 8h3M8 12h3M8 16h3M3 21h18"/>',
    r_altura: '<path d="M12 6v12M8.500 9L12 5.500 15.500 9M8.500 15l3.500 3.500 3.500-3.500M4 3h16M4 21h16"/>',
    r_peso: '<path d="M7 8h10l3 12H4zM9.500 8a2.500 2.500 0 015 0"/>' + T(12, 17.500, 8, "t"),
    r_buraco: '<ellipse cx="12" cy="15" rx="8" ry="4"/><path d="M5 11.500l-1.500-4M19 11.500l1.500-4M12 10.500V5"/>',
    r_acidente: '<path d="M12 2.500l2 5 5-2-2 5 5 2-5 2 2 5-5-2-2 5-2-5-5 2 2-5-5-2 5-2-2-5 5 2z"/>',
    r_radar: '<circle cx="12" cy="12" r="2"/><path d="M7.500 7.500a6.400 6.400 0 000 9M16.500 7.500a6.400 6.400 0 010 9M4.500 4.500a10.600 10.600 0 000 15M19.500 4.500a10.600 10.600 0 010 15"/>',
    r_animal: '<circle cx="6.500" cy="10.500" r="1.800"/><circle cx="10" cy="6.500" r="1.800"/><circle cx="14" cy="6.500" r="1.800"/><circle cx="17.500" cy="10.500" r="1.800"/><path d="M12 12c-3 0-5.500 3-5.500 5.200 0 1.800 1.800 2.300 3 2.300 1 0 1.700-.5 2.500-.5s1.500.5 2.500.5c1.200 0 3-.5 3-2.300C17.500 15 15 12 12 12z"/>',
    r_fila: '<rect x="1.500" y="8.500" width="5.500" height="7" rx="1.500"/><rect x="9.200" y="8.500" width="5.500" height="7" rx="1.500"/><rect x="17" y="8.500" width="5.500" height="7" rx="1.500"/><path d="M4 19h16"/>',
    r_objeto: '<path d="M3.500 7.500L12 3l8.500 4.500v9L12 21l-8.500-4.500zM3.500 7.500L12 12l8.500-4.500M12 12v9"/>',
    r_parado: '<path d="M2.500 16.500v-3.500l2.200-4.500h8.600l2.200 4.500v3.500zM2.500 16.500v1.500M15.500 16.500v1.500"/><path d="M19 4.500l3 5.500h-6z"/>',
    r_alagamento: '<path d="M2.500 9c2 0 2-2 4.500-2s2.500 2 4.500 2 2.500-2 4.500-2 2.500 2 4.500 2M2.500 14c2 0 2-2 4.500-2s2.500 2 4.500 2 2.500-2 4.500-2 2.500 2 4.500 2M2.500 19c2 0 2-2 4.500-2s2.500 2 4.500 2 2.500-2 4.500-2 2.500 2 4.500 2"/>',
    r_neblina: '<path d="M4 7h13M7 11.500h13M4 16h10M8 20.500h12"/>',
    r_lisa: '<path d="M8 3c4 3-4 6 0 9s-4 6 0 9M16 3c4 3-4 6 0 9s-4 6 0 9"/>',
    balsa: '<path d="M3 16.500l1.800 3.500h14.400l1.800-3.500zM6.500 16.500V11.500h11v5M9.500 11.500V7.500h5v4M12 7.500V4"/>',
    terra: '<path d="M7 20.500L10 3.500M17 20.500L14 3.500M12 6.500v2.500M12 11.500v2.500M12 16.500v2.500"/>',
    casa: '<path d="M3 12l9-8 9 8M5 10v10h14V10M10 20v-6h4v6"/>',
    base: '<path d="M3 21V9.500l9-5.500 9 5.500V21M7 21v-6h10v6M7 12.500h10"/>',
    estrela: '<path d="M12 3l2.800 5.700 6.200.9-4.500 4.400 1.100 6.200L12 17.200 6.400 20.200l1.100-6.200L3 9.600l6.200-.9z"/>',
    parada: '<path d="M12 21s-6.500-6-6.500-11a6.500 6.500 0 0113 0c0 5-6.500 11-6.500 11z"/><circle cx="12" cy="10" r="2.300"/>',
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

  // Ícone de cada tipo de relato (app): usado na grade do formulário e nas listas.
  const ICONE_RELATO = { altura_maxima: "r_altura", limite_peso: "r_peso", obra: "obras", buraco: "r_buraco", acidente: "r_acidente", radar_movel: "r_radar",
    animal: "r_animal", fila: "r_fila", objeto: "r_objeto", veiculo_parado: "r_parado", alagamento: "r_alagamento", neblina: "r_neblina",
    pista_escorregadia: "r_lisa", balanca: "balanca" };
  // Põe o ícone (decorativo) no começo de um elemento, sem mexer no texto. Devolve o elemento.
  function prefixar(elemento, nome, classe) {
    if (!elemento || elemento.querySelector(":scope > svg.ico")) return elemento;
    elemento.insertBefore(no(nome, { classe: classe || "ico-prefixo" }), elemento.firstChild);
    return elemento;
  }

  const api = { NOMES, ICONE_RELATO, svg, no, prefixar };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoIcones = api;
})(typeof window !== "undefined" ? window : globalThis);
