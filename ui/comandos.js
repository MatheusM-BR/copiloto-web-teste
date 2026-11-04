// Comandos de voz (pacote E4): botão "Falar" no mapa, uma frase por toque, e o modo mãos-livres opcional (abaixo: escuta
// reaberta a cada frase com o app na tela; palavra de ativação de verdade, com tela bloqueada, só no app nativo).
// Interpretação determinística em comandos.js (sem IA, sem rede própria: a busca de lugar é a do app, Copiloto.busca).
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
//
// Destino por voz ("me leva para Goiânia", "ir para o posto Graal em Anápolis", "navegar até CEAGESP", "rota para Rio Verde
// GO"): busca com Copiloto.busca.procurar(texto) (ui/busca.js, a única busca do app; contrato [{ nome, detalhe, lat, lon }]). 1 resultado claro → "Traçando rota para <nome>, <cidade>" e traça (navegando:
// "Trocar o destino para …? Sim ou não", folha Sim/Não ≥ 64 px); vários → folha com até 5 opções ≥ 64 px e a voz lê as 3
// primeiras ("Um: …; dois: …"), resposta "um/dois/primeiro/o de Anápolis" pela voz ou toque; nenhum → fala e folha;
// sem internet → destinos recentes pelo nome (navegacao.recentes() + os escolhidos por voz, copiloto.voz.lugares.v1).
//
// Mãos-livres (opcional, ligado por um toque na folha "Comando sem voz"): escuta contínua com o app aberto e na tela. Cada
// sessão do reconhecimento termina sozinha; o app abre outra no fim (sem bipe). Só a frase que começa com "Copiloto" vira
// comando ("Copiloto" sozinho: bipe e a próxima frase em 8 s vale). Fecha o microfone enquanto o app fala ("voz:falar") e
// durante a fala de manobra/alerta. Se o aparelho recusar abrir sem toque (ou falhar), pausa com "Toque para voltar a
// ouvir". Desliga ao ir para segundo plano (na volta: pausado, um toque religa; 2 min sem toque, desliga) e após
// 10 min sem navegação ativa. Não conta em ouvindo() (a manobra não espera por ele: ele é que espera a manobra).
// Limite real: PWA não ouve com a tela bloqueada nem em segundo plano; palavra de ativação de verdade só no app nativo.
(function (C) {
  "use strict";
  const { $, el, botao, novoId } = C.util;
  const Cmd = window.CopilotoComandos, Relatos = window.CopilotoRelatos, NuvemLib = window.CopilotoNuvem, Voz = window.CopilotoVoz;
  const ESCUTA_MS = 8000, RESPOSTA_MS = 6000, SEM_OUVINTE_MS = 300, SESSAO_RELATO_MS = 60000, LONGO_MS = 650;
  // Fim da fala por silêncio (campo 01/11: "o áudio para sozinho ao não identificar mais áudio"): 1,2 s sem resultado
  // novo depois do último texto fecha a escuta e executa; nada dito em 5 s (com som) → "Não ouvi nada" (sem a folha).
  const FIM_FALA_MS = 1200, SEM_FALA_MS = 5000;
  const NAO_OUVI = "Não ouvi nada. Toque em Falar e fale depois do bipe.";
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
  let pergunta = null, perguntaEscuta = null; // pergunta por voz em andamento (lista de destinos ou Sim/Não)

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
    mlPararCiclo("cancelado"); // o mãos-livres cede o microfone (volta sozinho depois)
    if (ml.ligado && ml.estado === "ouvindo") mlEstado("esperando");
    if (C.voz.calar) { C.voz.calar(); D.registrar("ui:fala calada", "antes do start()"); }
    if (C.voz.microfone) C.voz.microfone(true); // o áudio mudo em laço (modo silencioso) sai enquanto o microfone está aberto
    estado("abrindo");
    C.mensagem(ROTULOS.abrindo, 4000);
    eu.h = escuta.escutar({ maxMs: ms, fimSilencioMs: extra && extra.fimSilencioMs, semFalaMs: extra && extra.semFalaMs,
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
        if (!ouvindo && C.voz.microfone) C.voz.microfone(false);
        estado("pronto");
        if (eu.abriu && res.motivo !== "alerta" && res.motivo !== "cancelado") C.voz.bipe("fim");
        anotar(res);
        fim(res);
        desenharDiag();
      } });
    ouvindo = eu; // aoOuvindo/aoTerminar nunca rodam antes deste ponto (são sempre assíncronos)
    return { parar: (m) => eu.h && eu.h.parar(m), concluir: () => eu.h && (eu.h.concluir ? eu.h.concluir() : eu.h.parar("cancelado")) };
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
    // 1º toque em "Falar": o aviso do microfone (reconhecimento de fala da Apple…) antes de abrir; "Entendi, falar" abre no mesmo toque
    if (!ouvindo && !(sessao && sessao.escuta) && C.privacidade && C.privacidade.microfoneAvisado && !C.privacidade.microfoneAvisado()) {
      C.privacidade.avisarMicrofone(tocar);
      return;
    }
    // tocar de novo enquanto ouve: fecha e executa o que já ouviu (campo 01/11: o motorista tocava para "terminar" e o
    // texto era descartado); sem nada ouvido, cancela
    if (ouvindo) { const o = ouvindo; if (o.h && o.h.concluir) o.h.concluir(); else pararEscuta("cancelado"); return; }
    if (sessao && sessao.escuta) { sessao.escuta.parar("cancelado"); return; }
    // "Falar" durante o alerta: corta a fala do alerta e abre o microfone (o alerta continua na tela)
    if (C.voz.emAlerta()) { C.voz.calar(); D.registrar("ui:alerta calado", "toque em Falar"); }
    alertaNoToque = C.alerta.atual();
    // M3 (QA2): o relato por voz vai no ponto do TOQUE em "Falar" (como o "!"), não no fim da fala/reconhecimento
    gpsNoToque = C.relatos.leituraDoToque();
    ouvir(ESCUTA_MS, processar, { fimSilencioMs: FIM_FALA_MS, semFalaMs: SEM_FALA_MS });
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
    if (!res.textos.length && res.motivo === "silencio" && (!res.codigo || res.codigo === "no-speech")) {
      // nada foi dito (fim por silêncio): só o aviso, sem a folha de comandos
      D.registrar("ui:não ouvi nada", "");
      avisar(NAO_OUVI, true); // na tela e por voz
      return;
    }
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
    // mãos-livres: liga com este toque (o start() do reconhecimento sai dentro do gesto)
    const ml1 = botao(ml.ligado ? "Desligar mãos-livres" : "Mãos-livres: dizer “Copiloto”", "btn btn-grande cmd-ml-alternar", () => {
      C.folha.fechar();
      if (ml.ligado) mlDesligar("folha", "Mãos-livres desligado."); else mlLigar();
    });
    ml1.id = "cmd-ml-alternar"; ml1.dataset.semDestravar = "";
    const mlDica = el("p", "dica cmd-ml-dica", "Mãos-livres: com o app aberto e na tela, o microfone fica ouvindo e só age quando a frase começa com “Copiloto” (ex.: “Copiloto, me leva para Goiânia”). Tudo o que for dito perto do celular vai ao reconhecimento de fala do aparelho. Desliga ao sair do app e depois de 10 min sem navegação. Com a tela bloqueada não funciona (limite do iPhone).");
    filhos.push(form, ml1, mlDica, botao("Fechar", "btn btn-grande", C.folha.fechar));
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
      case "qual_km": return comando("comando:qual-km", {}, semOuvinte); // "em que km estou" (ui/km.js atende)
      case "chegada": case "restante": return responderViagem(r.intencao);
      case "silenciar": return silenciar();
      case "ir_para": if (C.km && C.km.deVoz(r)) return; return irPara(r); // "BR-153 km 140" é destino por km (ui/km.js)
      case "talvez_lugar": if (C.km && C.km.deVoz(r)) return; return talvezLugar(r, textos, toque);
      case "relatar_sem_tipo": // "polícia", "blitz": o app não tem esse tipo; o formulário abre no ponto do toque para escolher
        C.relatos.abrirFormulario(toque ? { toque } : undefined);
        return avisar("Esse assunto ainda não é um tipo de relato. Escolha o tipo na tela.", true);
      default: return naoEntendi(textos, toque);
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
  // "quando eu chego", "quanto falta": a resposta vem da navegação (ou da rota traçada); fala e escreve
  function responderViagem(tipo) {
    const t = C.navegacao && typeof C.navegacao.textoViagem === "function" ? C.navegacao.textoViagem(tipo) : null;
    avisar(t || "Não há rota nem navegação em andamento.", true);
  }
  // "silencia", "cala a boca": corta a fala de agora (o alerta, se houver, continua na tela) e não repete a manobra cortada
  function silenciar() {
    C.voz.calar({ definitivo: true });
    C.mensagem("Fala silenciada.", 3000);
  }
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
    else { confirmar(); C.mensagem("Relato anotado: " + (cfg.curto || cfg.rotulo || tipo) + ".", 4000); }
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

  // ---------- destino por voz
  const LUGARES_CHAVE = "copiloto.voz.lugares.v1", PERGUNTA_MS = 20000;
  let buscaSeq = 0;
  // Uma só busca: a do app (ui/busca.js, Copiloto.busca.procurar; Photon, 1 pedido/s, tempo-limite, viés pela posição).
  // Falha de rede rejeita com .rede (aí a voz procura nos destinos recentes); sem a busca carregada, erro comum.
  function procurar(texto) {
    if (C.busca && typeof C.busca.procurar === "function") return Promise.resolve().then(() => C.busca.procurar(texto));
    return Promise.reject(new Error("A busca de lugares não está disponível."));
  }
  function posAgora() { const g = C.estado.gps; return g ? { lat: g.lat, lon: g.lon } : null; }
  function navegando() { return !!(C.navegacao && C.navegacao.ativa && C.navegacao.ativa() && C.navegacao.trocarDestino); }
  function lerLugares() { const l = C.util.lerJSON(LUGARES_CHAVE, []); return Array.isArray(l) ? l : []; }
  function guardarLugar(it) {
    const l = lerLugares().filter((x) => !(Math.abs(x.lat - it.lat) < 1e-4 && Math.abs(x.lon - it.lon) < 1e-4));
    l.unshift({ rotulo: it.rotulo, lat: it.lat, lon: it.lon, t: Date.now() });
    C.util.gravarJSON(LUGARES_CHAVE, l.slice(0, 20));
  }

  async function irPara(r) {
    const meu = ++buscaSeq;
    D.registrar("ui:destino por voz", r.consulta.length + " letras");
    C.mensagem("Procurando " + r.lugar + "…", 6000);
    let lista = null, semRede = navigator.onLine === false, erro = null;
    if (!semRede) {
      try { lista = await procurar(r.consulta); } catch (e) { if (e && e.rede) semRede = true; else erro = e || new Error(""); }
    }
    if (meu !== buscaSeq) return; // outro pedido passou na frente
    if (semRede) { irParaSemInternet(r); return; }
    if (erro) { naoAchou("Não deu para procurar “" + r.lugar + "”. " + (erro.message || ""), "Não deu para procurar agora."); return; }
    const d = Cmd.decidirLugares(lista, r, posAgora());
    if (d.tipo === "nenhum") { naoAchou("Não achei “" + r.lugar + "”. Diga o nome e a cidade, por exemplo: me leva para o posto Graal em Anápolis.", "Não achei " + r.lugar + "."); return; }
    if (d.tipo === "um") { escolherLugar(d.itens[0]); return; }
    oferecerOpcoes(r, d.itens, false);
  }
  function irParaSemInternet(r) {
    const recentes = (C.navegacao && C.navegacao.recentes ? C.navegacao.recentes() : []).concat(lerLugares());
    const d = Cmd.decidirLugares(Cmd.buscarNosRecentes(r, recentes), r, posAgora());
    if (d.tipo === "nenhum") { naoAchou("Sem internet para procurar “" + r.lugar + "”, e ele não está nos destinos recentes.", "Sem internet para procurar " + r.lugar + "."); return; }
    C.mensagem("Sem internet: achei nos destinos recentes.", 5000);
    if (d.tipo === "um") escolherLugar(d.itens[0], { semRede: true });
    else oferecerOpcoes(r, d.itens, true);
  }
  function naoAchou(texto, falado) {
    const p = el("p", "cmd-dest-erro", texto); p.id = "cmd-dest-erro";
    C.folha.abrir([el("h2", "cmd-titulo", "Destino não encontrado"), p, botao("Fechar", "btn btn-grande", C.folha.fechar)]);
    C.mensagem(texto, 8000);
    if (!C.voz.emAlerta()) C.voz.falar(falado, { naoInterromper: true });
  }
  function escolherLugar(it, o) {
    const op = o || {};
    guardarLugar(it);
    if (navegando()) { perguntarTroca(it); return; }
    if (op.semRede || navigator.onLine === false) {
      const g = C.offline && C.offline.rotaGuardada ? C.offline.rotaGuardada() : null;
      if (g && g.destino && Cmd.distKm(g.destino, it) < 0.1 && !C.rota.atual() && C.navegacao && C.navegacao.iniciar) {
        C.folha.fechar(); avisar("Sem internet. Seguindo a rota guardada para " + it.falado + ".", true); C.navegacao.iniciar(); return;
      }
      C.rota.definirDestino({ lat: it.lat, lng: it.lon }, { rotulo: it.falado });
      avisar("Sem internet para traçar a rota até " + it.falado + ". O destino ficou marcado.", true);
      if (C.estado.ultimaPos) C.rota.tracar(); // a folha diz "Sem conexão…" com "Tentar de novo"
      return;
    }
    C.rota.definirDestino({ lat: it.lat, lng: it.lon }, { rotulo: it.falado });
    if (!C.estado.ultimaPos) { avisar("Ative o GPS para traçar a rota até " + it.falado + ".", true); return; }
    avisar("Traçando rota para " + it.falado + ".", true);
    C.rota.tracar();
  }
  // navegando: confirma antes de trocar (Sim/Não ≥ 64 px, como o "Ir para este posto")
  function perguntarTroca(it) {
    const b = el("div", "linha-botoes cmd-dest-troca");
    const sim = botao("Sim, trocar", "btn btn-principal nav-grande", () => { C.folha.fechar(); C.navegacao.trocarDestino({ lat: it.lat, lon: it.lon, rotulo: it.falado }); });
    const nao = botao("Não", "btn nav-grande", C.folha.fechar);
    sim.id = "cmd-dest-sim"; nao.id = "cmd-dest-nao";
    b.append(sim, nao);
    C.folha.abrir([el("h2", "cmd-titulo", "Trocar o destino para " + it.rotulo + "?"),
      el("p", null, "A navegação recalcula a rota daqui, com o mesmo veículo e carga."), b]);
    perguntar("Trocar o destino para " + it.falado + "? Sim ou não.", (textos) => {
      const sn = Cmd.simOuNao(textos.map((t) => Cmd.extrairChamada(t).resto));
      if (sn === "sim") { sim.click(); return true; }
      if (sn === "nao" || sn === "cancelar") { nao.click(); return true; }
      return false;
    }, "cmd-dest-sim");
  }
  function oferecerOpcoes(r, itens, semRede) {
    const col = el("div", "coluna-botoes cmd-dest-lista"); col.id = "cmd-dest-lista";
    itens.forEach((it, k) => {
      const km = it.km == null ? "" : " · " + (it.km < 10 ? it.km.toFixed(1).replace(".", ",") : Math.round(it.km)) + " km";
      const b = botao((k + 1) + ". " + it.rotulo + km, "btn btn-grande cmd-dest-op", () => { C.folha.fechar(); escolherLugar(it, { semRede }); });
      b.dataset.indice = String(k); col.appendChild(b);
    });
    const cancelar = botao("Cancelar", "btn btn-grande", C.folha.fechar); cancelar.id = "cmd-dest-cancelar";
    C.folha.abrir([el("h2", "cmd-titulo", "Qual destino?"),
      el("p", "dica", "Procurei “" + r.lugar + "”" + (semRede ? " nos destinos recentes (sem internet)" : "") + ". Diga o número ou toque."), col, cancelar]);
    const n = itens.length;
    perguntar("Encontrei " + n + " lugares. " + Cmd.textoOpcoesFalado(itens) + " Diga o número.", (textos) => {
      const k = Cmd.lerEscolha(textos, n, itens);
      if (k === "cancelar") { cancelar.click(); return true; }
      if (typeof k === "number") { const b = col.querySelector('[data-indice="' + k + '"]'); if (b) { b.click(); return true; } }
      return false;
    }, "cmd-dest-lista");
  }

  // ---------- lugar provável (frase solta: "Goiânia", "posto Graal Anápolis", "CEAGESP") e "não entendi"
  // Integração (campo 01/11: "ao falar não transfere para busca ou para aviso"): toda frase reconhecida leva a uma ação
  // visível. Lugar provável: abre a Busca com o que foi dito e procura (Copiloto.busca.procurar); 1 resultado claro →
  // o fluxo do "me leva para" (fala + traça; navegando, pergunta); vários → a lista na Busca; nenhum → "Não entendi".
  async function talvezLugar(r, textos, toque) {
    const meu = ++buscaSeq;
    D.registrar("ui:lugar provável", r.consulta.length + " letras");
    const mostrar = (lista, aviso) => { if (C.busca && C.busca.mostrar) C.busca.mostrar(r.lugar, lista, aviso); };
    mostrar(null, "Buscando “" + r.lugar + "”…");
    let lista = null, semRede = navigator.onLine === false, erro = null;
    if (!semRede) {
      try { lista = await procurar(r.consulta); } catch (e) { if (e && e.rede) semRede = true; else erro = e || new Error(""); }
    }
    if (meu !== buscaSeq) return;
    if (semRede) {
      const rec = (C.navegacao && C.navegacao.recentes ? C.navegacao.recentes() : []).concat(lerLugares());
      lista = Cmd.buscarNosRecentes(r, rec);
    }
    const d = Cmd.decidirLugares(lista || [], r, posAgora());
    if (erro || d.tipo === "nenhum") {
      if (C.abas.atual() === "busca") C.abas.irPara("mapa");
      naoEntendi(textos, toque, semRede ? "Sem internet para procurar “" + r.lugar + "”." : null);
      return;
    }
    if (d.tipo === "um") { escolherLugar(d.itens[0], { semRede }); return; }
    mostrar(d.itens.map((it) => ({ nome: it.nome, detalhe: it.detalhe, lat: it.lat, lon: it.lon })), null);
    avisar("Encontrei " + d.itens.length + " lugares para " + r.lugar + ". Escolha na tela.", true);
  }
  // Não entendeu: o que ouviu, "Buscar “<texto>”", "Relatar" (≥ 64 px) e o campo de texto ("Comando sem voz").
  function naoEntendi(textos, toque, motivo) {
    const ouvido = String([].concat(textos).find((t) => t && String(t).trim()) || "").trim();
    D.registrar("ui:não entendi", ouvido.length + " letras");
    avisar(Cmd.MSG.naoEntendi + (motivo ? " " + motivo : ""), true); // o mesmo texto da folha, escrito e falado
    const filhos = [el("h2", "cmd-titulo", "Não entendi")];
    if (motivo) filhos.push(el("p", "cmd-ne-motivo", motivo));
    if (ouvido) { const p = el("p", "cmd-ne-ouvido", "Ouvi: “" + ouvido + "”"); p.id = "cmd-ne-ouvido"; filhos.push(p); }
    const linha = el("div", "linha-botoes cmd-ne-botoes");
    if (ouvido) {
      const b = botao("Buscar “" + ouvido + "”", "btn btn-principal btn-grande", () => { C.folha.fechar(); if (C.busca && C.busca.mostrar) C.busca.mostrar(ouvido); });
      b.id = "cmd-ne-buscar"; linha.append(b);
    }
    const rel = botao("Relatar", "btn btn-grande", () => { C.folha.fechar(); C.relatos.abrirFormulario(toque ? { toque } : undefined); });
    rel.id = "cmd-ne-relatar"; linha.append(rel);
    filhos.push(linha);
    // a folha cobre o "Falar": tentar de novo daqui mesmo (o toque é o gesto que o iPhone pede para abrir o microfone)
    const denovo = botao("Falar de novo", "btn btn-grande", () => { C.folha.fechar(); tocar(); });
    denovo.id = "cmd-ne-falar";
    filhos.push(denovo);
    const form = el("form", "cmd-alt-form"); form.id = "cmd-alt-form";
    const campo = document.createElement("input");
    campo.id = "cmd-alt-texto"; campo.type = "text"; campo.autocomplete = "off"; campo.setAttribute("enterkeyhint", "send");
    campo.setAttribute("aria-label", "Digite o comando"); campo.placeholder = "Ou digite (ou dite no teclado): Goiânia, tem buraco aqui";
    const enviar = el("button", "btn btn-principal btn-grande", "Enviar"); enviar.type = "submit"; enviar.id = "cmd-alt-enviar";
    form.append(campo, enviar);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const t = campo.value.trim();
      if (!t) { campo.focus(); return; }
      C.folha.fechar(); executar([t], toque);
    });
    filhos.push(form, botao("Fechar", "btn btn-grande", C.folha.fechar));
    C.folha.abrir(filhos);
  }

  // Pergunta por voz com a resposta na tela também. Com o mãos-livres, a escuta contínua responde (com ou sem "Copiloto").
  // Sem ele, ouve UMA vez depois do fim da fala + 300 ms (como o "É o mesmo?"); sem resposta clara, a decisão fica na tela.
  function perguntar(texto, tratar, id) {
    const p = { tratar, id, ate: Date.now() + PERGUNTA_MS };
    pergunta = p;
    const vivo = () => pergunta === p && !!$(id) && Date.now() < p.ate;
    if (ml.ligado && ml.estado !== "pausado") { if (!C.voz.emAlerta()) C.voz.falar(texto, { naoInterromper: true }); return; }
    let feito = false, tentativas = 0, timerFalha = null;
    const naTela = () => { if (vivo()) C.mensagem("Escolha na tela.", 7000); };
    const ouvirResposta = () => {
      if (!vivo() || C.voz.emAlerta() || ouvindo) { naTela(); return; }
      if (C.voz.sintetizando && C.voz.sintetizando()) { if (++tentativas <= 5) { setTimeout(ouvirResposta, 300); return; } naTela(); return; }
      perguntaEscuta = ouvir(RESPOSTA_MS, (res) => {
        perguntaEscuta = null;
        if (!vivo() || res.motivo === "cancelado" || res.motivo === "alerta") return;
        if (res.motivo === "ok" && responder(res.textos)) return;
        C.mensagem("Sem resposta clara. Escolha na tela.", 7000);
      }, { fimSilencioMs: FIM_FALA_MS });
    };
    const aposFala = () => { if (feito) return; feito = true; clearTimeout(timerFalha); setTimeout(ouvirResposta, 300); };
    if (C.voz.emAlerta() || !C.voz.falar(texto, { naoInterromper: true, aoTerminar: aposFala })) { feito = true; naTela(); return; }
    timerFalha = setTimeout(() => { if (!feito) { feito = true; naTela(); } }, 10000 + 90 * texto.length);
  }
  // true se a frase respondeu a pergunta aberta
  function responder(textos) {
    const p = pergunta;
    if (!p || !$(p.id) || Date.now() > p.ate) { pergunta = null; return false; }
    if (!p.tratar([].concat(textos))) return false;
    if (pergunta === p) pergunta = null;
    return true;
  }
  function aoMudarFolhaPergunta() {
    if (pergunta && !$(pergunta.id)) {
      pergunta = null;
      if (perguntaEscuta) { const e = perguntaEscuta; perguntaEscuta = null; e.parar("cancelado"); }
    }
  }

  // ---------- mãos-livres ("Copiloto, …" sem tocar)
  const ML = { MAX_MS: 12000, PARCIAL_MS: 2500, SURDO_MS: 60000, REINICIO_MS: 250, ESPERA_MS: 300, ARMADO_MS: 8000,
    VOLTAR_MS: 120000, SURDOS: 8, FALHAS: 2, RAPIDA_MS: 1500, APOS_FALA_MS: 400 };
  const semNavMs = () => Number(window.COPILOTO_ML_SEM_NAV_MS) || 10 * 60000;
  const ml = { ligado: false, estado: "desligado", h: null, timer: null, armadoAte: 0, rapidas: 0, surdos: 0, ultimaNav: 0,
    timerIdle: null, timerVoltar: null, falaAte: 0, voltar: false };
  let elMl = null;
  function mlDesenhar() {
    if (!elMl) return;
    elMl.hidden = ml.estado === "desligado";
    elMl.dataset.estado = ml.estado;
    const pausado = ml.estado === "pausado";
    elMl.querySelector(".cmd-ml-texto").textContent = pausado ? "Toque para voltar a ouvir" : "Copiloto";
    const r = pausado ? "Mãos-livres pausado. Toque para voltar a ouvir" : "Mãos-livres: ouvindo “Copiloto”. Toque para desligar";
    elMl.setAttribute("aria-label", r); elMl.title = r;
    mlPosicionar();
  }
  // Integração com o redesenho: o indicador fica à esquerda de um botão da coluna (ui/mapa.js já pôs a coluna no espaço
  // livre, em pé e deitado, com e sem navegação), na mesma altura: o primeiro, de cima para baixo, em que ele cabe sem
  // cobrir a busca, a faixa da manobra, a velocidade, a barra do pé, o alerta, o "Recentralizar" nem a atribuição do mapa.
  // Sem lugar (ou com o cartão da fachada aberto), fica compacto (só o ponto, 64 × 64). Antes ficava fixo a 186 px do pé:
  // deitado, caía sobre a busca e a faixa da manobra; navegando, sobre a atribuição.
  let mlQuadro = 0, mlUltima = "";
  const ML_OBSTACULOS = "#barra-topo, #nav-painel, .painel-mapa > .velocidade, #nav-rodape, #alerta, #btn-recentralizar, #mapa .maplibregl-ctrl-attrib, #folha";
  function mlPosicionar() {
    if (!elMl || elMl.hidden || mlQuadro) return;
    mlQuadro = requestAnimationFrame(() => {
      mlQuadro = 0;
      if (!elMl || elMl.hidden) return;
      const vis = (e) => !!e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
      const botoes = [...document.querySelectorAll(".acoes > *")].filter((b) => b !== elMl && vis(b)).map((b) => b.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      if (!botoes.length) return;
      const obst = [...document.querySelectorAll(ML_OBSTACULOS)].filter(vis).map((e) => e.getBoundingClientRect()).concat(botoes);
      const cruza = (a, q) => Math.min(a.right, q.right) - Math.max(a.left, q.left) > 1 && Math.min(a.bottom, q.bottom) - Math.max(a.top, q.top) > 1;
      const pai = (elMl.offsetParent || document.body).getBoundingClientRect();
      const fachada = !!(C.fachada && C.fachada.aberta && C.fachada.aberta());
      elMl.classList.remove("compacto");
      const largNormal = elMl.offsetWidth, alt = elMl.offsetHeight || 64;
      let escolha = null;
      for (const compacto of fachada ? [true] : [false, true]) {
        const larg = compacto ? 64 : largNormal;
        for (const r of botoes) {
          let esq = r.left; // botões lado a lado (deitado): à esquerda do mais à esquerda da fileira
          for (const q of botoes) if (q.bottom > r.top + 1 && q.top < r.bottom - 1) esq = Math.min(esq, q.left);
          const right = esq - 8;
          // centrado no botão; senão alinhado ao topo ou ao pé dele (o "!" tem 76 px: sobra um pouco acima e abaixo)
          for (const top of [r.top + (r.height - alt) / 2, r.top, r.bottom - alt]) {
            const caixa = { left: right - larg, right, top, bottom: top + alt };
            if (caixa.left < pai.left + 4 || caixa.top < pai.top + 4 || caixa.bottom > pai.bottom - 4) continue;
            if (obst.some((q) => cruza(caixa, q))) continue;
            escolha = { compacto, caixa }; break;
          }
          if (escolha) break;
        }
        if (escolha) break;
      }
      if (!escolha) { // sem lugar livre: compacto, à esquerda do botão de baixo
        const r = botoes[botoes.length - 1];
        escolha = { compacto: true, caixa: { right: r.left - 8, top: r.top + (r.height - alt) / 2 } };
      }
      elMl.classList.toggle("compacto", escolha.compacto);
      elMl.style.left = "auto"; elMl.style.bottom = "auto";
      elMl.style.right = Math.round(pai.right - escolha.caixa.right) + "px";
      elMl.style.top = Math.round(escolha.caixa.top - pai.top) + "px";
      const chave = elMl.style.right + "|" + elMl.style.top + "|" + escolha.compacto;
      if (chave !== mlUltima) { mlUltima = chave; C.emit("cmd-ml-posicao", { compacto: escolha.compacto }); }
    });
  }
  function mlEstado(e) { if (ml.estado !== e) { ml.estado = e; mlDesenhar(); } }
  // chamado no toque (gesto): o primeiro start() sai dentro dele
  function mlLigar() {
    if (!escuta.disponivel()) { C.mensagem(Cmd.MSG.indisponivel + ".", 5000); return; }
    ml.ligado = true; ml.rapidas = 0; ml.surdos = 0; ml.voltar = false; ml.ultimaNav = Date.now();
    clearTimeout(ml.timerVoltar);
    D.registrar("ui:mãos-livres", "ligado");
    mlEstado("ouvindo");
    C.mensagem("Mãos-livres ligado: diga “Copiloto” e o comando.", 5000);
    mlArmarIdle();
    clearTimeout(ml.timer); ml.timer = null;
    mlCiclo();
  }
  function mlDesligar(motivo, aviso) {
    const estava = ml.estado !== "desligado";
    ml.ligado = false; ml.armadoAte = 0; ml.voltar = false;
    clearTimeout(ml.timer); ml.timer = null; clearInterval(ml.timerIdle); ml.timerIdle = null; clearTimeout(ml.timerVoltar);
    mlPararCiclo("cancelado");
    mlEstado("desligado");
    if (estava) D.registrar("ui:mãos-livres", "desligado (" + motivo + ")");
    if (aviso) C.mensagem(aviso, 6000);
  }
  // espera um toque no indicador ("Toque para voltar a ouvir")
  function mlPausar(motivo, aviso) {
    clearTimeout(ml.timer); ml.timer = null;
    mlPararCiclo("cancelado");
    mlEstado("pausado");
    D.registrar("ui:mãos-livres", "pausado (" + motivo + ")");
    if (aviso) C.mensagem(aviso, 7000);
  }
  function mlRetomar() {
    ml.ligado = true; ml.rapidas = 0; ml.surdos = 0; ml.ultimaNav = Date.now();
    clearTimeout(ml.timerVoltar);
    D.registrar("ui:mãos-livres", "retomado no toque");
    mlEstado("ouvindo"); mlArmarIdle();
    clearTimeout(ml.timer); ml.timer = null;
    mlCiclo();
  }
  function mlPararCiclo(m) { const h = ml.h; ml.h = null; if (h) h.parar(m); }
  function appFalando() {
    try { return !!(C.voz.emAlerta() || (C.voz.emManobra && C.voz.emManobra()) || (C.voz.falando && C.voz.falando()) || (C.voz.sintetizando && C.voz.sintetizando())); }
    catch (e) { return false; }
  }
  function mlAgendar(ms) { if (!ml.ligado || ml.estado === "pausado") return; clearTimeout(ml.timer); ml.timer = setTimeout(mlCiclo, ms); }
  function mlCiclo() {
    ml.timer = null;
    if (!ml.ligado || ml.estado === "pausado" || ml.h) return;
    if (document.visibilityState === "hidden") return;
    // outra escuta (Falar, "É o mesmo?", pergunta) ou o app falando: espera (sem ouvir a si mesmo)
    if (appFalando()) ml.falaAte = Date.now() + ML.APOS_FALA_MS;
    if (ouvindo || appFalando() || Date.now() < ml.falaAte) { mlEstado("esperando"); mlAgendar(ML.ESPERA_MS); return; }
    mlEstado("ouvindo");
    const ciclo = { t0: Date.now(), abriu: false, h: null };
    const meu = { parar: (m) => { if (ciclo.h) ciclo.h.parar(m); } };
    ml.h = meu;
    ciclo.h = escuta.escutar({ maxMs: ML.MAX_MS, surdoMs: ML.SURDO_MS, estenderParcialMs: ML.PARCIAL_MS, fimSilencioMs: FIM_FALA_MS, rotulo: "(mãos-livres)",
      aoOuvindo: () => { ciclo.abriu = true; },
      aoTerminar: (res) => {
        if (ml.h === meu) ml.h = null;
        mlFimCiclo(ciclo, res);
      } });
  }
  function mlFimCiclo(ciclo, res) {
    if (!ml.ligado || ml.estado === "pausado") return;
    const m = res.motivo;
    if (m === "cancelado" || m === "fala" || m === "alerta") { mlAgendar(ML.REINICIO_MS); return; }
    if (res.textos.length) { ml.rapidas = 0; ml.surdos = 0; mlFrase(res.textos); mlAgendar(ML.REINICIO_MS); return; }
    // recusa ou falha que não passa sozinha (sem gesto: not-allowed; Siri desligada, microfone ocupado, sem internet…)
    if (m === "permissao" || m === "servico" || m === "microfone" || m === "rede" || m === "idioma" || m === "erro" || m === "indisponivel") {
      mlPausar(m, Cmd.mensagemEscuta(res, D.ambiente()));
      return;
    }
    // o microfone nem abriu, rápido e seguidas vezes: o aparelho está recusando (provável exigência de toque)
    if (!ciclo.abriu && Date.now() - ciclo.t0 < ML.RAPIDA_MS) {
      if (++ml.rapidas >= ML.FALHAS) { mlPausar("recusou sem toque", "O iPhone parou de ouvir sozinho. Toque para voltar a ouvir."); return; }
    } else ml.rapidas = 0;
    // sessões abertas sem som nenhum, uma atrás da outra (sessão surda do iOS 26/27)
    if (m === "silencio" || m === "surdo") {
      if (++ml.surdos >= ML.SURDOS) { mlPausar("sem som", "O microfone não está mandando som. Toque para voltar a ouvir."); return; }
    } else ml.surdos = 0;
    mlAgendar(ML.REINICIO_MS);
  }
  // Frase ouvida pelo mãos-livres: resposta da pergunta aberta, "Copiloto, <comando>", "Copiloto" sozinho ou nada
  function mlFrase(textos) {
    const c = Cmd.chamadaEmAlternativas(textos);
    if (pergunta) {
      const resp = c.chamou ? c.restos.filter(Boolean) : textos;
      if (resp.length && responder(resp)) { ml.armadoAte = 0; return; }
    }
    if (c.chamou && !c.resto) {
      ml.armadoAte = Date.now() + ML.ARMADO_MS;
      D.registrar("ui:mãos-livres", "chamado");
      C.voz.bipe("inicio");
      C.mensagem("Pode falar.", 4000);
      return;
    }
    if (c.chamou || Date.now() < ml.armadoAte) {
      ml.armadoAte = 0;
      D.registrar("ui:mãos-livres", "comando");
      executar(c.chamou ? c.restos.filter(Boolean) : textos, null);
      return;
    }
    D.registrar("ui:mãos-livres ignorou", "sem “Copiloto”");
  }
  function mlArmarIdle() {
    clearInterval(ml.timerIdle);
    ml.timerIdle = setInterval(() => {
      if (!ml.ligado) return;
      if (C.navegacao && C.navegacao.ativa && C.navegacao.ativa()) { ml.ultimaNav = Date.now(); return; }
      if (Date.now() - ml.ultimaNav >= semNavMs()) mlDesligar("sem navegação", "Mãos-livres desligado: " + Math.max(1, Math.round(semNavMs() / 60000)) + " min sem navegação.");
    }, Math.max(200, Math.min(30000, semNavMs() / 4)));
  }
  // app fechado ou em segundo plano: desliga; na volta fica pausado (um toque religa) por 2 min
  function mlSegundoPlano() {
    if (!ml.ligado) return;
    mlDesligar("segundo plano");
    ml.voltar = true;
  }
  function mlPrimeiroPlano() {
    if (!ml.voltar) return;
    ml.voltar = false; ml.ligado = true;
    mlEstado("pausado");
    D.registrar("ui:mãos-livres", "volta do segundo plano: pausado");
    C.mensagem("Mãos-livres pausado. Toque em “Toque para voltar a ouvir”.", 6000);
    clearTimeout(ml.timerVoltar);
    ml.timerVoltar = setTimeout(() => { if (ml.estado === "pausado") mlDesligar("não voltou"); }, ML.VOLTAR_MS);
  }
  function criarIndicadorMl() {
    elMl = document.createElement("button");
    elMl.type = "button"; elMl.id = "cmd-ml"; elMl.className = "cmd-ml"; elMl.hidden = true;
    elMl.dataset.semDestravar = "";
    elMl.append(el("span", "cmd-ml-ponto"), el("span", "cmd-ml-texto", "Copiloto"));
    elMl.addEventListener("click", () => { if (ml.estado === "pausado") mlRetomar(); else mlDesligar("toque", "Mãos-livres desligado."); });
    const pai = $("painel-mapa") || document.querySelector("main") || document.body;
    pai.appendChild(elMl);
    mlDesenhar();
    window.addEventListener("resize", mlPosicionar);
    const acoes = document.querySelector(".acoes");
    if (acoes && typeof MutationObserver !== "undefined") new MutationObserver(mlPosicionar).observe(acoes, { attributes: true, subtree: true, attributeFilter: ["style", "hidden", "class"] });
    for (const ev of ["navegacao", "folha", "alerta", "alerta-fechado", "aba", "fachada:aberta", "fachada:fechada", "mapa-estilo"]) C.on(ev, () => setTimeout(mlPosicionar, 0));
    // a faixa da manobra e o alerta mudam de altura sem evento próprio: confere a cada 2 s enquanto ligado
    setInterval(() => { if (ml.ligado) mlPosicionar(); }, 2000);
  }

  // ouvindo(): true enquanto o reconhecimento de fala está ativo (toque em "Falar" ou resposta ao "É o mesmo?"). M3 (QA3):
  // a navegação usa para adiar a fala de manobra (o microfone ouviria a própria fala e ela se perderia).
  C.comandos = { ouvir: tocar, pararEscuta: (m) => { const tinha = !!ouvindo || !!(sessao && sessao.escuta); pararEscuta(m || "cancelado"); if (sessao && sessao.escuta) sessao.escuta.parar(m || "cancelado"); return tinha; }, executar: (t) => executar([].concat(t), null), disponivel: () => escuta.disponivel(), ouvindo: () => !!ouvindo,
    alternativa: () => abrirAlternativa({}),
    // pergunta por voz com resposta na tela (destino por km: "Qual estado?", ui/km.js): tratar(textos) → true se respondeu; id = elemento vivo da pergunta
    perguntar,
    // mãos-livres: ligar() precisa vir de um toque; estado(): "desligado" | "ouvindo" | "esperando" | "pausado"
    maosLivres: { ligar: mlLigar, desligar: () => mlDesligar("pedido"), estado: () => ml.estado, ligado: () => ml.ligado } };

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
    // ui/voz.js destrava a fala também neste toque (enunciado mudo antes de o microfone abrir)
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
    criarIndicadorMl();
    C.on("voz:falar", () => {
      if (!ml.ligado) return;
      ml.falaAte = Date.now() + ML.APOS_FALA_MS;
      if (ml.h) { D.registrar("ui:mãos-livres", "pausa: o app vai falar"); mlPararCiclo("fala"); }
      mlAgendar(ML.ESPERA_MS);
    });
    C.on("navegacao", (d) => { if (d && d.ativa) ml.ultimaNav = Date.now(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") mlSegundoPlano(); else mlPrimeiroPlano(); });
    window.addEventListener("pagehide", mlSegundoPlano);
    C.on("aba", (id) => { if (id === "conta") desenharDiag(); });

    C.on("alerta", (d) => {
      ultimaDistAlerta = d.distanciaM;
      // alerta de segurança tem prioridade: corta a escuta (senão o reconhecedor ouviria a própria fala do alerta)
      if (d.abriu && ouvindo) { pararEscuta("alerta"); C.mensagem("Escuta interrompida pelo alerta.", 4000); }
      if (d.abriu && sessao && sessao.escuta) sessao.escuta.parar("alerta");
      if (d.abriu && ml.h) mlPararCiclo("alerta");
    });
    C.on("alerta-fechado", () => { ultimaDistAlerta = null; });
    C.on("folha", aoMudarFolha);
    C.on("folha", aoMudarFolhaPergunta);
    C.on("relato-enviado", () => { if (sessao) { encerrarSessao(); confirmar(); } });
    C.on("fila", () => { if (sessao && !C.folha.aberta()) { encerrarSessao(); confirmar(); } });
    C.on("voto", () => { if (votoPorVoz) { votoPorVoz = false; C.voz.bipe("ok"); } });
    C.on("sessao", () => { encerrarSessao(); });
  });
})(window.Copiloto);
