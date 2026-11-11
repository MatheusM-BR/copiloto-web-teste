// "Em que km estou" e destino por km (lógica pura em dados.js, window.CopilotoDados).
// 1. Navegando: a cada ~30 s ou 500 m (o que vier antes; um pedido em voo por vez; cache por posição arredondada; nada
//    sem internet nem sem a localização permitida) pergunta ao Supabase copiloto_snv_km_at (DNIT, oficial) e copiloto_km_at
//    (PRF + marcos ARTESP, estimado). Com resposta a < 300 m da rodovia, mostra "BR-153 · km 140,3" discreto no painel da
//    navegação (#km-atual, marcado "estimado" quando a fonte é a estimada); some ao sair da rodovia ou da navegação.
// 2. Voz: "em que km estou" / "que km é esse" (intenção qual_km de comandos.js) → fala "BR 153, quilômetro 140, estimado."
//    (vale também fora da navegação, com GPS; sem internet usa a última resposta recente).
// 3. Destino por km: a busca e a voz entendem "BR-153 km 140", "km 140 da BR 153", "SP-330 km 26" → copiloto_km_to_point.
//    Rodovia em mais de um estado (encontrado: false com ufs_disponiveis): a folha pergunta "Qual estado?" com um botão por
//    UF (a UF em que o motorista está primeiro) e a voz lista os estados e ouve a resposta (Copiloto.comandos.perguntar).
//    O ponto vira destino normal (Copiloto.busca.irPara) com rótulo "BR-153 km 140 (TO)"; precisao_m > 200 → aviso
//    "Ponto estimado, precisão de ~X m" (mensagem e linha na folha da rota). Autocompletar de rodovias na busca com
//    copiloto_km_highways. Tudo marcado como estimado quando a API diz estimado.
// Expõe Copiloto.km: atual() ({ rodovia, uf, km, oficial, estimado, … } ou null), responderVoz(), ehDestino(texto),
// procurar(texto) → Promise<[{ nome, detalhe, lat, lon, aoTocar? }]>, irParaKm({ rodovia, km, uf? }, { voz? }),
// deVoz(r) (true se o pedido de voz era um destino por km e foi tratado), prefixo(texto), sugerirRodovias(prefixo),
// avisoDestino(rota) (texto do aviso de precisão do destino atual ou null). Eventos: "km:atual" ({ atual }), "km:destino".
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const D = window.CopilotoDados;
  const Consent = window.CopilotoConsentimento;
  C.carregarEstilo("estilos/km.css");

  let elKm = null, atual = null, ultimoPedido = null, emVoo = null, respondidoEm = null, posResposta = null;
  const cache = new Map(); // chave da posição → { snv, kmAt, t }
  const CACHE_MAX = 60, CACHE_MS = 10 * 60000, FRESCO_MS = 60000, FRESCO_M = 1000;
  const kmCache = window.CopilotoKmCache.criar();
  let destinoKm = null;    // { lat, lon, rotulo, precisao_m, estimado } do último destino por km
  let rodoviasCache = new Map();

  function online() { return !(navigator && navigator.onLine === false); }
  function localizacaoOk() { try { return Consent.permite(Consent.ler(C.util.storage()), "localizacao"); } catch (e) { return false; } }
  function navegando() { return !!(C.navegacao && C.navegacao.ativa && C.navegacao.ativa()); }
  function gpsVelho() { try { return !!(C.gps && C.gps.velho()); } catch (e) { return false; } }
  function rpc(nome, params) { return C.nuvem.rpcPublica(nome, params); }

  // ------------------------------------------------------------ em que km estou
  async function pedir(pos) {
    const chave = D.chavePosicao(pos.lat, pos.lon);
    const c = cache.get(chave);
    if (c && Date.now() - c.t < CACHE_MS) return c;
    const [snv, kmAt] = await Promise.all([
      rpc("copiloto_snv_km_at", { p_lat: pos.lat, p_lon: pos.lon }).catch(() => null),
      rpc("copiloto_km_at", { p_lat: pos.lat, p_lon: pos.lon }).catch(() => null),
    ]);
    const r = { snv, kmAt, t: Date.now(), falhou: !snv && !kmAt };
    if (!r.falhou) { cache.set(chave, r); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
    return r;
  }
  function aplicar(res, pos) {
    atual = res && !res.falhou ? D.escolherKm(res.snv, res.kmAt) : null;
    respondidoEm = Date.now(); posResposta = { lat: pos.lat, lon: pos.lon };
    kmCache.registrar(atual, pos); // r5: base para estimar o km entre pedidos reais
    desenhar();
    C.emit("km:atual", { atual });
  }
  async function atualizar(forcar) {
    const g = C.estado.gps;
    if (!g || gpsVelho() || !localizacaoOk()) { if (atual) { atual = null; desenhar(); } return null; }
    if (!online()) { if (atual) { atual = null; desenhar(); } return null; }
    const pos = { lat: g.lat, lon: g.lon };
    if (emVoo) return emVoo;
    if (!forcar && !D.devePedirKm(ultimoPedido, Date.now(), pos)) return null;
    ultimoPedido = { t: Date.now(), lat: pos.lat, lon: pos.lon };
    const deduzido = forcar ? null : kmCache.estimar(pos); // r5: em rodovia, a menos de ~2 km da última resposta real, sem RPC
    if (deduzido) { atual = deduzido; respondidoEm = Date.now(); posResposta = { lat: pos.lat, lon: pos.lon }; desenhar(); C.emit("km:atual", { atual }); return atual; }
    emVoo = pedir(pos).then((res) => { emVoo = null; aplicar(res, pos); return atual; }, () => { emVoo = null; return null; });
    return emVoo;
  }
  function desenhar() {
    if (!elKm) return;
    const mostrar = !!atual && navegando();
    elKm.hidden = !mostrar;
    if (!mostrar) return;
    elKm.textContent = "";
    elKm.append(el("span", "km-atual-texto", D.textoKmTela(atual.rodovia, atual.km)));
    if (atual.estimado) elKm.append(el("span", "km-atual-est", "estimado"));
    elKm.dataset.fonte = atual.oficial ? "snv" : "estimado";
    elKm.setAttribute("aria-label", atual.rodovia + ", quilômetro " + D.fmtKm(atual.km) + (atual.estimado ? ", estimado" : ", oficial DNIT"));
    elKm.title = atual.oficial ? (atual.fonte || "DNIT — SNV") : "Estimado: " + (atual.fonte || "PRF / ARTESP");
  }
  function criarElemento() {
    const p = $("nav-painel"); if (!p || elKm) return;
    elKm = el("div", "km-atual"); elKm.id = "km-atual"; elKm.hidden = true; elKm.setAttribute("role", "status");
    const seg = $("nav-seguinte");
    if (seg && seg.parentNode === p) p.insertBefore(elKm, seg.nextSibling); else p.appendChild(elKm);
  }
  // resposta recente vale para a voz sem pedir de novo (< 60 s e < 1 km)
  function fresca() {
    const g = C.estado.gps;
    return !!(respondidoEm && posResposta && g && Date.now() - respondidoEm < FRESCO_MS && D.distanciaM(posResposta, { lat: g.lat, lon: g.lon }) < FRESCO_M);
  }
  function falar(t) { if (!C.voz.emAlerta()) C.voz.falar(t, { naoInterromper: true }); }
  async function responderVoz() {
    const g = C.estado.gps;
    if (!g) { C.mensagem("Ative o GPS para saber o km.", 5000); falar("Sem GPS, não sei em que quilômetro você está."); return null; }
    if (!fresca()) {
      if (!online()) { C.mensagem("Sem internet para saber o km.", 5000); falar("Sem internet, não sei em que quilômetro você está."); return null; }
      await (emVoo || atualizar(true));
    }
    if (!atual) { C.mensagem("Fora de rodovia conhecida.", 5000); falar(D.falaSemKm()); return null; }
    C.mensagem(D.textoKmTela(atual.rodovia, atual.km) + (atual.estimado ? " (estimado)" : " (DNIT)"), 6000);
    falar(D.falaKm(atual.rodovia, atual.km, atual.estimado));
    return atual;
  }

  // ------------------------------------------------------------ destino por km
  function ehDestino(texto) { return !!D.interpretarDestinoKm(texto); }
  async function pontoDoKm(p) {
    return rpc("copiloto_km_to_point", { p_highway: p.rodovia, p_uf: p.uf || null, p_km: p.km });
  }
  function ufAtual() {
    if (atual && atual.uf) return atual.uf;
    return null;
  }
  // UF do ponto: a da resposta, a pedida ou, em rodovia estadual ("SP-330"), a sigla da própria rodovia
  function ufDe(resp, p) {
    if (resp && resp.uf) return String(resp.uf).toUpperCase();
    if (p.uf) return String(p.uf).toUpperCase();
    return p.rodovia.slice(0, 2) !== "BR" ? p.rodovia.slice(0, 2) : null;
  }
  function definir(resp, p, o) {
    const uf = ufDe(resp, p);
    const rotulo = D.rotuloKm(resp.rodovia || p.rodovia, typeof resp.km === "number" ? resp.km : p.km, uf);
    const aviso = D.avisoPrecisao(resp.precisao_m);
    destinoKm = { lat: resp.lat, lon: resp.lon, rotulo, precisao_m: resp.precisao_m, estimado: resp.estimado !== false, aviso };
    C.emit("km:destino", destinoKm);
    C.busca.irPara({ lat: resp.lat, lon: resp.lon, rotulo });
    if (aviso) { C.mensagem(aviso, 8000); if (o && o.voz) falar(rotulo + ". " + aviso); }
    else if (o && o.voz) falar("Traçando rota para " + rotulo.replace("-", " ") + (destinoKm.estimado ? ", ponto estimado." : "."));
  }
  function naoAchei(p, o) {
    const t = "Não achei o km " + D.fmtKm(p.km) + " da " + p.rodovia + (p.uf ? " em " + D.nomeUF(p.uf) : "") + ".";
    C.folha.abrir([el("h2", "km-titulo", "Destino não encontrado"), el("p", null, t + " Confira a rodovia e o km, ou escolha o ponto no mapa."), botao("Fechar", "btn btn-grande", C.folha.fechar)]);
    C.mensagem(t, 6000);
    if (o && o.voz) falar(t);
  }
  function erro(p, e, o) {
    const t = e && e.rede ? "Sem conexão para localizar o km." : "Não deu para localizar o km agora.";
    C.mensagem(t, 6000);
    if (o && o.voz) falar(t);
  }
  // Rodovia em vários estados: folha "Qual estado?" (um botão por UF, a UF atual primeiro) e a voz pergunta
  function perguntarUf(p, ufs, o) {
    const lista = D.ordenarUfs(ufs.filter((u) => u && u.uf), ufAtual());
    const col = el("div", "coluna-botoes km-ufs"); col.id = "km-ufs";
    for (const u of lista) {
      const b = botao(D.nomeUF(u.uf) + " (" + String(u.uf).toUpperCase() + ")", "btn btn-grande km-uf", () => { C.folha.fechar(); irParaKm(Object.assign({}, p, { uf: String(u.uf).toUpperCase() }), o); });
      b.dataset.uf = String(u.uf).toUpperCase(); col.appendChild(b);
    }
    const cancelar = botao("Cancelar", "btn btn-grande", C.folha.fechar); cancelar.id = "km-ufs-cancelar";
    C.folha.abrir([el("h2", "km-titulo", "Qual estado?"), el("p", "dica", "A " + p.rodovia + " passa por mais de um estado. Em qual fica o km " + D.fmtKm(p.km) + "?"), col, cancelar]);
    const siglas = lista.map((u) => String(u.uf).toUpperCase());
    const frase = p.rodovia.replace("-", " ") + " km " + Math.round(p.km) + " fica em mais de um estado. Qual? " + D.ufsFaladas(siglas) + ".";
    if (o && o.voz && C.comandos && C.comandos.perguntar) {
      C.comandos.perguntar(frase, (textos) => {
        for (const t of textos) {
          const uf = D.ufDoTexto(t, siglas);
          if (uf) { const b = col.querySelector('[data-uf="' + uf + '"]'); if (b) { b.click(); return true; } }
          if (/\b(cancela|cancelar|deixa|nenhum)\b/i.test(String(t))) { cancelar.click(); return true; }
        }
        return false;
      }, "km-ufs");
    } else if (o && o.voz) falar(frase);
  }
  // p: { rodovia, km, uf? }. o: { voz: true } quando veio da voz (fala as respostas)
  async function irParaKm(p, o) {
    if (!online()) { C.mensagem("Sem internet para localizar o km.", 6000); if (o && o.voz) falar("Sem internet para localizar o km."); return false; }
    C.mensagem("Localizando " + D.rotuloKm(p.rodovia, p.km, p.uf) + "…", 6000);
    let resp;
    try { resp = await pontoDoKm(p); } catch (e) { erro(p, e, o); return false; }
    if (resp && resp.encontrado && isFinite(resp.lat) && isFinite(resp.lon)) { definir(resp, p, o); return true; }
    const ufs = resp && Array.isArray(resp.ufs_disponiveis) ? resp.ufs_disponiveis : [];
    if (ufs.length) { perguntarUf(p, ufs, o); return true; }
    naoAchei(p, o);
    return false;
  }
  // Para a busca por texto (ui/busca.js): resultado único, ou um por UF quando a rodovia passa por vários estados
  async function procurar(texto) {
    const p = D.interpretarDestinoKm(texto);
    if (!p) return [];
    const resp = await pontoDoKm(p);
    if (resp && resp.encontrado && isFinite(resp.lat) && isFinite(resp.lon)) {
      const uf = ufDe(resp, p);
      const rotulo = D.rotuloKm(resp.rodovia || p.rodovia, typeof resp.km === "number" ? resp.km : p.km, uf);
      const av = D.avisoPrecisao(resp.precisao_m);
      return [{ nome: rotulo, detalhe: (resp.estimado === false ? "Ponto da rodovia" : "Ponto estimado") + (av ? " · " + av.replace(/^Ponto estimado, /, "").replace(/\.$/, "") : "") + " · " + (resp.metodo || "km"), lat: resp.lat, lon: resp.lon,
        aoTocar: () => definir(resp, Object.assign({}, p, { uf }), {}) }];
    }
    const ufs = resp && Array.isArray(resp.ufs_disponiveis) ? D.ordenarUfs(resp.ufs_disponiveis.filter((u) => u && u.uf), ufAtual()) : [];
    return ufs.map((u) => ({ nome: D.rotuloKm(p.rodovia, p.km, String(u.uf).toUpperCase()), detalhe: "Qual estado? " + D.nomeUF(u.uf) + " · toque para localizar", lat: null, lon: null,
      aoTocar: () => irParaKm(Object.assign({}, p, { uf: String(u.uf).toUpperCase() }), {}) }));
  }
  // Voz (ui/comandos.js): r = resultado de interpretar (ir_para / talvez_lugar). Trata e devolve true quando é destino por km.
  function deVoz(r) {
    if (!r) return false;
    const texto = [r.lugar || r.consulta || "", r.uf ? String(r.uf) : ""].join(" ");
    const p = D.interpretarDestinoKm(texto) || D.interpretarDestinoKm(r.consulta || "");
    if (!p) return false;
    irParaKm(p, { voz: true });
    return true;
  }
  // Autocompletar: "BR-1" → rodovias que começam assim (copiloto_km_highways)
  function prefixo(texto) { return D.prefixoRodovia(texto); }
  function listaDeRodovias(resp) {
    const l = Array.isArray(resp) ? resp : resp && (resp.rodovias || resp.highways || resp.lista) || [];
    return l.map((x) => (typeof x === "string" ? { rodovia: x, ufs: [] } : { rodovia: x.rodovia || x.highway || x.nome || "", ufs: x.ufs || x.estados || [] })).filter((x) => x.rodovia);
  }
  async function sugerirRodovias(pref) {
    if (!pref || !online()) return [];
    if (rodoviasCache.has(pref)) return rodoviasCache.get(pref);
    let resp;
    try { resp = await rpc("copiloto_km_highways", { p_prefix: pref }); } catch (e) { return []; }
    const lista = listaDeRodovias(resp).slice(0, 8);
    rodoviasCache.set(pref, lista); if (rodoviasCache.size > 40) rodoviasCache.delete(rodoviasCache.keys().next().value);
    return lista;
  }
  function avisoDestino(rota) {
    if (!destinoKm || !destinoKm.aviso || !rota || !rota.destino) return null;
    const d = D.distanciaM(destinoKm, rota.destino);
    return d < 50 ? destinoKm.aviso + " Fonte: referência de km (PRF/ARTESP/DNIT), não o marco na estrada." : null;
  }
  C.rotaExtras = C.rotaExtras || { folha: [], cartao: [] };
  C.rotaExtras.folha.push(function (r) {
    const t = avisoDestino(r);
    if (!t) return null;
    const p = el("p", "aviso-rota km-aviso-destino", t); p.id = "km-aviso-destino";
    return p;
  });

  C.aoIniciar(() => {
    criarElemento();
    C.on("posicao", () => { if (navegando()) atualizar(false); });
    C.on("navegacao", (d) => { if (d && d.ativa === false) { atual = null; desenhar(); } else if (d && d.ativa) { if (!elKm) criarElemento(); desenhar(); atualizar(false); } });
    C.on("gps-sinal", (d) => { if (d && d.ok === false && atual) { atual = null; desenhar(); } });
    C.on("rota-limpa", () => { destinoKm = null; });
    C.on("comando:qual-km", (d) => { if (d && d.atender) d.atender(); responderVoz(); });
    window.addEventListener("offline", () => { if (atual) { atual = null; desenhar(); } });
  });

  // km de um PONTO qualquer (o que o motorista toca no mapa), a até 150 m de uma rodovia: { rodovia, uf, km, oficial, estimado } ou null.
  // Mesmo cache e as mesmas fontes do "em que km estou" (DNIT oficial, depois PRF/ARTESP estimado); sem internet ou sem resposta em 4 s: null.
  async function em(pos) {
    if (!pos || !isFinite(pos.lat) || !isFinite(pos.lon) || !online()) return null;
    const t = new Promise((ok) => setTimeout(() => ok(null), 4000));
    const r = await Promise.race([pedir(pos).catch(() => null), t]);
    return r && !r.falhou ? D.escolherKm(r.snv, r.kmAt, 150) : null;
  }
  C.km = { em, atual: () => atual, recente: (maxMs) => (atual && respondidoEm && Date.now() - respondidoEm <= (maxMs || 120000) ? atual : null), responderVoz, ehDestino, procurar, irParaKm, deVoz, prefixo, sugerirRodovias, avisoDestino, atualizar: () => atualizar(true),
    _cache: cache };
})(window.Copiloto);
