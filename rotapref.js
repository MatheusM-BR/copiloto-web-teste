// Rota, rodada 6 (lógica pura, sem DOM; testada em tests/rotapref.test.js). Cinco assuntos:
//  1. Preferências de rota ("Sem pedágio", "Sem balsa", "Sem estrada de terra"): normalizar, o que o servidor suporta (versão do
//     Valhalla em /status), diferença para a rota normal em tempo, distância e custo, e o aviso honesto quando o servidor não
//     conseguiu evitar (a resposta ainda traz pedágio/balsa/terra).
//  2. Selo "compatível" por rota: pelo resultado das restrições do banco (CopilotoDados.resumoRestricoes). Só vale para o que o
//     mapa (OSM) cadastra: ausência de restrição NÃO prova que a passagem é livre; o texto diz "no mapa".
//  3. Paradas intermediárias (postos no trajeto): lista curta sem repetição, marco de cada parada na rota, o que já foi
//     passado, e o desvio estimado em minutos (ida e volta pelo acesso, a 30 km/h; é estimativa, o texto diz "≈").
//  4. Câmera na manobra: fator 0–1 pela distância da manobra, suavização por passo (sem tremer) e preferência guardada.
//  5. Faixas e saída: lê as faixas (turn_lanes do /trace_attributes) e a saída (sign da manobra do /route); sem dado, null.
(function (raiz) {
  "use strict";

  // ------------------------------------------------------------ 1. preferências
  const CHAVE_PREFS = "copiloto.rota.prefs.v1";
  const PREFS = [
    { id: "semPedagio", rotulo: "Sem pedágio", icone: "pedagio", longo: "Evitar pedágio", evitando: "pedágio" },
    { id: "semBalsa", rotulo: "Sem balsa", icone: "balsa", longo: "Evitar balsa", evitando: "balsa" },
    { id: "semTerra", rotulo: "Sem estrada de terra", icone: "terra", longo: "Evitar estrada de terra", evitando: "estrada de terra" },
  ];
  const IDS = PREFS.map((p) => p.id);

  function normalizarPrefs(o) {
    const r = {};
    for (const id of IDS) r[id] = !!(o && o[id] === true);
    return r;
  }
  function algumaAtiva(prefs) { return IDS.some((id) => prefs && prefs[id] === true); }

  // Versão do Valhalla em /status ({ version: "3.9.1-2085e78" }) → [maior, menor] ou null.
  function versaoDoStatus(json) {
    const m = json && typeof json.version === "string" ? /^(\d+)\.(\d+)/.exec(json.version) : null;
    return m ? [Number(m[1]), Number(m[2])] : null;
  }
  // O que o servidor aceita. use_tolls e use_ferry existem desde a série 3.0; exclude_unpaved desde a 3.4. Sem a versão
  // (offline, servidor sem /status, servidor próprio): pedágio e balsa aparecem, "terra" fica escondido (não dá para provar).
  function suporteDoStatus(json) {
    const v = versaoDoStatus(json);
    if (!v) return { semPedagio: true, semBalsa: true, semTerra: false, conhecido: false, versao: null };
    const maior = v[0] > 3 || (v[0] === 3 && v[1] >= 4);
    return { semPedagio: true, semBalsa: true, semTerra: maior, conhecido: true, versao: v.join(".") };
  }
  function urlStatus(urlRota) { return String(urlRota || "").replace(/\/route\/?$/, "/status"); }
  // Só as preferências ligadas E suportadas
  function efetivas(prefs, suporte) {
    const p = normalizarPrefs(prefs), s = suporte || {};
    const r = {};
    for (const id of IDS) r[id] = p[id] && s[id] !== false && (id !== "semTerra" || s.semTerra === true);
    return r;
  }
  function rotulosAtivos(prefs) { return PREFS.filter((p) => prefs && prefs[p.id] === true).map((p) => p.evitando); }

  function sinal(n, un, casas) {
    const a = Math.abs(n), t = (casas ? a.toFixed(casas) : String(Math.round(a))).replace(".", ",");
    return (n < 0 ? "−" : "+") + t + (un ? " " + un : "");
  }
  function minutosTexto(m) {
    const a = Math.abs(m);
    if (a < 60) return sinal(m, "min");
    const h = Math.floor(a / 60), r = a % 60;
    return (m < 0 ? "−" : "+") + h + " h" + (r ? " " + String(r).padStart(2, "0") + " min" : "");
  }
  function reais(v) { return "R$ " + Math.abs(v).toFixed(2).replace(".", ","); }

  // base e nova: { minutos, km }; custoBase / custoNovo: total em reais ou null (desconhecido)
  function diferenca(base, nova, custoBase, custoNovo) {
    if (!base || !nova) return null;
    const minutos = Math.round(nova.minutos - base.minutos), km = Math.round((nova.km - base.km) * 10) / 10;
    const custo = isFinite(custoBase) && isFinite(custoNovo) && custoBase != null && custoNovo != null ? Math.round((custoNovo - custoBase) * 100) / 100 : null;
    const igual = Math.abs(minutos) < 1 && Math.abs(km) < 0.5;
    return { minutos, km, custo, igual };
  }
  // "+18 min · +12,3 km · custo −R$ 45,00" (ou "Mesmo caminho da rota normal.")
  function textoDiferenca(dif) {
    if (!dif) return "";
    if (dif.igual) return "Mesmo caminho da rota normal." + (dif.custo != null && Math.abs(dif.custo) >= 0.01 ? " Custo " + (dif.custo < 0 ? "−" : "+") + reais(dif.custo) + "." : "");
    const partes = [minutosTexto(dif.minutos), sinal(dif.km, "km", 1)];
    if (dif.custo != null && Math.abs(dif.custo) >= 0.01) partes.push("custo " + (dif.custo < 0 ? "−" : "+") + reais(dif.custo));
    return partes.join(" · ");
  }
  // Avisos do que o servidor NÃO conseguiu evitar (c = Alt.caracteristicas da rota nova). Campo desconhecido não avisa.
  function avisosNaoEvitou(prefs, c) {
    const a = [];
    if (!prefs || !c) return a;
    if (prefs.semPedagio && c.pedagio === true) a.push("Não deu para evitar todo o pedágio nesta região.");
    if (prefs.semBalsa && c.balsa === true) a.push("Não deu para evitar a balsa: não há outro caminho para este destino.");
    if (prefs.semTerra && c.terra === true) a.push("Ainda há trecho de terra: não achei outro caminho pavimentado.");
    return a;
  }

  // ------------------------------------------------------------ 2. selo "compatível com o caminhão"
  // resumo: CopilotoDados.resumoRestricoes (ou null = ainda não sei); erro: a consulta falhou. veiculoCaminhao: o perfil é caminhão.
  // Devolve { estado: "ok" | "viola" | "condicional" | "pendente" | "indisponivel" | "carro", texto, aria }.
  function seloCompat(resumo, opcoes) {
    const o = opcoes || {};
    if (o.veiculoCaminhao === false) return { estado: "carro", texto: "", aria: "" };
    if (o.erro) return { estado: "indisponivel", texto: "Restrições: sem conferir", aria: "Não foi possível conferir as restrições desta rota agora." };
    if (!resumo) return { estado: "pendente", texto: "Conferindo…", aria: "Conferindo as restrições desta rota." };
    const nv = (resumo.violadas || []).length, nc = (resumo.condicionais || []).length;
    if (nv) return { estado: "viola", texto: nv + (nv === 1 ? " restrição" : " restrições"), aria: "Atenção: " + nv + (nv === 1 ? " restrição" : " restrições") + " que o seu caminhão não passa, pelo mapa." };
    if (nc) return { estado: "condicional", texto: "Confira " + nc + (nc === 1 ? " limite" : " limites"), aria: "Compatível, mas confira " + nc + (nc === 1 ? " limite condicional" : " limites condicionais") + "." };
    return { estado: "ok", texto: "compatível", aria: "Compatível com o seu caminhão: nenhuma restrição cadastrada no mapa que ele não passe. O mapa pode estar incompleto." };
  }

  // ------------------------------------------------------------ 3. paradas intermediárias
  const MAX_PARADAS = 3, IGUAL_M = 40, VEL_ACESSO_MS = 30 / 3.6;
  const RAD = Math.PI / 180;
  function distM(a, b) { // { lat, lon }
    const R = 6371008.8, dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function normalizarParada(p) {
    if (!p || !isFinite(p.lat) || !isFinite(p.lon)) return null;
    const r = { lat: Number(p.lat), lon: Number(p.lon), rotulo: p.rotulo ? String(p.rotulo) : null };
    if (isFinite(p.alongM) && p.alongM != null) r.alongM = Number(p.alongM);
    return r;
  }
  // Acrescenta uma parada (sem repetir a mesma, no máximo 3; a lista segue a ordem ao longo da rota quando se sabe).
  function adicionarParada(lista, nova) {
    const n = normalizarParada(nova);
    const base = (lista || []).filter((x) => x);
    if (!n) return base;
    if (base.some((x) => distM(x, n) < IGUAL_M)) return base;
    const out = base.concat([n]);
    if (out.every((x) => x.alongM != null)) out.sort((a, b) => a.alongM - b.alongM);
    return out.slice(-MAX_PARADAS);
  }
  // Distância (m) ao longo da rota até o fim de cada perna (as paradas), dado o desenho [lon, lat] e quantos pontos tem cada perna.
  function marcosDasParadas(coords, pontosPorPerna) {
    const out = [];
    if (!Array.isArray(coords) || !Array.isArray(pontosPorPerna)) return out;
    const acum = [0];
    for (let i = 1; i < coords.length; i++) acum.push(acum[i - 1] + distM({ lat: coords[i - 1][1], lon: coords[i - 1][0] }, { lat: coords[i][1], lon: coords[i][0] }));
    let fim = 0;
    for (let k = 0; k < pontosPorPerna.length - 1; k++) {
      fim += pontosPorPerna[k];
      const i = Math.min(coords.length - 1, Math.max(0, fim - 1));
      out.push(Math.round(acum[i]));
    }
    return out;
  }
  // Paradas que ainda faltam: tira as que o caminhão já alcançou (progresso ≥ marco − folga).
  function aindaFaltam(paradas, marcosM, progressoM, folgaM) {
    const f = folgaM == null ? 60 : folgaM;
    if (!Array.isArray(paradas) || !Array.isArray(marcosM) || marcosM.length !== paradas.length || !isFinite(progressoM)) return paradas || [];
    return paradas.filter((p, i) => progressoM < marcosM[i] - f);
  }
  // Desvio estimado de um posto a off_route_m da pista: ida e volta pelo acesso a 30 km/h. Nunca diz "0 min" para o que não é
  // exatamente na pista: abaixo de 1 min é "na pista". Devolve { min, texto, aria } ou null sem a distância.
  function desvioPosto(offRouteM) {
    if (offRouteM == null || !isFinite(offRouteM) || offRouteM < 0) return null;
    const min = Math.ceil(2 * offRouteM / VEL_ACESSO_MS / 60 - 1e-9);
    if (offRouteM < 60 || min < 1) return { min: 0, texto: "na pista", aria: "Fica na pista, sem desvio." };
    return { min, texto: "≈ +" + min + " min", aria: "Desvio estimado de cerca de " + min + (min === 1 ? " minuto" : " minutos") + " (ida e volta pelo acesso)." };
  }
  // Postos da rota (resposta de stations_along_route) na ordem ao longo do caminho, só os à frente.
  function ordenarAoLongo(postos) {
    return (postos || []).filter((p) => p && p.along_route_m != null && p.along_route_m > 0)
      .sort((a, b) => a.along_route_m - b.along_route_m || String(a.station_key).localeCompare(String(b.station_key)));
  }

  // ------------------------------------------------------------ 4. câmera na manobra
  // Padrão LIGADO e bem visível: a < distM da manobra (mais longe quanto mais rápido, e mais ainda de caminhão) a câmera vai até
  // o zoom `zoom` (17,5 ≈ o cruzamento inteiro na tela; nunca menos que +zoomExtra sobre o zoom normal da velocidade) e inclina
  // até `pitch`; depois da manobra o fator volta a 0 e a câmera desce sozinha.
  const CHAVE_CAMERA = "copiloto.camera.manobra.v1";
  const CAMERA_PADRAO = { ligado: true, distM: 400, zoom: 17.5, zoomExtra: 1, pitch: 58 };
  const ANTECIPA_S = { carro: 15, caminhao: 22 }, DIST_MAX_M = 700;
  function configCamera(o) {
    const c = Object.assign({}, CAMERA_PADRAO);
    if (o && typeof o === "object") {
      if (typeof o.ligado === "boolean") c.ligado = o.ligado;
      if (isFinite(o.distM) && o.distM >= 100 && o.distM <= 600) c.distM = Number(o.distM);
      if (isFinite(o.zoom) && o.zoom >= 15 && o.zoom <= 19) c.zoom = Number(o.zoom);
      if (isFinite(o.zoomExtra) && o.zoomExtra >= 0 && o.zoomExtra <= 2.5) c.zoomExtra = Number(o.zoomExtra);
      if (isFinite(o.pitch) && o.pitch >= 30 && o.pitch <= 70) c.pitch = Number(o.pitch);
    }
    return c;
  }
  // A que distância da manobra a câmera começa: distM no mínimo; em velocidade, ~15 s (carro) ou ~22 s (caminhão, que freia e muda
  // de faixa mais devagar) de antecedência, até 700 m. velMs ausente → distM.
  function distanciaCamera(velMs, cfg, caminhao) {
    const c = cfg || CAMERA_PADRAO;
    if (!(velMs > 0) || !isFinite(velMs)) return c.distM;
    return Math.min(DIST_MAX_M, Math.max(c.distM, velMs * (caminhao ? ANTECIPA_S.caminhao : ANTECIPA_S.carro)));
  }
  // 0 longe da manobra; sobe de 0 a 1 entre a distância da câmera e 60% dela (curva suave); 1 daí até a manobra
  function fatorManobra(manobraM, cfg, velMs, caminhao) {
    const c = cfg || CAMERA_PADRAO;
    if (!c.ligado || manobraM == null || !isFinite(manobraM) || manobraM < 0) return 0;
    const d = distanciaCamera(velMs, c, caminhao);
    if (manobraM >= d) return 0;
    const t = Math.min(1, (d - manobraM) / (d * 0.4));
    return t * t * (3 - 2 * t);
  }
  // Anda do valor atual ao alvo no máximo "passo" por chamada (uma leitura de GPS): zoom e inclinação nunca dão salto.
  function suavizar(atual, alvo, passo) {
    if (atual == null || !isFinite(atual)) return alvo;
    const d = alvo - atual;
    return Math.abs(d) <= passo ? alvo : atual + Math.sign(d) * passo;
  }
  // quanto somar ao zoom normal (base) para chegar ao zoom da manobra: pelo menos zoomExtra, e até cfg.zoom
  function zoomExtraPara(zoomBase, cfg) {
    const c = cfg || CAMERA_PADRAO;
    return Math.max(c.zoomExtra, c.zoom - (isFinite(zoomBase) ? zoomBase : 0));
  }
  // zoom e inclinação para um fator 0–1; base: o que a câmera usaria sem a manobra
  function alvoCamera(base, fator, cfg) {
    const c = cfg || CAMERA_PADRAO;
    return { zoom: base.zoom + zoomExtraPara(base.zoom, c) * fator, pitch: base.pitch + (Math.max(base.pitch, c.pitch) - base.pitch) * fator };
  }

  // ------------------------------------------------------------ 5. faixas e saída
  // Bits do Valhalla (baldr/turnlanes.h): 1 nenhuma, 2 em frente, 4 curva fechada à esquerda, 8 esquerda, 16 leve esquerda,
  // 32 leve direita, 64 direita, 128 curva fechada à direita, 256 retorno, 512 junta à esquerda, 1024 junta à direita.
  const BITS = [[2, "frente"], [4, "esq_forte"], [8, "esquerda"], [16, "esq_leve"], [32, "dir_leve"], [64, "direita"], [128, "dir_forte"], [256, "retorno"], [512, "junta_esq"], [1024, "junta_dir"]];
  const NOMES = { through: "frente", straight: "frente", left: "esquerda", right: "direita", slight_left: "esq_leve", slight_right: "dir_leve",
    sharp_left: "esq_forte", sharp_right: "dir_forte", reverse: "retorno", merge_to_left: "junta_esq", merge_to_right: "junta_dir", none: null, frente: "frente",
    esquerda: "esquerda", direita: "direita" };
  const GLIFO = { frente: "↑", esquerda: "←", direita: "→", esq_leve: "↖", dir_leve: "↗", esq_forte: "↩", dir_forte: "↪", retorno: "↶", junta_esq: "↖", junta_dir: "↗" };
  const FALA = { frente: "em frente", esquerda: "à esquerda", direita: "à direita", esq_leve: "levemente à esquerda", dir_leve: "levemente à direita",
    esq_forte: "curva fechada à esquerda", dir_forte: "curva fechada à direita", retorno: "retorno", junta_esq: "junção à esquerda", junta_dir: "junção à direita" };

  function direcoes(v) {
    if (v == null) return [];
    if (typeof v === "number") return BITS.filter(([b]) => (v & b) !== 0).map(([, n]) => n);
    const lista = Array.isArray(v) ? v : String(v).split(/[;|,]/);
    const out = [];
    for (const t of lista) {
      const n = NOMES[String(t).trim().toLowerCase().replace(/[\s-]+/g, "_")];
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  }
  // Uma faixa: { directions, valid, active } (cada um: máscara numérica, lista ou "a;b"). Sem direção conhecida → null.
  function faixa(l) {
    if (!l || typeof l !== "object") return null;
    const dirs = direcoes(l.directions != null ? l.directions : l.directions_mask);
    if (!dirs.length) return null;
    const val = l.valid != null ? direcoes(l.valid) : null, at = l.active != null ? direcoes(l.active) : null;
    return { direcoes: dirs, valida: val ? val.length > 0 : false, indicada: at ? at.length > 0 : false };
  }
  // Resposta do /trace_attributes → [{ fim: end_shape_index da aresta, faixas: [...] }] só com aresta que tem faixas lidas.
  function lerFaixas(json) {
    const out = [];
    for (const e of (json && Array.isArray(json.edges) ? json.edges : [])) {
      if (!e || !Array.isArray(e.turn_lanes) || !e.turn_lanes.length) continue;
      const faixas = e.turn_lanes.map(faixa).filter(Boolean);
      if (!faixas.length || !isFinite(e.end_shape_index)) continue;
      out.push({ fim: Number(e.end_shape_index), faixas });
    }
    return out;
  }
  // Faixas da aresta que termina na manobra (indice_forma da manobra, ±1 ponto). Sem dado: null.
  function faixasDaManobra(lidas, indiceForma) {
    if (!Array.isArray(lidas) || !isFinite(indiceForma)) return null;
    const e = lidas.find((x) => Math.abs(x.fim - indiceForma) <= 1);
    return e ? e.faixas : null;
  }
  function textoFaixas(faixas) {
    if (!faixas || !faixas.length) return "";
    const todas = faixas.map((f, i) => ({ f, i }));
    const ind = todas.filter((x) => x.f.indicada), val = todas.filter((x) => x.f.valida);
    const quais = ind.length && ind.length < faixas.length ? ind : val.length && val.length < faixas.length ? val : [];
    if (!quais.length) return faixas.length + (faixas.length === 1 ? " faixa." : " faixas.");
    return "Use a faixa " + quais.map((x) => (x.i + 1) + "ª").join(" ou ") + " da esquerda para a direita, " + FALA[quais[0].f.direcoes[0]] + ".";
  }
  // Direção da manobra (tipo do Valhalla) → "esquerda" | "direita" | "frente" | "retorno" | null (destino, início…)
  function direcaoDoTipo(tipo) {
    if ([9, 10, 11, 18, 20, 23].includes(tipo)) return "direita";
    if ([14, 15, 16, 19, 21, 24].includes(tipo)) return "esquerda";
    if ([12, 13].includes(tipo)) return "retorno";
    if ([8, 17, 22].includes(tipo)) return "frente";
    return null;
  }
  const FAMILIA = { direita: ["direita", "dir_leve", "dir_forte", "junta_dir"], esquerda: ["esquerda", "esq_leve", "esq_forte", "junta_esq"], frente: ["frente"], retorno: ["retorno"] };
  // Faixas a partir do texto OSM `turn:lanes` ("left|through|through;right": faixas separadas por "|", opções por ";"; vazio e
  // "none" = em frente). `manobra` ("esquerda" | "direita" | "frente" | "retorno") marca como válidas as faixas que levam a ela.
  // Texto vazio, sem faixa, ou com valor desconhecido em TODAS as faixas → null (nada inventado).
  function faixasDeOsm(texto, manobra) {
    if (typeof texto !== "string" || !texto.trim()) return null;
    const partes = texto.split("|");
    if (partes.length < 2 || partes.length > 8) return null;
    const alvo = FAMILIA[manobra] || null;
    const out = [];
    for (const p of partes) {
      const t = p.trim().toLowerCase();
      const dirs = t === "" || t === "none" ? ["frente"] : direcoes(t);
      if (!dirs.length) return null; // valor que não entendemos: melhor não desenhar do que desenhar errado
      out.push({ direcoes: dirs, valida: !!alvo && dirs.some((d) => alvo.includes(d)), indicada: false });
    }
    return out;
  }
  const NUM = ["", "uma", "duas", "três", "quatro", "cinco", "seis", "sete", "oito"];
  // Frase falada: "Use as duas faixas da direita." / "Use a faixa da esquerda." / "Use a 2ª faixa da esquerda para a direita."
  // Só com 2+ faixas e uma indicação que NÃO seja todas as faixas; senão "" (a voz não diz nada).
  function falaFaixas(faixas) {
    if (!faixas || faixas.length < 2) return "";
    const n = faixas.length;
    const ind = faixas.map((f, i) => (f.indicada ? i : -1)).filter((i) => i >= 0), val = faixas.map((f, i) => (f.valida ? i : -1)).filter((i) => i >= 0);
    const q = ind.length && ind.length < n ? ind : val.length && val.length < n ? val : [];
    if (!q.length) return "";
    const k = q.length, contigua = q[k - 1] - q[0] === k - 1;
    if (contigua && q[k - 1] === n - 1) return k === 1 ? "Use a faixa da direita." : "Use as " + NUM[k] + " faixas da direita.";
    if (contigua && q[0] === 0) return k === 1 ? "Use a faixa da esquerda." : "Use as " + NUM[k] + " faixas da esquerda.";
    if (contigua && k === 1) return "Use a " + (q[0] + 1) + "ª faixa a partir da esquerda.";
    return "Use as faixas " + q.map((i) => i + 1).join(", ").replace(/, (\d+)$/, " e $1") + ", a partir da esquerda.";
  }
  // Saída da manobra do /route: sign.exit_number_elements / exit_name_elements / exit_branch / exit_toward. Sem nada: null.
  function lerSaida(sign) {
    if (!sign || typeof sign !== "object") return null;
    const txt = (l) => (Array.isArray(l) ? l.map((x) => String(x && x.text || "").trim()).filter(Boolean) : []);
    const numero = txt(sign.exit_number_elements)[0] || null;
    const nome = txt(sign.exit_name_elements)[0] || null;
    const ramo = txt(sign.exit_branch_elements)[0] || null;
    const sentido = txt(sign.exit_toward_elements).slice(0, 3);
    if (!numero && !nome) return null;
    // referência de saída de rodovia brasileira costuma ser o km: número (com letra opcional) vira "Saída km 93"
    const rotulo = numero ? (/^\d+[A-Za-z]?$/.test(numero) ? "Saída km " + numero : "Saída " + numero) : "Saída " + nome;
    return { numero, nome, ramo, sentido, rotulo, detalhe: [ramo, sentido.length ? "→ " + sentido.join(" / ") : null].filter(Boolean).join(" ") };
  }

  const api = { CHAVE_PREFS, PREFS, IDS, normalizarPrefs, algumaAtiva, versaoDoStatus, suporteDoStatus, urlStatus, efetivas, rotulosAtivos,
    diferenca, textoDiferenca, avisosNaoEvitou, seloCompat,
    MAX_PARADAS, distM, normalizarParada, adicionarParada, marcosDasParadas, aindaFaltam, desvioPosto, ordenarAoLongo,
    CHAVE_CAMERA, CAMERA_PADRAO, configCamera, distanciaCamera, fatorManobra, suavizar, zoomExtraPara, alvoCamera,
    faixasDeOsm, direcaoDoTipo, falaFaixas,
    direcoes, faixa, lerFaixas, faixasDaManobra, textoFaixas, lerSaida, GLIFO, FALA };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoRotaPref = api;
})(typeof window !== "undefined" ? window : globalThis);
