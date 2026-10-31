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
(function (C) {
  "use strict";
  const { $ } = C.util;
  const Voz = window.CopilotoVoz;
  const falador = Voz.criarFalador();
  const bipador = Voz.criarBipe();
  const prefVoz = Voz.lerPreferencias(C.util.storage());
  let bipeLigado = Voz.lerBipe(C.util.storage());
  let vozDestravada = false, contAgradecimento = 0;
  let ultimaFala = null, falaAlerta = null, falaManobra = null;
  const MSG_INDISPONIVEL = "Voz indisponível neste aparelho. Os alertas continuam na tela.";

  // Guarda a última fala para saber quando o alerta de segurança terminou de ser falado.
  function falar(texto, opcoes) {
    if (!prefVoz.ligada) return false;
    if (opcoes && opcoes.naoInterromper && ocupada()) return esperarAlerta(texto, opcoes);
    const fala = { texto: String(texto), t: Date.now(), terminou: false };
    const aoTerminar = () => { fala.terminou = true; if (opcoes && opcoes.aoTerminar) opcoes.aoTerminar(); };
    const ehManobra = !!(opcoes && opcoes.manobra);
    const cortada = !ehManobra && falando(falaManobra) ? falaManobra : null;
    const ok = falador.falar(texto, { aoTerminar });
    if (ok) { ultimaFala = fala; falaManobra = ehManobra ? fala : null; }
    if (ok && cortada) { cortada.terminou = true; C.emit("voz-manobra-cortada", { texto: cortada.texto }); }
    return ok;
  }
  function falando(f) { return !!(f && !f.terminou && Date.now() < f.t + 1500 + 75 * f.texto.length); }
  // Orientação de manobra ainda sendo falada (cortada por outra fala, o falador avisa o fim e ela deixa de contar).
  function emManobra() { return falando(falaManobra); }
  function ocupada() { return emAlerta() || emManobra(); }
  // Alerta falado: até o fim da fala (onend) ou, se o aparelho não avisar, um tempo estimado pelo tamanho do texto.
  function emAlerta() {
    const f = falaAlerta;
    return !!(f && !f.terminou && Date.now() < f.t + 1500 + 75 * f.texto.length);
  }
  // Falas não críticas na espera do fim do alerta (B7): nunca cortam a frase de segurança. Saem em ordem, uma depois
  // da outra (cada uma espera a anterior da fila terminar); a que espera mais que esperaMaxMs é descartada.
  const fila = [];
  let timerFila = null, falaDaFila = null;
  function esperarAlerta(texto, opcoes) {
    fila.push({ texto, opcoes, ate: Date.now() + (opcoes.esperaMaxMs || 10000) });
    agendarFila();
    return true;
  }
  function agendarFila() { if (!timerFila) timerFila = setTimeout(tentarFila, 150); }
  function tentarFila() {
    timerFila = null;
    while (fila.length && Date.now() > fila[0].ate) fila.shift(); // esperou demais: descarta
    if (!fila.length) return;
    const f = falaDaFila;
    const anteriorFalando = !!(f && !f.terminou && Date.now() < f.t + 1500 + 75 * f.texto.length);
    if (ocupada() || anteriorFalando) { agendarFila(); return; }
    const p = fila.shift();
    if (falar(p.texto, Object.assign({}, p.opcoes, { naoInterromper: false }))) falaDaFila = ultimaFala;
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
    $("voz-msg").textContent = falador.disponivel() ? "" : MSG_INDISPONIVEL;
  }
  function salvar() { const s = C.util.storage(); if (s) Voz.gravarPreferencias(s, prefVoz); desenhar(); }

  C.voz = { falar, preferencias: () => Object.assign({}, prefVoz), falador, disponivel: () => falador.disponivel(),
    bipe, bipeLigado: () => bipeLigado, emAlerta, emManobra, falando: () => falando(ultimaFala) };

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

  C.aoIniciar(() => {
    for (const [id, p] of Object.entries(Voz.PERFIS)) $("voz-perfil").add(new Option(p.rotulo, id));
    $("voz-ligada").addEventListener("change", () => {
      prefVoz.ligada = $("voz-ligada").checked;
      salvar();
      if (prefVoz.ligada) {
        // o toque no controle destrava a fala no iPhone
        if (!falador.falar("Voz ativada.")) $("voz-msg").textContent = MSG_INDISPONIVEL;
        else vozDestravada = true;
      }
    });
    $("voz-perfil").addEventListener("change", () => { prefVoz.perfil = $("voz-perfil").value; salvar(); });
    // primeiro toque em qualquer lugar também destrava (Safari exige gesto do usuário)
    document.addEventListener("pointerdown", () => { if (!vozDestravada && prefVoz.ligada && falador.destravar()) vozDestravada = true; }, { once: true, capture: true });
    // depois de um voto aceito: agradecimento no jeito escolhido (o alerta em si é igual em todos os perfis)
    C.on("voto", () => falar(Voz.agradecimento(prefVoz.perfil, contAgradecimento++), { naoInterromper: true }));
    // alerta.js fala o alerta e logo em seguida emite "alerta" com abriu: marca essa fala como alerta de segurança
    C.on("alerta", (d) => { if (d && d.abriu && ultimaFala && Date.now() - ultimaFala.t < 500) falaAlerta = ultimaFala; });
    criarCaixaBipe();
    desenhar();
  });
})(window.Copiloto);
