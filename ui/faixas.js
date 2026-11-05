// Faixas e saída na faixa da manobra (rodada 6; lógica em rotapref.js). Duas fontes, as duas SEM inventar nada:
//  - Saída: o `sign` da manobra do /route (exit_number / exit_name / ramo / sentido) → "Saída km 93" e "BR-153 → Anápolis / …".
//    Cobertura medida em 04/11/2026 (Goiânia → Anápolis, Valhalla público): aparece nas saídas de rodovia com número cadastrado.
//  - Faixas: `edge.turn_lanes` do /trace_attributes (o mesmo pedido compartilhado do limite e da via, tracecache.js) da aresta
//    que termina na manobra → símbolos de faixa, a indicada em destaque. O servidor público NÃO devolveu turn_lanes em nenhuma
//    das rotas testadas (Goiânia–Anápolis, São Paulo, Paris): enquanto o mapa não tiver o dado, nada aparece.
// Só navegando, uma rota por vez; sem internet ou erro, fica sem faixas. Expõe Copiloto.faixas: desenhar(manobra, rota),
// estado() ({ chave, pedacos, faixas: n de arestas com faixas }), carregar(rota, perfil).
(function (C) {
  "use strict";
  const { $, el } = C.util;
  const RP = window.CopilotoRotaPref, L = window.CopilotoLimite, Rota = window.CopilotoRota;
  let reg = null;          // { chave, coords, lidas: [{ fim, faixas }], completo }
  let caixa = null;
  const buscando = new Set();

  function urlTrace() {
    if (window.COPILOTO_URL_TRACE) return window.COPILOTO_URL_TRACE;
    const r = window.COPILOTO_URL_ROTA;
    return r && /\/route$/.test(r) ? r.replace(/\/route$/, "/trace_attributes") : L.URL_TRACE_PADRAO;
  }
  const online = () => !(navigator && navigator.onLine === false);
  const chaveDe = (coords, caminhao) => L.chaveRota(coords, caminhao);

  async function carregar(rota, perfil) {
    if (!rota || !Array.isArray(rota.coords) || rota.coords.length < 2 || !online()) return;
    const caminhao = Rota.ehCaminhao(perfil !== undefined ? perfil : rota.perfil);
    const chave = chaveDe(rota.coords, caminhao);
    if ((reg && reg.chave === chave) || buscando.has(chave)) return;
    const novo = { chave, coords: rota.coords, lidas: [], completo: false };
    reg = novo; buscando.add(chave);
    const V = window.CopilotoVia;
    const pedacos = V && V.fatiar ? V.fatiar(rota.coords) : L.dividir(rota.coords);
    try {
      let completo = true;
      for (const p of pedacos) {
        const res = await window.CopilotoTrace.compartilhado.postar(urlTrace(), L.pedidoTrace(rota.coords.slice(p.de, p.ate + 1), caminhao));
        if (res.rede || !res.json) { completo = false; break; }
        for (const e of RP.lerFaixas(res.json)) novo.lidas.push({ fim: e.fim + p.de, faixas: e.faixas });
      }
      novo.completo = completo;
    } catch (e) { /* sem faixas: a saída (do /route) continua */ }
    finally { buscando.delete(chave); }
    if (reg === novo) { const g = ultima; if (g) desenhar(g.m, g.rota); }
  }

  let ultima = null;
  function garantirCaixa() {
    if (caixa && caixa.isConnected) return caixa;
    const rua = $("nav-rua"); if (!rua || !rua.parentNode) return null;
    caixa = el("div", "nav-faixas"); caixa.id = "nav-faixas"; caixa.hidden = true;
    rua.parentNode.insertBefore(caixa, rua.nextSibling);
    return caixa;
  }
  function limpar() { if (caixa) { caixa.textContent = ""; caixa.hidden = true; } }

  // m: manobra da navegação ({ indice_forma, sign }); rota: a rota em uso (para casar com o que foi lido)
  function desenhar(m, rota) {
    ultima = m ? { m, rota } : null;
    const c = garantirCaixa(); if (!c) return;
    c.textContent = "";
    if (!m || m.semCurvas) { c.hidden = true; return; }
    const faixas = reg && rota && reg.coords === rota.coords ? RP.faixasDaManobra(reg.lidas, m.indice_forma) : null;
    const saida = RP.lerSaida(m.sign);
    if (!faixas && !saida) { c.hidden = true; return; }
    if (faixas) {
      const fila = el("span", "nav-faixas-fila"); fila.setAttribute("role", "img"); fila.setAttribute("aria-label", RP.textoFaixas(faixas));
      for (const f of faixas) {
        const g = el("span", "nav-faixa" + (f.valida ? " valida" : "") + (f.indicada ? " indicada" : ""), f.direcoes.map((d) => RP.GLIFO[d]).join(""));
        g.setAttribute("aria-hidden", "true"); fila.appendChild(g);
      }
      c.appendChild(fila);
    }
    if (saida) {
      const s = el("span", "nav-saida", saida.rotulo); s.id = "nav-saida";
      if (saida.detalhe) s.appendChild(el("small", null, saida.detalhe));
      c.appendChild(s);
    }
    c.hidden = false;
  }

  C.faixas = { desenhar, carregar, estado: () => (reg ? { chave: reg.chave, arestas: reg.lidas.length, completo: reg.completo } : null) };

  C.aoIniciar(() => {
    C.on("navegacao", (d) => {
      if (!d || !d.ativa) { reg = null; ultima = null; limpar(); return; }
      const r = C.rota && C.rota.atual ? C.rota.atual() : null;
      if (r && (!reg || reg.coords !== r.coords)) carregar(r, r.perfil);
    });
  });
})(window.Copiloto);
