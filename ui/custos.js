// Custos da rota (v1): modo Padrão × Avançado da folha da rota. Lógica pura em custos.js (window.CopilotoCustos);
// contrato com o servidor em ARQUITETURA.md, "Custos da rota (v1)".
// - Padrão (o de sempre): tempo, distância e chegada; nenhum pedido de custo sai do aparelho.
// - Avançado: pedágio estimado (RPC copiloto_route_tolls), combustível estimado (RPC copiloto_route_fuel_price:
//   preço médio ANP × distância ÷ consumo do veículo) e o total; em cada cartão de alternativa, a diferença para a rota
//   principal ("+R$ 42 de pedágio").
// O modo fica em "copiloto.rota.modo.v1" e muda nas Configurações (grupo "Rota", criado aqui) ou no alternador da folha
// da rota (#rota-custos, lugar reservado por ui/rota.js, que emite "rota:folha" ao abrir a folha).
// Chamadas: as duas RPCs são públicas (GRANT a anon): nuvem.rpcPublica, só a chave publicável, sem token. Uma chamada de cada
// por rota (cache por desenho da rota + veículo/carga/produto), alternativas em paralelo com no máximo 4 pedidos ao mesmo
// tempo. Sem internet: "Custos precisam de internet." (tenta de novo quando a internet volta). Recusa de permissão
// (401/42501) fora da conta: "Entre na conta para ver custos." (hoje não acontece; defesa caso o servidor mude).
// Carga: a do cadastro do veículo ("Não informado" conta carregado, pelo lado caro), trocável aqui (Carregado/Vazio).
// Vazio: eixos suspensos não pagam; o cadastro não tem o campo, então pergunta uma vez por veículo (opcional; padrão 0),
// guardado em "copiloto.rota.suspensos.v1" = { <id do veículo>: n }.
// Expõe Copiloto.custos: modo(novo?), da(rota) → Promise do resumo, estado() (o que está na tela). Emite "custos:modo".
(function (C) {
  "use strict";
  const { $, el, botao, lerJSON, gravarJSON } = C.util;
  const K = window.CopilotoCustos;
  const CHAVE_SUSP = "copiloto.rota.suspensos.v1";
  const MAX_CACHE = 40, ESPERA_ERRO_MS = 10000;
  const limitar = K.criarLimitador(4);
  const cache = new Map();          // chave → { estado: "carregando"|"ok"|"erro", valor, erro, em }
  let modo = K.lerModo(C.util.storage());
  let cargaEscolhida = null;        // null = a do cadastro; true = carregado; false = vazio
  let ultimo = null;                // último resumo desenhado (para os testes e para quem quiser ler)

  // ------------------------------------------------------------ modo
  function definirModo(novo) {
    if (!K.MODOS.includes(novo)) return modo;
    if (novo !== modo) {
      modo = novo; K.salvarModo(C.util.storage(), novo);
      C.emit("custos:modo", { modo });
    }
    desenharConfig(); desenhar();
    return modo;
  }

  // ------------------------------------------------------------ servidor (com cache)
  function online() { return !(navigator && navigator.onLine === false); }
  function erroRede() { const e = new Error("sem internet"); e.rede = true; return e; }
  function guardar(chave, entrada) {
    cache.set(chave, entrada);
    if (cache.size > MAX_CACHE) { const velha = cache.keys().next().value; cache.delete(velha); }
  }
  // Devolve a entrada do cache e, se precisar, dispara o pedido (o fim chama desenhar() de novo).
  function pedir(chave, fn, forcar) {
    const e = cache.get(chave);
    if (e && (e.estado === "ok" || e.estado === "carregando")) return e;
    if (e && e.estado === "erro" && !forcar && Date.now() - e.em < ESPERA_ERRO_MS) return e;
    if (!online()) { const x = { estado: "erro", erro: erroRede(), em: Date.now() }; guardar(chave, x); return x; }
    const nova = { estado: "carregando", em: Date.now() };
    guardar(chave, nova);
    nova.promessa = limitar(fn).then((valor) => { nova.estado = "ok"; nova.valor = valor; },
      (erro) => { nova.estado = "erro"; nova.erro = erro || new Error("falhou"); nova.em = Date.now(); })
      .then(() => { if (cache.get(chave) === nova) desenhar(); });
    return nova;
  }

  function carregadoDe(perfil) {
    if (cargaEscolhida != null) return cargaEscolhida;
    if (perfil && perfil.carga === "Vazio") return false;
    if (perfil && perfil.carga === "Carregado") return true;
    return null; // não informado: os cálculos contam carregado
  }
  function suspensosGuardados(perfil) {
    const m = lerJSON(CHAVE_SUSP, {}) || {};
    const v = perfil && perfil.id != null ? m[perfil.id] : undefined;
    return Number.isInteger(v) ? v : null;
  }
  function guardarSuspensos(perfil, n) {
    if (!perfil || perfil.id == null) return;
    const m = lerJSON(CHAVE_SUSP, {}) || {};
    if (n == null) delete m[perfil.id]; else m[perfil.id] = n;
    gravarJSON(CHAVE_SUSP, m);
  }

  // Resumo de custos de uma rota (síncrono, do cache; dispara o que faltar). Retorna
  // { carregando, erro: null|"rede"|"conta"|"outro", pedagio, combustivel, preco, produto, total }.
  function resumo(rota, perfil, forcar) {
    const carregado = carregadoDe(perfil);
    const susp = suspensosGuardados(perfil);
    const rk = K.chaveRota(rota && rota.coords);
    const produto = K.produtoPara(perfil);
    const out = { carregando: false, erro: null, pedagio: null, combustivel: null, preco: null, produto, total: null };
    if (!rk) { out.pedagio = { ok: false, motivo: "Trace uma rota para estimar o pedágio." }; return out; }
    const erros = [];
    // pedágio
    const pp = K.paramsPedagio(rota.coords, perfil, { carregado, suspensos: susp == null ? 0 : susp });
    if (!pp.ok) out.pedagio = { ok: false, motivo: pp.motivo };
    else {
      const p = pp.params;
      const chave = ["pedagio", rk, p.p_axles, p.p_loaded, p.p_suspended_axles, p.p_vehicle_class].join("|");
      const e = pedir(chave, async () => {
        const resps = []; // um pedaço por vez (rota longa); o limitador de 4 vale por rota
        for (const r of pp.rotas) resps.push(await C.nuvem.rpcPublica("copiloto_route_tolls", Object.assign({}, p, { p_route: r })));
        return K.juntarPedagios(resps);
      }, forcar);
      if (e.estado === "ok") out.pedagio = K.resumoPedagio(e.valor);
      else if (e.estado === "erro") { erros.push(e.erro); out.pedagio = { ok: false, motivo: "Pedágio indisponível agora." }; }
      else out.carregando = true;
    }
    // combustível (o preço não depende da carga: uma chamada por rota e produto)
    const distanciaM = rota.km != null ? rota.km * 1000 : null;
    if (K.consumoPara(perfil, carregado) == null) out.combustivel = K.combustivel({ distanciaM, perfil, carregado, preco: null });
    else {
      const chave = ["combustivel", rk, produto].join("|");
      const e = pedir(chave, () => C.nuvem.rpcPublica("copiloto_route_fuel_price", { p_route: K.rotaGeoJSON(rota.coords), p_product: produto }), forcar);
      if (e.estado === "ok") {
        out.preco = K.precoDaResposta(e.valor);
        out.combustivel = K.combustivel({ distanciaM, perfil, carregado, preco: out.preco.ok ? out.preco.preco : null });
      } else if (e.estado === "erro") { erros.push(e.erro); out.combustivel = { ok: false, motivo: "Preço médio do combustível indisponível agora." }; }
      else out.carregando = true;
    }
    if (erros.some((x) => x && x.rede)) out.erro = "rede";
    else if (erros.some(precisaConta)) out.erro = "conta";
    else if (erros.length) out.erro = "outro";
    if (!out.carregando) out.total = K.totalViagem(out.pedagio, out.combustivel);
    return out;
  }
  function precisaConta(e) {
    if (!e) return false;
    const recusa = e.status === 401 || e.status === 403 || e.codigo === "42501" || e.codigo === "28000";
    let logado = false; try { logado = C.nuvem.logado(); } catch (x) { /* ignora */ }
    return recusa && !logado;
  }

  // ------------------------------------------------------------ folha da rota
  function linha(id, rotulo, partes, classe) {
    const p = el("p", "custos-linha" + (classe ? " " + classe : "")); p.id = id;
    const ic = { "custos-pedagio": "pedagio", "custos-combustivel": "bomba", "custos-total": "distancia" }[id];
    if (ic && window.CopilotoIcones) { const w = el("span", "custos-ico"); w.append(window.CopilotoIcones.no(ic)); p.append(w); } // r6: símbolo + rótulo
    p.append(el("span", "custos-rotulo", rotulo), " ");
    if (partes.valor) {
      p.append(el("span", "custos-valor", partes.valor));
      if (partes.nota) p.append(el("span", "custos-nota", (/^\(/.test(partes.nota) ? " " : " · ") + partes.nota));
    } else p.append(el("span", "custos-nota custos-falta", partes.nota || "indisponível"));
    return p;
  }

  function seletor(id, rotulo, opcoes, atual, aoEscolher, classe) {
    const g = el("div", "custos-seg " + (classe || "")); g.id = id;
    g.setAttribute("role", "radiogroup"); g.setAttribute("aria-label", rotulo);
    for (const [valor, texto] of opcoes) {
      const b = botao(texto, "custos-seg-btn", () => aoEscolher(valor));
      b.id = id + "-" + String(valor); b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(valor === atual));
      b.dataset.valor = String(valor);
      g.appendChild(b);
    }
    return g;
  }

  function desenharCartoes(perfil) {
    const cartoes = document.querySelectorAll("#folha .rota-opcao[data-i]");
    const alt = C.rota && C.rota.alternativas ? C.rota.alternativas() : null;
    for (const b of cartoes) {
      let s = b.querySelector(".rota-opcao-custo");
      if (modo !== "avancado" || !alt) { if (s) s.remove(); continue; }
      const i = Number(b.dataset.i), r = alt.rotas[i];
      if (!r) continue;
      if (!s) { s = el("span", "rota-opcao-custo"); b.appendChild(s); }
      const ri = resumo(r, perfil), r0 = i === 0 ? ri : resumo(alt.rotas[0], perfil);
      let texto = "";
      if (ri.carregando || r0.carregando) texto = "Calculando custos…";
      else if (ri.erro || r0.erro) texto = "";
      else if (i === 0) { const t = K.partesTotal(ri.total); texto = t.valor ? "Custo " + t.valor : ""; }
      else texto = K.textoDiferenca(K.compararRotas({ pedagio: r0.pedagio, combustivel: r0.combustivel }, { pedagio: ri.pedagio, combustivel: ri.combustivel }));
      s.textContent = texto; s.hidden = !texto;
      const base = (b.getAttribute("aria-label") || "").split(" · custo: ")[0];
      b.setAttribute("aria-label", texto ? base + " · custo: " + texto : base);
    }
  }

  function desenhar(forcar) {
    const caixa = document.getElementById("rota-custos");
    if (!caixa || !document.getElementById("folha").contains(caixa)) { ultimo = null; return; }
    const perfil = C.veiculos.ativo();
    const rota = C.rota.atual();
    caixa.textContent = "";
    caixa.dataset.modo = modo;
    caixa.appendChild(seletor("rota-modo", "Modo da rota", [["padrao", "Padrão"], ["avancado", "Avançado"]], modo, definirModo, "custos-modo"));
    if (modo !== "avancado" || !rota) { ultimo = null; desenharCartoes(perfil); return; }

    const r = resumo(rota, perfil, forcar);
    ultimo = r;
    const bloco = el("div", "custos-caixa"); bloco.id = "custos-caixa";
    bloco.setAttribute("aria-live", "polite");
    if (!perfil) {
      bloco.append(el("p", "custos-aviso", "Cadastre o veículo (eixos e consumo) para ver os custos."),
        botaoId("custos-ir-veiculo", "Cadastrar veículo", "btn", () => C.abas.irPara("veiculo")));
      caixa.appendChild(bloco); desenharCartoes(perfil); return;
    }
    if (r.erro === "rede") {
      bloco.appendChild(el("p", "custos-aviso", "Custos precisam de internet."));
      caixa.appendChild(bloco); desenharCartoes(perfil); return;
    }
    if (r.erro === "conta") {
      bloco.append(el("p", "custos-aviso", "Entre na conta para ver custos."),
        botaoId("custos-entrar", "Entrar na conta", "btn", () => C.abas.irPara("conta")));
      caixa.appendChild(bloco); desenharCartoes(perfil); return;
    }
    if (r.carregando) {
      bloco.appendChild(el("p", "custos-aviso custos-calculando", "Calculando pedágio e combustível…"));
    } else {
      bloco.appendChild(linha("custos-pedagio", "Pedágio", K.partesPedagio(r.pedagio)));
      const pc = K.partesCombustivel(r.combustivel, r.preco, r.produto);
      bloco.appendChild(linha("custos-combustivel", "Combustível", pc));
      bloco.appendChild(linha("custos-total", "Total", K.partesTotal(r.total), "custos-total"));
      const det = [];
      if (pc.detalhe) det.push(pc.detalhe + ".");
      for (const a of K.avisosPedagio(r.pedagio)) det.push(a);
      if (det.length) bloco.appendChild(el("p", "custos-detalhe", det.join(" ")));
    }
    // carga e eixos suspensos (mudam o pedágio e o consumo)
    const carregado = carregadoDe(perfil);
    bloco.appendChild(seletor("custos-carga", "Carga", [[true, "Carregado"], [false, "Vazio"]], carregado !== false,
      (v) => { cargaEscolhida = v; desenhar(); }, "custos-carga"));
    if (carregado == null) bloco.appendChild(el("p", "custos-detalhe", "Carga não informada no cadastro: contada como carregado."));
    const possiveis = K.suspensosPossiveis(perfil.eixos);
    if (carregado === false && possiveis.length > 1) {
      const susp = suspensosGuardados(perfil);
      if (susp == null) {
        bloco.appendChild(el("p", "custos-pergunta", "Quantos eixos ficam suspensos vazio? Eixo suspenso não paga pedágio. (Opcional; sem resposta, conta 0.)"));
        bloco.appendChild(seletor("custos-susp", "Eixos suspensos", possiveis.map((n) => [n, String(n)]), null,
          (n) => { guardarSuspensos(perfil, n); desenhar(); }, "custos-susp"));
      } else {
        bloco.appendChild(botaoId("custos-susp-mudar", "Eixos suspensos: " + (susp === 0 ? "nenhum" : susp) + " · mudar", "btn custos-mudar",
          () => { guardarSuspensos(perfil, null); desenhar(); }));
      }
    }
    if (!r.carregando) bloco.appendChild(el("p", "custos-fonte", "Estimativa. Pedágio: praças ANTT/OpenStreetMap e tarifas publicadas. Combustível: preço médio de revenda da ANP."));
    caixa.appendChild(bloco);
    desenharCartoes(perfil);
  }
  function botaoId(id, texto, classe, fn) { const b = botao(texto, classe, fn); b.id = id; return b; }

  // ------------------------------------------------------------ Configurações (grupo "Rota")
  function criarConfig() {
    if ($("cfg-rota-modo")) return;
    const tela = $("tela-config"); if (!tela) return;
    const grupo = el("div", "cfg-grupo"); grupo.id = "cfg-rota";
    const t = el("h2", "cfg-titulo", "Rota"); t.id = "cfg-rota-titulo";
    const seg = el("div", "cfg-seg cfg-seg-2 custos-cfg"); seg.id = "cfg-rota-modo";
    seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-labelledby", "cfg-rota-titulo");
    for (const [v, txt] of [["padrao", "Padrão"], ["avancado", "Avançado"]]) {
      const b = el("button", null, txt); b.type = "button"; b.id = "cfg-rota-" + v; b.dataset.rotaModo = v;
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false");
      b.addEventListener("click", () => definirModo(v));
      seg.appendChild(b);
    }
    const dica = el("p", "dica", "Padrão: tempo, distância e chegada. Avançado: também pedágio e combustível estimados e o total.");
    dica.id = "cfg-rota-dica";
    grupo.append(t, seg, dica);
    const menu = tela.querySelector(".cfg-menu");
    tela.insertBefore(grupo, menu || null);
  }
  function desenharConfig() {
    for (const b of document.querySelectorAll("#cfg-rota-modo [data-rota-modo]")) b.setAttribute("aria-checked", String(b.dataset.rotaModo === modo));
  }

  C.custos = {
    modo: (novo) => (novo === undefined ? modo : definirModo(novo)),
    // resumo de uma rota (espera os pedidos): para outros pacotes e testes
    da: async (rota, perfil) => {
      const p = perfil !== undefined ? perfil : C.veiculos.ativo();
      let r = resumo(rota, p);
      for (let i = 0; i < 3 && r.carregando; i++) {
        await Promise.all([...cache.values()].filter((e) => e.estado === "carregando").map((e) => e.promessa));
        r = resumo(rota, p);
      }
      return r;
    },
    estado: () => ultimo,
  };

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/custos.css");
    criarConfig(); desenharConfig();
    C.on("aba", (id) => { if (id === "config") desenharConfig(); });
    C.on("rota:folha", () => desenhar());
    C.on("rota", () => desenhar());                      // alternativa escolhida: o bloco mostra a escolhida
    C.on("veiculo", () => { cargaEscolhida = null; desenhar(); });
    C.on("sessao", () => desenhar(true));
    window.addEventListener("online", () => desenhar(true));
    window.addEventListener("offline", () => desenhar());
  });
})(window.Copiloto);
