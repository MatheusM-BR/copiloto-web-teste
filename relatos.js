// Relatos de motoristas: restrições e ocorrências na estrada.
// Regras do dossiê: relato sempre tem validade (expiração) e nunca é apresentado como confirmado.
(function (raiz) {
  "use strict";

  const H = 3600 * 1000, D = 24 * H;

  const TIPOS = {
    altura_maxima: { rotulo: "Altura máxima (ponte ou viaduto)", sigla: "ALT",    ttlMs: 180 * D, valor: { rotulo: "Altura (m)", min: 1.5, max: 6,   unidade: "m" } },
    limite_peso:   { rotulo: "Limite de peso (ponte)",           sigla: "PESO",   ttlMs: 180 * D, valor: { rotulo: "Peso (t)",   min: 1,   max: 100, unidade: "t" } },
    obra:          { rotulo: "Obra na pista",                    sigla: "OBRA",   ttlMs: 7 * D },
    buraco:        { rotulo: "Buraco ou pista danificada",       sigla: "BURACO", ttlMs: 30 * D },
    acidente:      { rotulo: "Acidente",                         sigla: "ACID",   ttlMs: 3 * H },
    radar_movel:   { rotulo: "Radar móvel",                      sigla: "RADAR",  ttlMs: 2 * H },
    animal:        { rotulo: "Animal na pista",                  sigla: "ANIMAL", ttlMs: 1 * H },
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

  // pos: { lat, lon }; valorTexto: texto do campo de valor (ignorado nos tipos sem valor)
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
    return {
      ok: true,
      relato: { id, tipo, lat: pos.lat, lon: pos.lon, valor, criadoEm: agoraMs, expiraEm: agoraMs + cfg.ttlMs, fonte: "relato_usuario", confirmado: false },
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

  function descricao(r, agoraMs) {
    const restante = r.expiraEm - agoraMs;
    const validade = restante < D ? "vale por mais " + Math.max(1, Math.round(restante / H)) + " h" : "vale até " + dataCurta(r.expiraEm);
    return "Relato seu, não confirmado · " + validade;
  }

  const api = { TIPOS, criarRelato, ativos, titulo, descricao, lerValor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoRelatos = api;
})(typeof window !== "undefined" ? window : globalThis);
