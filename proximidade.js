// Alerta de relato à frente (estilo Waze). Lógica pura: sem DOM, testável no Node.
//
// Estado por relato, a cada leitura do GPS:
//   longe ──(≤ 500 m e à frente)──▶ ativo ──(passou pelo ponto)──▶ passando ──(≥ 300 m depois)──▶ passou
//   passou ──(> 1000 m de distância)──▶ longe   (rearma para a próxima passagem)
//
// "À frente":
//   - com rumo do GPS: diferença entre o rumo e a direção até o relato ≤ 60°;
//   - sem rumo: a distância está diminuindo entre leituras (aproximação).
// "Passou pelo ponto":
//   - com rumo: o relato ficou atrás (diferença > 90°);
//   - sem rumo: a distância voltou a crescer (mais de 15 m acima da menor distância vista).
// Um alerta por relato por passagem. Vários ao mesmo tempo: mostra um (o mais próximo quando abre)
// e os outros esperam na fila, por distância. Relato que já ficou para trás sai da fila sem aparecer.
(function (raiz) {
  "use strict";

  const RAIO_ALERTA_M = 500;
  const DEPOIS_M = 300;
  const REARME_M = 1000;
  const CONE_GRAUS = 60;
  const ATRAS_GRAUS = 90;
  const FOLGA_M = 15;      // ruído do GPS ao decidir "afastando"
  const PARADO_MS = 1.0;   // abaixo disso (m/s) o rumo do GPS não vale

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

  function temRumo(pos) { return pos.rumo != null && isFinite(pos.rumo); }
  function aFrente(pos, rel, cone) {
    if (!temRumo(pos)) return true; // sem rumo: quem decide é a aproximação
    return difAngular(pos.rumo, rumoGraus(pos, rel)) <= (cone == null ? CONE_GRAUS : cone);
  }

  // relatos: [{ id, lat, lon, ... }]; pos: { lat, lon, rumo (graus ou null) }
  function criarAlertador(opcoes) {
    const o = opcoes || {};
    const raio = o.raioM || RAIO_ALERTA_M, depois = o.depoisM || DEPOIS_M, rearme = o.rearmeM || REARME_M;
    const estados = new Map(); // id → { fase, dist, min, dispensado }
    let atualId = null;

    function estado(id) {
      let e = estados.get(id);
      if (!e) { e = { fase: "longe", dist: null, min: Infinity, dispensado: false, mostrado: false }; estados.set(id, e); }
      return e;
    }

    function avancar(e, pos, r, d) {
      const anterior = e.dist;
      e.dist = d;
      if (e.fase === "longe") {
        const aproximando = anterior != null && d < anterior - 0.5;
        const frente = temRumo(pos) ? aFrente(pos, r) : aproximando;
        if (d <= raio && frente) { e.fase = "ativo"; e.min = d; e.dispensado = false; e.mostrado = false; }
        return;
      }
      if (e.fase === "ativo" || e.fase === "passando") {
        e.min = Math.min(e.min, d);
        if (e.fase === "ativo") {
          const atras = temRumo(pos) ? difAngular(pos.rumo, rumoGraus(pos, r)) > ATRAS_GRAUS : d > e.min + FOLGA_M;
          if (atras) e.fase = "passando";
        }
        if (e.fase === "passando" && d >= depois) e.fase = "passou";
        return;
      }
      if (e.fase === "passou" && d > rearme) { e.fase = "longe"; e.min = Infinity; e.dispensado = false; e.mostrado = false; }
    }

    // Devolve { atual: {relato, distanciaM, fase} | null, abriu: bool, fechou: id | null, fila: [{relato, distanciaM}] }
    function atualizar(pos, relatos) {
      const res = { atual: null, abriu: false, fechou: null, fila: [] };
      if (!pos || !isFinite(pos.lat) || !isFinite(pos.lon)) return res;
      const vistos = new Map();
      for (const r of relatos || []) {
        if (!r || r.id == null || !isFinite(r.lat) || !isFinite(r.lon)) continue;
        const d = distanciaM(pos, r);
        avancar(estado(r.id), pos, r, d);
        vistos.set(r.id, { relato: r, distanciaM: d });
      }
      for (const id of [...estados.keys()]) if (!vistos.has(id)) estados.delete(id); // relato saiu da lista

      // o que está aberto continua até passar 300 m do ponto (ou ser dispensado)
      if (atualId != null) {
        const e = estados.get(atualId);
        if (!e || e.dispensado || e.fase === "passou" || e.fase === "longe") { res.fechou = atualId; atualId = null; }
      }
      // candidatos: à frente (ativo), ainda não mostrados nesta passagem
      const fila = [];
      for (const [id, v] of vistos) {
        const e = estados.get(id);
        if (id !== atualId && e.fase === "ativo" && !e.dispensado && !e.mostrado) fila.push(v);
      }
      fila.sort((a, b) => a.distanciaM - b.distanciaM);
      if (atualId == null && fila.length) {
        const prox = fila.shift();
        atualId = prox.relato.id;
        estados.get(atualId).mostrado = true;
        res.abriu = true;
      }
      if (atualId != null) {
        const v = vistos.get(atualId);
        res.atual = { relato: v.relato, distanciaM: v.distanciaM, fase: estados.get(atualId).fase };
      }
      res.fila = fila;
      return res;
    }

    // O motorista votou (ou fechou): some agora, sem voltar nesta passagem.
    function dispensar(id) { const e = estados.get(id); if (e) { e.dispensado = true; e.mostrado = true; } }
    function fase(id) { const e = estados.get(id); return e ? e.fase : "longe"; }
    return { atualizar, dispensar, fase, atual: () => atualId };
  }

  const api = { criarAlertador, rumoGraus, difAngular, distanciaM, rumoDoGps, aFrente,
    RAIO_ALERTA_M, DEPOIS_M, REARME_M, CONE_GRAUS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoProximidade = api;
})(typeof window !== "undefined" ? window : globalThis);
