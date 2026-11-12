// Busca e toque no mapa (redesenho).
// Busca ("Para onde?", #btn-destino → tela #tela-busca): busca de destino POR TEXTO (endereço, lugar, empresa) no serviço
// público Photon (Komoot, dados do OpenStreetMap; ver interface.js), com viés pela posição atual, ~400 ms depois da última
// tecla e no máximo 1 pedido por segundo; até 6 resultados (nome, cidade/UF, distância). "lat, lon" colado vira resultado
// sem internet. Sem internet, busca só nos destinos recentes e avisa. Escolher um resultado abre a mesma folha do toque no
// mapa ("Ir para cá"). Mais "Postos à frente" (Copiloto.postos.abrirProximo, o antigo botão ⛽ do mapa), "Casa / base" e os
// destinos recentes da navegação (E1; tocar num recente já traça a rota).
// Toque no mapa — um só comportamento: TOQUE SIMPLES num ponto do mapa (fora de marcador, popup ou posto) abre a folha do
// ponto com o endereço (Copiloto.endereco.perto, se existir) ou a coordenada, "Ir para cá" (vira destino e traça a rota;
// navegando, pergunta antes de trocar), "Relatar aqui" e "Salvar este ponto" (submenu: casa/base e lugar); "×" no título fecha. Nunca vira destino sozinho.
// Casa/base: copiloto.base.v1 = { lat, lon, rotulo } (formato antigo, lido como Casa por ui/lugares.js, que guarda a lista em
// copiloto.lugares.v1: Casa, Base e até 5 favoritos).
// Expõe Copiloto.busca: abrir(), procurar(texto) → Promise<[{ nome, detalhe, lat, lon }]> (também para a voz: "ir para X";
// sem internet, os recentes; erro de rede: rejeita com .rede = true), irPara({ lat, lon, rotulo? }),
// abrirToque({ lat, lng }, { titulo?, detalhe? }), base().
(function (C) {
  "use strict";
  const { $, el, botao, lerJSON, gravarJSON } = C.util;
  const I = window.CopilotoInterface;
  const CHAVE_BASE = "copiloto.base.v1";
  // camadas dos pacotes que já tratam o próprio toque (o detalhe do posto abre por ui/postos.js; a linha cinza de uma
  // rota alternativa escolhe a rota, ui/rota.js — equipe F)
  const CAMADAS_COM_TOQUE = ["postos-pontos", "postos-50km", "rota-alt-toque", "rota-alt"];
  const ESPERA_TECLA_MS = 400, INTERVALO_MIN_MS = 1000, TEMPO_LIMITE_MS = 8000, MAX_RESULTADOS = 6;
  let pinoToque = null, folhaToque = null, folhaGuardada = null, seqEndereco = 0, seqBusca = 0, timerBusca = null, ultimoPedido = 0;

  const Nav = () => window.CopilotoNavegacao;
  function distanciaDaqui(p) {
    const g = C.estado.gps;
    if (!g || !Nav()) return null;
    return Nav().distanciaM({ lat: g.lat, lon: g.lon }, { lat: p.lat, lon: p.lon });
  }
  function textoDist(p) { const d = distanciaDaqui(p); return d == null ? "" : Nav().formatarDistancia(d) + " daqui"; }
  function navegando() { return !!(C.navegacao && C.navegacao.ativa && C.navegacao.ativa()); }
  function lerBase() { const b = lerJSON(CHAVE_BASE, null); return b && isFinite(b.lat) && isFinite(b.lon) ? b : null; }

  // ------------------------------------------------------------ ir para um destino (busca, recentes, toque)
  function irPara(d) {
    if (!d || !isFinite(d.lat) || !isFinite(d.lon)) return;
    if (C.abas.atual() !== "mapa") C.abas.irPara("mapa");
    if (navegando() && C.navegacao.trocarDestino) { perguntarTroca(d); return; }
    C.rota.definirDestino({ lat: d.lat, lng: d.lon }, { rotulo: d.rotulo || null }); // nome vai na rota e nos recentes
    // sem internet só marca o destino (a folha "Destino escolhido" diz que a rota espera a internet e tem "Traçar rota")
    if (navigator.onLine !== false) C.rota.tracar();
  }
  function perguntarTroca(d) {
    const nome = d.rotulo || I.textoCoordenada(d);
    const linha = el("div", "linha-botoes busca-troca");
    const sim = botao("Sim, trocar", "btn btn-principal nav-grande", () => { C.folha.fechar(); C.navegacao.trocarDestino({ lat: d.lat, lon: d.lon, rotulo: d.rotulo || null }); });
    sim.id = "busca-trocar-sim";
    const nao = botao("Não", "btn nav-grande", C.folha.fechar); nao.id = "busca-trocar-nao";
    linha.append(sim, nao);
    C.folha.abrir([el("h2", null, "Trocar o destino para " + nome + "?"), el("p", null, "A navegação recalcula a rota daqui, com o mesmo veículo e carga."), linha]);
  }

  // ------------------------------------------------------------ tela de busca
  function itemDestino(d, classe, aoTocar) {
    const li = el("li");
    const b = el("button", "busca-item " + classe); b.type = "button";
    const txt = el("span", "busca-item-texto");
    if (window.CopilotoIcones) b.append(window.CopilotoIcones.no("relogio")); // recente: relógio (r6)
    txt.append(el("span", "busca-item-nome", d.rotulo || I.textoCoordenada(d)));
    const det = [d.detalhe, textoDist(d)].filter(Boolean).join(" · ");
    if (det) txt.append(el("small", "busca-item-detalhe", det));
    b.append(txt);
    b.addEventListener("click", aoTocar || (() => irPara(d)));
    li.append(b);
    return li;
  }
  function recentes() { try { return C.navegacao && C.navegacao.recentes ? C.navegacao.recentes() : []; } catch (e) { return []; } }
  // ---------- procurar: coordenada colada, recentes (sem internet) ou Photon
  const online = () => navigator.onLine !== false;
  function localizacaoPermitida() { return !C.privacidade || !C.privacidade.localizacaoPermitida || C.privacidade.localizacaoPermitida(); }
  function deRecentes(texto) {
    return I.filtrarRecentes(recentes(), texto).slice(0, MAX_RESULTADOS)
      .map((d) => ({ nome: d.rotulo || I.textoCoordenada(d), detalhe: "Destino recente", lat: d.lat, lon: d.lon }));
  }
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  async function procurar(texto) {
    const t = String(texto == null ? "" : texto).trim();
    if (!t) return [];
    const c = I.lerCoordenada(t);
    if (c) return [{ nome: I.textoCoordenada(c), detalhe: "Coordenada", lat: c.lat, lon: c.lon }];
    if (!online()) return deRecentes(t);
    // "BR-153 km 140" (ui/km.js): o ponto do km pela referência do Copiloto, não pelo Photon
    if (C.km && C.km.ehDestino(t)) return C.km.procurar(t);
    // educado com o serviço público: no máximo 1 pedido por segundo
    const falta = INTERVALO_MIN_MS - (Date.now() - ultimoPedido);
    if (falta > 0) await esperar(falta);
    ultimoPedido = Date.now();
    // a posição do motorista só vai ao Photon (viés "o que está perto") com a localização permitida; o que se digita vai sempre
    // (o consentimento diz isso fora do item de localização)
    const g = localizacaoPermitida() ? C.estado.gps : null;
    const ctl = new AbortController(), tl = setTimeout(() => ctl.abort(), TEMPO_LIMITE_MS);
    try {
      // Duas consultas seguidas (a segunda sem a posição): (1) numa caixa de ~40 km ao redor do motorista, com viés — o que está
      // perto vem mesmo com nome comum; (2) no Brasil inteiro — cidades e lugares grandes, que o viés empurra para fora dos 10
      // primeiros ("São Paulo" virava só ruas de Londrina) e sem CEPs de Portugal. Com número ("260, aço"): só ruas, pelo nome.
      const pedir = async (texto, pos, opc) => {
        const r = await fetch(I.urlBusca(texto, pos, 10, window.COPILOTO_URL_BUSCA, opc), { signal: ctl.signal });
        if (!r.ok) { const e = new Error("A busca de endereços não respondeu (" + r.status + ")."); e.rede = r.status >= 500 || r.status === 429; throw e; }
        return r.json();
      };
      const pos = g ? { lat: g.lat, lon: g.lon } : null;
      const num = I.lerEnderecoComNumero(t);
      const q = num ? num.resto : t, tag = num ? "highway" : null;
      // um pedido por vez, com o intervalo de 1 s entre eles (serviço público): primeiro o perto, depois o Brasil
      const resp = [];
      if (pos) resp.push(await pedir(q, pos, { bbox: I.bboxPerto(pos), osmTag: tag }));
      if (pos) { const falta2 = INTERVALO_MIN_MS - (Date.now() - ultimoPedido); if (falta2 > 0) await esperar(falta2); ultimoPedido = Date.now(); }
      resp.push(await pedir(q, null, { bbox: I.BBOX_BRASIL, osmTag: tag }).catch((e) => { if (!pos) throw e; return null; }));
      return I.resultadosBusca(I.juntarBusca(resp), MAX_RESULTADOS, q, num ? num.numero : null);
    } catch (e) {
      if (e.name === "AbortError" || e instanceof TypeError) { const x = new Error("Sem conexão com a busca de endereços."); x.rede = true; throw x; }
      throw e;
    } finally { clearTimeout(tl); }
  }

  // ---------- tela de busca
  function itemResultado(r) {
    const li = el("li");
    const b = el("button", "busca-item busca-resultado"); b.type = "button";
    const txt = el("span", "busca-item-texto");
    if (window.CopilotoIcones) b.append(window.CopilotoIcones.no(r.icone || "pino")); // resultado: pino (r6)
    txt.append(el("span", "busca-item-nome", r.nome));
    const det = [r.detalhe, Number.isFinite(r.lat) && Number.isFinite(r.lon) ? textoDist(r) : ""].filter(Boolean).join(" · ");
    if (det) txt.append(el("small", "busca-item-detalhe", det));
    b.append(txt);
    // r.aoTocar: resultado que faz o próprio caminho (destino por km, sugestão de rodovia — ui/km.js)
    b.addEventListener("click", () => (typeof r.aoTocar === "function" ? r.aoTocar() : escolher(r)));
    li.append(b);
    return li;
  }
  // resultado escolhido: a mesma folha do toque no mapa, com o mapa no ponto
  function escolher(r) {
    C.abas.irPara("mapa");
    if (C.seguir) C.seguir(false);
    try { C.mapa.jumpTo({ center: [r.lon, r.lat], zoom: Math.max(C.mapa.getZoom(), 15) }); } catch (e) { /* mapa sem estilo */ }
    abrirToque({ lat: r.lat, lng: r.lon }, { titulo: r.nome, detalhe: r.detalhe });
  }
  function mostrarResultados(lista, aviso) {
    const res = $("busca-resultados"); res.textContent = "";
    if (aviso) { const p = el("p", "busca-aviso", aviso); p.id = "busca-aviso"; res.append(p); }
    if (!lista.length) return;
    const ul = el("ul", "busca-lista"); ul.id = "busca-lista-resultados";
    for (const r of lista) ul.append(itemResultado(r));
    res.append(ul);
  }
  // Recentes abaixo dos resultados/avisos. Com aviso de falha (sem internet, erro de rede) eles ficam sempre à vista: se o que foi digitado
  // não bate com nenhum, mostra todos (revisão UX, item 20: o aviso nunca toma o lugar da lista).
  function desenharRecentes(texto, comAviso) {
    let lista = I.filtrarRecentes(recentes(), texto);
    if (comAviso && !lista.length) lista = recentes().slice(0, MAX_RESULTADOS);
    const ul = $("busca-recentes"); ul.textContent = "";
    for (const d of lista) ul.append(itemDestino(d, "btn-recente"));
    $("busca-recentes-titulo").hidden = !lista.length;
    return lista;
  }
  function desenharBusca() {
    const texto = $("busca-texto").value, t = texto.trim();
    desenharRecentes(texto, false);
    $("busca-dica").textContent = "Ou toque no mapa e escolha \"Ir para cá\".";
    clearTimeout(timerBusca);
    const seq = ++seqBusca;
    if (!t) { mostrarResultados([]); return; }
    const c = I.lerCoordenada(t);
    if (c) { procurar(t).then((l) => { if (seq === seqBusca) mostrarResultados(l); }); return; }
    if (!online()) { desenharRecentes(texto, true); mostrarResultados([], "Sem internet: a busca por endereço volta com a conexão. Por enquanto, só os destinos recentes."); return; }
    // começo de rodovia ("BR-1", "SP-33"): sugere rodovias (ui/km.js, copiloto_km_highways) para completar com o km
    const pref = C.km && C.km.prefixo ? C.km.prefixo(t) : null;
    if (pref) {
      mostrarResultados([], "Digite o km: " + pref.replace(/-$/, "") + " km 140");
      C.km.sugerirRodovias(pref).then((l) => {
        if (seq !== seqBusca) return;
        mostrarResultados(l.map((x) => ({ nome: x.rodovia, detalhe: "Rodovia" + (x.ufs && x.ufs.length ? " · " + x.ufs.join(", ") : "") + " · toque e digite o km",
          aoTocar: () => { const c = $("busca-texto"); c.value = x.rodovia + " km "; c.focus(); desenharBusca(); } })), "Digite o km: " + pref.replace(/-$/, "") + " km 140");
      });
      return;
    }
    if (t.length < 3) { mostrarResultados([]); return; }
    mostrarResultados([], "Buscando…");
    timerBusca = setTimeout(async () => {
      try {
        const l = await procurar(t);
        if (seq !== seqBusca) return;
        mostrarResultados(l, l.length ? null : "Nada encontrado para \"" + t + "\". Tente outro nome, a cidade junto ou toque no mapa.");
      } catch (e) {
        if (seq !== seqBusca) return;
        desenharRecentes(texto, true);
        mostrarResultados([], (e.rede ? "Sem conexão com a busca de endereços" : e.message.replace(/\.$/, "")) + ". Os destinos recentes continuam abaixo.");
      }
    }, ESPERA_TECLA_MS);
  }
  // Para a voz (ui/comandos.js): abre a Busca com o texto dito. lista = resultados já procurados (mostra sem pedir de novo);
  // lista null = só o aviso ("Buscando…"); sem lista = busca normal do texto (como se fosse digitado).
  function mostrar(texto, lista, aviso) {
    if (C.abas.atual() !== "busca") C.abas.irPara("busca");
    $("busca-texto").value = texto || "";
    if (lista === undefined) { desenharBusca(); return; }
    clearTimeout(timerBusca); seqBusca++;
    desenharRecentes(texto || "", !!aviso);
    mostrarResultados(lista || [], aviso || null);
  }
  function aoEnviarBusca(ev) {
    ev.preventDefault();
    const primeiro = document.querySelector("#busca-lista-resultados .busca-resultado");
    if (primeiro) { primeiro.click(); return; }
    const texto = $("busca-texto").value, t = texto.trim();
    const lista = I.filtrarRecentes(recentes(), texto);
    if (lista.length === 1) { irPara(lista[0]); return; }
    // "Buscar" do teclado antes de os resultados chegarem: busca agora (sem esperar a pausa da digitação) e escolhe o 1º
    if (t.length < 2) return;
    clearTimeout(timerBusca);
    const seq = ++seqBusca;
    mostrarResultados([], "Buscando…");
    procurar(t).then((l) => {
      if (seq !== seqBusca || C.abas.atual() !== "busca") return;
      if (l.length) { mostrarResultados(l); if (typeof l[0].aoTocar === "function") l[0].aoTocar(); else escolher(l[0]); }
      else mostrarResultados([], "Nada encontrado para \"" + t + "\". Tente outro nome, a cidade junto ou toque no mapa.");
    }, (e) => {
      if (seq !== seqBusca) return;
      desenharRecentes(texto, true);
      mostrarResultados([], (e.rede ? "Sem conexão com a busca de endereços" : e.message.replace(/\.$/, "")) + ". Os destinos recentes continuam abaixo.");
    });
  }
  function abrirPostos() {
    C.abas.irPara("mapa");
    if (C.postos && C.postos.abrirProximo) C.postos.abrirProximo();
    else C.mensagem("Postos indisponíveis agora.", 5000);
  }
  function abrirBase() {
    if (C.lugares && C.lugares.irCasaOuBase) { C.lugares.irCasaOuBase(); return; } // rodada 6: Casa, Base e favoritos (ui/lugares.js)
    const b = lerBase();
    if (b) { irPara(Object.assign({ rotulo: b.rotulo || "Casa / base" }, b)); return; }
    C.abas.irPara("mapa");
    C.folha.abrir([el("h2", null, "Casa / base"), el("p", null, "Toque no mapa no lugar da casa ou da base e escolha \"Salvar como casa/base\"."),
      botao("Entendi", "btn", C.folha.fechar)]);
  }

  // ------------------------------------------------------------ toque no mapa
  function tirarPino() { if (pinoToque) { pinoToque.remove(); pinoToque = null; } }
  function abrirToque(lngLat, info) {
    const p = { lat: lngLat.lat, lon: lngLat.lng };
    const dado = info && info.titulo ? info : null; // resultado da busca: nome e detalhe já conhecidos
    tirarPino();
    // folha de decisão aberta (destino escolhido, rota traçada, "Iniciar navegação"): o ponto tocado vai POR CIMA dela e
    // o primeiro "Fechar" ou o próximo toque no mapa a devolve; antes ele a substituía e a rota ficava sem volta
    const f = $("folha");
    if (!folhaGuardada && f && !f.hidden && f.dataset.decisao === "1") folhaGuardada = Array.from(f.childNodes);
    const pino = el("div", "pino-toque");
    pino.innerHTML = '<svg viewBox="0 0 36 48" aria-hidden="true" focusable="false"><path d="M18 46C18 46 3 28 3 17a15 15 0 0130 0C33 28 18 46 18 46Z"/><circle cx="18" cy="17" r="5"/></svg>';
    pinoToque = new maplibregl.Marker({ element: pino, anchor: "bottom" }).setLngLat([p.lon, p.lat]).addTo(C.mapa);
    const titulo = el("h2", "toque-titulo", dado ? dado.titulo : "Ponto no mapa"); titulo.id = "toque-titulo";
    if (dado) titulo.dataset.endereco = dado.titulo;
    const det = el("p", "toque-detalhe", [dado && dado.detalhe, I.textoCoordenada(p), textoDist(p)].filter(Boolean).join(" · ")); det.id = "toque-detalhe";
    const ir = botao("Ir para cá", "btn btn-principal toque-ir", () => { tirarPino(); irPara(Object.assign({ rotulo: titulo.dataset.endereco || null }, p)); }); ir.id = "toque-ir";
    const rel = botao("Relatar aqui", "btn toque-relatar", () => {
      tirarPino();
      C.relatos.abrirFormulario({ toque: { lat: p.lat, lon: p.lon, rumo: null, velKmh: null, precisao: null, t: Date.now() }, aqui: true });
    });
    rel.id = "toque-relatar";
    if (window.CopilotoIcones) { window.CopilotoIcones.prefixar(ir, "ir"); window.CopilotoIcones.prefixar(rel, "bandeira"); } // r6: símbolo + texto (ação de destino não fica só no desenho)
    const linha = el("div", "toque-botoes"); linha.append(ir, rel);
    const base = botao("Salvar como casa/base", "btn btn-pequeno toque-base", () => {
      gravarJSON(CHAVE_BASE, { lat: p.lat, lon: p.lon, rotulo: titulo.dataset.endereco || "Casa / base" });
      if (C.lugares && C.lugares.salvar) C.lugares.salvar({ tipo: "casa", nome: "Casa", lat: p.lat, lon: p.lon, rotulo: titulo.dataset.endereco || "Casa / base" });
      C.mensagem("Casa/base salva. Ela aparece na busca.", 4000);
      folhaGuardada = null;
      C.folha.fechar();
    });
    base.id = "toque-base";
    // rodada 6: Casa, Base ou um favorito nomeado (ui/lugares.js)
    const lugar = botao("Salvar lugar", "btn btn-pequeno toque-lugar", () => {
      tirarPino(); folhaGuardada = null;
      C.lugares.escolherParaSalvar(p, titulo.dataset.endereco || null);
    });
    lugar.id = "toque-lugar"; if (!C.lugares) lugar.hidden = true;
    // revisão UX (item 21): "Ir para cá" + "Relatar aqui" na primeira linha; "Salvar…" abre o submenu (Casa/base e lugar); "Fechar" vira "×" no título
    const menu = el("div", "toque-salvar-menu"); menu.id = "toque-salvar-menu"; menu.hidden = true; menu.append(base, lugar);
    const salvar = botao("Salvar este ponto", "btn toque-salvar", () => {
      menu.hidden = !menu.hidden; salvar.setAttribute("aria-expanded", String(!menu.hidden));
      if (!menu.hidden && menu.scrollIntoView) { try { menu.scrollIntoView({ block: "nearest" }); } catch (e) { /* ignora */ } } // tela baixa (SE): o submenu aparece inteiro
    });
    salvar.id = "toque-salvar"; salvar.setAttribute("aria-expanded", "false"); salvar.setAttribute("aria-controls", "toque-salvar-menu");
    const fechar = botao("×", "toque-x", fecharToque); fechar.id = "toque-fechar"; fechar.setAttribute("aria-label", "Fechar");
    const cab = el("div", "toque-cab"); cab.append(titulo, fechar);
    const raiz = el("div", "toque-folha"); raiz.id = "toque-folha";
    raiz.append(cab, det, linha, salvar, menu);
    folhaToque = raiz;
    C.folha.abrir([raiz]);
    // endereço do ponto, se o pacote de endereço existir (do mapa guardado ou da internet); sem ele, fica a coordenada
    const seq = ++seqEndereco;
    if (!dado && C.endereco && typeof C.endereco.perto === "function") {
      // km da rodovia do ponto (DNIT/PRF, aproximado) e número da casa (Nominatim) entram no título: "BR-116, km 230,4" · "Rua X, 463"
      Promise.resolve().then(() => (C.km && C.km.em ? C.km.em(p).catch(() => null) : null)).then((k) => C.endereco.perto({ lat: p.lat, lon: p.lon, km: k ? { rodovia: k.rodovia, km: k.km } : null })).then((r) => {
        if (seq !== seqEndereco || !raiz.isConnected) return;
        const t = I.textoEndereco(r);
        if (!t) return;
        titulo.textContent = t.titulo; titulo.dataset.endereco = t.titulo;
        det.textContent = [t.linha, I.textoCoordenada(p), textoDist(p)].filter(Boolean).join(" · ");
      }, () => { /* sem endereço: fica a coordenada */ });
    }
  }
  // fecha a folha do ponto tocado; se havia uma folha de decisão por baixo, ela volta
  function fecharToque() {
    const volta = folhaGuardada; folhaGuardada = null;
    tirarPino();
    if (volta && C.rota && C.rota.destino()) C.folha.abrir(volta);
    else C.folha.fechar();
    if (volta && C.rota && C.rota.destino()) { const f = $("folha"); if (f) f.dataset.decisao = "1"; }
  }
  function aoTocarMapa(d) {
    if (!d || !d.lngLat || C.abas.atual() !== "mapa") return;
    if (d.sobreMarcador) return;                         // relato, posto, destino, popup aberto: cada um trata o seu
    if (d.camada && CAMADAS_COM_TOQUE.indexOf(d.camada) >= 0) return;
    // a linha da rota (fora da navegação) reabre a folha da rota (ui/rota.js); navegando, ela é só mais um ponto do mapa
    if ((d.camada === "rota" || d.camada === "rota-toque") && C.rota && C.rota.destino() && !(C.navegacao && C.navegacao.ativa && C.navegacao.ativa())) return;
    // com rota traçada, o toque no mapa não marca ponto nem destino (atrapalha a condução); só o botão de busca e a linha da rota
    if (C.rota && C.rota.destino()) return;
    // com a folha do ponto por cima da rota, o primeiro toque só a fecha e devolve a rota
    if (folhaGuardada && folhaToque && folhaToque.isConnected) { fecharToque(); return; }
    abrirToque(d.lngLat);
  }

  C.busca = { abrir: () => C.abas.irPara("busca"), procurar, irPara, abrirToque, base: lerBase, mostrar };

  C.aoIniciar(() => {
    C.abas.registrar({ id: "busca", rotulo: "Buscar", tela: $("tela-busca"), botao: $("btn-destino"), aoAbrir: () => {
      $("busca-texto").value = ""; desenharBusca();
    } });
    $("busca-texto").addEventListener("input", desenharBusca);
    $("busca-form").addEventListener("submit", aoEnviarBusca);
    $("busca-postos").addEventListener("click", abrirPostos);
    $("busca-base").addEventListener("click", abrirBase);
    C.on("aba", (id) => { $("btn-destino").setAttribute("aria-pressed", String(id === "busca")); });
    C.on("mapa-clique", aoTocarMapa);
    // internet caiu ou voltou com a busca aberta: refaz (sem internet, só os recentes)
    for (const ev of ["online", "offline"]) window.addEventListener(ev, () => { if (C.abas.atual() === "busca") desenharBusca(); });
    // o pino do ponto tocado some com a folha dele
    C.on("folha", () => {
      if (!(folhaToque && folhaToque.isConnected)) { if (pinoToque) tirarPino(); folhaGuardada = null; }
    });
  });
})(window.Copiloto);
