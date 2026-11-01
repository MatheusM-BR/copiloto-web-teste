// Navegação guiada (pacote E1): lógica pura, sem DOM. Testada no Node (tests/navegacao.test.js).
// - projeção do GPS na linha da rota (rumo considerado) e rastreador do progresso (A1: ignora leitura imprecisa,
//   confirma salto grande com 2 leituras, aceita recuo de até 200 m quando leituras boas discordam);
// - manobras do Valhalla (instruções pt-BR) com posição em metros na rota;
// - detecção de saída da rota com tolerância a ruído; limite de recálculo;
// - quando falar cada manobra conforme a velocidade, sem repetir;
// - formatação (distância, duração, hora de chegada "sem trânsito");
// - peso para a rota (carregado/vazio) sem inventar: o que não foi informado vai sem peso e com aviso;
// - registro da viagem pelo GPS (resumo pós-viagem, PRD 17.1), viagens e destinos recentes;
// - rota offline: volta pela mesma rota (desenho invertido, sem inventar manobras), ponto de reentrada à frente,
//   conferência com a internet (quando e se a rota nova difere) e a faixa "Rota offline · conferida …".
(function (raiz) {
  "use strict";

  const RotaLib = typeof module !== "undefined" && module.exports ? require("./rota.js") : raiz.CopilotoRota;
  const VozLib = typeof module !== "undefined" && module.exports ? require("./voz.js") : raiz.CopilotoVoz;

  const CHAVE = "copiloto.nav.v1";
  const R = 6371008.8;
  const RAD = Math.PI / 180;
  const M_POR_GRAU = R * RAD;

  // ------------------------------------------------------------ geometria
  function distanciaM(a, b) { // a, b: { lat, lon }
    const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  const ponto = (c) => ({ lon: c[0], lat: c[1] });
  function difAngulo(a, b) { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; }

  // coords: [[lon, lat], ...] (como rota.js devolve). Junta pontos repetidos sem perder o índice original.
  function prepararGeometria(coords) {
    const acum = [0];
    for (let i = 1; i < coords.length; i++) acum.push(acum[i - 1] + distanciaM(ponto(coords[i - 1]), ponto(coords[i])));
    return { coords, acum, total: acum[acum.length - 1] || 0 };
  }

  // Segmento (índice do ponto inicial) que contém o progresso em metros.
  function segmentoDoProgresso(geo, progresso) {
    const a = geo.acum; let lo = 0, hi = a.length - 1;
    if (hi <= 0) return 0;
    if (progresso >= a[hi]) return hi - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= progresso) lo = m; else hi = m; }
    return lo;
  }

  // Projeta a posição na rota.
  // pos: { lat, lon }. op: { progresso (anterior, m), rumo (graus ou null), janelaM (quanto à frente procurar),
  //   dtS (s desde a leitura anterior), velMs (m/s; sem ela, vale VEL_MAX_MS) }.
  // Com progresso anterior, procura só na janela à frente dele. Se o veículo pode ter andado mais que a janela desde a
  // leitura anterior (dtS × velocidade: GPS voltando de um túnel ou de um tempo sem sinal), procura na linha inteira:
  // senão a posição certa, lá na frente, pareceria "fora da rota".
  // Devolve { progresso_m (nunca menor que o anterior), ao_longo_m (projeção pura), distancia_m (à linha), indice, ponto }.
  const VEL_MAX_MS = 33; // ~120 km/h: limite para quando a velocidade não é conhecida
  function alcancePossivelM(dtS, velMs) {
    if (typeof dtS !== "number" || !isFinite(dtS) || dtS <= 0) return 0;
    // velocidade conhecida, mesmo 0 (parado na fila: A1 do QA 3), vale no mínimo 5 m/s; desconhecida, o limite
    const v = typeof velMs === "number" && isFinite(velMs) && velMs >= 0 ? Math.max(velMs, 5) : VEL_MAX_MS;
    return dtS * v * 1.25 + 100;
  }
  // op.recuoM (padrão 50): quanto atrás do progresso anterior ainda procurar.
  function projetar(geo, pos, op) {
    const o = op || {};
    const ant = typeof o.progresso === "number" && isFinite(o.progresso) ? o.progresso : null;
    const janela = o.janelaM == null ? 3000 : o.janelaM;
    const recuo = o.recuoM == null ? 50 : o.recuoM;
    const buscaCompleta = alcancePossivelM(o.dtS, o.velMs) > janela;
    const kx = Math.cos(pos.lat * RAD) * M_POR_GRAU, ky = M_POR_GRAU;
    const rumo = typeof o.rumo === "number" && isFinite(o.rumo) ? o.rumo : null;
    function procurar(restrito) {
      let melhor = null;
      for (let i = 0; i < geo.coords.length - 1; i++) {
        if (restrito && (geo.acum[i + 1] < ant - recuo || geo.acum[i] > ant + janela)) continue;
        const a = geo.coords[i], b = geo.coords[i + 1];
        const ax = (a[0] - pos.lon) * kx, ay = (a[1] - pos.lat) * ky;
        const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        const px = ax + t * dx, py = ay + t * dy;
        const d = Math.hypot(px, py);
        let custo = d;
        // trecho no sentido contrário ao rumo (ida e volta paralelas, retorno): penaliza
        if (rumo != null && l2 > 1) {
          const rumoSeg = (Math.atan2(dx, dy) / RAD + 360) % 360;
          if (difAngulo(rumo, rumoSeg) > 90) custo += 100;
        }
        if (!melhor || custo < melhor.custo) {
          melhor = { custo, distancia_m: d, ao_longo_m: geo.acum[i] + t * (geo.acum[i + 1] - geo.acum[i]),
            ponto: [pos.lon + px / kx, pos.lat + py / ky] };
        }
      }
      return melhor;
    }
    let m = ant != null && !buscaCompleta ? procurar(true) : null;
    if (!m) m = procurar(false);
    if (!m) return { progresso_m: ant || 0, ao_longo_m: 0, distancia_m: Infinity, indice: 0, ponto: null };
    const progresso = ant == null ? m.ao_longo_m : Math.max(ant, m.ao_longo_m);
    return { progresso_m: progresso, ao_longo_m: m.ao_longo_m, distancia_m: m.distancia_m,
      indice: segmentoDoProgresso(geo, progresso), ponto: m.ponto };
  }

  // ------------------------------------------------------------ rastreador do progresso (A1)
  // Uma leitura ruim não pode mover o progresso para sempre (antes ele só avançava: um reflexo de 150 m depois da curva
  // pulava a manobra, e as leituras boas seguintes, ainda antes da curva, pareciam "fora da rota").
  // - precisão > PRECISAO_MAX_M: não mexe no progresso e não conta para desvio nem chegada;
  // - avanço maior que o possível (velocidade × tempo desde a última leitura aceita, com margem: alcancePossivelM):
  //   fica pendente; só vale se a leitura seguinte confirmar (também à frente). Com tempo longo sem leitura (túnel, M6)
  //   o possível é grande e o salto vale na hora;
  // - parado ou quase (velocidade conhecida < PARADO_MS) e sem rumo (QA 3, A1: fila em frente ao destino na pista
  //   dupla, o ruído joga a posição na pista oposta): avanço maior que SALTO_PARADO_M não vale, nem confirmado. Sem
  //   rumo, a projeção não sabe de que lado da pista o caminhão está; ele volta a valer quando o caminhão andar;
  // - saltou: true na leitura em que um salto pendente foi confirmado. A chegada não se declara nela (QA 3, A1): só
  //   numa leitura aceita sem salto, já perto do fim;
  // - recuo de mais de RECUO_MIN_M (até RECUO_MAX_M) em 2 leituras boas seguidas: o progresso volta (salto errado aceito);
  //   recuo pequeno (ruído) não volta;
  // - leitura boa longe da linha: não mexe no progresso, mas conta para o detector de desvio.
  // atualizar({ lat, lon, precisao, rumo, velMs, t (ms) }) → { progresso_m, distancia_m, ao_longo_m, indice, ponto,
  //   considerada (vale para desvio/chegada), saltou, motivo: null | "precisao" | "salto" | "recuo" | "fora" }.
  const PRECISAO_MAX_M = 40, RECUO_MAX_M = 200, RECUO_MIN_M = 30, PARADO_MS = 2, SALTO_PARADO_M = 100;
  function criarRastreador(geo) {
    let prog = null, tAceito = null, pendente = null, recuo = null;
    const num = (x) => typeof x === "number" && isFinite(x);
    function saida(p, considerada, motivo, progresso, saltou) {
      const pr = progresso != null ? progresso : prog != null ? prog : 0;
      return { progresso_m: pr, distancia_m: p.distancia_m, ao_longo_m: p.ao_longo_m, indice: segmentoDoProgresso(geo, pr),
        ponto: p.ponto, considerada, motivo, saltou: !!saltou };
    }
    return {
      atualizar(l) {
        const pos = { lat: l.lat, lon: l.lon };
        const prec = num(l.precisao) ? l.precisao : 0;
        const ruim = prec > PRECISAO_MAX_M;
        const rumo = num(l.rumo) ? l.rumo : null;
        const t = num(l.t) ? l.t : null;
        if (prog == null) {
          const p = projetar(geo, pos, { rumo });
          if (ruim) return saida(p, false, "precisao", p.ao_longo_m); // provisório: a primeira leitura boa fixa
          prog = p.ao_longo_m; tAceito = t;
          return saida(p, true, null);
        }
        const dtS = tAceito != null && t != null ? (t - tAceito) / 1000 : null;
        const p = projetar(geo, pos, { progresso: prog, rumo, dtS, velMs: l.velMs, recuoM: RECUO_MAX_M });
        if (ruim) return saida(p, false, "precisao");
        if (p.distancia_m > Math.max(40, 2 * prec)) { pendente = null; recuo = null; return saida(p, true, "fora"); }
        const av = p.ao_longo_m - prog;
        const possivel = dtS == null || dtS <= 0 ? Infinity : alcancePossivelM(dtS, l.velMs);
        const parado = rumo == null && num(l.velMs) && l.velMs < PARADO_MS;
        if (parado && av > SALTO_PARADO_M) { pendente = null; recuo = null; return saida(p, false, "salto"); }
        if (av > possivel) {
          if (!(pendente != null && p.ao_longo_m >= pendente - 30)) { pendente = p.ao_longo_m; recuo = null; return saida(p, false, "salto"); }
          prog = Math.max(prog, p.ao_longo_m); pendente = null; recuo = null; tAceito = t;
          return saida(p, true, null, null, true);
        } else if (av < -RECUO_MIN_M) {
          if (recuo == null) { recuo = p.ao_longo_m; pendente = null; return saida(p, true, "recuo"); }
          prog = p.ao_longo_m; pendente = null; recuo = null; tAceito = t;
          return saida(p, true, null);
        }
        prog = Math.max(prog, p.ao_longo_m); pendente = null; recuo = null; tAceito = t;
        return saida(p, true, null);
      },
      progresso: () => prog,
    };
  }

  // ------------------------------------------------------------ manobras
  const DESTINO = new Set([4, 5, 6]);
  const ICONES = {
    1: "↑", 2: "↱", 3: "↰", 4: "⚑", 5: "⚑", 6: "⚑", 7: "↑", 8: "↑", 9: "↗", 10: "→", 11: "↘", 12: "↻", 13: "↺",
    14: "↙", 15: "←", 16: "↖", 17: "↑", 18: "↗", 19: "↖", 20: "↗", 21: "↖", 22: "↑", 23: "↗", 24: "↖", 25: "↑",
    26: "⟳", 27: "↗", 37: "↗", 38: "↖",
  };
  function icone(tipo) { return ICONES[tipo] || "↑"; }

  // A chegada nunca aparece como manobra futura com o texto do passado ("Você chegou ao seu destino."):
  // no painel é "Destino" e a fala é "Você chegará ao destino." (a própria chegada tem a fala "Você chegou.").
  const TEXTO_DESTINO = "Destino", FALA_DESTINO = "Você chegará ao destino.";
  const TEXTO_PARADA = "Parada", FALA_PARADA = "Você chegará à parada."; // fim de uma perna intermediária

  // resposta: JSON bruto do Valhalla. geo: prepararGeometria(coords da rota inteira).
  // Os índices de forma são por perna; aqui viram índices na linha inteira (as pernas são concatenadas como em rota.js).
  function extrairManobras(resposta, geo) {
    const lista = [];
    if (!resposta || !resposta.trip || !Array.isArray(resposta.trip.legs)) return lista;
    let deslocamento = 0;
    const pernas = resposta.trip.legs;
    for (let iPerna = 0; iPerna < pernas.length; iPerna++) {
      const leg = pernas[iPerna], ultimaPerna = iPerna === pernas.length - 1;
      const n = typeof leg.shape === "string" ? RotaLib.decodificarPolyline6(leg.shape).length : 0;
      for (const m of leg.maneuvers || []) {
        const ini = Math.min(geo.acum.length - 1, deslocamento + (Number(m.begin_shape_index) || 0));
        const ehDestino = DESTINO.has(Number(m.type));
        lista.push({
          tipo: Number(m.type) || 0,
          instrucao: ehDestino ? (ultimaPerna ? TEXTO_DESTINO : TEXTO_PARADA) : m.instruction || "",
          pre: ehDestino ? (ultimaPerna ? FALA_DESTINO : FALA_PARADA) : m.verbal_pre_transition_instruction || m.instruction || "",
          alerta: ehDestino ? (ultimaPerna ? FALA_DESTINO : FALA_PARADA) : m.verbal_transition_alert_instruction || m.verbal_pre_transition_instruction || m.instruction || "",
          ruas: (m.street_names && m.street_names.length ? m.street_names : (m.begin_street_names || [])).slice(),
          indice_forma: ini,
          inicio_m: geo.acum[ini] || 0,
          tempo_s: typeof m.time === "number" && isFinite(m.time) ? m.time : null,
          destino: ehDestino,
        });
      }
      deslocamento += n;
    }
    for (let i = 0; i < lista.length; i++) lista[i].fim_m = i + 1 < lista.length ? lista[i + 1].inicio_m : geo.total;
    return lista;
  }

  // Manobra atual = a do trecho onde o motorista está (pelo índice de forma); a próxima é a que ele vai fazer.
  function situacaoManobras(manobras, indiceSegmento, progresso) {
    if (!manobras.length) return { atual: -1, proxima: -1, seguinte: -1, distancia_m: null };
    let atual = 0;
    for (let i = 0; i < manobras.length; i++) if (manobras[i].indice_forma <= indiceSegmento) atual = i;
    // várias manobras no mesmo ponto: a próxima é a primeira que começa à frente do progresso
    let proxima = atual + 1;
    while (proxima < manobras.length - 1 && manobras[proxima].inicio_m < progresso - 1) proxima++;
    if (proxima >= manobras.length) return { atual, proxima: -1, seguinte: -1, distancia_m: null };
    return { atual, proxima, seguinte: proxima + 1 < manobras.length ? proxima + 1 : -1,
      distancia_m: Math.max(0, manobras[proxima].inicio_m - progresso) };
  }

  // Tempo restante pelo tempo que o motor de rota deu a cada manobra (sem trânsito). Sem tempos: proporcional.
  function tempoRestanteS(manobras, progresso, total, tempoTotalS) {
    const temTempos = manobras.length && manobras.every((m) => m.tempo_s != null);
    if (!temTempos) return total > 0 && isFinite(tempoTotalS) ? Math.max(0, tempoTotalS * (total - progresso) / total) : null;
    let s = 0;
    for (const m of manobras) {
      if (m.fim_m <= progresso) continue;
      const len = m.fim_m - m.inicio_m;
      if (m.inicio_m >= progresso || len <= 0) s += m.tempo_s;
      else s += m.tempo_s * (m.fim_m - progresso) / len;
    }
    return s;
  }

  // ------------------------------------------------------------ saída da rota e recálculo
  // Fora da rota: distância > max(40 m, 2 × precisão) em N leituras seguidas com velocidade > 2 m/s.
  // Leitura sem velocidade conhecida não conta (e zera a sequência). Leitura com precisão > 40 m (A1) é ignorada:
  // não conta nem zera.
  function criarDetectorDesvio(opcoes) {
    const o = opcoes || {};
    const minimo = o.minimoM || 40, leituras = o.leituras || 3, velMin = o.velMinMs == null ? 2 : o.velMinMs;
    let cont = 0;
    return {
      atualizar(l) {
        const prec = typeof l.precisao === "number" && isFinite(l.precisao) ? l.precisao : 0;
        if (prec > PRECISAO_MAX_M) return false;
        const limite = Math.max(minimo, 2 * prec);
        if (l.distancia_m > limite && typeof l.velMs === "number" && l.velMs > velMin) cont++;
        else cont = 0;
        return cont >= leituras;
      },
      zerar() { cont = 0; },
      contagem: () => cont,
    };
  }
  const INTERVALO_RECALCULO_MS = 20000;
  function podeRecalcular(agoraMs, ultimoMs) { return ultimoMs == null || agoraMs - ultimoMs >= INTERVALO_RECALCULO_MS; }

  // Chegada: a menos de 30 m do destino COM o progresso perto do fim (A2: destino do outro lado da pista dupla não
  // "chega" ao passar em frente na ida), ou passou do fim da linha.
  function chegou(geo, pos, progresso) {
    if (!geo.coords.length) return false;
    const fim = ponto(geo.coords[geo.coords.length - 1]);
    return (distanciaM(pos, fim) < 30 && progresso >= geo.total - 50) || progresso >= geo.total - 30;
  }

  // ------------------------------------------------------------ voz das manobras
  const ORDEM = { longe: 0, perto: 1, agora: 2 };
  // Distâncias de anúncio conforme a velocidade (m/s). "agora" ≈ 5 s antes, entre 30 e 150 m.
  function etapasAnuncio(velMs) {
    const v = typeof velMs === "number" && isFinite(velMs) && velMs > 0 ? velMs : 0;
    const agora = Math.round(Math.max(30, Math.min(150, v * 5)));
    if (v >= 20) return [{ id: "longe", m: 2000 }, { id: "perto", m: 500 }, { id: "agora", m: agora }]; // rodovia (≥ 72 km/h)
    if (v >= 12) return [{ id: "longe", m: 1000 }, { id: "perto", m: 300 }, { id: "agora", m: agora }];
    return [{ id: "perto", m: 300 }, { id: "agora", m: agora }];
  }

  // Lembra o que já foi dito por manobra: nunca repete a mesma etapa nem volta a uma etapa mais distante.
  function criarAnunciador() {
    const ditos = new Map(); // índice da manobra → maior ORDEM já dita
    return {
      // devolve a etapa a falar agora ("longe" | "perto" | "agora") ou null
      avaliar(indice, distancia_m, velMs, destino) {
        if (indice < 0 || distancia_m == null) return null;
        let alvo = null;
        for (const e of etapasAnuncio(velMs)) {
          if (destino && e.id === "agora") continue; // a chegada tem a própria fala
          if (distancia_m <= e.m) alvo = e.id;
        }
        if (!alvo) return null;
        const ja = ditos.has(indice) ? ditos.get(indice) : -1;
        return ORDEM[alvo] > ja ? alvo : null;
      },
      marcar(indice, etapa) { const ja = ditos.has(indice) ? ditos.get(indice) : -1; ditos.set(indice, Math.max(ja, ORDEM[etapa])); },
      // etapa já dita da manobra ("longe" | "perto" | "agora" | null) e desfazer (fala cortada pelo alerta: volta a valer)
      dito(indice) { if (!ditos.has(indice)) return null; const o = ditos.get(indice); return Object.keys(ORDEM).find((k) => ORDEM[k] === o) || null; },
      desfazer(indice, etapaAnterior) { if (indice < 0) return; if (etapaAnterior == null) ditos.delete(indice); else ditos.set(indice, ORDEM[etapaAnterior]); },
      zerar() { ditos.clear(); },
    };
  }

  function minuscula(t) { return t.length > 1 && t[1] === t[1].toLowerCase() ? t[0].toLowerCase() + t.slice(1) : t; }
  function comPonto(t) { t = String(t || "").trim(); return t && !/[.!?]$/.test(t) ? t + "." : t; }
  // limiar_m (opcional): distância da etapa. Perto dela (≥ 80 %), fala o número redondo da etapa ("2 quilômetros"
  // em vez de "1,9 quilômetros"); bem abaixo (a primeira leitura já veio perto), fala a distância real.
  function textoAnuncio(manobra, distancia_m, etapa, limiar_m) {
    if (!manobra) return "";
    if (etapa === "agora") return comPonto(manobra.pre || manobra.instrucao);
    const d = typeof limiar_m === "number" && distancia_m >= 0.8 * limiar_m ? limiar_m : distancia_m;
    return "Em " + VozLib.distanciaFalada(d) + ", " + comPonto(minuscula(manobra.alerta || manobra.pre || manobra.instrucao));
  }
  function limiarEtapa(velMs, etapa) { const e = etapasAnuncio(velMs).find((x) => x.id === etapa); return e ? e.m : null; }

  // ------------------------------------------------------------ formatação
  function virgula(n, casas) { return n.toFixed(casas).replace(".", ","); }
  function formatarDistancia(m) {
    if (typeof m !== "number" || !isFinite(m)) return "--";
    const d = Math.max(0, m);
    if (d < 1000) return (d < 100 ? Math.round(d / 10) * 10 : Math.round(d / 50) * 50) + " m";
    if (d < 10000) return virgula(d / 1000, 1) + " km";
    return Math.round(d / 1000) + " km";
  }
  function formatarDuracao(s) {
    if (typeof s !== "number" || !isFinite(s)) return "--";
    const min = Math.round(s / 60);
    if (min < 1) return "menos de 1 min";
    const h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? h + " h " + String(m).padStart(2, "0") + " min" : m + " min";
  }
  function formatarHora(data) { return String(data.getHours()).padStart(2, "0") + ":" + String(data.getMinutes()).padStart(2, "0"); }
  // Sem trânsito em tempo real: a hora de chegada é estimativa do motor de rota, e o texto diz isso.
  function textoChegada(agoraMs, restanteS) {
    if (typeof restanteS !== "number" || !isFinite(restanteS)) return "Chegada: desconhecida";
    return "Chegada " + formatarHora(new Date(agoraMs + restanteS * 1000)) + " · sem trânsito";
  }

  // ------------------------------------------------------------ peso (carregado/vazio)
  // Lê toneladas digitadas ("15", "15,5"). Vazio = não informado (null).
  function lerToneladas(texto) {
    const t = String(texto == null ? "" : texto).trim();
    if (t === "") return { ok: true, valor: null };
    if (!/^\d+([.,]\d+)?$/.test(t)) return { ok: false, erro: "Digite o peso em toneladas (ex.: 15 ou 15,5)." };
    const n = Number(t.replace(",", "."));
    if (n < 1 || n > 91) return { ok: false, erro: "Peso vazio deve ficar entre 1 e 91 t." };
    return { ok: true, valor: n };
  }
  function tFalado(n) { return String(Math.round(n * 100) / 100).replace(".", ",") + " t"; }
  // carga: "carregado" | "vazio" | null (veículo leve). pesoT: carregado = peso total digitado (t; null/omitido = PBTC do
  // cadastro); vazio = peso vazio (tara) do cadastro (t) ou null.
  function pesoParaRota(perfil, carga, pesoT) {
    if (!perfil || !RotaLib.ehCaminhao(perfil) || !carga) return { peso: null, aviso: null };
    const t = typeof pesoT === "number" && isFinite(pesoT) ? pesoT : null;
    if (carga === "carregado") {
      const pbtc = typeof perfil.pbtc === "number" && isFinite(perfil.pbtc) ? perfil.pbtc : null;
      if (t != null && t !== pbtc) return { peso: t, aviso: "Carregado: rota calculada com " + tFalado(t) + " (peso informado por você)." };
      return pbtc != null
        ? { peso: pbtc, aviso: "Carregado: rota calculada com " + tFalado(pbtc) + " (PBTC do cadastro)." }
        : { peso: null, aviso: "Carregado, mas o peso (PBTC) não foi informado no cadastro: a rota foi calculada sem peso." };
    }
    return t != null
      ? { peso: t, aviso: "Vazio: rota calculada com " + tFalado(t) + " (peso vazio do veículo)." }
      : { peso: null, aviso: "Vazio, sem peso vazio informado: a rota foi calculada sem peso." };
  }
  // Ajusta pedido + faltando (de rota.criarPedido) ao peso escolhido. Não altera os originais.
  function aplicarPeso(pedido, faltando, peso) {
    const p = JSON.parse(JSON.stringify(pedido));
    const f = (faltando || []).filter((x) => x !== "PBTC");
    if (p.costing_options && p.costing_options.truck) {
      if (typeof peso === "number" && isFinite(peso)) p.costing_options.truck.weight = peso;
      else delete p.costing_options.truck.weight;
    }
    return { pedido: p, faltando: f };
  }

  // ------------------------------------------------------------ registro da viagem (GPS do aparelho)
  // Distância só soma com o veículo em movimento (> 1 m/s), para o tremor do GPS parado não virar quilômetro.
  function criarRegistro() {
    let primeiro = null, anterior = null, dist = 0, mov = 0, leituras = 0;
    return {
      adicionar(l) { // { lat, lon, t (ms), velMs (m/s ou null), precisao }
        if (!l || typeof l.t !== "number") return;
        if (typeof l.precisao === "number" && l.precisao > 100) return; // leitura ruim: ignora
        leituras++;
        if (!primeiro) { primeiro = l; anterior = l; return; }
        const dt = (l.t - anterior.t) / 1000;
        if (dt <= 0) return;
        const d = distanciaM(anterior, l);
        const v = typeof l.velMs === "number" && isFinite(l.velMs) ? l.velMs : d / dt;
        if (v > 1) { dist += d; mov += dt; }
        anterior = l;
      },
      resumo() {
        const total = primeiro ? (anterior.t - primeiro.t) / 1000 : 0;
        const movimento = Math.min(mov, total);
        return {
          inicio: primeiro ? primeiro.t : null, fim: anterior ? anterior.t : null, leituras,
          distancia_m: dist, total_s: total, movimento_s: movimento, parado_s: Math.max(0, total - movimento),
          vel_media_kmh: movimento >= 10 ? Math.round(dist / movimento * 3.6) : null,
        };
      },
    };
  }
  // Linhas do resumo pós-viagem: tudo "registrado", nada "estimado".
  function linhasResumo(r) {
    return [
      ["Distância percorrida", formatarDistancia(r.distancia_m)],
      ["Tempo total", formatarDuracao(r.total_s)],
      ["Tempo em movimento", formatarDuracao(r.movimento_s)],
      ["Tempo parado", formatarDuracao(r.parado_s)],
      ["Velocidade média em movimento", r.vel_media_kmh == null ? "não deu para medir" : r.vel_media_kmh + " km/h"],
    ];
  }

  // ------------------------------------------------------------ armazenamento (copiloto.nav.v1)
  function lerDados(storage) {
    let o = null;
    try { o = JSON.parse((storage && storage.getItem(CHAVE)) || "null"); } catch (e) { o = null; }
    o = o && typeof o === "object" ? o : {};
    return {
      taras: o.taras && typeof o.taras === "object" ? o.taras : {},
      pesos: o.pesos && typeof o.pesos === "object" ? o.pesos : {}, // último peso carregado por veículo (redesenho)
      viagens: Array.isArray(o.viagens) ? o.viagens : [],
      recentes: Array.isArray(o.recentes) ? o.recentes : [],
      andamento: o.andamento && typeof o.andamento === "object" ? o.andamento : null,
    };
  }
  // M4: navegação em andamento guardada (o iOS descarta a aba): { destino: { lat, lon }, rotulo, perfilId, perfilNome,
  // carga, peso, aviso, inicio, atualizado (ms), progresso_m, total_m, resumo (do registro), registrada? }.
  // Vale para "Continuar navegação" por ANDAMENTO_MAX_MS depois da última atualização.
  const ANDAMENTO_MAX_MS = 12 * 3600 * 1000;
  function andamentoValido(a, agoraMs) {
    return !!(a && a.destino && typeof a.destino.lat === "number" && isFinite(a.destino.lat) && typeof a.destino.lon === "number" &&
      isFinite(a.destino.lon) && typeof a.atualizado === "number" && agoraMs - a.atualizado >= 0 && agoraMs - a.atualizado <= ANDAMENTO_MAX_MS);
  }
  // Viagem interrompida (página recarregada no meio) para o histórico, com o que o GPS registrou até a última gravação.
  function viagemInterrompida(a, id) {
    const r = a && a.resumo && typeof a.resumo === "object" ? a.resumo : {};
    const n = (x) => (typeof x === "number" && isFinite(x) ? x : 0);
    return { id, chegou: false, interrompida: true, destino: a.rotulo || null, veiculo: a.perfilNome || null, carga: a.carga || null,
      data: typeof a.inicio === "number" ? a.inicio : a.atualizado, inicio: r.inicio == null ? null : r.inicio, fim: r.fim == null ? null : r.fim,
      leituras: n(r.leituras), distancia_m: n(r.distancia_m), total_s: n(r.total_s), movimento_s: n(r.movimento_s), parado_s: n(r.parado_s),
      vel_media_kmh: typeof r.vel_media_kmh === "number" ? r.vel_media_kmh : null };
  }
  function gravarDados(storage, d) { try { storage && storage.setItem(CHAVE, JSON.stringify(d)); } catch (e) { /* ignora */ } }
  function adicionarViagem(lista, viagem, max) { return [viagem].concat(lista || []).slice(0, max || 20); }
  // Destino repetido (a menos de 100 m de um da lista) sobe para o topo em vez de duplicar.
  function adicionarRecente(lista, destino, max) {
    const resto = (lista || []).filter((d) => distanciaM(d, destino) >= 100);
    return [destino].concat(resto).slice(0, max || 5);
  }

  // ------------------------------------------------------------ rota offline: volta, reentrada e conferência
  // Volta pela mesma rota: o desenho guardado no sentido inverso. As manobras do Valhalla são do sentido da ida e não
  // valem na volta (a direita vira esquerda, retornos e mãos únicas mudam): a volta vai SEM manobras, nunca inventadas.
  function inverterRota(rota) {
    if (!rota || !Array.isArray(rota.coords) || rota.coords.length < 2) return null;
    const coords = rota.coords.slice().reverse().map((c) => [c[0], c[1]]);
    const ini = coords[0], fim = coords[coords.length - 1];
    return { origem: { lat: ini[1], lon: ini[0] }, destino: { lat: fim[1], lon: fim[0] }, coords,
      km: rota.km, minutos: rota.minutos, avisos: [], resposta: null, invertida: true };
  }

  // Orientação mínima e honesta para uma linha sem manobras: "siga pela rota destacada" até o fim, que é a única
  // "manobra" (com os anúncios de chegada de 2 km / 500 m / 300 m). rotuloFim: "ponto de origem", "destino"…
  function manobrasSemCurvas(geo, rotuloFim, falaInicio) {
    const fim = rotuloFim || "destino";
    const chegada = "Você chegará ao " + fim + ".";
    const ultimo = Math.max(0, geo.coords.length - 1);
    return [
      { tipo: 1, instrucao: "Siga pela rota destacada", pre: falaInicio || "Siga pela rota destacada.", alerta: "Siga pela rota destacada.",
        ruas: [], indice_forma: 0, inicio_m: 0, fim_m: geo.total, tempo_s: null, destino: false, semCurvas: true },
      { tipo: 4, instrucao: "Siga pela rota destacada", pre: chegada, alerta: chegada, ruas: ["até o " + fim],
        indice_forma: ultimo, inicio_m: geo.total, fim_m: geo.total, tempo_s: null, destino: true, semCurvas: true },
    ];
  }

  // Avisos de distância restante numa rota sem manobras: devolve o marco (m) que acabou de ser cruzado ou null.
  const MARCOS_RESTANTE_M = [200000, 100000, 50000, 20000, 10000, 5000];
  // inicioM (opcional): o que faltava no começo; marco a menos de 300 m dele não é falado (acabou de ouvir a distância).
  function marcoRestante(antesM, agoraM, inicioM) {
    if (typeof antesM !== "number" || typeof agoraM !== "number" || !isFinite(antesM) || !isFinite(agoraM)) return null;
    let cruzado = null;
    for (const m of MARCOS_RESTANTE_M) if (antesM > m && agoraM <= m && !(typeof inicioM === "number" && m > inicioM - 300)) cruzado = m;
    return cruzado;
  }
  function textoMarco(m) { return "Faltam " + VozLib.distanciaFalada(m) + " pela rota destacada."; }

  // Ponto da linha mais perto de pos, só no trecho [desdeM, ateM] (metros ao longo da linha).
  function maisProximo(geo, pos, desdeM, ateM) {
    const n = geo.coords.length;
    if (n < 2) return null;
    const ini = desdeM == null || desdeM <= 0 ? 0 : segmentoDoProgresso(geo, desdeM);
    const kx = Math.cos(pos.lat * RAD) * M_POR_GRAU, ky = M_POR_GRAU;
    let melhor = null;
    for (let i = ini; i < n - 1; i++) {
      if (ateM != null && geo.acum[i] > ateM) break;
      const a = geo.coords[i], b = geo.coords[i + 1];
      const ax = (a[0] - pos.lon) * kx, ay = (a[1] - pos.lat) * ky;
      const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      // não volta para antes de desdeM dentro do primeiro segmento
      const s0 = geo.acum[i], s1 = geo.acum[i + 1];
      if (desdeM != null && s1 > s0 && s0 + t * (s1 - s0) < desdeM) t = Math.min(1, (desdeM - s0) / (s1 - s0));
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(px, py);
      if (!melhor || d < melhor.distancia_m) {
        melhor = { distancia_m: d, ao_longo_m: s0 + t * (s1 - s0), ponto: { lon: pos.lon + px / kx, lat: pos.lat + py / ky } };
      }
    }
    return melhor;
  }

  // Rumo (graus a partir do norte, sentido horário) de a para b.
  function rumoEntre(a, b) {
    const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
    const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  const RUMOS = ["norte", "nordeste", "leste", "sudeste", "sul", "sudoeste", "oeste", "noroeste"];
  function textoRumo(graus) { return RUMOS[Math.round((((graus % 360) + 360) % 360) / 45) % 8]; }
  // Lado do alvo em relação ao rumo do veículo ("em frente", "à direita", "à esquerda", "atrás"); sem rumo, null.
  function direcaoRelativa(alvo, rumoVeiculo) {
    if (typeof rumoVeiculo !== "number" || !isFinite(rumoVeiculo)) return null;
    const d = ((alvo - rumoVeiculo + 540) % 360) - 180;
    if (Math.abs(d) <= 30) return "em frente";
    if (Math.abs(d) >= 150) return "atrás";
    return d > 0 ? "à direita" : "à esquerda";
  }

  // Ponto de reentrada sem internet: o ponto da linha mais perto, À FRENTE do progresso (sentido da viagem; uma folga de
  // 50 m atrás). Saindo de uma fazenda a alguns km da linha, é para lá que o motorista vai, não para um trecho já feito.
  // Devolve { ponto: { lat, lon }, distancia_m, ao_longo_m, rumo } ou null.
  function pontoReentrada(geo, pos, progresso) {
    const desde = typeof progresso === "number" && isFinite(progresso) ? Math.max(0, progresso - 50) : 0;
    const m = maisProximo(geo, pos, desde) || maisProximo(geo, pos, 0);
    if (!m) return null;
    return Object.assign(m, { rumo: rumoEntre(pos, m.ponto) });
  }

  // Textos do estado "fora da linha sem internet". motivo: "internet" (padrão) ou "servidor" (não respondeu).
  // Devolve { status (faixa do painel), detalhe ("Linha a 350 m · nordeste · à direita"), fala }.
  function textoReentrada(r, rumoVeiculo, motivo) {
    const causaTela = motivo === "servidor" ? "o servidor de rotas não respondeu" : "sem internet para recalcular";
    const status = "Rota offline — " + causaTela + ". Volte para a linha destacada";
    if (!r) return { status, detalhe: "", fala: "Rota offline, " + causaTela + ". Volte para a linha destacada." };
    const lado = direcaoRelativa(r.rumo, rumoVeiculo);
    const rumo = textoRumo(r.rumo);
    const detalhe = "Linha a " + formatarDistancia(r.distancia_m) + " · " + rumo + (lado ? " · " + lado : "");
    const fala = "Rota offline, " + causaTela + ". Volte para a linha destacada, a " + VozLib.distanciaFalada(r.distancia_m) + ", " +
      (lado && lado !== "atrás" ? lado : "ao " + rumo) + ".";
    return { status, detalhe, fala };
  }
  const REENTRADA_FALA_MS = 60000; // voz do "volte para a linha" no máximo a cada ~60 s
  function podeFalarReentrada(tAgora, tUltima) { return tUltima == null || !isFinite(tUltima) || tAgora - tUltima >= REENTRADA_FALA_MS; }

  // Ponto a s metros ao longo da linha.
  function pontoNaDistancia(geo, s) {
    const i = segmentoDoProgresso(geo, s);
    const a = geo.coords[i], b = geo.coords[Math.min(i + 1, geo.coords.length - 1)];
    const len = geo.acum[Math.min(i + 1, geo.acum.length - 1)] - geo.acum[i];
    const t = len > 0 ? Math.max(0, Math.min(1, (s - geo.acum[i]) / len)) : 0;
    return { lon: a[0] + t * (b[0] - a[0]), lat: a[1] + t * (b[1] - a[1]) };
  }

  // Conferência da rota guardada quando a internet volta: a rota nova (posição atual → destino) difere da guardada?
  // Difere se a distância muda mais de 10 % (contra o que falta da guardada) ou se algum ponto da nova passa a mais de
  // 300 m da linha guardada. geo: geometria guardada; progresso: metros já feitos nela; coordsNova: [[lon, lat], …].
  // Devolve { difere, difDistPct, desvioMaxM }.
  const DIFERE_DIST = 0.10, DIFERE_DESVIO_M = 300;
  function compararRotas(geo, progresso, coordsNova, op) {
    const o = Object.assign({ distPct: DIFERE_DIST, desvioM: DIFERE_DESVIO_M, passoM: 100 }, op);
    if (!Array.isArray(coordsNova) || coordsNova.length < 2 || !geo || geo.coords.length < 2) return { difere: true, difDistPct: null, desvioMaxM: null };
    const nova = prepararGeometria(coordsNova);
    const prog = typeof progresso === "number" && isFinite(progresso) ? Math.max(0, progresso) : 0;
    const restante = Math.max(0, geo.total - prog);
    const difDist = restante > 0 ? Math.abs(nova.total - restante) / restante : nova.total > 50 ? Infinity : 0;
    // desvio: amostras a cada passoM na nova; cada uma procura perto de onde a anterior casou (as duas andam no mesmo
    // sentido) e, se ficar longe, na linha toda à frente (do progresso, com folga) antes de contar como desvio
    let desvio = 0, onde = prog;
    const passo = Math.max(10, o.passoM);
    const amostras = [];
    for (let s = 0; s < nova.total; s += passo) amostras.push(s);
    amostras.push(nova.total);
    for (const s of amostras) {
      const p = pontoNaDistancia(nova, s);
      let m = maisProximo(geo, p, Math.max(0, onde - 500), onde + 2 * passo + 1500);
      if (!m || m.distancia_m > o.desvioM) m = maisProximo(geo, p, Math.max(0, prog - 200));
      if (!m) continue;
      if (m.distancia_m <= o.desvioM) onde = Math.max(onde, m.ao_longo_m);
      if (m.distancia_m > desvio) desvio = m.distancia_m;
      if (desvio > o.desvioM) break;
    }
    return { difere: difDist > o.distPct || desvio > o.desvioM,
      difDistPct: isFinite(difDist) ? Math.round(difDist * 1000) / 10 : null, desvioMaxM: Math.round(desvio) };
  }

  // Quando conferir: uma vez por retorno da internet (ou no início, com rota guardada), nunca em laço. Falha (sem rede,
  // servidor calado) espera 60 s, 120 s, 240 s… até 5 min antes de tentar de novo.
  function criarConferidor(op) {
    const base = (op && op.esperaMs) || 60000, max = (op && op.esperaMaxMs) || 300000;
    let pendente = false, emCurso = false, proximaEm = 0, falhas = 0;
    function falhou(agora) { pendente = true; falhas++; proximaEm = agora + Math.min(max, base * Math.pow(2, falhas - 1)); }
    return {
      pedir() { pendente = true; },
      internetVoltou() { pendente = true; falhas = 0; proximaEm = 0; },
      falhou,
      deveConferir(agora, online) { return !!online && pendente && !emCurso && agora >= proximaEm; },
      iniciou() { emCurso = true; },
      terminou(ok, agora) { emCurso = false; if (ok) { pendente = false; falhas = 0; proximaEm = 0; } else falhou(agora); },
      estado: () => ({ pendente, emCurso, proximaEm, falhas }),
    };
  }

  // Faixa da navegação com rota guardada/offline: "Rota offline · conferida às 14:10" (hoje), "… em 30/10 às 14:10",
  // "… conferida agora", "… não conferida" ou "… conferindo com a internet…".
  function textoFaixaOffline(e) {
    const agora = e.agora == null ? Date.now() : e.agora;
    if (e.conferindo) return "Rota offline · conferindo com a internet…";
    const c = e.conferidaEm;
    if (typeof c !== "number" || !isFinite(c)) return "Rota offline · não conferida";
    if (agora - c >= 0 && agora - c < 60000) return "Rota offline · conferida agora";
    const d = new Date(c), h = new Date(agora);
    const mesmoDia = d.getFullYear() === h.getFullYear() && d.getMonth() === h.getMonth() && d.getDate() === h.getDate();
    const dd = (x) => String(x).padStart(2, "0");
    return "Rota offline · conferida " + (mesmoDia ? "às " : "em " + dd(d.getDate()) + "/" + dd(d.getMonth() + 1) + " às ") + formatarHora(d);
  }

  const api = {
    inverterRota, manobrasSemCurvas, marcoRestante, textoMarco, MARCOS_RESTANTE_M, maisProximo, rumoEntre, textoRumo, direcaoRelativa,
    pontoReentrada, textoReentrada, REENTRADA_FALA_MS, podeFalarReentrada, pontoNaDistancia, compararRotas, DIFERE_DIST, DIFERE_DESVIO_M,
    criarConferidor, textoFaixaOffline,
    CHAVE, INTERVALO_RECALCULO_MS, VEL_MAX_MS, PRECISAO_MAX_M, RECUO_MAX_M, ANDAMENTO_MAX_MS, criarRastreador, andamentoValido, viagemInterrompida, TEXTO_DESTINO, FALA_DESTINO, distanciaM, prepararGeometria, segmentoDoProgresso, projetar, alcancePossivelM,
    icone, extrairManobras, situacaoManobras, tempoRestanteS,
    criarDetectorDesvio, podeRecalcular, chegou,
    etapasAnuncio, criarAnunciador, textoAnuncio, limiarEtapa,
    formatarDistancia, formatarDuracao, formatarHora, textoChegada,
    lerToneladas, pesoParaRota, aplicarPeso,
    criarRegistro, linhasResumo, lerDados, gravarDados, adicionarViagem, adicionarRecente,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoNavegacao = api;
})(typeof window !== "undefined" ? window : globalThis);
