// Limite de velocidade da via (lacuna 3 do docs/COMPARATIVO_WAZE.md). Lógica pura em limite.js.
// Placa redonda (borda vermelha, número) dentro do velocímetro (.velocidade), só quando há limite conhecido no ponto da
// rota onde o caminhão está; "estimado" embaixo quando o valor vem do CTB pelo tipo de via. Acima de limite + tolerância
// o velocímetro fica vermelho e sai um aviso falado curto, uma vez por trecho, pela fila de falas (naoInterromper: não
// corta manobra, alerta nem o microfone aberto; espera a fala que estiver tocando).
// Fonte: pedido separado ao Valhalla (/trace_attributes, edge_walk) com a forma da rota já traçada — não mexe no pedido
// de rota (ui/rota.js). Um pedido por rota (cache em memória e em localStorage "copiloto.limite.v1", as 3 últimas);
// sem internet usa o guardado (a rota guardada do E3 tem a mesma forma, então a mesma chave). Sem dados, sem placa.
// Sem rota não há fonte (o mapa da OpenFreeMap não tem maxspeed): sem placa.
// Ouve: "rota", "rota-limpa", "navegacao" (rota offline/guardada), "posicao", "gps-sinal", "veiculo".
// Configuração na aba Conta (cartão "Limite de velocidade", chave "copiloto.limite.config.v1"): mostrar, tolerância, aviso falado.
// Expõe Copiloto.limite: atual() ({ kmh, fonte, estimado } ou null), excesso(), config(), dados() (resumo da rota carregada).
(function (C) {
  "use strict";
  const { $, el } = C.util;
  const L = window.CopilotoLimite;
  const Rota = window.CopilotoRota;
  let cfg = L.lerConfig(C.util.storage());
  const aviso = L.criarAviso();
  let reg = null;            // { chave, coords, caminhao, trechos, completo }
  let dica = null, mostrado = null, excesso = false;
  const buscando = new Map(); // chave → true (um pedido por rota de cada vez)
  let esperaRede = null, tentativas = 0;
  let placa = null, num = null, rot = null;

  // ------------------------------------------------------------ dados da rota
  function urlTrace() {
    if (window.COPILOTO_URL_TRACE) return window.COPILOTO_URL_TRACE;
    const r = window.COPILOTO_URL_ROTA;
    return r && /\/route$/.test(r) ? r.replace(/\/route$/, "/trace_attributes") : L.URL_TRACE_PADRAO;
  }
  function online() { return !(navigator && navigator.onLine === false); }

  function usarRota(coords, perfil) {
    if (!Array.isArray(coords) || coords.length < 2) { limpar(); return; }
    const caminhao = Rota.ehCaminhao(perfil);
    const chave = L.chaveRota(coords, caminhao);
    if (reg && reg.chave === chave) return;
    reg = { chave, coords, caminhao, trechos: [], completo: false };
    dica = null; aviso.reiniciar(); tentativas = 0; clearTimeout(esperaRede); esperaRede = null;
    const g = L.buscarGuardado(C.util.storage(), chave);
    if (g) { reg.trechos = g.trechos; reg.completo = g.completo; }
    if (!reg.completo) buscar(reg);
    redesenhar();
  }
  function limpar() {
    reg = null; dica = null; aviso.reiniciar(); clearTimeout(esperaRede); esperaRede = null;
    esconder();
  }

  async function pedirPedaco(coords, caminhao) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const resp = await fetch(urlTrace(), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(L.pedidoTrace(coords, caminhao)), signal: ctl.signal });
      return { json: await resp.json().catch(() => null) };
    } catch (e) { return { rede: true }; } finally { clearTimeout(t); }
  }
  async function buscar(r) {
    if (buscando.has(r.chave)) return;
    if (!online()) return; // volta no evento "online"
    buscando.set(r.chave, true);
    const trechos = [];
    let completo = true, rede = false;
    try {
      for (const p of L.dividir(r.coords)) {
        const res = await pedirPedaco(r.coords.slice(p.de, p.ate + 1), r.caminhao);
        if (res.rede) { completo = false; rede = true; break; }
        // o servidor não casou este pedaço com o mapa (raro com a forma dele mesmo): fica sem limite, sem repetir
        try { trechos.push(...L.trechosDaResposta(res.json, p.de, r.caminhao)); } catch (e) { /* sem limite neste pedaço */ }
      }
    } finally { buscando.delete(r.chave); }
    if (rede) {
      // sem rede: tenta de novo na volta da internet ou daqui a 60 s, 120 s… (máx. 5 min), sem laço
      if (reg === r && !esperaRede) {
        const ms = Math.min(300000, 60000 * Math.pow(2, tentativas++));
        esperaRede = setTimeout(() => { esperaRede = null; if (reg === r) buscar(r); }, ms);
      }
      if (!trechos.length) return;
    }
    r.trechos = L.juntar(r.trechos.concat(trechos));
    r.completo = completo;
    L.guardar(C.util.storage(), { chave: r.chave, n: r.coords.length, salvoEm: Date.now(), completo, trechos: r.trechos });
    if (reg === r) redesenhar();
    C.emit("limite:dados", { chave: r.chave, trechos: r.trechos.length, completo });
  }

  // ------------------------------------------------------------ onde estou e o que mostrar
  function redesenhar() { const g = C.estado.gps; if (g) avaliar(g); else esconder(); }
  function avaliar(g) {
    if (!cfg.mostrar || !reg || !reg.trechos.length || !g || (C.gps && C.gps.velho && C.gps.velho())) { esconder(); return; }
    const maxM = Math.min(60, Math.max(30, (g.precisao || 0) * 1.5));
    const rumo = typeof g.rumo === "number" && isFinite(g.rumo) ? g.rumo : null;
    const loc = L.localizar(reg.coords, [g.lon, g.lat], { dica, rumo, maxM });
    if (!loc) { esconder(); return; } // fora da rota: não há dado aqui
    dica = loc.indice;
    const t = L.trechoDoIndice(reg.trechos, loc.indice);
    if (!t) { esconder(); return; }
    mostrar(t);
    const r = aviso.atualizar({ kmh: g.kmh, limite: t.kmh, trecho: reg.chave + ":" + t.i0, tol: cfg.tolerancia });
    pintar(r.excesso);
    if (r.avisar && cfg.som) falarAviso(t.kmh);
  }
  function mostrar(t) {
    if (!placa) return;
    mostrado = { kmh: t.kmh, fonte: t.fonte, estimado: !!t.estimado };
    const texto = String(t.kmh);
    if (num.textContent !== texto) num.textContent = texto;
    rot.hidden = !t.estimado;
    placa.dataset.fonte = t.fonte;
    placa.setAttribute("aria-label", "Limite " + t.kmh + " km/h" + (t.estimado ? ", estimado pelo tipo de via" : t.fonte === "placa-caminhao" ? " para caminhão" : ""));
    placa.title = t.estimado ? "Limite estimado pelo tipo de via (CTB, art. 61). Confira a placa." : "Limite da via (OpenStreetMap). Confira a placa.";
    if (placa.hidden) placa.hidden = false;
    const vel = placa.parentNode;
    if (vel && !vel.classList.contains("limite-com-placa")) vel.classList.add("limite-com-placa");
  }
  function esconder() {
    mostrado = null;
    pintar(false);
    if (!placa) return;
    if (!placa.hidden) placa.hidden = true;
    const vel = placa.parentNode;
    if (vel && vel.classList.contains("limite-com-placa")) vel.classList.remove("limite-com-placa");
  }
  function pintar(v) {
    excesso = !!v;
    const vel = placa && placa.parentNode;
    if (vel && vel.classList.contains("limite-excesso") !== excesso) vel.classList.toggle("limite-excesso", excesso);
  }

  // Aviso falado: espera qualquer fala tocando, alerta, manobra e o microfone (não corta nada); desiste em ~6 s ou se
  // o excesso acabou. A fila de falas (naoInterromper) segura de novo se algo começar no meio.
  function falarAviso(kmh) {
    if (!C.voz || typeof C.voz.falar !== "function") return;
    const ate = Date.now() + 6000;
    const ocupado = () => (C.voz.falando && C.voz.falando()) || (C.voz.emAlerta && C.voz.emAlerta()) ||
      (C.voz.emManobra && C.voz.emManobra()) || (C.comandos && typeof C.comandos.ouvindo === "function" && C.comandos.ouvindo());
    const tentar = () => {
      if (!excesso || !mostrado || mostrado.kmh !== kmh) return;
      if (ocupado()) { if (Date.now() < ate) setTimeout(tentar, 250); return; }
      C.voz.falar(L.textoAviso(kmh), { naoInterromper: true, esperaMaxMs: 4000 });
      C.emit("limite:aviso", { kmh });
    };
    tentar();
  }

  // ------------------------------------------------------------ configuração (aba Conta)
  const TOLERANCIAS = [
    ["radar:7", "+7 km/h (acima de 100: +7 %)"],
    ["kmh:0", "Sem margem"],
    ["kmh:5", "+5 km/h"],
    ["kmh:10", "+10 km/h"],
    ["pct:10", "+10 %"],
  ];
  function criarCartao() {
    const tela = $("tela-conta");
    if (!tela || $("limite-cartao")) return;
    const cartao = el("div", "cartao limite-cartao"); cartao.id = "limite-cartao";
    const linha = (id, texto, marcado) => {
      const r = el("label", "linha-check"); r.htmlFor = id;
      const cx = document.createElement("input"); cx.type = "checkbox"; cx.id = id; cx.checked = marcado;
      r.append(cx, " " + texto); return { r, cx };
    };
    const ver = linha("limite-mostrar", "Mostrar o limite da via (com rota traçada)", cfg.mostrar);
    const som = linha("limite-som", "Aviso falado ao passar do limite", cfg.som);
    const rotTol = el("label"); rotTol.htmlFor = "limite-tolerancia"; rotTol.append("Margem antes de avisar");
    const sel = document.createElement("select"); sel.id = "limite-tolerancia";
    for (const [v, t] of TOLERANCIAS) sel.add(new Option(t, v));
    const atualTol = cfg.tolerancia.modo + ":" + cfg.tolerancia.valor;
    if (!TOLERANCIAS.some(([v]) => v === atualTol)) sel.add(new Option("+" + cfg.tolerancia.valor + (cfg.tolerancia.modo === "pct" ? " %" : " km/h"), atualTol));
    sel.value = atualTol;
    rotTol.append(sel);
    const dicaTxt = "Vem do OpenStreetMap, pelo servidor de rotas, só para a rota traçada. \"estimado\": a via não tem placa de " +
      "caminhão no mapa e o valor é o do CTB (art. 61) para o tipo de via (rodovia 90 km/h para caminhão e ônibus; estrada de terra 60). " +
      "Onde o mapa não sabe, a placa some. Vale sempre a placa da estrada.";
    cartao.append(el("h2", null, "Limite de velocidade"), ver.r, rotTol, som.r, el("p", "dica", dicaTxt));
    const voz = $("cartao-voz");
    if (voz && voz.parentNode === tela) voz.after(cartao); else tela.appendChild(cartao);
    const salvar = () => {
      const [modo, valor] = sel.value.split(":");
      cfg = L.normalizarConfig({ mostrar: ver.cx.checked, som: som.cx.checked, tolerancia: { modo, valor: Number(valor) } });
      L.gravarConfig(C.util.storage(), cfg);
      redesenhar();
    };
    for (const e of [ver.cx, som.cx, sel]) e.addEventListener("change", salvar);
  }

  function criarPlaca() {
    const vel = document.querySelector(".painel-mapa > .velocidade");
    if (!vel || $("limite-placa")) return;
    placa = el("div", "limite-placa"); placa.id = "limite-placa"; placa.hidden = true; placa.setAttribute("role", "img");
    num = el("div", "limite-num"); rot = el("div", "limite-rotulo", "estimado"); rot.hidden = true;
    const circulo = el("div", "limite-circulo"); circulo.append(num);
    placa.append(circulo, rot);
    vel.insertBefore(placa, vel.firstChild);
  }

  C.limite = {
    atual: () => (mostrado ? Object.assign({}, mostrado) : null),
    excesso: () => excesso,
    config: () => JSON.parse(JSON.stringify(cfg)),
    dados: () => (reg ? { chave: reg.chave, caminhao: reg.caminhao, trechos: reg.trechos.map((t) => Object.assign({}, t)), completo: reg.completo } : null),
  };

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/limite.css");
    criarPlaca();
    criarCartao();
    C.on("rota", (r) => usarRota(r && r.coords, r && r.perfil !== undefined ? r.perfil : C.veiculos.ativo()));
    C.on("rota-limpa", limpar);
    C.on("navegacao", (d) => {
      if (!d || !d.ativa || !Array.isArray(d.coords)) return;
      if (reg && reg.coords === d.coords) return;
      const r = C.rota.atual();
      usarRota(d.coords, r && r.coords === d.coords ? r.perfil : C.veiculos.ativo());
    });
    C.on("veiculo", (perfil) => { if (reg) { const c = reg.coords; reg = null; usarRota(c, perfil); } });
    C.on("posicao", avaliar);
    C.on("gps-sinal", (s) => { if (s && !s.ok) esconder(); });
    window.addEventListener("online", () => { if (reg && !reg.completo) { tentativas = 0; clearTimeout(esperaRede); esperaRede = null; buscar(reg); } });
  });
})(window.Copiloto);
