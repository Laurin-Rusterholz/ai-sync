import { pruefeId } from './assistant-schema.mjs';

// Optional, closed metadata for the existing quick-capture fields. No patch
// paths or arbitrary entity properties cross this boundary.
export function validateIntakeCapture(data, capture) {
  if (capture === undefined) return null;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)
    || Object.keys(capture).some(k => !['title', 'projectId', 'sourceUrl', 'nextAction'].includes(k))) return 'CAPTURE_INVALID';
  for (const [key, max] of [['title', 200], ['sourceUrl', 2000], ['nextAction', 500]])
    if (capture[key] !== undefined && (typeof capture[key] !== 'string' || !capture[key].trim() || capture[key].length > max)) return 'CAPTURE_INVALID';
  if (capture.sourceUrl !== undefined) {
    try { const url = new URL(capture.sourceUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'CAPTURE_URL_INVALID'; }
    catch (_) { return 'CAPTURE_URL_INVALID'; }
  }
  if (capture.projectId !== undefined) {
    try { pruefeId(capture.projectId, 'projectId'); } catch (_) { return 'CAPTURE_PROJECT_INVALID'; }
    const project = data.entities.projects?.[capture.projectId];
    if (!project || project.deleted || Object.hasOwn(data._deleteLog?.projects || {}, capture.projectId)) return 'CAPTURE_PROJECT_MISSING';
  }
  return null;
}
