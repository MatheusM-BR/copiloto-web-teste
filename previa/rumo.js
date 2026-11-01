// Rumo exibido no mapa (seta da posição e "rumo para cima"). Lógica pura: sem DOM, testável no Node.
//
// Entradas do iPhone real (Safari/WebKit): heading e speed vêm null (ou NaN) muitas vezes, mesmo andando, e speed −1 /
// heading −1 quando o aparelho não sabe; dentro da cabine a precisão fica em 30–65 m. Tudo que não é número finito
// (null, NaN, "", −1) conta como "não sei"; texto numérico ("12.5") vale como número. speed em m/s, heading em graus.
//
// Fonte do rumo, nesta ordem, a cada leitura do GPS:
//   1. rumo do GPS (heading ≥ 0), se a velocidade passa de VEL_MIN_MS (~1 m/s) — a do aparelho ou, sem ela, a estimada
//      pelas leituras (≥ VEL_RAPIDO_MS);
//   2. rumo entre leituras, por uma TRILHA das leituras dos últimos JANELA_MS (a parte mais recente que já andou o
//      bastante), só com velocidade ≥ VEL_MIN_MS (a do aparelho ou a das leituras dos últimos segundos):
//        rápido: ≥ 3 leituras, reta (deslocamento/caminho ≥ RETIDAO_MIN), sem salto (nenhum trecho > TRECHO_MAX do
//                deslocamento), velocidade ≥ VEL_RAPIDO_MS e deslocamento
//                ≥ max(DESLOC_MIN_M, min(DESLOC_RAPIDO_MAX_M, FATOR_RAPIDO × precisão)) — 65 m de precisão → 32,5 m;
//                direção pela reta (mínimos quadrados) das leituras da trilha;
//        lento:  2+ leituras com deslocamento ≥ max(DESLOC_MIN_M, FATOR_PRECISAO × precisão) (a regra antiga).
//      A trilha desliza: andando, cada leitura nova dá um rumo novo (antes: só a cada ~100 m com precisão de 65 m).
//   3. parado: mantém o último rumo confiável, com a seta APAGADA (confiavel = false);
//   4. sem rumo nenhum: null (a marca vira bolinha). Bússola (opcional, ui/gps.js): só parado/devagar (< VEL_RAPIDO_MS)
//      e sem rumo de movimento antes, com precisão < BUSSOLA_PRECISAO_MAX; corrigida pela diferença bússola × GPS.
// O exibido é suavizado (média circular pelo caminho mais curto; mudança < IGNORA_GRAUS é ignorada): fator SUAVIZACAO
// no rumo do GPS (já filtrado pelo aparelho) e SUAVIZACAO_LEITURAS no rumo entre leituras.
(function (raiz) {
  "use strict";

  const VEL_MIN_MS = 1.0;
  const VEL_RAPIDO_MS = 2.0;          // "andando de verdade" para a regra rápida (e limite do "devagar" da bússola)
  const DESLOC_MIN_M = 15;
  const FATOR_PRECISAO = 1.5;         // regra lenta (2 leituras)
  const FATOR_RAPIDO = 0.5;           // regra rápida (3+ leituras em reta)
  const DESLOC_RAPIDO_MAX_M = 40;
  const RETIDAO_MIN = 0.8;
  const TRECHO_MAX = 0.7;             // regra rápida: nenhum trecho entre leituras passa de 70% do deslocamento
  const JANELA_MS = 20000;            // trilha: leituras dos últimos 20 s
  const TRILHA_MAX = 20;
  const SALTO_M = 2000;               // salto (túnel, 1ª leitura boa): a trilha recomeça
  const SUAVIZACAO = 0.3;
  const SUAVIZACAO_LEITURAS = 0.6;
  const IGNORA_GRAUS = 3;
  const BUSSOLA_PRECISAO_MAX = 25;
  const BUSSOLA_VALIDADE_MS = 3000;   // leitura da bússola mais velha que isso não vale
  const MOVENDO_SEM_VEL_MS = 10000;   // sem velocidade do aparelho: "andando" até 10 s depois do último rumo entre leituras

  const num = (v) => typeof v === "number" && isFinite(v);
  // número do GPS: null/NaN/""/texto não numérico → null; "12.5" → 12.5
  function numero(v) {
    if (num(v)) return v;
    if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return isFinite(n) ? n : null; }
    return null;
  }
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
  // Direção da reta que melhor passa pelos pontos (eixo principal, mínimos quadrados), no sentido do primeiro ao último.
  function rumoDaReta(pts) {
    if (pts.length < 3) return rumoEntre(pts[0], pts[pts.length - 1]);
    const rad = Math.PI / 180, o = pts[0], k = Math.cos(o.lat * rad) * 111195;
    const xy = pts.map((p) => [(p.lon - o.lon) * k, (p.lat - o.lat) * 111195]); // leste, norte (m)
    let mx = 0, my = 0; for (const [x, y] of xy) { mx += x; my += y; } mx /= xy.length; my /= xy.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of xy) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // eixo principal, a partir do leste
    let ex = Math.cos(ang), ny = Math.sin(ang);
    const u = xy[xy.length - 1], p0 = xy[0];
    if (ex * (u[0] - p0[0]) + ny * (u[1] - p0[1]) < 0) { ex = -ex; ny = -ny; }
    return norm(Math.atan2(ex, ny) / rad);
  }
  // um passo da suavização: de "atual" em direção a "alvo"
  function suavizar(atual, alvo, fator, minimo) {
    if (!num(alvo)) return num(atual) ? atual : null;
    if (!num(atual)) return norm(alvo);
    const d = difCircular(atual, alvo);
    if (Math.abs(d) < (minimo == null ? IGNORA_GRAUS : minimo)) return atual;
    return norm(atual + (fator == null ? SUAVIZACAO : fator) * d);
  }

  // Velocidade pelas leituras: do ponto de 2 a 10 s atrás até o último (sem ele, do mais velho da trilha). null sem dado.
  function velocidadeDasLeituras(trilha) {
    const u = trilha[trilha.length - 1];
    let ref = null;
    for (let i = trilha.length - 2; i >= 0; i--) {
      const dt = u.t - trilha[i].t;
      if (dt >= 2000) { if (dt <= 10000) ref = trilha[i]; break; }
    }
    if (!ref && trilha.length >= 2 && u.t - trilha[0].t > 0 && u.t - trilha[0].t < 2000) ref = trilha[0];
    if (!ref || u.t - ref.t <= 0) return null;
    return distanciaM(ref, u) / ((u.t - ref.t) / 1000);
  }

  // Parado pelas leituras (sem velocidade do aparelho): todas as leituras dos últimos PARADO_JANELA_MS (cobrindo pelo menos
  // PARADO_COBERTURA_MS, com 4+ leituras) a menos de DESLOC_MIN_M da última. Sem isso, o ruído do GPS parado (±5 m a cada
  // segundo) virava "velocidade" de 3–6 m/s pela leitura de 2 s atrás e a trilha esticava até o trecho andado antes de
  // parar: a seta ficava acesa e o rumo "das leituras" seguia valendo com o caminhão parado (campo, iPhone na cabine).
  const PARADO_JANELA_MS = 5000, PARADO_COBERTURA_MS = 3500;
  function paradoPelasLeituras(trilha) {
    const u = trilha[trilha.length - 1];
    const rec = trilha.filter((p) => u.t - p.t <= PARADO_JANELA_MS);
    if (rec.length < 4 || u.t - rec[0].t < PARADO_COBERTURA_MS) return false;
    return rec.every((p) => distanciaM(p, u) < DESLOC_MIN_M);
  }

  // Rumo pela trilha (regras rápida e lenta do cabeçalho). Devolve { graus, regra } ou null.
  function rumoDaTrilha(trilha, velAparelho) {
    const n = trilha.length;
    if (n < 2) return null;
    const u = trilha[n - 1];
    const vLeit = velocidadeDasLeituras(trilha);
    const vel = velAparelho != null ? velAparelho : vLeit;
    if (vel == null || vel < VEL_MIN_MS) return null;
    // a parte mais recente da trilha que já andou o mínimo (cresce para trás até DESLOC_MIN_M)
    let ini = -1;
    for (let i = n - 2; i >= 0; i--) if (distanciaM(trilha[i], u) >= DESLOC_MIN_M) { ini = i; break; }
    if (ini < 0) return null;
    const precisaoDe = (a, b) => { let s = 0, c = 0; for (let i = a; i <= b; i++) if (trilha[i].precisao > 0) { s += trilha[i].precisao; c++; } return c ? s / c : 0; };
    // rápido: cresce a parte até o limiar rápido, com 3+ leituras em reta
    if (vel >= VEL_RAPIDO_MS) {
      for (let i = ini; i >= 0; i--) {
        const pts = trilha.slice(i), d = distanciaM(trilha[i], u);
        const limiar = Math.max(DESLOC_MIN_M, Math.min(DESLOC_RAPIDO_MAX_M, FATOR_RAPIDO * precisaoDe(i, n - 1)));
        if (d < limiar) continue;
        if (pts.length < 3) continue;
        let caminho = 0, maior = 0;
        for (let j = 1; j < pts.length; j++) { const s = distanciaM(pts[j - 1], pts[j]); caminho += s; maior = Math.max(maior, s); }
        // reta e andada aos poucos: um salto só (troca de antena/Wi-Fi com o caminhão parado) não vira rumo
        if (caminho > 0 && d / caminho >= RETIDAO_MIN && maior <= TRECHO_MAX * d) return { graus: rumoDaReta(pts), regra: "rapida" };
        break; // a parte mais curta que alcança o limiar não é reta: não vale esticar (misturaria a curva)
      }
    }
    // lento: duas pontas com deslocamento ≥ max(15 m, 1,5 × precisão)
    for (let i = ini; i >= 0; i--) {
      const d = distanciaM(trilha[i], u);
      if (d >= Math.max(DESLOC_MIN_M, FATOR_PRECISAO * precisaoDe(i, n - 1))) return { graus: rumoEntre(trilha[i], u), regra: "lenta" };
    }
    return null;
  }

  function criarRumo() {
    let exibido = null;       // graus suavizados (o que a seta e o mapa mostram)
    let confiavel = false;    // seta acesa
    let fonte = null;         // "gps" | "leituras" | "bussola" | null
    let teveRumoMovendo = false; // já houve rumo do GPS ou entre leituras (a bússola não entra mais)
    let trilha = [];          // [{ lat, lon, t, precisao }] leituras recentes (rumo entre leituras)
    let tRumoLeituras = -Infinity;
    let bus = null;           // { graus, precisao, t }
    let correcao = null;      // GPS − bússola (graus), medida em movimento
    let movendo = false;
    let velEstimada = null;   // m/s (do aparelho ou das leituras)

    function bussola(b) {
      const g = b ? numero(b.graus) : null;
      if (g == null) return;
      const p = numero(b.precisao), t = numero(b.t);
      bus = { graus: norm(g), precisao: p, t: t != null ? t : Date.now() };
    }
    function bussolaValida(t) {
      return !!bus && bus.precisao != null && bus.precisao >= 0 && bus.precisao < BUSSOLA_PRECISAO_MAX && Math.abs(t - bus.t) <= BUSSOLA_VALIDADE_MS;
    }

    function atualizar(l) {
      const lat = l ? numero(l.lat) : null, lon = l ? numero(l.lon) : null;
      if (lat == null || lon == null) return estado();
      const tl = numero(l.t), t = tl != null ? tl : Date.now();
      const v0 = numero(l.velMs), vel = v0 != null && v0 >= 0 ? v0 : null;       // −1 do iOS = não sei
      const h0 = numero(l.heading), heading = h0 != null && h0 >= 0 ? h0 : null; // −1 do iOS = não sei
      const p0 = numero(l.precisao), precisao = p0 != null && p0 > 0 ? p0 : 0;
      const pos = { lat, lon, t, precisao };
      let alvo = null, novaFonte = null;

      // trilha: tira o velho, recomeça no salto ou com o relógio voltando
      const ult = trilha[trilha.length - 1];
      if (ult && (t < ult.t || distanciaM(ult, pos) > SALTO_M)) trilha = [];
      trilha.push(pos);
      while (trilha.length > TRILHA_MAX || (trilha.length > 1 && t - trilha[0].t > JANELA_MS)) trilha.shift();
      const paradoLeit = vel == null && paradoPelasLeituras(trilha);
      const vLeit = paradoLeit ? 0 : velocidadeDasLeituras(trilha);
      velEstimada = vel != null ? vel : vLeit;

      if ((vel != null && vel <= VEL_MIN_MS) || paradoLeit) {
        trilha = [pos]; // parado (pelo aparelho ou pelas leituras): deriva do GPS não vira rumo
        tRumoLeituras = -Infinity;
      } else if (heading != null && ((vel != null && vel > VEL_MIN_MS) || (vel == null && vLeit != null && vLeit >= VEL_RAPIDO_MS))) {
        alvo = norm(heading); novaFonte = "gps";
        if (bussolaValida(t)) { // calibra: quanto a bússola erra dentro da cabine (metal, ímã do suporte)
          const d = difCircular(bus.graus, alvo);
          correcao = correcao == null ? d : norm(correcao + 0.2 * difCircular(correcao, d) + 180) - 180;
        }
      } else {
        const r = rumoDaTrilha(trilha, vel);
        if (r) { alvo = r.graus; novaFonte = "leituras"; tRumoLeituras = t; }
      }

      movendo = vel != null ? vel > VEL_MIN_MS : (novaFonte != null || t - tRumoLeituras <= MOVENDO_SEM_VEL_MS);
      const devagar = !movendo || (velEstimada != null && velEstimada < VEL_RAPIDO_MS);

      if (novaFonte) {
        const fator = novaFonte === "leituras" ? SUAVIZACAO_LEITURAS : SUAVIZACAO;
        exibido = fonte === "bussola" ? norm(alvo) : suavizar(exibido, alvo, fator);
        fonte = novaFonte; confiavel = true; teveRumoMovendo = true;
      } else if (devagar && !teveRumoMovendo && bussolaValida(t)) {
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
      return { graus: exibido == null ? null : Math.round(exibido * 10) / 10, confiavel: exibido != null && confiavel, fonte, movendo,
        velMs: velEstimada == null ? null : Math.round(velEstimada * 10) / 10, correcaoBussola: correcao };
    }
    function reiniciar() { exibido = null; confiavel = false; fonte = null; teveRumoMovendo = false; trilha = []; tRumoLeituras = -Infinity; movendo = false; velEstimada = null; }

    return { atualizar, bussola, estado, reiniciar };
  }

  const api = { criarRumo, suavizar, difCircular, rumoEntre, rumoDaReta, distanciaM, numero,
    VEL_MIN_MS, VEL_RAPIDO_MS, DESLOC_MIN_M, FATOR_PRECISAO, FATOR_RAPIDO, SUAVIZACAO, SUAVIZACAO_LEITURAS, IGNORA_GRAUS, BUSSOLA_PRECISAO_MAX };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoRumo = api;
})(typeof window !== "undefined" ? window : globalThis);
