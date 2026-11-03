// Fachada na chegada: lógica pura (sem DOM), usada por ui/fachada.js e testada no Node (tests/fachada.test.js).
//  - preferência liga/desliga (copiloto.fachada.v1 = { ligada }, padrão ligada);
//  - gatilho: uma vez por viagem (e por destino), a ~100 m do fim da rota;
//  - lado da rua do destino pelo rumo de chegada e a posição do destino;
//  - foto do Mapillary: caixa de busca em volta do destino, URL da API Graph v4 e escolha da melhor foto
//    (perto do destino e virada para ele).
(function (raiz) {
  "use strict";

  const CHAVE = "copiloto.fachada.v1";
  const LIMITE_M = 100;          // distância (pela rota) em que o cartão aparece
  const RAIO_FOTO_M = 60;        // fotos até 60 m do destino
  const ANGULO_FOTO_MAX = 70;    // câmera virada até 70° do destino
  const LADO_MIN_M = 3;          // destino a menos de 3 m da linha: lado indefinido ("à frente")
  const R = 6371008.8;
  const rad = (g) => (g * Math.PI) / 180;
  const grau = (r) => (r * 180) / Math.PI;

  // ------------------------------------------------------------ preferência
  function lerPreferencia(storage) {
    try {
      const b = storage && storage.getItem(CHAVE);
      const j = b ? JSON.parse(b) : null;
      return { ligada: !(j && j.ligada === false) };
    } catch (e) { return { ligada: true }; }
  }
  function gravarPreferencia(storage, ligada) {
    const v = { ligada: !!ligada };
    try { if (storage) storage.setItem(CHAVE, JSON.stringify(v)); } catch (e) { /* sem armazenamento: vale só agora */ }
    return v;
  }

  // ------------------------------------------------------------ geometria ({ lat, lon })
  function ponto(p) {
    if (Array.isArray(p)) return { lat: Number(p[1]), lon: Number(p[0]) };
    return p && isFinite(p.lat) && isFinite(p.lon != null ? p.lon : p.lng) ? { lat: Number(p.lat), lon: Number(p.lon != null ? p.lon : p.lng) } : null;
  }
  function distanciaM(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // rumo de a para b, 0–360 (0 = norte, 90 = leste)
  function rumoGraus(a, b) {
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return (grau(Math.atan2(y, x)) + 360) % 360;
  }
  // diferença com sinal b − a em (−180, 180]
  function difComSinal(a, b) { let d = ((b - a) % 360 + 540) % 360 - 180; if (d === -180) d = 180; return d; }
  function difAngulo(a, b) { return Math.abs(difComSinal(a, b)); }

  // Desvio lateral (m) do destino em relação à reta que passa por "de" com o rumo dado: + direita, − esquerda.
  function desvioLateral(de, rumo, destino) {
    const d = distanciaM(de, destino);
    if (d < 0.01) return 0;
    return d * Math.sin(rad(difComSinal(rumo, rumoGraus(de, destino))));
  }

  // Lado da rua do destino: "direita" | "esquerda" | null (à frente / não dá para saber).
  // opcoes: { coords ([[lon, lat]…] da rota), destino, posicao?, rumo? }
  //  1º pela rota: rumo do último trecho (≥ 15 m antes do fim) e o destino em relação a essa reta;
  //  2º sem rota: a posição e o rumo do caminhão.
  function ladoDaRua(opcoes) {
    const o = opcoes || {};
    const dest = ponto(o.destino);
    if (!dest) return null;
    const cs = Array.isArray(o.coords) ? o.coords.map(ponto).filter(Boolean) : [];
    let de = null, rumo = null;
    if (cs.length >= 2) {
      const fim = cs[cs.length - 1];
      let ini = null;
      for (let i = cs.length - 2; i >= 0; i--) { ini = cs[i]; if (distanciaM(cs[i], fim) >= 15) break; }
      if (ini && distanciaM(ini, fim) >= 1) { de = ini; rumo = rumoGraus(ini, fim); }
    }
    if (de == null) {
      const p = ponto(o.posicao);
      if (p && isFinite(o.rumo) && o.rumo != null) { de = p; rumo = Number(o.rumo); }
    }
    if (de == null) return null;
    const off = desvioLateral(de, rumo, dest);
    if (Math.abs(off) < LADO_MIN_M) return null;
    return off > 0 ? "direita" : "esquerda";
  }
  function textoLado(lado) {
    return lado === "direita" ? "Destino à direita" : lado === "esquerda" ? "Destino à esquerda" : "Destino à frente";
  }
  // Rumo de chegada (para virar a câmera do mapa 3D como o motorista vê): o do último trecho da rota, ou null.
  function rumoChegada(coords) {
    const cs = Array.isArray(coords) ? coords.map(ponto).filter(Boolean) : [];
    if (cs.length < 2) return null;
    const fim = cs[cs.length - 1];
    for (let i = cs.length - 2; i >= 0; i--) if (distanciaM(cs[i], fim) >= 15 || i === 0) return distanciaM(cs[i], fim) >= 1 ? rumoGraus(cs[i], fim) : null;
    return null;
  }

  // ------------------------------------------------------------ Mapillary
  // Caixa [oeste, sul, leste, norte] de raioM em volta do ponto.
  function caixaAoRedor(p, raioM) {
    const r = raioM == null ? RAIO_FOTO_M : raioM;
    const dLat = grau(r / R), dLon = grau(r / (R * Math.cos(rad(p.lat))));
    const f = (v) => Number(v.toFixed(6));
    return [f(p.lon - dLon), f(p.lat - dLat), f(p.lon + dLon), f(p.lat + dLat)];
  }
  // API Graph v4: imagens na caixa, com os campos que a escolha usa. O token vai na consulta (sem cabeçalho = sem preflight).
  function urlMapillary(token, destino, raioM) {
    const p = ponto(destino);
    return "https://graph.mapillary.com/images?access_token=" + encodeURIComponent(token) +
      "&fields=id,thumb_1024_url,computed_geometry,compass_angle&bbox=" + caixaAoRedor(p, raioM).join(",") + "&limit=50";
  }
  // Melhor foto para ver o destino: até raioM dele, câmera virada para ele (diferença ≤ maxAngulo), menor nota
  // (distância + 0,4 m por grau de desvio). Foto a menos de 3 m vale sem olhar o ângulo. Nenhuma boa: null.
  function melhorFoto(imagens, destino, opcoes) {
    const o = opcoes || {};
    const raio = o.raioM == null ? RAIO_FOTO_M : o.raioM, maxAng = o.maxAngulo == null ? ANGULO_FOTO_MAX : o.maxAngulo;
    const dest = ponto(destino);
    const lista = Array.isArray(imagens) ? imagens : (imagens && Array.isArray(imagens.data) ? imagens.data : []);
    if (!dest) return null;
    let melhor = null, nota = Infinity;
    for (const im of lista) {
      if (!im || !im.thumb_1024_url || !im.computed_geometry || !Array.isArray(im.computed_geometry.coordinates)) continue;
      const p = ponto(im.computed_geometry.coordinates);
      if (!p || !isFinite(p.lat) || !isFinite(p.lon)) continue;
      const d = distanciaM(p, dest);
      if (d > raio) continue;
      let ang = 0;
      if (d >= 3) {
        if (!isFinite(im.compass_angle) || im.compass_angle == null) continue;
        ang = difAngulo(Number(im.compass_angle), rumoGraus(p, dest));
        if (ang > maxAng) continue;
      }
      const n = d + 0.4 * ang;
      if (n < nota) { nota = n; melhor = Object.assign({}, im, { distanciaM: d, anguloGraus: ang }); }
    }
    return melhor;
  }

  // ------------------------------------------------------------ gatilho (uma vez por viagem)
  function chaveDestino(p) { const q = ponto(p); return q ? q.lat.toFixed(5) + "," + q.lon.toFixed(5) : ""; }
  // avaliar({ ativa, restanteM, chave }) → true uma única vez quando restanteM ≤ limite. ativa: false (chegou/encerrou)
  // zera; destino novo (chave diferente) vale de novo.
  function criarGatilho(opcoes) {
    const limite = (opcoes && opcoes.limiteM) || LIMITE_M;
    let chave = null, mostrou = false;
    return {
      avaliar(d) {
        if (!d || !d.ativa) { chave = null; mostrou = false; return false; }
        const k = d.chave || "";
        if (k !== chave) { chave = k; mostrou = false; }
        if (mostrou || d.restanteM == null || !isFinite(d.restanteM) || d.restanteM > limite) return false;
        mostrou = true;
        return true;
      },
      reiniciar() { chave = null; mostrou = false; },
      mostrou: () => mostrou,
    };
  }

  const api = {
    CHAVE, LIMITE_M, RAIO_FOTO_M, ANGULO_FOTO_MAX, LADO_MIN_M,
    lerPreferencia, gravarPreferencia, distanciaM, rumoGraus, difAngulo, desvioLateral, ladoDaRua, textoLado, rumoChegada,
    caixaAoRedor, urlMapillary, melhorFoto, chaveDestino, criarGatilho,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoFachada = api;
})(typeof window !== "undefined" ? window : globalThis);
