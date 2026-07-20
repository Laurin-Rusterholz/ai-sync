import { lpSplit, lpBuildPlan, lpBuildDoc, lpWordCount } from "./leseplan-core.mjs";

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name, extra != null ? JSON.stringify(extra) : ""); } }

// Helper: HTML mit n Ueberschriften + je ~words Woertern
function words(n) { return Array.from({ length: n }, () => "wort").join(" "); }
function docHtml(sections) {
  return "<title>Testdokument</title>" + sections.map((s, i) => `<h2>Abschnitt ${i + 1}</h2><p>${words(s)}</p>`).join("");
}

// 1) Aufteilung nach Ueberschriften
{
  const html = docHtml([50, 60, 40]);
  const chunks = lpSplit(html);
  ok("split: 3 Abschnitte", chunks.length === 3, chunks.map(c => c.wordCount));
  const joined = chunks.map(c => c.html).join("");
  // verlustfrei: Woerter erhalten (50+3(head)+... grob) -> mind. Summe der Absatz-Woerter
  const total = chunks.reduce((s, c) => s + c.wordCount, 0);
  ok("split: verlustfrei Woerteranzahl >= Absatzsumme", total >= 150, total);
}

// 2) Grosser Abschnitt wird weiter geschnitten
{
  const big = "<h2>Gross</h2>" + Array.from({ length: 10 }, () => `<p>${words(200)}</p>`).join("");
  const chunks = lpSplit(big, { maxChunkWords: 600 });
  ok("split: grosser Abschnitt -> mehrere Chunks", chunks.length >= 3, chunks.length);
  const total = chunks.reduce((s, c) => s + c.wordCount, 0);
  ok("split: gross verlustfrei (~2000 Woerter)", total >= 1990 && total <= 2010, total);
}

// 3) Taeglich vs. 2-taeglich (10-Min-Regel)
{
  const start = "2026-07-20";
  // 30 Tage, wenig Inhalt -> <10 Min/Tag -> zweitaeglich
  const chunksSmall = lpSplit(docHtml([100, 100, 100])); // ~300 Woerter -> 1.5 Min gesamt
  const planSmall = lpBuildPlan(chunksSmall, start, "2026-08-18", { wordsPerMinute: 200, minMinutesPerUnit: 10 });
  ok("pace: kleiner Inhalt / viele Tage -> zweitaeglich", planSmall.rhythmus === "zweitaeglich", planSmall.rhythmus);

  // viel Inhalt, wenige Tage -> taeglich
  const bigSecs = Array.from({ length: 20 }, () => 400); // 8000 Woerter -> 40 Min gesamt
  const chunksBig = lpSplit(docHtml(bigSecs), { maxChunkWords: 600 });
  const planBig = lpBuildPlan(chunksBig, start, "2026-07-23", { wordsPerMinute: 200, minMinutesPerUnit: 10 }); // 4 Tage -> 10 Min/Tag
  ok("pace: viel Inhalt / wenige Tage -> taeglich", planBig.rhythmus === "taeglich", planBig.rhythmus);
}

// 4) Zwei Dokumente parallel -> unabhaengige Plaene, unterschiedliche Zieldaten
{
  const start = "2026-07-20";
  const secs = Array.from({ length: 12 }, () => 400); // 4800 Woerter -> 24 Min
  const c = lpSplit(docHtml(secs), { maxChunkWords: 600 });
  const planA = lpBuildPlan(c, start, "2026-07-27", { wordsPerMinute: 200, minMinutesPerUnit: 10 }); // 8 Tage
  const planB = lpBuildPlan(c, start, "2026-08-10", { wordsPerMinute: 200, minMinutesPerUnit: 10 }); // 22 Tage
  ok("parallel: verschiedene Slot-Anzahl je Zieldatum", planA.plan.length !== planB.plan.length, [planA.plan.length, planB.plan.length]);
  ok("parallel: A endet <= Zieldatum A", planA.plan[planA.plan.length - 1].datum <= "2026-07-27", planA.plan[planA.plan.length - 1].datum);
  ok("parallel: B endet <= Zieldatum B", planB.plan[planB.plan.length - 1].datum <= "2026-08-10", planB.plan[planB.plan.length - 1].datum);
}

// 5) Alle Chunks landen im Plan (kein Verlust bei der Verteilung)
{
  const secs = Array.from({ length: 15 }, () => 300);
  const c = lpSplit(docHtml(secs), { maxChunkWords: 600 });
  const plan = lpBuildPlan(c, "2026-07-20", "2026-07-30", { wordsPerMinute: 200, minMinutesPerUnit: 10 });
  const assigned = plan.plan.reduce((s, sl) => s + sl.sektionIds.length, 0);
  ok("verteilung: alle Chunks zugewiesen", assigned === c.length, [assigned, c.length]);
}

// 6) Zieldatum in der Vergangenheit -> Fehler
{
  const c = lpSplit(docHtml([100]));
  const plan = lpBuildPlan(c, "2026-07-20", "2026-07-19", {});
  ok("fehler: Vergangenheit -> error", plan.error === "past", plan.error);
}

// 7) lpBuildDoc Ende-zu-Ende
{
  const res = lpBuildDoc("doc_1", "", docHtml([300, 300, 300]), "2026-07-20", "2026-08-10", { wordsPerMinute: 200, minMinutesPerUnit: 10 });
  ok("doc: gebaut", !!res.doc, res.error);
  ok("doc: Titel aus <title>", res.doc && res.doc.title === "Testdokument", res.doc && res.doc.title);
  ok("doc: sektionen vorhanden", res.doc && Object.keys(res.doc.sektionen).length >= 3, res.doc && Object.keys(res.doc.sektionen).length);
  ok("doc: plan referenziert existierende sektionIds", res.doc && res.doc.plan.every(sl => sl.sektionIds.every(id => res.doc.sektionen[id])), true);
  ok("doc: einheitenGesamt == plan.length", res.doc && res.doc.einheitenGesamt === res.doc.plan.length, true);
}

// 8) leerer Text -> error
{
  const res = lpBuildDoc("d", "", "   ", "2026-07-20", "2026-08-01", {});
  ok("doc: leer -> error", res.error === "empty", res.error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
