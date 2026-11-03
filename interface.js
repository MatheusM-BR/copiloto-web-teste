// Lógica pura da interface redesenhada (sem DOM): tema automático pelo horário, coordenada digitada na busca, filtro dos
// destinos recentes, texto do endereço (toque no mapa e Emergência) e a frase pronta para dizer ao 191/192/193.
// Usado por ui/tema.js, ui/busca.js e ui/privacidade.js. Testado em tests/interface.test.js.
(function (raiz) {
  "use strict";

  // Automático: claro das 6 h às 17:59, escuro das 18 h às 5:59 (hora do aparelho)
  function temaPorHorario(hora) { return hora >= 6 && hora < 18 ? "claro" : "escuro"; }

  // "-16.6786, -49.2539", "-16,6786; -49,2539", "-16,6786 -49,2539" → { lat, lon } ou null.
  // Vírgula decimal só com separador ";" ou espaço (com vírgula entre os dois, o decimal é ponto).
  function lerCoordenada(texto) {
    const t = String(texto == null ? "" : texto).trim().replace(/\s+/g, " ");
    if (!t) return null;
    const num = "(-?\\d{1,3}(?:[.,]\\d+)?)";
    let m = t.match(new RegExp("^" + num + "\\s*;\\s*" + num + "$")) || t.match(new RegExp("^" + num + " " + num + "$"));
    if (!m) m = t.match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = Number(m[1].replace(",", ".")), lon = Number(m[2].replace(",", "."));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function normalizar(s) {
    return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }
  // destinos recentes ({ rotulo, lat, lon, t }) cujo rótulo contém todas as palavras digitadas (sem acento, sem caixa)
  function filtrarRecentes(lista, texto) {
    const palavras = normalizar(texto).split(/\s+/).filter(Boolean);
    if (!palavras.length) return (lista || []).slice();
    return (lista || []).filter((d) => { const r = normalizar(d && d.rotulo); return palavras.every((p) => r.indexOf(p) >= 0); });
  }

  // vírgula decimal, n casas
  function coord(n, casas) { return (Math.round(n * Math.pow(10, casas)) / Math.pow(10, casas)).toFixed(casas).replace(".", ","); }
  function textoCoordenada(p) { return p && isFinite(p.lat) && isFinite(p.lon) ? coord(p.lat, 5) + ", " + coord(p.lon, 5) : ""; }

  // km com vírgula ("498", "498,3"); aceita número ou texto
  function textoKm(km) {
    if (km == null || km === "") return null;
    const n = Number(String(km).replace(",", "."));
    if (!isFinite(n)) return String(km);
    return (Math.round(n * 10) / 10).toString().replace(".", ",");
  }

  // Endereço (contrato de Copiloto.endereco.perto: { rodovia, km, rua, bairro, cidade, uf, fonte }) →
  // { titulo, linha } para a folha do toque e a Emergência. Sem dado: null (quem chama mostra a coordenada).
  function textoEndereco(e) {
    if (!e || typeof e !== "object") return null;
    const rod = e.rodovia ? String(e.rodovia) + (textoKm(e.km) ? ", km " + textoKm(e.km) : "") : null;
    const lugar = [e.bairro, e.cidade && e.uf ? e.cidade + ", " + e.uf : e.cidade || e.uf].filter(Boolean).join(" · ");
    const titulo = rod || e.rua || lugar || (e.texto ? String(e.texto) : null);
    if (!titulo) return null;
    const resto = [];
    if (rod && e.rua) resto.push("Perto de " + e.rua);
    if (lugar && titulo !== lugar) resto.push(lugar);
    return { titulo, linha: resto.join(" · ") };
  }

  // Frase pronta para dizer ao atendente (191/192/193). Só o que se sabe; sem endereço, a coordenada.
  function fraseEmergencia(e, p) {
    const partes = [];
    if (e && e.rodovia) partes.push("na " + e.rodovia + (textoKm(e.km) ? ", quilômetro " + textoKm(e.km) : ""));
    if (e && e.rua) partes.push((partes.length ? "perto da " : "na ") + e.rua);
    const cidade = e && e.cidade ? e.cidade + (e.uf ? ", " + e.uf : "") : null;
    if (cidade) partes.push("em " + cidade);
    let frase = partes.length ? "Estou " + partes.join(", ") + "." : "";
    if (p && isFinite(p.lat) && isFinite(p.lon)) {
      frase += (frase ? " " : "") + "Coordenadas: latitude " + coord(p.lat, 5) + ", longitude " + coord(p.lon, 5) + ".";
    }
    return frase || null;
  }

  // ------------------------------------------------------------ busca de destino por texto (Photon, Komoot)
  // Serviço público e gratuito: https://photon.komoot.io/api/?q=…&limit=…&lat=…&lon=… (lat/lon = viés pela posição
  // atual: o que está perto vem primeiro). Sem "lang": o Photon público só aceita default/de/en/fr (lang=pt responde 400);
  // o padrão devolve os nomes locais, em português no Brasil.
  const URL_PHOTON = "https://photon.komoot.io/api/";
  function urlBusca(texto, pos, limite, base) {
    let u = (base || URL_PHOTON) + "?q=" + encodeURIComponent(String(texto || "").trim()) + "&limit=" + (limite || 10);
    if (pos && isFinite(pos.lat) && isFinite(pos.lon)) u += "&lat=" + (Math.round(pos.lat * 1e4) / 1e4) + "&lon=" + (Math.round(pos.lon * 1e4) / 1e4);
    return u;
  }
  const UF = { "acre": "AC", "alagoas": "AL", "amapa": "AP", "amazonas": "AM", "bahia": "BA", "ceara": "CE", "distrito federal": "DF",
    "espirito santo": "ES", "goias": "GO", "maranhao": "MA", "mato grosso": "MT", "mato grosso do sul": "MS", "minas gerais": "MG",
    "para": "PA", "paraiba": "PB", "parana": "PR", "pernambuco": "PE", "piaui": "PI", "rio de janeiro": "RJ", "rio grande do norte": "RN",
    "rio grande do sul": "RS", "rondonia": "RO", "roraima": "RR", "santa catarina": "SC", "sao paulo": "SP", "sergipe": "SE", "tocantins": "TO" };
  function siglaUF(estado) { const n = normalizar(estado); return UF[n] || (estado ? String(estado) : null); }
  // GeoJSON do Photon → até `limite` resultados { nome, detalhe, lat, lon, cidade, uf }: no Brasil primeiro, sem repetir
  // (mesmo nome a < 50 m). nome: o nome do lugar ou a rua com número; detalhe: rua (se o nome não for ela), bairro, cidade/UF.
  function resultadosBusca(json, limite) {
    const fs = json && Array.isArray(json.features) ? json.features : [];
    const lista = [];
    for (const f of fs) {
      const c = f && f.geometry && f.geometry.coordinates, p = (f && f.properties) || {};
      if (!Array.isArray(c) || !isFinite(c[0]) || !isFinite(c[1])) continue;
      const rua = p.street ? p.street + (p.housenumber ? ", " + p.housenumber : "") : null;
      const nome = p.name || rua || p.city || p.county || p.state;
      if (!nome) continue;
      const brasil = !p.countrycode || p.countrycode === "BR";
      const uf = brasil ? siglaUF(p.state) : p.country || null;
      const cidade = p.city || p.town || p.village || p.county || null;
      const lugar = cidade && uf && cidade !== nome ? cidade + ", " + uf : cidade && cidade !== nome ? cidade : uf && uf !== nome ? uf : null;
      const detalhe = [rua && rua !== nome ? rua : null, p.district && p.district !== nome ? p.district : null, lugar].filter(Boolean).join(" · ");
      const r = { nome: String(nome), detalhe, lat: c[1], lon: c[0], cidade, uf, brasil };
      const repetido = lista.some((x) => x.nome === r.nome && Math.abs(x.lat - r.lat) < 0.0005 && Math.abs(x.lon - r.lon) < 0.0005);
      if (!repetido) lista.push(r);
    }
    lista.sort((a, b) => (a.brasil === b.brasil ? 0 : a.brasil ? -1 : 1)); // estável: mantém a ordem do Photon
    return lista.slice(0, limite || 6).map((r) => ({ nome: r.nome, detalhe: r.detalhe, lat: r.lat, lon: r.lon }));
  }

  const api = { URL_PHOTON, urlBusca, resultadosBusca, siglaUF, temaPorHorario, lerCoordenada, filtrarRecentes, normalizar, textoCoordenada, textoKm, textoEndereco, fraseEmergencia };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoInterface = api;
})(typeof window !== "undefined" ? window : globalThis);
