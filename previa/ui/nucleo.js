// Núcleo da interface: barramento de eventos, estado compartilhado, utilidades e pontos de extensão.
// Tudo fica em window.Copiloto. Contrato documentado em ARQUITETURA.md.
(function () {
  "use strict";

  // ------------------------------------------------------------ barramento de eventos
  const ouvintes = new Map(); // evento → [fn]
  function on(evento, fn) {
    if (!ouvintes.has(evento)) ouvintes.set(evento, []);
    ouvintes.get(evento).push(fn);
    return () => off(evento, fn);
  }
  function off(evento, fn) {
    const l = ouvintes.get(evento); if (!l) return;
    const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  }
  // Chama os ouvintes na ordem em que se registraram. Erro de um ouvinte não impede os outros:
  // é relançado fora do fluxo (aparece no console e nos testes como erro de página).
  function emit(evento, dado) {
    const l = ouvintes.get(evento); if (!l) return;
    for (const fn of l.slice()) {
      try { fn(dado); } catch (e) { setTimeout(() => { throw e; }, 0); }
    }
  }

  // ------------------------------------------------------------ utilidades
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, texto) { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; }
  function botao(texto, cls, fn) { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = texto; b.addEventListener("click", fn); return b; }
  function plural(n, um, varios) { return n + " " + (n === 1 ? um : varios); }
  function novoId() { return "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  // localStorage protegido (modo privado, armazenamento cheio ou bloqueado: segue sem quebrar)
  function lerJSON(chave, padrao) { try { const b = localStorage.getItem(chave); return b == null ? padrao : JSON.parse(b); } catch (e) { return padrao; } }
  function gravarJSON(chave, valor) { try { localStorage.setItem(chave, JSON.stringify(valor)); } catch (e) { /* ignora */ } }
  function storage() { try { return localStorage; } catch (e) { return null; } }
  // Estilo próprio de um pacote sem mexer no index.html: Copiloto.carregarEstilo("estilos/postos.css")
  function carregarEstilo(href) {
    if (document.querySelector('link[data-copiloto="' + href + '"]')) return;
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; l.dataset.copiloto = href;
    document.head.appendChild(l);
  }

  // ------------------------------------------------------------ mensagem curta sobre o mapa
  let timerMsg;
  function mensagem(texto, ms) {
    const e = $("msg-mapa");
    e.textContent = texto; e.hidden = false;
    clearTimeout(timerMsg);
    timerMsg = setTimeout(() => { e.hidden = true; }, ms || 5000);
  }

  // ------------------------------------------------------------ folha inferior (uma por vez)
  // M8 (QA): toque que quica (estrada ruim): o 2º toque no mesmo lugar, logo depois de a folha trocar de conteúdo, cairia
  // no botão novo que apareceu ali ("Iniciar navegação" → "Vazio"; "Traçar rota" → "Baixar mapa da rota"). Um toque na
  // folha que COMEÇA (pointerdown) até 600 ms depois da troca, a menos de 40 px do toque que causou a troca e num botão
  // DIFERENTE do primeiro, é ignorado (tocar de novo o mesmo botão, ex.: "Salvar relato" depois de corrigir ou um filtro
  // redesenhado com o mesmo id, vale). Só vale para toque (dedo); mouse e caneta não quicam.
  // (Conta o início do toque: o navegador pode soltar o "click" do 2º toque bem depois.)
  const GUARDA_MS = 600, GUARDA_PX = 40;
  let ultimoToque = null, guarda = null;
  function marcarToque(e) {
    if (!(e.clientX || e.clientY)) return;
    const alvo = e.target && e.target.closest ? e.target.closest("button, a, input, select, label") : null;
    ultimoToque = { x: e.clientX, y: e.clientY, t: Date.now(), alvo, id: alvo ? alvo.id : "", dedo: e.pointerType === "touch" };
  }
  function folhaTrocou() {
    const t = ultimoToque;
    if (t && Date.now() - t.t < 1000 && (!guarda || guarda.desde < t.t)) guarda = { x: t.x, y: t.y, desde: Date.now(), alvo: t.alvo, id: t.id };
    else if (guarda && t && guarda.desde >= t.t) guarda.desde = Date.now(); // mais uma troca pelo mesmo toque
  }
  function vigiarToqueDuplo() {
    const f = $("folha");
    if (!f) return;
    // inclusive botão inserido depois na folha (E3 põe "Baixar mapa da rota" na folha da rota)
    new MutationObserver(folhaTrocou).observe(f, { childList: true, subtree: true });
    const barrar = (e) => {
      const t = ultimoToque;
      if (!guarda || !t || !t.dedo || !f.contains(e.target)) return;
      if (t.t < guarda.desde || t.t > guarda.desde + GUARDA_MS) return;
      if (Math.hypot(e.clientX - guarda.x, e.clientY - guarda.y) > GUARDA_PX) return;
      const alvo = e.target.closest ? e.target.closest("button, a, input, select, label") : null;
      if (alvo && ((guarda.alvo && guarda.alvo.isConnected && alvo === guarda.alvo) || (guarda.id && alvo.id === guarda.id))) return;
      e.preventDefault(); e.stopImmediatePropagation();
    };
    document.addEventListener("pointerdown", marcarToque, true);
    document.addEventListener("click", barrar, true);
  }
  const folha = {
    abrir(filhos) { const f = $("folha"); f.textContent = ""; filhos.forEach((x) => f.appendChild(x)); f.hidden = false; emit("folha", { aberta: true }); },
    fechar() { const f = $("folha"); f.hidden = true; f.textContent = ""; emit("folha", { aberta: false }); },
    aberta() { return !$("folha").hidden; },
  };

  // ------------------------------------------------------------ abas (telas; o menu fica na tela de Configurações)
  // { id, rotulo, tela?: HTMLElement, botao?: HTMLElement, aoAbrir?: fn }
  // Sem "tela": cria <section class="tela" id="tela-<id>">. Sem "botao": cria <button id="nav-<id>"> na barra.
  const abas = new Map();
  let abaAtual = "mapa";
  function registrarAba(o) {
    let tela = o.tela || null;
    if (!tela && o.id !== "mapa") {
      tela = document.createElement("section"); tela.id = "tela-" + o.id; tela.className = "tela"; tela.hidden = true;
      tela.setAttribute("aria-label", o.rotulo);
      document.querySelector("main").appendChild(tela);
    }
    let b = o.botao || $("nav-" + o.id);
    if (!b) { b = document.createElement("button"); b.id = "nav-" + o.id; b.textContent = o.rotulo; document.querySelector("nav").appendChild(b); }
    b.addEventListener("click", () => irPara(o.id));
    abas.set(o.id, { id: o.id, tela, botao: b, aoAbrir: o.aoAbrir || null });
    return tela;
  }
  function irPara(id) {
    for (const a of abas.values()) {
      if (a.tela) a.tela.hidden = a.id !== id;
      a.botao.setAttribute("aria-current", a.id === id ? "page" : "false");
    }
    abaAtual = id;
    const a = abas.get(id);
    if (a && a.aoAbrir) a.aoAbrir();
    emit("aba", id);
  }

  // ------------------------------------------------------------ botões redondos sobre o mapa
  // { id, icone, rotulo, aoTocar, pressionavel?: bool, classe?: string, noFim?: bool }
  // Entra no topo da coluna de botões (noFim: true põe embaixo).
  function adicionarBotaoMapa(o) {
    const b = document.createElement("button");
    b.className = "btn-redondo" + (o.classe ? " " + o.classe : "");
    b.id = o.id; b.setAttribute("aria-label", o.rotulo); b.title = o.rotulo; b.textContent = o.icone;
    if (o.pressionavel) b.setAttribute("aria-pressed", "false");
    if (o.aoTocar) b.addEventListener("click", o.aoTocar);
    const col = document.querySelector(".acoes");
    if (o.noFim) col.appendChild(b); else col.insertBefore(b, col.firstChild);
    return b;
  }

  // ------------------------------------------------------------ início
  // Cada módulo registra o que faz ao iniciar; ui/inicio.js chama Copiloto.iniciar() depois de todos os <script>.
  const ganchos = [];
  let iniciado = false;
  function aoIniciar(fn) { if (iniciado) fn(); else ganchos.push(fn); }
  function iniciar() {
    if (iniciado) return;
    iniciado = true;
    vigiarToqueDuplo();
    for (const fn of ganchos) fn();
    emit("pronto");
  }

  // ------------------------------------------------------------ serviços compartilhados
  const Cfg = window.CopilotoConfig;
  const nuvem = window.CopilotoNuvem.criarNuvem({ url: Cfg.url, chave: Cfg.chave });

  window.Copiloto = {
    on, off, emit,
    aoIniciar, iniciar,
    // estado compartilhado (só leitura para os pacotes; quem escreve é o módulo dono)
    estado: {
      gps: null,        // última leitura útil: { lat, lon, precisao, rumo, velKmh, kmh, t } (ui/gps.js)
      ultimaPos: null,  // [lon, lat] da última leitura (ui/gps.js)
    },
    nuvem,              // cliente Supabase (nuvem.js): rpc, logado, usuario, fila…
    mapa: null,         // maplibregl.Map, preenchido por ui/mapa.js no início
    util: { $, el, botao, plural, novoId, lerJSON, gravarJSON, storage },
    mensagem, folha, carregarEstilo,
    abas: { registrar: registrarAba, irPara, atual: () => abaAtual },
    botoesMapa: { adicionar: adicionarBotaoMapa },
  };
  registrarAba({ id: "mapa", rotulo: "Mapa" });
})();
