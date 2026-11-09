// Cronômetro de descanso do motorista (lógica pura, sem DOM). Testado em tests/descanso.test.js.
//
// É uma ORIENTAÇÃO, nunca registro oficial nem controle de jornada legal. Conta só o tempo de direção contínua pelo GPS
// (velocidade acima de ~5 km/h) e lembra de parar. Valores-padrão, todos configuráveis (Lei 13.103/2015; CTB art. 67-C):
//   limite de direção contínua 5h30, aviso 30 min antes, pausa recomendada de 30 min, descanso diário de 11 h a cada 24 h.
// A lei foi alterada e partes dela foram julgadas pelo STF: o app não afirma mais do que isso. Quem manda é o controle oficial.
//
// Regras do motor:
//  - dirMs soma só o tempo andando. Parado menos de `paradaMin` (5 min: semáforo, fila, pedágio) não conta como pausa e não
//    soma na direção: segue de onde estava.
//  - Parada >= `paradaMin` encerra a janela corrente de direção e vale como pausa; pausas SOMAM (15 + 15 min = 30 min).
//    Quando a soma chega a `pausaMin` (30 min), a direção contínua zera (e a soma de pausas também).
//  - Buraco de leituras maior que `lacunaMs` (3 min, túnel/sem sinal/app fechado) não conta nem como direção nem como
//    pausa: não se sabe o que houve. Buraco de 12 h ou mais zera tudo (outro dia).
//  - Parada de `descansoDiarioH` (11 h) ou mais é guardada em `ultimoLongo` (só informativo).
//  - Avisos ("aviso" faltando `avisoAntesMin` e "limite"), uma vez por janela; `eventos()` entrega cada um uma vez.
// O relógio é sempre passado de fora (t em ms): os testes simulam o tempo.
(function (raiz) {
  "use strict";

  const MIN = 60000, HORA = 3600000;
  const CHAVE_CONFIG = "copiloto.descanso.config.v1";
  const CHAVE_ESTADO = "copiloto.descanso.estado.v1";
  const LACUNA_MS = 3 * MIN;       // sem leitura por mais que isso: não conta
  const REINICIO_MS = 12 * HORA;   // sem leitura por tanto tempo: outro dia, zera
  const MOSTRAR_APOS_MIN = 120;    // a tela só mostra o cronômetro depois de 2 h de direção (ou perto do limite)

  const PADRAO = {
    ligado: true,
    som: true,              // aviso falado
    limiteMin: 330,         // direção contínua máxima (5h30)
    avisoAntesMin: 30,
    pausaMin: 30,           // pausa recomendada
    paradaMin: 5,           // parada mínima para valer como pausa
    velMinKmh: 5,           // acima disso está dirigindo
    descansoDiarioH: 11,
  };
  const FAIXAS = {
    limiteMin: [60, 600], avisoAntesMin: [5, 120], pausaMin: [15, 120], paradaMin: [1, 30], velMinKmh: [2, 20], descansoDiarioH: [8, 24],
  };

  function inteiro(v, def, min, max) {
    const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
  }
  function normalizarConfig(c) {
    const o = c && typeof c === "object" ? c : {};
    const r = { ligado: o.ligado === false ? false : true, som: o.som === false ? false : true };
    for (const k of Object.keys(FAIXAS)) r[k] = inteiro(o[k], PADRAO[k], FAIXAS[k][0], FAIXAS[k][1]);
    if (r.avisoAntesMin >= r.limiteMin) r.avisoAntesMin = Math.max(FAIXAS.avisoAntesMin[0], Math.min(PADRAO.avisoAntesMin, r.limiteMin - 1));
    return r;
  }
  function lerConfig(storage) {
    try { const b = storage && storage.getItem(CHAVE_CONFIG); return normalizarConfig(b ? JSON.parse(b) : null); }
    catch (e) { return normalizarConfig(null); }
  }
  function gravarConfig(storage, c) {
    try { storage.setItem(CHAVE_CONFIG, JSON.stringify(normalizarConfig(c))); return true; } catch (e) { return false; }
  }

  // ------------------------------------------------------------ estado guardado (tolerante a lixo)
  const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);
  function estadoVazio() {
    return { dirMs: 0, pausaMs: 0, paradoDesde: null, paradaInicio: null, ultimaT: null, movendo: false,
      avisou: false, limitou: false, ultimoLongo: null };
  }
  function normalizarEstado(e) {
    const v = estadoVazio();
    if (!e || typeof e !== "object") return v;
    v.dirMs = num(e.dirMs) || 0; v.pausaMs = num(e.pausaMs) || 0;
    v.paradoDesde = num(e.paradoDesde); v.paradaInicio = num(e.paradaInicio); v.ultimaT = num(e.ultimaT);
    v.movendo = e.movendo === true; v.avisou = e.avisou === true; v.limitou = e.limitou === true;
    v.ultimoLongo = num(e.ultimoLongo);
    if (!v.movendo && v.ultimaT != null && v.paradoDesde == null) v.paradoDesde = v.ultimaT;
    if (!v.movendo && v.paradaInicio == null) v.paradaInicio = v.paradoDesde;
    return v;
  }
  function lerEstado(storage) {
    try { const b = storage && storage.getItem(CHAVE_ESTADO); return normalizarEstado(b ? JSON.parse(b) : null); }
    catch (e) { return estadoVazio(); }
  }
  function gravarEstado(storage, e) {
    try { storage.setItem(CHAVE_ESTADO, JSON.stringify(normalizarEstado(e))); return true; } catch (e2) { return false; }
  }

  // ------------------------------------------------------------ texto
  function minutosInteiros(ms) { return Math.max(0, Math.floor(ms / MIN)); }
  // "4h20" / "45 min" (tela)
  function fmt(ms) {
    const m = minutosInteiros(ms), h = Math.floor(m / 60), r = m % 60;
    if (h === 0) return r + " min";
    return h + "h" + (r < 10 ? "0" : "") + r;
  }
  // "4 horas e 20 minutos" (voz)
  function fmtFalado(ms) {
    const m = minutosInteiros(ms), h = Math.floor(m / 60), r = m % 60;
    const horas = h + (h === 1 ? " hora" : " horas"), mins = r + (r === 1 ? " minuto" : " minutos");
    if (h === 0) return mins;
    return r === 0 ? horas : horas + " e " + mins;
  }
  function textoAviso(tipo, cfg) {
    const c = normalizarConfig(cfg);
    if (tipo === "aviso") {
      return "Atenção: faltam " + fmtFalado(c.avisoAntesMin * MIN) + " para o limite de direção contínua. Procure um lugar seguro para uma pausa de " +
        fmtFalado(c.pausaMin * MIN) + ".";
    }
    return "Você completou " + fmtFalado(c.limiteMin * MIN) + " de direção. Faça uma pausa de " + fmtFalado(c.pausaMin * MIN) +
      " assim que for seguro. Toque em Postos para ver onde parar.";
  }
  const TEXTO_TRANSPARENCIA = "Orientação baseada na Lei 13.103/2015 (máx. 5h30 de direção contínua; pausa de 30 min a cada 6 h de direção; " +
    "11 h de descanso a cada 24 h). Não substitui o controle oficial da jornada.";

  // ------------------------------------------------------------ motor
  function criar(config, salvo) {
    let cfg = normalizarConfig(config);
    let s = normalizarEstado(salvo);
    let pendentes = [];

    function zerarJanela() { s.dirMs = 0; s.pausaMs = 0; s.avisou = false; s.limitou = false; }

    // soma de pausa já valendo, contando a parada em curso se ela já passou do mínimo
    function pausaFeita() {
      let p = s.pausaMs;
      if (!s.movendo && s.paradoDesde != null && s.ultimaT != null) {
        const parado = s.ultimaT - s.paradoDesde;
        if (parado >= cfg.paradaMin * MIN) p += parado;
      }
      return p;
    }
    function conferirPausa() {
      if (pausaFeita() >= cfg.pausaMin * MIN && (s.dirMs > 0 || s.pausaMs > 0 || s.avisou || s.limitou)) {
        zerarJanela();
        // a parada em curso já foi toda creditada: recomeça a contar do instante da leitura
        if (!s.movendo) s.paradoDesde = s.ultimaT;
      }
    }
    function fecharParada(t) {
      // chegou uma leitura andando depois de uma parada
      if (s.paradoDesde != null) {
        const parado = t - s.paradoDesde;
        if (parado >= cfg.paradaMin * MIN) s.pausaMs += parado;
      }
      if (s.paradaInicio != null && t - s.paradaInicio >= cfg.descansoDiarioH * HORA) s.ultimoLongo = t;
      s.paradoDesde = null; s.paradaInicio = null;
    }
    function checarMarcos() {
      if (!s.avisou && s.dirMs >= (cfg.limiteMin - cfg.avisoAntesMin) * MIN) { s.avisou = true; if (s.dirMs < cfg.limiteMin * MIN) pendentes.push("aviso"); }
      if (!s.limitou && s.dirMs >= cfg.limiteMin * MIN) { s.limitou = true; pendentes.push("limite"); }
    }

    // t em ms; kmh número ou null (leitura sem velocidade: segue o estado anterior)
    function amostra(t, kmh) {
      if (!cfg.ligado || typeof t !== "number" || !isFinite(t)) return;
      const andando = typeof kmh === "number" && isFinite(kmh) ? kmh > cfg.velMinKmh : null;
      if (s.ultimaT == null) {
        s.ultimaT = t; s.movendo = andando === true;
        if (!s.movendo) { s.paradoDesde = t; s.paradaInicio = t; }
        return;
      }
      const dt = t - s.ultimaT;
      if (dt < 0) return;                                  // relógio voltou: ignora
      if (dt >= REINICIO_MS) {
        s = estadoVazio(); pendentes = [];
        s.ultimaT = t; s.movendo = andando === true;
        if (!s.movendo) { s.paradoDesde = t; s.paradaInicio = t; }
        return;
      }
      if (dt > LACUNA_MS) {
        // não se sabe o que houve: não conta nada. Recomeça a parada (se for o caso) a partir de agora.
        s.ultimaT = t;
        const agoraAndando = andando === null ? s.movendo : andando;
        if (agoraAndando) { s.movendo = true; s.paradoDesde = null; s.paradaInicio = null; }
        else { s.movendo = false; s.paradoDesde = t; s.paradaInicio = t; }
        return;
      }
      const eraAndando = s.movendo;
      const agora = andando === null ? eraAndando : andando;
      if (eraAndando) s.dirMs += dt;
      s.ultimaT = t;
      if (eraAndando && !agora) { s.movendo = false; s.paradoDesde = t; s.paradaInicio = t; }
      else if (!eraAndando && agora) { fecharParada(t); s.movendo = true; conferirPausa(); }
      else if (!eraAndando && !agora) conferirPausa();
      checarMarcos();
    }

    function estado(t) {
      const semSinal = s.ultimaT == null || (typeof t === "number" && t - s.ultimaT > LACUNA_MS);
      const restanteMs = cfg.limiteMin * MIN - s.dirMs;
      const pausa = pausaFeita();
      let nivel = "ok";
      if (restanteMs <= 0) nivel = "limite"; else if (restanteMs <= cfg.avisoAntesMin * MIN) nivel = "aviso";
      const visivel = cfg.ligado && !semSinal &&
        (s.dirMs >= Math.min(MOSTRAR_APOS_MIN, cfg.limiteMin - cfg.avisoAntesMin) * MIN || nivel !== "ok");
      return { ligado: cfg.ligado, semSinal, movendo: s.movendo, dirMs: s.dirMs, restanteMs, pausaMs: pausa,
        pausaFaltaMs: Math.max(0, cfg.pausaMin * MIN - pausa), nivel, visivel, ultimoLongo: s.ultimoLongo };
    }
    function eventos() { const e = pendentes; pendentes = []; return e; }
    function zerar(t) {
      zerarJanela(); pendentes = [];
      if (typeof t === "number") { s.ultimaT = t; if (!s.movendo) { s.paradoDesde = t; } }
    }
    function definirConfig(novo) {
      const antes = cfg;
      cfg = normalizarConfig(novo);
      if (!cfg.ligado && antes.ligado) pendentes = [];
      // limites novos valem na hora: refaz os marcos
      if (cfg.limiteMin !== antes.limiteMin || cfg.avisoAntesMin !== antes.avisoAntesMin) {
        s.avisou = s.dirMs >= (cfg.limiteMin - cfg.avisoAntesMin) * MIN;
        s.limitou = s.dirMs >= cfg.limiteMin * MIN;
      }
    }
    return { amostra, estado, eventos, zerar, config: () => Object.assign({}, cfg), definirConfig,
      exportar: () => Object.assign({}, s) };
  }

  const API = { PADRAO, FAIXAS, CHAVE_CONFIG, CHAVE_ESTADO, LACUNA_MS, REINICIO_MS, MOSTRAR_APOS_MIN, TEXTO_TRANSPARENCIA,
    normalizarConfig, lerConfig, gravarConfig, normalizarEstado, lerEstado, gravarEstado, estadoVazio,
    fmt, fmtFalado, textoAviso, criar };
  if (typeof module !== "undefined" && module.exports) module.exports = API; else raiz.CopilotoDescanso = API;
})(typeof window !== "undefined" ? window : globalThis);
