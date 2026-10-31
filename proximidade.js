// Pergunta "Ainda está aí?" na estrada: escolhe no máximo um relato para perguntar.
// Regras:
//  - a até 300 m do motorista;
//  - não é meu e eu ainda não votei nele;
//  - ainda não foi perguntado nesta sessão;
//  - se o rumo do motorista é conhecido, o relato está À FRENTE (diferença ≤ 60° entre o rumo e a direção até ele);
//  - no máximo uma pergunta a cada 30 s.
// Lógica pura: sem DOM, testável no Node.
(function (raiz) {
  "use strict";

  const RAIO_M = 300;
  const INTERVALO_MS = 30000;
  const CONE_GRAUS = 60;
  const PARADO_MS = 1.0; // abaixo disso (m/s) o rumo do GPS não vale

  function distanciaM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Rumo inicial de a até b, em graus (0 = norte, 90 = leste), 0 a 360.
  function rumoGraus(a, b) {
    const rad = Math.PI / 180;
    const f1 = a.lat * rad, f2 = b.lat * rad, dl = (b.lon - a.lon) * rad;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  // Menor diferença entre dois rumos, 0 a 180.
  function difAngular(a, b) {
    const d = Math.abs(((a - b) % 360 + 360) % 360);
    return d > 180 ? 360 - d : d;
  }

  // Rumo do GPS que pode ser usado: null se o aparelho não informou (null/NaN/negativo) ou se está parado.
  // Devolve inteiro de 0 a 359 (como o contrato pede em p_heading_deg).
  function rumoDoGps(heading, velocidadeMs) {
    if (typeof heading !== "number" || !isFinite(heading) || heading < 0) return null;
    if (typeof velocidadeMs === "number" && isFinite(velocidadeMs) && velocidadeMs < PARADO_MS) return null;
    return Math.round(heading) % 360;
  }

  function aFrente(pos, rel, cone) {
    if (pos.rumo == null || !isFinite(pos.rumo)) return true; // rumo desconhecido: não filtra
    return difAngular(pos.rumo, rumoGraus(pos, rel)) <= (cone == null ? CONE_GRAUS : cone);
  }

  // relatos: [{ id, lat, lon, mine, my_vote }]; pos: { lat, lon, rumo (graus ou null) }
  function criarPerguntador(opcoes) {
    const o = opcoes || {};
    const raio = o.raioM || RAIO_M, intervalo = o.intervaloMs == null ? INTERVALO_MS : o.intervaloMs, cone = o.coneGraus || CONE_GRAUS;
    const perguntados = new Set();
    let ultimaMs = -Infinity;

    function candidatos(pos, relatos) {
      const lista = [];
      for (const r of relatos || []) {
        if (!r || r.id == null || r.mine === true || r.my_vote) continue;
        if (perguntados.has(r.id)) continue;
        if (!isFinite(r.lat) || !isFinite(r.lon)) continue;
        const d = distanciaM(pos, r);
        if (d > raio) continue;
        if (!aFrente(pos, r, cone)) continue;
        lista.push({ relato: r, distanciaM: d });
      }
      lista.sort((a, b) => a.distanciaM - b.distanciaM);
      return lista;
    }

    // Devolve { relato, distanciaM } ou null. Quando devolve, conta como perguntado.
    function escolher(pos, relatos, agoraMs) {
      if (!pos || !isFinite(pos.lat) || !isFinite(pos.lon)) return null;
      if (agoraMs - ultimaMs < intervalo) return null;
      const c = candidatos(pos, relatos)[0];
      if (!c) return null;
      perguntados.add(c.relato.id);
      ultimaMs = agoraMs;
      return c;
    }

    return { escolher, candidatos, jaPerguntado: (id) => perguntados.has(id), marcar: (id) => perguntados.add(id) };
  }

  const api = { criarPerguntador, rumoGraus, difAngular, distanciaM, rumoDoGps, aFrente, RAIO_M, INTERVALO_MS, CONE_GRAUS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoProximidade = api;
})(typeof window !== "undefined" ? window : globalThis);
