// Aba Voz (lote 2 do redesenho, Stitch P2.6): a central de voz numa tela só (#tela-voz), na barra de abas e no menu de Configurações
// (#cfg-voz). Reúne o que já existia, sem lógica nova:
//  - aviso do som do iPhone (#voz-aviso-som, só enquanto a fala não está destravada) e o "Toque aqui para ativar o som" de sempre;
//  - "Quanto falar" (Completo / Só alertas): os mesmos #voz-modo e #voz-modo-dica de ui/voz.js, trazidos para o alto;
//  - botão Falar grande (#voz-falar) que faz o mesmo que o "Falar" do mapa (#cmd-falar) e espelha o estado dele (pronto, abrindo,
//    ouvindo, ok, indisponível); "Comandos por toque" abre a folha "Comando sem voz";
//  - mãos-livres (#cartao-maos-livres, de ui/toque.js);
//  - "Comandos frequentes": só frases que o interpretador (comandos.js) realmente entende; tocar volta ao mapa e executa;
//  - o cartão de voz de sempre (#cartao-voz: Falar os alertas, jeito de falar, bipe de rádio, Testar voz) e o Limite de velocidade
//    (#limite-cartao), com os mesmos ids; antes ficavam dentro da tela Conta;
//  - link para o diagnóstico do microfone (#cmd-diag, que continua na tela Conta).
// NÃO há controle de volume nem de velocidade da fala (o app não tem: o volume é o do aparelho) nem liga/desliga por categoria de alerta.
// Expõe Copiloto.vozTela = { abrir(alvo?) }.
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const FRASES = [["Quanto falta?", "quanto falta"], ["Quando eu chego?", "quando eu chego"], ["Em que km estou?", "em que km estou"],
    ["Próximo posto", "próximo posto"], ["Repete", "repete"], ["Tem buraco aqui", "tem buraco aqui"], ["Ir para casa", "ir para casa"]];
  const ROTULO_ESTADO = { pronto: "Pronto", abrindo: "Abrindo o microfone…", ouvindo: "Ouvindo…", ok: "Comando registrado", indisponivel: "Voz indisponível aqui" };
  const ROTULO_BOTAO = { pronto: "Falar", abrindo: "Abrindo", ouvindo: "Ouvindo", ok: "Entendi", indisponivel: "Falar" };

  const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11.500a6.500 6.500 0 0013 0M12 18v3.500M8.500 21.500h7"/></svg>';

  function cartao(id, titulo, filhos) {
    const c = el("section", "cartao voz-cartao " + id); c.id = id;
    if (titulo) c.append(el("h2", null, titulo));
    for (const f of filhos) c.append(f);
    return c;
  }

  function estadoFalar() {
    const origem = $("cmd-falar"), b = $("voz-falar"); if (!origem || !b) return;
    const e = origem.dataset.estado || "pronto";
    b.dataset.estado = e;
    b.querySelector(".voz-falar-rotulo").textContent = ROTULO_BOTAO[e] || "Falar";
    $("voz-falar-estado").textContent = ROTULO_ESTADO[e] || "Pronto";
    $("voz-falar-estado").dataset.estado = e;
    b.setAttribute("aria-label", origem.getAttribute("aria-label") || "Falar um comando de voz");
  }

  function avisoSom() {
    const a = $("voz-aviso-som"); if (!a) return;
    let p = null; try { p = C.voz.preferencias(); } catch (e) { /* sem voz */ }
    const mudo = !!(p && p.ligada && C.voz.disponivel() && C.voz.destravado && !C.voz.destravado());
    if (a.hidden === mudo) a.hidden = !mudo;
  }

  function montar() {
    const tela = $("tela-voz"); if (!tela || $("voz-falar")) return;
    const voz = $("cartao-voz"), ml = $("cartao-maos-livres"), lim = $("limite-cartao"), diag = $("cmd-diag");

    // 1) aviso do som (iPhone)
    const som = botao("", "voz-aviso-som", () => {
      try { C.voz.falador.destravar(); C.voz.falar("Voz ativada. Se não ouviu, aumente o volume e desligue o modo silencioso."); } catch (e) { /* ignora */ }
      setTimeout(avisoSom, 600);
    });
    som.id = "voz-aviso-som"; som.hidden = true; som.dataset.semDestravar = "";
    som.append(el("b", null, "Som do iPhone"), el("span", null, "Toque aqui para ativar o som. Se continuar mudo, desligue o modo silencioso (chave ao lado do aparelho) e aumente o volume."));

    // 2) quanto falar (os elementos de ui/voz.js, ids intactos)
    const modo = cartao("voz-card-modo", "Quanto falar", []);
    for (const id of ["voz-modo", "voz-modo-dica"]) { const e = $(id); if (e) modo.append(e); }
    const tit = $("voz-modo-titulo"); if (tit) tit.remove();

    // 3) falar
    const falar = el("button", "voz-falar"); falar.type = "button"; falar.id = "voz-falar"; falar.dataset.semDestravar = ""; falar.dataset.estado = "pronto";
    const mic = el("span", "voz-falar-mic"); mic.innerHTML = MIC; mic.setAttribute("aria-hidden", "true");
    falar.append(mic, el("span", "voz-falar-rotulo", "Falar"));
    falar.addEventListener("click", () => { const o = $("cmd-falar"); if (o) o.click(); });
    const estado = el("p", "voz-falar-estado", "Pronto"); estado.id = "voz-falar-estado"; estado.setAttribute("role", "status");
    const sem = botao("Comandos por toque (sem usar a voz)", "btn voz-sem-voz", () => { if (C.comandos && C.comandos.alternativa) C.comandos.alternativa(); });
    sem.id = "voz-sem-voz";
    const cFalar = cartao("voz-card-falar", "Comando imediato", [estado, falar,
      el("p", "dica voz-falar-dica", "Toque para falar ou diga “Copiloto” com o mãos-livres ligado. O microfone só abre depois do seu toque."), sem]);

    // 4) comandos frequentes
    const chips = el("div", "voz-chips"); chips.id = "voz-chips"; chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "Comandos frequentes");
    for (const [rotulo, frase] of FRASES) {
      const b = botao(rotulo, "voz-chip", () => { C.abas.irPara("mapa"); setTimeout(() => { if (C.comandos && C.comandos.executar) C.comandos.executar(frase); }, 60); });
      b.dataset.frase = frase; chips.append(b);
    }
    const cChips = cartao("voz-card-chips", "Comandos frequentes", [el("p", "dica", "Toque ou fale. Tocar leva ao mapa e executa."), chips]);

    // 5) link para o diagnóstico do microfone (continua na tela Conta)
    const dg = botao("Diagnóstico do microfone", "btn voz-diag", () => { C.abas.irPara("conta"); setTimeout(() => { const d = $("cmd-diag"); if (d && d.scrollIntoView) try { d.scrollIntoView({ block: "start" }); } catch (e) { /* ignora */ } }, 0); });
    dg.id = "voz-diag-link";
    const cDiag = cartao("voz-card-diag", null, [dg]);
    cDiag.classList.add("voz-card-diag");

    tela.append(som, modo, cFalar);
    if (ml) tela.append(ml);
    tela.append(cChips);
    if (voz) tela.append(voz);
    if (lim) tela.append(lim);
    tela.append(cDiag);

    const origem = $("cmd-falar");
    if (origem) new MutationObserver(estadoFalar).observe(origem, { attributes: true, attributeFilter: ["data-estado", "aria-label"] });
    estadoFalar();
    setInterval(() => { if (!tela.hidden) avisoSom(); }, 1000);
  }

  function abrir(alvo) {
    C.abas.irPara("voz");
    const t = $("tela-voz"); if (t) t.scrollTop = 0;
    const e = alvo && $(alvo);
    if (e && e.scrollIntoView) setTimeout(() => { try { e.scrollIntoView({ block: "start" }); } catch (x) { /* ignora */ } }, 0);
  }

  C.vozTela = { abrir };

  C.aoIniciar(() => {
    C.abas.registrar({ id: "voz", rotulo: "Voz", tela: $("tela-voz"), botao: $("cfg-voz"), aoAbrir: () => { estadoFalar(); avisoSom(); } });
  });
  // depois de ui/toque.js (que cria #cartao-maos-livres) e de todos os cartões de voz já existirem
  C.on("pronto", montar);
})(window.Copiloto);
