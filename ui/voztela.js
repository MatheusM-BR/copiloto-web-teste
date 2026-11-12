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
// NÃO há controle de volume nem de velocidade da fala (o app não tem: o volume é o do aparelho).
// Pacote F (item 17): "Alertas por categoria" (#voz-card-categorias): interruptores para Radar, Perigos na pista e Trânsito/obras/balança.
// Não existia filtro por categoria em voz.js nem em avisos.js; aqui ele é simples: só os relatos de motoristas falados por
// ui/alerta.js (Voz.textoAlerta, chamada sem opções) passam por ele. Restrição de altura/peso, manobra, curva, chegada e tudo o que é
// "crítica" NUNCA são filtrados (nem o "Só alertas" nem estes interruptores os calam). Limite de velocidade e descanso seguem com o
// interruptor próprio nos cartões respectivos. Escolha em localStorage "copiloto.voz.categorias.v1"; padrão: tudo ligado.
// Expõe Copiloto.vozTela = { abrir(alvo?), categorias: { lista, ligada(id), definir(id, v), daFala(texto, opcoes) } }.
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const FRASES = [["Quanto falta?", "quanto falta"], ["Quando eu chego?", "quando eu chego"], ["Em que km estou?", "em que km estou"],
    ["Próximo posto", "próximo posto"], ["Repete", "repete"], ["Tem buraco aqui", "tem buraco aqui"], ["Ir para casa", "ir para casa"]];
  const ROTULO_ESTADO = { pronto: "Pronto", abrindo: "Abrindo o microfone…", ouvindo: "Ouvindo…", ok: "Comando registrado", indisponivel: "Voz indisponível aqui" };
  const ROTULO_BOTAO = { pronto: "Falar", abrindo: "Abrindo", ouvindo: "Ouvindo", ok: "Entendi", indisponivel: "Falar" };

  const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11.500a6.500 6.500 0 0013 0M12 18v3.500M8.500 21.500h7"/></svg>';

  // ---- alertas por categoria
  const CHAVE_CATEGORIAS = "copiloto.voz.categorias.v1";
  const CATEGORIAS = [
    { id: "radar", rotulo: "Radar e fiscalização", dica: "Radar móvel relatado à frente.", nomes: ["radar móvel"] },
    { id: "perigos", rotulo: "Perigos na pista", dica: "Acidente, buraco, animal, objeto, veículo parado, alagamento, neblina, pista escorregadia e risco à segurança.",
      nomes: ["acidente", "buraco na pista", "animal na pista", "objeto na pista", "veículo parado", "alagamento", "neblina", "pista escorregadia"] },
    { id: "transito", rotulo: "Trânsito, obras e balança", dica: "Trânsito parado, obra e balança relatados à frente.", nomes: ["trânsito parado", "obra", "balança"] },
  ];
  function lerCategorias() {
    const o = C.util.lerJSON(CHAVE_CATEGORIAS, {});
    const r = {}; for (const c of CATEGORIAS) r[c.id] = !(o && o[c.id] === false);
    return r;
  }
  function categoriaLigada(id) { return lerCategorias()[id] !== false; }
  function definirCategoria(id, v) {
    if (!CATEGORIAS.some((c) => c.id === id)) return false;
    const o = lerCategorias(); o[id] = !!v; C.util.gravarJSON(CHAVE_CATEGORIAS, o); return true;
  }
  // Categoria de uma fala; null = nunca filtrar. Só relato falado sem opções ("Atenção: <nome> a <distância>.", de Voz.textoAlerta).
  const RE_ALERTA = /^Atenção: (.+) a \d[\d,]* (?:metros?|quilômetros?)\.$/;
  function categoriaDaFala(texto, opcoes) {
    if (opcoes !== undefined && opcoes !== null) return null;
    const t = String(texto == null ? "" : texto);
    if (/^Atenção: relatos de risco à segurança/.test(t)) return "perigos";
    const m = RE_ALERTA.exec(t); if (!m) return null;
    const c = CATEGORIAS.find((x) => x.nomes.indexOf(m[1]) >= 0);
    return c ? c.id : null;
  }
  function filtrarFala() {
    const V = C.voz; if (!V || typeof V.falar !== "function" || V.falar.__categorias) return;
    const orig = V.falar;
    const f = function (texto, opcoes) {
      const cat = categoriaDaFala(texto, opcoes);
      if (cat && !categoriaLigada(cat)) return false;
      return orig.apply(this, arguments);
    };
    f.__categorias = true;
    V.falar = f;
  }
  function cartaoCategorias() {
    const linhas = CATEGORIAS.map((c) => {
      const r = el("label", "linha-check voz-cat"); r.htmlFor = "voz-cat-" + c.id;
      const cx = document.createElement("input"); cx.type = "checkbox"; cx.id = "voz-cat-" + c.id; cx.checked = categoriaLigada(c.id);
      cx.addEventListener("change", () => { definirCategoria(c.id, cx.checked); });
      const tx = el("span", "voz-cat-txt"); tx.append(el("b", null, c.rotulo), el("small", null, c.dica));
      r.append(cx, tx); return r;
    });
    return cartao("voz-card-categorias", "Alertas por categoria", [
      el("p", "dica", "Escolha o que o Copiloto fala. O aviso continua na tela."), ...linhas,
      el("p", "dica", "Altura e peso do seu caminhão, curvas, manobras e chegada sempre falam. Limite de velocidade e descanso têm o próprio interruptor, abaixo.")]);
  }

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

  // ---- "Voz do Copiloto" (vozes gravadas, vozclipes.js): seletor, teste e download para usar sem internet.
  // Sem nenhuma voz gerada em voz/vozes.json, mostra só "Voz do aparelho" (e esconde teste e download).
  function criarCartaoClipes() {
    const tc = C.voz && C.voz.clipes;
    if (!tc || $("voz-card-clipes")) return null;
    const VC = window.CopilotoVozClipes;
    const sel = el("select"); sel.id = "voz-clipes-voz";
    const rot = el("label", null, "Voz do Copiloto"); rot.htmlFor = "voz-clipes-voz"; rot.append(sel);
    const dica = el("p", "dica", "Voz do aparelho é a de sempre. Uma voz gravada fala as frases fixas (alertas, avisos, navegação) com mais clareza; o resto continua na voz do aparelho.");
    const info = el("p", "dica"); info.id = "voz-clipes-info"; info.setAttribute("role", "status");
    const testar = botao("Ouvir a voz escolhida", "btn voz-sem-voz", () => {
      try {
        C.voz.falador.destravar();
        const t = tc.amostra();
        const ok = t ? C.voz.falador.falar(t) : false;
        info.textContent = ok ? "Falando… se não ouvir nada, aumente o volume e desligue o modo silencioso do iPhone." : "Não consegui falar agora.";
      } catch (e) { info.textContent = "Não consegui falar agora."; }
    });
    testar.id = "voz-clipes-testar"; testar.dataset.semDestravar = "";
    const baixar = botao("Baixar vozes para usar sem internet", "btn voz-sem-voz", async () => {
      baixar.disabled = true;
      info.textContent = "Baixando…";
      const r = await tc.baixarTudo((p) => { info.textContent = "Baixando… " + p.feitos + " de " + p.total + " (" + VC.formatarBytes(p.bytes) + ")"; });
      baixar.disabled = false;
      if (r.ok) info.textContent = "Pronto: " + r.feitos + " frases guardadas (" + VC.formatarBytes(r.bytes) + "). A voz funciona sem internet.";
      else info.textContent = "Baixou " + r.feitos + " de " + (r.total || "?") + ". Confira a internet e toque de novo para continuar.";
      desenharClipes();
    });
    baixar.id = "voz-clipes-baixar";
    sel.addEventListener("change", () => {
      tc.escolher(sel.value);
      try { C.voz.falador.destravar(); } catch (e) { /* ignora */ }
      desenharClipes();
    });
    const c = cartao("voz-card-clipes", "Voz gravada", [rot, dica, testar, baixar, info]);
    let gen = 0;
    function desenharClipes() {
      const vozes = tc.vozes(), ativa = tc.ativa();
      const quero = ["aparelho"].concat(vozes.map((v) => v.id)).join("|");
      if (sel.dataset.opcoes !== quero) {
        sel.textContent = "";
        sel.add(new Option("Voz do aparelho", "aparelho"));
        for (const v of vozes) sel.add(new Option(v.nome, v.id));
        sel.dataset.opcoes = quero;
      }
      sel.value = ativa || "aparelho";
      sel.disabled = !vozes.length;
      testar.hidden = baixar.hidden = !ativa;
      dica.hidden = !vozes.length;
      if (!ativa) { if (!/^Baixando/.test(info.textContent)) info.textContent = ""; return; }
      const meu = ++gen;
      tc.tamanhoBaixado().then((t) => {
        if (meu !== gen || /^Baixando/.test(info.textContent)) return;
        info.textContent = t.clipes >= t.total && t.total > 0 ? "Guardada no aparelho: " + t.clipes + " frases (" + VC.formatarBytes(t.bytes) + "). Funciona sem internet."
          : "Guardado no aparelho: " + VC.formatarBytes(t.bytes) + " de " + VC.formatarBytes(t.totalBytes) + " (" + t.clipes + " de " + t.total + " frases). As outras baixam ao usar; para ter tudo sem internet, baixe agora.";
      }, () => {});
    }
    tc.aoMudar(desenharClipes);
    desenharClipes();
    return c;
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
    tela.append(cartaoCategorias());
    filtrarFala();
    const clipes = criarCartaoClipes();
    if (clipes) tela.append(clipes);
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

  C.vozTela = { abrir, categorias: { lista: () => CATEGORIAS.map((c) => ({ id: c.id, rotulo: c.rotulo, ligada: categoriaLigada(c.id) })), ligada: categoriaLigada, definir: definirCategoria, daFala: categoriaDaFala } };

  C.aoIniciar(() => {
    C.abas.registrar({ id: "voz", rotulo: "Voz", tela: $("tela-voz"), botao: $("cfg-voz"), aoAbrir: () => { estadoFalar(); avisoSom(); } });
  });
  // depois de ui/toque.js (que cria #cartao-maos-livres) e de todos os cartões de voz já existirem
  C.on("pronto", montar);
})(window.Copiloto);
