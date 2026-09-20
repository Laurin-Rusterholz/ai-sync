/* ══ E2 — Job-Token fuer die eigene `lead_agent`-Rolle ════════════════════
 *
 * WOZU
 * ----
 * `run.context` (Belege je Quelle, C2-Kategorie `run_context`) darf laut
 * der echten Rollenmatrix (`ROLE_POLICY`, `quantus-v3-auth.mjs`) NUR
 * `lead_agent` (Job-Token, `binding: assigned`) und die Spezialisten
 * (Job-Token, `binding: job`) lesen — kein Dienst-Zugangsdatum. Dieser
 * Dienst (der die Leitung des Tagesbriefings faehrt) muss sich also fuer
 * GENAU DIESEN Aufruf als `lead_agent` ausweisen, gebunden an den Lauf,
 * dessen Kontext er liest.
 *
 * Ausgestellt wird das Token vom ECHTEN C1-Signaturweg
 * (`mintJobToken`/`resolveAuthConfig` aus `quantus-v3-auth.mjs`), dynamisch
 * importiert und nicht nachgebaut — dieselbe Regel wie beim Kernport. Fehlt
 * die Konfiguration (`QUANTUS_V3_WORKER_TOKEN_KEYS` u.a., C1-eigene
 * Umgebungsvariablen) oder der Export, gibt es KEINEN Aussteller — und
 * `context.run` bleibt ohne einen erfundenen Ausweis unerreichbar: der
 * Abschlussnachweis bleibt dann ehrlich unvollstaendig (`sources_missing`),
 * nie ein stilles Gruen.
 *
 * Kein neues Dienstkonto, keine neue Signaturlogik, keine IAM-Aenderung:
 * dieselben `QUANTUS_V3_WORKER_TOKEN_KEYS`, dieselbe Ausstellung wie fuer
 * jeden anderen Job-Token dieses Systems.
 * ═════════════════════════════════════════════════════════════════════════ */
import { HttpError } from "./errors.mjs";

const LEAD_AGENT_ROLE = "lead_agent";
export const JOB_TOKEN_LIFETIME_SECONDS = 120;

async function ladeAuth() {
  return import("../../../netlify/lib/quantus-v3-auth.mjs");
}

/**
 * @param options.principalId  feste, eigene Kennung dieses Dienstes als
 *                              Leitungsagent (kein Wert aus der Anfrage)
 * @param options.loadModule   nur fuer Tests: liefert das Auth-Modul
 */
export async function createJobTokenIssuer({ principalId = "quantus-v3-runtime:lead_agent", loadModule = null } = {}) {
  let A;
  try {
    A = typeof loadModule === "function" ? await loadModule() : await ladeAuth();
  } catch {
    return { available: false, reason: "auth_module_not_wired" };
  }
  for (const name of ["mintJobToken", "resolveAuthConfig", "envRead"]) {
    if (typeof A[name] !== "function") return { available: false, reason: `missing_export:${name}` };
  }
  const cfg = A.resolveAuthConfig(A.envRead);
  if (!cfg.ok) return { available: false, reason: `auth_not_configured:${cfg.reason || cfg.error || "unknown"}` };
  const config = cfg.config;

  return {
    available: true,
    reason: null,
    role: LEAD_AGENT_ROLE,
    /**
     * @param audience  die Route, fuer die das Token gilt (C1: Zielbindung)
     * @param jobId     die B-Lauf-Id, an die das Token gebunden wird
     * @param tenant    Mandant — muss dem konfigurierten Mandanten entsprechen
     * @param now       Serverzeit in ms (aus dem gemeinsamen Zeitport)
     */
    async mint({ audience, jobId, tenant, now }) {
      const ergebnis = await A.mintJobToken({
        config, audience, jobId, tenant,
        role: LEAD_AGENT_ROLE, principalId,
        assignedJobIds: [jobId],
        lifetimeSeconds: JOB_TOKEN_LIFETIME_SECONDS,
        now: () => now,
      });
      if (!ergebnis || ergebnis.ok !== true || typeof ergebnis.token !== "string" || !ergebnis.token) {
        // Modulgrenze: kein fremder Text, kein Wert — nur die Kennung.
        throw new HttpError(503, "job_token_mint_failed", { code: ergebnis?.error || null });
      }
      return ergebnis.token;
    },
  };
}

export default { createJobTokenIssuer, JOB_TOKEN_LIFETIME_SECONDS };
