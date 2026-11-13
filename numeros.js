// Leitura de números em português do Brasil, para montar falas com número livre a partir de clipes gravados.
// Lógica pura, sem DOM e sem dependências. Testado em tests/numeros.test.js; usado por vozclipes.js (montagem por partes)
// e por ferramentas/gerar-catalogo.mjs (que lista os clipes de números a gravar).
//
// Ideia: "Faltam 212 quilômetros, chegada às 15:40." não existe inteira no catálogo (o número é livre), mas pode ser dita como
//   "Faltam" + "duzentos e" + "doze" + "quilômetros, chegada às" + "quinze e" + "quarenta"
// cada pedaço sendo um clipe gravado. Os pedaços de TEXTO FIXO ("Faltam", "quilômetros, chegada às") saem das mesmas frases do app
// (o gerador de catálogo chama as funções reais); os pedaços de NÚMERO (0–99, centenas, "mil", "X e" das horas) estão aqui.
// Se qualquer pedaço faltar, a fala inteira continua na voz do aparelho (regra do vozclipes.js).
//
// Contagem: números de 0 a 9999. Acima disso, ou fora do formato, o analisador devolve null (voz do aparelho).
(function (raiz) {
  "use strict";

  const UNID = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quinze",
    "dezesseis", "dezessete", "dezoito", "dezenove"];
  const UNID_FEM = { 1: "uma", 2: "duas" };
  const DEZ = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
  const CEN = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
  const MAX = 9999;

  // 0–99 por extenso ("vinte e três"); fem: "uma", "duas", "vinte e uma"
  function ate99(n, fem) {
    if (n < 20) return fem && UNID_FEM[n] ? UNID_FEM[n] : UNID[n];
    const d = Math.floor(n / 10), u = n % 10;
    if (!u) return DEZ[d];
    return DEZ[d] + " e " + (fem && UNID_FEM[u] ? UNID_FEM[u] : UNID[u]);
  }

  // Clipes (textos falados) que dizem o inteiro n (0–9999). op.fem: "uma hora", "duas horas", "vinte e uma horas".
  // op.e: o número vem seguido de "e" (hora do relógio: "quinze e quarenta"); o "e" vai dentro do último clipe ("quinze e").
  // Cada elemento é o texto de UM clipe gravado.
  function clipesInteiro(n, op) {
    const o = op || {};
    if (!Number.isInteger(n) || n < 0 || n > MAX) return null;
    if (n < 100) return [ate99(n, o.fem) + (o.e ? " e" : "")];
    if (n < 1000) {
      const c = Math.floor(n / 100), r = n % 100;
      if (!r) return [c === 1 ? "cem" : CEN[c]];
      return [c === 1 ? "cento e" : CEN[c] + " e"].concat(clipesInteiro(r, o));
    }
    const m = Math.floor(n / 1000), r = n % 1000;
    const saida = m === 1 ? [] : [UNID[m]];
    if (!r) return saida.concat(["mil"]);
    // "mil e cem", "dois mil e vinte"; mas "mil cento e vinte", "dois mil trezentos e quinze"
    saida.push(r < 100 || r % 100 === 0 ? "mil e" : "mil");
    return saida.concat(clipesInteiro(r, o));
  }

  // Número por extenso em texto corrido (para conferir e testar): "cento e três", "mil e cem"
  function extenso(n, op) { const c = clipesInteiro(n, op); return c ? c.join(" ").replace(/ e e /g, " e ") : null; }

  // Dígito a dígito depois do "vírgula": "5" → cinco; "25" → vinte e cinco; "05" → zero cinco; "125" → um dois cinco
  function clipesDecimal(s) {
    if (!/^\d{1,3}$/.test(s)) return null;
    if (s.length <= 2 && !/^0\d$/.test(s)) return clipesInteiro(Number(s));
    return s.split("").map((d) => UNID[Number(d)]);
  }

  // Inteiro escrito como no texto ("153", "060", "007"): zeros à esquerda viram "zero".
  function clipesDigitos(s, op) {
    if (!/^\d+$/.test(s)) return null;
    let i = 0; const zeros = [];
    while (i < s.length - 1 && s[i] === "0") { zeros.push("zero"); i++; }
    const r = clipesInteiro(Number(s.slice(i)), op);
    return r ? zeros.concat(r) : null;
  }

  // Horário "15:40": "quinze e" + "quarenta"; "15:00": "quinze" + "horas"; "01:05": "uma e" + "cinco"; "02:00": "duas" + "horas".
  // As horas 1, 2, 21 e 22 vão no feminino ("à uma e cinco", "às duas e dez", "às vinte e uma").
  function clipesHora(h, m) {
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
    const fem = h === 1 || h === 2 || h === 21 || h === 22;
    if (m === 0) return [ate99(h, fem), h === 1 ? "hora" : "horas"];
    return [ate99(h, fem) + " e"].concat(clipesInteiro(m));
  }

  // Quebra o texto em pedaços: { t: "seg", s } (texto fixo, já com espaços colapsados) e { t: "num", s } (número, "4,5" ou "15:40").
  // Número seguido de ª/º (ordinal) ou colado a letras/hífen de código (SP-330) não é número livre: devolve null (aparelho).
  const RE_NUM = /(\d{1,2}:\d{2}|\d+(?:,\d+)?)(?![\dªº°])/g;
  function partir(texto) {
    const t = String(texto == null ? "" : texto).replace(/\s+/g, " ").trim();
    const r = [];
    let ultimo = 0, m, achou = false;
    RE_NUM.lastIndex = 0;
    while ((m = RE_NUM.exec(t))) {
      const antes = t.slice(ultimo, m.index);
      if (/[A-Za-zÀ-ÿ]-$/.test(antes) && !/\bBR-$/.test(antes)) return null; // "SP-330", "MG-050": só BR tem clipe
      if (/\bBR-$/.test(antes)) { r.push({ t: "seg", s: antes.slice(0, -1).trim() }); } else if (antes.trim()) r.push({ t: "seg", s: antes.trim() });
      r.push({ t: "num", s: m[1] });
      ultimo = m.index + m[1].length; achou = true;
    }
    if (!achou) return null;
    const resto = t.slice(ultimo).trim();
    if (resto) r.push({ t: "seg", s: resto });
    return r;
  }

  // Texto do pedaço fixo "só pontuação" ("." "," ".") não vira clipe: some.
  const SO_PONTUACAO = /^[\s.,;:!?…-]*$/;

  // Texto → lista de clipes (textos), na ordem de fala, ou null. Cada elemento: { texto, numero: bool }.
  // Os pedaços de texto fixo vêm com o texto exato do app (o catálogo tem que tê-los); os de número vêm de clipesInteiro etc.
  function componentes(texto) {
    const ps = partir(texto);
    if (!ps) return null;
    const saida = [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.t === "seg") { if (!SO_PONTUACAO.test(p.s)) saida.push({ texto: p.s, numero: false }); continue; }
      const prox = ps[i + 1] && ps[i + 1].t === "seg" ? ps[i + 1].s : "";
      const fem = /^horas?\b/.test(prox);
      let cl = null;
      if (p.s.includes(":")) { const [h, m] = p.s.split(":").map(Number); cl = clipesHora(h, m); }
      else if (p.s.includes(",")) {
        const [a, b] = p.s.split(",");
        const x = clipesDigitos(a), y = clipesDecimal(b);
        cl = x && y ? x.concat(["vírgula"], y) : null;
      } else cl = clipesDigitos(p.s, { fem: fem && Number(p.s) < 100 });
      if (!cl) return null;
      for (const c of cl) saida.push({ texto: c, numero: true });
    }
    return saida.length ? saida : null;
  }

  // Todos os clipes de NÚMERO que o app pode precisar (para o catálogo): 0–99 (masc. e fem.), centenas, "mil", horas "X e", etc.
  function clipesDeNumeros() {
    const s = new Set();
    for (let n = 0; n < 100; n++) { s.add(ate99(n)); s.add(ate99(n, true)); }
    for (let n = 100; n <= 900; n += 100) for (const c of clipesInteiro(n).concat(clipesInteiro(n + 1).slice(0, 1))) s.add(c);
    s.add("mil"); s.add("mil e");
    for (let h = 0; h <= 23; h++) { for (const c of clipesHora(h, 5).slice(0, 1)) s.add(c); for (const c of clipesHora(h, 0)) s.add(c); }
    s.add("vírgula"); s.add("hora"); s.add("horas");
    return [...s];
  }

  const api = { MAX, extenso, clipesInteiro, clipesDecimal, clipesDigitos, clipesHora, partir, componentes, clipesDeNumeros };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoNumeros = api;
})(typeof window !== "undefined" ? window : globalThis);
