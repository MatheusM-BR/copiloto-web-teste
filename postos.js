// Postos: lógica pura (sem DOM), testada no Node. Usada por ui/postos.js.
// Regra do projeto: atributo desconhecido aparece como "não informado"; nada é inventado.
(function (raiz) {
  "use strict";

  const CONE_GRAUS = 60;          // "à frente": diferença entre o rumo e a direção do posto
  const ZOOM_MINIMO = 11;         // postos no mapa só a partir deste zoom
  const RAIO_MAX_M = 50000;       // limite da API
  const MAX_PONTOS_ROTA = 4000;   // pontos enviados da rota (a API aceita até 5.000)

  // Ordem e rótulos dos atributos devolvidos pela API (copiloto_stations_*).
  const ATRIBUTOS = [
    ["diesel", "Diesel"],
    ["diesel_caminhao", "Bomba de diesel para caminhão"],
    ["arla32", "Arla 32"],
    ["acesso_caminhao", "Acesso de caminhão"],
    ["aberto_24h", "24 horas"],
    ["horario", "Horário"],
    ["banheiro", "Banheiro"],
    ["banho", "Banho"],
    ["gnv", "GNV"],
    ["etanol", "Etanol"],
  ];
  const ROTULO = Object.fromEntries(ATRIBUTOS);

  function distanciaM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function rumoGraus(a, b) {
    const rad = Math.PI / 180;
    const f1 = a.lat * rad, f2 = b.lat * rad, dl = (b.lon - a.lon) * rad;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  function difAngulo(a, b) { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; }

  // Postos à frente pelo rumo (sem rota). Sem rumo: todos, do mais perto ao mais longe.
  // Devolve cópias com distancia_m (linha reta) e dif_rumo (null sem rumo).
  function aFrentePorRumo(postos, pos, rumo, n) {
    const temRumo = rumo != null && isFinite(rumo);
    return (postos || [])
      .map((p) => {
        const d = distanciaM(pos, p);
        const dif = temRumo && d > 1 ? difAngulo(rumo, rumoGraus(pos, p)) : null;
        return Object.assign({}, p, { distancia_m: Math.round(d), dif_rumo: dif == null ? null : Math.round(dif) });
      })
      .filter((p) => !temRumo || p.dif_rumo == null || p.dif_rumo <= CONE_GRAUS)
      .sort((a, b) => a.distancia_m - b.distancia_m || String(a.station_key).localeCompare(String(b.station_key)))
      .slice(0, n == null ? Infinity : n);
  }

  // Postos na rota (resposta de copiloto_stations_along_route): só à frente, ordenados pelo caminho.
  function naRota(postos, n) {
    return (postos || [])
      .filter((p) => p.along_route_m != null && p.along_route_m > 0)
      .map((p) => Object.assign({}, p, { distancia_m: p.along_route_m }))
      .sort((a, b) => a.along_route_m - b.along_route_m || String(a.station_key).localeCompare(String(b.station_key)))
      .slice(0, n == null ? Infinity : n);
  }

  // Filtros "quando conhecido": só passa quem tem o atributo CONFIRMADO (true). Desconhecido não passa.
  function filtrar(postos, f) {
    f = f || {};
    return (postos || []).filter((p) => {
      const a = p.attributes || {};
      if (f.diesel && a.diesel !== true && a.diesel_caminhao !== true) return false;
      if (f.caminhao && a.acesso_caminhao !== true) return false;
      if (f.h24 && a.aberto_24h !== true) return false;
      if (f.banho && a.banho !== true) return false;
      if (f.aberto && abertoAgoraDoPosto(p, f.agora) !== true) return false;   // só confirmado aberto; horário desconhecido não passa
      if (Array.isArray(f.bandeiras) && f.bandeiras.length && !f.bandeiras.includes(grupoBandeira(p.brand))) return false;
      return true;
    });
  }

  function formatarDistancia(m) {
    if (m == null || !isFinite(m)) return "distância desconhecida";
    if (m < 1000) return Math.max(10, Math.round(m / 10) * 10) + " m";
    const km = m / 1000;
    return (km < 10 ? km.toFixed(1).replace(".", ",") : String(Math.round(km))) + " km";
  }

  function nomeBandeira(brand) {
    const b = String(brand || "").trim();
    if (!b) return "Bandeira não informada";
    const u = b.toUpperCase();
    if (u === "BANDEIRA BRANCA") return "Bandeira branca";
    if (u === "VIBRA") return "Petrobras (Vibra)";
    if (u === "RAIZEN" || u === "RAIZEN MIME") return "Shell (Raízen)";
    if (u === b) return u.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()); // MAIÚSCULAS -> Título
    return b;
  }

  function nomePosto(p) {
    const n = String((p && p.name) || "").trim();
    return n || "Posto sem nome no mapa";
  }

  // [{ chave, rotulo, texto, conhecido }] na ordem de ATRIBUTOS.
  function descreverAtributos(attrs) {
    const a = attrs || {};
    return ATRIBUTOS.map(([chave, rotulo]) => {
      const v = a[chave];
      let texto, conhecido = true;
      if (v === true) texto = "sim";
      else if (v === false) texto = "não";
      else if (typeof v === "string" && v.trim()) texto = v.trim();
      else { texto = "não informado"; conhecido = false; }
      return { chave, rotulo, texto, conhecido };
    });
  }
  // Resumo curto para a lista: conhecidos ("Diesel: sim") e os não informados agrupados.
  function resumoAtributos(attrs) {
    const d = descreverAtributos(attrs);
    return {
      conhecidos: d.filter((x) => x.conhecido && x.chave !== "horario").map((x) => x.rotulo + ": " + x.texto),
      naoInformados: d.filter((x) => !x.conhecido).map((x) => x.rotulo.toLowerCase()),
    };
  }

  function rotuloConfianca(p) {
    if (!p) return "";
    if (p.source === "osm") return "Só no mapa colaborativo (OSM): não encontrado no cadastro da ANP";
    if (p.match_level === "alta") return "Posição do OSM conferida com o cadastro da ANP (confiança alta)";
    if (p.match_level === "media") return "Posição do OSM ligada ao cadastro da ANP pelo nome ou rua (confiança média)";
    if (p.match_level === "baixa") return "Posição provável: único posto da bandeira/cidade (confiança baixa — confira no local)";
    return "Cadastro da ANP";
  }

  // Rota para a API: GeoJSON LineString com no máximo `max` pontos (mantém o primeiro e o último).
  function rotaGeoJSON(coords, max) {
    max = max || MAX_PONTOS_ROTA;
    const c = (coords || []).filter((x) => Array.isArray(x) && isFinite(x[0]) && isFinite(x[1]));
    if (c.length < 2) return null;
    let out = c;
    if (c.length > max) {
      const passo = (c.length - 1) / (max - 1);
      out = [];
      for (let i = 0; i < max; i++) out.push(c[Math.round(i * passo)]);
    }
    return { type: "LineString", coordinates: out.map((x) => [Number(x[0].toFixed(6)), Number(x[1].toFixed(6))]) };
  }

  // Área visível -> busca por raio: centro e meia diagonal × folga (até 50 km). b = { oeste, sul, leste, norte }.
  // A folga (ex.: 1,5) busca um pouco além da tela para não buscar de novo a cada arrastada.
  function buscaDaVista(b, folga) {
    const centro = { lat: (b.sul + b.norte) / 2, lon: (b.oeste + b.leste) / 2 };
    const raio = Math.min(RAIO_MAX_M, Math.ceil(distanciaM(centro, { lat: b.norte, lon: b.leste }) * (folga || 1)));
    return { centro, raio };
  }
  // Precisa buscar de novo? Só se a nova vista sai da área já buscada (com folga) ou ficou bem maior.
  function precisaBuscar(anterior, nova) {
    if (!anterior) return true;
    const d = distanciaM(anterior.centro, nova.centro);
    return d + nova.raio > anterior.raio || nova.raio > anterior.raio * 1.5;
  }

  // GeoJSON dos postos para a camada do mapa.
  function paraGeoJSON(postos) {
    return {
      type: "FeatureCollection",
      features: (postos || []).filter((p) => isFinite(p.lat) && isFinite(p.lon)).map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: { key: p.station_key, fonte: p.source, nome: nomePosto(p) },
      })),
    };
  }


  // ---------------------------------------------------------------- card do posto (R5)
  // Comodidades em ícones. `real` = a API (copiloto_stations_*) traz o atributo; os demais (restaurante, estacionamento de
  // caminhão, borracharia, loja, pernoite, ar/calibrador, wi-fi) a fonte ainda NÃO traz: ficam sempre "sem informação",
  // a não ser que o objeto de atributos passe a trazer a chave (true/false). Nada é inventado.
  const AMENIDADES = [
    ["diesel", "Diesel", "bomba", true],
    ["diesel_caminhao", "Bomba caminhão", "diesel_caminhao", true],
    ["acesso_caminhao", "Acesso de caminhão", "caminhao", true],
    ["arla32", "Arla 32", "arla32", true],
    ["aberto_24h", "24 horas", "h24", true],
    ["banheiro", "Banheiro", "banheiro", true],
    ["banho", "Banho", "banho", true],
    ["gnv", "GNV", "gnv", true],
    ["etanol", "Etanol", "etanol", true],
    ["restaurante", "Restaurante", "restaurante", false],
    ["estacionamento", "Estacionamento de caminhão", "estacionamento", false],
    ["borracharia", "Borracharia", "borracharia", false],
    ["loja", "Loja", "loja", false],
    ["pernoite", "Pernoite", "pernoite", false],
    ["ar", "Ar / calibrador", "ar", false],
    ["wifi", "Wi-Fi", "wifi", false],
  ];
  // [{ chave, rotulo, icone, real, estado: "sim"|"nao"|"?", texto }]
  function descreverAmenidades(attrs) {
    const a = attrs || {};
    return AMENIDADES.map(([chave, rotulo, icone, real]) => {
      const v = a[chave];
      const estado = v === true ? "sim" : v === false ? "nao" : "?";
      return { chave, rotulo, icone, real, estado, texto: estado === "sim" ? "sim" : estado === "nao" ? "não" : "não informado" };
    });
  }
  // Só o que é CONFIRMADO sim (para a linha de ícones da lista).
  function amenidadesSim(attrs) { return descreverAmenidades(attrs).filter((x) => x.estado === "sim"); }

  // Logo genérico por bandeira (iniciais + cor derivada do nome; não usa marca registrada nem imagem).
  function marcaBandeira(brand) {
    const nome = nomeBandeira(brand);
    if (!String(brand || "").trim()) return { iniciais: "?", cor: "#4a5566", nome };
    const limpo = nome.replace(/\(.*?\)/g, " ").trim();
    const palavras = limpo.split(/\s+/).filter(Boolean);
    const iniciais = (palavras.length > 1 ? palavras[0][0] + palavras[1][0] : limpo.slice(0, 2)).toUpperCase();
    let h = 0;
    for (const ch of String(brand).toUpperCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return { iniciais, cor: "hsl(" + h + ",42%,30%)", nome }; // fundo escuro + texto branco: contraste ≥ 7:1
  }

  // Posto mais perto à frente com diesel CONFIRMADO (a lista já vem na ordem do caminho/da distância).
  function proximoComDiesel(lista) {
    return (lista || []).find((p) => p.attributes && (p.attributes.diesel === true || p.attributes.diesel_caminhao === true)) || null;
  }

  // Linha curta (~120 m) em volta do posto, para pedir à API de preço a UF dele (copiloto_route_fuel_price exige uma rota).
  function linhaDoPosto(p) {
    const d = 0.0006;
    return { type: "LineString", coordinates: [[Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))], [Number((p.lon + d).toFixed(6)), Number(p.lat.toFixed(6))]] };
  }
  function formatarDiaMes(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "/" + m[2] : null;
  }
  function formatarReais(v) { return "R$ " + Number(v).toFixed(2).replace(".", ","); }
  // Resposta de copiloto_route_fuel_price (linha do posto) → preço MÉDIO da UF (não é o preço do posto).
  // { ok, uf, preco, semana, texto }. Sem preço da UF: ok false e o motivo.
  function precoDaRegiao(resp, nomeProduto) {
    const u = resp && Array.isArray(resp.ufs) ? resp.ufs.find((x) => x && x.preco != null) : null;
    if (!u || !(Number(u.preco) > 0)) return { ok: false, texto: "sem preço da região" };
    const semana = formatarDiaMes(u.semana_inicio);
    return { ok: true, uf: u.uf, preco: Number(u.preco), semana,
      texto: nomeProduto + " " + formatarReais(u.preco) + "/L · preço médio da região (" + u.uf + ")" + (semana ? ", semana de " + semana : "") };
  }
  // Idade do preço em dias (para avisar quando está velho). null se a semana não veio.
  function diasDesde(iso, agora) {
    const t = Date.parse(String(iso || "").slice(0, 10) + "T12:00:00");
    return isFinite(t) ? Math.max(0, Math.floor(((agora || Date.now()) - t) / 86400000)) : null;
  }
  // Telefone para tel: (só dígitos e +); null se a fonte não trouxe.
  function telefoneLimpo(p) {
    const t = String((p && (p.phone || p.telefone)) || "").replace(/[^\d+]/g, "");
    return t.replace(/\D/g, "").length >= 8 ? t : null;
  }

  // ---------------------------------------------------------------- R6: dados do posto (telefone, horário, data), bandeira em grupos
  // A API (copiloto_stations_*) põe estes campos em `attributes`: telefone, atualizado_em (ISO), horario. Também aceita
  // os nomes soltos (phone/telefone, updated_at, opening_hours) para outras fontes.
  function dadosDoPosto(p) {
    const a = (p && p.attributes) || {};
    const txt = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return {
      telefone: telefoneLimpo({ phone: txt(a.telefone) || (p && (p.phone || p.telefone)) }),
      atualizadoEm: txt(a.atualizado_em) || txt(p && p.updated_at) || null,
      horario: txt(a.horario) || txt(p && p.opening_hours),
    };
  }
  // ISO (ou AAAA-MM-DD) → "dd/mm/aaaa"; null se não vier data válida.
  function formatarData(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return null;
    return m[3] + "/" + m[2] + "/" + m[1];
  }

  // opening_hours do OSM (subconjunto): "24/7", "Mo-Su 06:00-22:00", "Mo-Fr 08:00-12:00,14:00-18:00; Sa 08:00-12:00; Su off",
  // listas de dias ("Mo,We,Fr"), intervalos que viram a noite ("22:00-06:00") e 24:00. Regras mais adiante valem sobre as anteriores
  // nos dias que citam. Feriados (PH/SH) são ignorados. Qualquer sintaxe fora disso (nascer do sol, semanas, meses, comentários)
  // devolve null = desconhecido. Dia que nenhuma regra cita = fechado (padrão do OSM).
  const DIAS_OSM = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const RE_HORA = "\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2}";
  const RE_REGRA = new RegExp("^(?:([A-Za-z][A-Za-z,\\-]*)\\s+)?(" + RE_HORA + "(?:\\s*,\\s*" + RE_HORA + ")*|off|closed)$", "i");
  function minutos(h) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(h.trim());
    if (!m) return null;
    const t = +m[1] * 60 + +m[2];
    return +m[1] <= 24 && +m[2] < 60 && t <= 1440 ? t : null;
  }
  function diasDaRegra(txt) {
    if (!txt) return DIAS_OSM.map((_, i) => i);
    const out = [];
    for (const parte of txt.split(",")) {
      if (/^(PH|SH)$/i.test(parte)) continue;
      const m = /^([A-Za-z]{2})(?:-([A-Za-z]{2}))?$/.exec(parte);
      if (!m) return null;
      const norm = (x) => DIAS_OSM.findIndex((d) => d.toLowerCase() === x.toLowerCase());
      const a = norm(m[1]), b = m[2] ? norm(m[2]) : a;
      if (a < 0 || b < 0) return null;
      for (let i = a; ; i = (i + 1) % 7) { out.push(i); if (i === b) break; }
    }
    return out;
  }
  // → null (não entendi) | { semana: [ [ [ini,fim],... ] x 7 ] } (segunda = 0), "24/7" vira todos os dias 0–1440.
  function lerHorario(texto) {
    const t = String(texto || "").trim();
    if (!t || t.length > 300) return null;
    if (/^24\/7$/i.test(t)) return { semana: DIAS_OSM.map(() => [[0, 1440]]) };
    const semana = DIAS_OSM.map(() => []);
    let algum = false;
    for (const regra of t.split(";").map((x) => x.trim()).filter(Boolean)) {
      const m = RE_REGRA.exec(regra);
      if (!m) return null;
      const dias = diasDaRegra(m[1]);
      if (dias === null) return null;
      let faixas = [];
      if (!/^(off|closed)$/i.test(m[2])) {
        for (const f of m[2].split(",")) {
          const [i, j] = f.split("-").map(minutos);
          if (i == null || j == null || i === j) return null;
          faixas.push([i, j]);
        }
      }
      if (!dias.length) continue;   // regra só de feriado
      algum = true;
      for (const d of dias) semana[d] = faixas.slice();
    }
    return algum ? { semana } : null;
  }
  // true | false | null (horário ausente ou que não sei ler). `agora` = Date (hora local do aparelho).
  function abertoAgora(texto, agora) {
    const h = lerHorario(texto);
    if (!h) return null;
    const d = agora instanceof Date ? agora : new Date(agora == null ? Date.now() : agora);
    if (isNaN(d.getTime())) return null;
    const dia = (d.getDay() + 6) % 7, min = d.getHours() * 60 + d.getMinutes();
    for (const [i, j] of h.semana[dia]) {
      if (i < j ? min >= i && min < j : min >= i) return true;          // i > j: vira a noite, a ponta de hoje
    }
    for (const [i, j] of h.semana[(dia + 6) % 7]) if (i > j && min < j) return true; // a ponta de ontem que cai hoje
    return false;
  }
  // Considera o atributo 24 h confirmado (true) e depois o horário. false (não é 24 h) não decide nada.
  function abertoAgoraDoPosto(p, agora) {
    const a = (p && p.attributes) || {};
    if (a.aberto_24h === true) return true;
    return abertoAgora(dadosDoPosto(p).horario, agora);
  }
  // { estado: "aberto"|"fechado"|"?", icone, texto } para o selo verde / vermelho / cinza
  function situacaoAbertura(p, agora) {
    const v = abertoAgoraDoPosto(p, agora);
    if (v === true) return { estado: "aberto", icone: "ok", texto: "Aberto agora" };
    if (v === false) return { estado: "fechado", icone: "fechar", texto: "Fechado agora" };
    return { estado: "?", icone: "ajuda", texto: "Horário não informado" };
  }

  // Bandeira em grupos para o filtro: ipiranga, shell (Raízen), petrobras (BR/Vibra), ale, outras (inclui bandeira branca e sem bandeira).
  const GRUPOS_BANDEIRA = [["ipiranga", "Ipiranga"], ["shell", "Shell"], ["petrobras", "Petrobras / BR"], ["ale", "Ale"], ["outras", "Outras"]];
  function grupoBandeira(brand) {
    const u = String(brand || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
    if (!u || u === "BANDEIRA BRANCA") return "outras";
    if (/^IPIRANGA\b/.test(u)) return "ipiranga";
    if (/^(SHELL|RAIZEN)\b/.test(u)) return "shell";
    if (/^(PETROBRAS|VIBRA|BR)\b/.test(u)) return "petrobras";
    if (/^ALE\b/.test(u)) return "ale";
    return "outras";
  }

  // Confiança em estrelas (1 a 3) a partir do mesmo critério do texto de rotuloConfianca.
  function estrelasConfianca(p) {
    if (!p) return 0;
    if (p.source === "osm") return 1;
    if (p.match_level === "alta") return 3;
    if (p.match_level === "media") return 2;
    if (p.match_level === "baixa") return 1;
    return 3; // cadastro ANP sem OSM: dado oficial
  }
  // Desvio estimado ida e volta da pista até o posto, em minutos (~40 km/h); null se for menos de 1 min ou se não vier a distância.
  function desvioMin(p) {
    const m = p && p.off_route_m;
    if (m == null || !isFinite(m)) return null;
    const min = Math.round((2 * m) / 667);
    return min >= 1 ? min : null;
  }


  const api = {
    CONE_GRAUS, ZOOM_MINIMO, RAIO_MAX_M, MAX_PONTOS_ROTA, ATRIBUTOS, ROTULO,
    distanciaM, rumoGraus, difAngulo, aFrentePorRumo, naRota, filtrar, formatarDistancia, nomeBandeira, nomePosto,
    descreverAtributos, resumoAtributos, AMENIDADES, descreverAmenidades, amenidadesSim, marcaBandeira, proximoComDiesel, linhaDoPosto, precoDaRegiao, formatarDiaMes, formatarReais, diasDesde, telefoneLimpo, rotuloConfianca, rotaGeoJSON, dadosDoPosto, formatarData, lerHorario, abertoAgora, abertoAgoraDoPosto, situacaoAbertura, GRUPOS_BANDEIRA, grupoBandeira, estrelasConfianca, desvioMin, buscaDaVista, precisaBuscar, paraGeoJSON,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoPostos = api;
})(typeof window !== "undefined" ? window : globalThis);
