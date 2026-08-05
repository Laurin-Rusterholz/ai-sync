(function (global) {
  "use strict";

  if (!global || !global.document || global.__quantusEnglishC1EntryLoaded) return;
  global.__quantusEnglishC1EntryLoaded = true;

  var APP_ID = "englishc1";
  var APP_URL = "/english-c1.html";
  var APP_TITLE = "English C1";
  var APP_DESCRIPTION = "C1-Leseverständnis mit 12 Modulen, Aufgaben, Wortschatz und Lernfortschritt";
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
    return '[data-route="' + APP_ID + '"],[data-app="' + APP_ID + '"],a[href="' + APP_URL + '"],a[href$="/english-c1.html"]';
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
    if (node.dataset.quantusEnglishDirect !== "1") {
      node.dataset.quantusEnglishDirect = "1";
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
    return activate(clone);
  }

  function closestCard(node) {
    if (!node) return null;
    var selector = ".app-card,.app-tile,.module-card,[data-app-card],.card,a,button,[role='button']";
    if (node.matches && node.matches(selector)) return node;
    return node.closest && node.closest(selector);
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
    if (icon) icon.textContent = "🇬🇧";

    var title = node.querySelector(".app-title,.module-title,.card-title,.nav-label,.app-nav-label,.label,h2,h3,h4,strong");
    if (title) title.textContent = APP_TITLE;

    if (!compact) {
      var description = node.querySelector(".app-description,.module-description,.card-description,.description,p,small");
      if (description && description !== title) description.textContent = APP_DESCRIPTION;
    }

    if (!title) node.textContent = "🇬🇧 " + APP_TITLE;
  }

  function existingCard() {
    var entries = global.document.querySelectorAll(appSelector());
    for (var i = 0; i < entries.length; i += 1) {
      if (!isNavigationNode(entries[i])) return entries[i];
    }
    return null;
  }

  function existingNav() {
    var entries = global.document.querySelectorAll(appSelector());
    for (var i = 0; i < entries.length; i += 1) {
      if (isNavigationNode(entries[i]) || entries[i].classList.contains("app-nav-item")) return entries[i];
    }
    return null;
  }

  function findAppsGrid() {
    var headings = global.document.querySelectorAll("h1,h2,h3,h4,[role='heading'],.section-title,.page-title");
    for (var i = 0; i < headings.length; i += 1) {
      if (normalize(headings[i].textContent).indexOf("meine apps") === -1) continue;
      var section = headings[i].closest && headings[i].closest("section,.section,.panel,.content,.page,main");
      var grid = section && section.querySelector(".app-grid,.apps-grid,.module-grid,.grid,[data-app-grid]");
      if (grid) return grid;
      if (headings[i].nextElementSibling) return headings[i].nextElementSibling;
    }
    return null;
  }

  function mountCard() {
    var present = existingCard();
    if (present) {
      activate(present);
      return false;
    }

    var source = findBmCard();
    var card;
    if (source && source.parentNode) {
      card = cleanClone(source);
      card.id = "quantusEnglishC1AppCard";
      setEntryText(card, false);
      source.parentNode.insertBefore(card, source.nextSibling);
      return true;
    }

    var grid = findAppsGrid();
    if (!grid) return false;
    card = global.document.createElement("button");
    card.type = "button";
    card.id = "quantusEnglishC1AppCard";
    card.className = "app-card quantus-english-c1-card";
    card.innerHTML = '<span aria-hidden="true" style="font-size:1.7rem">🇬🇧</span><span><strong>English C1</strong><small style="display:block">' + APP_DESCRIPTION + "</small></span>";
    card.style.cssText = "display:flex;align-items:center;gap:12px;width:100%;min-height:84px;padding:16px;text-align:left;border:1px solid currentColor;border-radius:16px;background:transparent;cursor:pointer";
    activate(card);
    grid.appendChild(card);
    return true;
  }

  function mountSidebar() {
    var present = existingNav();
    if (present) {
      activate(present);
      return false;
    }

    var source = findBmNav();
    if (!source || !source.parentNode) return false;
    var item = cleanClone(source);
    item.id = "quantusEnglishC1SidebarLink";
    setEntryText(item, true);
    source.parentNode.insertBefore(item, source.nextSibling);
    return true;
  }

  function interceptHash() {
    var route = normalize(global.location.hash).replace(/^#\/?/, "");
    if (route === APP_ID || route.indexOf(APP_ID + "/") === 0) global.location.replace(APP_URL);
  }

  function ensureEntries() {
    scheduled = false;
    mountCard();
    mountSidebar();
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
    var retries = 0;
    var timer = global.setInterval(function () {
      ensureEntries();
      retries += 1;
      if (retries >= 20 || (existingCard() && existingNav())) global.clearInterval(timer);
    }, 500);
  }

  if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})(window);
