// Nuvem: login (Supabase Auth / GoTrue), chamadas RPC e fila offline dos relatos.
// Contrato: docs/API_RELATOS.md (v3.3). Sem biblioteca externa: só fetch.
// fetch, storage, relógio e agendador são injetáveis para teste (Node).
(function (raiz) {
  "use strict";

  const CHAVE_SESSAO = "copiloto.sessao.v1";
  const CHAVE_FILA = "copiloto.fila.v1";
  const PKCE_VALIDADE_MS = 10 * 60 * 1000;  // verificador esquecido (login abandonado) é descartado depois de 10 minutos
  const CHAVE_PKCE = "copiloto.pkce.v1";   // verificador PKCE do login social, entre a ida ao Google e a volta
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
    // taxonomia 7.1 (E5)
    fila: "congestion",
    objeto: "road_object",
    veiculo_parado: "stopped_vehicle",
    alagamento: "flooding",
    neblina: "fog",
    pista_escorregadia: "slippery_road",
    balanca: "weigh_station",
  };
  const SERVIDOR_PARA_APP = {};
  for (const k of Object.keys(APP_PARA_SERVIDOR)) SERVIDOR_PARA_APP[APP_PARA_SERVIDOR[k]] = k;
  function tipoParaServidor(t) { return APP_PARA_SERVIDOR[t] || null; }
  function tipoParaApp(t) { return SERVIDOR_PARA_APP[t] || null; }

  // ------------------------------------------------------------ níveis
  // COM-05: o motorista não vê o rótulo repetido "não confirmado" nem pontuação numérica.
  //  texto     = frase do detalhe (popup) e do título do marcador;
  //  indicador = sinal discreto no alerta ("" = nada; "Contestado" continua visível: é informação de segurança).
  const NIVEIS = {
    reported:  { texto: "Relato de motorista", indicador: "", mostrar: true },
    probable:  { texto: "Confirmado por outro motorista", indicador: "✓", mostrar: true },
    confirmed: { texto: "Confirmado por motoristas", indicador: "✓✓", mostrar: true },
    disputed:  { texto: "Contestado", indicador: "? Contestado", mostrar: true },
    hidden:    { texto: "Escondido (só você vê)", indicador: "", mostrar: false },
  };
  function textoNivel(nivel) { return (NIVEIS[nivel] && NIVEIS[nivel].texto) || NIVEIS.reported.texto; }
  function indicadorNivel(nivel) { return NIVEIS[nivel] ? NIVEIS[nivel].indicador : ""; }
  // Linha do detalhe: "Relato de motorista · 2 confirmações". Nunca mostra a pontuação.
  function detalheNivel(r) {
    const n = Math.max(0, Math.floor(Number(r && r.confirm_count) || 0));
    return "Relato de motorista · " + n + (n === 1 ? " confirmação" : " confirmações");
  }
  // ---- rodovia e km do relato (r6; copiloto_report_set_road / copiloto_report_roads)
  const RE_RODOVIA = /^[A-Z]{2,3}-[0-9]{1,4}[A-Z]?$/;
  // Do km atual do app ({ rodovia, km, … }) para { road_ref, km }; null quando não vale (sem rodovia no formato ou km fora de 0–5.000).
  function rodoviaDoRelato(atual) {
    if (!atual || typeof atual.rodovia !== "string") return null;
    const ref = atual.rodovia.trim().toUpperCase().replace(/\s+/g, "-");
    if (!RE_RODOVIA.test(ref)) return null;
    const km = typeof atual.km === "number" && isFinite(atual.km) && atual.km >= 0 && atual.km <= 5000 ? Math.round(atual.km * 1000) / 1000 : null;
    return { road_ref: ref, km };
  }
  // "BR-153 km 140" (km sem casas inúteis: 140,5 → "140,5"); só a rodovia se não houver km; "" sem rodovia.
  function textoRodovia(r) {
    if (!r || typeof r.road_ref !== "string" || !r.road_ref) return "";
    const km = r.km == null || r.km === "" ? null : Number(r.km);
    return r.road_ref + (km != null && isFinite(km) ? " km " + String(Math.round(km * 10) / 10).replace(".", ",") : "");
  }
  // Depois do envio: grava rodovia/km no relato recém-criado (só "created": confirmar um existente não é autoria). Falha em silêncio.
  async function definirRodovia(chamar, resposta, rodovia) {
    if (!rodovia || !resposta || resposta.action !== "created" || resposta.report_id == null) return false;
    try { await chamar("copiloto_report_set_road", { p_report_id: resposta.report_id, p_road_ref: rodovia.road_ref, p_km: rodovia.km == null ? null : rodovia.km }); return true; }
    catch (e) { return false; }
  }
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

  // ------------------------------------------------------------ hora da observação (M7)
  // Hora (ms) em que o motorista viu o problema: item.observadoEm, senão params.p_observed_at, senão o padrão.
  function horaObservada(item, padrao) {
    const i = item || {};
    if (i.observadoEm != null && isFinite(i.observadoEm)) return Number(i.observadoEm);
    const p = i.params && i.params.p_observed_at ? Date.parse(i.params.p_observed_at) : NaN;
    if (isFinite(p)) return p;
    return isFinite(padrao) ? Number(padrao) : Date.now();
  }
  // Cópia de params com p_observed_at (ISO 8601, UTC). Não muda o original; mantém o que já veio.
  function comHoraObservada(params, ms) {
    const c = Object.assign({}, params || {});
    if (!c.p_observed_at && isFinite(ms)) c.p_observed_at = new Date(Number(ms)).toISOString();
    return c;
  }


  // ------------------------------------------------------------ login social (OAuth do GoTrue, fluxo PKCE)
  // Ida: <url>/auth/v1/authorize?provider=google&redirect_to=<app>&code_challenge=<S256 do verificador>&code_challenge_method=s256
  // Volta: <app>?code=<auth_code> → POST /auth/v1/token?grant_type=pkce { auth_code, code_verifier } → mesma sessão do e-mail.
  // Erro na volta: ?error=…&error_code=…&error_description=… (ou no #, no fluxo implícito).
  const MSG_PROVEDOR_DESLIGADO = "Entrar com Google ainda não está ativado no servidor. Use e-mail e senha por enquanto.";
  const MSG_OAUTH = {
    provider_disabled: MSG_PROVEDOR_DESLIGADO,
    access_denied: "Login com Google cancelado.",
    verificador_vencido: "O login com Google demorou demais e foi descartado por segurança. Toque em \"Entrar com Google\" de novo.",
    verificador_ausente: "O login com Google voltou para um navegador diferente de onde começou. Toque em \"Entrar com Google\" de novo, aqui mesmo, ou use e-mail e senha.",
    flow_state_not_found: "O login com Google demorou demais. Toque em \"Entrar com Google\" de novo.",
    flow_state_expired: "O login com Google demorou demais. Toque em \"Entrar com Google\" de novo.",
    bad_code_verifier: "O login com Google não foi aceito. Toque em \"Entrar com Google\" de novo.",
    signup_disabled: "Cadastro desligado no servidor.",
  };
  function mensagemErroOAuth(codigo, descricao) {
    const d = String(descricao || "");
    if (/provider is not enabled|unsupported provider|provider.*not.*enabled/i.test(d)) return MSG_PROVEDOR_DESLIGADO;
    if (MSG_OAUTH[codigo]) return MSG_OAUTH[codigo];
    if (MSG_AUTH[codigo]) return MSG_AUTH[codigo];
    return "Não foi possível entrar com o Google" + (d ? ": " + d : ".");
  }

  const ALFABETO_PKCE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  function criptoPadrao() { return (raiz && raiz.crypto) || (typeof crypto !== "undefined" ? crypto : null); }
  // Verificador PKCE (RFC 7636): 64 caracteres de [A-Za-z0-9-._~]. aleatorio(n) → Uint8Array(n) (injetável para teste).
  function gerarVerificador(aleatorio) {
    const gerar = aleatorio || ((n) => { const c = criptoPadrao(); if (!c || !c.getRandomValues) throw new Error("sem gerador aleatório seguro"); return c.getRandomValues(new Uint8Array(n)); });
    const bytes = gerar(64);
    let s = "";
    for (let i = 0; i < 64; i++) s += ALFABETO_PKCE[bytes[i] % 66]; // 66 símbolos: 256 % 66 = 58, viés desprezível
    return s;
  }
  function base64url(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = ""; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // Desafio S256 = base64url(sha256(verificador)), sem "=".
  async function desafioPkce(verificador, sutil) {
    const s = sutil || (criptoPadrao() && criptoPadrao().subtle);
    if (!s) throw new Error("sem crypto.subtle");
    const hash = await s.digest("SHA-256", new TextEncoder().encode(String(verificador)));
    return base64url(new Uint8Array(hash));
  }
  function urlAutorizar(base, provedor, redirectTo, desafio) {
    const q = "provider=" + encodeURIComponent(provedor) + "&redirect_to=" + encodeURIComponent(redirectTo) +
      "&code_challenge=" + encodeURIComponent(desafio) + "&code_challenge_method=s256";
    return String(base || "").replace(/\/+$/, "") + "/auth/v1/authorize?" + q;
  }
  // Endereço de volta: a página do app sem consulta, sem # e sem "index.html" (o que vai na lista de Redirect URLs).
  function urlDeRetorno(href) {
    const u = new URL(href);
    return u.origin + u.pathname.replace(/index\.html$/, "");
  }
  const PARAMS_RETORNO = ["code", "error", "error_code", "error_description", "state", "sb", "access_token", "refresh_token", "expires_in", "expires_at", "token_type", "provider_token", "provider_refresh_token", "type"];
  // Lê a volta do OAuth na URL: { code } | { erro: { codigo, descricao } } | null (abertura normal).
  function lerRetornoOAuth(href) {
    let u; try { u = new URL(href); } catch (e) { return null; }
    const hash = new URLSearchParams(u.hash.replace(/^#/, ""));
    const pega = (k) => u.searchParams.get(k) || hash.get(k);
    const erro = pega("error") || pega("error_code");
    if (erro) return { erro: { codigo: pega("error_code") || pega("error"), descricao: pega("error_description") || "" } };
    const code = u.searchParams.get("code");
    if (code) return { code };
    return null;
  }
  // A mesma URL sem os parâmetros da volta (para history.replaceState: recarregar não repete o login).
  function urlSemRetorno(href) {
    const u = new URL(href);
    for (const k of PARAMS_RETORNO) u.searchParams.delete(k);
    const hash = new URLSearchParams(u.hash.replace(/^#/, ""));
    let mexeu = false;
    for (const k of PARAMS_RETORNO) if (hash.has(k)) { hash.delete(k); mexeu = true; }
    if (mexeu) u.hash = hash.toString();
    let s = u.toString();
    if (/[?#]$/.test(s)) s = s.replace(/[?#]+$/, "");
    return s;
  }

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
    // metodo "GET" (sem corpo) só para /auth/v1/settings; o resto é POST.
    async function http(caminho, corpo, token, metodo) {
      if (!fazerFetch) throw erroRede();
      const get = metodo === "GET";
      const cab = get ? { apikey: CHAVE } : { "content-type": "application/json", apikey: CHAVE };
      if (token) cab.authorization = "Bearer " + token;
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const t = ctl ? setTimeout(() => ctl.abort(), tempoLimite) : null;
      if (t && t.unref) t.unref();
      let resp;
      try {
        resp = await fazerFetch(URL_BASE + caminho, get ? { method: "GET", headers: cab, signal: ctl ? ctl.signal : undefined } : {
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

    // ---------------------------------------------------------- login social (Google), PKCE
    // O provedor está ligado no servidor? GET /auth/v1/settings → { external: { google: true|false } }.
    // true/false; null = não deu para saber (servidor antigo, resposta estranha). Sem internet: lança erro de rede.
    async function provedorAtivo(provedor) {
      const r = await http("/auth/v1/settings", null, null, "GET");
      if (!r.ok || !r.json || !r.json.external || typeof r.json.external[provedor] !== "boolean") return null;
      return r.json.external[provedor];
    }
    // Prepara a ida ao provedor: confere se está ligado (desligado → erro "provider_disabled", sem sair do app), gera e
    // guarda o verificador (copiloto.pkce.v1) e devolve a URL de /auth/v1/authorize. Quem chama faz location.assign(url).
    async function iniciarOAuth(provedor, redirectTo) {
      const p = provedor || "google";
      const ativo = await provedorAtivo(p);
      if (ativo === false) throw new ErroNuvem("provider_disabled", MSG_PROVEDOR_DESLIGADO, { status: 400 });
      const verificador = gerarVerificador(o.aleatorio);
      const desafio = await desafioPkce(verificador, o.sutil);
      gravar(CHAVE_PKCE, { verificador, provedor: p, criadoEm: agora() });
      return urlAutorizar(URL_BASE, p, redirectTo, desafio);
    }
    // Descarta o verificador esquecido há mais de 10 minutos (login abandonado). true se descartou.
    function descartarPkceVencido() {
      const g = ler(CHAVE_PKCE, null);
      if (g && !(agora() - Number(g.criadoEm) <= PKCE_VALIDADE_MS)) { gravar(CHAVE_PKCE, null); return true; }
      return false;
    }
    // Trata a volta (href = location.href). Sem nada de OAuth na URL: null. Com erro: lança com a mensagem em português.
    // Com ?code=: troca pelo token (grant_type=pkce) e grava a sessão como no login por e-mail (mesma renovação).
    async function concluirOAuth(href) {
      // verificador abandonado (foi ao Google e não voltou): sai do aparelho depois de 10 minutos, volte ou não
      const vencido = descartarPkceVencido();
      const guardado = vencido ? null : ler(CHAVE_PKCE, null);
      const ret = lerRetornoOAuth(href);
      if (!ret) return null;
      gravar(CHAVE_PKCE, null); // um uso só
      if (ret.erro) throw new ErroNuvem(String(ret.erro.codigo || "oauth"), mensagemErroOAuth(ret.erro.codigo, ret.erro.descricao), { status: 400 });
      if (!guardado || !guardado.verificador) {
        if (vencido) throw new ErroNuvem("verificador_vencido", MSG_OAUTH.verificador_vencido);
        throw new ErroNuvem("verificador_ausente", MSG_OAUTH.verificador_ausente);
      }
      const r = await http("/auth/v1/token?grant_type=pkce", { auth_code: ret.code, code_verifier: guardado.verificador });
      if (!r.ok) {
        const j = r.json || {};
        const codigo = j.error_code || j.code || j.error || "oauth";
        throw new ErroNuvem(String(codigo), mensagemErroOAuth(String(codigo), j.msg || j.message || j.error_description), { status: r.status });
      }
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

    // RPC pública (GRANT a anon): só a chave publicável, sem token, com ou sem conta (custos da rota, ui/custos.js).
    // Mesmos erros da rpc(): .rede sem internet/demora; recusa (401 sem código) vira "28000".
    async function rpcPublica(nome, params) {
      const r = await http("/rest/v1/rpc/" + encodeURIComponent(nome), params || {}, null);
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

    // item: { id, tipo, valor, lat, lon, expiraEm, observadoEm?, params } (params = corpo do copiloto_report_submit)
    // M7: a hora da observação (observadoEm, ms; padrão = agora) vai junto em params.p_observed_at, para o servidor contar
    // a validade a partir dela e não do reenvio.
    function enfileirar(item) {
      if (!item || !item.id || !item.params) return false;
      if (fila.some((x) => x.id === item.id)) return false; // nunca duas vezes o mesmo
      const t = agora();
      const obs = horaObservada(item, t);
      const novo = Object.assign({ criadoEm: t, usuario: sessao && sessao.user ? sessao.user.id : null }, item, { observadoEm: obs });
      novo.params = comHoraObservada(item.params, obs);
      fila.push(novo);
      gravarFila();
      return true;
    }
    // B3 (QA3): item.seguraAte (ms) segura o reenvio até essa hora — o envio direto cancelado na tela ainda pode estar
    // chegando ao servidor; quem segurou chama liberar(id) (não chegou) ou retirar(id) (chegou: não manda de novo).
    function liberar(id) {
      const x = fila.find((i) => i.id === id);
      if (!x || x.seguraAte == null) return false;
      delete x.seguraAte; gravarFila(); return true;
    }
    function retirar(id) {
      if (!fila.some((i) => i.id === id)) return false;
      fila = fila.filter((i) => i.id !== id); gravarFila(); return true;
    }
    function filaAtual() { return fila.slice(); }
    function filaDoUsuario() {
      const u = sessao && sessao.user ? sessao.user.id : null;
      return fila.filter((x) => !x.usuario || x.usuario === u);
    }

    // Só uma resposta 4xx do servidor (fora 401/408/429) é recusa pela regra e tira o relato da fila. Erro de rede,
    // 5xx (inclusive na renovação do token, quando a internet volta) ou resposta sem status: o relato continua guardado.
    function recusaDeRegra(e) {
      const s = e && e.status;
      return s >= 400 && s < 500 && s !== 401 && s !== 408 && s !== 429;
    }

    // Reenvia o que ficou na fila. Chamadas simultâneas recebem a mesma execução (sem reenvio duplicado).
    function processarFila() {
      if (processando) return processando;
      processando = (async () => {
        const res = { enviados: 0, descartados: 0, restantes: 0 };
        try {
          // B3 (QA3): sempre assíncrono. Sem nenhum await (fila só com itens segurados, sem sessão), o finally rodava ANTES
          // de `processando` receber a promessa, e ela ficava presa: todo processarFila() seguinte devolvia o resultado velho.
          await Promise.resolve();
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
            if (item.seguraAte != null && item.seguraAte > agora()) continue; // B3: o envio direto ainda pode chegar
            try {
              // M7: item guardado antes da M7 (sem p_observed_at) usa a hora em que entrou na fila
              const resp = await rpc("copiloto_report_submit", comHoraObservada(item.params, horaObservada(item, item.criadoEm)));
              if (item.rodovia) await definirRodovia(rpc, resp, item.rodovia); // fila: rodovia/km do momento do relato (silencioso)
              fila = fila.filter((x) => x.id !== item.id); res.enviados++; gravarFila();
            } catch (e) {
              if (e.rede) break; // ainda sem internet: tenta depois
              if (e.codigo === "28000" || e.codigo === "sessao_expirada") break; // precisa entrar de novo
              if (!recusaDeRegra(e)) break; // servidor fora do ar (5xx), renovação do token falhou etc.: tenta depois
              // servidor recusou pela regra (duplicado, inválido, limite): não adianta repetir
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
      on, cadastrar, entrar, sair, renovar, provedorAtivo, iniciarOAuth, concluirOAuth, descartarPkceVencido, rpc, rpcPublica, enfileirar, processarFila, liberar, retirar,
      fila: filaAtual, filaDoUsuario,
      sessao: () => sessao,
      logado: () => !!sessao,
      usuario: () => (sessao ? sessao.user : null),
    };
  }

  // M1: espera antes de tentar de novo a busca de relatos depois de N falhas seguidas (rede ou servidor):
  // 15 s, 30 s, 60 s e depois 2 min no máximo. 0 falhas = pode buscar já.
  const ESPERA_BUSCA_MS = [15000, 30000, 60000, 120000];
  function esperaAposFalha(falhas) {
    const n = Math.floor(Number(falhas) || 0);
    if (n <= 0) return 0;
    return ESPERA_BUSCA_MS[Math.min(n, ESPERA_BUSCA_MS.length) - 1];
  }

  const api = {
    esperaAposFalha, ESPERA_BUSCA_MS, horaObservada, comHoraObservada,
    rodoviaDoRelato, textoRodovia, definirRodovia, criarNuvem, ErroNuvem, NIVEIS, textoNivel, indicadorNivel, detalheNivel, visivel,
    tipoParaServidor, tipoParaApp, APP_PARA_SERVIDOR, SERVIDOR_PARA_APP,
    mensagemErroRpc, mensagemErroAuth, MSG_REDE, CHAVE_SESSAO, CHAVE_FILA,
    CHAVE_PKCE, PKCE_VALIDADE_MS, MSG_PROVEDOR_DESLIGADO, mensagemErroOAuth, gerarVerificador, base64url, desafioPkce, urlAutorizar,
    urlDeRetorno, lerRetornoOAuth, urlSemRetorno,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoNuvem = api;
})(typeof window !== "undefined" ? window : globalThis);
