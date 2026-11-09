// Revisão 5 (equipe TOQUE): ajustes de toque e layout que atravessam vários módulos, sem editar os módulos dos outros:
//  - SOS no mapa (#btn-sos) abre a Emergência (ui/privacidade.js);
//  - teclado do iPhone: visualViewport → --teclado (folhas e telas sobem acima do teclado) e o campo focado rola à vista;
//  - atribuição do mapa (MapLibre) compacta e FECHADA enquanto navega;
//  - "Depois: Destino" não aparece no painel de navegação;
//  - tela "Voz" própria no menu (a Conta em "modo voz": só os cartões de voz, ids intactos) com "Mãos-livres";
//  - "Preparando a navegação…" ganha "Cancelar" (aborta o pedido de rota em andamento).
// Expõe Copiloto.toque = { abrirVoz() }.
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;

  // ------------------------------------------------------------ SOS no mapa
  function ligarSOS() {
    const b = $("btn-sos"); if (!b) return;
    b.addEventListener("click", () => { if (C.privacidade && C.privacidade.abrirEmergencia) C.privacidade.abrirEmergencia(); });
  }

  // ------------------------------------------------------------ teclado (visualViewport)
  // No iPhone o teclado cobre a parte de baixo SEM encolher a página: a folha e as telas ficam por baixo dele. Medimos a
  // parte coberta (altura da página − altura visível − deslocamento) e a damos a --teclado (estilos/toque.css: bottom).
  // Pequenas diferenças (barra do Safari) não contam.
  function ajustarTeclado() {
    const vv = window.visualViewport; if (!vv) return;
    const coberto = Math.round(window.innerHeight - vv.height - vv.offsetTop);
    const v = coberto > 80 ? coberto + "px" : "0px";
    const raiz = document.documentElement.style;
    if (raiz.getPropertyValue("--teclado") !== v) {
      raiz.setProperty("--teclado", v);
      C.emit("teclado", { px: coberto > 80 ? coberto : 0 });
      const f = document.activeElement;
      if (coberto > 80 && f && f.matches && f.matches("input, select, textarea")) trazerAVista(f);
    }
  }
  function trazerAVista(campo) {
    setTimeout(() => {
      if (document.activeElement !== campo || !campo.isConnected) return;
      try { campo.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { /* sem suporte */ }
    }, 120);
  }
  function ligarTeclado() {
    const vv = window.visualViewport;
    if (vv) { vv.addEventListener("resize", ajustarTeclado); vv.addEventListener("scroll", ajustarTeclado); }
    window.addEventListener("resize", ajustarTeclado);
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (t && t.matches && t.matches("input, select, textarea") && t.closest && t.closest(".folha, .tela")) trazerAVista(t);
    });
    ajustarTeclado();
  }

  // ------------------------------------------------------------ atribuição do mapa fechada ao navegar
  function fecharAtribuicao() {
    const a = document.querySelector(".maplibregl-ctrl-attrib"); if (!a) return;
    a.classList.remove("maplibregl-compact-show"); a.removeAttribute("open");
  }
  function atribuicaoNaNavegacao() {
    const app = $("app"); let tinha = false, tocou = false;
    // o motorista abriu a atribuição de propósito (botão "i"): não fechamos de novo por cima dele
    document.addEventListener("click", (e) => { if (e.target && e.target.closest && e.target.closest(".maplibregl-ctrl-attrib-button")) tocou = true; }, true);
    const fechar = () => { if (!tocou && app.classList.contains("nav-ativa")) fecharAtribuicao(); };
    const ver = () => {
      const nav = app.classList.contains("nav-ativa");
      if (nav && !tinha) { tocou = false; fecharAtribuicao(); setTimeout(fechar, 300); }
      tinha = nav;
    };
    new MutationObserver(ver).observe(app, { attributes: true, attributeFilter: ["class"] });
    ver();
  }

  // ------------------------------------------------------------ "Depois: Destino" (sem informação)
  function esconderDepoisDestino() {
    const e = $("nav-seguinte"); if (!e) return;
    const ajustar = () => { if (/^Depois:\s*(Destino|Você chegou.*|Chegada)\.?$/i.test(e.textContent.trim()) && !e.hidden) e.hidden = true; };
    new MutationObserver(ajustar).observe(e, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    ajustar();
  }

  // ------------------------------------------------------------ tela "Voz"
  // Lote 2: a Voz é uma aba própria (#tela-voz, ui/voztela.js); só o diagnóstico do microfone continua na tela Conta.
  function abrirVoz(alvo) {
    const conta = alvo === "cmd-diag";
    C.abas.irPara(conta ? "conta" : "voz");
    const t = $(conta ? "tela-conta" : "tela-voz"); if (t) t.scrollTop = 0;
    const e = alvo && $(alvo);
    if (e && e.scrollIntoView) setTimeout(() => { try { e.scrollIntoView({ block: "start" }); } catch (x) { /* ignora */ } }, 0);
  }
  function rotuloMaosLivres() {
    const b = $("ml-alternar"); if (!b) return;
    const ligado = !!(C.comandos && C.comandos.maosLivres && C.comandos.maosLivres.ligado());
    b.textContent = ligado ? "Desligar mãos-livres" : "Ligar mãos-livres: dizer “Copiloto”";
    b.setAttribute("aria-pressed", String(ligado));
  }
  function montarVoz() {
    const tela = $("tela-conta"); if (!tela) return;
    const cartao = el("div", "cartao"); cartao.id = "cartao-maos-livres"; cartao.hidden = !(C.comandos && C.comandos.maosLivres);
    const alternar = botao("", "btn btn-principal", () => {
      const ml = C.comandos && C.comandos.maosLivres; if (!ml) return;
      if (ml.ligado()) ml.desligar(); else ml.ligar();
      rotuloMaosLivres(); setTimeout(rotuloMaosLivres, 400);
    });
    alternar.id = "ml-alternar"; alternar.dataset.semDestravar = "";
    cartao.append(el("h2", null, "Mãos-livres"),
      el("p", "dica", "Com o app aberto e na tela, o microfone fica ouvindo e só age quando a frase começa com “Copiloto” (ex.: “Copiloto, me leva para Goiânia”)."),
      alternar);
    const voz = $("cartao-voz");
    if (voz) voz.after(cartao); else tela.appendChild(cartao); // ui/voztela.js leva os dois para a aba Voz
    rotuloMaosLivres();
    C.on("aba", (id) => { if (id === "voz" || id === "conta") rotuloMaosLivres(); });
    const menuDiag = $("cfg-diagnostico");
    if (menuDiag) menuDiag.addEventListener("click", () => abrirVoz("cmd-diag"));
  }

  // ------------------------------------------------------------ pedidos de rota: Cancelar
  // Todo pedido que passa por Copiloto.rota.calcular ganha um AbortController; cancelarPedidos() aborta os que estão no ar
  // (quem pediu recebe o erro "cancelada" e não desenha nada: ver ui/rota.js e ui/navegacao.js).
  const emVoo = new Set();
  function envolverCalcular() {
    const R = C.rota; if (!R || typeof R.calcular !== "function" || R.__toque) return;
    const original = R.calcular;
    R.calcular = function (o) {
      const ctl = new AbortController(); emVoo.add(ctl);
      const de = o && o.sinal;
      if (de) { if (de.aborted) ctl.abort(); else de.addEventListener("abort", () => ctl.abort()); }
      const p = original.call(R, Object.assign({}, o, { sinal: ctl.signal }));
      const fim = () => emVoo.delete(ctl);
      p.then(fim, fim);
      return p;
    };
    R.cancelarPedidos = () => { for (const c of Array.from(emVoo)) c.abort(); emVoo.clear(); };
    R.__toque = true;
  }
  function cancelarPreparo() {
    if (C.rota && C.rota.cancelarPedidos) C.rota.cancelarPedidos();
    if (!(C.rota && C.rota.reabrirFolha && C.rota.reabrirFolha())) C.folha.fechar();
  }
  function vigiarFolha() {
    const f = $("folha"); if (!f) return;
    const ver = () => {
      const h = f.querySelector("h2");
      if (!h || f.hidden || !/^Preparando a navegação/.test(h.textContent) || $("nav-preparando-cancelar")) return;
      const b = botao("Cancelar", "btn btn-grande btn-cancelar-pedido", cancelarPreparo); b.id = "nav-preparando-cancelar";
      f.appendChild(b);
    };
    new MutationObserver(ver).observe(f, { childList: true });
  }

  C.toque = { abrirVoz, ajustarTeclado };

  C.aoIniciar(() => {
    ligarSOS();
    ligarTeclado();
    envolverCalcular();
    vigiarFolha();
  });
  C.on("pronto", () => {
    montarVoz();
    esconderDepoisDestino();
    atribuicaoNaNavegacao();
  });
})(window.Copiloto);
