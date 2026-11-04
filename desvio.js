// Desvio de restrições: lógica pura (sem DOM), testada no Node (tests/desvio.test.js). Expõe window.CopilotoDesvio.
//
// A restrição do mapa (ponte baixa, limite de peso…) hoje só alerta. Aqui está o que faz o app CRIAR a alternativa:
//   - quadrado ~60 m em volta de cada restrição violada → "exclude_polygons" do Valhalla (mais robusto que exclude_locations,
//     que só evita o ponto exato); o servidor público limita o perímetro total (padrão 10 km), por isso MAX_POLIGONOS;
//   - acúmulo: se a rota nova ainda viola outra restrição, os polígonos dela entram junto com os anteriores (uma vez só);
//   - etiqueta da alternativa: "Evita 2 restrições · +12 km · +18 min" (diferença contra a rota original);
//   - textos honestos: dado de restrição é do OpenStreetMap (comunitário): "segundo o mapa (OSM)", limite da via × veículo,
//     e quem decide é o motorista. Nunca diz que a rota é segura.
// A parte com rede e tela está em ui/desvio.js.
(function (raiz) {
  "use strict";

  const LADO_M = 60;           // lado do quadrado ao redor da restrição
  const MAX_POLIGONOS = 20;    // 20 × 240 m = 4,8 km de perímetro, metade do limite padrão do Valhalla (10 km)
  const DUPLICADO_M = 15;      // dois pontos a menos que isso são a mesma restrição (ex.: ponte nos dois sentidos)
  const NAV_MIN_ADIANTE_M = 3000; // navegando: só recalcula se a restrição está a pelo menos 3 km à frente
  const M_POR_GRAU = 111195;

  const num = (v) => { const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : v; return typeof n === "number" && isFinite(n) ? n : null; };
  const fmt = (v) => String(Math.round(Number(v) * 100) / 100).replace(".", ",");

  // ------------------------------------------------------------ polígonos
  // Anel fechado [lon, lat] (5 pontos) de um quadrado de ladoM metros centrado em (lat, lon).
  function quadrado(lat, lon, ladoM) {
    const meio = (ladoM || LADO_M) / 2;
    const dLat = meio / M_POR_GRAU;
    const dLon = meio / (M_POR_GRAU * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
    const r = (x) => Math.round(x * 1e6) / 1e6;
    return [[r(lon - dLon), r(lat - dLat)], [r(lon + dLon), r(lat - dLat)], [r(lon + dLon), r(lat + dLat)], [r(lon - dLon), r(lat + dLat)], [r(lon - dLon), r(lat - dLat)]];
  }
  function distM(a, b) {
    const dy = (a.lat - b.lat) * M_POR_GRAU, dx = (a.lon - b.lon) * M_POR_GRAU * Math.cos(a.lat * Math.PI / 180);
    return Math.hypot(dx, dy);
  }
  // Soma restrições violadas (itens do RPC: { id, lat, lon, … }) a uma lista de "alvos" { id, lat, lon, anel } sem repetir
  // (mesmo id ou a menos de DUPLICADO_M). Fica no máximo MAX_POLIGONOS (os primeiros, que são os mais perto da origem).
  // Devolve { alvos, cortou } — cortou: alguma ficou de fora pelo limite do servidor.
  function acumular(atuais, violadas) {
    const alvos = (atuais || []).slice();
    let cortou = false;
    for (const r of violadas || []) {
      if (!r || !isFinite(r.lat) || !isFinite(r.lon)) continue;
      if (alvos.some((a) => (r.id != null && a.id === r.id) || distM(a, r) < DUPLICADO_M)) continue;
      if (alvos.length >= MAX_POLIGONOS) { cortou = true; continue; }
      alvos.push({ id: r.id != null ? r.id : null, lat: r.lat, lon: r.lon, anel: quadrado(r.lat, r.lon, LADO_M) });
    }
    return { alvos, cortou };
  }
  const aneis = (alvos) => (alvos || []).map((a) => a.anel);
  // Pedido do Valhalla com os polígonos a evitar (cópia; sem alvos: o pedido como veio).
  function aplicar(pedido, alvos) {
    if (!pedido || !alvos || !alvos.length) return pedido;
    return Object.assign({}, pedido, { exclude_polygons: aneis(alvos) });
  }

  // ------------------------------------------------------------ comparação e etiqueta
  const plural = (n, um, varios) => n + " " + (n === 1 ? um : varios);
  function deltaKm(km) {
    const r = Math.round(km);
    return r === 0 ? "mesma distância" : (r > 0 ? "+" : "-") + Math.abs(r) + " km";
  }
  function deltaMin(min) {
    const r = Math.round(min);
    if (r === 0) return "mesmo tempo";
    const a = Math.abs(r), t = a >= 60 ? Math.floor(a / 60) + " h " + String(a % 60).padStart(2, "0") + " min" : a + " min";
    return (r > 0 ? "+" : "-") + t;
  }
  // original/nova: { km, minutos }. evitadas: quantas restrições violadas a nova deixou de passar; total: quantas a original
  // violava (se evitou só parte: "Evita 1 de 2 restrições").
  function etiqueta(original, nova, evitadas, total) {
    const n = Math.max(0, evitadas | 0), t = total != null ? total : n;
    const evita = n === t ? "Evita " + plural(n, "restrição", "restrições") : "Evita " + n + " de " + t + (t === 1 ? " restrição" : " restrições");
    return [evita, deltaKm(nova.km - original.km), deltaMin(nova.minutos - original.minutos)].join(" · ");
  }
  // Ids das restrições violadas (itens do RPC) que continuam na lista nova.
  const idsDe = (lista) => new Set((lista || []).map((r) => r && r.id).filter((x) => x != null));
  function evitadasEntre(violadasOriginal, violadasNova) {
    const resta = idsDe(violadasNova);
    return (violadasOriginal || []).filter((r) => r && !resta.has(r.id));
  }

  // ------------------------------------------------------------ nomes e textos
  const TIPO = { ponte: "ponte", tunel: "túnel", balsa: "balsa" };
  // Qual medida estourou: pelo texto do servidor ("altura 4.4 m > limite 4.2 m"), senão pelo que a restrição tem.
  function dimensaoViolada(r) {
    const txt = ((r && r.viola) || []).join(" ").toLowerCase();
    for (const d of ["altura", "peso", "comprimento", "largura", "eixo"]) if (txt.includes(d)) return d;
    const a = (r && r.attrs) || {};
    if (num(a.altura_max_m) != null || num(a.altura_fisica_m) != null) return "altura";
    if (num(a.peso_max_t) != null || num(a.peso_max_hgv_t) != null) return "peso";
    if (num(a.comprimento_max_m) != null) return "comprimento";
    if (num(a.largura_max_m) != null) return "largura";
    if (num(a.eixo_max_t) != null) return "eixo";
    if (a.hgv === "no") return "hgv";
    return null;
  }
  function limiteDe(r, d) {
    const a = (r && r.attrs) || {};
    const menor = (x, y) => (x == null ? y : y == null ? x : Math.min(x, y));
    if (d === "altura") return menor(num(a.altura_max_m), num(a.altura_fisica_m));
    if (d === "peso") return menor(num(a.peso_max_t), num(a.peso_max_hgv_t));
    if (d === "comprimento") return num(a.comprimento_max_m);
    if (d === "largura") return num(a.largura_max_m);
    if (d === "eixo") return num(a.eixo_max_t);
    return null;
  }
  const UNIDADE = { altura: ["metro", "metros", "m"], comprimento: ["metro", "metros", "m"], largura: ["metro", "metros", "m"], peso: ["tonelada", "toneladas", "t"], eixo: ["tonelada por eixo", "toneladas por eixo", "t"] };
  function valorFalado(d, v) {
    const u = UNIDADE[d]; if (!u || v == null) return "";
    return fmt(v) + " " + (v === 1 ? u[0] : u[1]);
  }
  // "ponte de 4,2 metros", "limite de 20 toneladas", "restrição para caminhão" (para a fala e para a mensagem)
  function nomeFalado(r) {
    const d = dimensaoViolada(r), v = limiteDe(r, d);
    const tipo = TIPO[r && r.kind] || (d === "hgv" ? "restrição para caminhão" : "limite");
    if (d === "hgv" || v == null) return tipo;
    return tipo + " de " + valorFalado(d, v);
  }
  // "Ponte do Rio Verde (altura 4,2 m)" para mensagem escrita
  function nomeCurto(r) {
    const d = dimensaoViolada(r), v = limiteDe(r, d);
    const tipo = { ponte: "Ponte", tunel: "Túnel", balsa: "Balsa" }[r && r.kind] || "Restrição";
    const n = r && (r.nome || r.rodovia) ? String(r.nome || r.rodovia) : "";
    const cabeca = n && n.toLowerCase().startsWith(tipo.toLowerCase()) ? n : tipo + (n ? " " + n : "");
    const u = UNIDADE[d];
    return cabeca + (v != null && u ? " (" + d + " " + fmt(v) + " " + u[2] + ")" : "");
  }
  // Fala ao trocar de rota navegando: "Rota alterada para desviar da ponte de 4,2 metros." (várias: "…de 3 restrições")
  function falaDesvio(violadas) {
    const l = violadas || [];
    if (!l.length) return "Rota alterada para evitar uma restrição do caminhão.";
    if (l.length === 1) {
      const n = nomeFalado(l[0]);
      return "Rota alterada para desviar " + (/^(ponte|balsa|restrição)/.test(n) ? "da " : /^túnel/.test(n) ? "do " : "do ") + n + ".";
    }
    return "Rota alterada para desviar de " + l.length + " restrições do caminhão.";
  }
  // Navegando e sem desvio possível: honesto, sem dizer que dá para passar
  function falaSemDesvio(violadas) {
    const l = violadas || [];
    return "Não achei caminho que evite " + (l.length === 1 ? "a " + nomeFalado(l[0]) : l.length + " restrições") + ". Confirme a medida no local.";
  }
  // Cartão da folha quando não há desvio: nunca diz que a rota é segura.
  function textoSemDesvio(violadas) {
    const l = violadas || [];
    if (!l.length) return "Sem caminho que evite a restrição; confirme a medida no local.";
    const nome = nomeCurto(l[0]);
    return l.length === 1 ? "Sem caminho que evite a restrição " + nome + "; confirme a medida no local."
      : "Sem caminho que evite as " + l.length + " restrições (" + nome + " e mais " + (l.length - 1) + "); confirme as medidas no local.";
  }
  function textoParcial(restantes) {
    const l = restantes || [];
    return "O desvio ainda passa por " + plural(l.length, "restrição", "restrições") + " (" + nomeCurto(l[0]) + (l.length > 1 ? " e mais " + (l.length - 1) : "") + "). Confirme a medida no local.";
  }
  // "limite da via 4,2 m · seu caminhão 4,4 m" a partir de "altura 4.4 m > limite 4.2 m" (peso e demais igual)
  function textoLimites(motivo) {
    const m = /^\s*([a-zçã]+)\s+([\d.,]+)\s*(m|t)\s*>\s*limite\s+([\d.,]+)/i.exec(String(motivo || ""));
    if (!m) return String(motivo || "");
    const un = " " + m[3].toLowerCase();
    return m[1].toLowerCase() + ": limite da via " + fmt(num(m[4])) + un + " · seu caminhão " + fmt(num(m[2])) + un;
  }
  const AVISO_FONTE = "Segundo o mapa (OSM), dado da comunidade: pode estar errado ou desatualizado. O motorista decide; confirme a medida no local.";

  // Quem pede o desvio navegando: restrições violadas a ≥ 3 km à frente do progresso, ainda não tentadas.
  function paraRecalcularNavegando(violadas, progressoM, tentadas) {
    return (violadas || []).filter((r) => r && typeof r.ao_longo_m === "number" && r.ao_longo_m - progressoM >= NAV_MIN_ADIANTE_M && !(tentadas && tentadas.has(r.id)));
  }

  // ------------------------------------------------------------ desvio fácil × grande
  const FACIL_KM = 5, FACIL_MIN = 8; // desvio pequeno (< 5 km ou < 8 min a mais, já sem nova violação): sai desviado, sem perguntar
  function extra(original, nova) { return { km: nova.km - original.km, minutos: nova.minutos - original.minutos }; }
  function facil(original, nova) { const e = extra(original, nova); return e.km < FACIL_KM || e.minutos < FACIL_MIN; }
  // Registro para a rota e o resumo da viagem: um item por restrição evitada
  function registro(evitadas, original, nova) {
    const e = extra(original, nova);
    return (evitadas || []).map((r) => ({ id: r.id, tipo: r.kind || "restricao", nome: r.nome || null, rodovia: r.rodovia || null, km: r.km != null ? r.km : null,
      dim: dimensaoViolada(r), descricao: nomeCurto(r), falado: nomeFalado(r), lat: r.lat, lon: r.lon, ao_longo_m: r.ao_longo_m, extraKm: Math.round(e.km * 10) / 10, extraMin: Math.round(e.minutos) }));
  }
  // "↪ Desvio de 1 restrição (ponte 4,2 m) · +3 km"
  function linhaFolha(reg) {
    const l = reg || [];
    if (!l.length) return "";
    const med = (r) => { const m = /\((.*)\)\s*$/.exec(r.descricao || ""); const n = (r.descricao || "").split(" (")[0]; return m ? n.split(" ")[0].toLowerCase() + " " + m[1].replace(/^(altura|peso|comprimento|largura|eixo) /, "") : n; };
    const km = Math.round(l[0].extraKm);
    return "\u21aa Desvio de " + plural(l.length, "restrição", "restrições") + (l.length === 1 ? " (" + med(l[0]) + ")" : "") + " · " + (km >= 0 ? "+" : "-") + Math.abs(km) + " km";
  }
  function falaInicio(violadas) {
    const l = violadas || [];
    if (l.length !== 1) return "Rota ajustada para evitar " + l.length + " restrições do caminhão.";
    const d = l[0].dim || dimensaoViolada(l[0]), tipo = l[0].kind || l[0].tipo;
    return "Rota ajustada para evitar " + (d === "altura" ? (tipo === "tunel" ? "um túnel baixo" : "uma ponte baixa") : d === "peso" ? "um limite de peso" : "uma restrição do caminhão") + ".";
  }
  function falaPerto(r) { const n = r.falado || nomeFalado(r); return "Estamos desviando " + (/^(ponte|balsa|restrição)/.test(n) ? "da " : "do ") + n + ", siga a rota."; }

  const api = { FACIL_KM, FACIL_MIN, facil, extra, registro, linhaFolha, falaInicio, falaPerto, LADO_M, MAX_POLIGONOS, NAV_MIN_ADIANTE_M, quadrado, distM, acumular, aneis, aplicar, etiqueta, deltaKm, deltaMin, evitadasEntre,
    dimensaoViolada, nomeFalado, nomeCurto, falaDesvio, falaSemDesvio, textoSemDesvio, textoParcial, textoLimites, AVISO_FONTE, paraRecalcularNavegando };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoDesvio = api;
})(typeof window !== "undefined" ? window : globalThis);
