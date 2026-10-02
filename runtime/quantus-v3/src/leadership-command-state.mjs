/** An uncertain command must retain its original call identity. Explicit
 * pre-execution rejection and dry-run can be reconsidered without replaying it.
 */
export function commandUnconfirmed(call, receipt) {
  if (call.name !== 'quantus_command' || receipt.confirmed === true) return false;
  const { status, body } = receipt.response || {};
  if (status === 200 && body?.dryRun === true && body?.applied === false) return false;
  return !(body?.ok === false && [400, 401, 403, 404, 409, 413, 422, 429].includes(status));
}
