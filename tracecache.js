// Pedidos ao /trace_attributes do Valhalla compartilhados (r5). O limite de velocidade (ui/limite.js) e a "Via do trajeto"
// (ui/via.js) mandavam, cada um, a MESMA forma da rota ao mesmo servidor, com listas de atributos diferentes (2 pedidos de até
// 450 km por rota). Aqui os dois pedem pelo mesmo caminho: o corpo é normalizado com a UNIÃO dos atributos (a resposta serve aos
// dois, atributo a mais não atrapalha), pedidos iguais em andamento viram um só e a resposta fica ~15 min na memória (até 6).
// Só vale para encoded_polyline + shape_match (trace); outras URLs (ex.: /height) passam direto.
// criar({ fetch, agora, timeoutMs, ttlMs, max }) → { postar(url, corpo) → Promise<{ json } | { rede: true }>, normalizar, chave, limpar, pedidosReais }.
(function (raiz) {
  "use strict";

  // união do que ui/limite.js (limite.js), ui/via.js (viaqualidade.js) e ui/faixas.js (edge.turn_lanes, rodada 6) pedem; o teste confere que nada ficou de fora
  const ATRIBUTOS = ["edge.begin_shape_index", "edge.density", "edge.end_shape_index", "edge.length", "edge.lane_count", "edge.max_downward_grade",
    "edge.max_upward_grade", "edge.mean_elevation", "edge.names", "edge.road_class", "edge.speed_limit", "edge.surface", "edge.traversability",
    "edge.truck_speed", "edge.turn_lanes", "edge.use", "edge.weighted_grade"];

  function normalizar(corpo) {
    if (!corpo || typeof corpo !== "object" || typeof corpo.encoded_polyline !== "string") return corpo;
    const atrs = corpo.filters && Array.isArray(corpo.filters.attributes) ? corpo.filters.attributes : [];
    const uniao = Array.from(new Set(ATRIBUTOS.concat(atrs))).sort();
    return Object.assign({}, corpo, { filters: Object.assign({}, corpo.filters, { attributes: uniao, action: "include" }) });
  }
  const chave = (url, corpo) => url + "|" + corpo.costing + "|" + corpo.units + "|" + corpo.shape_match + "|" + corpo.encoded_polyline;

  function criar(o) {
    const op = o || {};
    const buscar = op.fetch || (typeof fetch === "function" ? fetch.bind(raiz) : null);
    const agora = op.agora || (() => Date.now());
    const timeoutMs = op.timeoutMs || 30000, ttlMs = op.ttlMs || 15 * 60000, max = op.max || 6;
    const emVoo = new Map(), guardado = new Map();   // chave → Promise | { t, json }
    let reais = 0;

    async function http(url, corpo) {
      reais++;
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const t = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs);
      try {
        const resp = await buscar(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo), signal: ctl ? ctl.signal : undefined });
        return { json: await resp.json().catch(() => null) };
      } catch (e) { return { rede: true }; } finally { clearTimeout(t); }
    }
    async function postar(url, corpoOriginal) {
      const trace = corpoOriginal && typeof corpoOriginal.encoded_polyline === "string";
      if (!trace) return http(url, corpoOriginal);
      const corpo = normalizar(corpoOriginal), k = chave(url, corpo);
      const g = guardado.get(k);
      if (g && agora() - g.t < ttlMs) { guardado.delete(k); guardado.set(k, g); return { json: g.json }; }
      if (emVoo.has(k)) return emVoo.get(k);
      const p = http(url, corpo).then((r) => {
        // só guarda resposta boa (com arestas); erro do servidor ou rede: o próximo pedido tenta de novo
        if (r.json && Array.isArray(r.json.edges)) { guardado.set(k, { t: agora(), json: r.json }); while (guardado.size > max) guardado.delete(guardado.keys().next().value); }
        return r;
      }).finally(() => emVoo.delete(k));
      emVoo.set(k, p);
      return p;
    }
    return { postar, normalizar, chave, limpar: () => { guardado.clear(); emVoo.clear(); }, pedidosReais: () => reais };
  }

  const api = { criar, normalizar, chave, ATRIBUTOS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { raiz.CopilotoTrace = api; raiz.CopilotoTrace.compartilhado = criar(); }
})(typeof window !== "undefined" ? window : globalThis);
