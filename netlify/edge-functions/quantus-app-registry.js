const APP_KEY = "englishc1";
const APP_ENTRY = '{key:"englishc1", icon:"🇬🇧", label:"English C1", desc:getLang()==="de"?"C1-Leseverständnis mit 12 Modulen, Aufgaben, Wortschatz, Wiederholung und Lernfortschritt":"C1 reading comprehension with 12 modules, exercises, vocabulary, review and progress"},';

// A previous source transformation turned intended string separators such as
// .join("\\n") into a physical backslash + line break. Whitespace after the
// backslash makes the complete Quantus inline script fail to parse. Once that
// happens, the browser treats the following JavaScript string fragments as
// HTML, which is why settings inputs receive values such as "' + esc(...) + '".
//
// Keep this repair deliberately narrow: only double-quoted .join separators
// ending in a physical backslash line break are normalized. The optional prefix
// preserves an existing escaped carriage return used by the CSV export.
const BROKEN_JOIN_SEPARATOR = /\.join\("([^"\r\n]*)\\[ \t]*(?:\r\n|\n|\r)"\)/g;

export function repairQuantusInlineScriptLineBreaks(source) {
  return String(source || "").replace(BROKEN_JOIN_SEPARATOR, (_match, prefix) => {
    const separator = prefix === "\\r"
      ? "\\r\\n"
      : prefix
        ? prefix + "\\n"
        : "\\n";
    return `.join("${separator}")`;
  });
}

export function injectEnglishC1(source) {
  let html = String(source || "");

  // Quantus Apps overview: insert the app before Polaris in the shared app registry.
  if (!html.includes('key:"' + APP_KEY + '"')) {
    html = html.replace(
      /(\r?\n[ \t]*)\{key:"polaris",/,
      '$1' + APP_ENTRY + '$1{key:"polaris",'
    );
  }

  // Main router: the app opens the already deployed standalone C1 route.
  if (!html.includes('case "' + APP_KEY + '":')) {
    html = html.replace(
      /(\r?\n[ \t]*)case "ruhestand":/,
      '$1case "englishc1": window.location.href = "english-c1.html"; return; // English C1 Reading Lab$1case "ruhestand":'
    );
  }

  // Persistent sidebar shortcut. It clones an existing navigation item, so the
  // current desktop/tablet styling and future design changes are inherited.
  if (!html.includes('id="quantusEnglishC1HubLink"')) {
    const launcher = `<script id="quantusEnglishC1HubLink">
(function(){
  function mountEnglishC1Link(){
    if(document.getElementById('navEnglishC1')) return true;
    var items=Array.prototype.slice.call(document.querySelectorAll('.app-nav-item'));
    if(!items.length) return false;
    var sample=items.find(function(el){return el.getAttribute('data-route')==='bmpruefung';}) || items[0];
    var item=sample.cloneNode(true);
    item.id='navEnglishC1';
    item.classList.remove('active');
    item.setAttribute('data-route','englishc1');
    item.removeAttribute('data-action');
    if(item.tagName==='A') item.setAttribute('href','#/englishc1');
    var badge=item.querySelector('.badge'); if(badge) badge.remove();
    var parts=item.querySelectorAll('span');
    if(parts.length){ parts[0].textContent='🇬🇧'; parts[parts.length-1].textContent='English C1'; }
    else item.textContent='🇬🇧 English C1';
    item.addEventListener('click',function(event){event.preventDefault();window.location.hash='#/englishc1';});
    var bm=items.find(function(el){return el.getAttribute('data-route')==='bmpruefung';});
    if(bm && bm.parentNode) bm.parentNode.insertBefore(item,bm.nextSibling);
    else if(sample.parentNode) sample.parentNode.appendChild(item);
    return true;
  }
  var attempts=0;
  function retry(){
    attempts+=1;
    if(!mountEnglishC1Link() && attempts<80) setTimeout(retry,250);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',retry,{once:true});
  else retry();
})();
</script>`;
    html = html.replace(/<\/body>/i, launcher + "\n</body>");
  }

  return html;
}

export default async function handler(request, context) {
  const response = await context.next();
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/html")) return response;

  const original = await response.text();
  const repaired = repairQuantusInlineScriptLineBreaks(original);
  const transformed = injectEnglishC1(repaired);
  if (transformed === original) return new Response(original, response);

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  headers.set("cache-control", "no-cache, must-revalidate");
  if (repaired !== original) headers.set("x-quantus-index-repair", "inline-line-breaks");
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
