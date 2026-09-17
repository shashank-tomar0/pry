/**
 * Route guard: refuse the navigation dead-ends that app switchers create.
 *
 * WHY THIS EXISTS
 *
 * A live run clicked `<a 'Google apps'>` on Gmail while the task was to reach
 * another site. That control opens Google's app-launcher popup, which is served
 * in a CROSS-ORIGIN iframe (`ogs.google.com`) — no content script can read a
 * document inside it, so the launcher's tiles are invisible to the page read and
 * to `click_text` alike. The agent then asked for the text "YouTube", was told
 * truthfully that no visible text matched, and was trapped: the route it took
 * cannot be completed by any action it has.
 *
 * The general shape is worth refusing rather than diagnosing:
 *
 *   - the route is fragile by construction (it depends on a menu that differs by
 *     account, locale and rollout);
 *   - the destination is usually reachable by one `navigate` with a URL, which
 *     cannot miss;
 *   - a dead end here costs turns, and on a slow reasoning model that is
 *     minutes.
 *
 * The refusal is a redirect, not a wall: the planner gets a tool error naming
 * the route to take instead, and it carries on in the same run.
 *
 * Pure: takes the clicked element's name, returns a message or null.
 */

/**
 * Names of app-switcher controls. Deliberately narrow — a control only matches
 * when its accessible name IS the switcher, so an ordinary link whose text
 * merely mentions apps is untouched.
 */
const APP_SWITCHER_PATTERNS: RegExp[] = [
  /^google\s*apps?$/i,
  // "Apps", "Apps menu", "Apps launcher", "App grid", "Apps switcher".
  /^apps?(\s+(menu|launcher|grid|switcher))?$/i,
  // The icon's shape is also used as its name: "nine-square grid", "3x3 dots".
  /^(nine|3x3|3[- ]by[- ]3)[\s-]*(square|dot|dots|grid)(\s*(grid|menu))?$/i,
  /^waffle(\s*menu)?$/i,
  /^(menu|switcher)\s+of\s+apps$/i,
];

export function looksLikeAppSwitcher(elementName: string | undefined): boolean {
  const name = (elementName ?? "").trim();
  if (name.length === 0 || name.length > 40) return false;
  return APP_SWITCHER_PATTERNS.some((p) => p.test(name));
}

/**
 * The message the planner receives instead of the click, when there is one.
 *
 * `suggestedUrl` is optional: when the caller knows the destination (a task
 * that names a site, a stored target URL) the redirect is exact, otherwise the
 * example is generic but still the right route.
 */
export function appSwitcherRefusal(elementName: string | undefined, suggestedUrl?: string): string | null {
  if (!looksLikeAppSwitcher(elementName)) return null;
  const example = suggestedUrl ?? "https://youtube.com";
  return (
    `Refusing to click ${JSON.stringify(elementName)}: app-switcher popups open in a ` +
    `cross-origin frame, so their tiles are invisible to the page read and to click_text — ` +
    `this route cannot be completed from here. Use navigate instead: ` +
    `navigate({"url": "${example}"}) reaches the site directly and cannot miss. ` +
    `Reserve menus like this for destinations that have no URL.`
  );
}
