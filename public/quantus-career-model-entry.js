(function (global) {
  "use strict";

  if (!global || !global.document || global.__quantusCareerModelEntryLoaded) return;
  global.__quantusCareerModelEntryLoaded = true;

  var APP_ID = "career";
  var APP_URL = "/career-model.html";
  var APP_TITLE = "Career Model";
  var APP_DESCRIPTION = "Berufliche Weiterbildung in 30-Minuten-Modulen mit Lernfortschritt und Reflecta";
  var scheduled = false;

  function normalize(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isBmLabel(value) {
    var text = normalize(value);
    return text.indexOf("bm-prüfung") > -1 || text.indexOf("bm prüfung") > -1 ||
      text.indexOf("bm vorbereitung") > -1 || text.indexOf("bm-vorbereitung") > -1;
  }

  function isNavigationNode(node) {
    return Boolean(node && node.closest && node.closest("nav,.sidebar,.app-sidebar,#sidebar,[role='navigation']"));
  }

  function appSelector() {
    return '[data-route="' + APP_ID + '"],[data-app="' + APP_ID + '"],a[href="#/' + APP_ID + '"],a[href="' + APP_URL + '"],a[href$="/career-model.html"]';
  }

  function directNavigate(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    global.location.assign(APP_URL);
  }

  function activate(node) {
    if (!node) return null;
    node.setAttribute("data-route", APP_ID);
    node.setAttribute("data-app", APP_ID);
    node.setAttribute("aria-label", APP_TITLE + " öffnen");
    if (node.tagName === "A") node.setAttribute("href", APP_URL);
    if (node.dataset.quantusCareerDirect !== "1") {
      node.dataset.quantusCareerDirect = "1";
      node.addEventListener("click", directNavigate, true);
    }
    return node;
  }

  function cleanClone(node) {
    var clone = node.cloneNode(true);
    clone.removeAttribute("id");
    Array.prototype.forEach.call(clone.querySelectorAll("[id]"), function (child) {
      child.removeAttribute("id");
    });
    clone.classList.remove("active", "selected", "current");
    clone.removeAttribute("aria-current");
    clone.removeAttribute("data-action");
    clone.removeAttribute("onclick");
    return activate(clone);
  }

  function closestCard(node) {
    if (!node) return null;
    var selector = ".app-card,.app-tile,.module-card,[data-app-card],.card,a,button,[role='button']";
    if (node.matches && node.matches(selector)) return node;
    return node.closest && node.closest(selector);
  }

  function findExistingCard() {
    var matches = global.document.querySelectorAll(appSelector());
    for (var i = 0; i < matches.length; i += 1) {
      var card = closestCard(matches[i]);
      if (card && !isNavigationNode(card)) return card;
    }
    return null;
  }

  function findExistingNav() {
    var matches = global.document.querySelectorAll(appSelector());
    for (var i = 0; i < matches.length; i += 1) {
      if (isNavigationNode(matches[i])) return matches[i];
    }
    return null;
  }

  function findBmCard() {
    var direct = global.document.querySelectorAll('[data-route="bmpruefung"],[data-app="bmpruefung"],a[href*="#/bmpruefung"],a[href$="/bm.html"],a[href="bm.html"]');
    for (var i = 0; i < direct.length; i += 1) {
      var card = closestCard(direct[i]);
      if (card && !isNavigationNode(card)) return card;
    }

    var cards = global.document.querySelectorAll(".app-card,.app-tile,.module-card,[data-app-card],main .card,main a,main button");
    for (var j = 0; j < cards.length; j += 1) {
      if (isBmLabel(cards[j].textContent)) return cards[j];
    }
    return null;
  }

  function findBmNav() {
    var navCandidates = global.document.querySelectorAll("nav a,nav button,.sidebar a,.sidebar button,.app-nav-item,[role='navigation'] a,[role='navigation'] button");
    for (var i = 0; i < navCandidates.length; i += 1) {
      var route = navCandidates[i].getAttribute("data-route") || navCandidates[i].getAttribute("data-app") || "";
      var href = navCandidates[i].getAttribute("href") || "";
      if (route === "bmpruefung" || /(?:#\/bmpruefung|\/bm\.html$|^bm\.html$)/.test(href) || isBmLabel(navCandidates[i].textContent)) {
        return navCandidates[i];
      }
    }
    return null;
  }

  function setEntryText(node, compact) {
    var icon = node.querySelector(".app-icon,.module-icon,.card-icon,.nav-icon,.app-nav-icon,.icon,[data-icon]");
    if (icon) icon.textContent = "🧭";

    var title = node.querySelector(".app-title,.module-title,.card-title,.nav-label,.app-nav-label,.label,h2,h3,h4,strong");
    if (title) title.textContent = APP_TITLE;

    if (!compact) {
      var description = node.querySelector(".app-description,.module-description,.card-description,.description,p,small");
      if (description && description !== title) description.textContent = APP_DESCRIPTION;
    }

    if (!title) {
      node.innerHTML = compact
        ? '<span aria-hidden="true">🧭</span><span>Career Model</span>'
        : '<span aria-hidden="true" style="font-size:1.7rem">🧭</span><span><strong>Career Model</strong><small style="display:block">' + APP_DESCRIPTION + "</small></span>";
    }
  }

  function findAppsGrid() {
    var headings = global.document.querySelectorAll("h1,h2,h3,h4,[role='heading'],.section-title,.page-title");
    for (var i = 0; i < headings.length; i += 1) {
      if (normalize(headings[i].textContent).indexOf("meine apps") === -1) continue;
      var section = headings[i].closest && headings[i].closest("section,.section,.panel,.content,.page,main");
      if (section) {
        var grid = section.querySelector(".app-grid,.apps-grid,.module-grid,.grid,[data-app-grid]");
        if (grid) return grid;
      }
      if (headings[i].nextElementSibling) return headings[i].nextElementSibling;
    }
    return null;
  }

  function ensureAppCard() {
    var existing = findExistingCard();
    if (existing) {
      existing.id = existing.id || "quantusCareerModelAppCard";
      activate(existing);
      setEntryText(existing, false);
      return false;
    }

    var source = findBmCard();
    var card;
    if (source && source.parentNode) {
      card = cleanClone(source);
      source.parentNode.insertBefore(card, source.nextSibling);
    } else {
      var grid = findAppsGrid();
      if (!grid) return false;
      card = global.document.createElement("button");
      card.type = "button";
      card.className = "app-card quantus-career-model-card";
      card.style.cssText = "display:flex;align-items:center;gap:12px;width:100%;min-height:84px;padding:16px;text-align:left;border:1px solid currentColor;border-radius:16px;background:transparent;cursor:pointer";
      grid.appendChild(card);
      activate(card);
    }

    card.id = "quantusCareerModelAppCard";
    setEntryText(card, false);
    return true;
  }

  function ensureSidebarLink() {
    var existing = findExistingNav();
    if (existing) {
      existing.id = existing.id || "quantusCareerModelSidebarLink";
      activate(existing);
      setEntryText(existing, true);
      return false;
    }

    var source = findBmNav();
    if (!source || !source.parentNode) return false;
    var item = cleanClone(source);
    item.id = "quantusCareerModelSidebarLink";
    setEntryText(item, true);
    source.parentNode.insertBefore(item, source.nextSibling);
    return true;
  }

  function interceptHash() {
    var hash = normalize(global.location.hash).replace(/^#\/?/, "");
    if (hash === APP_ID || hash.indexOf(APP_ID + "/") === 0) global.location.replace(APP_URL);
  }

  function ensureEntries() {
    scheduled = false;
    ensureAppCard();
    ensureSidebarLink();
    interceptHash();
  }

  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = true;
    global.setTimeout(ensureEntries, 40);
  }

  function start() {
    ensureEntries();
    var observer = new MutationObserver(scheduleEnsure);
    if (global.document.body) observer.observe(global.document.body, { childList: true, subtree: true });
    global.addEventListener("hashchange", interceptHash);
    global.setInterval(ensureEntries, 3000);
  }

  if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})(window);
