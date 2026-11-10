// Placas no app: lista de avisos (folha), marcadores com placa e a tela "Placas e sinais". Lógica de desenho em placas.js
// (window.CopilotoPlacas, também em Copiloto.placas). Expõe Copiloto.lista:
//   abrir({ foco?, centro? })   abre a folha "Avisos no trajeto": avisos da rota, rampas (ui/via.js), relatos e postos, agrupados
//                               por severidade (restrição > atenção > informativo) e, em cada grupo, por distância (ao longo da
//                               rota; sem rota, ao ponto tocado ou ao GPS). Toque no item: centraliza o mapa e mostra o detalhe.
//   itens({ centro? })          os mesmos itens, sem desenhar (testes)
//   preencherMarca(div, id, { valor, leitor, tamanho })   põe a placa (e o texto só para o leitor de tela) num marcador do mapa
//   botaoPopup(lat, lon)        botão "Avisos por aqui" para os popups de relato
// Só mostra o que o app já tem; nada é inventado. Offline: tudo vem da memória/armazenamento do aparelho.
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const PL = window.CopilotoPlacas;
  C.carregarEstilo("estilos/placas.css");
  C.carregarEstilo("estilos/lista.css");
  C.placas = PL;

  const RAIO_PONTO_M = 5000, BUFFER_ROTA_M = 300;
  let progressoM = null, navAtiva = false;
  let focoMarca = null, ultima = null;

  const rotaAtual = () => { const r = C.rota && C.rota.atual && C.rota.atual(); return r && Array.isArray(r.coords) && r.coords.length > 1 ? r : null; };
  const navegando = () => { const a = $("app"); return !!(a && a.classList.contains("nav-ativa")); };

  // ------------------------------------------------------------ texto
  function textoDist(m) {
    if (m < 50) return "aqui";
    const t = m < 1000 ? Math.round(m / 10) * 10 + " m" : m < 10000 ? (Math.round(m / 100) / 10).toFixed(1).replace(".", ",") + " km" : Math.round(m / 1000) + " km";
    return "a " + t;
  }
  function idadeTexto(ms) {
    if (!isFinite(ms) || ms < 0) return "";
    const min = Math.round(ms / 60000);
    if (min < 2) return "agora há pouco";
    if (min < 120) return "há " + min + " min";
    const h = Math.round(min / 60);
    if (h < 48) return "há " + h + " h";
    return "há " + Math.round(h / 24) + " dias";
  }
  const pos = (i) => [i.lon, i.lat];
  function distMetros(a, b) {
    const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ------------------------------------------------------------ coleta
  function pctDaRampa(e, t) {
    let m = null;
    for (const run of e.runs || []) {
      if (run.i0 < t.i0 - 1 || run.i1 > t.i1 + 1 || run.rampa === 0) continue;
      const v = t.sentido === "subida" ? run.sobe : run.desce == null ? null : -run.desce;
      if (typeof v === "number" && isFinite(v) && (m == null || v > m)) m = v;
    }
    return m == null ? null : Math.round(m);
  }
  function relatosNuvem() {
    const N = window.CopilotoNuvem, R = window.CopilotoRelatos;
    const out = [];
    for (const r of (C.comunidade && C.comunidade.relatos ? C.comunidade.relatos() : [])) {
      const tipo = N.tipoParaApp(r.report_type); if (!tipo || !R.TIPOS[tipo] || !isFinite(r.lat)) continue;
      const onde = N.textoRodovia ? N.textoRodovia(r) : "";
      const cr = Date.parse(r.created_at);
      out.push({ id: "relato:" + r.id, origem: "relato", tipo, valor: r.value_numeric == null ? null : Number(r.value_numeric), titulo: R.titulo({ tipo, valor: r.value_numeric == null ? null : Number(r.value_numeric) }),
        lat: r.lat, lon: r.lon, via: onde || "", fonte: "Relato de motoristas", idade: isFinite(cr) ? idadeTexto(Date.now() - cr) : "", detalhe: r.mine ? "Relato seu" : "" });
    }
    for (const r of (C.relatos && C.relatos.locais ? C.relatos.locais() : [])) {
      if (!R.TIPOS[r.tipo] || !isFinite(r.lat)) continue;
      out.push({ id: "local:" + r.id, origem: "relato", tipo: r.tipo, valor: r.valor == null ? null : Number(r.valor), titulo: R.titulo(r), lat: r.lat, lon: r.lon, via: "",
        fonte: "Relato seu, neste aparelho", idade: idadeTexto(Date.now() - r.criadoEm), detalhe: "" });
    }
    return out;
  }
  function postos() {
    const P = window.CopilotoPostos, out = [];
    for (const p of (C.postos && C.postos.naVista ? C.postos.naVista() : [])) {
      if (!isFinite(p.lat) || !isFinite(p.lon)) continue;
      out.push({ id: "posto:" + p.station_key, origem: "posto", tipo: "posto", valor: null, titulo: P && P.nomePosto ? P.nomePosto(p) : "Posto", lat: p.lat, lon: p.lon, via: "",
        fonte: p.source === "osm" ? "OpenStreetMap" : "Cadastro ANP / OpenStreetMap", idade: "", detalhe: "" });
    }
    return out;
  }

  // centro: { lat, lon } (ponto tocado). Com rota: ordem ao longo dela (o que já passou some navegando). Sem rota: distância ao centro.
  function itens(o) {
    o = o || {};
    const r = rotaAtual(), lista = [];
    const D = window.CopilotoDados, L = window.CopilotoLimite;
    const sevDe = (t) => PL.severidade(t);
    const novo = (x) => Object.assign({ placa: PL.idDoTipo(x.tipo), sev: sevDe(x.tipo) }, x);
    if (r) {
      const e0 = C.dadosRota && C.dadosRota.estado ? C.dadosRota.estado(r) : null;
      const base = navAtiva && progressoM != null ? progressoM : 0;
      for (const a of (C.dadosRota && C.dadosRota.avisosDe ? C.dadosRota.avisosDe(r) : [])) {
        const dist = a.ao_longo_m - base; if (navAtiva && dist < -40) continue;
        const fonte = a.fonteInfo || (a.fonte ? String(a.fonte).replace(/^Fonte:\s*/i, "") : "");
        lista.push(novo({ id: "aviso:" + a.id, origem: "aviso", tipo: a.tipo, valor: null, titulo: a.texto, lat: a.lat, lon: a.lon, dist: Math.max(0, dist), via: a.detalhe || "",
          fonte, idade: e0 && e0.guardado ? "dado guardado no aparelho" : "", detalhe: "" }));
      }
      const via = C.via && C.via.obter ? C.via.obter(r) : null;
      if (via && via.estado === "ok" && via.resumo) {
        for (const t of via.resumo.trechosRampaAlta) {
          const dist = t.kmIni * 1000 - base; if (navAtiva && dist < -40) continue;
          const p = r.coords[t.i0], pct = pctDaRampa(via, t);
          lista.push(novo({ id: "rampa:" + t.i0, origem: "rampa", tipo: t.sentido, valor: pct, titulo: (t.sentido === "subida" ? "Subida" : "Descida") + " forte", lat: p[1], lon: p[0], dist: Math.max(0, dist),
            via: (t.km >= 1 ? String(Math.round(t.km * 10) / 10).replace(".", ",") + " km de extensão" : Math.round(t.km * 1000) + " m de extensão"), fonte: "Relevo do mapa (OpenStreetMap), estimado", idade: "", detalhe: "" }));
        }
      }
      const acum = D.acumuladoM(r.coords);
      for (const x of relatosNuvem().concat(postos())) {
        const loc = L.localizar(r.coords, pos(x), { maxM: BUFFER_ROTA_M }); if (!loc) continue;
        const ao = D.progressoM(r.coords, acum, loc.indice, pos(x)); if (ao == null) continue;
        const dist = ao - base; if (navAtiva && dist < -40) continue;
        lista.push(novo(Object.assign(x, { dist: Math.max(0, dist) })));
      }
    } else {
      const g = C.estado && C.estado.gps;
      const c = o.centro || (g ? { lat: g.lat, lon: g.lon } : null);
      if (c) for (const x of relatosNuvem().concat(postos())) { const d = distMetros(c, x); if (d <= RAIO_PONTO_M) lista.push(novo(Object.assign(x, { dist: d }))); }
    }
    const ordem = { restricao: 0, atencao: 1, informativo: 2 };
    lista.sort((a, b) => ordem[a.sev] - ordem[b.sev] || a.dist - b.dist);
    return lista;
  }

  // ------------------------------------------------------------ marcadores
  function preencherMarca(div, id, o) {
    o = o || {};
    div.textContent = "";
    if (!PL || !PL.existe(id)) { div.textContent = o.leitor || "!"; return div; }
    div.classList.add("com-placa");
    div.append(PL.placa(id, { valor: o.valor, tamanho: o.tamanho || 34, decorativa: true }));
    if (o.leitor) div.append(el("span", "so-leitor", o.leitor));
    return div;
  }
  function botaoPopup(lat, lon) {
    const b = botao("Avisos por aqui", "popup-lista", () => abrir({ centro: { lat, lon } }));
    return b;
  }
  function limparFoco() { if (focoMarca) { focoMarca.remove(); focoMarca = null; } }
  function marcarFoco(i) {
    limparFoco();
    C.mapaPronto(() => {
      const d = el("div", "la-foco");
      d.append(PL.placa(i.placa, { valor: i.valor, tamanho: 56, decorativa: true }));
      focoMarca = new maplibregl.Marker({ element: d }).setLngLat(pos(i)).addTo(C.mapa);
    });
  }

  // ------------------------------------------------------------ folha
  function linhaItem(i, foco, aoTocar) {
    const b = el("button", "la-item" + (foco && foco === i.id ? " foco" : "")); b.type = "button"; b.dataset.id = i.id; b.dataset.sev = i.sev; b.dataset.dist = String(Math.round(i.dist || 0));
    const ico = el("span", "la-placa"); ico.append(PL.placa(i.placa, { valor: i.valor, tamanho: 48, decorativa: true }));
    const txt = el("span", "la-txt");
    const linha1 = el("span", "la-l1"); linha1.append(el("b", "la-nome", i.titulo), el("span", "la-dist", i.dist == null ? "" : textoDist(i.dist)));
    txt.append(linha1);
    if (i.via) txt.append(el("span", "la-via", i.via));
    const fi = [i.fonte, i.idade].filter(Boolean).join(" · ");
    if (fi) txt.append(el("span", "la-fonte", fi));
    b.append(ico, txt);
    b.setAttribute("aria-label", [i.titulo + (i.valor != null && i.tipo !== "altura_maxima" && i.tipo !== "limite_peso" ? " " + i.valor + "%" : ""), i.dist == null ? "" : textoDist(i.dist), i.via, fi].filter(Boolean).join(", "));
    b.addEventListener("click", () => aoTocar(i));
    return b;
  }
  function detalhe(i, voltar) {
    marcarFoco(i);
    try { C.mapaPronto(() => C.mapa.easeTo({ center: pos(i), zoom: Math.max(C.mapa.getZoom(), 13.5), duration: 450 })); } catch (e) { /* ignora */ }
    const cab = el("div", "la-det-cab");
    cab.append(PL.placa(i.placa, { valor: i.valor, tamanho: 72, decorativa: true }));
    const t = el("div", "la-det-txt"); t.append(el("h2", null, i.titulo));
    t.append(el("p", "la-det-dist", i.dist == null ? "" : textoDist(i.dist) + (i.origem === "aviso" || i.origem === "rampa" ? (rotaAtual() ? " no trajeto" : "") : "")));
    cab.append(t);
    const nos = [cab, el("p", "la-sev " + i.sev, PL.ROTULO_SEVERIDADE[i.sev])];
    if (i.valor != null && i.origem === "rampa") nos.push(el("p", "la-det", "Inclinação de até " + i.valor + "%."));
    else if (i.valor != null) nos.push(el("p", "la-det", "Valor relatado: " + PL.fmt(i.valor) + (i.tipo === "altura_maxima" ? " m" : i.tipo === "limite_peso" ? " t" : "") + "."));
    if (i.via) nos.push(el("p", "la-det", i.via));
    if (i.detalhe) nos.push(el("p", "la-det", i.detalhe));
    const fi = [i.fonte, i.idade].filter(Boolean).join(" · ");
    nos.push(el("p", "la-det la-fonte", fi ? "Fonte: " + fi : "Fonte não informada"));
    nos.push(el("p", "la-det", PL.catalogo().find((c) => c.id === i.placa).significado));
    const bot = el("div", "linha-botoes");
    const v = botao("Voltar à lista", "btn", () => { limparFoco(); voltar(); }); v.id = "la-voltar";
    const f = botao("Fechar", "btn", () => { limparFoco(); C.folha.fechar(); }); f.id = "la-fechar-det";
    bot.append(v, f); nos.push(bot);
    C.folha.abrir(nos);
  }
  function abrir(o) {
    o = o || {};
    limparFoco();
    ultima = o;
    const lista = itens(o);
    const nav = navegando();
    const topo = el("div", "folha-topo la-topo");
    const h = el("h2", null, rotaAtual() ? "Avisos no trajeto" : "Avisos por aqui"); h.id = "la-titulo";
    const fechar = botao("Fechar", "btn la-fechar", () => { limparFoco(); C.folha.fechar(); }); fechar.id = "la-fechar";
    topo.append(h, fechar);
    const corpo = el("div", "la-lista" + (nav ? " nav" : "")); corpo.id = "la-lista";
    corpo.setAttribute("aria-labelledby", "la-titulo");
    if (!lista.length) {
      const v = el("p", "la-vazio", "Nenhum aviso neste trecho"); v.id = "la-vazio";
      corpo.append(v, el("p", "la-vazio-dica", rotaAtual() ? "O app só mostra o que tem: avisos da rota, rampas, relatos de motoristas e postos." : "Nada perto deste ponto. Trace uma rota para ver os avisos do trajeto."));
    } else {
      for (const sev of ["restricao", "atencao", "informativo"]) {
        const g = lista.filter((x) => x.sev === sev); if (!g.length) continue;
        const sec = el("section", "la-grupo la-" + sev); sec.dataset.sev = sev;
        const gh = el("h3", "la-grupo-titulo", PL.ROTULO_SEVERIDADE[sev] + " (" + g.length + ")");
        sec.append(gh);
        for (const i of g) sec.append(linhaItem(i, o.foco, (x) => detalhe(x, () => abrir(o))));
        corpo.append(sec);
      }
    }
    C.folha.abrir([topo, corpo]);
    const f = $("folha"); if (f) f.scrollTop = 0;
    if (o.foco) { const b = corpo.querySelector('.la-item[data-id="' + String(o.foco).replace(/"/g, "") + '"]'); if (b) b.scrollIntoView({ block: "center" }); }
  }

  // ------------------------------------------------------------ tela "Placas e sinais"
  function montarCatalogo(tela) {
    tela.textContent = "";
    tela.append(el("h1", null, "Placas e sinais"));
    tela.append(el("p", "dica", "Os desenhos que o app usa nos avisos do mapa e da navegação. Toque na placa que você vê na tela para saber o que ela quer dizer."));
    const todas = PL.catalogo();
    const busca = el("input", "pl-busca"); busca.type = "search"; busca.id = "pl-busca"; busca.placeholder = "Buscar placa (ex.: curva, neblina, peso)";
    busca.autocomplete = "off"; busca.setAttribute("aria-label", "Buscar placa pelo nome ou significado"); busca.enterKeyHint = "search";
    const vazio = el("p", "dica pl-vazio", "Nenhuma placa com esse nome. Tente outra palavra."); vazio.hidden = true; vazio.setAttribute("role", "status");
    tela.append(busca, vazio);
    for (const cat of ["advertencia", "regulamentacao", "indicacao"]) {
      const g = todas.filter((p) => p.categoria === cat); if (!g.length) continue;
      const sec = el("section", "pl-grupo"); sec.dataset.categoria = cat;
      sec.append(el("h2", "pl-grupo-titulo", PL.CATEGORIAS[cat] + " (" + g.length + ")"));
      const grade = el("ul", "pl-grade");
      for (const p of g) {
        const li = el("li", "pl-card"); li.dataset.placa = p.id;
        const ex = p.valor ? p.valor.exemplo : null;
        const ico = el("span", "pl-ico"); ico.append(PL.placa(p.id, { valor: ex, tamanho: 64, decorativa: true }));
        const t = el("span", "pl-txt");
        t.append(el("b", null, p.nome), el("span", null, p.significado));
        if (p.valor) t.append(el("small", null, "Exemplo com " + PL.fmt(ex) + (p.valor.unidade === "%" ? "%" : " " + p.valor.unidade) + "."));
        li.append(ico, t); grade.append(li);
      }
      sec.append(grade); tela.append(sec);
    }
    const sa = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const textos = new Map(todas.map((p) => [p.id, sa(p.nome + " " + p.significado)]));
    busca.addEventListener("input", () => {
      const termos = sa(busca.value).split(/\s+/).filter(Boolean); let total = 0;
      tela.querySelectorAll(".pl-card").forEach((li) => { const t = textos.get(li.dataset.placa) || ""; const ok = termos.every((x) => t.includes(x)); li.hidden = !ok; if (ok) total++; });
      tela.querySelectorAll(".pl-grupo").forEach((g) => { g.hidden = !g.querySelector(".pl-card:not([hidden])"); });
      vazio.hidden = total > 0;
    });
    tela.append(el("p", "dica", "Cores e formas seguem o padrão das placas brasileiras (amarelo: perigo; círculo vermelho: regra; azul e verde: informação). Desenhos próprios do app; vale sempre a placa da estrada."));
  }
  function criarMenu() {
    const menu = document.querySelector("#tela-config .cfg-menu"); if (!menu || $("nav-placas")) return;
    const b = el("button"); b.type = "button"; b.id = "nav-placas";
    b.append(el("span", "cfg-item", "Placas e sinais"), el("small", "cfg-valor", "Ver"));
    const titulos = menu.querySelectorAll(".cfg-menu-titulo"), antes = titulos[2] || null; // fim do grupo "Tela e mapa" (ajuda visual); sem grupo novo no menu
    menu.insertBefore(b, antes);
    if (window.CopilotoIcones) window.CopilotoIcones.prefixar(b.querySelector(".cfg-item"), "aviso");
    return b;
  }

  // ------------------------------------------------------------ gancho: folha da rota (botão discreto)
  C.rotaExtras = C.rotaExtras || { folha: [], cartao: [] };
  C.rotaExtras.folha.push(function (r) {
    if (!r || !Array.isArray(r.coords)) return null;
    const b = botao("", "btn la-abrir", () => abrir({})); b.id = "la-abrir";
    b.append(PL.placa("atencao", { tamanho: 28, decorativa: true }), el("span", null, "Avisos no trajeto"));
    return b;
  });

  C.lista = { abrir, itens, preencherMarca, botaoPopup, textoDist, idadeTexto };
  C.aoIniciar(() => {
    const botaoMenu = criarMenu();
    const tela = C.abas.registrar({ id: "placas", rotulo: "Placas e sinais", botao: botaoMenu || undefined, aoAbrir: () => { const t = $("tela-placas"); if (t && !t.dataset.pronto) { montarCatalogo(t); t.dataset.pronto = "1"; } } });
    if (tela) tela.classList.add("tela-placas");
    C.on("navegacao", (d) => { navAtiva = !!(d && d.ativa); progressoM = d && d.ativa ? d.progresso_m : null; });
    C.on("rota-limpa", () => { limparFoco(); });
    C.on("folha", (d) => { if (d && d.aberta === false) limparFoco(); });
  });
})(window.Copiloto);
