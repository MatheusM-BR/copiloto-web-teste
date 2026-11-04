// Cache do "em que km estou" em rodovia (r5; lógica pura, testada em tests/kmcache.test.js). O app pedia copiloto_snv_km_at +
// copiloto_km_at (2 RPCs) a cada 30 s ou 500 m. Em rodovia o km muda de forma previsível: depois de 2 respostas reais na mesma
// rodovia (que dão o sentido do km), os pedidos seguintes a menos de ~2 km da última resposta real são respondidos por conta:
// km = km real ± distância andada (reta; um pouco menos que a pista, ok para "km 141"), marcado estimado. Passou de 2 km, de 5 min,
// saiu da rodovia (a resposta real não achou) ou a conta não bate com as 2 respostas anteriores: pede de verdade.
(function (raiz) {
  "use strict";
  const RAIO_M = 2000, VALE_MS = 5 * 60000, DESLOC_MIN_M = 300, RAZAO = [0.6, 1.6];

  function distM(a, b) {
    const R = 6371008.8, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function criar(o) {
    const op = o || {};
    const raio = op.raioM || RAIO_M, vale = op.valeMs || VALE_MS;
    let ult = null, ant = null, sentido = 0;   // sentido: +1 km cresce, -1 decresce, 0 ainda não sei
    function registrar(atual, pos, agora) {
      const t = typeof agora === "number" ? agora : Date.now();
      if (!atual || !atual.rodovia || typeof atual.km !== "number" || !pos || (typeof atual.distancia_m === "number" && atual.distancia_m > 100)) { ult = null; ant = null; sentido = 0; return; }
      if (ult && ult.rodovia !== atual.rodovia) { ant = null; sentido = 0; }
      else if (ult) {
        const d = distM(ult.pos, pos), dk = atual.km - ult.km;
        ant = ult;
        sentido = 0;
        if (d >= DESLOC_MIN_M && Math.abs(dk) >= 0.2) {
          const r = Math.abs(dk) * 1000 / d;
          if (r >= RAZAO[0] && r <= RAZAO[1]) sentido = dk > 0 ? 1 : -1;
        }
      }
      ult = { rodovia: atual.rodovia, km: atual.km, uf: atual.uf || null, pos: { lat: pos.lat, lon: pos.lon }, t, base: atual };
    }
    // devolve o km estimado ({ ...atual, km, estimado: true, oficial: false, deduzido: true }) ou null (pedir de verdade)
    function estimar(pos, agora) {
      const t = typeof agora === "number" ? agora : Date.now();
      if (!ult || !sentido || !pos || t - ult.t > vale) return null;
      const d = distM(ult.pos, pos);
      if (d > raio) return null;
      const km = Math.round((ult.km + sentido * d / 1000) * 10) / 10;
      if (km < 0) return null;
      return Object.assign({}, ult.base, { km, estimado: true, oficial: false, deduzido: true, distancia_m: ult.base.distancia_m });
    }
    return { registrar, estimar, estado: () => ({ ult, ant, sentido }), limpar: () => { ult = ant = null; sentido = 0; } };
  }
  const api = { criar, distM, RAIO_M, VALE_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoKmCache = api;
})(typeof window !== "undefined" ? window : globalThis);
