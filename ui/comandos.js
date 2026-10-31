// Comandos de voz (pacote E4): botão "Falar" no mapa, uma frase por toque (o Safari do iPhone não permite escuta
// contínua nem palavra de ativação). Interpretação determinística em comandos.js (sem IA, sem rede própria).
//
// Fluxo: toque → bipe de início → escuta (até 8 s) → bipe de fim → interpreta → executa.
// M3 (QA2): o relato por voz vai no ponto do TOQUE em "Falar" (posição, rumo, velocidade e precisão de lá, como o "!"),
// logado (gpsToque) ou fora da conta (formulário aberto com esse ponto) — não no fim da fala.
//  - relato: mesmo caminho do app. Logado: Copiloto.comunidade.enviar() (candidatos "É este?" e fila offline);
//    se houver candidato, pergunta por voz "Já tem <tipo> a <N> metros. É o mesmo?" e escuta sim/não UMA vez;
//    sem resposta clara em ~6 s a decisão fica na tela (nunca envia sozinho). Deslogado: formulário local do botão "!".
//    Tipo com medida e sem valor dito (ou valor duvidoso): abre o formulário com o tipo escolhido e pede o valor na tela.
//  - confirmação silenciosa (COM-02): bipe "ok" + ✓ no botão; frase só nos perfis Amigável/Bem-humorado.
//  - voto: com alerta aberto, "continua lá" / "não está mais" respondem o alerta (mesmo efeito dos botões).
//  - alerta de segurança tem prioridade: se um alerta abre, a escuta é interrompida e nada fala/bipa por cima.
//
// Eventos emitidos (outros pacotes ouvem). O dado traz atender(): quem tratar o comando chama dado.atender()
// em até 300 ms; senão o Copiloto diz "Ainda não disponível".
//   "comando:proximo-posto"  { origem: "voz", atender }
//   "comando:repetir"        { origem: "voz", atender }  (sem ninguém: repete o alerta aberto, se houver)
//   "comando:cancelar-rota"  { origem: "voz", atender }
//   "comando:mapa-modo"      { modo: "simples" | "completo", origem: "voz", atender }
//   "comando:ouvido"         { textos, resultado }      cada frase interpretada (registro/telemetria)
// Expõe Copiloto.comandos: ouvir() (o mesmo que tocar no botão), executar(textos) (interpreta e executa uma
// transcrição, sem microfone), disponivel(), ouvindo() (true enquanto o reconhecimento de fala está ativo).
// M3 (QA3): as respostas faladas do comando ("Não entendi…", "Anotado!") vão com naoInterromper (não cortam manobra/alerta).
(function (C) {
  "use strict";
  const { $, el, botao, novoId } = C.util;
  const Cmd = window.CopilotoComandos, Relatos = window.CopilotoRelatos, NuvemLib = window.CopilotoNuvem, Voz = window.CopilotoVoz;
  const ESCUTA_MS = 8000, RESPOSTA_MS = 6000, SEM_OUVINTE_MS = 300, SESSAO_RELATO_MS = 60000;
  const ROTULOS = {
    pronto: "Falar um comando de voz",
    ouvindo: "Ouvindo. Toque para cancelar",
    ok: "Comando registrado",
    indisponivel: Cmd.MSG.indisponivel,
  };
  const escuta = Cmd.criarEscuta();
  let btn = null, ouvindo = null, alertaNoToque = null, gpsNoToque = null, ultimaDistAlerta = null, timerOk = null, votoPorVoz = false;
  let sessao = null; // relato por voz em andamento: { tipo, perguntou, escuta, timer }

  // ---------- botão
  function estado(e) {
    if (!btn) return;
    if (!escuta.disponivel()) e = "indisponivel";
    btn.dataset.estado = e;
    btn.setAttribute("aria-label", ROTULOS[e]); btn.title = ROTULOS[e];
    btn.querySelector(".cmd-icone").textContent = e === "ok" ? "✓" : "🎙";
    btn.querySelector(".cmd-rotulo").textContent = e === "ouvindo" ? "Ouvindo" : "Falar";
  }
  function avisar(texto, falar) {
    C.mensagem(texto, 5000);
    // M3 (QA3): resposta do comando é fala não crítica: espera a manobra/alerta acabar em vez de cortar
    if (falar && !C.voz.emAlerta()) C.voz.falar(texto, { naoInterromper: true });
  }

  // ---------- escuta
  function ouvir(ms, fim) {
    const eu = {};
    C.voz.bipe("inicio");
    estado("ouvindo");
    eu.h = escuta.escutar({ maxMs: ms, aoTerminar: (res) => {
      if (ouvindo === eu) ouvindo = null;
      estado("pronto");
      if (res.motivo !== "alerta" && res.motivo !== "cancelado") C.voz.bipe("fim");
      fim(res);
    } });
    ouvindo = eu; // aoTerminar nunca roda antes deste ponto (é sempre assíncrono)
    return { parar: (m) => eu.h && eu.h.parar(m) };
  }
  function pararEscuta(motivo) { if (ouvindo) { const o = ouvindo; ouvindo = null; o.h.parar(motivo); } }

  function tocar() {
    if (!escuta.disponivel()) { C.mensagem(Cmd.MSG.indisponivel + ".", 5000); return; }
    if (ouvindo) { pararEscuta("cancelado"); return; }
    if (sessao && sessao.escuta) { sessao.escuta.parar("cancelado"); return; }
    // o microfone ouviria a fala do alerta: espera ela acabar
    if (C.voz.emAlerta()) { C.mensagem("Espere o alerta terminar e toque de novo.", 4000); return; }
    alertaNoToque = C.alerta.atual();
    // M3 (QA2): o relato por voz vai no ponto do TOQUE em "Falar" (como o "!"), não no fim da fala/reconhecimento
    gpsNoToque = C.relatos.leituraDoToque();
    ouvir(ESCUTA_MS, processar);
  }

  // ---------- interpretação
  function faixas() {
    const f = {};
    for (const t of ["altura_maxima", "limite_peso"]) { const v = Relatos.TIPOS[t] && Relatos.TIPOS[t].valor; if (v) f[t] = { min: v.min, max: v.max }; }
    return f;
  }
  function processar(res) {
    const toque = gpsNoToque; gpsNoToque = null;
    if (res.motivo === "alerta" || res.motivo === "cancelado") return;
    if (res.motivo === "permissao") { avisar("Libere o microfone para este site nos ajustes do Safari para usar o comando de voz."); return; }
    if (!res.textos.length) {
      avisar(res.motivo === "rede" ? "Sem internet para reconhecer a fala. Use os botões da tela." : "Não ouvi nada. Toque em Falar e diga o comando.");
      return;
    }
    executar(res.textos, toque);
  }
  // toque: leitura do GPS no toque em "Falar"; executar() direto (sem microfone) usa a posição de agora
  function executar(textos, toque) {
    const relAlerta = C.alerta.atual() || alertaNoToque;
    alertaNoToque = null;
    const r = Cmd.interpretarAlternativas(textos, { alertaAberto: !!relAlerta, faixas: faixas() });
    C.emit("comando:ouvido", { textos: [].concat(textos), resultado: r });
    switch (r.intencao) {
      case "relatar": return relatar(r.tipo, r, toque);
      case "ambiguo": return escolherTipo(r.candidatos, toque);
      case "votar": return votar(r, relAlerta, toque);
      case "proximo_posto": return comando("comando:proximo-posto", {}, semOuvinte);
      case "repetir": return comando("comando:repetir", {}, repetirSozinho);
      case "cancelar_rota": return comando("comando:cancelar-rota", {}, semOuvinte);
      case "mapa_modo": return comando("comando:mapa-modo", { modo: r.modo }, semOuvinte);
      default: return avisar(Cmd.MSG.naoEntendi, true);
    }
  }

  // ---------- comandos atendidos por outros pacotes
  function comando(evento, dado, semNinguem) {
    const d = Object.assign({ origem: "voz", atendido: false }, dado);
    d.atender = () => { d.atendido = true; };
    C.emit(evento, d);
    setTimeout(() => { if (!d.atendido) semNinguem(); }, SEM_OUVINTE_MS);
  }
  function semOuvinte() { avisar(Cmd.MSG.aindaNao + ".", true); }
  function repetirSozinho() {
    const a = C.alerta.atual();
    if (!a || ultimaDistAlerta == null) { semOuvinte(); return; }
    C.voz.falar(Voz.textoAlerta(NuvemLib.tipoParaApp(a.report_type), a.value_numeric == null ? null : Number(a.value_numeric), ultimaDistAlerta));
  }

  // ---------- relato
  function tipoDisponivel(tipo) {
    return !!(Relatos.TIPOS[tipo] && (!C.nuvem.logado() || NuvemLib.tipoParaServidor(tipo)));
  }
  function botaoSalvar() { return [...$("folha").querySelectorAll("button")].find((b) => b.textContent.trim() === "Salvar relato") || null; }
  // Abre o formulário do botão "!" com o tipo (e o valor) já escolhidos. false se o formulário não tem o tipo.
  function preencherFormulario(tipo, valorTexto, toque) {
    C.relatos.abrirFormulario(toque ? { toque } : undefined);
    const sel = $("r-tipo");
    if (!sel || ![...sel.options].some((o) => o.value === tipo)) return false;
    sel.value = tipo; sel.dispatchEvent(new Event("change"));
    const inp = $("r-valor");
    if (inp && valorTexto != null) inp.value = valorTexto;
    return true;
  }
  // toque: leitura do GPS no toque em "Falar" (M3); sem ela, a de agora. Vai como gpsToque (precisão/rumo/velocidade
  // de lá) na nuvem e como ponto do formulário fora da conta.
  function relatar(tipo, r, toque) {
    if (!tipoDisponivel(tipo)) { avisar(Cmd.MSG.tipoIndisponivel + ".", true); return; }
    if (!C.estado.gps || !C.estado.ultimaPos) { avisar("Ative o GPS para reportar.", true); return; }
    const gps = toque || C.relatos.leituraDoToque();
    const cfg = Relatos.TIPOS[tipo];
    if (cfg.valor && (r.valor == null || !isFinite(r.valor))) {
      // não adivinha a medida: o motorista digita na tela
      if (preencherFormulario(tipo, null, gps)) { const inp = $("r-valor"); if (inp) inp.focus(); }
      avisar(Cmd.textoPedirValor(tipo), true);
      return;
    }
    const valorTexto = cfg.valor ? String(r.valor).replace(".", ",") : "";
    if (C.nuvem.logado()) {
      const c = Relatos.criarRelato(tipo, { lat: gps.lat, lon: gps.lon, rumo: gps.rumo }, valorTexto, Date.now(), novoId());
      if (!c.ok) { preencherFormulario(tipo, valorTexto, gps); avisar(c.erro); return; }
      iniciarSessao(tipo);
      C.comunidade.enviar(Object.assign({}, c.relato, { gpsToque: gps }));
      return;
    }
    // deslogado: o próprio formulário salva no aparelho (mesma validação e mesma lista local), no ponto do toque
    if (!preencherFormulario(tipo, valorTexto, gps)) { C.folha.fechar(); avisar(Cmd.MSG.tipoIndisponivel + ".", true); return; }
    const salvar = botaoSalvar();
    if (!salvar) { avisar("Confira o relato na tela."); return; }
    salvar.click();
    if (C.folha.aberta()) avisar("Confira o relato na tela.");
    else confirmar();
  }
  function escolherTipo(candidatos, toque) {
    const lista = candidatos.filter(tipoDisponivel);
    if (!lista.length) { avisar(Cmd.MSG.tipoIndisponivel + ".", true); return; }
    if (lista.length === 1) { relatar(lista[0], { valor: null }, toque); return; }
    const col = el("div", "coluna-botoes");
    for (const t of lista) {
      const b = botao(Relatos.TIPOS[t].rotulo, "btn btn-grande", () => { C.folha.fechar(); relatar(t, { valor: null }, toque); });
      b.dataset.tipo = t; col.appendChild(b);
    }
    col.appendChild(botao("Cancelar", "btn btn-grande", C.folha.fechar));
    C.folha.abrir([el("h2", "cmd-titulo", "O que você viu?"), col]);
    avisar("Escolha na tela.", true);
  }

  // Confirmação silenciosa: bipe + ✓ no botão; frase só nos perfis que pedem.
  function confirmar() {
    C.voz.bipe("ok");
    estado("ok");
    clearTimeout(timerOk);
    timerOk = setTimeout(() => { if (!ouvindo) estado("pronto"); }, 1800);
    const frase = Cmd.fraseFinal(C.voz.preferencias().perfil);
    if (frase && !C.voz.emAlerta()) C.voz.falar(frase, { naoInterromper: true }); // M3 (QA3): não corta manobra/alerta
  }

  // ---------- "É o mesmo?" (candidato do servidor)
  function iniciarSessao(tipo) {
    encerrarSessao();
    sessao = { tipo, perguntou: false, escuta: null };
    sessao.timer = setTimeout(encerrarSessao, SESSAO_RELATO_MS);
  }
  function encerrarSessao() {
    if (!sessao) return;
    const s = sessao; sessao = null;
    clearTimeout(s.timer);
    if (s.escuta) s.escuta.parar("cancelado");
  }
  function perguntarMesmo(s) {
    const h2 = $("folha").querySelector("h2");
    const m = /a (\d+) m\. É este\?/.exec(h2 ? h2.textContent : "");
    const dist = m ? Number(m[1]) : null;
    const pref = C.voz.preferencias();
    if (!pref.ligada || !C.voz.disponivel() || !escuta.disponivel() || C.voz.emAlerta()) {
      C.mensagem("Já existe um relato parecido aqui. Responda na tela.", 6000);
      return;
    }
    const texto = Cmd.textoPergunta(s.tipo, dist, Voz.distanciaFalada);
    let comecou = false;
    const comecar = () => {
      if (comecou || sessao !== s || !$("btn-e-este")) return;
      comecou = true;
      if (C.voz.emAlerta()) { C.mensagem("Responda na tela: é este ou é outro?", 6000); return; }
      s.escuta = ouvir(RESPOSTA_MS, (res) => { s.escuta = null; responderMesmo(s, res); });
    };
    C.voz.falar(texto, { aoTerminar: comecar });
    setTimeout(comecar, 1500 + 75 * texto.length); // se o aparelho não avisar o fim da fala
  }
  function responderMesmo(s, res) {
    if (sessao !== s || !$("btn-e-este")) return; // já respondeu na tela
    const sn = res.motivo === "ok" ? Cmd.simOuNao(res.textos) : null;
    if (sn === "sim") $("btn-e-este").click();
    else if (sn === "nao") $("btn-e-outro").click();
    else if (sn === "cancelar") { $("btn-e-cancelar").click(); encerrarSessao(); }
    else C.mensagem("Sem resposta clara. Escolha na tela: é este ou é outro?", 7000);
  }
  function aoMudarFolha() {
    const s = sessao;
    if (!s) return;
    const temEste = !!$("btn-e-este");
    if (temEste && !s.perguntou) { s.perguntou = true; perguntarMesmo(s); return; }
    if (!temEste && s.escuta) s.escuta.parar("cancelado"); // respondeu na tela
    if (C.folha.aberta() && !temEste && !/Enviando relato/.test($("folha").textContent)) { encerrarSessao(); return; } // erro na tela
    // folha fechou: se não veio "relato-enviado" nem "fila" no mesmo ciclo, o motorista cancelou
    if (!C.folha.aberta()) setTimeout(() => { if (sessao === s) encerrarSessao(); }, 0);
  }

  // ---------- voto
  function votar(r, relAlerta, toque) {
    if (!relAlerta) {
      if (r.voto === "confirm" && r.tipo) { relatar(r.tipo, { valor: null }, toque); return; } // "ainda tem buraco" sem alerta = relato
      avisar(Cmd.MSG.semAlerta, true); return;
    }
    const tipoAlerta = NuvemLib.tipoParaApp(relAlerta.report_type);
    if (r.tipo && tipoAlerta && r.tipo !== tipoAlerta) {
      if (r.voto === "confirm") { relatar(r.tipo, { valor: null }, toque); return; }
      avisar("O alerta aberto é de outro tipo. Responda na tela.", true); return;
    }
    if (relAlerta.mine) { avisar("Esse relato é seu.", true); return; }
    if (relAlerta.my_vote) { avisar("Você já votou neste relato.", true); return; }
    votoPorVoz = true;
    setTimeout(() => { votoPorVoz = false; }, 15000); // voto que falhou não deixa o próximo voto manual bipar
    const atual = C.alerta.atual();
    const caixa = $("alerta-botoes");
    if (atual && atual.id === relAlerta.id && caixa && !caixa.hidden) $(r.voto === "confirm" ? "btn-a-sim" : "btn-a-nao").click();
    else C.comunidade.votar(relAlerta, r.voto);
  }

  // ouvindo(): true enquanto o reconhecimento de fala está ativo (toque em "Falar" ou resposta ao "É o mesmo?"). M3 (QA3):
  // a navegação usa para adiar a fala de manobra (o microfone ouviria a própria fala e ela se perderia).
  C.comandos = { ouvir: tocar, executar: (t) => executar([].concat(t), null), disponivel: () => escuta.disponivel(), ouvindo: () => !!ouvindo };

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/comandos.css");
    btn = C.botoesMapa.adicionar({ id: "cmd-falar", icone: "", rotulo: ROTULOS.pronto, aoTocar: tocar, classe: "cmd-falar", noFim: true });
    btn.textContent = "";
    btn.append(el("span", "cmd-icone", "🎙"), el("span", "cmd-rotulo", "Falar"));
    if (!escuta.disponivel()) btn.setAttribute("aria-disabled", "true");
    estado("pronto");

    C.on("alerta", (d) => {
      ultimaDistAlerta = d.distanciaM;
      // alerta de segurança tem prioridade: corta a escuta (senão o reconhecedor ouviria a própria fala do alerta)
      if (d.abriu && ouvindo) { pararEscuta("alerta"); C.mensagem("Escuta interrompida pelo alerta.", 4000); }
      if (d.abriu && sessao && sessao.escuta) sessao.escuta.parar("alerta");
    });
    C.on("alerta-fechado", () => { ultimaDistAlerta = null; });
    C.on("folha", aoMudarFolha);
    C.on("relato-enviado", () => { if (sessao) { encerrarSessao(); confirmar(); } });
    C.on("fila", () => { if (sessao && !C.folha.aberta()) { encerrarSessao(); confirmar(); } });
    C.on("voto", () => { if (votoPorVoz) { votoPorVoz = false; C.voz.bipe("ok"); } });
    C.on("sessao", () => { encerrarSessao(); });
  });
})(window.Copiloto);
