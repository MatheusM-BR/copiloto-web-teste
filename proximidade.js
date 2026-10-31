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
// Filtro opcional (opcoes.filtro(pos, relato) → bool): decide, ao entrar no raio, se o relato vale para este motorista
// (ALT-03: sentido compatível). Depois de aberto, o alerta segue até passar, mesmo que o rumo oscile numa curva.
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
    const filtro = typeof o.filtro === "function" ? o.filtro : null;
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
        if (d <= raio && frente && (!filtro || filtro(pos, r))) { e.fase = "ativo"; e.min = d; e.dispensado = false; e.mostrado = false; }
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


  // ------------------------------------------------------------ ALT-03: sentido
  const SENTIDO_GRAUS = 90;
  // O relato (com rumo de quem relatou) vale para quem vai no rumo do motorista? Sem rumo de um dos lados: vale (como antes).
  function sentidoCompativel(rumoRelato, rumoMotorista, limite) {
    const a = rumoRelato == null ? NaN : Number(rumoRelato), b = rumoMotorista == null ? NaN : Number(rumoMotorista);
    if (!isFinite(a) || !isFinite(b)) return true;
    return difAngular(a, b) <= (limite == null ? SENTIDO_GRAUS : limite);
  }

  // ------------------------------------------------------------ ALT-03: altura e peso × veículo ativo
  const num = (n) => String(Math.round(Number(n) * 100) / 100).replace(".", ",");
  // tipo: tipo do app; valor: valor do relato; veiculo: perfil ativo ({ altura (m), pbtc (t) } ou null).
  // Devolve null (tipo sem medida) ou { estado: "excede" | "sem_dado" | "cabe", texto, fala }.
  function cruzarVeiculo(tipo, valor, veiculo) {
    let cfg = null;
    if (tipo === "altura_maxima") cfg = { campo: "altura", un: "m", nome: "Altura máxima", falta: "Altura do veículo não informada", seu: "", falaUn: "metros" };
    else if (tipo === "limite_peso") cfg = { campo: "pbtc", un: "t", nome: "Limite de peso", falta: "PBTC do veículo não informado", seu: "PBTC de ", falaUn: "toneladas" };
    if (!cfg || valor == null || !isFinite(valor)) return null;
    const v = veiculo ? veiculo[cfg.campo] : null;
    if (v == null || v === "" || !isFinite(v)) {
      return { estado: "sem_dado", texto: cfg.falta + ". Confira se o seu veículo passa.", fala: null };
    }
    if (Number(v) > Number(valor)) {
      return {
        estado: "excede",
        texto: cfg.nome + " " + num(valor) + " " + cfg.un + " — seu veículo tem " + cfg.seu + num(v) + " " + cfg.un,
        fala: "Atenção: " + cfg.nome.toLowerCase() + " " + num(valor) + " " + cfg.falaUn + ". Seu veículo tem " + num(v) + ".",
      };
    }
    return { estado: "cabe", texto: null, fala: null };
  }

  // ------------------------------------------------------------ ALT-02: bipe progressivo (sensor de estacionamento)
  const RAIO_BIPE_M = 200;
  const BIPE_LENTO_MS = 1000, BIPE_RAPIDO_MS = 150;
  // Intervalo entre bipes: null fora dos últimos 200 m; 1 s a 200 m, cada vez mais rápido até 0,15 s no ponto.
  function intervaloBipeMs(distM) {
    const d = Number(distM);
    if (!isFinite(d) || d < 0 || d > RAIO_BIPE_M) return null;
    return Math.round(BIPE_RAPIDO_MS + (BIPE_LENTO_MS - BIPE_RAPIDO_MS) * (d / RAIO_BIPE_M));
  }
  // Deve bipar agora? riscoAlto: tipo de risco alto (ou altura/peso que o veículo excede); fase: fase do alertador;
  // somLigado: voz/som do motorista; dispensado: votou ou fechou. Devolve o intervalo (ms) ou null.
  function bipeAgora(o) {
    if (!o || !o.riscoAlto || !o.somLigado || o.dispensado) return null;
    if (o.fase !== "ativo") return null; // passou do ponto: silêncio
    return intervaloBipeMs(o.distanciaM);
  }

  // ------------------------------------------------------------ PRI-05: trecho da rota para ditar ao atendente
  // rota: { coords: [[lon, lat]…], resposta: JSON do Valhalla }; pos: { lat, lon }. Devolve o nome da via mais próxima ou null.
  function trechoDaRota(rota, pos) {
    try {
      if (!rota || !Array.isArray(rota.coords) || !rota.coords.length || !pos) return null;
      let melhor = -1, dMin = Infinity;
      rota.coords.forEach((c, i) => { const d = distanciaM(pos, { lat: c[1], lon: c[0] }); if (d < dMin) { dMin = d; melhor = i; } });
      if (dMin > 2000) return null; // longe da rota: não afirma trecho
      const legs = (rota.resposta && rota.resposta.trip && rota.resposta.trip.legs) || [];
      let base = 0;
      for (const leg of legs) {
        const mans = leg.maneuvers || [];
        const fim = mans.length ? Math.max(...mans.map((m) => Number(m.end_shape_index) || 0)) : 0;
        for (const m of mans) {
          if (melhor >= base + Number(m.begin_shape_index) && melhor <= base + Number(m.end_shape_index)) {
            const nomes = m.street_names || m.begin_street_names;
            if (Array.isArray(nomes) && nomes.length) return nomes.join(" / ");
          }
        }
        base += fim + 1;
      }
      return null;
    } catch (e) { return null; }
  }

  const api = { criarAlertador, rumoGraus, difAngular, distanciaM, rumoDoGps, aFrente,
    sentidoCompativel, cruzarVeiculo, intervaloBipeMs, bipeAgora, trechoDaRota,
    RAIO_ALERTA_M, DEPOIS_M, REARME_M, CONE_GRAUS, SENTIDO_GRAUS, RAIO_BIPE_M };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoProximidade = api;
})(typeof window !== "undefined" ? window : globalThis);
