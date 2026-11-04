// Relatos: botão "!" com o formulário de relato (com "SOS · Emergência" pequeno no pé; abrirFormulario({ toque, aqui }) relata
// num ponto tocado no mapa, ui/busca.js) e os relatos locais (copiloto.relatos.v1, quando fora da conta).
// Logado e com permissão de envio (consentimento "enviar"), o relato segue para Copiloto.comunidade.enviar();
// sem a permissão, fica só no aparelho e o motorista é avisado (PRI-01). Expõe Copiloto.relatos.abrirFormulario({ toque? }), locais() e
// leituraDoToque() (posição, rumo, velocidade e precisão de agora; null sem GPS).
// Emite "relatos-locais" (lista ativa) quando a lista local muda.
// A3: o tipo se escolhe numa grade de botões grandes (#r-grade, um botão [data-tipo] por tipo); #r-tipo (select escondido)
// guarda o tipo escolhido para os comandos de voz. M2: o relato vai no ponto do toque no "!" (com rumo/velocidade/precisão
// de lá); passados 5 s, o formulário avisa "Relato no ponto de há X s".
(function (C) {
  "use strict";
  const { $, el, botao, novoId, lerJSON, gravarJSON } = C.util;
  const Relatos = window.CopilotoRelatos, Consent = window.CopilotoConsentimento;
  const podeEnviar = () => Consent.permite(Consent.ler(C.util.storage()), "enviar");
  const CHAVE_REL = "copiloto.relatos.v1";
  let relatos = [];
  const marcas = new Map();

  function carregar() { const o = lerJSON(CHAVE_REL, []); relatos = Array.isArray(o) ? o : []; }
  function gravar() { gravarJSON(CHAVE_REL, relatos); }

  function desenhar() {
    const agora = Date.now();
    relatos = Relatos.ativos(relatos, agora);
    const vivos = new Set(relatos.map((r) => r.id));
    for (const [id, m] of marcas) if (!vivos.has(id)) { m.remove(); marcas.delete(id); }
    for (const r of relatos) {
      if (marcas.has(r.id)) continue;
      const cfg = Relatos.TIPOS[r.tipo];
      const marca = el("div", "relato-marca" + (cfg.valor ? "" : " transitorio"), cfg.sigla + (r.valor == null ? "" : " " + String(r.valor).replace(".", ",")));
      const pop = el("div", "popup-relato");
      pop.append(el("b", null, Relatos.titulo(r)), el("small", null, Relatos.descricao(r, agora)),
        botao("Excluir relato", "", () => { relatos = relatos.filter((x) => x.id !== r.id); gravar(); desenhar(); }));
      const m = new maplibregl.Marker({ element: marca }).setLngLat([r.lon, r.lat]).setPopup(new maplibregl.Popup({ offset: 14 }).setDOMContent(pop)).addTo(C.mapa);
      marcas.set(r.id, m);
    }
    C.emit("relatos-locais", relatos.slice());
  }

  // M2: leitura do GPS no toque do "!". O relato vai neste ponto (com rumo, velocidade e precisão daqui),
  // mesmo que o motorista leve alguns segundos para escolher o tipo e tocar em "Salvar".
  function leituraDoToque() {
    const g = C.estado.gps, pos = C.estado.ultimaPos;
    const lat = g && isFinite(g.lat) ? g.lat : pos[1], lon = g && isFinite(g.lon) ? g.lon : pos[0];
    return { lat, lon, rumo: g ? g.rumo : null, velKmh: g ? g.velKmh : null, precisao: g ? g.precisao : null, t: Date.now() };
  }

  // A3: grade de botões grandes (um por tipo) no lugar da lista. #r-tipo continua existindo (select escondido com o
  // tipo escolhido e o evento "change"): os comandos de voz (ui/comandos.js) preenchem o formulário por ele.
  // opcoes.toque (M3 do QA2): leitura já guardada antes (o toque em "Falar" dos comandos de voz); sem ela, a de agora.
  function abrirFormulario(opcoes) {
    const pos = C.estado.ultimaPos;
    const dado = opcoes && opcoes.toque && isFinite(opcoes.toque.lat) ? opcoes.toque : null;
    if (!pos && !dado) { C.mensagem("Ative o GPS para reportar neste ponto.", 6000); return; }
    C.rota.pedirDestino(false);
    const toque = dado || leituraDoToque();
    const sel = el("select"); sel.id = "r-tipo"; sel.hidden = true; sel.setAttribute("aria-hidden", "true"); sel.tabIndex = -1;
    sel.add(new Option("", ""));
    const grade = el("div", "r-grade"); grade.id = "r-grade"; grade.setAttribute("role", "radiogroup"); grade.setAttribute("aria-label", "O que você viu?");
    const botoesTipo = new Map();
    for (const [id, cfg] of Object.entries(Relatos.TIPOS)) {
      sel.add(new Option(cfg.rotulo, id));
      const b = el("button", "r-tipo-btn" + (cfg.risco ? " risco" : ""));
      b.type = "button"; b.dataset.tipo = id; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false");
      b.setAttribute("aria-label", cfg.rotulo);
      b.append(el("span", "r-nome", cfg.curto || cfg.rotulo)); // só o nome: a sigla repetia o nome
      b.addEventListener("click", () => {
        sel.value = id; sel.dispatchEvent(new Event("change"));
        if (cfg.valor) { pararContagem(); inp.focus(); } else iniciarContagem(cfg);
      });
      grade.appendChild(b);
      botoesTipo.set(id, b);
    }
    sel.value = "";
    const inp = el("input"); inp.id = "r-valor"; inp.type = "text"; inp.autocomplete = "off";
    inp.setAttribute("inputmode", "decimal"); inp.setAttribute("enterkeyhint", "done"); inp.setAttribute("pattern", "[0-9]*[,.]?[0-9]*");
    const rotValor = el("label", "r-valor-rotulo", ""); const spanRot = el("span", null, "");
    rotValor.append(spanRot, inp);
    const erro = el("p", "erro r-erro"); erro.setAttribute("role", "alert");
    const rotTipo = el("p", "r-pergunta", "O que você viu?");
    const idade = el("p", "r-idade"); idade.id = "r-idade"; idade.hidden = true;
    function ajustar() {
      const cfg = Relatos.TIPOS[sel.value];
      for (const [id, b] of botoesTipo) { const v = id === sel.value; b.classList.toggle("escolhido", v); b.setAttribute("aria-checked", v ? "true" : "false"); }
      rotValor.hidden = !(cfg && cfg.valor);
      if (cfg && cfg.valor) { spanRot.textContent = cfg.valor.rotulo; inp.placeholder = cfg.valor.unidade === "m" ? "4,30" : "30"; }
      erro.textContent = ""; inp.removeAttribute("aria-invalid");
    }
    sel.addEventListener("change", ajustar); ajustar();
    function mostrarIdade() {
      if (!idade.isConnected) { clearInterval(relogio); return; }
      const t = Relatos.textoIdadePosicao(Date.now() - toque.t);
      idade.textContent = t; idade.hidden = !t;
    }
    const relogio = setInterval(mostrarIdade, 1000);
    const logado = C.nuvem.logado(), envia = podeEnviar();
    // Rodapé fixo da folha (estilos/toque.css): contagem, erro e os botões grandes ficam sempre à vista, mesmo com a
    // folha rolada e com o teclado aberto. Tipo SEM valor: 2 toques (abrir o "!" e escolher o tipo); o relato sai sozinho
    // em 4 s, com a contagem visível e "Cancelar" grande. Tipo COM valor: abre o campo numérico e "Salvar relato" fica
    // acima do teclado.
    const rodape = el("div", "folha-rodape r-rodape");
    const contagem = el("p", "r-contagem"); contagem.id = "r-contagem"; contagem.setAttribute("role", "status"); contagem.hidden = true;
    const botoes = el("div", "r-botoes");
    const ESPERA_S = 4;
    let timerContagem = null, restante = 0, tipoContagem = null;
    function pararContagem() {
      clearInterval(timerContagem); timerContagem = null; tipoContagem = null;
      contagem.hidden = true; contagem.textContent = "";
      cancelar.textContent = "Cancelar"; cancelar.classList.remove("contando");
    }
    function mostrarContagem() {
      contagem.hidden = false;
      contagem.textContent = "Enviando “" + (Relatos.TIPOS[tipoContagem].curto || Relatos.TIPOS[tipoContagem].rotulo) + "” em " + restante + " s";
      cancelar.textContent = "Cancelar (" + restante + " s)";
    }
    function iniciarContagem(cfg) {
      pararContagem();
      tipoContagem = sel.value; restante = ESPERA_S; cancelar.classList.add("contando"); mostrarContagem();
      timerContagem = setInterval(() => {
        if (!rodape.isConnected) { pararContagem(); return; }
        restante--;
        if (restante <= 0) { const t = tipoContagem; pararContagem(); if (sel.value === t) salvar.click(); return; }
        mostrarContagem();
      }, 1000);
    }
    const salvar = botao("Salvar relato", "btn btn-principal btn-grande", () => {
      pararContagem();
      if (!sel.value) { erro.textContent = "Toque no tipo do relato."; return; }
      const r = Relatos.criarRelato(sel.value, { lat: toque.lat, lon: toque.lon, rumo: toque.rumo }, inp.value, Date.now(), novoId());
      if (!r.ok) { erro.textContent = r.erro; inp.setAttribute("aria-invalid", "true"); return; }
      clearInterval(relogio);
      const aviso = Relatos.textoIdadePosicao(Date.now() - toque.t);
      if (C.nuvem.logado() && podeEnviar()) {
        if (aviso) C.mensagem(aviso, 5000);
        C.comunidade.enviar(Object.assign({}, r.relato, { gpsToque: toque }));
        return;
      }
      relatos.push(r.relato); gravar(); desenhar(); C.folha.fechar();
      C.mensagem((C.nuvem.logado() ? "Relato salvo só neste aparelho: o envio está desligado nas suas escolhas de privacidade (Configurações → Privacidade)."
        : "Relato salvo só neste aparelho. Entre para compartilhar com outros motoristas.") + (aviso ? " " + aviso : ""), 6000);
    });
    salvar.id = "r-salvar";
    const cancelar = botao("Cancelar", "btn btn-grande", () => {
      if (timerContagem) { // cancela o envio automático e volta à escolha do tipo
        pararContagem(); sel.value = ""; sel.dispatchEvent(new Event("change")); return;
      }
      clearInterval(relogio); C.folha.fechar();
    }); cancelar.id = "r-cancelar";
    // mudar o campo do valor ou o tipo por outro caminho (voz) nunca deixa um envio automático pendente
    sel.addEventListener("change", () => { if (tipoContagem && sel.value !== tipoContagem) pararContagem(); });
    inp.addEventListener("input", pararContagem);
    botoes.append(cancelar, salvar);
    rodape.append(erro, contagem, botoes);
    // SOS no TOPO da folha (fixo): a Emergência a um toque a partir do "!", com alvo de 64 px
    const sos = botao("SOS", "btn r-sos", () => {
      pararContagem(); clearInterval(relogio); C.folha.fechar();
      if (C.privacidade && C.privacidade.abrirEmergencia) C.privacidade.abrirEmergencia();
    });
    sos.id = "r-sos"; sos.setAttribute("aria-label", "SOS: abrir Emergência (191, 192, 193 e sua posição)");
    const topo = el("div", "folha-topo r-topo");
    topo.append(el("h2", null, opcoes && opcoes.aqui ? "Relatar no ponto tocado" : "Reportar neste ponto"), sos);
    const itens = [topo, rotTipo, grade, sel, rotValor, idade];
    if (logado && envia) {
      itens.push(el("p", null, "Vai para outros motoristas. Vence sozinho e ganha força quando outros motoristas confirmarem."));
    } else if (logado) {
      itens.push(el("p", null, "O envio de relatos está desligado nas suas escolhas de privacidade (Configurações → Privacidade). Este relato fica só neste aparelho e vence sozinho."));
    } else {
      itens.push(el("p", null, "Fica salvo só neste aparelho e vence sozinho."));
      const dica = el("p", "dica", "Entre para compartilhar com outros motoristas. ");
      const ir = botao("Entrar na conta", "btn r-ir-conta", () => { pararContagem(); clearInterval(relogio); C.folha.fechar(); C.abas.irPara("conta"); }); ir.id = "btn-ir-conta";
      dica.appendChild(ir);
      itens.push(dica);
    }
    itens.push(rodape);
    C.folha.abrir(itens);
  }

  C.relatos = { abrirFormulario, locais: () => relatos.slice(), leituraDoToque: () => (C.estado.ultimaPos ? leituraDoToque() : null) };

  C.aoIniciar(() => {
    $("btn-reportar").addEventListener("click", abrirFormulario);
    carregar(); desenhar();
    setInterval(desenhar, 60000);
  });
})(window.Copiloto);
