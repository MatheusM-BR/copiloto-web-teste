// Rota: monta o pedido ao Valhalla, decodifica a resposta e escreve os avisos de honestidade.
// Regra central: medida do veículo que o motorista não informou NÃO é inventada aqui.
// Ela é omitida do pedido (o motor usa um padrão próprio) e o aviso diz isso na tela.
(function (raiz) {
  "use strict";

  // Servidor público e gratuito do projeto OpenStreetMap (FOSSGIS), só para teste. Uso justo, sem garantia.
  const URL_PADRAO = "https://valhalla1.openstreetmap.de/route";

  const MEDIDAS = [
    { campo: "altura",      valhalla: "height",     rotulo: "altura" },
    { campo: "largura",     valhalla: "width",      rotulo: "largura" },
    { campo: "comprimento", valhalla: "length",     rotulo: "comprimento" },
    { campo: "pbtc",        valhalla: "weight",     rotulo: "PBTC" },
    { campo: "eixos",       valhalla: "axle_count", rotulo: "eixos" },
  ];

  function ehCaminhao(perfil) { return !!perfil && perfil.tipo !== "Carro"; }

  // Carga por eixo (t) para o Valhalla (axle_load) e para a consulta de restrições (p_axle_t). O cadastro do veículo não
  // tem "peso por eixo": vale eixoT, se um dia existir; senão a MÉDIA PBTC ÷ eixos (estimativa: o eixo mais carregado pesa
  // mais que a média). Sem os dois números: null (o campo é omitido, nada é inventado).
  function cargaPorEixoT(perfil) {
    const p = perfil || {};
    const num = (v) => typeof v === "number" && isFinite(v);
    if (num(p.eixoT) && p.eixoT > 0) return p.eixoT;
    if (num(p.pbtc) && num(p.eixos) && p.eixos >= 2 && p.pbtc > 0) return Math.round(p.pbtc / p.eixos * 10) / 10;
    return null;
  }

  // origem/destino: { lat, lon }. perfil: perfil ativo ou null. extra (opcional):
  //  { semPedagio: true } → use_tolls 0; { semBalsa: true } → use_ferry 0 (o Valhalla evita quando dá; não é garantia: a
  //  resposta diz se a rota ainda tem pedágio/balsa); { semTerra: true } → exclude_unpaved (Valhalla ≥ 3.4);
  //  { paradas: [{ lat, lon }] } → paradas intermediárias ("break": viram pernas, a navegação diz "chegou à parada").
  // Caminhão: height/width/length/weight/axle_count/axle_load do cadastro (medida ausente é omitida, nunca inventada) e
  // hazmat só quando o cadastro marca carga perigosa (perfil.hazmat === true).
  function criarPedido(perfil, origem, destino, extra) {
    const paradas = extra && Array.isArray(extra.paradas) ? extra.paradas.filter((p) => p && isFinite(p.lat) && isFinite(p.lon)) : [];
    const pedido = {
      locations: [
        { lat: origem.lat, lon: origem.lon, type: "break" },
        ...paradas.map((p) => ({ lat: p.lat, lon: p.lon, type: "break" })),
        { lat: destino.lat, lon: destino.lon, type: "break" },
      ],
      costing: ehCaminhao(perfil) ? "truck" : "auto",
      directions_options: { units: "kilometers", language: "pt-BR" },
    };
    const faltando = [];
    if (ehCaminhao(perfil)) {
      const opcoes = {};
      for (const m of MEDIDAS) {
        const v = perfil[m.campo];
        if (typeof v === "number" && isFinite(v)) opcoes[m.valhalla] = v;
        else faltando.push(m.rotulo);
      }
      const eixo = cargaPorEixoT(perfil);
      if (eixo != null) opcoes.axle_load = eixo;
      if (perfil.hazmat === true) opcoes.hazmat = true;
      Object.assign(opcoes, preferencias(extra));
      pedido.costing_options = { truck: opcoes };
    } else {
      const op = preferencias(extra);
      if (Object.keys(op).length) pedido.costing_options = { auto: op };
    }
    return { pedido, faltando };
  }

  // Preferências de rota → opções do costing (iguais para "truck" e "auto")
  function preferencias(extra) {
    const o = {};
    if (extra && extra.semPedagio) o.use_tolls = 0;
    if (extra && extra.semBalsa) o.use_ferry = 0;
    if (extra && extra.semTerra) o.exclude_unpaved = true;
    return o;
  }

  function decodificarPolyline6(texto) {
    const coords = [];
    let i = 0, lat = 0, lon = 0;
    while (i < texto.length) {
      for (let eixo = 0; eixo < 2; eixo++) {
        let b, deslocamento = 0, resultado = 0;
        do {
          b = texto.charCodeAt(i++) - 63;
          resultado |= (b & 0x1f) << deslocamento;
          deslocamento += 5;
        } while (b >= 0x20 && i <= texto.length);
        const delta = (resultado & 1) ? ~(resultado >> 1) : (resultado >> 1);
        if (eixo === 0) lat += delta; else lon += delta;
      }
      coords.push([lon / 1e6, lat / 1e6]); // [lng, lat], como o MapLibre espera
    }
    return coords;
  }

  // Erros conhecidos do servidor em português claro (nunca "Path distance exceeds…" cru na tela). Rota longa: rotalonga.js.
  function traduzirErro(msg) {
    const t = String(msg);
    if (/max distance limit|exceeds the max distance/i.test(t)) return "A rota é muito longa para o servidor de rotas de uma vez. Tente de novo; o app divide a viagem em trechos.";
    if (/No suitable edges|Could not find a location/i.test(t)) return "Não achei estrada perto da origem ou do destino. Escolha um ponto mais perto de uma estrada.";
    if (/No path could be found/i.test(t)) return "O servidor não achou caminho para este veículo (restrição de altura, peso ou eixos, ou estrada interrompida).";
    return "O servidor de rotas respondeu: " + t;
  }

  // Lança Error com mensagem em português se a resposta não for uma rota.
  function resumirResposta(json) {
    if (!json || !json.trip) {
      const msg = json && (json.error || json.message);
      throw new Error(msg ? traduzirErro(msg) : "Resposta inesperada do servidor de rotas.");
    }
    if (json.trip.status !== 0 || !Array.isArray(json.trip.legs) || !json.trip.legs.length) {
      throw new Error(json.trip.status_message || "Não foi possível traçar a rota.");
    }
    const coords = [];
    for (const leg of json.trip.legs) {
      if (typeof leg.shape !== "string") throw new Error("A rota veio sem o desenho do trajeto.");
      coords.push(...decodificarPolyline6(leg.shape));
    }
    const s = json.trip.summary || {};
    return { km: Number(s.length), minutos: Math.round(Number(s.time) / 60), coords };
  }

  function formatarTempo(minutos) {
    if (!isFinite(minutos)) return "--";
    const h = Math.floor(minutos / 60), m = minutos % 60;
    return h > 0 ? h + " h " + String(m).padStart(2, "0") + " min" : m + " min";
  }

  function formatarKm(km) {
    return isFinite(km) ? km.toFixed(1).replace(".", ",") + " km" : "--";
  }

  // Avisos que sempre aparecem junto com a rota.
  function avisos(perfil, faltando) {
    const lista = [];
    if (!perfil) {
      lista.push("Nenhum veículo ativo: a rota foi calculada para carro.");
    } else if (!ehCaminhao(perfil)) {
      lista.push("Veículo ativo é carro: a rota foi calculada para carro.");
    } else if (faltando.length) {
      lista.push("Medidas não informadas (" + faltando.join(", ") + "): o servidor usou valores padrão dele. Cadastre as medidas do veículo.");
    }
    // Pontes, viadutos e limites: o estado (verificado / não verificado / com violação) é uma linha só, em ui/avisos.js
    // (linhaEstadoRestricoes + cartão de restrições); aqui não há mais um aviso fixo que contradiria o resultado.
    return lista;
  }

  const api = { URL_PADRAO, traduzirErro, criarPedido, cargaPorEixoT, decodificarPolyline6, resumirResposta, formatarTempo, formatarKm, avisos, ehCaminhao };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoRota = api;
})(typeof window !== "undefined" ? window : globalThis);
