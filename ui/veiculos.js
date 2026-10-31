// Veículos: cadastro local (copiloto.perfis.v1), veículo ativo e chip no mapa.
// Expõe Copiloto.veiculos.ativo() / lista(). Emite "veiculo" (perfil ativo ou null) quando muda ou é editado.
// Tanque (L) e consumo (km/L) — pacote E2 (autonomia): campos criados aqui, sem mexer no index.html.
(function (C) {
  "use strict";
  const { $, botao, novoId, lerJSON, gravarJSON } = C.util;
  const V = window.CopilotoValidacao;
  const CHAVE = "copiloto.perfis.v1";
  let estado = { perfis: [], ativoId: null };
  let editandoId = null;

  function carregar() {
    const o = lerJSON(CHAVE, null);
    if (o && Array.isArray(o.perfis)) estado = { perfis: o.perfis, ativoId: o.ativoId || null };
  }
  function gravar() { gravarJSON(CHAVE, estado); }
  function ativo() { return estado.perfis.find((p) => p.id === estado.ativoId) || null; }

  function fmt(v, un) { return v == null ? null : String(v).replace(".", ",") + (un ? " " + un : ""); }
  function dado(rotulo, v, un) {
    const s = document.createElement("span");
    const t = fmt(v, un);
    if (t == null) { s.className = "nao-informado"; s.textContent = rotulo + ": não informado"; }
    else s.textContent = rotulo + ": " + t;
    return s;
  }

  function desenharLista() {
    const ul = $("lista-perfis"); ul.textContent = "";
    if (!estado.perfis.length) {
      const li = document.createElement("li"); li.className = "dica";
      li.textContent = "Nenhum veículo cadastrado ainda. Cadastre o primeiro abaixo.";
      ul.appendChild(li);
    }
    for (const p of estado.perfis) {
      const li = document.createElement("li"); li.className = "perfil" + (p.id === estado.ativoId ? " ativo" : "");
      const h = document.createElement("h3"); h.textContent = p.nome + " · " + p.tipo;
      if (p.id === estado.ativoId) { const s = document.createElement("span"); s.className = "selo"; s.textContent = "ATIVO"; h.appendChild(s); }
      const d = document.createElement("div"); d.className = "dados";
      d.append(dado("Altura", p.altura, "m"), dado("Largura", p.largura, "m"), dado("Comprimento", p.comprimento, "m"),
               dado("PBTC", p.pbtc, "t"), dado("Eixos", p.eixos, ""),
               dado("Tanque", p.tanque, "L"), dado("Consumo", p.consumo, "km/L"));
      const c = document.createElement("span"); c.textContent = "Carga: " + p.carga; d.appendChild(c);
      const b = document.createElement("div"); b.className = "linha-botoes";
      if (p.id !== estado.ativoId) b.appendChild(botao("Usar este", "btn btn-pequeno btn-principal", () => { estado.ativoId = p.id; gravar(); atualizarTudo(); }));
      b.appendChild(botao("Editar", "btn btn-pequeno", () => editar(p.id)));
      b.appendChild(botao("Excluir", "btn btn-pequeno btn-perigo", () => excluir(p.id)));
      li.append(h, d, b); ul.appendChild(li);
    }
  }

  function excluir(id) {
    estado.perfis = estado.perfis.filter((p) => p.id !== id);
    if (estado.ativoId === id) estado.ativoId = estado.perfis.length ? estado.perfis[0].id : null;
    if (editandoId === id) limparForm();
    gravar(); atualizarTudo();
  }

  const CAMPOS_NUM = ["altura", "largura", "comprimento", "pbtc", "eixos", "tanque", "consumo"];
  function lerForm() {
    const o = { nome: $("f-nome").value, tipo: $("f-tipo").value, carga: $("f-carga").value };
    for (const c of CAMPOS_NUM) o[c] = $("f-" + c).value;
    return o;
  }
  function mostrarErros(erros) {
    for (const c of ["nome", "tipo"].concat(CAMPOS_NUM)) {
      const e = $("e-" + c); if (e) e.textContent = erros[c] || "";
      const i = $("f-" + c); if (i) i.setAttribute("aria-invalid", erros[c] ? "true" : "false");
    }
  }
  function limparForm() {
    editandoId = null; $("form-perfil").reset(); $("f-tipo").value = "Carreta"; mostrarErros({});
    $("titulo-form").textContent = "Novo veículo"; $("btn-cancelar").hidden = true; $("btn-salvar").textContent = "Salvar veículo";
  }
  function editar(id) {
    const p = estado.perfis.find((x) => x.id === id); if (!p) return;
    editandoId = id; mostrarErros({});
    $("f-nome").value = p.nome; $("f-tipo").value = p.tipo; $("f-carga").value = p.carga;
    for (const c of CAMPOS_NUM) $("f-" + c).value = p[c] == null ? "" : String(p[c]).replace(".", ",");
    $("titulo-form").textContent = "Editar veículo"; $("btn-cancelar").hidden = false; $("btn-salvar").textContent = "Salvar alterações";
    $("f-nome").focus();
  }

  function aoSalvar(ev) {
    ev.preventDefault();
    const r = V.validarPerfil(lerForm());
    mostrarErros(r.erros);
    if (!r.ok) { const primeiro = Object.keys(r.erros)[0]; const el = $("f-" + primeiro); if (el) el.focus(); return; }
    if (editandoId) {
      const i = estado.perfis.findIndex((p) => p.id === editandoId);
      if (i >= 0) estado.perfis[i] = Object.assign({ id: editandoId }, r.perfil);
    } else {
      const novo = Object.assign({ id: novoId() }, r.perfil);
      estado.perfis.push(novo);
      if (!estado.ativoId) estado.ativoId = novo.id; // o primeiro vira o ativo
    }
    gravar(); limparForm(); atualizarTudo();
  }

  function atualizarTudo() {
    desenharLista();
    const a = ativo();
    $("chip-veiculo").textContent = a ? a.nome + " · " + a.tipo : "Nenhum veículo ativo";
    C.emit("veiculo", a);
  }

  // Campos de autonomia (E2) na mesma grade das medidas.
  function criarCamposAutonomia() {
    if ($("f-tanque")) return;
    const grade = $("f-eixos").closest(".grade");
    const campo = (id, rotulo, modo, exemplo) => {
      const l = document.createElement("label"); l.htmlFor = "f-" + id; l.append(rotulo);
      const i = document.createElement("input"); i.id = "f-" + id; i.inputMode = modo; i.autocomplete = "off"; i.placeholder = exemplo;
      const e = document.createElement("span"); e.className = "erro"; e.id = "e-" + id;
      l.append(i, e); return l;
    };
    grade.append(campo("tanque", "Tanque (L)", "decimal", "600"), campo("consumo", "Consumo (km/L)", "decimal", "2,5"));
  }

  C.veiculos = { ativo, lista: () => estado.perfis.slice() };

  C.aoIniciar(() => {
    carregar();
    criarCamposAutonomia();
    for (const t of V.TIPOS) $("f-tipo").add(new Option(t, t));
    for (const c of V.CARGAS) $("f-carga").add(new Option(c, c));
    $("f-tipo").value = "Carreta";
    $("form-perfil").addEventListener("submit", aoSalvar);
    $("btn-cancelar").addEventListener("click", limparForm);
    C.abas.registrar({ id: "veiculo", rotulo: "Veículo", tela: $("tela-veiculo") });
    atualizarTudo();
  });
})(window.Copiloto);
