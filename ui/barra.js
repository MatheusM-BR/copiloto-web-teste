// Barra de 4 abas (lote 2 do redesenho, Stitch): Mapa, Veículo, Voz, Conta, fixa EMBAIXO (#barra-abas, filha do #app, fora do <main>:
// o mapa e tudo que fica posicionado dentro dele já terminam acima da barra, sem conta de altura).
//  - Visível: tela inicial (mapa), planejamento da rota (folha de decisão aberta) e telas Veículo, Voz, Conta e Configurações.
//  - Escondida: navegando, alerta crítico ("Você não passa"), Busca, Emergência/SOS, telas dos pacotes, consentimento, teclado
//    aberto e folhas de tarefa (toque no mapa, relato, postos, carregado/vazio…).
//  - A barra só chama os mesmos caminhos de antes (Copiloto.abas.irPara): #nav-veiculo, #nav-conta, #cfg-voz, #nav-mapa continuam
//    existindo e funcionando no menu de Configurações.
// Também monta o que a tela inicial ganhou (P1.1): cartão do veículo ativo acima da busca (#mapa-veiculo, "Ajustar" → aba Veículo) e
// os atalhos Casa / Base / Recente (#mapa-atalhos, ≥ 64 px, acima da barra). Nada de dado inventado: sem veículo, o cartão pede o
// cadastro; sem Casa/Base/Recente salvos, o atalho diz isso.
// Classes no #app: com-barra, com-atalhos, com-veiculo (usadas em estilos/barra.css). Expõe Copiloto.barra = { visivel(), atualizar() }.
(function (C) {
  "use strict";
  const { $, el } = C.util;
  const ICONES = { mapa: "mapa", veiculo: "caminhao", voz: "voz_tudo", conta: "pessoa" };
  const ABAS_COM_BARRA = ["mapa", "config", "veiculo", "voz", "conta"];
  let tecladoAberto = false, pedido = false;

  const navegando = () => !!(C.navegacao && C.navegacao.ativa && C.navegacao.ativa());
  function folhaPermite() {
    const f = $("folha");
    return !f || f.hidden || f.dataset.decisao === "1"; // só a folha de planejamento (destino/rota) convive com a barra
  }
  function criticoAberto() { const a = $("aviso-dado"); return !!(a && !a.hidden && a.classList.contains("critico")); }
  function consentimentoAberto() { return !!$("e5-consentimento"); }

  function deveMostrarBarra() {
    return ABAS_COM_BARRA.indexOf(C.abas.atual()) >= 0 && !navegando() && !criticoAberto() && !consentimentoAberto() && !tecladoAberto && folhaPermite();
  }
  // tela inicial limpa: mapa sem navegação, sem folha e sem rota ou destino
  function inicioLimpo() {
    const f = $("folha");
    return C.abas.atual() === "mapa" && !navegando() && !consentimentoAberto() && !(f && !f.hidden) && !(C.rota && C.rota.destino && C.rota.destino());
  }

  function atualizar() {
    const app = $("app"), barra = $("barra-abas");
    if (!app || !barra) return;
    const mostrar = deveMostrarBarra();
    if (barra.hidden === mostrar) barra.hidden = !mostrar;
    const limpo = inicioLimpo();
    app.classList.toggle("com-barra", mostrar);
    app.classList.toggle("com-atalhos", limpo);
    app.classList.toggle("com-veiculo", limpo);
    const atual = C.abas.atual();
    for (const b of barra.querySelectorAll(".barra-aba")) {
      const ativa = b.dataset.aba === atual;
      b.setAttribute("aria-current", ativa ? "page" : "false");
      b.classList.toggle("ativa", ativa);
    }
    if (limpo) { desenharVeiculo(); desenharAtalhos(); }
  }
  function agendar() {
    if (pedido) return;
    pedido = true;
    requestAnimationFrame(() => { pedido = false; atualizar(); });
  }

  // ------------------------------------------------------------ cartão do veículo (acima da busca)
  const fmtM = (v) => String(v).replace(".", ",") + " m";
  function desenharVeiculo() {
    const c = $("mapa-veiculo"); if (!c) return;
    const v = C.veiculos && C.veiculos.ativo ? C.veiculos.ativo() : null;
    c.querySelector(".mapa-veiculo-nome").textContent = v ? v.nome : "Nenhum veículo ativo";
    const det = [];
    if (v) {
      if (v.altura != null) det.push("Altura " + fmtM(v.altura));
      if (v.pbtc != null) det.push("PBTC " + String(v.pbtc).replace(".", ",") + " t");
      if (!det.length) det.push(v.tipo);
    } else det.push("Cadastre para a rota respeitar o seu caminhão");
    c.querySelector(".mapa-veiculo-dados").textContent = det.join(" · ");
    c.querySelector(".mapa-veiculo-ajustar > span").textContent = v ? "Ajustar" : "Cadastrar";
  }
  function montarVeiculo() {
    const topo = $("barra-topo"); if (!topo || $("mapa-veiculo")) return;
    const c = el("div", "mapa-veiculo"); c.id = "mapa-veiculo";
    const ic = el("span", "mapa-veiculo-icone"); ic.setAttribute("aria-hidden", "true");
    if (window.CopilotoIcones) ic.append(window.CopilotoIcones.no("caminhao"));
    const txt = el("span", "mapa-veiculo-texto");
    txt.append(el("span", "mapa-veiculo-nome", ""), el("span", "mapa-veiculo-dados", ""));
    const aj = el("button", "mapa-veiculo-ajustar"); aj.type = "button"; aj.id = "mapa-veiculo-ajustar";
    aj.setAttribute("aria-label", "Ajustar o veículo ativo (abre a aba Veículo)");
    aj.append(el("span", null, "Ajustar"));
    aj.addEventListener("click", () => C.abas.irPara("veiculo"));
    c.append(ic, txt, aj);
    topo.insertBefore(c, topo.firstChild);
  }

  // ------------------------------------------------------------ atalhos Casa / Base / Recente
  const lugar = (tipo) => (C.lugares && C.lugares.lista ? C.lugares.lista().find((l) => l.tipo === tipo) : null) || null;
  function recente() { try { const r = C.navegacao && C.navegacao.recentes ? C.navegacao.recentes() : []; return r && r[0] ? r[0] : null; } catch (e) { return null; } }
  function desenharAtalhos() {
    const caixa = $("mapa-atalhos"); if (!caixa) return;
    for (const tipo of ["casa", "base"]) {
      const l = lugar(tipo), b = $("atalho-" + tipo);
      b.querySelector(".atalho-sub").textContent = l ? (l.rotulo || l.nome || "Salvo") : "Não salvo";
      b.setAttribute("aria-label", (tipo === "casa" ? "Casa" : "Base") + (l ? ": ir para " + (l.rotulo || l.nome) : ": ainda não salva"));
    }
    const r = recente(), br = $("atalho-recente");
    br.querySelector(".atalho-sub").textContent = r ? (r.rotulo || "Sem nome") : "Nenhum ainda";
    br.setAttribute("aria-label", r ? "Destino recente: " + (r.rotulo || "sem nome") : "Destinos recentes: nenhum ainda");
  }
  function explicarLugar(tipo) {
    const nome = tipo === "casa" ? "casa" : "base";
    C.folha.abrir([el("h2", null, "Falta salvar a " + nome),
      el("p", null, "Toque no mapa no lugar da " + nome + " e escolha \"Salvar lugar\"."),
      C.util.botao("Entendi", "btn btn-grande", C.folha.fechar)]);
  }
  function montarAtalhos() {
    const painel = $("painel-mapa"); if (!painel || $("mapa-atalhos")) return;
    const caixa = el("div", "mapa-atalhos"); caixa.id = "mapa-atalhos"; caixa.setAttribute("role", "group"); caixa.setAttribute("aria-label", "Atalhos de destino");
    const um = (id, icone, rotulo, aoTocar) => {
      const b = el("button", "atalho"); b.type = "button"; b.id = id;
      const i = el("span", "atalho-icone"); i.setAttribute("aria-hidden", "true"); if (window.CopilotoIcones) i.append(window.CopilotoIcones.no(icone));
      b.append(i, el("span", "atalho-nome", rotulo), el("span", "atalho-sub", ""));
      b.addEventListener("click", aoTocar);
      caixa.append(b);
    };
    um("atalho-casa", "casa", "Casa", () => { if (lugar("casa") && C.lugares.irPara) C.lugares.irPara("casa"); else explicarLugar("casa"); });
    um("atalho-base", "base", "Base", () => { if (lugar("base") && C.lugares.irPara) C.lugares.irPara("base"); else explicarLugar("base"); });
    um("atalho-recente", "relogio", "Recente", () => {
      const r = recente();
      if (r && C.busca && C.busca.irPara) C.busca.irPara(r); else C.abas.irPara("busca");
    });
    painel.appendChild(caixa);
  }

  // ------------------------------------------------------------ barra
  function montarBarra() {
    const barra = $("barra-abas"); if (!barra) return;
    for (const b of barra.querySelectorAll(".barra-aba")) {
      const i = b.querySelector(".barra-aba-icone");
      if (i && window.CopilotoIcones) i.append(window.CopilotoIcones.no(ICONES[b.dataset.aba]));
      b.addEventListener("click", () => C.abas.irPara(b.dataset.aba));
    }
  }

  C.barra = { visivel: () => { const b = $("barra-abas"); return !!b && !b.hidden; }, atualizar };

  C.aoIniciar(() => {
    montarBarra(); montarVeiculo(); montarAtalhos();
    for (const ev of ["aba", "folha", "navegacao", "rota", "rota-limpa", "destino", "veiculo", "lugares", "alerta", "alerta-fechado", "pronto"]) C.on(ev, agendar);
    C.on("teclado", (d) => { tecladoAberto = !!(d && d.px > 0); agendar(); });
    const mo = new MutationObserver(agendar);
    const app = $("app"); if (app) { mo.observe(app, { attributes: true, attributeFilter: ["class"] }); mo.observe(app, { childList: true }); }
    const f = $("folha"); if (f) mo.observe(f, { attributes: true, attributeFilter: ["hidden", "data-decisao"] });
    const ad = $("aviso-dado"); if (ad) mo.observe(ad, { attributes: true, attributeFilter: ["hidden", "class"] });
    // altura do velocímetro (cresce com a placa do limite): o SOS fica logo acima dele
    const vel = document.querySelector(".painel-mapa > .velocidade");
    if (vel && typeof ResizeObserver === "function") new ResizeObserver(() => { const h = Math.round(vel.getBoundingClientRect().height); if (h) $("app").style.setProperty("--vel-h", h + "px"); }).observe(vel);
    atualizar();
  });
})(window.Copiloto);
