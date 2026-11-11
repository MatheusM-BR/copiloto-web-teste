// Parada no posto (lógica pura, sem DOM). Testado em tests/parada.test.js.
//
// O motorista para num posto → na CHEGADA o Copiloto lembra: "quando sair, me conta o que tem aqui".
// Na SAÍDA pergunta por voz (no máximo 4 perguntas): preço do diesel S10, nota do posto, banheiro (limpeza e cheiro) e UMA
// pergunta de existência (cabe carreta, pátio, S10, Arla, banheiro, chuveiro, restaurante, 24 h). As respostas vão para o
// banco (copiloto_station_answers_submit) e viram a pontuação interna do posto (não aparece no app até a base consolidar).
//
// Detector (alimentado a cada leitura do GPS com o posto mais perto):
//  - chegada: a até RAIO_CHEGADA_M (150 m) do posto e parado (≤ 8 km/h) por CHEGADA_MS (2 min) seguidos; ou marcada à mão;
//  - saída: depois da chegada, a mais de RAIO_SAIDA_M (300 m) do posto, ou andando acima de 25 km/h por 30 s;
//  - buraco de leituras > 30 min dentro do posto: a visita segue; a saída vem da próxima leitura longe.
(function (raiz) {
  "use strict";

  const RAIO_CHEGADA_M = 150, RAIO_SAIDA_M = 300, CHEGADA_MS = 120000, PARADO_KMH = 8, SAIDA_KMH = 25, SAIDA_RAPIDA_MS = 30000;
  const MAX_PERGUNTAS = 4;
  const DIA = 86400000;

  // Perguntas de existência, na ordem do que mais pesa para o caminhoneiro; `vence` = depois disso pergunta de novo.
  const EXISTENCIA = [
    { q: "carreta", texto: "Cabe carreta para entrar e manobrar aqui?", rotulo: "Cabe carreta", vence: 365 * DIA },
    { q: "patio", texto: "Tem pátio para pernoitar?", rotulo: "Pátio para pernoite", vence: 180 * DIA },
    { q: "s10", texto: "Tem diesel S10?", rotulo: "Diesel S10", vence: 90 * DIA },
    { q: "arla", texto: "Tem Arla na bomba?", rotulo: "Arla 32 na bomba", vence: 90 * DIA },
    { q: "banheiro", texto: "Tem banheiro?", rotulo: "Banheiro", vence: 180 * DIA },
    { q: "chuveiro", texto: "Tem chuveiro?", rotulo: "Chuveiro", vence: 180 * DIA },
    { q: "restaurante", texto: "Tem restaurante ou lanchonete?", rotulo: "Restaurante", vence: 180 * DIA },
    { q: "24h", texto: "Fica aberto vinte e quatro horas?", rotulo: "Aberto 24 h", vence: 90 * DIA },
  ];
  const PRECO = { q: "preco_s10", texto: "Quanto estava o diesel S10?", rotulo: "Preço do S10", vence: 7 * DIA, tipo: "preco" };
  const NOTA = { q: "nota_geral", texto: "De um a cinco, que nota você dá para este posto?", rotulo: "Nota do posto", vence: 30 * DIA, tipo: "nota" };
  const BANHEIRO = { q: "limpeza", texto: "E o banheiro: limpo, regular ou sujo?", rotulo: "Banheiro", vence: 30 * DIA, tipo: "banheiro" };

  // ------------------------------------------------------------ geometria
  function distM(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // ------------------------------------------------------------ detector de chegada e saída
  // criarDetector() → { atualizar(leitura, posto) → null | {tipo:"chegada"|"saida", visita}, marcar(posto, leitura), visita() }
  //   leitura = { lat, lon, kmh, t }; posto = { key, nome, lat, lon } (o mais perto, ou null)
  function criarDetector(opc) {
    const o = Object.assign({ chegadaMs: CHEGADA_MS }, opc || {});
    let visita = null, candidato = null, rapidoDesde = null, seq = 0;
    function novaVisita(posto, leitura, manual) {
      const d = Math.round(distM(leitura, posto));
      visita = { id: o.gerarId ? o.gerarId() : "v" + (++seq) + "-" + leitura.t, key: posto.key, nome: posto.nome || "posto",
        lat: posto.lat, lon: posto.lon, inicio: leitura.t, distancia_m: d, manual: !!manual };
      candidato = null; rapidoDesde = null;
      return { tipo: "chegada", visita };
    }
    function atualizar(l, posto) {
      if (!l || typeof l.lat !== "number" || typeof l.t !== "number") return null;
      const kmh = typeof l.kmh === "number" ? l.kmh : null;
      if (visita) {
        const d = distM(l, visita);
        if (kmh !== null && kmh > SAIDA_KMH) { if (rapidoDesde === null) rapidoDesde = l.t; } else rapidoDesde = null;
        if (d > RAIO_SAIDA_M || (rapidoDesde !== null && l.t - rapidoDesde >= SAIDA_RAPIDA_MS)) {
          const v = Object.assign({}, visita, { fim: l.t, duracaoMs: l.t - visita.inicio });
          visita = null; rapidoDesde = null;
          return { tipo: "saida", visita: v };
        }
        return null;
      }
      if (!posto || kmh === null || kmh > PARADO_KMH || distM(l, posto) > RAIO_CHEGADA_M) { candidato = null; return null; }
      if (!candidato || candidato.key !== posto.key) { candidato = { key: posto.key, desde: l.t }; return null; }
      if (l.t - candidato.desde >= o.chegadaMs) return novaVisita(posto, l, false);
      return null;
    }
    function marcar(posto, leitura) { if (!posto || !leitura) return null; return novaVisita(posto, leitura, true); }
    return { atualizar, marcar, visita: () => (visita ? Object.assign({}, visita) : null), cancelar: () => { visita = null; candidato = null; } };
  }

  // ------------------------------------------------------------ escolha das perguntas
  // memoria = { "<station_key>": { "<q>": t_ms da última resposta deste motorista, ... } }
  function vencida(mem, key, p, agora) { const t = mem && mem[key] && mem[key][p.q]; return !t || agora - t >= p.vence; }
  function escolherPerguntas(mem, key, agora, opc) {
    const o = Object.assign({ max: MAX_PERGUNTAS }, opc || {});
    const lista = [];
    if (vencida(mem, key, PRECO, agora)) lista.push(PRECO);
    if (vencida(mem, key, NOTA, agora)) lista.push(NOTA);
    const respBanheiro = mem && mem[key] && mem[key].banheiro_resp;
    if (respBanheiro !== "nao" && vencida(mem, key, BANHEIRO, agora)) lista.push(BANHEIRO);
    const ex = EXISTENCIA.find((p) => vencida(mem, key, p, agora));
    if (ex) lista.push(ex);
    return lista.slice(0, o.max);
  }

  // ------------------------------------------------------------ leitura das respostas faladas
  function normalizar(t) {
    return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9,. ]/g, " ").replace(/\s+/g, " ").trim();
  }
  const lista = (t) => (Array.isArray(t) ? t : [t]);
  const PULAR = /\b(pula|pular|proxima|depois|cancela|cancelar|esquece|agora nao|deixa pra la|chega)\b/;

  function pulou(textos) { return lista(textos).some((t) => PULAR.test(normalizar(t))); }

  // "sim" | "nao" | "nao_sei" | null
  function simNaoNaoSei(textos) {
    for (const t of lista(textos)) {
      const n = normalizar(t);
      if (!n) continue;
      if (/\b(nao sei|sei la|nao reparei|nao vi|nao lembro|nao prestei atencao|nao faco ideia)\b/.test(n)) return "nao_sei";
      if (/^(nao|negativo|nenhum|nada)\b/.test(n) || /\bnao (tem|tinha|cabe|cabia|fica|ficava|e|da)\b/.test(n)) return "nao";
      if (/^(sim|tem|tinha|cabe|cabia|fica|claro|positivo|com certeza|uhum|aham|isso|pode|da)\b/.test(n) || /\b(tem sim|tinha sim|sim)\b/.test(n)) return "sim";
    }
    return null;
  }

  const UNID = { zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
    onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19 };
  const DEZ = { vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90 };
  // "quarenta e nove" → 49; "seis" → 6; "6" → 6
  function numeroPalavras(trecho) {
    const ps = trecho.split(" ").filter((p) => p && p !== "e");
    if (!ps.length) return null;
    let total = 0, achou = false;
    for (const p of ps) {
      if (/^\d+$/.test(p)) { total += Number(p); achou = true; }
      else if (p in DEZ) { total += DEZ[p]; achou = true; }
      else if (p in UNID) { total += UNID[p]; achou = true; }
      else return null;
    }
    return achou ? total : null;
  }

  // R$/L entre 3 e 15, ou null. "6,49" | "6.49" | "seis e quarenta e nove" | "seis reais e quarenta e nove centavos" | "6 e 49"
  function lerPreco(textos) {
    for (const t of lista(textos)) {
      let n = normalizar(t).replace(/\b(o|a|tava|estava|ta|esta|era|litro|o litro|por litro|diesel|s10|s 10|uns|mais ou menos|cerca de|de)\b/g, " ").replace(/\s+/g, " ").trim();
      const dig = n.match(/(\d{1,2})[,.](\d{1,3})/);
      let v = null;
      if (dig) v = Number(dig[1]) + Number(dig[2].padEnd(2, "0").slice(0, 2)) / 100 + (dig[2].length === 3 ? Number(dig[2][2]) / 1000 : 0);
      else {
        n = n.replace(/\bcentavos?\b/g, " ").replace(/\s+/g, " ").trim();
        const m = n.split(/\breais?\b|\bconto\b|\bpila\b/);
        if (m.length >= 2) {
          const r = numeroPalavras(m[0].trim()), c = numeroPalavras(m[1].replace(/^\s*e\s+/, "").trim()) || 0;
          if (r !== null) v = r + c / 100;
        } else {
          // "seis e quarenta e nove": o primeiro número (1 dígito) são os reais, o resto os centavos
          const ps = n.split(" ").filter(Boolean);
          const i = ps.indexOf("e");
          if (i > 0) {
            const r = numeroPalavras(ps.slice(0, i).join(" ")), c = numeroPalavras(ps.slice(i + 1).join(" "));
            if (r !== null && c !== null && c < 100) v = r + c / 100;
          } else { const r = numeroPalavras(n); if (r !== null) v = r; }
        }
      }
      if (v !== null && v >= 3 && v <= 15) return Math.round(v * 1000) / 1000;
    }
    return null;
  }

  // nota 1–5 ou null: número/palavra ou adjetivo
  function lerNota(textos) {
    for (const t of lista(textos)) {
      const n = normalizar(t);
      if (/\b(otimo|excelente|muito bom|top|perfeito|maravilh)/.test(n)) return 5;
      if (/\b(pessimo|horrivel|muito ruim|lixo|terrivel)\b/.test(n)) return 1;
      if (/\b(ruim|fraco)\b/.test(n)) return 2;
      if (/\b(regular|mais ou menos|razoavel|medio)\b/.test(n)) return 3;
      const num = n.match(/\b([1-5])\b/) || null;
      if (num) return Number(num[1]);
      for (const p of n.split(" ")) if (p in UNID && UNID[p] >= 1 && UNID[p] <= 5) return UNID[p];
      if (/\bbom\b/.test(n)) return 4;
    }
    return null;
  }

  // banheiro → { limpeza: 1..3 | null, cheiro: 1..3 | null } ou null se nada foi entendido
  function lerBanheiro(textos) {
    for (const t of lista(textos)) {
      const n = normalizar(t);
      let limpeza = null, cheiro = null;
      if (/\b(sujo|imundo|nojento|porco|horrivel|pessimo)\b/.test(n)) limpeza = 1;
      else if (/\b(regular|mais ou menos|razoavel)\b/.test(n)) limpeza = 2;
      else if (/\b(limpo|limpinho|bom|otimo)\b/.test(n)) limpeza = 3;
      if (/\b(fedido|fedendo|fede|catinga|cheiro ruim|mal cheiro|mau cheiro|fedor)\b/.test(n)) { cheiro = 1; if (limpeza === null) limpeza = 1; }
      else if (/\b(cheiroso|sem cheiro|cheirando bem)\b/.test(n)) cheiro = 3;
      if (limpeza !== null || cheiro !== null) return { limpeza, cheiro };
    }
    return null;
  }

  // Lê a resposta de uma pergunta → lista de respostas para o banco ([{q,a}|{q,v}]), [] = pulou, null = não entendeu
  function lerResposta(pergunta, textos) {
    if (pulou(textos)) return [];
    if (pergunta.tipo === "preco") { const v = lerPreco(textos); return v === null ? (simNaoNaoSei(textos) === "nao_sei" ? [] : null) : [{ q: pergunta.q, v }]; }
    if (pergunta.tipo === "nota") { const v = lerNota(textos); return v === null ? null : [{ q: pergunta.q, v }]; }
    if (pergunta.tipo === "banheiro") {
      if (simNaoNaoSei(textos) === "nao_sei") return [];
      const b = lerBanheiro(textos); if (!b) return null;
      const r = []; if (b.limpeza !== null) r.push({ q: "limpeza", v: b.limpeza }); if (b.cheiro !== null) r.push({ q: "cheiro", v: b.cheiro });
      return r;
    }
    const a = simNaoNaoSei(textos);
    return a ? [{ q: pergunta.q, a }] : null;
  }

  // Grava na memória local o que foi respondido (para não perguntar de novo antes de vencer)
  function lembrar(mem, key, respostas, agora) {
    const m = Object.assign({}, mem || {});
    const p = Object.assign({}, m[key] || {});
    for (const r of respostas) {
      p[r.q] = agora;
      if (r.q === "limpeza" || r.q === "cheiro") p.limpeza = agora;
      if (r.q === "banheiro") p.banheiro_resp = r.a;
    }
    m[key] = p;
    return m;
  }
  // Pergunta feita e pulada: não insiste nesta mesma visita, mas volta na próxima (marca só a visita).

  // Textos falados
  function textoChegada(nome) { return "Chegou no " + nome + ". Quando sair, me conta o que tem aqui pra gente marcar."; }
  function textoSaida(nome, n) { return n > 1 ? "Saindo do " + nome + ". " + n + " perguntas rápidas. Pode dizer pular." : "Saindo do " + nome + ". Uma pergunta rápida."; }
  const TEXTO_FIM = "Valeu! Anotado.";

  const API = { RAIO_CHEGADA_M, RAIO_SAIDA_M, CHEGADA_MS, MAX_PERGUNTAS, EXISTENCIA, PRECO, NOTA, BANHEIRO, distM, criarDetector,
    escolherPerguntas, normalizar, simNaoNaoSei, lerPreco, lerNota, lerBanheiro, lerResposta, pulou, lembrar,
    textoChegada, textoSaida, TEXTO_FIM };
  if (typeof module !== "undefined" && module.exports) module.exports = API; else raiz.CopilotoParada = API;
})(typeof window !== "undefined" ? window : globalThis);
