// Voz do Copiloto: textos falados e chamada à fala do aparelho (Web Speech API).
// Regras (VOZ-05):
//  - o ALERTA de segurança é sempre o mesmo texto curto, em todos os perfis, sem humor e sem o nível;
//  - o perfil muda só a frase de agradecimento depois do voto;
//  - Profissional nunca faz humor; Bem-humorado é leve e curto, sem palavrão e sem estereótipo.
// speechSynthesis e SpeechSynthesisUtterance são injetáveis (testes no Node e no navegador).
(function (raiz) {
  "use strict";

  const CHAVE_PREF = "copiloto.voz.v1";

  const PERFIS = {
    profissional: { rotulo: "Profissional" },
    equilibrado:  { rotulo: "Equilibrado" },
    amigavel:     { rotulo: "Amigável" },
    bem_humorado: { rotulo: "Bem-humorado" },
  };
  const PERFIL_PADRAO = "equilibrado";

  const AGRADECIMENTOS = {
    profissional: ["Registrado."],
    equilibrado:  ["Obrigado, registrado."],
    amigavel:     ["Valeu, parceiro, registrado."],
    bem_humorado: ["Anotado! A estrada agradece.", "Registrado. Mais um ponto pro time da estrada.", "Valeu! Informação boa é igual café: ajuda a viagem."],
  };

  // Como o alerta chama cada tipo (fala). Tipos com valor usam a forma "Altura máxima 4,3 metros".
  const FALA_TIPO = {
    altura_maxima: { nome: "Altura máxima", unidade: ["metro", "metros"] },
    limite_peso:   { nome: "Limite de peso", unidade: ["tonelada", "toneladas"] },
    obra:          { nome: "obra" },
    buraco:        { nome: "buraco na pista" },
    acidente:      { nome: "acidente" },
    radar_movel:   { nome: "radar móvel" },
    animal:        { nome: "animal na pista" },
    // tipos do pacote E5 (taxonomia 7.1)
    fila:               { nome: "trânsito parado" },
    objeto:             { nome: "objeto na pista" },
    veiculo_parado:     { nome: "veículo parado" },
    alagamento:         { nome: "alagamento" },
    neblina:            { nome: "neblina" },
    pista_escorregadia: { nome: "pista escorregadia" },
    balanca:            { nome: "balança" },
  };

  // 4.3 → "4,3"; 45 → "45"; 4.25 → "4,25"
  function numeroFalado(n) {
    const v = Math.round(Number(n) * 100) / 100;
    return String(v).replace(".", ",");
  }
  function comUnidade(n, formas) {
    return numeroFalado(n) + " " + (Math.abs(Number(n)) === 1 ? formas[0] : formas[1]);
  }

  // Distância falada: arredonda para não falar "487 metros" (abaixo de 100 m: de 10 em 10; até 1 km: de 50 em 50).
  function distanciaFalada(m) {
    const d = Math.max(0, Number(m) || 0);
    if (d >= 1000) return comUnidade(Math.round(d / 100) / 10, ["quilômetro", "quilômetros"]);
    const r = d < 100 ? Math.max(10, Math.round(d / 10) * 10) : Math.round(d / 50) * 50;
    return r >= 1000 ? "1 quilômetro" : r + " metros";
  }

  // Texto do alerta: igual em todos os perfis. tipo = tipo do app (altura_maxima, obra…).
  function textoAlerta(tipo, valor, distanciaM) {
    const f = FALA_TIPO[tipo];
    const onde = "a " + distanciaFalada(distanciaM);
    if (!f) return "Atenção: alerta " + onde + ".";
    if (f.unidade && valor != null && isFinite(valor)) return f.nome + " " + comUnidade(valor, f.unidade) + " " + onde + ".";
    if (f.unidade) return "Atenção: " + f.nome.toLowerCase() + " " + onde + ".";
    return "Atenção: " + f.nome + " " + onde + ".";
  }

  // Agradecimento depois do voto. indice escolhe entre as variações (só o Bem-humorado tem mais de uma).
  function agradecimento(perfil, indice) {
    const lista = AGRADECIMENTOS[perfil] || AGRADECIMENTOS[PERFIL_PADRAO];
    const i = Math.abs(Math.floor(Number(indice) || 0)) % lista.length;
    return lista[i];
  }

  function lerPreferencias(storage) {
    let o = null;
    try { o = JSON.parse((storage && storage.getItem(CHAVE_PREF)) || "null"); } catch (e) { o = null; }
    o = o || {};
    return { ligada: o.ligada !== false, perfil: PERFIS[o.perfil] ? o.perfil : PERFIL_PADRAO };
  }
  function gravarPreferencias(storage, pref) {
    try { storage && storage.setItem(CHAVE_PREF, JSON.stringify({ ligada: !!pref.ligada, perfil: PERFIS[pref.perfil] ? pref.perfil : PERFIL_PADRAO })); } catch (e) { /* ignora */ }
  }

  // Falador: envolve speechSynthesis. sintese/Enunciado injetáveis.
  function criarFalador(opcoes) {
    const o = opcoes || {};
    const sintese = o.sintese !== undefined ? o.sintese : (typeof speechSynthesis !== "undefined" ? speechSynthesis : null);
    const Enunciado = o.Enunciado !== undefined ? o.Enunciado : (typeof SpeechSynthesisUtterance !== "undefined" ? SpeechSynthesisUtterance : null);

    function disponivel() { return !!(sintese && typeof sintese.speak === "function" && Enunciado); }
    function vozPtBr() {
      try {
        const vozes = (sintese.getVoices && sintese.getVoices()) || [];
        return vozes.find((v) => /^pt[-_]BR$/i.test(v.lang)) || vozes.find((v) => /^pt/i.test(v.lang)) || null;
      } catch (e) { return null; }
    }
    // Fala o texto, interrompendo o que estiver falando. Devolve false se não deu.
    // opcoes.aoTerminar: chamado quando a fala acaba (onend/onerror), uma vez só.
    function falar(texto, opcoes) {
      if (!disponivel() || texto == null) return false;
      try {
        const u = new Enunciado(String(texto));
        u.lang = "pt-BR";
        const v = vozPtBr(); if (v) u.voice = v;
        u.rate = 1; u.pitch = 1; u.volume = 1;
        if (opcoes && typeof opcoes.aoTerminar === "function") {
          let feito = false; const cb = () => { if (!feito) { feito = true; opcoes.aoTerminar(); } };
          u.onend = cb; u.onerror = cb;
        }
        if (sintese.cancel) sintese.cancel();
        sintese.speak(u);
        return true;
      } catch (e) { return false; }
    }
    // iPhone/Safari só libera a fala depois de um toque: fala um enunciado vazio e mudo dentro do toque.
    function destravar() {
      if (!disponivel()) return false;
      try { const u = new Enunciado(""); u.volume = 0; u.lang = "pt-BR"; sintese.speak(u); return true; } catch (e) { return false; }
    }
    return { disponivel, falar, destravar };
  }

  // ------------------------------------------------------------ bipe de rádio (VOZ-02)
  // Bipe curto estilo rádio PX, gerado no código (WebAudio, sem arquivo de som):
  //  inicio = dois tons subindo ("pode falar"); fim = dois tons descendo ("câmbio"); ok = dois toques curtos (relato aceito).
  // Preferência própria (liga/desliga), guardada à parte da voz.
  const CHAVE_BIPE = "copiloto.voz.bipe.v1";
  const BIPES = {
    inicio: [[1250, 0.06], [1650, 0.07]],
    fim:    [[1650, 0.06], [1150, 0.1]],
    ok:     [[1900, 0.04], [0, 0.035], [1900, 0.04]],
  };
  function lerBipe(storage) {
    try { const o = JSON.parse((storage && storage.getItem(CHAVE_BIPE)) || "null"); return !(o && o.ligado === false); } catch (e) { return true; }
  }
  function gravarBipe(storage, ligado) {
    try { storage && storage.setItem(CHAVE_BIPE, JSON.stringify({ ligado: !!ligado })); } catch (e) { /* ignora */ }
  }
  // AudioContext injetável. O primeiro tocar() deve acontecer dentro de um toque (iPhone só libera o áudio assim).
  function criarBipe(opcoes) {
    const o = opcoes || {};
    const g = typeof window !== "undefined" ? window : {};
    const AC = o.AudioContext !== undefined ? o.AudioContext : (g.AudioContext || g.webkitAudioContext || null);
    const volume = o.volume != null ? o.volume : 0.12;
    let ctx = null;
    function disponivel() { return typeof AC === "function"; }
    function contexto() {
      if (!ctx) ctx = new AC();
      if (ctx.state === "suspended" && ctx.resume) { try { ctx.resume(); } catch (e) { /* ignora */ } }
      return ctx;
    }
    function tocar(nome) {
      const notas = BIPES[nome];
      if (!notas || !disponivel()) return false;
      try {
        const c = contexto();
        let t = (c.currentTime || 0) + 0.01;
        const saida = c.createGain(); saida.gain.value = volume;
        let destino = saida;
        // passa-baixa: som "de rádio", menos estridente
        if (c.createBiquadFilter) { const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 2600; f.connect(saida); destino = f; }
        saida.connect(c.destination);
        for (const [freq, dur] of notas) {
          if (freq > 0) {
            const osc = c.createOscillator(), env = c.createGain();
            osc.type = "square"; osc.frequency.setValueAtTime(freq, t);
            env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + 0.005);
            env.gain.setValueAtTime(1, t + dur - 0.008); env.gain.linearRampToValueAtTime(0, t + dur);
            osc.connect(env); env.connect(destino);
            osc.start(t); osc.stop(t + dur + 0.01);
          }
          t += dur;
        }
        return true;
      } catch (e) { return false; }
    }
    return { disponivel, tocar, destravar: () => { if (!disponivel()) return false; try { contexto(); return true; } catch (e) { return false; } } };
  }

  const api = { CHAVE_BIPE, BIPES, lerBipe, gravarBipe, criarBipe, PERFIS, PERFIL_PADRAO, AGRADECIMENTOS, CHAVE_PREF, numeroFalado, distanciaFalada, textoAlerta, agradecimento,
    lerPreferencias, gravarPreferencias, criarFalador };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoVoz = api;
})(typeof window !== "undefined" ? window : globalThis);
