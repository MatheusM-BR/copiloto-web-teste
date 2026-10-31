// Mapa (MapLibre): criação, modo "seguir minha posição", erro de carregamento e clique.
// Expõe Copiloto.mapa, Copiloto.mapaPronto(fn), Copiloto.seguir(v) e Copiloto.mapaModo(modo?) ("simples" | "completo").
// Emite "mapa-clique" ({ lngLat }).
// Também cuida de:
//  - A1: a coluna de botões redondos fica sempre no espaço livre do mapa, abaixo do painel de navegação e do alerta
//    (em uma, duas ou três colunas, conforme a altura), sem nada por cima e sem cobrir a atribuição nem a velocidade;
//  - A4/M5: o app é para o celular em pé (manifest "portrait", que o iOS ignora); deitado (tela baixa), uma faixa no alto
//    pede "Use o celular em pé" sem tapar SOS, alerta nem botões (estilos/base.css);
//  - B4: o mapa não gira nem inclina pelo toque (sem bússola embaixo do painel);
//  - M1 (QA 3): navegando, o "seguir" volta sozinho depois de 10 s sem toque no mapa (arrasto sem querer);
//  - NAV-05: comando de voz "mapa simples"/"mapa completo" (comando:mapa-modo). Simples esconde postos, relatos guardados
//    e os pontos de interesse do mapa base; rota, alertas e relatos ativos continuam. Fica guardado (copiloto.mapa.modo.v1).
(function (C) {
  "use strict";
  const { $, el } = C.util;
  const ESTILO = "https://tiles.openfreemap.org/styles/liberty"; // gratuito, sem chave
  const CHAVE_MODO = "copiloto.mapa.modo.v1";
  let seguindo = false, avisouErro = false, avisouSemRede = 0;
  let modo = (C.util.lerJSON(CHAVE_MODO, null) || {}).modo === "simples" ? "simples" : "completo";

  function definirSeguir(v) {
    seguindo = v;
    $("btn-seguir").setAttribute("aria-pressed", String(v));
    const pos = C.estado.ultimaPos;
    if (v && pos) C.mapa.easeTo({ center: pos, zoom: Math.max(C.mapa.getZoom(), 15), duration: 600 });
    vigiarVolta();
  }

  // M1 (QA 3): navegando, um arrasto sem querer desligava o "seguir" e nada religava (no iPhone SE com alerta o ◎ fica
  // escondido). Com a navegação ativa, o mapa volta a seguir sozinho depois de VOLTA_SEGUIR_MS sem toque no mapa.
  const VOLTA_SEGUIR_MS = 10000;
  let timerVolta = null;
  function navegando() { try { return !!(C.navegacao && C.navegacao.ativa && C.navegacao.ativa()); } catch (e) { return false; } }
  function vigiarVolta() {
    clearTimeout(timerVolta); timerVolta = null;
    if (seguindo) return;
    timerVolta = setTimeout(() => {
      timerVolta = null;
      if (!seguindo && navegando()) definirSeguir(true); // fora da navegação, nada (ao iniciar, ela liga o "seguir")
    }, VOLTA_SEGUIR_MS);
  }

  // Roda fn quando o estilo do mapa estiver carregado (para addSource/addLayer).
  // Depois do primeiro "load", roda na hora. Não dá para confiar só em isStyleLoaded(): ele volta a ser false enquanto
  // uma fonte nova carrega (ex.: a camada de postos do E2), e aí once("load") nunca mais dispararia.
  let carregou = false;
  function mapaPronto(fn) { if (carregou || C.mapa.isStyleLoaded()) fn(); else C.mapa.once("load", fn); }

  // ------------------------------------------------------------ A1: botões do mapa no espaço livre
  // Coluna por coluna, da direita para a esquerda; em cada coluna, de baixo para cima (o último botão, Falar, fica
  // embaixo, à direita). Cada coluna vai do que estiver em cima dela (painel de navegação, alerta, chip do veículo) até
  // acima do que estiver embaixo dela: a atribuição do mapa (© OpenStreetMap / ANP, aberta ou fechada; a licença ODbL
  // exige que fique visível e tocável) e o velocímetro. Só a primeira coluna desce até o pé (a atribuição fica à esquerda
  // dela, estilos/comandos.css). As colunas não passam da borda esquerda da tela.
  // Sem espaço para todos (iPhone SE com navegação, alerta e instrução longa; celular deitado), esconde primeiro os não
  // essenciais, nesta ordem; o "!" (relatar) e o "Falar" nunca saem (o SOS fica na barra inferior).
  const VAO = 10, BASE = 14, MARGEM = 8;
  const DISPENSAVEIS = ["btn-tela", "e3-btn-baixar", "btn-seguir", "btn-destino", "btn-postos"];
  function visivel(e) { return !!e && !e.hidden && e.offsetParent !== null && getComputedStyle(e).display !== "none"; }
  const SEL_PE = ".maplibregl-ctrl-bottom-right > *, .maplibregl-ctrl-bottom-left > *, .painel-mapa > .velocidade";
  const SEL_TOPO = "#nav-painel, #alerta, .maplibregl-ctrl-top-right > *, .maplibregl-ctrl-top-left > *, .painel-mapa > .chip-veiculo";
  function retangulos(sel) {
    const out = [];
    for (const e of document.querySelectorAll(sel)) {
      if (!visivel(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push(r);
    }
    return out;
  }
  // Reparte "ordem" (de baixo para cima, da direita para a esquerda) em colunas. Devolve null se não couber.
  function repartir(ordem, mr, direita, topos, pes) {
    const alturas = ordem.map((b) => b.offsetHeight || 64), larguras = ordem.map((b) => b.offsetWidth || 64);
    const pos = [];
    let i = 0, xDir = direita, colunas = 0;
    while (i < ordem.length) {
      const xEsq = xDir - Math.max.apply(null, larguras.slice(i));
      if (xEsq < mr.left + MARGEM) return null; // passaria da borda esquerda
      let teto = mr.top + MARGEM, chao = mr.bottom - BASE;
      for (const r of topos) if (r.left < xDir && r.right > xEsq && r.top < mr.bottom - BASE) teto = Math.max(teto, r.bottom + MARGEM);
      for (const r of pes) if (r.left < xDir && r.right > xEsq) chao = Math.min(chao, r.top - MARGEM);
      const disponivel = chao - teto;
      const coluna = []; let alto = 0, larg = 0;
      while (i < ordem.length) {
        const prox = alto + (coluna.length ? VAO : 0) + alturas[i];
        if (prox > disponivel) break;
        coluna.push(i); alto = prox; larg = Math.max(larg, larguras[i]); i++;
      }
      if (!coluna.length) return null; // nem um botão cabe nesta coluna
      let y = mr.bottom - BASE - chao;
      for (const k of coluna) {
        pos.push({ b: ordem[k], bottom: y, right: direita - xDir + (larg - larguras[k]) / 2 });
        y += alturas[k] + VAO;
      }
      xDir -= larg + VAO; colunas++;
    }
    return { pos, colunas, largura: Math.max(0, direita - xDir - VAO) };
  }
  function arrumarAcoes() {
    const acoes = document.querySelector(".acoes"), main = document.querySelector("main");
    if (!acoes || !main || !main.offsetHeight) return;
    // os escondidos por falta de espaço continuam candidatos (a classe só muda quando o resultado muda: sem laço com o observador)
    const botoes = Array.from(acoes.children).filter((b) => !b.hidden && (b.classList.contains("sem-espaco") || getComputedStyle(b).display !== "none"));
    if (!botoes.length) return;
    if (!acoes.classList.contains("arrumada")) acoes.classList.add("arrumada"); // sem mutação à toa (observador)
    acoes.style.top = "0px";
    const mr = main.getBoundingClientRect(), direita = acoes.getBoundingClientRect().right;
    const topos = retangulos(SEL_TOPO), pes = retangulos(SEL_PE);
    let ordem = botoes.slice().reverse(), arranjo = repartir(ordem, mr, direita, topos, pes);
    const escondidos = [];
    for (const id of DISPENSAVEIS) {
      if (arranjo) break;
      const b = ordem.find((x) => x.id === id);
      if (!b) continue;
      ordem = ordem.filter((x) => x !== b); escondidos.push(b);
      arranjo = repartir(ordem, mr, direita, topos, pes);
    }
    if (!arranjo) { // nem assim: põe o que der, sem sair da tela (raro: tela minúscula)
      arranjo = { pos: [], colunas: 0, largura: 0 };
      let y = 0;
      for (const b of ordem) { arranjo.pos.push({ b, bottom: y, right: 0 }); y += (b.offsetHeight || 64) + VAO; }
      arranjo.colunas = 1; arranjo.largura = Math.max.apply(null, ordem.map((b) => b.offsetWidth || 64));
    }
    for (const b of botoes) b.classList.toggle("sem-espaco", escondidos.includes(b));
    for (const p of arranjo.pos) { p.b.style.bottom = p.bottom + "px"; p.b.style.right = p.right + "px"; }
    acoes.style.width = arranjo.largura + "px";
    acoes.dataset.colunas = String(arranjo.colunas);
    acoes.dataset.escondidos = escondidos.map((b) => b.id).join(" ");
  }
  let pedidoArrumar = false;
  function agendarArrumar() {
    if (pedidoArrumar) return;
    pedidoArrumar = true;
    requestAnimationFrame(() => { pedidoArrumar = false; arrumarAcoes(); });
  }
  function vigiarLayout() {
    const acoes = document.querySelector(".acoes");
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(agendarArrumar) : null;
    const mo = new MutationObserver(agendarArrumar);
    // a atribuição muda de tamanho ao abrir/fechar (botão "i") e quando o texto das fontes chega
    for (const e of [document.querySelector("main"), $("nav-painel"), $("alerta"), document.querySelector(".velocidade"),
      document.querySelector(".chip-veiculo"), document.querySelector(".maplibregl-ctrl-attrib")]) {
      if (!e) continue;
      if (ro) ro.observe(e);
      mo.observe(e, { attributes: true, attributeFilter: ["hidden", "class"] });
    }
    for (const e of document.querySelectorAll(".maplibregl-ctrl-bottom-right, .maplibregl-ctrl-bottom-left")) mo.observe(e, { childList: true });
    // o alerta muda de lugar sem mudar de tamanho quando o painel de navegação muda (--nav-fim no #app, ui/navegacao.js)
    if ($("app")) mo.observe($("app"), { attributes: true, attributeFilter: ["style", "class"] });
    if (acoes) mo.observe(acoes, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
    window.addEventListener("resize", agendarArrumar);
    for (const ev of ["navegacao", "alerta", "alerta-fechado", "aba", "folha"]) C.on(ev, agendarArrumar);
    arrumarAcoes();
  }

  // ------------------------------------------------------------ A4: celular deitado
  function criarAvisoPaisagem() {
    if ($("aviso-paisagem")) return;
    const a = el("div", "aviso-paisagem"); a.id = "aviso-paisagem"; a.setAttribute("role", "status");
    a.append(el("div", "aviso-paisagem-icone", "📱"), el("b", null, "Use o celular em pé"),
      el("p", null, "O Copiloto foi feito para a tela na vertical, no suporte. Gire o celular para continuar."));
    document.body.appendChild(a);
  }

  // ------------------------------------------------------------ NAV-05: mapa simples / completo
  const CAMADAS_SIMPLES = ["postos-pontos"]; // camadas dos pacotes que o modo simples esconde
  function camadaNaoEssencial(camada) {
    if (CAMADAS_SIMPLES.includes(camada.id)) return true;
    // pontos de interesse do mapa base (lojas, restaurantes…): não ajudam a dirigir
    return camada.type === "symbol" && /(^|[-_])poi([-_]|$)/i.test(camada.id) && camada.id.indexOf("e3-") !== 0;
  }
  function aplicarModo() {
    const app = $("app");
    if (app) app.classList.toggle("mapa-simples", modo === "simples");
    const mapa = C.mapa;
    if (!mapa || !mapa.getStyle) return;
    let camadas = [];
    try { camadas = (mapa.getStyle() || {}).layers || []; } catch (e) { return; }
    const vis = modo === "simples" ? "none" : "visible";
    for (const c of camadas) {
      if (!camadaNaoEssencial(c)) continue;
      try { if (mapa.getLayoutProperty(c.id, "visibility") !== vis && !(vis === "visible" && mapa.getLayoutProperty(c.id, "visibility") === undefined)) mapa.setLayoutProperty(c.id, "visibility", vis); } catch (e) { /* camada sumiu */ }
    }
  }
  function mapaModo(novo) {
    if (novo === "simples" || novo === "completo") {
      modo = novo;
      C.util.gravarJSON(CHAVE_MODO, { modo });
      aplicarModo();
    }
    return modo;
  }

  C.seguir = definirSeguir;
  C.mapaModo = mapaModo;
  C.seguindo = () => seguindo;
  C.mapaPronto = mapaPronto;
  C.mapaEstiloUrl = ESTILO; // ui/offline.js (E3) guarda o estilo no cache para o mapa abrir sem internet

  C.aoIniciar(() => {
    const mapa = new maplibregl.Map({
      container: "mapa", style: ESTILO, center: [-49.25, -16.68], zoom: 6, attributionControl: { compact: true },
    });
    C.mapa = mapa;
    mapa.once("load", () => { carregou = true; });
    window.copiloto = { mapa: mapa, nuvem: C.nuvem }; // atalho usado pelos testes de navegador
    // B4 (QA): sem girar nem inclinar o mapa pelo toque (o app nunca gira o mapa sozinho). Assim não precisa de bússola,
    // que ficava embaixo do painel de navegação; o norte fica sempre para cima.
    if (mapa.dragRotate) mapa.dragRotate.disable();
    if (mapa.touchZoomRotate) mapa.touchZoomRotate.disableRotation();
    if (mapa.touchPitch) mapa.touchPitch.disable();
    if (mapa.keyboard && mapa.keyboard.disableRotation) mapa.keyboard.disableRotation();
    mapa.on("dragstart", () => definirSeguir(false));
    // M1: cada toque no mapa adia a volta ao "seguir" (o motorista ainda está olhando o mapa)
    for (const ev of ["pointerdown", "touchstart", "wheel"]) mapa.getContainer().addEventListener(ev, () => { if (!seguindo) vigiarVolta(); }, { passive: true });
    mapa.on("error", () => {
      // sem internet, falta de pedaço do mapa é esperada (só aparece o que foi visto ou baixado: ui/offline.js, E3)
      if (navigator.onLine === false) {
        if (Date.now() - avisouSemRede > 120000) { avisouSemRede = Date.now(); C.mensagem("Sem internet: o mapa só aparece onde já foi visto ou baixado.", 6000); }
        return;
      }
      if (avisouErro) return;
      avisouErro = true;
      C.mensagem("O mapa não carregou. Confira a internet e recarregue a página.", 8000);
    });
    mapa.on("click", (e) => C.emit("mapa-clique", { lngLat: e.lngLat }));
    $("btn-seguir").addEventListener("click", () => definirSeguir(!seguindo));
    C.on("aba", (id) => { if (id === "mapa") setTimeout(() => mapa.resize(), 50); });
    criarAvisoPaisagem();
    // camadas novas (postos, estilo recarregado) também seguem o modo
    mapa.on("styledata", () => { if (modo === "simples") aplicarModo(); });
    aplicarModo();
    C.on("comando:mapa-modo", (d) => {
      if (!d || (d.modo !== "simples" && d.modo !== "completo")) return;
      if (typeof d.atender === "function") d.atender();
      mapaModo(d.modo);
      C.mensagem(d.modo === "simples" ? "Mapa simples: só rota, alertas e relatos ativos." : "Mapa completo.", 4000);
      C.voz.falar(d.modo === "simples" ? "Mapa simples." : "Mapa completo.", { naoInterromper: true });
    });
    C.on("pronto", vigiarLayout);
  });
})(window.Copiloto);
