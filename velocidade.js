// Filtro de velocidade para GPS de celular.
// Problema: parado, o GPS oscila e reporta 2 a 3 km/h que não existem.
// Regras:
//  - sinal fraco (precisão pior que 50 m): não mostra número, devolve null ("--");
//  - velocidade do aparelho (m/s) tem prioridade; sem ela, estima pela distância entre duas posições,
//    contando só o deslocamento que supera a incerteza das duas leituras;
//  - zona morta com histerese: sai do "parado" acima de 1,4 m/s (~5 km/h) e volta abaixo de 1,0 m/s (~3,6 km/h).
(function (raiz) {
  "use strict";

  const PRECISAO_MAX_M = 50;
  const SAIR_PARADO_MS = 1.4;
  const ENTRAR_PARADO_MS = 1.0;
  const DT_MIN_S = 1;
  const DT_MAX_S = 15;

  function distanciaM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function criarFiltro() {
    let parado = true;
    let ultima = null;

    // pos: { lat, lon, precisao (m), velocidade (m/s ou null), t (ms) }
    // retorna km/h inteiro, ou null quando não dá para saber
    function atualizar(pos) {
      const anterior = ultima;
      if (!(pos.precisao <= PRECISAO_MAX_M)) { return null; } // sinal fraco (ou precisão ausente)
      ultima = pos;

      let v = null;
      if (typeof pos.velocidade === "number" && isFinite(pos.velocidade) && pos.velocidade >= 0) {
        v = pos.velocidade;
      } else if (anterior) {
        const dt = (pos.t - anterior.t) / 1000;
        if (dt >= DT_MIN_S && dt <= DT_MAX_S) {
          const d = distanciaM(anterior, pos);
          const incerteza = pos.precisao + anterior.precisao;
          v = d > incerteza ? d / dt : 0;
        }
      }
      if (v === null) return null;

      if (parado) {
        if (v < SAIR_PARADO_MS) return 0;
        parado = false;
      } else if (v < ENTRAR_PARADO_MS) {
        parado = true;
        return 0;
      }
      return Math.round(v * 3.6);
    }

    return { atualizar };
  }

  const api = { criarFiltro, distanciaM, PRECISAO_MAX_M, SAIR_PARADO_MS, ENTRAR_PARADO_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoVelocidade = api;
})(typeof window !== "undefined" ? window : globalThis);
