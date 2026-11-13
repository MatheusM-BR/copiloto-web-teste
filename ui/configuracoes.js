// Configurações (redesenho): engrenagem sempre à vista (tela inicial: ao lado da busca; navegando: na faixa da manobra) e a
// tela com Tema, Tipo de mapa e o menu (Veículo, Voz, Fachada na chegada, Manter a tela ligada, Privacidade, Diagnóstico de
// voz, Conta, as telas dos pacotes e, por último, Emergência/SOS). As telas antigas (Veículo, Conta, Emergência…) continuam
// existindo; o acesso é por este menu (o <nav> fica dentro da tela de Configurações), não por uma barra de abas.
// "#nav-mapa" (‹ Mapa) volta ao mapa de qualquer tela.
// Expõe Copiloto.configuracoes: abrir(), irPara(idDaTela, idDoCartao?) (abre a tela e rola até o cartão).
(function (C) {
  "use strict";
  const { $ } = C.util;
  const ROTULO_TEMA = { claro: "Claro", escuro: "Escuro", auto: "Automático" };

  function desenhar() {
    const T = C.tema;
    if (!T) return;
    const escolha = T.escolha(), ef = T.efetivo();
    for (const b of document.querySelectorAll("#tela-config [data-tema]")) b.setAttribute("aria-checked", String(b.dataset.tema === escolha));
    $("cfg-tema-dica").textContent = escolha === "auto"
      ? "Automático: claro das 6 h às 18 h, escuro à noite. Agora: " + ROTULO_TEMA[ef].toLowerCase() + "." : "";
    const tipo = T.tipoMapa();
    for (const b of document.querySelectorAll("#tela-config [data-tipo]")) b.setAttribute("aria-checked", String(b.dataset.tipo === tipo));
    const orient = typeof C.orientacao === "function" ? C.orientacao() : "auto";
    for (const b of document.querySelectorAll("#tela-config [data-orient]")) b.setAttribute("aria-checked", String(b.dataset.orient === orient));
    const fach = T.fachada();
    $("cfg-fachada").setAttribute("aria-checked", String(fach));
    $("cfg-fachada-valor").textContent = fach ? "Ligada" : "Desligada";
    const cam = C.cameraManobra ? C.cameraManobra.config().ligado : true;
    $("cfg-camera").setAttribute("aria-checked", String(cam));
    $("cfg-camera-valor").textContent = cam ? "Ligado" : "Desligado";
    try {
      const p = C.voz && C.voz.preferencias ? C.voz.preferencias() : null;
      const perfis = window.CopilotoVoz && window.CopilotoVoz.PERFIS;
      $("cfg-voz-valor").textContent = !p ? "" : !p.ligada ? "Desligada" : (perfis && perfis[p.perfil] ? perfis[p.perfil].rotulo : "Ligada") + (p.modo === "alertas" ? " · Só alertas" : "");
    } catch (e) { /* sem voz */ }
    let conta = "Entrar";
    try { if (C.nuvem.logado()) { const u = C.nuvem.usuario(); conta = (u && u.email) || "Conectado"; } } catch (e) { /* ignora */ }
    $("cfg-conta-valor").textContent = conta;
  }

  // abre outra tela e rola até um cartão dela (Voz, Privacidade e Diagnóstico ficam na tela Conta)
  function irPara(id, alvo) {
    C.abas.irPara(id);
    if (!alvo) return;
    const e = $(alvo);
    if (e && e.scrollIntoView) setTimeout(() => { try { e.scrollIntoView({ block: "start" }); } catch (x) { /* ignora */ } }, 0);
  }

  // Navegando, a engrenagem vai para a faixa da manobra (sempre à vista, sem disputar lugar com a faixa do alerta);
  // fora da navegação volta para o lado da busca.
  function posicionarEngrenagem() {
    const g = $("btn-config"); if (!g) return;
    const ativa = !!(C.navegacao && C.navegacao.ativa && C.navegacao.ativa());
    const faixa = document.querySelector("#nav-painel .nav-manobra");
    const destino = ativa && faixa ? faixa : $("barra-topo");
    if (destino && g.parentNode !== destino) destino.appendChild(g);
  }

  // "!" no pé da coluna (por último), "Falar" logo acima — como no desenho
  function arrumarColuna() {
    const acoes = document.querySelector(".acoes"), r = $("btn-reportar");
    if (acoes && r && acoes.lastElementChild !== r) acoes.appendChild(r);
  }

  // r6: símbolo antes de cada item do menu e nos botões de tema/mapa (o texto continua; só reforça)
  const ICONES_MENU = { "nav-veiculo": "caminhao", "cfg-voz": "voz_tudo", "cfg-fachada": "predio", "btn-tela": "celular", "cfg-privacidade": "escudo",
    "cfg-diagnostico": "pulso", "nav-conta": "pessoa" };
  const ICONES_SEG = { "cfg-tema-claro": "sol", "cfg-tema-escuro": "lua", "cfg-tema-auto": "tema_auto", "cfg-mapa-ruas": "mapa", "cfg-mapa-predios": "predio",
    "cfg-orient-auto": "tema_auto", "cfg-orient-rumo": "ir", "cfg-orient-norte": "bandeira" };
  function simbolos() {
    const I = window.CopilotoIcones; if (!I) return;
    for (const [id, nome] of Object.entries(ICONES_MENU)) { const b = $(id), it = b && b.querySelector(".cfg-item"); if (it) I.prefixar(it, nome); }
    for (const [id, nome] of Object.entries(ICONES_SEG)) { const b = $(id); if (b) I.prefixar(b, nome); }
  }

  // Pacote F (item 17): as linhas de liga/desliga ganham um interruptor de verdade (trilho 52 × 32 px num alvo de 56 × 48 px; a linha toda,
  // 64 px, responde ao toque). O texto "Ligado/Desligado" fica só para o leitor de tela (estilos/conta.css, ".tg"). Os grupos do menu
  // continuam os de antes (Rota, Veículo e voz, Tela e mapa, Privacidade e conta): reagrupar por Navegação/Rota pesada/Voz/Memória mexe
  // no index.html e nos testes de ordem do menu.
  const INTERRUPTORES = ["cfg-camera", "cfg-fachada", "btn-tela"];
  function interruptores() {
    for (const id of INTERRUPTORES) {
      const b = $(id);
      if (!b || b.querySelector(":scope > .tg")) continue;
      const tg = document.createElement("span"); tg.className = "tg"; tg.setAttribute("aria-hidden", "true");
      b.appendChild(tg);
    }
  }

  C.configuracoes = { abrir: () => C.abas.irPara("config"), irPara };

  C.aoIniciar(() => {
    simbolos();
    interruptores();
    C.abas.registrar({ id: "config", rotulo: "Configurações", tela: $("tela-config"), botao: $("btn-config"), aoAbrir: desenhar });
    for (const b of document.querySelectorAll("#tela-config [data-tema]")) b.addEventListener("click", () => { C.tema.escolha(b.dataset.tema); desenhar(); });
    for (const b of document.querySelectorAll("#tela-config [data-tipo]")) b.addEventListener("click", () => { C.tema.tipoMapa(b.dataset.tipo); desenhar(); });
    // orientação do mapa (equipe D): a mesma escolha do botão #btn-orientacao (que só aparece navegando)
    for (const b of document.querySelectorAll("#tela-config [data-orient]")) b.addEventListener("click", () => { if (C.orientacao) C.orientacao(b.dataset.orient); desenhar(); });
    C.on("orientacao", () => { if (C.abas.atual() === "config") desenhar(); });
    $("cfg-fachada").addEventListener("click", () => { C.tema.fachada(!C.tema.fachada()); desenhar(); });
    // rodada 6: a câmera aproxima e inclina quando falta pouco para a manobra (ui/mapa.js)
    $("cfg-camera").addEventListener("click", () => { if (C.cameraManobra) C.cameraManobra.definir({ ligado: !C.cameraManobra.config().ligado }); desenhar(); });
    for (const b of document.querySelectorAll("#tela-config [data-ir]")) b.addEventListener("click", () => irPara(b.dataset.ir, b.dataset.alvo));
    // "‹ Mapa": só nas telas
    C.on("aba", (id) => { $("nav-mapa").hidden = id === "mapa"; });
    C.on("tema", () => { if (C.abas.atual() === "config") desenhar(); });
    C.on("sessao", () => { if (C.abas.atual() === "config") desenhar(); });
    C.on("navegacao", posicionarEngrenagem);
    // a navegação liga a classe nav-ativa no #app antes do primeiro evento "navegacao" (sem GPS ainda): segue a classe
    new MutationObserver(posicionarEngrenagem).observe($("app"), { attributes: true, attributeFilter: ["class"] });
    C.on("pronto", () => { arrumarColuna(); posicionarEngrenagem(); });
  });
})(window.Copiloto);
