// Ruído dos avisos da estrada (lógica pura, sem DOM; testada em tests/ruido.test.js e tests/ruido_regressao.test.js).
// O mapa aberto despeja dado bruto (Dutra SP-RJ: 131 avisos por 100 km). Este módulo faz, do lado do app, o mesmo que as
// migrações de r5 fazem no servidor (defesa em profundidade: rota guardada antes da migração, servidor sem a migração):
//   limparFeicoes / limparTrechos / limparRestricoes   tiram o que não é da pista da rota (outra pista, rua que cruza,
//                                                      viaduto por cima, curva em via pequena, lombada de rodovia, rumble strip)
//   buscarFeicoes                                      pagina copiloto_route_features_pag por along_route_m até cobrir a rota
//   finalizar(avisos)                                  junta km seguidos de trecho perigoso, marca o que só vai para a tela
//                                                      (semVoz), "só acima de 50 km/h" (minKmh) e põe o teto de ~25 falas/100 km
// Convenção: aviso.semVoz = fica na tela/mapa, mas o avisador não fala.
(function (raiz) {
  "use strict";

  const OFF_PONTO_M = 12, OFF_LINHA_M = 15, OFF_CAMADA_M = 5, SOBREPOSICAO_MIN = 0.5, ANGULO_MAX = 30;
  const CURVA_VIAS = ["motorway", "trunk", "primary"], CURVA_COMP_MIN_M = 40, CURVA_KMH_MIN = 50;
  const PONTOS_NA_PISTA = ["radar", "lombada", "curva", "perigo", "restricao"];
  const TETO_VOZ_100KM = 25, JANELA_M = 100000, TETO_VOZ_20KM = 6, JANELA_CURTA_M = 20000;
  const JUNTAR_KM_M = 1500, JUNTAR_ALTO_M = 3000;   // trechos perigosos críticos a até 1,5 km um do outro (alto: 3 km) viram um aviso só
  // ordem do corte da voz (maior fica): restrição > perigoso 3 > (balança, balsa, passagem de nível, área de escape, perigo, obra) > radar > curva > lombada
  const RANK_VOZ = { restricao: 100, perigoso3: 90, balanca: 85, balsa: 85, passagem_nivel: 80, area_escape: 75, perigo: 75, obra: 70, radar: 60, curva: 50, lombada: 40, lombadas: 40, praca_pedagio: 35 };

  const num = (v) => { const n = typeof v === "string" ? parseFloat(v) : v; return typeof n === "number" && isFinite(n) ? n : null; };
  const way = (f) => String(f && f.source_key || "").split("/")[0];

  // ------------------------------------------------------------ dados crus → limpos
  // linhas de copiloto_route_features (ou das páginas de copiloto_route_features_pag)
  function limparFeicoes(linhas) {
    const vistos = new Set(), out = [];
    for (const f of Array.isArray(linhas) ? linhas : []) {
      if (!f || typeof f.along_route_m !== "number") continue;
      if (f.id != null) { if (vistos.has(f.id)) continue; vistos.add(f.id); }
      const a = f.attrs || {}, ponto = f.end_route_m == null && f.length_m == null;
      if (f.kind === "curva") {
        if (!CURVA_VIAS.includes(f.highway)) continue;
        const c = num(a.comprimento_m);
        if (c == null || c < CURVA_COMP_MIN_M) continue;
      }
      if (f.kind === "lombada" && (f.highway === "motorway" || f.highway === "motorway_link" || a.tipo === "rumble_strip")) continue;
      const off = num(f.off_route_m);
      if (ponto && off != null && PONTOS_NA_PISTA.includes(f.kind) && off > OFF_PONTO_M) continue;   // outra pista da dupla
      if (!ponto && num(a.rota_angulo) != null && a.rota_angulo > ANGULO_MAX) continue;               // cruza a rota
      out.push(f);
    }
    return out;
  }

  // Sentido da rota em cada BR: tendência do km ao longo da rota (vizinhos: 4 antes e 4 depois), como o SQL.
  // O trecho da PRF de sentido contrário (ou "desconhecido"/sem tendência: fica) sai.
  function limparTrechos(resp) {
    if (!resp || !Array.isArray(resp.trechos)) return resp;
    const todos = resp.trechos.filter((t) => t && typeof t.ao_longo_m === "number").slice().sort((a, b) => a.ao_longo_m - b.ao_longo_m || a.id - b.id);
    const porBr = new Map();
    for (const t of todos) { const k = t.br != null ? t.br : t.rodovia; if (!porBr.has(k)) porBr.set(k, []); porBr.get(k).push(t); }
    const ficam = new Set(), vistos = new Set();
    for (const lista of porBr.values()) {
      for (let i = 0; i < lista.length; i++) {
        const t = lista[i];
        if (vistos.has(t.id)) continue;
        const tend = inclinacao(lista.slice(Math.max(0, i - 4), i + 5));
        if (t.sentido === "crescente" || t.sentido === "decrescente") { if (tend != null && tend !== 0 && (tend > 0) !== (t.sentido === "crescente")) continue; }
        vistos.add(t.id); ficam.add(t);
      }
    }
    const trechos = todos.filter((t) => ficam.has(t));
    const nivel = (n) => trechos.filter((t) => t.nivel === n).length;
    return Object.assign({}, resp, { trechos, total: trechos.length, por_nivel: { 1: nivel(1), 2: nivel(2), 3: nivel(3) } });
  }
  function inclinacao(ts) {   // regr_slope(km, ao_longo_m): só o sinal importa
    const p = ts.filter((t) => num(t.km) != null);
    if (p.length < 2) return null;
    const mx = p.reduce((s, t) => s + t.ao_longo_m, 0) / p.length, my = p.reduce((s, t) => s + t.km, 0) / p.length;
    let sxy = 0, sxx = 0;
    for (const t of p) { sxy += (t.ao_longo_m - mx) * (t.km - my); sxx += (t.ao_longo_m - mx) ** 2; }
    return sxx > 0 ? sxy : null;
  }

  // copiloto_route_restrictions: restricao + ponte/tunel da mesma way viram uma; camada <> 0 fora da rota, pista paralela
  // (a mais de 15 m), sobreposição < 50 % e ponto a mais de 12 m saem. Recalcula os totais.
  function limparRestricoes(resp) {
    if (!resp || !Array.isArray(resp.restricoes)) return resp;
    const peso = { restricao: 0, tunel: 1, ponte: 2, balsa: 3 };
    const porWay = new Map(), semWay = [];
    for (const r of resp.restricoes) {
      if (!r) continue;
      const a = r.attrs || {};
      const ponto = r.fim_m == null;
      const off = num(r.fora_da_rota_m);
      if (num(a.rota_sobreposicao) != null && a.rota_sobreposicao < SOBREPOSICAO_MIN) continue;
      if (off != null && off > (ponto ? OFF_PONTO_M : OFF_LINHA_M)) continue;
      if (num(a.camada) != null && a.camada !== 0 && off != null && off > OFF_CAMADA_M) continue;
      if (!/^[wnr]\d+\//.test(String(r.source_key || ""))) { semWay.push(r); continue; }
      const k = way(r), antes = porWay.get(k);
      if (!antes) { porWay.set(k, r); continue; }
      const [ficar, sair] = (peso[r.kind] != null ? peso[r.kind] : 9) < (peso[antes.kind] != null ? peso[antes.kind] : 9) ? [r, antes] : [antes, r];
      const sa = sair.attrs || {};
      const attrs = Object.assign({}, ficar.attrs);
      if (attrs.camada == null && sa.camada != null) attrs.camada = sa.camada;
      if (!attrs.estrutura && (sair.kind === "tunel" || sair.kind === "ponte")) attrs.estrutura = sair.kind;
      porWay.set(k, Object.assign({}, ficar, { attrs }));
    }
    const restricoes = Array.from(porWay.values()).concat(semWay).sort((a, b) => a.ao_longo_m - b.ao_longo_m || a.id - b.id);
    const ordem = (r) => (r.status === "viola" ? 0 : r.status === "condicional" ? 1 : 2);
    restricoes.sort((a, b) => ordem(a) - ordem(b) || a.ao_longo_m - b.ao_longo_m);
    const c = (s) => restricoes.filter((r) => r.status === s).length;
    return Object.assign({}, resp, { restricoes, total: restricoes.length, violadas: c("viola"), condicionais: c("condicional"), desconhecidas: c("desconhecido") });
  }

  // ------------------------------------------------------------ paginação de copiloto_route_features_pag
  // rpc(nome, params) → Promise. Repete a partir de `proximo_m` enquanto `truncado`; sem a RPC nova (404), cai na antiga.
  async function buscarFeicoes(rpc, rota, o) {
    const op = o || {}, kinds = op.kinds || null, buffer = op.buffer || 40, limite = op.limite || 800, maxPaginas = op.maxPaginas || 12;
    const todas = []; const vistos = new Set();
    let de = 0;
    for (let i = 0; i < maxPaginas; i++) {
      let j;
      try { j = await rpc("copiloto_route_features_pag", { p_route: rota, p_kinds: kinds, p_buffer_m: buffer, p_limit: limite, p_from_m: de }); }
      catch (x) {
        if (i === 0 && ausente(x)) return limparFeicoes(await rpc("copiloto_route_features", { p_route: rota, p_kinds: kinds, p_buffer_m: buffer, p_limit: 2000 }));
        throw x;
      }
      for (const f of j && Array.isArray(j.feicoes) ? j.feicoes : []) if (!vistos.has(f.id)) { vistos.add(f.id); todas.push(f); }
      if (!j || !j.truncado || !(j.proximo_m > de)) { todas.truncado = !!(j && j.truncado && !(j.proximo_m > de)); break; }
      de = j.proximo_m;
      if (i === maxPaginas - 1) todas.truncado = true;
    }
    const out = limparFeicoes(todas);
    out.truncado = !!todas.truncado;
    return out;
  }
  function ausente(x) { const c = String(x && x.code || ""); return c === "PGRST202" || c === "http_404" || (x && x.status === 404); }

  // ------------------------------------------------------------ avisos prontos → voz × tela
  const fmtKm = (m) => { const k = Math.max(1, Math.round(m / 1000)); return k; };
  const pluralKm = (k) => k + (k === 1 ? " quilômetro" : " quilômetros");
  function juntarTrechos(avisos) {
    const per = avisos.filter((a) => a.tipo === "perigoso").sort((a, b) => a.ao_longo_m - b.ao_longo_m);
    if (!per.length) return avisos;
    const outros = avisos.filter((a) => a.tipo !== "perigoso");
    const grupos = (lista, gap) => { const gs = []; for (const a of lista) { const g = gs[gs.length - 1]; if (g && a.ao_longo_m - g[g.length - 1].ao_longo_m <= gap) g.push(a); else gs.push([a]); } return gs; };
    const g3 = grupos(per.filter((a) => (a.nivel || 0) >= 3), JUNTAR_KM_M).map((g) => ({ g, ini: g[0].ao_longo_m, fim: g[g.length - 1].ao_longo_m }));
    const dentro = (a) => g3.some((x) => a.ao_longo_m >= x.ini - JUNTAR_KM_M && a.ao_longo_m <= x.fim + JUNTAR_KM_M);
    const g2 = grupos(per.filter((a) => (a.nivel || 0) < 3 && !dentro(a)), JUNTAR_ALTO_M);
    const novo = [];
    for (const g of g3.map((x) => x.g)) novo.push(grupo(g, 3));
    for (const g of g2) novo.push(grupo(g, 2));
    return outros.concat(novo);
  }
  function grupo(g, nivel) {
    const ini = g[0], fim = g[g.length - 1];
    const km = fmtKm(fim.ao_longo_m - ini.ao_longo_m + 1000);
    const acid = g.reduce((s, a) => s + (num(a.acidentes) || 0), 0);
    const crit = nivel >= 3;
    const detalhe = [ini.detalhe && ini.detalhe.split(" · ").slice(0, 2).join(" · "), km > 1 ? km + " km" : null, g.length > 1 ? g.length + " pontos de acidente" : ini.detalhe && ini.detalhe.split(" · ").slice(2).join(" · ")].filter(Boolean).join(" · ");
    return Object.assign({}, ini, {
      id: "prf:grupo:" + ini.id, nivel, prioridade: crit ? 90 : 80, chave: crit ? "perigoso3" : "perigoso2", agrupado: true, km_grupo: km,
      texto: (crit ? "Trecho crítico" : "Trecho de risco alto") + (km > 1 ? ": próximos " + km + " km" : ""),
      fala: crit ? (km > 1 ? "Trecho crítico, próximos " + pluralKm(km) + "." : "Trecho crítico à frente.") : ini.fala,
      detalhe, semVoz: !crit,
    });
  }

  function rankVoz(a) { return a.tipo === "perigoso" ? (a.nivel >= 3 ? RANK_VOZ.perigoso3 : 0) : (RANK_VOZ[a.tipo] != null ? RANK_VOZ[a.tipo] : 30); }

  // Teto de falas: no máximo `porCemKm` (25) em qualquer janela de 100 km e 6 em qualquer janela de 20 km (não deixa juntar
  // tudo num trecho), por ordem de rank de voz; restrição nunca é cortada. O cortado vira semVoz (continua na tela).
  function limitarVoz(avisos, porCemKm) {
    const teto20 = Number(raiz.COPILOTO_TETO_VOZ_20KM) > 0 ? Number(raiz.COPILOTO_TETO_VOZ_20KM) : TETO_VOZ_20KM; // só os testes mudam (rota de 6 km com tudo junto)
    const janelas = [[JANELA_M, porCemKm || TETO_VOZ_100KM], [JANELA_CURTA_M, teto20]];
    const aceitos = [];      // posições (m), ordenadas
    const candidatos = avisos.filter((a) => !a.semVoz).sort((a, b) => rankVoz(b) - rankVoz(a) || a.ao_longo_m - b.ao_longo_m);
    const contar = (de, ate) => { let n = 0; for (const p of aceitos) if (p >= de && p <= ate) n++; return n; };
    for (const a of candidatos) {
      const x = a.ao_longo_m;
      let cabe = a.tipo === "restricao";
      if (!cabe) {
        cabe = true;
        // janelas que contêm x começam em [x-J, x]; basta olhar as que começam em x-J, em x e em cada aceito nesse intervalo
        for (const [J, teto] of janelas) {
          const inicios = [x - J, x].concat(aceitos.filter((p) => p >= x - J && p <= x));
          for (const s of inicios) if (contar(s, s + J) >= teto) { cabe = false; break; }
          if (!cabe) break;
        }
      }
      if (cabe) { aceitos.push(x); aceitos.sort((p, q) => p - q); } else a.semVoz = true;
    }
    return avisos;
  }

  // Última etapa depois de D.juntarAvisos: junta trechos perigosos, marca curva (50 km/h, fala "pode haver"), aplica o teto.
  function finalizar(avisos, o) {
    const op = o || {};
    let lista = juntarTrechos((avisos || []).map((a) => Object.assign({}, a)));
    for (const a of lista) {
      if (a.tipo === "curva") { a.minKmh = CURVA_KMH_MIN; a.estimado = true; }
      if (a.tipo === "perigoso" && !a.agrupado && !(a.nivel >= 3)) a.semVoz = true;
    }
    lista = limitarVoz(lista, op.porCemKm);
    lista.sort((a, b) => a.ao_longo_m - b.ao_longo_m || b.prioridade - a.prioridade);
    return lista;
  }

  // Avisos por 100 km (para medir): { total, voz } sobre uma lista finalizada e a distância da rota em metros
  function porCemKm(avisos, distanciaM) {
    const k = distanciaM / 100000;
    return { total: avisos.length / k, voz: avisos.filter((a) => !a.semVoz).length / k };
  }

  const api = { limparFeicoes, limparTrechos, limparRestricoes, buscarFeicoes, finalizar, juntarTrechos, limitarVoz, porCemKm, rankVoz,
    TETO_VOZ_100KM, TETO_VOZ_20KM, CURVA_KMH_MIN, OFF_PONTO_M, CURVA_VIAS, CURVA_COMP_MIN_M, JUNTAR_KM_M };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoRuido = api;
})(typeof window !== "undefined" ? window : globalThis);
