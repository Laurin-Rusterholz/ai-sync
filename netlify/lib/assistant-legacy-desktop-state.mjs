// The pre-migration desktop writes these UI states without the canonical
// source/version/roles tuple. In particular decision_required and
// information_required are not states in the server's canonical model.
const DESKTOP_STATES = new Set(['doing', 'waiting_external', 'followup_scheduled',
  'decision_required', 'information_required', 'delegated_cowork', 'review', 'done', 'cancelled']);
const LEGACY_STATUSES = new Set(['neu', 'verstanden', 'in_arbeit', 'wartet', 'abgeschlossen']);
const CANONICAL_MARKERS = ['operationalStateSource', 'operationalStateVersion', 'operationalRoles', 'operationalStateUnmapped', 'operationalStateHistory'];

export function isUnmigratedDesktopLead(entity) {
  return !!entity && typeof entity === 'object' && !Array.isArray(entity)
    && DESKTOP_STATES.has(entity.operationalState) && LEGACY_STATUSES.has(entity.status)
    && CANONICAL_MARKERS.every(key => entity[key] === undefined);
}

export function mapLegacyDesktopOverlay(entity, legacyMapping) {
  if (!isUnmigratedDesktopLead(entity)) return legacyMapping;
  const desktopState = entity.operationalState;
  const comparable = desktopState === 'delegated_cowork' ? 'delegated' : desktopState;
  // A UI label cannot manufacture a waiting-party proof, a job receipt or a
  // closure. Only agreement with the established legacy mapping is accepted.
  // Preserve disagreement as an explicit migration conflict for reconciliation.
  if (legacyMapping.operationalState === comparable) return { ...legacyMapping, desktopState };
  return { ...legacyMapping, operationalState: null, unmapped: true, reason: 'ambiguous',
    note: 'Desktop-Zustand und belegte Altstatus-Semantik müssen abgeglichen werden', desktopState };
}
