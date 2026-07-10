/* ════════════════════════════════════════════════════════════════════════
   QUANTUS ORB — <quantus-orb>
   Das lebendige Neural-Core-Ringelement: künftiger Button der Sprachsteuerung.

   Zustände
   ────────
   • Leerlauf: die Ringgruppen rotieren ruhig (gegenläufig), der Kern atmet.
   • speaking: Wellen laufen vom Kern nach außen (Schallwellen-Metapher),
     die Ringe drehen schneller, der Kern pulsiert im Sprachrhythmus.

   Verwendung
   ──────────
     <quantus-orb style="width:34px;height:34px" title="Sprachsteuerung"></quantus-orb>

     const orb = document.querySelector("quantus-orb");
     orb.speaking = true;            // KI spricht → Wellen nach außen
     orb.speaking = false;           // zurück in den Leerlauf
     orb.addEventListener("orb-activate", fn);   // Klick / Enter / Leertaste

   Die Sprachsteuerung hängt sich später an "orb-activate" und steuert
   `speaking`, solange die KI-Audioausgabe läuft.
   ════════════════════════════════════════════════════════════════════════ */
(function(){
"use strict";

if (window.customElements && customElements.get("quantus-orb")) return;

var TEMPLATE =
  '<style>' +
    ':host{display:inline-flex;width:40px;height:40px;cursor:pointer;border-radius:50%;-webkit-tap-highlight-color:transparent}' +
    ':host(:focus-visible){outline:2px solid #a78bfa;outline-offset:3px}' +
    'svg{width:100%;height:100%;display:block;overflow:visible;filter:drop-shadow(0 0 6px rgba(139,92,246,.25));transition:filter .25s ease,transform .2s ease}' +
    ':host(:hover) svg{filter:drop-shadow(0 0 12px rgba(167,139,250,.55));transform:scale(1.05)}' +
    ':host(:active) svg{transform:scale(.96)}' +
    ':host([speaking]) svg{filter:drop-shadow(0 0 16px rgba(167,139,250,.7))}' +

    /* ── Rotationen (Leerlauf) ── */
    '.gA,.gB,.gC{transform-origin:48px 48px}' +
    '.gA{animation:qoRot 16s linear infinite}' +
    '.gB{animation:qoRotCcw 30s linear infinite}' +
    '.gC{animation:qoRot 22s linear infinite}' +
    '.core{transform-origin:48px 48px;animation:qoBreath 3.4s ease-in-out infinite}' +

    /* ── Sprechen: schneller drehen, Kern pulsiert, Wellen laufen raus ── */
    ':host([speaking]) .gA{animation-duration:5s}' +
    ':host([speaking]) .gB{animation-duration:9s}' +
    ':host([speaking]) .gC{animation-duration:7s}' +
    ':host([speaking]) .core{animation:qoVoice .9s ease-in-out infinite}' +
    '.ripple{transform-origin:48px 48px;opacity:0}' +
    ':host([speaking]) .ripple{animation:qoRipple 2.1s cubic-bezier(.2,.6,.4,1) infinite}' +
    ':host([speaking]) .ripple:nth-of-type(2){animation-delay:-.7s}' +
    ':host([speaking]) .ripple:nth-of-type(3){animation-delay:-1.4s}' +

    '@keyframes qoRot{to{transform:rotate(360deg)}}' +
    '@keyframes qoRotCcw{to{transform:rotate(-360deg)}}' +
    '@keyframes qoBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.09)}}' +
    '@keyframes qoVoice{0%{transform:scale(1)}16%{transform:scale(1.18)}34%{transform:scale(.94)}52%{transform:scale(1.12)}72%{transform:scale(1)}86%{transform:scale(1.1)}100%{transform:scale(1)}}' +
    '@keyframes qoRipple{0%{transform:scale(.16);opacity:.8}70%{opacity:.3}100%{transform:scale(1.04);opacity:0}}' +

    /* Reduzierte Bewegung: Rotation aus; „spricht"-Signal bleibt als sanfter
       Puls erhalten (Statusinformation, keine Deko) */
    '@media (prefers-reduced-motion:reduce){' +
      '.gA,.gB,.gC,.core{animation:none!important}' +
      ':host([speaking]) .ripple{animation:qoRippleSoft 2.4s ease-in-out infinite}' +
      '@keyframes qoRippleSoft{0%,100%{transform:scale(.9);opacity:0}50%{transform:scale(.94);opacity:.35}}' +
    '}' +
  '</style>' +

  '<svg viewBox="0 0 96 96" aria-hidden="true">' +
    '<defs>' +
      '<radialGradient id="qoCore" cx="0.38" cy="0.34" r="0.85">' +
        '<stop offset="0" stop-color="#d6c9ff"/>' +
        '<stop offset="0.55" stop-color="#a78bfa"/>' +
        '<stop offset="1" stop-color="#7c3aed"/>' +
      '</radialGradient>' +
    '</defs>' +
    '<g fill="none" stroke-linecap="round">' +

      /* Sprech-Wellen: vom Kern nach außen (nur bei [speaking] sichtbar) */
      '<circle class="ripple" cx="48" cy="48" r="43" stroke="#a78bfa" stroke-width="1.6" vector-effect="non-scaling-stroke"/>' +
      '<circle class="ripple" cx="48" cy="48" r="43" stroke="#8b5cf6" stroke-width="1.6" vector-effect="non-scaling-stroke"/>' +
      '<circle class="ripple" cx="48" cy="48" r="43" stroke="#6aa3de" stroke-width="1.4" vector-effect="non-scaling-stroke"/>' +

      /* äußerer statischer Hauch */
      '<circle cx="48" cy="48" r="46" stroke="#a78bfa" stroke-opacity=".18" stroke-width="1"/>' +

      /* Gruppe C: äußere Segmentbögen mit Kopf-Punkt */
      '<g class="gC">' +
        '<path d="M48 5 A43 43 0 0 1 89.7 37.6" stroke="#a78bfa" stroke-width="3"/>' +
        '<path d="M43.5 90.8 A43 43 0 0 1 5.2 43.5" stroke="#8b5cf6" stroke-width="3"/>' +
        '<path d="M87.9 64.1 A43 43 0 0 1 70.8 84.5" stroke="#6aa3de" stroke-width="2"/>' +
        '<circle cx="89.7" cy="37.6" r="2.4" fill="#eef0f2" stroke="none"/>' +
      '</g>' +

      /* Gruppe B: feiner Tick-Ring, gegenläufig, mit Orbit-Punkt */
      '<g class="gB">' +
        '<circle cx="48" cy="48" r="34" stroke="#a78bfa" stroke-opacity=".42" stroke-width="1.4" stroke-dasharray="2.4 4.6"/>' +
        '<circle cx="48" cy="14" r="1.8" fill="#6aa3de" stroke="none"/>' +
      '</g>' +

      /* Gruppe A: innere Doppelbögen */
      '<g class="gA">' +
        '<path d="M28.9 31.9 A25 25 0 0 1 67.2 31.9" stroke="#8b5cf6" stroke-width="2.4"/>' +
        '<path d="M67.2 64.1 A25 25 0 0 1 28.9 64.1" stroke="#a78bfa" stroke-width="2.4"/>' +
      '</g>' +

      /* innerer Hauch + Kern */
      '<circle cx="48" cy="48" r="17" stroke="#6aa3de" stroke-opacity=".3" stroke-width="1"/>' +
      '<g class="core">' +
        '<circle cx="48" cy="48" r="12" fill="#8b5cf6" fill-opacity=".22" stroke="none"/>' +
        '<circle cx="48" cy="48" r="7" fill="url(#qoCore)" stroke="none"/>' +
      '</g>' +
    '</g>' +
  '</svg>';

function QuantusOrbFactory(){
  function QuantusOrb(){
    var self = Reflect.construct(HTMLElement, [], QuantusOrb);
    return self;
  }
  QuantusOrb.prototype = Object.create(HTMLElement.prototype);
  QuantusOrb.prototype.constructor = QuantusOrb;
  Object.setPrototypeOf(QuantusOrb, HTMLElement);

  QuantusOrb.observedAttributes = ["speaking"];

  QuantusOrb.prototype.connectedCallback = function(){
    if (!this.shadowRoot){
      var root = this.attachShadow({ mode: "open" });
      root.innerHTML = TEMPLATE;
    }
    if (!this.hasAttribute("role")) this.setAttribute("role", "button");
    if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "0");
    if (!this.hasAttribute("aria-label")) this.setAttribute("aria-label", this.getAttribute("title") || "Sprachsteuerung");
    this._syncAria();

    var self = this;
    if (!this._wired){
      this._wired = true;
      this.addEventListener("click", function(e){ self._activate(e); });
      this.addEventListener("keydown", function(e){
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar"){
          e.preventDefault();
          self._activate(e);
        }
      });
    }
  };

  QuantusOrb.prototype.attributeChangedCallback = function(){ this._syncAria(); };

  QuantusOrb.prototype._syncAria = function(){
    this.setAttribute("aria-pressed", this.hasAttribute("speaking") ? "true" : "false");
  };

  QuantusOrb.prototype._activate = function(){
    this.dispatchEvent(new CustomEvent("orb-activate", { bubbles: true, composed: true }));
  };

  Object.defineProperty(QuantusOrb.prototype, "speaking", {
    get: function(){ return this.hasAttribute("speaking"); },
    set: function(v){
      if (v) this.setAttribute("speaking", "");
      else this.removeAttribute("speaking");
    }
  });

  return QuantusOrb;
}

var Orb = QuantusOrbFactory();
customElements.define("quantus-orb", Orb);

/* Globale Helfer für die spätere Sprachsteuerung:
   QuantusOrb.speakingAll(true)  → alle Orbs zeigen „KI spricht"
   QuantusOrb.speakingAll(false) → zurück in den Leerlauf */
window.QuantusOrb = {
  speakingAll: function(on){
    document.querySelectorAll("quantus-orb").forEach(function(o){ o.speaking = !!on; });
  }
};

})();
