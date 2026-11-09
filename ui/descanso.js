// Cronômetro de descanso do motorista (lógica pura em descanso.js, window.CopilotoDescanso). ORIENTAÇÃO, não registro oficial.
// Conta direção contínua só com o GPS (velocidade > 5 km/h), em qualquer momento (com ou sem navegação):
//  - pílula discreta no painel da navegação, "Dirigindo há 4h20 · pausa em 1h10" (número grande, tabular), só depois de 2 h
//    de direção ou perto do limite; parado, mostra a pausa que falta ("Em pausa · faltam 18 min");
//  - 30 min antes do limite (5h30 por padrão) e no limite: faixa âmbar com "Postos" (abre a lista de postos com banho
//    confirmado, ui/postos.js) e "Silenciar", mais aviso falado pela fila de falas. Informativo: nada bloqueia a navegação,
//    e a lista de postos só abre por toque (nunca sozinha, com o caminhão andando);
//  - configuração na aba Conta (cartão "Descanso do motorista"): ligar/desligar (padrão ligado), limite, aviso, pausa,
//    aviso falado, "Zerar contagem" e o texto de transparência.
// Guarda em localStorage (tolerante a falha): copiloto.descanso.config.v1 e copiloto.descanso.estado.v1 (a contagem sobrevive
// a recarregar a página). Expõe Copiloto.descanso: estado(), config(), definirConfig(), zerar(), silenciar(), aviso().
// Eventos: descanso:aviso { tipo }, descanso:estado { ... } (a cada mudança de minuto), descanso:config.
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const D = window.CopilotoDescanso;
  const GRAVAR_A_CADA_MS = 15000;

  let cfg = D.lerConfig(C.util.storage());
  let motor = D.criar(cfg, D.lerEstado(C.util.storage()));
  let pilula = null, faixa = null, cartao = null, textoPilula = "", ultimoGravar = 0, silenciado = false, avisoAtual = null;
  const agora = () => Date.now();

  function gravar(forcar) {
    const t = agora();
    if (!forcar && t - ultimoGravar < GRAVAR_A_CADA_MS) return;
    ultimoGravar = t;
    D.gravarEstado(C.util.storage(), motor.exportar());
  }

  // ------------------------------------------------------------ pílula
  function textoDe(e) {
    if (!e.movendo && e.pausaMs >= cfg.paradaMin * 60000 && e.dirMs > 0) {
      return { rot: "Em pausa · faltam", num: D.fmt(e.pausaFaltaMs), sep: "", sec: "", aria: "Em pausa, faltam " + D.fmtFalado(e.pausaFaltaMs) + " para completar a pausa recomendada" };
    }
    if (e.restanteMs <= 0) {
      return { rot: "Dirigindo há", num: D.fmt(e.dirMs), sep: "· pausa", sec: "agora", aria: "Dirigindo há " + D.fmtFalado(e.dirMs) + ", faça uma pausa agora" };
    }
    return { rot: "Dirigindo há", num: D.fmt(e.dirMs), sep: "· pausa em", sec: D.fmt(e.restanteMs),
      aria: "Dirigindo há " + D.fmtFalado(e.dirMs) + ", pausa recomendada em " + D.fmtFalado(e.restanteMs) };
  }
  function desenharPilula(e) {
    if (!pilula) return;
    if (!e.visivel || (faixa && !faixa.hidden)) { if (!pilula.hidden) pilula.hidden = true; textoPilula = ""; return; }
    const t = textoDe(e), chave = [t.rot, t.num, t.sep, t.sec, e.nivel].join("|");
    if (chave === textoPilula && !pilula.hidden) return;
    textoPilula = chave;
    pilula.dataset.nivel = e.nivel;
    pilula.replaceChildren(el("span", "descanso-rot", t.rot), el("b", "descanso-num", t.num));
    if (t.sep) pilula.append(el("span", "descanso-sep", t.sep), el("b", "descanso-sec", t.sec));
    pilula.setAttribute("aria-label", t.aria);
    pilula.hidden = false;
    C.emit("descanso:estado", { dirMs: e.dirMs, restanteMs: e.restanteMs, nivel: e.nivel });
  }

  // ------------------------------------------------------------ aviso (faixa âmbar + fala)
  function esconderFaixa() { avisoAtual = null; if (faixa) faixa.hidden = true; }
  function mostrarFaixa(tipo) {
    avisoAtual = tipo;
    if (!faixa) return;
    const aviso = tipo === "aviso";
    faixa.dataset.tipo = tipo;
    faixa.querySelector(".descanso-aviso-texto").textContent = aviso
      ? "Faltam " + cfg.avisoAntesMin + " min para o limite de direção. Pausa de " + cfg.pausaMin + " min recomendada."
      : "Limite de " + D.fmt(cfg.limiteMin * 60000) + " de direção. Pare " + cfg.pausaMin + " min quando for seguro.";
    faixa.hidden = false;
    if (pilula) pilula.hidden = true;
  }
  function abrirPostos() {
    if (C.postos && C.postos.abrirProximo) C.postos.abrirProximo({ banho: true });
    else C.mensagem("Postos indisponíveis agora.", 4000);
  }
  function silenciar() { silenciado = true; esconderFaixa(); }

  // fala pela fila (não corta alerta, manobra nem microfone); desiste se silenciou ou o aviso mudou
  function falar(tipo) {
    if (!cfg.som || !C.voz || typeof C.voz.falar !== "function") return;
    const ate = agora() + 90000;
    const ocupado = () => (C.voz.falando && C.voz.falando()) || (C.voz.emAlerta && C.voz.emAlerta()) ||
      (C.voz.emManobra && C.voz.emManobra()) || (C.comandos && typeof C.comandos.ouvindo === "function" && C.comandos.ouvindo());
    const tentar = () => {
      if (silenciado || !cfg.ligado || !cfg.som || avisoAtual !== tipo) return;
      if (ocupado()) { if (agora() < ate) setTimeout(tentar, 400); return; }
      C.voz.falar(D.textoAviso(tipo, cfg), { naoInterromper: true, esperaMaxMs: 8000 });
    };
    tentar();
  }
  function avisar(tipo) {
    if (silenciado) return;
    mostrarFaixa(tipo);
    if (!C.navegacao || !C.navegacao.ativa || !C.navegacao.ativa()) C.mensagem(faixa.querySelector(".descanso-aviso-texto").textContent, 8000);
    falar(tipo);
    C.emit("descanso:aviso", { tipo });
  }

  // ------------------------------------------------------------ leituras do GPS
  function processar(t) {
    const e = motor.estado(t);
    if (e.dirMs === 0 && silenciado) silenciado = false;      // janela nova: os avisos voltam a valer
    if (e.nivel === "ok" && avisoAtual) esconderFaixa();     // pausa feita: a faixa sai
    for (const tipo of motor.eventos()) avisar(tipo);
    desenharPilula(motor.estado(t));
    gravar(false);
    atualizarCartao(e);
  }
  function aoPosicao(g) {
    if (!cfg.ligado || !g) return;
    const t = typeof g.recebidoEm === "number" ? g.recebidoEm : agora();
    motor.amostra(t, g.kmh != null ? g.kmh : g.velKmh);
    processar(t);
  }

  // ------------------------------------------------------------ configuração (aba Conta)
  const OP_LIMITE = [270, 300, 330, 360];
  const OP_AVISO = [15, 30, 45, 60];
  const OP_PAUSA = [15, 30, 45];
  const rotMin = (m) => (m >= 60 ? D.fmt(m * 60000) : m + " min");
  let elStatus = null;
  function atualizarCartao(e) {
    if (!elStatus) return;
    const ev = e || motor.estado(agora());
    elStatus.textContent = !cfg.ligado ? "Desligado." : ev.semSinal ? "Sem leitura recente do GPS: contagem parada."
      : "Agora: dirigindo há " + D.fmt(ev.dirMs) + (ev.restanteMs > 0 ? " · pausa recomendada em " + D.fmt(ev.restanteMs) : " · faça uma pausa");
  }
  function seletor(id, rotulo, opcoes, atual, aoMudar) {
    const l = el("label"); l.htmlFor = id; l.append(rotulo);
    const s = document.createElement("select"); s.id = id;
    const lista = opcoes.includes(atual) ? opcoes : opcoes.concat(atual).sort((a, b) => a - b);
    for (const m of lista) s.add(new Option(rotMin(m), String(m)));
    s.value = String(atual);
    s.addEventListener("change", () => aoMudar(Number(s.value)));
    l.append(s);
    return l;
  }
  function definirConfig(novo) {
    cfg = D.normalizarConfig(Object.assign({}, cfg, novo));
    motor.definirConfig(cfg);
    D.gravarConfig(C.util.storage(), cfg);
    if (!cfg.ligado) { esconderFaixa(); if (pilula) pilula.hidden = true; textoPilula = ""; }
    else processar(agora());
    C.emit("descanso:config", Object.assign({}, cfg));
    return cfg;
  }
  function zerar() {
    motor.zerar(agora()); silenciado = false; esconderFaixa(); textoPilula = "";
    gravar(true); processar(agora());
  }
  function criarCartao() {
    const tela = $("tela-conta");
    if (!tela || $("descanso-cartao")) return;
    cartao = el("div", "cartao descanso-cartao"); cartao.id = "descanso-cartao";
    const linha = (id, texto, marcado, aoMudar) => {
      const r = el("label", "linha-check"); r.htmlFor = id;
      const cx = document.createElement("input"); cx.type = "checkbox"; cx.id = id; cx.checked = marcado;
      cx.addEventListener("change", () => aoMudar(cx.checked));
      r.append(cx, " " + texto); return r;
    };
    elStatus = el("p", "descanso-status"); elStatus.id = "descanso-status"; elStatus.setAttribute("role", "status");
    const zer = botao("Zerar contagem", "btn", zerar); zer.id = "descanso-zerar";
    const transp = el("p", "dica", D.TEXTO_TRANSPARENCIA); transp.id = "descanso-transparencia";
    cartao.append(el("h2", null, "Descanso do motorista"),
      linha("descanso-ligado", "Cronômetro de descanso (só orientação)", cfg.ligado, (v) => definirConfig({ ligado: v })),
      linha("descanso-som", "Aviso falado", cfg.som, (v) => definirConfig({ som: v })),
      seletor("descanso-limite", "Aviso de direção contínua em", OP_LIMITE, cfg.limiteMin, (v) => definirConfig({ limiteMin: v })),
      seletor("descanso-antes", "Avisar antes do limite", OP_AVISO, cfg.avisoAntesMin, (v) => definirConfig({ avisoAntesMin: v })),
      seletor("descanso-pausa", "Pausa recomendada", OP_PAUSA, cfg.pausaMin, (v) => definirConfig({ pausaMin: v })),
      elStatus,
      zer, transp);
    const ant = $("limite-cartao") || $("cartao-voz");
    if (ant && ant.parentNode === tela) ant.after(cartao); else tela.appendChild(cartao);
    atualizarCartao();
  }

  // ------------------------------------------------------------ elementos da navegação
  function criarElementos() {
    const p = $("nav-painel"); if (!p || pilula) return;
    pilula = el("div", "descanso-pilula"); pilula.id = "descanso-pilula"; pilula.hidden = true; pilula.setAttribute("role", "status"); pilula.setAttribute("aria-live", "off");
    faixa = el("div", "descanso-aviso"); faixa.id = "descanso-aviso"; faixa.hidden = true; faixa.setAttribute("role", "status"); faixa.setAttribute("aria-live", "polite");
    const botoes = el("div", "descanso-aviso-botoes");
    const bp = botao("Postos", "btn descanso-postos", abrirPostos); bp.id = "descanso-postos";
    const bs = botao("Silenciar", "btn descanso-silenciar", silenciar); bs.id = "descanso-silenciar";
    botoes.append(bp, bs);
    faixa.append(el("span", "descanso-aviso-texto"), botoes);
    const ref = $("km-atual") || $("nav-seguinte");
    if (ref && ref.parentNode === p) { ref.after(pilula); pilula.after(faixa); } else p.append(pilula, faixa);
  }

  C.descanso = {
    estado: () => motor.estado(agora()),
    config: () => Object.assign({}, cfg),
    definirConfig, zerar, silenciar,
    aviso: () => avisoAtual,
  };

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/descanso.css");
    criarElementos();
    criarCartao();
    C.on("posicao", aoPosicao);
    window.addEventListener("pagehide", () => gravar(true));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") gravar(true); });
    window.setInterval(() => { if (cfg.ligado) atualizarCartao(); }, 30000);
  });
})(window.Copiloto);
