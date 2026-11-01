// Custos da rota (v1): pedágio e combustível estimados. Lógica pura, sem DOM, testada no Node (tests/custos.test.js).
// Contrato com o servidor e com a interface: ARQUITETURA.md, seção "Custos da rota (v1)".
// Regras do projeto: nada de inventar dado. Sem eixos, sem consumo ou sem preço, o valor fica desconhecido e o
// motivo vai em português para a tela. Todo valor é "estimado".
(function (raiz) {
  "use strict";

  const CHAVE_MODO = "copiloto.rota.modo.v1";        // "padrao" | "avancado" (Configurações e tela da rota)
  const MODOS = ["padrao", "avancado"];
  const MAX_PONTOS_RPC = 5000;                         // limite das RPCs de rota no servidor
  const PRODUTO_PADRAO = "diesel_s10";

  // ---------------------------------------------------------------- modo de visualização
  function lerModo(storage) {
    try {
      const v = storage && storage.getItem(CHAVE_MODO);
      return MODOS.includes(v) ? v : "padrao";
    } catch (e) { return "padrao"; }
  }
  function salvarModo(storage, modo) {
    if (!MODOS.includes(modo)) return false;
    try { storage.setItem(CHAVE_MODO, modo); return true; } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- formatação
  function formatarReais(v, casas) {
    if (v == null || !isFinite(v)) return "";
    const c = casas == null ? 2 : casas;
    const n = Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c });
    return (v < 0 ? "−" : "") + "R$ " + n;
  }
  // "R$ 187,40 (estimado)"
  function formatarEstimado(v) {
    const t = formatarReais(v);
    return t ? t + " (estimado)" : "";
  }
  function formatarLitros(l) {
    if (l == null || !isFinite(l)) return "";
    return Math.round(l).toLocaleString("pt-BR") + " L";
  }
  function plural(n, um, varios) { return n + " " + (n === 1 ? um : varios); }

  // ---------------------------------------------------------------- pedágio
  // Eixos cobrados: vazio não paga os eixos suspensos (Lei 13.103/2015, art. 17, red. Lei 13.711/2018). Mínimo 2.
  // carregado: true | false | null (null = não informado → trata como carregado: pelo lado caro, nunca subestima).
  function eixosCobrados(eixos, carregado, suspensos) {
    if (eixos == null || !Number.isInteger(eixos) || eixos < 2 || eixos > 12) return null;
    if (carregado !== false) return eixos;
    const s = Math.min(Math.max(Number.isInteger(suspensos) ? suspensos : 0, 0), eixos - 2);
    return eixos - s;
  }

  // Classe do pedágio pelo tipo do veículo cadastrado (validacao.js TIPOS). Carro = rodagem simples; o resto,
  // caminhão (rodagem dupla, cobrança por eixo).
  function classeVeiculo(perfil) {
    if (!perfil) return null;
    if (perfil.classePedagio) return perfil.classePedagio;
    return perfil.tipo === "Carro" ? "passeio" : "comercial";
  }

  // Tabela padrão de categorias dos contratos ANTT (cat. 1–9). Acima de 6 eixos: o contrato decide (null, × eixos).
  const CATEGORIAS = {
    comercial: { 2: [2, 2], 3: [4, 3], 4: [6, 4], 5: [7, 5], 6: [8, 6] },
    passeio: { 2: [1, 1], 3: [3, 1.5], 4: [5, 2] },
    moto: { 2: [9, 0.5] },
  };
  function categoria(classe, eixos) {
    const t = CATEGORIAS[classe];
    if (!t || eixos == null) return null;
    if (t[eixos]) return { categoria: t[eixos][0], multiplicador: t[eixos][1] };
    if (classe === "comercial" && eixos > 6 && eixos <= 12) return { categoria: null, multiplicador: eixos };
    return null;
  }

  // Linha da rota para as RPCs: GeoJSON LineString com no máximo `max` pontos (primeiro e último ficam).
  // coords: [[lng, lat], ...] (formato do rota.js / MapLibre).
  function rotaGeoJSON(coords, max) {
    const m = Math.max(2, Math.min(max || MAX_PONTOS_RPC, MAX_PONTOS_RPC));
    const c = (coords || []).filter((x) => Array.isArray(x) && isFinite(x[0]) && isFinite(x[1]));
    if (c.length < 2) return null;
    let out = c;
    if (c.length > m) {
      const passo = (c.length - 1) / (m - 1);
      out = [];
      for (let i = 0; i < m; i++) out.push(c[Math.round(i * passo)]);
    }
    return { type: "LineString", coordinates: out.map((x) => [Number(Number(x[0]).toFixed(6)), Number(Number(x[1]).toFixed(6))]) };
  }

  // Parâmetros de public.copiloto_route_tolls. opcoes: { carregado, suspensos }.
  // Retorna { ok:true, params } ou { ok:false, motivo }.
  function paramsPedagio(coords, perfil, opcoes) {
    const o = opcoes || {};
    const rota = rotaGeoJSON(coords);
    if (!rota) return { ok: false, motivo: "Trace uma rota para estimar o pedágio." };
    if (!perfil || perfil.eixos == null) return { ok: false, motivo: "Cadastre o número de eixos do veículo para estimar o pedágio." };
    const classe = classeVeiculo(perfil);
    const params = {
      p_route: rota, p_axles: perfil.eixos, p_loaded: o.carregado !== false,
      p_suspended_axles: o.carregado === false && Number.isInteger(o.suspensos) ? o.suspensos : 0,
      p_vehicle_class: classe,
    };
    return { ok: true, params };
  }

  // Resposta da RPC → resumo para a tela. Nunca soma praça sem tarifa como zero sem avisar.
  function resumoPedagio(resp) {
    if (!resp || !Array.isArray(resp.pracas)) return { ok: false, motivo: "Pedágio indisponível agora." };
    const pracas = resp.pracas;
    const semTarifa = pracas.filter((p) => p.valor == null).length;
    const incerto = pracas.filter((p) => p.sentido === "desconhecido").length;
    const extrapoladas = pracas.filter((p) => p.regra === "extrapolada").length;
    const total = Math.round(Number(resp.total || 0) * 100) / 100;
    return {
      ok: true, total, pracas, quantidade: pracas.length, semTarifa, sentidoIncerto: incerto, extrapoladas,
      completo: semTarifa === 0, eixosCobrados: resp.eixos_cobrados, categoria: resp.categoria,
    };
  }

  // "R$ 187,40 (estimado)" | "R$ 120,00 (estimado); 2 praças sem tarifa conhecida" | "Nenhuma praça de pedágio conhecida na rota"
  function textoPedagio(r) {
    if (!r || !r.ok) return r ? r.motivo : "";
    if (r.quantidade === 0) return "Nenhuma praça de pedágio conhecida na rota (estimativa).";
    if (r.semTarifa === r.quantidade) {
      return plural(r.quantidade, "praça", "praças") + " de pedágio na rota, sem tarifa conhecida.";
    }
    let t = formatarEstimado(r.total);
    if (r.semTarifa) t += "; " + plural(r.semTarifa, "praça sem tarifa conhecida", "praças sem tarifa conhecida");
    return t;
  }

  // Avisos extras (para o detalhe): sentido incerto, tarifas acima de 6 eixos pela regra geral.
  function avisosPedagio(r) {
    const out = [];
    if (!r || !r.ok) return out;
    if (r.sentidoIncerto) out.push(plural(r.sentidoIncerto, "praça", "praças") + " sem sentido de cobrança conhecido: contada" + (r.sentidoIncerto === 1 ? "" : "s") + " como cobrada" + (r.sentidoIncerto === 1 ? "" : "s") + ".");
    if (r.extrapoladas) out.push("Acima de 6 eixos o valor é calculado por eixo; o contrato da praça pode cobrar diferente.");
    out.push("Valor de cabine sem desconto de tag. Pode mudar com reajuste da concessionária.");
    return out;
  }

  // ---------------------------------------------------------------- combustível
  // Consumo usado: carregado → consumoCarregado (ou consumo); vazio → consumoVazio (ou consumo).
  // Carga não informada (null) → usa o consumo carregado (pelo lado caro).
  function consumoPara(perfil, carregado) {
    if (!perfil) return null;
    const vazio = carregado === false;
    const c = vazio ? (perfil.consumoVazio != null ? perfil.consumoVazio : perfil.consumo)
                    : (perfil.consumoCarregado != null ? perfil.consumoCarregado : perfil.consumo);
    return c != null && isFinite(c) && c > 0 ? Number(c) : null;
  }

  // Gancho da v2 (altimetria): fator ≥ 1 sobre os litros, vindo do perfil de elevação da rota (Valhalla /height
  // ou elevação no corredor). Na v1 é sempre 1 (sem ajuste). Ver ARQUITETURA.md.
  function fatorRampa(elevacao) {
    if (!elevacao || !isFinite(elevacao.fator) || elevacao.fator < 1) return 1;
    return Math.min(elevacao.fator, 1.5);
  }

  // { distanciaM, perfil, carregado, preco (R$/L), elevacao? } → { ok, litros, preco, valor, consumo, fator } | { ok:false, motivo }
  function combustivel(entrada) {
    const e = entrada || {};
    if (!(e.distanciaM > 0)) return { ok: false, motivo: "Trace uma rota para estimar o combustível." };
    const consumo = consumoPara(e.perfil, e.carregado);
    if (consumo == null) return { ok: false, motivo: "Cadastre o consumo (km/L) do veículo para estimar o combustível." };
    const fator = fatorRampa(e.elevacao);
    const litros = (e.distanciaM / 1000 / consumo) * fator;
    if (e.preco == null || !(e.preco > 0)) {
      return { ok: false, litros, consumo, fator, motivo: "Preço médio do diesel indisponível agora." };
    }
    const valor = Math.round(litros * e.preco * 100) / 100;
    return { ok: true, litros, preco: Number(e.preco), valor, consumo, fator };
  }

  // Resposta de public.copiloto_route_fuel_price → preço usado e texto da origem.
  function precoDaResposta(resp) {
    if (!resp || resp.preco_medio == null) return { ok: false, motivo: "Preço médio do diesel indisponível agora." };
    const preco = Number(resp.preco_medio);
    const origem = resp.metodo === "ponderado_por_uf"
      ? "média ANP das UFs da rota (" + (resp.ufs || []).filter((u) => u.preco != null).map((u) => u.uf).join(", ") + ")"
      : "média ANP nacional (UFs da rota não reconhecidas)";
    return { ok: true, preco, metodo: resp.metodo, origem, semana: resp.semana_referencia || null };
  }

  function textoCombustivel(r) {
    if (!r || !r.ok) return r ? r.motivo : "";
    return formatarEstimado(r.valor) + " · " + formatarLitros(r.litros) + " × " + formatarReais(r.preco, 2).replace("R$ ", "R$ ") + "/L";
  }

  // ---------------------------------------------------------------- total e comparação
  // pedagio: resultado de resumoPedagio; comb: resultado de combustivel. Soma só o que é conhecido e diz o que falta.
  function totalViagem(pedagio, comb) {
    const partes = [];
    const faltando = [];
    let total = 0;
    if (pedagio && pedagio.ok && pedagio.quantidade > 0 && pedagio.semTarifa < pedagio.quantidade) { total += pedagio.total; partes.push("pedagio"); }
    else if (pedagio && pedagio.ok && pedagio.quantidade === 0) partes.push("pedagio");
    else faltando.push("pedágio");
    if (pedagio && pedagio.ok && pedagio.semTarifa > 0 && pedagio.semTarifa < pedagio.quantidade) faltando.push("parte do pedágio");
    if (comb && comb.ok) { total += comb.valor; partes.push("combustivel"); } else faltando.push("combustível");
    total = Math.round(total * 100) / 100;
    if (!partes.length) return { ok: false, total: null, partes, faltando, texto: "Custo da viagem indisponível." };
    let texto = "Total " + formatarEstimado(total);
    if (faltando.length) texto += " — sem " + faltando.join(" e ");
    return { ok: true, total, partes, faltando, completo: faltando.length === 0, texto };
  }

  // Diferença de custo entre a rota `b` e a rota de referência `a` (cada uma { pedagio, combustivel }).
  // "+R$ 42 de pedágio", "−R$ 15 de combustível". Diferença abaixo de R$ 1 = "mesmo pedágio".
  function difTexto(d, oque) {
    if (d == null) return null;
    if (Math.abs(d) < 1) return "mesmo " + oque;
    return (d > 0 ? "+" : "−") + "R$ " + Math.round(Math.abs(d)).toLocaleString("pt-BR") + " de " + oque;
  }
  function compararRotas(a, b) {
    const pa = a && a.pedagio && a.pedagio.ok ? a.pedagio : null;
    const pb = b && b.pedagio && b.pedagio.ok ? b.pedagio : null;
    const ca = a && a.combustivel && a.combustivel.ok ? a.combustivel : null;
    const cb = b && b.combustivel && b.combustivel.ok ? b.combustivel : null;
    const dp = pa && pb ? Math.round((pb.total - pa.total) * 100) / 100 : null;
    const dc = ca && cb ? Math.round((cb.valor - ca.valor) * 100) / 100 : null;
    const textos = [difTexto(dp, "pedágio"), difTexto(dc, "combustível")].filter(Boolean);
    const incerto = !!((pa && pa.semTarifa) || (pb && pb.semTarifa));
    return { pedagio: dp, combustivel: dc, total: dp != null && dc != null ? Math.round((dp + dc) * 100) / 100 : null, textos, incerto };
  }

  const api = {
    CHAVE_MODO, MODOS, MAX_PONTOS_RPC, PRODUTO_PADRAO, CATEGORIAS,
    lerModo, salvarModo, formatarReais, formatarEstimado, formatarLitros,
    eixosCobrados, classeVeiculo, categoria, rotaGeoJSON, paramsPedagio, resumoPedagio, textoPedagio, avisosPedagio,
    consumoPara, fatorRampa, combustivel, precoDaResposta, textoCombustivel, totalViagem, compararRotas,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoCustos = api;
})(typeof window !== "undefined" ? window : globalThis);
