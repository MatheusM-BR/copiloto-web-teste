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
    function falar(texto) {
      if (!disponivel() || texto == null) return false;
      try {
        const u = new Enunciado(String(texto));
        u.lang = "pt-BR";
        const v = vozPtBr(); if (v) u.voice = v;
        u.rate = 1; u.pitch = 1; u.volume = 1;
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

  const api = { PERFIS, PERFIL_PADRAO, AGRADECIMENTOS, CHAVE_PREF, numeroFalado, distanciaFalada, textoAlerta, agradecimento,
    lerPreferencias, gravarPreferencias, criarFalador };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoVoz = api;
})(typeof window !== "undefined" ? window : globalThis);
