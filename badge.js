/**
 * Infinite Discos — Selos nativos da vitrine (substitui o app Tagy).
 *
 * Carregado na vitrine via Nuvemshop Scripts API (upload no Portal de Parceiros,
 * app dedicada "Selos"). Corre no browser de CADA cliente, em TODAS as páginas
 * da loja — por isso é DEFENSIVO por contrato:
 *
 *   1. NUNCA lança excepção para fora (tudo em try/catch; falha = silêncio).
 *   2. Só ADICIONA elementos (spans de selo). A ÚNICA mutação sancionada no
 *      tema é static→relative no contentor de imagem MEDIDO (necessária para
 *      ancorar os selos absolutos; layout-neutral para conteúdo in-flow). Um
 *      contentor não-medido só é usado se JÁ for âncora de posicionamento;
 *      sem âncora fiável, degrada para "sem selo" (nunca mutamos às cegas).
 *   3. Não depende de NENHUM JavaScript do tema (exigência da própria NS).
 *   4. Kill-switch remoto: config.enabled === false → remove os nossos selos,
 *      repõe o Tagy, e o re-poll (10 min / bfcache) aplica-o a tabs já abertas.
 *   5. Coexistência com o Tagy: escondemos os selos do Tagy SÓ nos contentores
 *      onde NÓS pintámos (scope por-produto via classe id-badges-covered). Um
 *      produto que não cobrimos mantém o selo do Tagy — degrada para o Tagy
 *      por-produto, nunca "sem selos". Falha total nossa => Tagy visível.
 *
 * Fonte de verdade: config.json gerado pelo catalog-tracker a partir das
 * categorias NS que ele já gere (Lançamentos / Sob Encomenda / Pré-Venda).
 * O visual dos selos também vem do config — ajustar cor/texto/posição NÃO
 * exige re-upload deste ficheiro no portal (só regenerar o config).
 *
 * Specs capturadas ao pixel do Tagy em 2026-07-11 (loja live):
 *   LANÇAMENTO    #ED2304 / branco / 12px bold / barra em baixo-centro
 *   SOB ENCOMENDA #F03272 / branco / 11px bold / pill canto sup-direito
 *   PRÉ-VENDA     #CBC308 / preto  / 11px bold / pill canto sup-direito
 */
(function () {
  'use strict';

  // URL do config gerado pelo tracker (GitHub Pages).
  // Override p/ testes: window.__ID_BADGES_CONFIG_URL antes deste script.
  var CONFIG_URL =
    (typeof window !== 'undefined' && window.__ID_BADGES_CONFIG_URL) ||
    'https://terossi1997.github.io/infinitediscos-badges/config.json';

  var CONFIG_REFRESH_MS = 10 * 60 * 1000; // alinhado com o max-age=600 do GH Pages

  // Fallback embutido: se o config remoto não trouxer `badges`, usamos as specs
  // capturadas do Tagy (espelham BADGE_SPECS em app/services/badge_config.py —
  // manter os dois em sincronia). Assim um config só-com-listas continua a pintar.
  var DEFAULT_BADGES = {
    lancamento: {
      text: 'LANÇAMENTO',
      bg: '#ED2304',
      fg: '#FFFFFF',
      font_size: '12px',
      position: 'bottom-center'
    },
    sob_encomenda: {
      text: 'SOB ENCOMENDA',
      bg: '#F03272',
      fg: '#FFFFFF',
      font_size: '11px',
      position: 'top-right'
    },
    pre_venda: {
      text: 'PRÉ-VENDA',
      bg: '#CBC308',
      fg: '#000000',
      font_size: '11px',
      position: 'top-right'
    }
  };

  var FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  var PAINTED_ATTR = 'data-id-badges-painted'; // assinatura pid:keys já pintada
  var BADGE_CLASS = 'id-badge'; // os nossos spans
  var COVERED_CLASS = 'id-badges-covered'; // contentor onde pintámos (scope do hide)
  var HIDE_TAGY_STYLE_ID = 'id-badges-hide-tagy';

  var state = { config: null };

  // ------------------------------------------------------------------
  // utilitários defensivos
  // ------------------------------------------------------------------

  function safe(fn) {
    // Envelope universal: NENHUM caminho deste script pode lançar para fora.
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        return undefined; // silêncio deliberado — selo é cosmético
      }
    };
  }

  function badgeSpecs() {
    // Merge campo-a-campo sobre o default: um badge do config com campos em
    // falta (ex. só a cor ajustada) NÃO apaga os restantes campos do default.
    var cfg = state.config || {};
    var merged = {};
    var key, f;
    for (key in DEFAULT_BADGES) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_BADGES, key)) {
        merged[key] = DEFAULT_BADGES[key];
      }
    }
    if (cfg.badges) {
      for (key in cfg.badges) {
        if (!Object.prototype.hasOwnProperty.call(cfg.badges, key)) continue;
        var override = cfg.badges[key];
        if (!override || typeof override !== 'object') continue; // lixo → default
        var base = merged[key] || {};
        var out = {};
        for (f in base) {
          if (Object.prototype.hasOwnProperty.call(base, f)) out[f] = base[f];
        }
        for (f in override) {
          if (
            Object.prototype.hasOwnProperty.call(override, f) &&
            override[f] != null &&
            override[f] !== ''
          ) {
            out[f] = override[f];
          }
        }
        merged[key] = out;
      }
    }
    return merged;
  }

  function badgesForProduct(productId) {
    // Lista de chaves de selo (ex. ['lancamento']) para um produto. Entrada
    // malformada (string/objecto em vez de array) → [] (custa 1 selo, nunca
    // aborta o passe de pintura da página).
    var cfg = state.config;
    if (!cfg || !cfg.products) return [];
    var entry = cfg.products[String(productId)];
    if (!Array.isArray(entry) || !entry.length) return [];
    var out = [];
    for (var i = 0; i < entry.length; i++) {
      if (typeof entry[i] === 'string') out.push(entry[i]);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // pintura
  // ------------------------------------------------------------------

  function paintContainer(container, productId) {
    // Pinta os selos de UM produto dentro do contentor de imagem dado.
    if (!container || !productId) return false;

    var keys = badgesForProduct(productId);
    var sig = String(productId) + ':' + keys.join(',');
    var already = container.getAttribute(PAINTED_ATTR);
    if (already === sig) {
      // idempotente SÓ se o DOM ainda bate: com selos esperados, confirmar
      // que os nossos spans não foram destruídos por um re-render do tema
      // (o atributo vive no contentor e sobreviveria; os spans não).
      if (!keys.length) return false;
      if (container.querySelector('.' + BADGE_CLASS)) return true;
      // spans destruídos pelo tema → cair para repintura
    }

    // limpar SÓ os nossos selos anteriores (nunca tocamos no resto do DOM)
    var old = container.querySelectorAll('.' + BADGE_CLASS);
    for (var i = 0; i < old.length; i++) {
      old[i].parentNode && old[i].parentNode.removeChild(old[i]);
    }

    if (!keys.length) {
      // memoizar "sem selos" é seguro (o memo-hit devolve false) e evita
      // re-tentativas a cada mutação. Este contentor não cobre o Tagy.
      container.setAttribute(PAINTED_ATTR, sig);
      container.classList.remove(COVERED_CLASS);
      return false;
    }

    // âncora de posicionamento — NUNCA mutar às cegas um elemento do tema
    var pos;
    try {
      pos = window.getComputedStyle(container).position;
    } catch (e) {
      return false; // sem leitura fiável → sem selo (degrada p/ Tagy)
    }
    if (pos === 'static') container.style.position = 'relative';

    var specs = badgeSpecs();
    var topRightOffset = 8; // empilhar múltiplos selos de canto (Tagy sobrepunha)
    var paintedAny = false;

    for (var k = 0; k < keys.length; k++) {
      var spec = specs[keys[k]];
      if (!spec || !spec.text) continue;

      var span = document.createElement('span');
      span.className = BADGE_CLASS;
      span.textContent = spec.text; // textContent → texto do config é inerte

      var css =
        'position:absolute;z-index:9;box-sizing:border-box;' +
        'background:' + (spec.bg || '#000') + ';' +
        'color:' + (spec.fg || '#fff') + ';' +
        'font-weight:700;font-style:normal;' +
        'font-size:' + (spec.font_size || '11px') + ';' +
        'font-family:' + FONT_STACK + ';' +
        'border-radius:16px;padding:4px 8px;text-align:center;' +
        'line-height:normal;text-transform:none;text-decoration:none;' +
        'pointer-events:none;'; // selo nunca rouba o clique do produto

      if ((spec.position || 'top-right') === 'bottom-center') {
        css += 'left:8px;right:8px;bottom:8px;display:block;';
      } else {
        // top-right (default) — empilha para baixo se houver mais que um
        css += 'top:' + topRightOffset + 'px;right:8px;';
        topRightOffset += 32;
      }

      span.style.cssText = css;
      container.appendChild(span);
      paintedAny = true;
    }

    if (paintedAny) {
      // só memoizar/marcar-coberto APÓS pintura real: um config com badge sem
      // `text` (0 spans) nunca grava o attr → nunca engana o memo-hit nem
      // esconde o Tagy sem selos.
      container.setAttribute(PAINTED_ATTR, sig);
      container.classList.add(COVERED_CLASS);
    } else {
      container.classList.remove(COVERED_CLASS);
    }
    return paintedAny;
  }

  function findCardImageContainer(card) {
    var el = card.querySelector('.js-product-item-image-container-private');
    if (el) return el; // selector primário medido — âncora conhecida
    el = card.querySelector('[class*="product-item-image"]');
    if (!el) return null;
    try {
      // fallback não-medido: usar SÓ se já for âncora de posicionamento
      // (nunca mutamos position de um elemento do tema fora do medido — #2)
      return window.getComputedStyle(el).position !== 'static' ? el : null;
    } catch (e) {
      return null;
    }
  }

  function paintListingCards() {
    // Cartões de listagem/carrossel: categoria, busca, home, relacionados.
    // Markup do tema Amazonas: .js-item-product[data-product-id] com o
    // contentor .js-product-item-image-container-private lá dentro (o Tagy
    // pinta DENTRO desse mesmo contentor — por isso o scope do hide bate).
    var painted = false;
    var cards = document.querySelectorAll('.js-item-product[data-product-id]');
    for (var i = 0; i < cards.length; i++) {
      var pid = cards[i].getAttribute('data-product-id');
      var cont = findCardImageContainer(cards[i]);
      if (pid && cont) {
        if (paintContainer(cont, pid)) painted = true;
      }
    }
    return painted;
  }

  function paintProductPage() {
    // Página do produto: o selo vai na imagem principal (slider swiper).
    // O id vem de LS.product.id (garantido pela NS no contexto de scripts)
    // com fallback ao input do form de compra.
    var pid = null;
    try {
      if (window.LS && window.LS.product && window.LS.product.id) {
        pid = window.LS.product.id;
      }
    } catch (e) {
      /* LS indisponível — segue para o fallback */
    }
    if (!pid) {
      var input = document.querySelector(
        'form input[name="add_to_cart"], form input[name="product_id"]'
      );
      if (input && input.value) pid = input.value;
    }
    if (!pid) return false;

    var cont = document.querySelector('.js-swiper-product'); // medido na PDP
    if (!cont) {
      // fallbacks não-medidos: só se já forem âncora de posicionamento
      var cands = ['.product-image-container', '#product-carousel'];
      for (var i = 0; i < cands.length; i++) {
        var el = document.querySelector(cands[i]);
        if (!el) continue;
        try {
          if (window.getComputedStyle(el).position !== 'static') {
            cont = el;
            break;
          }
        } catch (e) {
          /* ignora candidato */
        }
      }
    }
    if (!cont) return false;
    return paintContainer(cont, pid);
  }

  function injectHideTagyStyle() {
    // Esconde o Tagy SÓ nos contentores que marcámos como cobertos
    // (.id-badges-covered). Inerte enquanto não houver markers, por isso é
    // seguro injectar assim que o config pedir — nunca esconde o Tagy num
    // produto que não cobrimos (rede de segurança por-produto).
    var cfg = state.config;
    if (!cfg || !cfg.hide_tagy) return;
    if (document.getElementById(HIDE_TAGY_STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = HIDE_TAGY_STYLE_ID;
    st.textContent =
      '.' + COVERED_CLASS + ' .TA--tag,' +
      '.' + COVERED_CLASS + ' #TA_container{display:none !important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  function applyKill() {
    // Kill-switch: desfaz SÓ os nossos artefactos e repõe o Tagy.
    var spans = document.querySelectorAll('.' + BADGE_CLASS);
    for (var i = 0; i < spans.length; i++) {
      spans[i].parentNode && spans[i].parentNode.removeChild(spans[i]);
    }
    var marked = document.querySelectorAll('.' + COVERED_CLASS);
    for (var j = 0; j < marked.length; j++) {
      marked[j].classList.remove(COVERED_CLASS);
      marked[j].removeAttribute(PAINTED_ATTR); // permite repintura se re-ligar
    }
    var st = document.getElementById(HIDE_TAGY_STYLE_ID);
    if (st && st.parentNode) st.parentNode.removeChild(st);
  }

  var paintAll = safe(function () {
    var cfg = state.config;
    if (!cfg) return;
    if (cfg.enabled === false) {
      applyKill();
      return;
    }
    injectHideTagyStyle(); // inerte sem markers
    paintListingCards();
    paintProductPage();
  });

  // ------------------------------------------------------------------
  // repintura em conteúdo dinâmico (paginação, filtros, carrosséis)
  // ------------------------------------------------------------------

  function watchDom() {
    if (typeof MutationObserver === 'undefined') return;
    var timer = null;
    var firstPendingAt = 0;

    function isOurBadge(n) {
      return !!(
        n &&
        n.nodeType === 1 &&
        n.classList &&
        n.classList.contains(BADGE_CLASS)
      );
    }
    function recordIsOurs(rec) {
      // Um record é "nosso" (a ignorar) se TODOS os nós adicionados+removidos
      // são spans .id-badge — assim o eco das nossas próprias pinturas não
      // re-dispara o observer (o filtro por .target era código morto: o
      // target é sempre o contentor pai, nunca o span).
      var seen = 0;
      var lists = [rec.addedNodes, rec.removedNodes];
      for (var li = 0; li < lists.length; li++) {
        var list = lists[li];
        for (var ni = 0; ni < (list ? list.length : 0); ni++) {
          if (!isOurBadge(list[ni])) return false;
          seen++;
        }
      }
      return seen > 0;
    }

    var fire = safe(function () {
      timer = null;
      firstPendingAt = 0;
      paintAll();
    });

    var obs = new MutationObserver(
      safe(function (mutations) {
        var relevant = false;
        for (var i = 0; i < mutations.length; i++) {
          if (!recordIsOurs(mutations[i])) {
            relevant = true;
            break;
          }
        }
        if (!relevant) return;
        var now = nowMs();
        if (!firstPendingAt) firstPendingAt = now;
        if (timer) clearTimeout(timer);
        if (now - firstPendingAt >= 1000) {
          // max-wait: rajadas sustentadas <150ms não adiam a repintura p/ sempre
          fire();
        } else {
          timer = setTimeout(fire, 150);
        }
      })
    );
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function nowMs() {
    try {
      return new Date().getTime();
    } catch (e) {
      return 0;
    }
  }

  // ------------------------------------------------------------------
  // config: fetch inicial + re-poll (kill-switch chega a tabs já abertas)
  // ------------------------------------------------------------------

  var refreshConfig = safe(function () {
    fetch(CONFIG_URL, { credentials: 'omit', mode: 'cors', cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('config http ' + r.status);
        return r.json();
      })
      .then(
        safe(function (cfg) {
          if (!cfg || typeof cfg !== 'object') return;
          state.config = cfg;
          if (cfg.enabled === false) applyKill();
          else paintAll();
        })
      )
      .catch(
        safe(function () {
          /* mantém o snapshot anterior (fail-safe) */
        })
      );
  });

  // ------------------------------------------------------------------
  // arranque
  // ------------------------------------------------------------------

  var start = safe(function () {
    if (!document.body) {
      setTimeout(start, 50); // defensivo — antes do body existir
      return;
    }
    var done = false;
    var timeout = setTimeout(
      safe(function () {
        done = true; // desiste do 1.º paint — nunca pintamos sem config
      }),
      8000
    );

    fetch(CONFIG_URL, { credentials: 'omit', mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('config http ' + r.status);
        return r.json();
      })
      .then(
        safe(function (cfg) {
          if (done) return;
          clearTimeout(timeout);
          if (!cfg || typeof cfg !== 'object') return;
          state.config = cfg;
          paintAll();
          watchDom();
          // re-poll: o kill-switch (enabled=false) chega a tabs já abertas;
          // o pageshow cobre restauros do bfcache (botão voltar).
          try {
            setInterval(refreshConfig, CONFIG_REFRESH_MS);
          } catch (e) {
            /* setInterval indisponível — ignora */
          }
          try {
            window.addEventListener(
              'pageshow',
              safe(function (ev) {
                if (ev && ev.persisted) refreshConfig();
              })
            );
          } catch (e) {
            /* addEventListener indisponível — ignora */
          }
        })
      )
      .catch(
        safe(function () {
          clearTimeout(timeout);
          // sem config → sem selos nossos → NUNCA escondemos o Tagy
        })
      );
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safe(start));
  } else {
    start();
  }
})();
