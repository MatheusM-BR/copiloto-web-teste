// Validação do perfil de veículo. Espelha VehicleProfileValidator.kt do app Android.
// Regra central: campo em branco = desconhecido (null). Nunca vira valor padrão inventado.
(function (raiz) {
  "use strict";

  const LIMITES = {
    altura:      { min: 1.0, max: 5.5,  rotulo: "Altura",      unidade: "m", inteiro: false },
    largura:     { min: 1.0, max: 3.2,  rotulo: "Largura",     unidade: "m", inteiro: false },
    comprimento: { min: 2.0, max: 35.0, rotulo: "Comprimento", unidade: "m", inteiro: false },
    pbtc:        { min: 0.5, max: 91.0, rotulo: "PBTC",        unidade: "t", inteiro: false },
    eixos:       { min: 2,   max: 12,   rotulo: "Eixos",       unidade: "",  inteiro: true  },
    // Peso vazio (tara): a navegação usa quando o motorista responde "Vazio" (sem perguntar de novo).
    tara:        { min: 0.5, max: 91.0, rotulo: "Peso vazio",  unidade: "t", inteiro: false },
    // Autonomia (pacote E2). Mesmos limites de vehicle_profiles no banco.
    tanque:      { min: 10,  max: 3000, rotulo: "Tanque",      unidade: "L", inteiro: false },
    consumo:     { min: 0.5, max: 30,   rotulo: "Consumo",     unidade: "km/L", inteiro: false },
  };

  const TIPOS = ["Carro", "Toco", "Truck", "Carreta", "Bitrem", "Rodotrem", "Personalizado"];
  const CARGAS = ["Não informado", "Carregado", "Vazio"];

  // Retorna { ok:true, valor:number|null } ou { ok:false, erro:string }
  function lerNumero(texto, campo) {
    const lim = LIMITES[campo];
    const t = String(texto == null ? "" : texto).trim();
    if (t === "") return { ok: true, valor: null };
    if (t.startsWith("-")) return { ok: false, erro: lim.rotulo + ": não pode ser negativo." };
    if (t.includes(",") && t.includes(".")) {
      return { ok: false, erro: lim.rotulo + ": use só vírgula ou só ponto (ex.: 4,40)." };
    }
    if (!/^\d+([.,]\d+)?$/.test(t)) return { ok: false, erro: lim.rotulo + ": digite um número." };
    const n = Number(t.replace(",", "."));
    if (lim.inteiro && !Number.isInteger(n)) {
      return { ok: false, erro: lim.rotulo + ": use número inteiro." };
    }
    if (n < lim.min || n > lim.max) {
      const u = lim.unidade ? " " + lim.unidade : "";
      return { ok: false, erro: lim.rotulo + ": entre " + lim.min + " e " + lim.max + u + "." };
    }
    return { ok: true, valor: n };
  }

  // entrada: { nome, tipo, carga, altura, largura, comprimento, pbtc, eixos, tara, tanque, consumo } (campos de texto)
  // saída:  { ok, perfil?, erros: {campo: mensagem} }
  function validarPerfil(entrada) {
    const erros = {};
    const nome = String(entrada.nome == null ? "" : entrada.nome).trim();
    if (nome === "") erros.nome = "Dê um nome ao veículo.";
    else if (nome.length > 80) erros.nome = "Nome com no máximo 80 letras.";
    if (!TIPOS.includes(entrada.tipo)) erros.tipo = "Escolha o tipo do veículo.";
    const carga = CARGAS.includes(entrada.carga) ? entrada.carga : "Não informado";

    const perfil = { nome, tipo: entrada.tipo, carga };
    for (const campo of Object.keys(LIMITES)) {
      const r = lerNumero(entrada[campo], campo);
      if (r.ok) perfil[campo] = r.valor;
      else erros[campo] = r.erro;
    }
    return Object.keys(erros).length ? { ok: false, erros } : { ok: true, perfil, erros: {} };
  }

  const api = { LIMITES, TIPOS, CARGAS, lerNumero, validarPerfil };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoValidacao = api;
})(typeof window !== "undefined" ? window : globalThis);
