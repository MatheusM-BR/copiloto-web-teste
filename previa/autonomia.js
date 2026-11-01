// Autonomia (SRV-04): alcance estimado com os dados que o motorista INFORMOU. Lógica pura, testada no Node.
// Nunca inventa nível de combustível: sem litros informados não há estimativa.
(function (raiz) {
  "use strict";

  const LIMITE_AVISO = 0.8;   // acima de 80% do alcance o posto fica "no limite"

  // Litros digitados agora. Branco = não informado (null). Retorna { ok, valor } ou { ok:false, erro }.
  function lerLitros(texto, tanqueL) {
    const t = String(texto == null ? "" : texto).trim();
    if (t === "") return { ok: true, valor: null };
    if (t.includes(",") && t.includes(".")) return { ok: false, erro: "Use só vírgula ou só ponto (ex.: 250,5)." };
    if (!/^\d+([.,]\d+)?$/.test(t)) return { ok: false, erro: "Digite os litros como número (ex.: 250)." };
    const n = Number(t.replace(",", "."));
    if (n <= 0) return { ok: false, erro: "Litros precisa ser maior que zero." };
    if (tanqueL != null && n > tanqueL) return { ok: false, erro: "Mais litros (" + fmt(n) + ") que o tanque cadastrado (" + fmt(tanqueL) + " L)." };
    if (n > 3000) return { ok: false, erro: "Valor alto demais (máximo 3000 L)." };
    return { ok: true, valor: n };
  }

  // { ok:true, km, litros, consumo } ou { ok:false, motivo } — motivo em português para a tela.
  function alcance(veiculo, litros) {
    const consumo = veiculo ? veiculo.consumo : null;
    if (consumo == null || !(consumo > 0)) return { ok: false, motivo: "Cadastre o consumo (km/L) do veículo na aba Veículo para estimar o alcance." };
    if (litros == null) return { ok: false, motivo: "Informe quantos litros tem no tanque agora para estimar o alcance." };
    if (!(litros > 0)) return { ok: false, motivo: "Litros inválidos." };
    const tanque = veiculo.tanque;
    if (tanque != null && litros > tanque) return { ok: false, motivo: "Mais litros que o tanque cadastrado." };
    return { ok: true, km: litros * consumo, litros, consumo };
  }

  // Situação de um posto a `distanciaM` com alcance de `km`: "ok" | "limite" | "fora" | null (sem estimativa).
  function situacao(distanciaM, km) {
    if (km == null || distanciaM == null || !isFinite(distanciaM)) return null;
    const d = distanciaM / 1000;
    if (d > km) return "fora";
    if (d > km * LIMITE_AVISO) return "limite";
    return "ok";
  }
  function marcar(postos, km) {
    return (postos || []).map((p) => Object.assign({}, p, { alcance: situacao(p.distancia_m, km) }));
  }

  function fmt(n) { return String(Math.round(n * 10) / 10).replace(".", ","); }
  // "~X km" arredondado para baixo de 10 em 10 (a partir de 100 km), nunca para cima.
  function formatarAlcance(km) {
    if (km == null || !isFinite(km)) return "";
    const v = km >= 100 ? Math.floor(km / 10) * 10 : Math.floor(km);
    return "~" + v.toLocaleString("pt-BR") + " km";
  }
  function textoAlcance(r) {
    if (!r || !r.ok) return r ? r.motivo : "";
    return "Alcance estimado " + formatarAlcance(r.km) + " (" + fmt(r.litros) + " L × " + fmt(r.consumo) +
      " km/L). É só uma estimativa com os dados que você informou: o consumo real muda com carga, subida e velocidade.";
  }

  const api = { LIMITE_AVISO, lerLitros, alcance, situacao, marcar, formatarAlcance, textoAlcance };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoAutonomia = api;
})(typeof window !== "undefined" ? window : globalThis);
