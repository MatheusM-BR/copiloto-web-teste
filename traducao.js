// Manobras do Valhalla que chegam em inglês no meio do pt-BR (lógica pura, sem DOM; testada em tests/traducao.test.js).
// O arquivo pt-BR do Valhalla ainda não traduz rotatória e "toward": vêm frases como "Enter the roundabout and take the 2ª exit
// onto Praça Universitária." e "Turn à esquerda toward Prefeitura." (observadas em rotas reais de GO e SP). Aqui o texto vira
// português por trechos fixos, SEM mexer nos nomes de rua (a parte depois de "onto"/"toward" fica como veio).
// Uso: Traducao.manobras(leg.maneuvers) devolve cópias com instruction e verbal_* traduzidos.
(function (raiz) {
  "use strict";

  const LADO = { left: "à esquerda", right: "à direita", straight: "em frente" };
  const ladoPt = (s) => LADO[String(s).toLowerCase()] || s;
  // cada regra: [regex global, substituição]; a ordem importa (das mais específicas para as soltas)
  const REGRAS = [
    [/\bEnter the roundabout and take the (\d+)[ªºa-z]* exit onto /g, "Entre na rotatória e pegue a $1ª saída para "],
    [/\bEnter the roundabout and take the (\d+)[ªºa-z]* exit\b/g, "Entre na rotatória e pegue a $1ª saída"],
    [/\bEnter (?!the roundabout)([^.]*?) and take the (\d+)[ªºa-z]* exit onto /g, "Entre em $1 e pegue a $2ª saída para "],
    [/\bEnter (?!the roundabout)([^.]*?) and take the (\d+)[ªºa-z]* exit\b/g, "Entre em $1 e pegue a $2ª saída"],
    [/\bExit the roundabout\b/g, "Saia da rotatória"],
    [/\bEnter the roundabout\b/g, "Entre na rotatória"],
    [/(^|[.!] |, )Enter (?=[A-ZÀ-Ú0-9])/g, "$1Entre em "],     // só no começo da frase: "Rua Enter Prise" fica
    [/\bMake a (left|right) U-turn\b/g, (m, l) => "Faça o retorno " + ladoPt(l)],
    [/\bMake a U-turn\b/g, "Faça o retorno"],
    [/\bTurn (à esquerda|à direita|left|right) toward /g, (m, l) => "Vire " + ladoPt(l) + " em direção a "],
    [/\bTurn (à esquerda|à direita|left|right)\b/g, (m, l) => "Vire " + ladoPt(l)],
    [/\b(?:Bear|Keep|Stay) (à esquerda|à direita|left|right|straight) toward /g, (m, l) => "Mantenha-se " + ladoPt(l) + " em direção a "],
    [/\b(?:Bear|Keep|Stay) (à esquerda|à direita|left|right|straight)\b/g, (m, l) => "Mantenha-se " + ladoPt(l)],
    [/\bMerge (à esquerda|à direita|left|right) toward /g, (m, l) => "Entre na via " + ladoPt(l) + " em direção a "],
    [/\bMerge (à esquerda|à direita|left|right)\b/g, (m, l) => "Entre na via " + ladoPt(l)],
    [/\bMerge\b(?= toward| onto|\.|$)/g, "Entre na via"],
    [/\bTake the ramp on the (left|right)\b/g, (m, l) => "Pegue a rampa " + ladoPt(l)],
    [/\bTake the exit on the (left|right)\b/g, (m, l) => "Pegue a saída " + ladoPt(l)],
    [/\bTake the (?:ramp|exit)\b/g, (m) => (/ramp/.test(m) ? "Pegue a rampa" : "Pegue a saída")],
    [/\bContinue straight\b/g, "Siga em frente"],
    [/\bThen, /g, "Então, "],
    // restos soltos
    [/ toward /g, " em direção a "],
    [/ onto /g, " para "],
    [/\btoward /g, "em direção a "],
    [/\broundabout\b/g, "rotatória"],
  ];
  // palavras que denunciam inglês em instrução de manobra (usadas pelo teste e por temIngles)
  const INGLES = /\b(Enter the|Enter [A-Z]|Turn (?:à|left|right)|Bear (?:à|left|right)|Keep (?:à|left|right)|toward|onto|roundabout|exit\b|Merge|Take the|Make a|U-turn|Then,)/;

  function temIngles(texto) { return typeof texto === "string" && INGLES.test(texto); }
  function traduzir(texto) {
    if (typeof texto !== "string" || !texto) return texto;
    // atalho: sem nenhuma palavra do padrão, devolve igual (a maioria das instruções)
    if (!/(Enter|Turn|Bear|Keep|Stay|Merge|Take the|Make a|Exit|Continue straight|Then,|toward|onto|roundabout)/.test(texto)) return texto;
    let t = texto;
    for (const [re, sub] of REGRAS) t = t.replace(re, sub);
    return t;
  }
  const CAMPOS = ["instruction", "verbal_transition_alert_instruction", "verbal_succinct_transition_instruction", "verbal_pre_transition_instruction", "verbal_post_transition_instruction"];
  function manobra(m) {
    if (!m || typeof m !== "object") return m;
    let copia = null;
    for (const c of CAMPOS) {
      if (typeof m[c] !== "string") continue;
      const t = traduzir(m[c]);
      if (t !== m[c]) { if (!copia) copia = Object.assign({}, m); copia[c] = t; }
    }
    return copia || m;
  }
  function manobras(lista) { return Array.isArray(lista) ? lista.map(manobra) : []; }

  const api = { traduzir, manobra, manobras, temIngles, CAMPOS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoTraducao = api;
})(typeof window !== "undefined" ? window : globalThis);
