// Rumo exibido no mapa (seta da posição e "rumo para cima"). Lógica pura: sem DOM, testável no Node.
//
// Fonte do rumo, nesta ordem, a cada leitura do GPS:
//   1. rumo do GPS (heading), se a velocidade passa de VEL_MIN_MS (~1 m/s);
//   2. rumo entre leituras: deslocamento desde a âncora ≥ max(DESLOC_MIN_M, FATOR_PRECISAO × precisão)
//      (o Safari manda heading NaN muitas vezes, mesmo andando);
//   3. parado: mantém o último rumo confiável, com a seta APAGADA (confiavel = false);
//   4. sem rumo nenhum: null (a marca vira bolinha). Bússola (opcional, ui/gps.js): só parado e sem rumo anterior,
//      com precisão < BUSSOLA_PRECISAO_MAX; corrigida pela diferença bússola × GPS medida em movimento.
// O exibido é suavizado (média circular, fator SUAVIZACAO pelo caminho mais curto; mudança < IGNORA_GRAUS é ignorada).
(function (raiz) {
  "use strict";

  const VEL_MIN_MS = 1.0;
  const DESLOC_MIN_M = 15;
  const FATOR_PRECISAO = 1.5;
  const SUAVIZACAO = 0.3;
  const IGNORA_GRAUS = 3;
  const BUSSOLA_PRECISAO_MAX = 25;
  const BUSSOLA_VALIDADE_MS = 3000;   // leitura da bússola mais velha que isso não vale
  const MOVENDO_SEM_VEL_MS = 10000;   // sem velocidade do aparelho: "andando" até 10 s depois do último rumo entre leituras
  const ANCORA_MAX_MS = 30000;        // deriva lenta do GPS parado: a âncora anda depois de 30 s sem deslocamento

  const num = (v) => typeof v === "number" && isFinite(v);
  const norm = (g) => ((g % 360) + 360) % 360;
  // diferença com sinal de a para b, -180 a 180 (caminho mais curto)
  function difCircular(a, b) { let d = norm(b) - norm(a); if (d > 180) d -= 360; if (d < -180) d += 360; return d; }

  function distanciaM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function rumoEntre(a, b) {
    const rad = Math.PI / 180;
    const f1 = a.lat * rad, f2 = b.lat * rad, dl = (b.lon - a.lon) * rad;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return norm(Math.atan2(y, x) / rad);
  }
  // um passo da suavização: de "atual" em direção a "alvo"
  function suavizar(atual, alvo, fator, minimo) {
    if (!num(alvo)) return num(atual) ? atual : null;
    if (!num(atual)) return norm(alvo);
    const d = difCircular(atual, alvo);
    if (Math.abs(d) < (minimo == null ? IGNORA_GRAUS : minimo)) return atual;
    return norm(atual + (fator == null ? SUAVIZACAO : fator) * d);
  }

  function criarRumo() {
    let exibido = null;       // graus suavizados (o que a seta e o mapa mostram)
    let confiavel = false;    // seta acesa
    let fonte = null;         // "gps" | "leituras" | "bussola" | null
    let teveRumoMovendo = false; // já houve rumo do GPS ou entre leituras (a bússola não entra mais)
    let ancora = null;        // { lat, lon, t } ponto de referência do rumo entre leituras
    let tRumoLeituras = -Infinity;
    let bus = null;           // { graus, precisao, t }
    let correcao = null;      // GPS − bússola (graus), medida em movimento
    let movendo = false;

    function bussola(b) {
      if (!b || !num(b.graus)) return;
      bus = { graus: norm(b.graus), precisao: num(b.precisao) ? b.precisao : null, t: num(b.t) ? b.t : Date.now() };
    }
    function bussolaValida(t) {
      return !!bus && bus.precisao != null && bus.precisao >= 0 && bus.precisao < BUSSOLA_PRECISAO_MAX && Math.abs(t - bus.t) <= BUSSOLA_VALIDADE_MS;
    }

    function atualizar(l) {
      if (!l || !num(l.lat) || !num(l.lon)) return estado();
      const t = num(l.t) ? l.t : Date.now();
      const vel = num(l.velMs) && l.velMs >= 0 ? l.velMs : null;
      const precisao = num(l.precisao) && l.precisao > 0 ? l.precisao : 0;
      const pos = { lat: l.lat, lon: l.lon, t };
      let alvo = null, novaFonte = null;

      if (vel != null && vel > VEL_MIN_MS && num(l.heading) && l.heading >= 0) {
        alvo = norm(l.heading); novaFonte = "gps"; ancora = pos;
        if (bussolaValida(t)) { // calibra: quanto a bússola erra dentro da cabine (metal, ímã do suporte)
          const d = difCircular(bus.graus, alvo);
          correcao = correcao == null ? d : norm(correcao + 0.2 * difCircular(correcao, d) + 180) - 180;
        }
      } else if (vel != null && vel <= VEL_MIN_MS) {
        ancora = pos; // parado pelo aparelho: deriva do GPS não vira rumo
      } else if (!ancora) {
        ancora = pos;
      } else {
        const d = distanciaM(ancora, pos);
        if (d >= Math.max(DESLOC_MIN_M, FATOR_PRECISAO * precisao)) {
          alvo = rumoEntre(ancora, pos); novaFonte = "leituras"; ancora = pos; tRumoLeituras = t;
        } else if (t - ancora.t > ANCORA_MAX_MS) ancora = pos;
      }

      movendo = vel != null ? vel > VEL_MIN_MS : (novaFonte != null || t - tRumoLeituras <= MOVENDO_SEM_VEL_MS);

      if (novaFonte) {
        exibido = fonte === "bussola" ? norm(alvo) : suavizar(exibido, alvo);
        fonte = novaFonte; confiavel = true; teveRumoMovendo = true;
      } else if (!movendo && !teveRumoMovendo && bussolaValida(t)) {
        exibido = suavizar(exibido, bus.graus + (correcao || 0));
        fonte = "bussola"; confiavel = true;
      } else if (!movendo) {
        confiavel = false; // parado: mantém o último rumo, seta apagada
        if (fonte === "bussola" && !bussolaValida(t)) { exibido = null; fonte = null; }
      }
      // andando sem rumo novo nesta leitura (ainda não deslocou o bastante): mantém o último, aceso
      return estado();
    }

    function estado() {
      return { graus: exibido == null ? null : Math.round(exibido * 10) / 10, confiavel: exibido != null && confiavel, fonte, movendo, correcaoBussola: correcao };
    }
    function reiniciar() { exibido = null; confiavel = false; fonte = null; teveRumoMovendo = false; ancora = null; tRumoLeituras = -Infinity; movendo = false; }

    return { atualizar, bussola, estado, reiniciar };
  }

  const api = { criarRumo, suavizar, difCircular, rumoEntre, distanciaM,
    VEL_MIN_MS, DESLOC_MIN_M, FATOR_PRECISAO, SUAVIZACAO, IGNORA_GRAUS, BUSSOLA_PRECISAO_MAX };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoRumo = api;
})(typeof window !== "undefined" ? window : globalThis);
