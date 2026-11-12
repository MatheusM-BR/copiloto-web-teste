// Faixas e saída na faixa da manobra (rodada 6; lógica em rotapref.js). Duas fontes, as duas SEM inventar nada:
//  - Saída: o `sign` da manobra do /route (exit_number / exit_name / ramo / sentido) → "Saída km 93" e "BR-153 → Anápolis / …".
//    Cobertura medida em 04/11/2026 (Goiânia → Anápolis, Valhalla público): aparece nas saídas de rodovia com número cadastrado.
//  - Faixas: `edge.turn_lanes` do /trace_attributes (o mesmo pedido compartilhado do limite e da via, tracecache.js) da aresta
//    que termina na manobra → símbolos de faixa, a indicada em destaque. O servidor público NÃO devolveu turn_lanes em nenhuma
//    das rotas testadas (Goiânia–Anápolis, São Paulo, Paris): enquanto o mapa não tiver o dado, nada aparece.
//  - Tira de faixas (rodada 7): uma caixa por faixa (44 px; 36 e 28 px com 5–6 e 7+ faixas), seta SVG por direção, as faixas a usar
//    preenchidas, com contorno grosso e a recomendada com anel (não depende só da cor), alto contraste nos dois temas (estilos/rota6.css).
//  - Voz: "Use as duas faixas da direita." UMA vez por manobra, quando ela chega a ≤ 400 m (até 700 m em velocidade) e só se o dado
//    diz quais faixas servem; sem dado, ou todas servindo, não fala nada.
// Só navegando, uma rota por vez; sem internet ou erro, fica sem faixas. Expõe Copiloto.faixas: desenhar(manobra, rota),
// estado() ({ chave, arestas, completo }), carregar(rota, perfil), injetar(rota, lidas) (outras fontes, ex.: turn:lanes do OSM,
// entram no mesmo desenho: lidas = [{ fim: índice da forma, faixas }]).
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
    falados = new Set();
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

  let ultima = null, distManobra = null, falados = new Set();
  const NS = "http://www.w3.org/2000/svg";
  // seta para cima (frente) girada pelo ângulo da direção; retorno tem desenho próprio
  const ANGULO = { frente: 0, dir_leve: 45, direita: 90, dir_forte: 135, esq_leve: -45, esquerda: -90, esq_forte: -135, junta_dir: 45, junta_esq: -45 };
  const SETA = "M12 2 L4.5 11 H10 V22 H14 V11 H19.5 Z", RETORNO = "M17 22 V9 a5 5 0 0 0 -10 0 v6 H4 l5 6 l5 -6 h-3 V9 a1 1 0 0 1 2 0 V22 Z";
  function seta(dir, pequena) {
    const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "nav-seta" + (pequena ? " pequena" : "")); svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(NS, "path"); p.setAttribute("d", dir === "retorno" ? RETORNO : SETA); p.setAttribute("fill", "currentColor");
    if (dir !== "retorno") p.setAttribute("transform", "rotate(" + (ANGULO[dir] || 0) + " 12 12)");
    svg.appendChild(p); return svg;
  }
  function limiteFalaM() { const g = C.estado && C.estado.gps, v = g ? (g.kmh != null ? g.kmh : g.velKmh) : null; return Math.min(700, Math.max(400, v ? (v / 3.6) * 22 : 0)); }
  function falarSePerto() {
    const u = ultima; if (!u || !u.fala || distManobra == null || distManobra > limiteFalaM()) return;
    const chave = (reg ? reg.chave : "") + ":" + u.m.indice_forma;
    if (falados.has(chave)) return;
    falados.add(chave);
    if (C.voz && C.voz.falar) C.voz.falar(u.fala, { naoInterromper: true, esperaMaxMs: 8000 });
  }
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
    ultima.fala = faixas ? RP.falaFaixas(faixas) : "";
    const saida = RP.lerSaida(m.sign);
    if (!faixas && !saida) { c.hidden = true; return; }
    if (faixas) {
      const fila = el("span", "nav-faixas-fila"); fila.setAttribute("role", "img"); fila.setAttribute("aria-label", RP.textoFaixas(faixas));
      fila.dataset.n = String(faixas.length); fila.classList.add(faixas.length === 1 ? "n1" : faixas.length <= 4 ? "n4" : faixas.length <= 6 ? "n6" : "n8");
      for (const f of faixas) {
        const g = el("span", "nav-faixa" + (f.valida ? " valida" : "") + (f.indicada ? " indicada" : ""));
        g.dataset.dir = f.direcoes.join(" ");
        for (const d of f.direcoes) g.appendChild(seta(d, f.direcoes.length > 1));
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
    falarSePerto();
  }
  function injetar(rota, lidas) {
    if (!rota || !Array.isArray(rota.coords) || !Array.isArray(lidas)) return;
    if (!reg || reg.coords !== rota.coords) reg = { chave: "injetada", coords: rota.coords, lidas: [], completo: true };
    for (const l of lidas) if (l && isFinite(l.fim) && Array.isArray(l.faixas) && l.faixas.length) reg.lidas.push({ fim: Number(l.fim), faixas: l.faixas });
    if (ultima) desenhar(ultima.m, ultima.rota);
  }

  C.faixas = { desenhar, carregar, injetar, estado: () => (reg ? { chave: reg.chave, arestas: reg.lidas.length, completo: reg.completo } : null) };

  C.aoIniciar(() => {
    C.on("navegacao", (d) => {
      if (!d || !d.ativa) { reg = null; ultima = null; distManobra = null; falados = new Set(); limpar(); return; }
      distManobra = typeof d.manobra_m === "number" ? d.manobra_m : null;
      falarSePerto();
      const r = C.rota && C.rota.atual ? C.rota.atual() : null;
      if (r && (!reg || reg.coords !== r.coords)) carregar(r, r.perfil);
    });
  });
})(window.Copiloto);
