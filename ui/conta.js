// Conta: entrar (Google ou e-mail), criar conta, sair, reputação e relatos esperando internet. Aba "Conta".
// Entrar com Google: OAuth do Supabase pelo fluxo PKCE (nuvem.js). A ida é na MESMA janela (location.assign): no app
// instalado no iPhone a página do Google abre por cima do Copiloto (navegador interno do app, mesmo armazenamento) e,
// quando o Supabase manda de volta para o endereço do app, ela fecha e o Copiloto abre com ?code=… (ver docs/LOGIN_GOOGLE.md).
(function (C) {
  "use strict";
  const { $, el, plural } = C.util;
  const nuvem = C.nuvem;

  function msgConta(texto, erro) {
    const e = $("c-msg");
    e.textContent = texto || ""; e.hidden = !texto;
    e.classList.toggle("erro-msg", !!erro);
  }
  function desenhar(recarregarReputacao) {
    const logado = nuvem.logado();
    $("conta-fora").hidden = logado;
    $("conta-dentro").hidden = !logado;
    if (!logado) return;
    const u = nuvem.usuario() || {};
    $("c-usuario").textContent = u.email || "Conta sem e-mail";
    const n = nuvem.filaDoUsuario().length;
    $("c-fila").hidden = !n;
    $("c-fila").textContent = n ? plural(n, "relato esperando", "relatos esperando") + " a internet para ser enviado." : "";
    if (recarregarReputacao) carregarReputacao();
  }
  async function carregarReputacao() {
    const box = $("c-reputacao");
    try {
      const r = (await nuvem.rpc("copiloto_my_reputation", {})) || {};
      const num = (v) => (v == null || !isFinite(v) ? "--" : String(Math.round(Number(v) * 100) / 100).replace(".", ","));
      box.textContent = "";
      box.append(el("h2", null, "Sua reputação"), el("div", "reputacao-num", num(r.reputation)),
        el("div", "dica", "Relatos enviados: " + num(r.reports_total) + " · confirmados: " + num(r.reports_confirmed) + " · escondidos: " + num(r.reports_hidden)),
        el("div", "dica", "Acertos: " + num(r.hits) + " · erros: " + num(r.misses)),
        el("div", "dica", "Sobe quando outros motoristas confirmam seus relatos e cai quando negam."));
    } catch (e) {
      box.textContent = "";
      box.append(el("h2", null, "Sua reputação"), el("div", "dica", "Não foi possível carregar: " + e.message));
    }
  }
  // ------------------------------------------------------------ Google
  const N = window.CopilotoNuvem;
  function standalone() {
    try { return !!(navigator.standalone || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)); } catch (e) { return false; }
  }
  // Ir para outra página (o teste troca para ver a URL sem sair do app).
  C.conta = { irPara: (url) => window.location.assign(url) };
  async function entrarGoogle() {
    const b = $("btn-google");
    b.disabled = true; msgConta("Abrindo o Google…");
    try {
      const url = await nuvem.iniciarOAuth("google", N.urlDeRetorno(window.location.href));
      C.conta.irPara(url);
    } catch (e) { msgConta(e.message, true); b.disabled = false; }
  }
  function montarGoogle() {
    if ($("btn-google")) return;
    const caixa = el("div", "conta-social"); caixa.id = "conta-social";
    const b = el("button", "btn btn-google", null); b.type = "button"; b.id = "btn-google";
    b.append(el("span", "g-logo", "G"), el("span", null, "Entrar com Google"));
    b.addEventListener("click", entrarGoogle);
    caixa.append(b);
    if (standalone()) caixa.append(el("p", "dica", "No app da tela de início, a página do Google abre por cima do Copiloto e fecha sozinha quando você termina. Se ela ficar aberta, toque em OK e entre com e-mail e senha."));
    caixa.append(el("p", "ou-separador", "ou com e-mail"));
    const form = $("form-conta");
    form.parentNode.insertBefore(caixa, form);
  }
  // Volta do Google (?code=… ou ?error=…): limpa a URL na hora (recarregar não repete) e conclui.
  async function tratarRetorno() {
    const href = window.location.href;
    try { nuvem.descartarPkceVencido(); } catch (e) { /* segue */ } // login abandonado há mais de 10 min: o verificador sai
    const ret = N.lerRetornoOAuth(href);
    if (!ret) return;
    try { history.replaceState(history.state, "", N.urlSemRetorno(href)); } catch (e) { /* segue */ }
    C.abas.irPara("conta");
    msgConta("Entrando com o Google…");
    try {
      await nuvem.concluirOAuth(href);
      msgConta("Pronto! Você entrou com o Google. Seus relatos agora vão para outros motoristas.");
    } catch (e) { msgConta(e.message, true); }
  }

  function lerCredenciais() { return { email: $("c-email").value.trim(), senha: $("c-senha").value }; }
  function travar(v) { $("btn-entrar").disabled = v; $("btn-criar-conta").disabled = v; }
  async function entrar() {
    const { email, senha } = lerCredenciais();
    if (!email || !senha) { msgConta("Digite o e-mail e a senha.", true); return; }
    travar(true); msgConta("Entrando…");
    try {
      await nuvem.entrar(email, senha);
      $("c-senha").value = "";
      msgConta("Pronto! Você entrou. Seus relatos agora vão para outros motoristas.");
    } catch (e) { msgConta(e.message, true); }
    finally { travar(false); }
  }
  async function criarConta() {
    const { email, senha } = lerCredenciais();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msgConta("Digite um e-mail válido.", true); return; }
    if (senha.length < 6) { msgConta("A senha precisa ter pelo menos 6 caracteres.", true); return; }
    travar(true); msgConta("Criando a conta…");
    try {
      const r = await nuvem.cadastrar(email, senha);
      $("c-senha").value = "";
      msgConta(r.confirmar ? "Enviamos um e-mail de confirmação. Confirme e depois entre." : "Conta criada. Você já entrou.");
    } catch (e) { msgConta(e.message, true); }
    finally { travar(false); }
  }
  async function sair() {
    await nuvem.sair();
    msgConta("Você saiu da conta. Os relatos novos ficam só neste aparelho.");
  }

  C.aoIniciar(() => {
    C.abas.registrar({ id: "conta", rotulo: "Conta", tela: $("tela-conta"), aoAbrir: () => desenhar(true) });
    $("form-conta").addEventListener("submit", (ev) => { ev.preventDefault(); entrar(); });
    $("btn-criar-conta").addEventListener("click", criarConta);
    $("btn-sair").addEventListener("click", sair);
    montarGoogle();
    C.on("fila", () => { if (!$("tela-conta").hidden) desenhar(false); });
    C.on("sessao", (s) => desenhar(!!s));
    desenhar(false);
    tratarRetorno();
  });
})(window.Copiloto);
