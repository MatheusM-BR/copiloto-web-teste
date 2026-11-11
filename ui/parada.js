// Parada no posto: o motorista conta o que tem no posto (lógica pura em parada.js, window.CopilotoParada).
//  - Chegada (2 min parado a até 150 m de um posto, ou "Estou neste posto" no detalhe): fala "Chegou no <posto>. Quando sair,
//    me conta o que tem aqui pra gente marcar." e mostra um aviso curto.
//  - Saída (a mais de 300 m, ou andando): até 4 perguntas, uma de cada vez, por voz e na tela: preço do S10, nota do posto,
//    banheiro (limpo/regular/sujo, fedido), uma de existência (carreta, pátio, S10, Arla, banheiro, chuveiro, restaurante,
//    24 h). "Pular" passa; "Parar" encerra. Sem resposta em 25 s, passa para a próxima.
//  - Envio: copiloto_station_answers_submit (conta logada). Sem conta ou sem internet: fica guardado no aparelho e vai depois.
//    O banco transforma nota, limpeza e cheiro numa pontuação INTERNA (não aparece no app até a base consolidar).
// Postos perto: copiloto_stations_near (pública), só quando devagar (≤ 8 km/h), no máximo a cada 30 s.
// Expõe Copiloto.parada: marcar(posto), visita(), pendentes(), enviarPendentes(), simularSaida() (testes).
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const P = window.CopilotoParada;
  const CHAVE_MEM = "copiloto.parada.memoria.v1", CHAVE_FILA = "copiloto.parada.fila.v1", CHAVE_LIGADO = "copiloto.parada.ligado.v1";
  const BUSCA_MS = Number(window.COPILOTO_PARADA_BUSCA_MS) || 30000, RESPOSTA_MS = 25000;

  const ler = (k, pad) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? pad : v; } catch (e) { return pad; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sem espaço */ } };
  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));

  const det = P.criarDetector(Object.assign({ gerarId: uuid }, Number(window.COPILOTO_PARADA_CHEGADA_MS) > 0 ? { chegadaMs: Number(window.COPILOTO_PARADA_CHEGADA_MS) } : {})); // testes: chegada mais curta
  let postosPerto = [], ultimaBusca = 0, buscando = false, sessao = null;

  function ligado() { return ler(CHAVE_LIGADO, true) !== false; }
  function nomeDe(p) { return (p && (p.name || p.nome || p.brand)) || "posto"; }
  function maisPerto(g) {
    let m = null, dm = Infinity;
    for (const p of postosPerto) { const d = P.distM(g, p); if (d < dm) { dm = d; m = p; } }
    return m ? { key: m.station_key || m.key, nome: nomeDe(m), lat: m.lat, lon: m.lon } : null;
  }
  async function buscarPerto(g) {
    if (buscando || Date.now() - ultimaBusca < BUSCA_MS || !C.nuvem || !C.nuvem.rpcPublica) return;
    buscando = true; ultimaBusca = Date.now();
    try {
      const r = await C.nuvem.rpcPublica("copiloto_stations_near", { p_lat: g.lat, p_lon: g.lon, p_radius_m: 300, p_limit: 5 });
      postosPerto = Array.isArray(r) ? r.filter((p) => p && p.station_key && typeof p.lat === "number") : [];
    } catch (e) { /* sem internet: tenta na próxima */ } finally { buscando = false; }
  }

  function aoPosicao(g) {
    if (!ligado() || !g || typeof g.lat !== "number") return;
    const kmh = typeof g.kmh === "number" ? g.kmh : (typeof g.velKmh === "number" ? g.velKmh : null);
    if (!det.visita() && kmh !== null && kmh <= 8) buscarPerto(g);
    const ev = det.atualizar({ lat: g.lat, lon: g.lon, kmh, t: g.recebidoEm || Date.now() }, det.visita() ? null : maisPerto(g));
    if (ev && ev.tipo === "chegada") chegou(ev.visita);
    else if (ev && ev.tipo === "saida") saiu(ev.visita);
  }

  // ------------------------------------------------------------ chegada
  function chegou(v) {
    C.emit("parada:chegada", v);
    const t = P.textoChegada(v.nome);
    C.mensagem(t, 9000);
    if (C.voz && !(C.voz.emAlerta && C.voz.emAlerta())) C.voz.falar(t, { naoInterromper: true });
  }
  function marcar(posto) {
    const g = C.estado.gps;
    if (!g) { C.mensagem("Sem GPS: não dá para marcar a chegada.", 5000); return null; }
    const p = { key: posto.station_key || posto.key, nome: nomeDe(posto), lat: posto.lat, lon: posto.lon };
    if (P.distM(g, p) > 400) { C.mensagem("Você está longe deste posto.", 5000); return null; }
    const ev = det.marcar(p, { lat: g.lat, lon: g.lon, t: g.recebidoEm || Date.now() });
    if (ev) chegou(ev.visita);
    return ev && ev.visita;
  }

  // ------------------------------------------------------------ saída: perguntas
  function saiu(v) {
    C.emit("parada:saida", v);
    const mem = ler(CHAVE_MEM, {});
    const perguntas = P.escolherPerguntas(mem, v.key, Date.now());
    if (!perguntas.length) return;
    sessao = { visita: v, perguntas, i: 0, respostas: [], fim: false };
    const s = sessao;
    const abertura = P.textoSaida(v.nome, perguntas.length);
    C.mensagem(abertura, 5000);
    let comecou = false;
    const comecar = () => { if (comecou) return; comecou = true; perguntarProxima(s); };
    if (!C.voz || (C.voz.emAlerta && C.voz.emAlerta()) || !C.voz.falar(abertura, { naoInterromper: true, aoTerminar: () => setTimeout(comecar, 200) })) comecar();
    setTimeout(comecar, 6000 + 80 * abertura.length);
  }

  function opcoesDe(p, responder) {
    const b = el("div", "parada-opcoes");
    const op = (rotulo, resp, id) => { const x = botao(rotulo, "btn parada-op", () => responder(resp)); x.id = "parada-op-" + id; return x; };
    if (p.tipo === "nota") for (let n = 1; n <= 5; n++) b.appendChild(op(String(n), [{ q: p.q, v: n }], "n" + n));
    else if (p.tipo === "banheiro") {
      b.classList.add("parada-dois");
      b.append(op("Limpo", [{ q: "limpeza", v: 3 }], "limpo"), op("Regular", [{ q: "limpeza", v: 2 }], "regular"),
        op("Sujo", [{ q: "limpeza", v: 1 }], "sujo"), op("Sujo e fedido", [{ q: "limpeza", v: 1 }, { q: "cheiro", v: 1 }], "fedido"));
    } else if (p.tipo === "preco") {
      const f = el("form", "parada-preco");
      const i = document.createElement("input"); i.id = "parada-preco"; i.inputMode = "decimal"; i.placeholder = "R$ por litro, ex.: 6,49"; i.autocomplete = "off";
      const ok = botao("OK", "btn btn-principal parada-op", () => {}); ok.type = "submit"; ok.id = "parada-op-ok";
      f.append(i, ok);
      f.addEventListener("submit", (e) => { e.preventDefault(); const v = P.lerPreco(i.value); if (v === null) { C.mensagem("Preço fora do normal (entre R$ 3 e R$ 15).", 4000); return; } responder([{ q: p.q, v }]); });
      b.append(f, op("Não sei", [], "naosei"));
    } else b.append(op("Sim", [{ q: p.q, a: "sim" }], "sim"), op("Não", [{ q: p.q, a: "nao" }], "nao"), op("Não sei", [{ q: p.q, a: "nao_sei" }], "naosei"));
    return b;
  }

  function perguntarProxima(s) {
    if (sessao !== s || s.fim) return;
    if (s.i >= s.perguntas.length) { encerrar(s, true); return; }
    const p = s.perguntas[s.i];
    let feito = false;
    const responder = (resp) => {
      if (feito || sessao !== s) return;
      feito = true; clearTimeout(s.timer);
      if (resp && resp.length) s.respostas.push(...resp);
      s.i++;
      perguntarProxima(s);
    };
    const raiz = el("section", "parada-pergunta"); raiz.id = "parada-pergunta";
    raiz.append(el("p", "parada-posto", s.visita.nome + " · " + (s.i + 1) + " de " + s.perguntas.length),
      el("h2", null, p.texto), opcoesDe(p, responder));
    const rod = el("div", "parada-rodape");
    const pular = botao("Pular", "btn parada-pular", () => responder([])); pular.id = "parada-pular";
    const parar = botao("Parar perguntas", "btn parada-parar", () => encerrar(s, true)); parar.id = "parada-parar";
    rod.append(pular, parar); raiz.appendChild(rod);
    C.folha.abrir([raiz]);
    s.timer = setTimeout(() => responder([]), RESPOSTA_MS);
    if (C.comandos && C.comandos.perguntar) {
      C.comandos.perguntar(p.texto, (textos) => {
        if (/\b(parar|chega|encerra)\b/.test(P.normalizar([].concat(textos).join(" ")))) { encerrar(s, true); return true; }
        const r = P.lerResposta(p, textos);
        if (r === null) return false;
        responder(r);
        return true;
      }, "parada-pergunta");
    }
  }

  function encerrar(s, agradecer) {
    if (s.fim) return;
    s.fim = true; clearTimeout(s.timer);
    if (sessao === s) sessao = null;
    const f = $("parada-pergunta"); if (f) C.folha.fechar();
    if (!s.respostas.length) return;
    gravar(CHAVE_MEM, P.lembrar(ler(CHAVE_MEM, {}), s.visita.key, s.respostas, Date.now()));
    const fila = ler(CHAVE_FILA, []);
    fila.push({ p_station_key: s.visita.key, p_visit_id: s.visita.id, p_answers: s.respostas,
      p_distance_m: s.visita.distancia_m, p_observed_at: new Date(s.visita.inicio).toISOString() });
    gravar(CHAVE_FILA, fila.slice(-50));
    C.emit("parada:respostas", { visita: s.visita, respostas: s.respostas.slice() });
    if (agradecer) {
      const logado = C.nuvem && C.nuvem.logado && C.nuvem.logado();
      const t = logado ? P.TEXTO_FIM : P.TEXTO_FIM + " Entre na sua conta para enviar.";
      C.mensagem(t, 6000);
      if (C.voz && !(C.voz.emAlerta && C.voz.emAlerta())) C.voz.falar(P.TEXTO_FIM, { naoInterromper: true });
    }
    enviarPendentes();
  }

  // ------------------------------------------------------------ envio
  let enviando = false;
  async function enviarPendentes() {
    if (enviando || !C.nuvem || !C.nuvem.logado || !C.nuvem.logado()) return 0;
    enviando = true;
    let n = 0;
    try {
      let fila = ler(CHAVE_FILA, []);
      while (fila.length) {
        const item = fila[0];
        try { await C.nuvem.rpc("copiloto_station_answers_submit", item); n++; }
        catch (e) {
          if (e && e.rede) break; // sem internet: tenta depois
          // recusado (longe, antigo, limite): descarta este item para não travar a fila
        }
        fila = ler(CHAVE_FILA, []).filter((x) => x.p_visit_id !== item.p_visit_id);
        gravar(CHAVE_FILA, fila);
      }
    } finally { enviando = false; }
    return n;
  }

  C.parada = { marcar, visita: () => det.visita(), pendentes: () => ler(CHAVE_FILA, []), enviarPendentes, ligado,
    ligar: (v) => gravar(CHAVE_LIGADO, !!v), simularSaida: () => { const v = det.visita(); if (!v) return false; det.cancelar(); saiu(Object.assign(v, { fim: Date.now() })); return true; },
    sessaoAtiva: () => !!sessao };
  C.aoIniciar(() => {
    C.carregarEstilo("estilos/parada.css");
    C.on("posicao", aoPosicao);
    C.on("sessao", (s) => { if (s) enviarPendentes(); });
    window.addEventListener("online", () => enviarPendentes());
    setTimeout(enviarPendentes, 5000);
  });
})(window.Copiloto);
