// Conta: entrar, criar conta, sair, reputação e relatos esperando internet. Aba "Conta".
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
    C.on("fila", () => { if (!$("tela-conta").hidden) desenhar(false); });
    C.on("sessao", (s) => desenhar(!!s));
    desenhar(false);
  });
})(window.Copiloto);
