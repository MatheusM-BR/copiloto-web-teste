// Endereço próximo para o SOS (equipe B; lógica pura em endereco.js, window.CopilotoEndereco).
// Copiloto.endereco.perto({ lat, lon, rumo? }) → Promise de { rodovia, km, rua, bairro, cidade, uf, texto, fonte } ou null.
//  1) do próprio mapa, sem internet: feições já carregadas da OpenFreeMap (querySourceFeatures nas camadas
//     transportation_name e place; se a área não estiver carregada, queryRenderedFeatures em volta do ponto na tela)
//  2) com internet: geocodificação reversa pontual no Nominatim (jsonv2, pt-BR), no máximo 1 pedido por segundo e com
//     cache por ~100 m / 5 min; só quando alguém pede (tela de Emergência), nunca em lote. Falhou: fica o do mapa.
// A posição vai ao Nominatim (OpenStreetMap) só nesse pedido; a Emergência (ui/privacidade.js), o consentimento e a política dizem isso.
// Posição DO MOTORISTA (opcao propria: true, a Emergência) só com a localização permitida; o ponto tocado no mapa vai sempre.
// km de rodovia: null (nenhuma das fontes traz o marco quilométrico; não é inventado).
(function (C) {
  "use strict";
  const E = window.CopilotoEndereco;
  const TEMPO_LIMITE_MS = 6000;
  const CAMADAS_VIA = ["transportation_name"];
  const CAMADAS_LUGAR = ["place"];
  let cache = [];             // respostas da internet [{ lat, lon, em, valor }]
  let ultimoPedidoEm = null;  // hora do último pedido ao Nominatim
  let emVoo = null;           // { lat, lon, promessa }

  const online = () => navigator.onLine !== false;

  // Fontes vetoriais do estilo carregado (a OpenFreeMap chama de "openmaptiles")
  function fontesVetoriais(m) {
    let estilo;
    try { estilo = m.getStyle(); } catch (e) { return []; }
    const fontes = (estilo && estilo.sources) || {};
    return Object.keys(fontes).filter((id) => fontes[id] && fontes[id].type === "vector");
  }
  function geo(f) { return { geometry: f.geometry, properties: f.properties || {} }; }

  function feicoesDoMapa(p) {
    const m = C.mapa;
    const vias = [], lugares = [];
    if (!m) return { vias, lugares };
    for (const id of fontesVetoriais(m)) {
      for (const camada of CAMADAS_VIA) { try { for (const f of m.querySourceFeatures(id, { sourceLayer: camada })) vias.push(geo(f)); } catch (e) { /* sem a camada */ } }
      for (const camada of CAMADAS_LUGAR) { try { for (const f of m.querySourceFeatures(id, { sourceLayer: camada })) lugares.push(geo(f)); } catch (e) { /* sem a camada */ } }
    }
    if (!vias.length && !lugares.length) {
      // a fonte não tem nada guardado na memória: tenta o que está desenhado em volta do ponto (se ele estiver na tela)
      try {
        const px = m.project([p.lon, p.lat]), c = m.getCanvas();
        if (px.x >= 0 && px.y >= 0 && px.x <= c.clientWidth && px.y <= c.clientHeight) {
          for (const f of m.queryRenderedFeatures([[px.x - 150, px.y - 150], [px.x + 150, px.y + 150]])) {
            if (CAMADAS_VIA.includes(f.sourceLayer)) vias.push(geo(f));
            else if (CAMADAS_LUGAR.includes(f.sourceLayer)) lugares.push(geo(f));
          }
        }
      } catch (e) { /* mapa sem estilo */ }
    }
    return { vias, lugares };
  }

  function doMapa(p, opcoes) {
    try {
      const { vias, lugares } = feicoesDoMapa(p);
      return E.doMapa({ vias, lugares, ponto: { lat: p.lat, lon: p.lon } }, opcoes);
    } catch (e) { return null; }
  }

  async function daInternet(p, opcoes) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = setTimeout(() => { if (ctrl) ctrl.abort(); }, TEMPO_LIMITE_MS);
    try {
      // identificação pela política do Nominatim: o navegador manda o Referer do app (origem); sem cookies
      const resp = await fetch(E.urlNominatim(p.lat, p.lon), { signal: ctrl ? ctrl.signal : undefined, credentials: "omit",
        referrerPolicy: "strict-origin-when-cross-origin", headers: { Accept: "application/json" } });
      if (!resp.ok) return null;
      return E.deNominatim(await resp.json(), opcoes);
    } finally { clearTimeout(t); }
  }

  async function perto(pos) {
    const p = pos && { lat: Number(pos.lat), lon: Number(pos.lon != null ? pos.lon : pos.lng) };
    if (!p || !isFinite(p.lat) || !isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return null;
    const opcoes = { rumo: pos.rumo };
    const mapa = doMapa(p, opcoes);
    const agora = Date.now();
    // a posição DO MOTORISTA (SOS: pos.propria) só vai ao Nominatim com a localização permitida; o ponto que ele toca no mapa
    // vai sempre (o consentimento diz isso fora do item de localização). Sem permissão: só o endereço do mapa guardado.
    const podeRede = online() && !(pos.propria === true && C.privacidade && C.privacidade.localizacaoPermitida && !C.privacidade.localizacaoPermitida());
    const d = E.decidir({ cache, online: podeRede, ultimoPedidoEm }, p, agora);
    if (d.acao === "cache") return E.combinar(mapa, d.entrada.valor, opcoes);
    if (d.acao === "mapa") {
      // pedido em andamento para perto daqui: espera ele em vez de mandar outro
      if (emVoo && E.doCache([{ lat: emVoo.lat, lon: emVoo.lon, em: agora, valor: null }], p, agora)) {
        const v = await emVoo.promessa;
        return E.combinar(mapa, v, opcoes);
      }
      return mapa;
    }
    ultimoPedidoEm = agora;
    const voo = { lat: p.lat, lon: p.lon, promessa: daInternet(p, opcoes).catch(() => null) };
    emVoo = voo;
    const v = await voo.promessa;
    if (emVoo === voo) emVoo = null;
    if (v) cache = E.guardar(cache, p, Date.now(), v);
    return E.combinar(mapa, v, opcoes);
  }

  C.endereco = { perto };
})(window.Copiloto);
