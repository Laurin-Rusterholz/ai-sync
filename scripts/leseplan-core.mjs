// Shared Leseplan core logic (DOM-free, identisch in Browser / Mobile / n8n).
// Verlustfreie HTML-Aufteilung nach Ueberschriften (Offset-basiert) + Zieldatum-Tempo.

export function lpStripTags(html) {
  return String(html == null ? "" : html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ").trim();
}
export function lpWordCount(html) {
  const t = lpStripTags(html);
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}
export function lpExtractTitle(html) {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  if (t && lpStripTags(t[1])) return lpStripTags(t[1]);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html || ""));
  if (h1 && lpStripTags(h1[1])) return lpStripTags(h1[1]);
  return "";
}

// Verlustfreie Aufteilung: Ueberschriften (h1-h3) definieren Abschnittsgrenzen;
// zu grosse Abschnitte werden an Block-Schluss-Tags (Offsets) weiter geschnitten.
// Aneinanderreihung aller chunk.html == bereinigter Body (nur script/style entfernt).
export function lpSplit(html, opts) {
  const maxW = (opts && opts.maxChunkWords) || 600;
  let src = String(html || "");
  const bodyM = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(src);
  if (bodyM) src = bodyM[1];
  src = src
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<title[\s\S]*?<\/title>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const re = /<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>/gi;
  const heads = []; let m;
  while ((m = re.exec(src)) !== null) heads.push({ start: m.index, text: lpStripTags(m[0]) });

  const sections = [];
  if (!heads.length) {
    sections.push({ title: "", start: 0, end: src.length });
  } else {
    if (heads[0].start > 0) sections.push({ title: "", start: 0, end: heads[0].start });
    for (let i = 0; i < heads.length; i++) {
      const s = heads[i].start;
      const e = (i + 1 < heads.length) ? heads[i + 1].start : src.length;
      sections.push({ title: heads[i].text, start: s, end: e });
    }
  }

  const chunks = [];
  sections.forEach(function (sec) {
    const secHtml = src.slice(sec.start, sec.end);
    if (!secHtml.trim()) return;
    const w = lpWordCount(secHtml);
    if (w <= maxW) { chunks.push({ title: sec.title, html: secHtml, wordCount: w }); return; }
    // grossen Abschnitt an Block-Schluss-Grenzen weiter schneiden (Offset-basiert)
    const bounds = []; const br = /<\/(p|li|ul|ol|blockquote|table|tr|h[1-3]|div|section)>/gi; let bm, last = 0;
    while ((bm = br.exec(secHtml)) !== null) { bounds.push([last, br.lastIndex]); last = br.lastIndex; }
    bounds.push([last, secHtml.length]);
    let curS = bounds[0][0], curW = 0, cont = 0;
    for (let i = 0; i < bounds.length; i++) {
      const bs = bounds[i][0], be = bounds[i][1];
      const bw = lpWordCount(secHtml.slice(bs, be));
      if (curW > 0 && curW + bw > maxW) {
        chunks.push({ title: sec.title + (cont > 0 ? " (Fortsetzung " + cont + ")" : ""), html: secHtml.slice(curS, bs), wordCount: curW });
        cont++; curS = bs; curW = 0;
      }
      curW += bw;
      if (i === bounds.length - 1) chunks.push({ title: sec.title + (cont > 0 ? " (Fortsetzung " + cont + ")" : ""), html: secHtml.slice(curS, be), wordCount: curW });
    }
  });
  return chunks.filter(function (c) { return c.html.trim(); });
}

export function lpDaysBetween(aYmd, bYmd) {
  const a = new Date(aYmd + "T00:00:00Z"), b = new Date(bYmd + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
export function lpAddDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Zieldatum-Tempo (inkl. <minMin -> 2-Tages-Rhythmus). Gibt {error} bei Vergangenheit.
export function lpBuildPlan(chunks, startYmd, zielYmd, cfg) {
  const wpm = (cfg && cfg.wordsPerMinute) || 200;
  const minMin = (cfg && cfg.minMinutesPerUnit) || 10;
  const totalWords = chunks.reduce(function (s, c) { return s + c.wordCount; }, 0);
  const totalMinutes = totalWords / wpm;
  const diff = lpDaysBetween(startYmd, zielYmd);
  if (diff < 0) return { error: "past" };
  const daysAvailable = diff + 1;

  // Rhythmus: waere die reine Tagesportion < minMin, seltener (2-Tages-Rhythmus).
  let rhythmus = "taeglich";
  const minutesPerDay = totalMinutes / daysAvailable;
  if (daysAvailable > 1 && minutesPerDay < minMin) rhythmus = "zweitaeglich";

  // Anzahl Leseeinheiten: taeglich = 1/Tag, zweitaeglich = jeden 2. Tag; nie mehr
  // Einheiten als es Abschnitte gibt (Abschnitte sind atomar).
  const baseSlots = (rhythmus === "zweitaeglich") ? Math.ceil(daysAvailable / 2) : daysAvailable;
  const maxSlots = Math.max(1, Math.min(baseSlots, chunks.length));

  // Termine GLEICHMAESSIG ueber [start, ziel] verteilen: fernes Zieldatum -> weitere
  // Abstaende, nahes -> dichtere. So ergeben unterschiedliche Zieldaten echte,
  // unabhaengige Plaene (andere Termine), auch bei gleicher Einheitenzahl.
  const span = daysAvailable - 1;
  const slotDates = [];
  for (let i = 0; i < maxSlots; i++) {
    const off = (maxSlots === 1) ? 0 : Math.round(i * span / (maxSlots - 1));
    slotDates.push(lpAddDays(startYmd, off));
  }

  // Gleichmaessige Verteilung ueber ALLE Slot-Tage: jeder Slot bekommt mind. eine
  // Sektion; weitere nur, solange der kumulierte Fortschritt unter der linearen
  // Ziel-Grenze bleibt UND fuer jeden Rest-Slot noch mind. eine Sektion uebrig
  // bleibt (kein Frueh-Verbrauch, kein leerer Slot).
  const totalW = totalWords;
  const plan = [];
  let ci = 0, used = 0;
  for (let s = 0; s < maxSlots && ci < chunks.length; s++) {
    const isLast = (s === maxSlots - 1);
    const slotIdx = []; let slotWords = 0;
    slotIdx.push(ci); slotWords += chunks[ci].wordCount; used += chunks[ci].wordCount; ci++;
    if (isLast) {
      while (ci < chunks.length) { slotIdx.push(ci); slotWords += chunks[ci].wordCount; used += chunks[ci].wordCount; ci++; }
    } else {
      const boundaryW = ((s + 1) / maxSlots) * totalW;
      while (ci < chunks.length
        && (chunks.length - ci) > (maxSlots - s - 1)
        && (used + chunks[ci].wordCount / 2) <= boundaryW) {
        slotIdx.push(ci); slotWords += chunks[ci].wordCount; used += chunks[ci].wordCount; ci++;
      }
    }
    plan.push({
      index: plan.length,
      datum: slotDates[s],
      sektionIds: slotIdx.map(function (i) { return "s" + i; }),
      words: slotWords,
      estMinutes: Math.max(1, Math.round(slotWords / wpm)),
      done: false, doneAt: null
    });
  }
  return { rhythmus, plan, totalWords, geschaetzteLesezeit: Math.max(1, Math.round(totalMinutes)), daysAvailable };
}

// Baut das komplette Dokument-Objekt fuer die RTDB (leseplan/docs/<id>).
export function lpBuildDoc(id, rawTitle, html, startYmd, zielYmd, cfg) {
  const chunks = lpSplit(html, { maxChunkWords: (cfg && cfg.maxChunkWords) || 600 });
  if (!chunks.length) return { error: "empty" };
  const docTitle = (rawTitle && rawTitle.trim()) || lpExtractTitle(html) || "Dokument";
  const planRes = lpBuildPlan(chunks, startYmd, zielYmd, cfg);
  if (planRes.error) return { error: planRes.error };
  const wpm = (cfg && cfg.wordsPerMinute) || 200;
  const sektionen = {};
  chunks.forEach(function (c, i) {
    sektionen["s" + i] = {
      order: i,
      title: (c.title && c.title.trim()) || (i === 0 ? docTitle : "Abschnitt " + (i + 1)),
      html: c.html,
      wordCount: c.wordCount,
      estMinutes: Math.max(1, Math.round(c.wordCount / wpm))
    };
  });
  const now = new Date().toISOString();
  return {
    doc: {
      id: id,
      title: docTitle,
      createdAt: now,
      updatedAt: now,
      startDatum: startYmd,
      zieldatum: zielYmd,
      rhythmus: planRes.rhythmus,
      status: "aktiv",
      totalWords: planRes.totalWords,
      geschaetzteLesezeit: planRes.geschaetzteLesezeit,
      einheitenGesamt: planRes.plan.length,
      einheitenErledigt: 0,
      sektionen: sektionen,
      plan: planRes.plan
    }
  };
}
