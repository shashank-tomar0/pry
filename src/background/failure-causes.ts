/**
 * Failure Taxonomy
 *
 * Classifies a failed tool result into a stable, learnable cause. Kept pure
 * (no chrome APIs, no storage) so the verify harness can test it directly and
 * reflection can key repeated-failure rules on the cause instead of on vague
 * run-level aggregates.
 *
 * Causes:
 *   page_load_error  — navigation landed on a browser error page (DNS, SSL…)
 *   timeout          — a round trip exceeded its bound
 *   stale_element    — the planner referenced an id that no longer exists
 *   declined         — the user declined a gated action
 *   wrong_target     — the planner targeted something that is not actionable
 *   not_found        — a lookup (option/text) came up empty
 *   generic          — anything else
 */
export function classifyFailure(detail: string): string {
  if (!detail) return "generic";
  if (/browser error page|navigation failed|dns|err_name|err_connection|err_ssl|err_timedout/i.test(detail)) {
    return "page_load_error";
  }
  if (/did not respond|timed out|timeout/i.test(detail)) return "timeout";
  if (/no element \d+|not found on the current page|page changed|stale/i.test(detail)) return "stale_element";
  if (/declined/i.test(detail)) return "declined";
  if (/not a text field|not a <select>|not handled|unknown tool/i.test(detail)) return "wrong_target";
  if (/no option|not found/i.test(detail)) return "not_found";
  return "generic";
}