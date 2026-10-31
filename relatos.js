// Relatos de motoristas: restrições e ocorrências na estrada.
// Regras do dossiê: relato sempre tem validade (expiração). Sem o rótulo repetido "não confirmado" (COM-05).
(function (raiz) {
  "use strict";

  const H = 3600 * 1000, D = 24 * H;

  // sentido: o relato só vale para quem vai no mesmo sentido (ALT-03). risco: tipo de risco alto (bipe de aproximação, ALT-02).
  // curto: nome do botão na grade do formulário de relato (A3).
  const TIPOS = {
    altura_maxima:      { rotulo: "Altura máxima (ponte ou viaduto)", curto: "Altura máxima",  sigla: "ALT",     ttlMs: 180 * D, valor: { rotulo: "Altura (m)", min: 1.5, max: 6,   unidade: "m" } },
    limite_peso:        { rotulo: "Limite de peso (ponte)",           curto: "Peso máximo",    sigla: "PESO",    ttlMs: 180 * D, valor: { rotulo: "Peso (t)",   min: 1,   max: 100, unidade: "t" } },
    obra:               { rotulo: "Obra na pista",                    curto: "Obra",           sigla: "OBRA",    ttlMs: 7 * D },
    buraco:             { rotulo: "Buraco ou pista danificada",       curto: "Buraco",         sigla: "BURACO",  ttlMs: 30 * D },
    acidente:           { rotulo: "Acidente",                         curto: "Acidente",       sigla: "ACID",    ttlMs: 3 * H,  sentido: true, risco: true },
    radar_movel:        { rotulo: "Radar móvel",                      curto: "Radar móvel",    sigla: "RADAR",   ttlMs: 2 * H,  sentido: true },
    animal:             { rotulo: "Animal na pista",                  curto: "Animal",         sigla: "ANIMAL",  ttlMs: 1 * H,  risco: true },
    // taxonomia 7.1 (E5)
    fila:               { rotulo: "Fila ou trânsito parado",          curto: "Fila",           sigla: "FILA",    ttlMs: 1 * H,  sentido: true, risco: true },
    objeto:             { rotulo: "Objeto na pista",                  curto: "Objeto",         sigla: "OBJETO",  ttlMs: 2 * H,  sentido: true, risco: true },
    veiculo_parado:     { rotulo: "Veículo parado",                   curto: "Veículo parado", sigla: "PARADO",  ttlMs: 2 * H,  sentido: true, risco: true },
    alagamento:         { rotulo: "Alagamento",                       curto: "Alagamento",     sigla: "ÁGUA",    ttlMs: 6 * H },
    neblina:            { rotulo: "Neblina",                          curto: "Neblina",        sigla: "NEBLINA", ttlMs: 3 * H },
    pista_escorregadia: { rotulo: "Pista escorregadia",               curto: "Pista lisa",     sigla: "LISA",    ttlMs: 6 * H },
    balanca:            { rotulo: "Balança/fiscalização de peso",     curto: "Balança",        sigla: "BALANÇA", ttlMs: 30 * D, sentido: true },
  };

  function lerValor(texto, cfg) {
    const t = String(texto == null ? "" : texto).trim();
    if (t === "") return { ok: false, erro: cfg.rotulo + ": informe o valor." };
    if (t.includes(",") && t.includes(".")) return { ok: false, erro: cfg.rotulo + ": use só vírgula ou só ponto." };
    if (!/^\d+([.,]\d+)?$/.test(t)) return { ok: false, erro: cfg.rotulo + ": digite um número." };
    const n = Number(t.replace(",", "."));
    if (n < cfg.min || n > cfg.max) return { ok: false, erro: cfg.rotulo + ": entre " + cfg.min + " e " + cfg.max + "." };
    return { ok: true, valor: n };
  }

  // pos: { lat, lon, rumo? }; valorTexto: texto do campo de valor (ignorado nos tipos sem valor).
  // rumo (graus, opcional): sentido de quem relatou; o relato local guarda para o alerta conferir o sentido (ALT-03).
  function criarRelato(tipo, pos, valorTexto, agoraMs, id) {
    const cfg = TIPOS[tipo];
    if (!cfg) return { ok: false, erro: "Escolha o tipo do relato." };
    if (!pos || !isFinite(pos.lat) || !isFinite(pos.lon)) return { ok: false, erro: "Sem posição do GPS." };
    let valor = null;
    if (cfg.valor) {
      const r = lerValor(valorTexto, cfg.valor);
      if (!r.ok) return r;
      valor = r.valor;
    }
    const relato = { id, tipo, lat: pos.lat, lon: pos.lon, valor, criadoEm: agoraMs, expiraEm: agoraMs + cfg.ttlMs, fonte: "relato_usuario", confirmado: false };
    if (pos.rumo != null && isFinite(pos.rumo)) relato.rumo = Number(pos.rumo);
    return { ok: true, relato };
  }

  // M3: relato local (deste aparelho) no formato das linhas da nuvem (copiloto_reports_near), para o alerta à frente.
  // paraServidor: função tipo do app → tipo do servidor (CopilotoNuvem.tipoParaServidor). Sem tipo conhecido: null.
  function comoLinhaDaNuvem(r, paraServidor) {
    const tipo = r && TIPOS[r.tipo] ? paraServidor(r.tipo) : null;
    if (!tipo || !isFinite(r.lat) || !isFinite(r.lon)) return null;
    return {
      id: "local:" + r.id, report_type: tipo, value_numeric: r.valor == null ? null : r.valor, lat: r.lat, lon: r.lon,
      heading_deg: r.rumo != null && isFinite(r.rumo) ? r.rumo : null, level: "reported", confirm_count: 0, deny_count: 0,
      mine: true, my_vote: null, expires_at: new Date(r.expiraEm).toISOString(), local: true,
    };
  }

  function ativos(lista, agoraMs) {
    return lista.filter((r) => TIPOS[r.tipo] && r.expiraEm > agoraMs);
  }

  function dataCurta(ms) {
    const d = new Date(ms);
    return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
  }

  function titulo(r) {
    const cfg = TIPOS[r.tipo];
    const v = r.valor == null ? "" : " " + String(r.valor).replace(".", ",") + " " + cfg.valor.unidade;
    return cfg.rotulo.split(" (")[0] + v;
  }

  function validade(expiraEm, agoraMs) {
    const restante = expiraEm - agoraMs;
    return restante < D ? "vale por mais " + Math.max(1, Math.round(restante / H)) + " h" : "vale até " + dataCurta(expiraEm);
  }

  function descricao(r, agoraMs) {
    return "Relato seu, só neste aparelho · " + validade(r.expiraEm, agoraMs);
  }

  // M2: texto da idade da posição do relato ("há 8 s"), só quando o toque no "!" foi há mais de 5 s. Senão "".
  function textoIdadePosicao(msDesdeToque) {
    const s = Math.round(Number(msDesdeToque) / 1000);
    if (!(s > 5)) return "";
    return "Relato no ponto de há " + (s < 120 ? s + " s" : Math.round(s / 60) + " min") + " (onde você tocou no \"!\").";
  }

  const api = { TIPOS, criarRelato, ativos, titulo, descricao, validade, lerValor, comoLinhaDaNuvem, textoIdadePosicao };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoRelatos = api;
})(typeof window !== "undefined" ? window : globalThis);
