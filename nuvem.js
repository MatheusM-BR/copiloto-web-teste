// Nuvem: login (Supabase Auth / GoTrue), chamadas RPC e fila offline dos relatos.
// Contrato: docs/API_RELATOS.md (v3). Sem biblioteca externa: só fetch.
// fetch, storage, relógio e agendador são injetáveis para teste (Node).
(function (raiz) {
  "use strict";

  const CHAVE_SESSAO = "copiloto.sessao.v1";
  const CHAVE_FILA = "copiloto.fila.v1";
  const RENOVAR_ANTES_S = 60;      // renova o token 60 s antes de vencer
  const TEMPO_LIMITE_MS = 20000;   // sem resposta em 20 s conta como sem internet

  // ------------------------------------------------------------ tipos app ↔ servidor
  const APP_PARA_SERVIDOR = {
    altura_maxima: "max_height",
    limite_peso: "max_weight",
    obra: "roadwork",
    buraco: "road_damage",
    acidente: "accident",
    radar_movel: "speed_camera_mobile",
    animal: "animal",
  };
  const SERVIDOR_PARA_APP = {};
  for (const k of Object.keys(APP_PARA_SERVIDOR)) SERVIDOR_PARA_APP[APP_PARA_SERVIDOR[k]] = k;
  function tipoParaServidor(t) { return APP_PARA_SERVIDOR[t] || null; }
  function tipoParaApp(t) { return SERVIDOR_PARA_APP[t] || null; }

  // ------------------------------------------------------------ níveis
  const NIVEIS = {
    reported:  { texto: "Não confirmado", mostrar: true },
    probable:  { texto: "Provável", mostrar: true },
    confirmed: { texto: "Confirmado por motoristas", mostrar: true },
    disputed:  { texto: "Contestado", mostrar: true },
    hidden:    { texto: "Escondido (só você vê)", mostrar: false },
  };
  function textoNivel(nivel) { return (NIVEIS[nivel] && NIVEIS[nivel].texto) || "Não confirmado"; }
  // hidden só aparece para o autor (mine=true)
  function visivel(r) { return !!r && (r.level !== "hidden" || r.mine === true); }

  // ------------------------------------------------------------ erros
  const MSG_REDE = "Sem internet";
  const MSG_FIXAS = {
    "28000": "Entre na sua conta para enviar.",
    "23505": "Você já relatou isso aqui.",
    "P0002": "Esse relato não está mais ativo.",
  };
  const MSG_AUTH = {
    invalid_credentials: "E-mail ou senha incorretos.",
    email_not_confirmed: "Seu e-mail ainda não foi confirmado. Abra o e-mail de confirmação que enviamos, toque no link e depois entre.",
    user_already_exists: "Já existe uma conta com esse e-mail. Toque em Entrar.",
    email_exists: "Já existe uma conta com esse e-mail. Toque em Entrar.",
    weak_password: "Senha fraca. Use pelo menos 6 caracteres.",
    validation_failed: "Confira o e-mail e a senha.",
    email_address_invalid: "E-mail inválido.",
    over_email_send_rate_limit: "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
    over_request_rate_limit: "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
    signup_disabled: "Cadastro desligado no servidor.",
    refresh_token_not_found: "Sua sessão expirou. Entre de novo.",
    session_not_found: "Sua sessão expirou. Entre de novo.",
  };

  class ErroNuvem extends Error {
    constructor(codigo, mensagem, extra) {
      super(mensagem);
      this.name = "ErroNuvem";
      this.codigo = codigo;
      this.rede = !!(extra && extra.rede);
      this.status = (extra && extra.status) || 0;
    }
  }

  // Erro de RPC (PostgREST): {code, message}. Devolve a mensagem para o motorista.
  function mensagemErroRpc(code, message, status) {
    if (MSG_FIXAS[code]) return MSG_FIXAS[code];
    if (message) return String(message);
    if (status >= 500) return "O servidor não respondeu direito. Tente de novo.";
    return "Erro no servidor" + (status ? " (HTTP " + status + ")" : "") + ".";
  }
  function mensagemErroAuth(codigo, texto, status) {
    if (MSG_AUTH[codigo]) return MSG_AUTH[codigo];
    if (status >= 500) return "O servidor de contas não respondeu. Tente de novo.";
    return texto ? String(texto) : "Não foi possível falar com o servidor de contas.";
  }
  function erroRede() { return new ErroNuvem("rede", MSG_REDE, { rede: true }); }

  // ------------------------------------------------------------ cliente
  function criarNuvem(opcoes) {
    const o = opcoes || {};
    const URL_BASE = String(o.url || "").replace(/\/+$/, "");
    const CHAVE = o.chave || "";
    const fazerFetch = o.fetch || (typeof fetch === "function" ? fetch.bind(raiz) : null);
    const storage = o.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const agora = o.agora || (() => Date.now());
    const agendar = o.agendar || ((fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; });
    const cancelar = o.cancelar || ((t) => clearTimeout(t));
    const tempoLimite = o.tempoLimiteMs || TEMPO_LIMITE_MS;

    const ouvintes = { sessao: [], fila: [], descartado: [] };
    function on(ev, fn) { ouvintes[ev].push(fn); return () => { ouvintes[ev] = ouvintes[ev].filter((x) => x !== fn); }; }
    function emitir(ev, dado) { for (const fn of ouvintes[ev].slice()) { try { fn(dado); } catch (e) { /* ouvinte com erro não derruba a nuvem */ } } }

    function ler(chave, padrao) {
      try { const b = storage && storage.getItem(chave); return b ? JSON.parse(b) : padrao; } catch (e) { return padrao; }
    }
    function gravar(chave, valor) {
      try { if (!storage) return; if (valor == null) storage.removeItem(chave); else storage.setItem(chave, JSON.stringify(valor)); } catch (e) { /* sem armazenamento */ }
    }

    // ---------------------------------------------------------- HTTP
    async function http(caminho, corpo, token) {
      if (!fazerFetch) throw erroRede();
      const cab = { "content-type": "application/json", apikey: CHAVE };
      if (token) cab.authorization = "Bearer " + token;
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const t = ctl ? setTimeout(() => ctl.abort(), tempoLimite) : null;
      if (t && t.unref) t.unref();
      let resp;
      try {
        resp = await fazerFetch(URL_BASE + caminho, {
          method: "POST", headers: cab, body: JSON.stringify(corpo == null ? {} : corpo), signal: ctl ? ctl.signal : undefined,
        });
      } catch (e) {
        throw erroRede(); // TypeError (sem rede), AbortError (demorou) etc.
      } finally { if (t) clearTimeout(t); }
      let json = null;
      const texto = await resp.text().catch(() => "");
      if (texto) { try { json = JSON.parse(texto); } catch (e) { json = null; } }
      return { status: resp.status, ok: resp.status >= 200 && resp.status < 300, json };
    }

    // ---------------------------------------------------------- sessão
    let sessao = null;
    let timerRenovar = null;
    let renovando = null;

    function normalizarSessao(j) {
      if (!j || !j.access_token) return null;
      const expiraEm = isFinite(j.expires_at) ? Number(j.expires_at)
        : Math.floor(agora() / 1000) + (isFinite(j.expires_in) ? Number(j.expires_in) : 3600);
      const u = j.user || {};
      return { access_token: j.access_token, refresh_token: j.refresh_token || null, expires_at: expiraEm, user: { id: u.id || null, email: u.email || null } };
    }

    function definirSessao(s) {
      sessao = s;
      gravar(CHAVE_SESSAO, s);
      agendarRenovacao();
      emitir("sessao", s);
    }

    function agendarRenovacao() {
      if (timerRenovar != null) { cancelar(timerRenovar); timerRenovar = null; }
      if (!sessao || !sessao.refresh_token) return;
      const ms = Math.max(1000, (sessao.expires_at - RENOVAR_ANTES_S) * 1000 - agora());
      timerRenovar = agendar(() => { timerRenovar = null; renovar().catch(() => {}); }, ms);
    }

    function precisaRenovar() { return !!sessao && sessao.expires_at * 1000 - agora() < RENOVAR_ANTES_S * 1000; }

    // Uma renovação por vez: chamadas simultâneas esperam a mesma.
    function renovar() {
      if (renovando) return renovando;
      if (!sessao || !sessao.refresh_token) return Promise.reject(new ErroNuvem("28000", MSG_FIXAS["28000"]));
      const rt = sessao.refresh_token;
      renovando = (async () => {
        try {
          const r = await http("/auth/v1/token?grant_type=refresh_token", { refresh_token: rt });
          if (r.ok) {
            const nova = normalizarSessao(r.json);
            if (!nova) throw new ErroNuvem("auth", "Resposta inesperada do servidor de contas.");
            if (!nova.user.id && sessao) nova.user = sessao.user;
            definirSessao(nova);
            return nova;
          }
          // refresh token inválido ou revogado: a sessão acabou
          if (r.status === 400 || r.status === 401 || r.status === 403) {
            definirSessao(null);
            throw new ErroNuvem("sessao_expirada", "Sua sessão expirou. Entre de novo.", { status: r.status });
          }
          const c = r.json && (r.json.error_code || r.json.code);
          throw new ErroNuvem(String(c || "auth"), mensagemErroAuth(c, r.json && (r.json.msg || r.json.message), r.status), { status: r.status });
        } finally { renovando = null; }
      })();
      return renovando;
    }

    async function tokenValido() {
      if (!sessao) throw new ErroNuvem("28000", MSG_FIXAS["28000"]);
      if (precisaRenovar()) await renovar();
      return sessao.access_token;
    }

    function erroDeAuth(r) {
      const j = r.json || {};
      const codigo = j.error_code || j.code || j.error || "auth";
      return new ErroNuvem(String(codigo), mensagemErroAuth(codigo, j.msg || j.message || j.error_description, r.status), { status: r.status });
    }

    // Criar conta: com confirmação por e-mail não vem access_token.
    async function cadastrar(email, senha) {
      const r = await http("/auth/v1/signup", { email: String(email || "").trim(), password: String(senha || "") });
      if (!r.ok) throw erroDeAuth(r);
      const s = normalizarSessao(r.json);
      if (s) { definirSessao(s); return { confirmar: false, sessao: s }; }
      return { confirmar: true };
    }

    async function entrar(email, senha) {
      const r = await http("/auth/v1/token?grant_type=password", { email: String(email || "").trim(), password: String(senha || "") });
      if (!r.ok) throw erroDeAuth(r);
      const s = normalizarSessao(r.json);
      if (!s) throw new ErroNuvem("auth", "Resposta inesperada do servidor de contas.");
      definirSessao(s);
      return s;
    }

    // Sair: avisa o servidor se der, mas a sessão local some de qualquer jeito.
    async function sair() {
      const s = sessao;
      definirSessao(null);
      if (s && s.access_token) { try { await http("/auth/v1/logout", {}, s.access_token); } catch (e) { /* sem internet: tudo bem */ } }
    }

    // ---------------------------------------------------------- RPC
    async function rpc(nome, params) {
      let token = await tokenValido();
      let r = await http("/rest/v1/rpc/" + encodeURIComponent(nome), params || {}, token);
      if (r.status === 401 && sessao && sessao.refresh_token) {
        await renovar();          // token vencido ou revogado: renova e tenta de novo uma vez
        token = sessao ? sessao.access_token : null;
        if (!token) throw new ErroNuvem("28000", MSG_FIXAS["28000"]);
        r = await http("/rest/v1/rpc/" + encodeURIComponent(nome), params || {}, token);
      }
      if (r.ok) return r.json;
      const j = r.json || {};
      const code = r.status === 401 && !j.code ? "28000" : String(j.code || "http_" + r.status);
      throw new ErroNuvem(code, mensagemErroRpc(code, j.message, r.status), { status: r.status });
    }

    // ---------------------------------------------------------- fila offline
    let fila = ler(CHAVE_FILA, []);
    if (!Array.isArray(fila)) fila = [];
    let processando = null;

    function gravarFila() { gravar(CHAVE_FILA, fila.length ? fila : null); emitir("fila", fila.slice()); }

    // item: { id, tipo, valor, lat, lon, expiraEm, params } (params = corpo do copiloto_report_submit)
    function enfileirar(item) {
      if (!item || !item.id || !item.params) return false;
      if (fila.some((x) => x.id === item.id)) return false; // nunca duas vezes o mesmo
      fila.push(Object.assign({ criadoEm: agora(), usuario: sessao && sessao.user ? sessao.user.id : null }, item));
      gravarFila();
      return true;
    }
    function filaAtual() { return fila.slice(); }
    function filaDoUsuario() {
      const u = sessao && sessao.user ? sessao.user.id : null;
      return fila.filter((x) => !x.usuario || x.usuario === u);
    }

    // Reenvia o que ficou na fila. Chamadas simultâneas recebem a mesma execução (sem reenvio duplicado).
    function processarFila() {
      if (processando) return processando;
      processando = (async () => {
        const res = { enviados: 0, descartados: 0, restantes: 0 };
        try {
          // vencidos saem antes de tentar
          const t = agora();
          const vencidos = fila.filter((x) => isFinite(x.expiraEm) && x.expiraEm <= t);
          if (vencidos.length) {
            fila = fila.filter((x) => !vencidos.includes(x));
            for (const v of vencidos) emitir("descartado", { item: v, erro: new ErroNuvem("vencido", "O relato venceu antes de a internet voltar.") });
            res.descartados += vencidos.length; gravarFila();
          }
          if (!sessao) { res.restantes = fila.length; return res; }
          for (const item of filaDoUsuario()) {
            if (!fila.some((x) => x.id === item.id)) continue;
            try {
              await rpc("copiloto_report_submit", item.params);
              fila = fila.filter((x) => x.id !== item.id); res.enviados++; gravarFila();
            } catch (e) {
              if (e.rede) break; // ainda sem internet: tenta depois
              if (e.codigo === "28000" || e.codigo === "sessao_expirada") break; // precisa entrar de novo
              // servidor recusou (duplicado, inválido, limite): não adianta repetir
              fila = fila.filter((x) => x.id !== item.id); res.descartados++; gravarFila();
              emitir("descartado", { item, erro: e });
            }
          }
          res.restantes = fila.length;
          return res;
        } finally { processando = null; }
      })();
      return processando;
    }

    // ---------------------------------------------------------- início
    const salva = ler(CHAVE_SESSAO, null);
    if (salva && salva.access_token) { sessao = salva; agendarRenovacao(); }

    return {
      on, cadastrar, entrar, sair, renovar, rpc, enfileirar, processarFila,
      fila: filaAtual, filaDoUsuario,
      sessao: () => sessao,
      logado: () => !!sessao,
      usuario: () => (sessao ? sessao.user : null),
    };
  }

  const api = {
    criarNuvem, ErroNuvem, NIVEIS, textoNivel, visivel,
    tipoParaServidor, tipoParaApp, APP_PARA_SERVIDOR, SERVIDOR_PARA_APP,
    mensagemErroRpc, mensagemErroAuth, MSG_REDE, CHAVE_SESSAO, CHAVE_FILA,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoNuvem = api;
})(typeof window !== "undefined" ? window : globalThis);
