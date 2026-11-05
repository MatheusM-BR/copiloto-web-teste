// Voz: configuração (cartão na aba Conta, funciona deslogado), destravar no iPhone e agradecimento depois do voto.
// Expõe Copiloto.voz: falar(texto, { aoTerminar }) (só se a voz estiver ligada), preferencias(), falador, disponivel(),
// bipe(nome) (bipe de rádio "inicio" | "fim" | "ok"; não toca com o bipe desligado nem durante um alerta falado),
// bipeLigado(), emAlerta() (true enquanto o alerta de segurança está sendo falado; outras falas e bipes esperam).
// falar(texto, { naoInterromper: true }): fala não crítica. Com um alerta sendo falado, espera ele acabar (até
// esperaMaxMs, padrão 10 s; depois descarta). As que esperam saem em ordem, uma de cada vez.
// falar(texto, { manobra: true }): orientação de manobra (navegação). Enquanto ela é falada, as falas não críticas
// também esperam (M1: "Obrigado", "Mapa simples", "Recalculando." não cortam "Vire à direita…" no meio).
// Uma fala que não é de manobra e começa com a orientação ainda tocando (resposta de comando de voz, alerta) a corta:
// emite "voz-manobra-cortada" ({ texto }) para a navegação repetir a etapa (QA 3, M3). falando(): alguma fala tocando.
// Voz no iPhone: calar() cancela a fala antes de abrir o microfone; as falas da fila esperam comandos.ouvindo();
// sintetizando() = fala nossa em curso (relógio próprio, não o speechSynthesis.speaking, que fica preso em true no iOS).
// Destravar: pointerup e click (captura) em qualquer lugar, inclusive o "Falar"; só os botões com [data-sem-destravar]
// (Testar voz, aviso "Sem som") cuidam do próprio destravar. Repete a cada toque até um onstart/onend real chegar; depois de
// 2 toques sem fala, mostra "Toque aqui para ativar o som". Um <audio> mudo em laço mantém a sessão em playback (modo
// silencioso); microfone(aberto) o pausa com o microfone aberto.
// falar(texto, { critica: true }): segurança/chegada. Nunca descartada por tempo na fila; com o microfone aberto, aborta a
// escuta e fala (com { manobra: true } fala já; com { naoInterromper: true } espera só alerta/manobra em curso).
// falar sem manobra/crítica e com { naoInterromper }: também espera a fala anterior acabar (não corta a frase de ninguém).
// falar(texto, { conversa: true }): conversa pelo caminho (marcos, "Continue por…"); no modo "Só alertas" não sai (falar devolve false).
// Copiloto.voz.modo() / definirModo("tudo"|"alertas"): modo de fala, persistente em copiloto.voz.v1; emite "voz:modo".
// Emite "voz:falar" ({ texto, manobra }) logo antes de cada fala (o mãos-livres do E4 fecha o microfone).
(function (C) {
  "use strict";
  const { $ } = C.util;
  const Voz = window.CopilotoVoz;
  const falador = Voz.criarFalador();
  const bipador = Voz.criarBipe();
  const prefVoz = Voz.lerPreferencias(C.util.storage());
  let bipeLigado = Voz.lerBipe(C.util.storage());
  let contAgradecimento = 0, toquesSemFala = 0, avisoSemSom = null;
  let ultimaFala = null, falaAlerta = null, falaManobra = null;
  const MSG_INDISPONIVEL = "Voz indisponível neste aparelho. Os alertas continuam na tela.";

  // Guarda a última fala para saber quando o alerta de segurança terminou de ser falado.
  function falar(texto, opcoes) {
    if (!prefVoz.ligada) return false;
    const op = opcoes || {};
    if (!Voz.permiteFala(prefVoz.modo, texto, op)) return false; // "Só alertas": conversa não sai
    const critica = !!op.critica;
    // crítica (manobra "agora", chegada, restrição): o microfone aberto (ou surdo) não pode emudecê-la. Só espera quem
    // aceita esperar (naoInterromper) e há alerta/manobra falando.
    if (critica && microfoneAberto() && !(op.naoInterromper && ocupada())) abortarMicrofone();
    if (op.naoInterromper && (ocupada() || (!critica && (microfoneAberto() || falando(ultimaFala))))) return esperarAlerta(texto, op);
    const fala = { texto: String(texto), t: Date.now(), terminou: false };
    const aoTerminar = () => { fala.terminou = true; if (op.aoTerminar) op.aoTerminar(); };
    const ehManobra = !!op.manobra;
    const cortada = !ehManobra && falando(falaManobra) ? falaManobra : null;
    // mãos-livres (ui/comandos.js): a escuta contínua fecha o microfone antes de o app falar (não ouve a si mesmo)
    C.emit("voz:falar", { texto: String(texto), manobra: ehManobra });
    const ok = falador.falar(texto, { aoTerminar });
    if (ok) { ultimaFala = fala; falaManobra = ehManobra ? fala : null; }
    if (ok && cortada) { cortada.terminou = true; C.emit("voz-manobra-cortada", { texto: cortada.texto }); }
    return ok;
  }
  function abortarMicrofone() {
    try { if (C.comandos && typeof C.comandos.pararEscuta === "function") { C.comandos.pararEscuta("cancelado"); C.mensagem("Escuta interrompida para avisar.", 4000); } } catch (e) { /* ignora */ }
  }
  function falando(f) { return !!(f && !f.terminou && Date.now() < f.t + 1500 + 75 * f.texto.length); }
  // Orientação de manobra ainda sendo falada (cortada por outra fala, o falador avisa o fim e ela deixa de contar).
  function emManobra() { return falando(falaManobra); }
  function ocupada() { return emAlerta() || emManobra(); }
  // Microfone do comando de voz aberto (E4): as falas da fila esperam (o reconhecimento ouviria a fala e a perderia).
  function microfoneAberto() { return !!(C.comandos && typeof C.comandos.ouvindo === "function" && C.comandos.ouvindo()); }
  // Cala a fala de agora antes de abrir o microfone (ou a pedido: "silencia", "Falar" durante o alerta). Orientação de
  // manobra cortada: a navegação repete depois, a não ser que opcoes.definitivo (o motorista mandou calar).
  function calar(opcoes) {
    const definitivo = !!(opcoes && opcoes.definitivo);
    const cortada = falando(falaManobra) ? falaManobra : null;
    if (ultimaFala) ultimaFala.terminou = true;
    if (falaAlerta) falaAlerta.terminou = true;
    if (cortada) cortada.terminou = true;
    const ok = falador.cancelar();
    if (cortada) { falaManobra = null; if (!definitivo) C.emit("voz-manobra-cortada", { texto: cortada.texto }); }
    if (definitivo) { for (let i = fila.length - 1; i >= 0; i--) if (!fila[i].opcoes.critica) fila.splice(i, 1); } // as críticas continuam
    return ok;
  }
  // Alerta falado: até o fim da fala (onend) ou, se o aparelho não avisar, um tempo estimado pelo tamanho do texto.
  function emAlerta() {
    const f = falaAlerta;
    return !!(f && !f.terminou && Date.now() < f.t + 1500 + 75 * f.texto.length);
  }
  // Falas não críticas na espera do fim do alerta (B7): nunca cortam a frase de segurança. Saem em ordem, uma depois
  // da outra (cada uma espera a anterior da fila terminar); a que espera mais que esperaMaxMs é descartada.
  const fila = [];
  let timerFila = null, falaDaFila = null;
  // Crítica (segurança, chegada): nunca descartada por tempo; passa na frente das não críticas.
  function esperarAlerta(texto, opcoes) {
    const item = { texto, opcoes, ate: opcoes.critica ? Infinity : Date.now() + (opcoes.esperaMaxMs || 10000) };
    if (opcoes.critica) { const i = fila.findIndex((x) => !x.opcoes.critica); if (i < 0) fila.push(item); else fila.splice(i, 0, item); }
    else fila.push(item);
    agendarFila();
    return true;
  }
  function agendarFila() { if (!timerFila) timerFila = setTimeout(tentarFila, 150); }
  function tentarFila() {
    timerFila = null;
    const agora = Date.now();
    for (let i = fila.length - 1; i >= 0; i--) if (agora > fila[i].ate) fila.splice(i, 1); // esperou demais: descarta
    if (!fila.length) return;
    const f = falaDaFila;
    const anteriorFalando = !!(f && !f.terminou && Date.now() < f.t + 1500 + 75 * f.texto.length);
    if (ocupada() || anteriorFalando) { agendarFila(); return; }
    const critica = !!fila[0].opcoes.critica;
    if (microfoneAberto()) { if (!critica) { agendarFila(); return; } abortarMicrofone(); }
    const p = fila.shift();
    if (falar(p.texto, Object.assign({}, p.opcoes, { naoInterromper: false, critica: false }))) falaDaFila = ultimaFala;
    if (fila.length) agendarFila();
  }
  function bipe(nome) {
    if (!bipeLigado || emAlerta()) return false;
    return bipador.tocar(nome);
  }

  function desenhar() {
    $("voz-ligada").checked = prefVoz.ligada;
    $("voz-perfil").value = prefVoz.perfil;
    $("voz-perfil").disabled = !prefVoz.ligada;
    desenharModo();
    $("voz-msg").textContent = falador.disponivel() ? "" : MSG_INDISPONIVEL;
  }
  function salvar() { const s = C.util.storage(); if (s) Voz.gravarPreferencias(s, prefVoz); desenhar(); }

  // Seletor "Quanto falar" (criado aqui, como a caixa do bipe): dois botões grandes com símbolo (radiogroup).
  function desenharModo() {
    const g = $("voz-modo"); if (!g) return;
    for (const b of g.querySelectorAll("[data-modo]")) {
      const v = b.dataset.modo === prefVoz.modo;
      b.setAttribute("aria-checked", String(v)); b.classList.toggle("escolhido", v); b.disabled = !prefVoz.ligada;
    }
    const d = $("voz-modo-dica"); if (d) d.textContent = Voz.MODOS[prefVoz.modo].dica + ".";
  }
  // Muda o modo (botão ou comando de voz). Devolve a frase de confirmação.
  function definirModo(modo, opcoes) {
    if (!Voz.MODOS[modo]) return null;
    const mudou = prefVoz.modo !== modo;
    prefVoz.modo = modo;
    const s = C.util.storage(); if (s) Voz.gravarPreferencias(s, prefVoz);
    desenharModo();
    if (mudou) C.emit("voz:modo", { modo });
    return modo === "alertas" ? "Só alertas." : "Falando tudo.";
  }
  function criarSeletorModo() {
    const cartao = $("cartao-voz");
    if (!cartao || $("voz-modo")) return;
    const rot = document.createElement("p"); rot.className = "voz-modo-titulo"; rot.id = "voz-modo-titulo"; rot.textContent = "Quanto falar";
    const g = document.createElement("div"); g.id = "voz-modo"; g.className = "voz-modo"; g.setAttribute("role", "radiogroup"); g.setAttribute("aria-labelledby", "voz-modo-titulo");
    for (const [id, m] of Object.entries(Voz.MODOS)) {
      const b = document.createElement("button"); b.type = "button"; b.dataset.modo = id; b.className = "voz-modo-btn";
      b.setAttribute("role", "radio"); b.setAttribute("aria-label", m.rotulo + ". " + m.dica);
      b.innerHTML = window.CopilotoIcones.svg(m.simbolo, { classe: "voz-modo-ico" }) + '<span class="voz-modo-nome"></span>';
      b.querySelector(".voz-modo-nome").textContent = m.rotulo;
      b.addEventListener("click", () => {
        definirModo(id);
        if (prefVoz.ligada) { falador.destravar(); falador.falar(id === "alertas" ? "Só alertas." : "Falando tudo."); }
      });
      g.appendChild(b);
    }
    const d = document.createElement("p"); d.className = "dica"; d.id = "voz-modo-dica";
    const perfil = $("voz-perfil") && $("voz-perfil").closest("label");
    if (perfil && perfil.parentNode === cartao) perfil.before(rot, g, d); else cartao.append(rot, g, d);
  }

  C.voz = { modo: () => prefVoz.modo, definirModo, falar, preferencias: () => Object.assign({}, prefVoz), falador, disponivel: () => falador.disponivel(),
    bipe, bipeLigado: () => bipeLigado, emAlerta, emManobra, falando: () => falando(ultimaFala),
    calar, sintetizando: () => falador.falando(),
    // microfone abrindo/fechando (ui/comandos.js): o áudio mudo em laço sai enquanto o microfone está aberto
    microfone: (aberto) => { if (aberto) falador.pausarSilencio(); else if (document.visibilityState !== "hidden") falador.retomarSilencio(); },
    destravado: () => falador.destravado() };

  // Caixa "Bipe de rádio" no cartão de voz (criada aqui para não mexer no index.html)
  function criarCaixaBipe() {
    const cartao = $("cartao-voz");
    if (!cartao || $("voz-bipe")) return;
    const rot = document.createElement("label"); rot.className = "linha-check"; rot.htmlFor = "voz-bipe";
    const cx = document.createElement("input"); cx.type = "checkbox"; cx.id = "voz-bipe"; cx.checked = bipeLigado;
    rot.append(cx, " Bipe de rádio no comando de voz");
    const perfil = $("voz-perfil") && $("voz-perfil").closest("label");
    if (perfil && perfil.parentNode === cartao) perfil.after(rot); else cartao.appendChild(rot);
    cx.addEventListener("change", () => {
      bipeLigado = cx.checked;
      const st = C.util.storage(); if (st) Voz.gravarBipe(st, bipeLigado);
      if (bipeLigado) bipador.tocar("ok"); // o toque destrava o áudio e mostra como soa
    });
  }

  // Fala perdida (iPhone mudo/bloqueado/sem gesto): avisa na tela e oferece "Toque para ativar o som". Antes o app
  // ficava mudo sem dizer nada.
  function criarAvisoSemSom() {
    if ($("aviso-sem-som")) return;
    const b = document.createElement("button");
    b.id = "aviso-sem-som"; b.type = "button"; b.hidden = true; b.setAttribute("data-sem-destravar", "");
    b.setAttribute("aria-live", "polite");
    b.textContent = "🔇 Sem som. Toque aqui para ativar a voz";
    avisoSemSom = b;
    b.addEventListener("click", () => {
      b.hidden = true; toquesSemFala = 0;
      falador.destravar();
      if (!falador.falar("Voz ativada. Se não ouviu, aumente o volume e desligue o modo silencioso.")) b.hidden = false;
    });
    document.body.appendChild(b);
    falador.aoFalhar((d) => {
      if (!prefVoz.ligada) return;
      b.textContent = "🔇 Sem som. Toque aqui para ativar a voz";
      b.hidden = false;
      C.emit("voz:falhou", d);
    });
    // quando uma fala começa de verdade, o aviso some
    // não fica para sempre por cima dos botões: some sozinho em 15 s (volta na próxima falha)
    setInterval(() => { if (b.hidden) { b._desde = 0; return; } if (!b._desde) b._desde = Date.now(); else if (Date.now() - b._desde > 15000) { b.hidden = true; b._desde = 0; } }, 1000);
    setInterval(() => { if (!b.hidden && b.dataset.motivo === "toque" && falador.destravado()) b.hidden = true; }, 1000);
    setInterval(() => { if (!b.hidden && falador.estado.iniciadas > (b._ini || 0) && falador.falando()) b.hidden = true; b._ini = falador.estado.iniciadas; }, 1500);
  }
  function criarBotaoTestar() {
    const cartao = $("cartao-voz");
    if (!cartao || $("voz-testar")) return;
    const bt = document.createElement("button");
    bt.id = "voz-testar"; bt.type = "button"; bt.className = "btn-secundario"; bt.setAttribute("data-sem-destravar", "");
    bt.textContent = "Testar voz";
    bt.addEventListener("click", () => {
      falador.destravar();
      const ok = falador.falar("Teste de voz do Copiloto. Se você está ouvindo isto, os alertas vão funcionar.");
      $("voz-msg").textContent = ok ? "Falando… se não ouvir nada, aumente o volume e desligue o modo silencioso do iPhone." : MSG_INDISPONIVEL;
    });
    cartao.appendChild(bt);
  }

  C.aoIniciar(() => {
    for (const [id, p] of Object.entries(Voz.PERFIS)) $("voz-perfil").add(new Option(p.rotulo, id));
    $("voz-ligada").addEventListener("change", () => {
      prefVoz.ligada = $("voz-ligada").checked;
      salvar();
      if (prefVoz.ligada) {
        // o toque no controle destrava a fala no iPhone
        falador.destravar();
        if (!falador.falar("Voz ativada.")) $("voz-msg").textContent = MSG_INDISPONIVEL;
      } else falador.pararSilencio();
    });
    $("voz-perfil").addEventListener("change", () => { prefVoz.perfil = $("voz-perfil").value; salvar(); });
    // Destravar (Safari exige gesto do usuário): pointerup e click, na captura, em qualquer lugar, inclusive no "Falar"
    // (o enunciado mudo sai antes de o microfone abrir). Repete a cada toque até um onstart/onend real chegar; depois de
    // 2 toques sem fala, o aviso "Toque aqui para ativar o som". Os botões com [data-sem-destravar] cuidam do próprio.
    const destravarNoToque = (ev) => {
      const alvo = ev && ev.target && ev.target.closest ? ev.target.closest("[data-sem-destravar]") : null;
      if (alvo || !prefVoz.ligada || !falador.disponivel()) return;
      if (falador.destravado()) {
        toquesSemFala = 0;
        if (avisoSemSom && avisoSemSom.dataset.motivo === "toque") avisoSemSom.hidden = true;
        // fala destravada; o áudio mudo em laço pode precisar de mais um toque (play() recusado)
        if (falador.estado.silencio || tentouSilencio > 2) { document.removeEventListener("pointerup", destravarNoToque, true); document.removeEventListener("click", destravarNoToque, true); }
        else { tentouSilencio++; falador.iniciarSilencio(); }
        return;
      }
      falador.destravar();
      // conta o gesto uma vez (pointerup); o click que vem junto não conta de novo
      if (ev.type === "pointerup" && ++toquesSemFala >= 2 && avisoSemSom) {
        setTimeout(() => {
          if (falador.destravado() || !avisoSemSom) return;
          avisoSemSom.textContent = "🔇 Toque aqui para ativar o som"; avisoSemSom.dataset.motivo = "toque"; avisoSemSom.hidden = false;
        }, 400);
      }
    };
    let tentouSilencio = 0;
    document.addEventListener("pointerup", destravarNoToque, true);
    document.addEventListener("click", destravarNoToque, true);
    // fora da tela o áudio mudo em laço para (bateria); na volta, retoma
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") falador.pausarSilencio(); else if (!microfoneAberto()) falador.retomarSilencio(); });
    // depois de um voto aceito: agradecimento no jeito escolhido (o alerta em si é igual em todos os perfis)
    C.on("voto", () => falar(Voz.agradecimento(prefVoz.perfil, contAgradecimento++), { naoInterromper: true }));
    // alerta.js fala o alerta e logo em seguida emite "alerta" com abriu: marca essa fala como alerta de segurança
    C.on("alerta", (d) => { if (d && d.abriu && ultimaFala && Date.now() - ultimaFala.t < 500) falaAlerta = ultimaFala; });
    criarSeletorModo();
    criarCaixaBipe();
    criarAvisoSemSom();
    criarBotaoTestar();
    desenhar();
  });
})(window.Copiloto);
