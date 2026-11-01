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

  // origem/destino: { lat, lon }. perfil: perfil ativo ou null.
  function criarPedido(perfil, origem, destino) {
    const pedido = {
      locations: [
        { lat: origem.lat, lon: origem.lon, type: "break" },
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
      pedido.costing_options = { truck: opcoes };
    }
    return { pedido, faltando };
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

  // Lança Error com mensagem em português se a resposta não for uma rota.
  function resumirResposta(json) {
    if (!json || !json.trip) {
      const msg = json && (json.error || json.message);
      throw new Error(msg ? "O servidor de rotas respondeu: " + msg : "Resposta inesperada do servidor de rotas.");
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
    lista.push("Rota não verificada para pontes, viadutos e limites de peso. O mapa tem poucas restrições cadastradas. Confira a sinalização da estrada.");
    return lista;
  }

  const api = { URL_PADRAO, criarPedido, decodificarPolyline6, resumirResposta, formatarTempo, formatarKm, avisos, ehCaminhao };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoRota = api;
})(typeof window !== "undefined" ? window : globalThis);
