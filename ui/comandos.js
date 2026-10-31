// Comandos de voz (pacote E4): botão "Falar" no mapa, uma frase por toque (o Safari do iPhone não permite escuta
// contínua nem palavra de ativação). Interpretação determinística em comandos.js (sem IA, sem rede própria).
//
// Fluxo: toque → cala a fala (TTS) → "Abrindo microfone…" → onaudiostart: bipe de início e "Ouvindo" → escuta (até 8 s
// depois do audiostart) → bipe de fim → interpreta → executa.
// Voz no iPhone (iOS 26/27, WebKit 321436): escuta "surda" (microfone aberto sem som) é abortada em ~6 s com a mensagem
// "Feche o app e abra de novo"; cada falha mostra a mensagem do código (comandos.js: mensagemEscuta) e abre a folha
// "Comando sem voz" (botões ≥ 64 px e campo de texto → executar). Toque longo em "Falar" abre a mesma folha.
// Aba Conta: "Diagnóstico do microfone" (linha do tempo dos eventos da escuta, Copiar, Testar microfone).
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
  const ESCUTA_MS = 8000, RESPOSTA_MS = 6000, SEM_OUVINTE_MS = 300, SESSAO_RELATO_MS = 60000, LONGO_MS = 650;
  const ROTULOS = {
    pronto: "Falar um comando de voz (toque longo: comandos na tela)",
    abrindo: "Abrindo microfone…",
    ouvindo: "Ouvindo. Toque para cancelar",
    ok: "Comando registrado",
    indisponivel: Cmd.MSG.indisponivel,
  };
  const MSG_SAFARI = "Abra o Copiloto pelo Safari (não pelo ícone da tela inicial): aberto pela tela inicial, este iPhone está bloqueando o reconhecimento de voz.";
  // Comandos da folha alternativa (toque): rótulo → frase que vai para executar(), a mesma interpretação da voz
  const ALTERNATIVAS = [["Buraco", "buraco na pista"], ["Acidente", "acidente"], ["Animal na pista", "animal na pista"],
    ["Obra", "obra na pista"], ["Trânsito parado", "trânsito parado"], ["Radar móvel", "radar móvel"],
    ["Próximo posto", "próximo posto"], ["Repetir", "repete"]];
  const D = Cmd.diagnostico;
  const escuta = Cmd.criarEscuta();
  let btn = null, ouvindo = null, alertaNoToque = null, gpsNoToque = null, ultimaDistAlerta = null, timerOk = null, votoPorVoz = false;
  let sessao = null; // relato por voz em andamento: { tipo, perguntou, escuta, timer }
  const hist = { surdosSeguidos: 0, ultimoCodigo: null }; // para o aviso "abra pelo Safari" (sugerirSafari)
  let toqueLongo = false, timerLongo = null;

  // ---------- botão
  function estado(e) {
    if (!btn) return;
    if (!escuta.disponivel()) e = "indisponivel";
    btn.dataset.estado = e;
    btn.setAttribute("aria-label", ROTULOS[e]); btn.title = ROTULOS[e];
    btn.querySelector(".cmd-icone").textContent = e === "ok" ? "✓" : "🎙";
    btn.querySelector(".cmd-rotulo").textContent = e === "ouvindo" ? "Ouvindo" : e === "abrindo" ? "Abrindo" : "Falar";
  }
  function avisar(texto, falar) {
    C.mensagem(texto, 5000);
    // M3 (QA3): resposta do comando é fala não crítica: espera a manobra/alerta acabar em vez de cortar
    if (falar && !C.voz.emAlerta()) C.voz.falar(texto, { naoInterromper: true });
  }

  // ---------- escuta
  // iPhone: o microfone abre até ~2 s depois do start(). Bipe de início e "Ouvindo" só no onaudiostart (aoOuvindo);
  // antes, "Abrindo microfone…". Nada de fala (TTS) com o microfone aberto: cala antes do start().
  function ouvir(ms, fim, extra) {
    const eu = { abriu: false };
    if (C.voz.calar) { C.voz.calar(); D.registrar("ui:fala calada", "antes do start()"); }
    estado("abrindo");
    C.mensagem(ROTULOS.abrindo, 4000);
    eu.h = escuta.escutar({ maxMs: ms,
      aoOuvindo: () => {
        if (ouvindo !== eu) return;
        eu.abriu = true;
        const tocou = C.voz.bipe("inicio");
        D.registrar("ui:bipe inicio", tocou ? "" : "(sem som: bipe desligado)");
        estado("ouvindo");
        C.mensagem("Ouvindo… pode falar.", 3000);
        if (extra && extra.aoOuvindo) extra.aoOuvindo();
        desenharDiag();
      },
      aoTerminar: (res) => {
        if (ouvindo === eu) ouvindo = null;
        estado("pronto");
        if (eu.abriu && res.motivo !== "alerta" && res.motivo !== "cancelado") C.voz.bipe("fim");
        anotar(res);
        fim(res);
        desenharDiag();
      } });
    ouvindo = eu; // aoOuvindo/aoTerminar nunca rodam antes deste ponto (são sempre assíncronos)
    return { parar: (m) => eu.h && eu.h.parar(m) };
  }
  function pararEscuta(motivo) { if (ouvindo) { const o = ouvindo; ouvindo = null; o.h.parar(motivo); } }
  function anotar(res) {
    if (res.motivo === "cancelado" || res.motivo === "alerta") return;
    hist.surdosSeguidos = res.motivo === "surdo" ? hist.surdosSeguidos + 1 : 0;
    hist.ultimoCodigo = res.codigo || null;
  }

  function tocar() {
    if (toqueLongo) { toqueLongo = false; return; } // o toque longo já abriu a folha de comandos
    if (!escuta.disponivel()) {
      C.mensagem(Cmd.MSG.indisponivel + ".", 5000);
      D.registrar("indisponivel", "sem SpeechRecognition");
      abrirAlternativa({ erro: Cmd.mensagemEscuta({ motivo: "indisponivel" }) });
      return;
    }
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
    if (!res.textos.length) {
      // a escuta falhou: mensagem certa para o código (com o código) e os comandos por toque/teclado
      const texto = Cmd.mensagemEscuta(res, D.ambiente());
      C.mensagem(texto, 9000);
      abrirAlternativa({ erro: texto });
      return;
    }
    executar(res.textos, toque);
  }

  // ---------- alternativa sem voz: botões grandes e campo de texto (o teclado do iPhone tem ditado próprio)
  function abrirAlternativa(o) {
    const op = o || {};
    D.registrar("ui:folha alternativa", op.erro ? "depois de falha" : "toque longo");
    const filhos = [el("h2", "cmd-titulo", "Comando sem voz")];
    if (op.erro) { const p = el("p", "cmd-alt-erro", op.erro); p.id = "cmd-alt-erro"; filhos.push(p); }
    if (Cmd.sugerirSafari(D.ambiente(), hist)) { const p = el("p", "cmd-alt-safari", MSG_SAFARI); p.id = "cmd-alt-safari"; filhos.push(p); }
    const grade = el("div", "cmd-alt-grade");
    const itens = (C.alerta.atual() ? [["Ainda está lá", "continua lá"], ["Não está mais", "não está mais"]] : []).concat(ALTERNATIVAS);
    for (const [rotulo, frase] of itens) {
      const b = botao(rotulo, "btn btn-grande cmd-alt-btn", () => { C.folha.fechar(); C.comandos.executar(frase); });
      b.dataset.frase = frase; grade.appendChild(b);
    }
    filhos.push(grade);
    const form = el("form", "cmd-alt-form");
    form.id = "cmd-alt-form";
    const campo = document.createElement("input");
    campo.id = "cmd-alt-texto"; campo.type = "text"; campo.autocomplete = "off"; campo.setAttribute("enterkeyhint", "send");
    campo.setAttribute("aria-label", "Digite o comando"); campo.placeholder = "Ou digite (ou dite no teclado): tem buraco aqui";
    const enviar = el("button", "btn btn-principal btn-grande", "Enviar"); enviar.type = "submit"; enviar.id = "cmd-alt-enviar";
    form.append(campo, enviar);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const t = campo.value.trim();
      if (!t) { campo.focus(); return; }
      C.folha.fechar(); C.comandos.executar(t);
    });
    filhos.push(form, botao("Fechar", "btn btn-grande", C.folha.fechar));
    C.folha.abrir(filhos);
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
    // Só ouve DEPOIS do fim da pergunta (onend) + 300 ms e com a fala parada (speechSynthesis.speaking = false): o
    // microfone aberto com a fala tocando fica surdo no iPhone. Se o fim não vier, não ouve: a decisão fica na tela.
    let feito = false, tentativas = 0, timerFalha = null;
    const naTela = (motivo) => {
      D.registrar("ui:é o mesmo? na tela", motivo);
      if (sessao === s && $("btn-e-este")) C.mensagem("Responda na tela: é este ou é outro?", 7000);
    };
    const tentar = () => {
      if (sessao !== s || !$("btn-e-este")) return;
      if (C.voz.emAlerta()) { naTela("alerta"); return; }
      if (C.voz.sintetizando && C.voz.sintetizando()) {
        if (++tentativas <= 5) { setTimeout(tentar, 300); return; }
        naTela("fala não parou"); return;
      }
      s.escuta = ouvir(RESPOSTA_MS, (res) => { s.escuta = null; responderMesmo(s, res); });
    };
    const aposFala = () => {
      if (feito) return;
      feito = true; clearTimeout(timerFalha);
      D.registrar("ui:fala terminou", "é o mesmo?");
      setTimeout(tentar, 300);
    };
    if (!C.voz.falar(texto, { aoTerminar: aposFala })) { feito = true; naTela("sem fala"); return; }
    timerFalha = setTimeout(() => { if (!feito) { feito = true; naTela("fala sem fim"); } }, 3000 + 90 * texto.length);
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
  C.comandos = { ouvir: tocar, executar: (t) => executar([].concat(t), null), disponivel: () => escuta.disponivel(), ouvindo: () => !!ouvindo,
    alternativa: () => abrirAlternativa({}) };

  // ---------- diagnóstico do microfone (aba Conta): ambiente, linha do tempo da escuta, Copiar e Testar microfone
  function criarCartaoDiag() {
    const tela = $("tela-conta");
    if (!tela || $("cmd-diag")) return;
    const c = el("div", "cartao cmd-diag"); c.id = "cmd-diag";
    const amb = el("p", "dica"); amb.id = "cmd-diag-amb";
    const safari = el("p", "cmd-alt-safari", MSG_SAFARI); safari.id = "cmd-diag-safari"; safari.hidden = true;
    const log = el("pre", "cmd-diag-log"); log.id = "cmd-diag-log";
    const copiar = botao("Copiar", "btn", copiarDiag); copiar.id = "cmd-diag-copiar";
    const testar = botao("Testar microfone", "btn btn-principal", testarMicrofone); testar.id = "cmd-diag-testar";
    testar.dataset.semDestravar = "";
    const linha = el("div", "linha-botoes"); linha.append(copiar, testar);
    const msg = el("p", "dica"); msg.id = "cmd-diag-msg"; msg.setAttribute("role", "status");
    c.append(el("h2", null, "Diagnóstico do microfone"),
      el("p", "dica", "Se o \"Falar\" não funcionar, toque em Testar microfone, fale algo e depois em Copiar para mandar ao suporte."),
      amb, safari, log, linha, msg);
    const voz = $("cartao-voz");
    if (voz && voz.parentNode === tela) voz.after(c); else tela.appendChild(c);
    desenharDiag();
  }
  function desenharDiag() {
    if (!$("cmd-diag")) return;
    const a = D.ambiente();
    $("cmd-diag-amb").textContent = D.textoAmbiente(a);
    $("cmd-diag-safari").hidden = !Cmd.sugerirSafari(a, hist);
    $("cmd-diag-log").textContent = D.texto() || "(nenhum evento ainda)";
  }
  function msgDiag(t) { const m = $("cmd-diag-msg"); if (m) m.textContent = t; }
  async function copiarDiag() {
    const txt = D.relatorio();
    let ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(txt); ok = true; } } catch (e) { /* tenta o outro jeito */ }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = txt; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy"); ta.remove();
      } catch (e) { ok = false; }
    }
    msgDiag(ok ? "Copiado. Cole na conversa com o suporte." : "Não deu para copiar. Segure o dedo no texto acima e copie.");
  }
  function testarMicrofone() {
    if (!escuta.disponivel()) { D.registrar("indisponivel", "teste do microfone"); msgDiag(Cmd.mensagemEscuta({ motivo: "indisponivel" })); desenharDiag(); return; }
    if (ouvindo) { pararEscuta("cancelado"); msgDiag("Teste cancelado."); return; }
    if (C.voz.emAlerta()) { msgDiag("Espere o alerta terminar e toque de novo."); return; }
    D.registrar("ui:teste do microfone");
    msgDiag(ROTULOS.abrindo);
    ouvir(ESCUTA_MS, (res) => {
      if (res.motivo === "cancelado" || res.motivo === "alerta") return;
      msgDiag(res.textos.length ? "Funcionou. Ouvi: “" + res.textos[0] + "”" : Cmd.mensagemEscuta(res, D.ambiente()));
    }, { aoOuvindo: () => msgDiag("Ouvindo… fale alguma coisa.") });
    desenharDiag();
  }

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/comandos.css");
    btn = C.botoesMapa.adicionar({ id: "cmd-falar", icone: "", rotulo: ROTULOS.pronto, aoTocar: tocar, classe: "cmd-falar", noFim: true });
    btn.textContent = "";
    btn.append(el("span", "cmd-icone", "🎙"), el("span", "cmd-rotulo", "Falar"));
    btn.dataset.semDestravar = ""; // ui/voz.js não destrava a fala neste toque (a fala muda tocaria com o microfone abrindo)
    if (!escuta.disponivel()) btn.setAttribute("aria-disabled", "true");
    estado("pronto");
    // toque longo em "Falar": comandos por toque/teclado, sem microfone
    btn.addEventListener("pointerdown", () => {
      toqueLongo = false; clearTimeout(timerLongo);
      timerLongo = setTimeout(() => { if (ouvindo) return; toqueLongo = true; abrirAlternativa({}); }, LONGO_MS);
    });
    for (const t of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(t, () => clearTimeout(timerLongo));
    btn.addEventListener("contextmenu", (ev) => ev.preventDefault());
    criarCartaoDiag();
    C.on("aba", (id) => { if (id === "conta") desenharDiag(); });

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
