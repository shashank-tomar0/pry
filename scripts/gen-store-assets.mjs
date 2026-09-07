// PRY — Chrome Web Store asset generator.
// Renders store tiles + screenshot mockups from SVG, composited with the brand icon.
// Run: node scripts/gen-store-assets.mjs
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const OUT = "assets/store";
mkdirSync(OUT, { recursive: true });

const ICON = "assets/icon-master.png";

// ─── Brand palette (mirrors src/sidepanel/styles.css) ────────────────────
const paper = "#f5f2e9";
const paper2 = "#ece7da";
const paper3 = "#ded7c5";
const ink = "#28231d";
const ink2 = "#3e3831";
const inkMute = "#6b6256";
const rule = "#4a4338";
const hairline = "#d2cbba";
const accent = "#e23829";
const teal = "#00888c";

const SERIF = `Georgia, 'Times New Roman', serif`;
const SANS = `'Helvetica Neue', Arial, sans-serif`;
const MONO = `'Courier New', monospace`;

function frame(w, h, bg = paper) {
  return `<rect width="${w}" height="${h}" fill="${bg}"/>
    <rect x="10" y="10" width="${w - 20}" height="${h - 20}" fill="none" stroke="${rule}" stroke-width="2"/>`;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function redactionBar(x, y, w, h, label) {
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${accent}" opacity="0.14"/>
    <path d="${Array.from({ length: Math.floor(w / 14) }, (_, i) => `M${x + 7 + i * 14} ${y} L${x + i * 14} ${y + h}`).join(" ")}" stroke="${accent}" stroke-width="2"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${accent}" stroke-width="1.5"/>
    <text x="${x + w / 2}" y="${y + h / 2 + 4}" font-family="${MONO}" font-size="12" fill="${accent}" text-anchor="middle">${esc(label)}</text>
  </g>`;
}

async function render(name, w, h, svg, icon = null) {
  const base = sharp(Buffer.from(svg)).resize(w, h);
  if (icon) {
    const buf = await sharp(ICON).resize(icon.size, icon.size).png().toBuffer();
    return base.composite([{ input: buf, left: icon.left, top: icon.top }]).png().toFile(`${OUT}/${name}`);
  }
  return base.png().toFile(`${OUT}/${name}`);
}

// ─── 1. Small promo tile 440×280 ─────────────────────────────────────────
const tileSvg = `<svg width="440" height="280" viewBox="0 0 440 280" xmlns="http://www.w3.org/2000/svg">
  ${frame(440, 280)}
  <text x="176" y="118" font-family="${SANS}" font-size="58" font-weight="800" fill="${ink}">PRY</text>
  <rect x="180" y="132" width="44" height="4" fill="${accent}"/>
  <text x="178" y="162" font-family="${SANS}" font-size="16" font-weight="600" letter-spacing="6" fill="${inkMute}">AGENT</text>
  <text x="176" y="196" font-family="${SERIF}" font-size="13" font-style="italic" fill="${inkMute}">Redacts PII before any AI sees it.</text>
  <text x="176" y="214" font-family="${SERIF}" font-size="13" font-style="italic" fill="${inkMute}">Runs tasks in your browser.</text>
</svg>`;
await render("tile-440x280.png", 440, 280, tileSvg, { size: 128, left: 28, top: 76 });

// ─── 2. Marquee tile 1400×560 ────────────────────────────────────────────
const marqueeSvg = `<svg width="1400" height="560" viewBox="0 0 1400 560" xmlns="http://www.w3.org/2000/svg">
  ${frame(1400, 560)}
  <rect x="10" y="10" width="1400" height="560" fill="none" stroke="${rule}" stroke-width="2"/>
  <text x="330" y="230" font-family="${SANS}" font-size="96" font-weight="800" fill="${ink}">PRY AGENT</text>
  <rect x="336" y="252" width="92" height="8" fill="${accent}"/>
  <text x="330" y="310" font-family="${SERIF}" font-size="30" font-style="italic" fill="${ink2}">Browser automation where nothing sensitive leaves your machine.</text>
  <rect x="330" y="352" width="880" height="66" fill="${paper2}" stroke="${rule}" stroke-width="2"/>
  <text x="348" y="380" font-family="${MONO}" font-size="20" fill="${inkMute}">Aadhaar · PAN · Card · Email · API key</text>
  <text x="348" y="408" font-family="${MONO}" font-size="20" fill="${accent}">→ detected on-device → &lt;CRED_1&gt; &lt;ID_2&gt; → redacted screenshot</text>
</svg>`;
await render("marquee-1400x560.png", 1400, 560, marqueeSvg, { size: 220, left: 60, top: 140 });

// ─── 3. Screenshot 1 — agent in action (1280×800) ────────────────────────
const shot1Svg = `<svg width="1280" height="800" viewBox="0 0 1280 800" xmlns="http://www.w3.org/2000/svg">
  <!-- left: browser mock -->
  <rect width="850" height="800" fill="#f8f7f2"/>
  <rect x="0" y="0" width="850" height="46" fill="#e8e6dc"/>
  <rect x="10" y="12" width="14" height="14" rx="7" fill="#e23829"/><rect x="30" y="12" width="14" height="14" rx="7" fill="#e8b34a"/><rect x="50" y="12" width="14" height="14" rx="7" fill="#3f9d63"/>
  <rect x="90" y="12" width="560" height="22" rx="11" fill="#ffffff" stroke="${hairline}" stroke-width="1.5"/>
  <circle cx="108" cy="23" r="6" fill="#3f9d63"/><text x="122" y="27" font-family="${SANS}" font-size="13" fill="${ink2}">bank.example.com/transfer — make a payment</text>
  <rect x="0" y="46" width="850" height="754" fill="#ffffff"/>
  <!-- page: payment form -->
  <text x="60" y="110" font-family="${SERIF}" font-size="30" font-weight="700" fill="${ink}">Make a payment</text>
  <text x="62" y="138" font-family="${SANS}" font-size="14" fill="${inkMute}">Beneficiary</text>
  <rect x="60" y="146" width="330" height="34" fill="#ffffff" stroke="${hairline}" stroke-width="1.5"/>
  <text x="72" y="168" font-family="${SANS}" font-size="14" fill="${inkMute}">Electricity board — Bengaluru</text>
  <text x="62" y="206" font-family="${SANS}" font-size="14" fill="${inkMute}">Amount (INR)</text>
  <rect x="60" y="214" width="330" height="34" fill="#ffffff" stroke="${hairline}" stroke-width="1.5"/>
  <text x="72" y="236" font-family="${MONO}" font-size="14" fill="${ink2}">1,250.00</text>
  <text x="62" y="274" font-family="${SANS}" font-size="14" fill="${inkMute}">Card number</text>
  <rect x="60" y="282" width="330" height="34" fill="#ffffff" stroke="${hairline}" stroke-width="1.5"/>
  ${redactionBar(68, 287, 314, 24, "REDACTED → <CRED_1>")}
  <text x="62" y="342" font-family="${SANS}" font-size="14" fill="${inkMute}">Cardholder name</text>
  <rect x="60" y="350" width="330" height="34" fill="#ffffff" stroke="${hairline}" stroke-width="1.5"/>
  ${redactionBar(68, 355, 314, 24, "REDACTED → <CRED_2>")}
  <text x="62" y="410" font-family="${SANS}" font-size="14" fill="${inkMute}">Aadhaar (KYC)</text>
  <rect x="60" y="418" width="330" height="34" fill="#ffffff" stroke="${hairline}" stroke-width="1.5"/>
  ${redactionBar(68, 423, 314, 24, "REDACTED → <ID_3>")}
  <rect x="60" y="480" width="150" height="40" fill="${ink}" rx="4"/>
  <text x="135" y="505" font-family="${SANS}" font-size="15" font-weight="600" fill="#ffffff" text-anchor="middle">Confirm</text>
  <text x="430" y="120" font-family="${MONO}" font-size="13" fill="${teal}">● 3 fields masked on-device</text>
  <text x="430" y="142" font-family="${MONO}" font-size="13" fill="${teal}">● no raw value ever sent</text>
  <text x="430" y="164" font-family="${MONO}" font-size="13" fill="${teal}">● screenshot re-OCR verified</text>

  <!-- right: PRY panel -->
  <rect x="850" y="0" width="430" height="800" fill="${paper}"/>
  <rect x="850" y="0" width="430" height="800" fill="none" stroke="${rule}" stroke-width="3"/>
  <rect x="850" y="0" width="430" height="54" fill="${paper2}" stroke="${rule}" stroke-width="2"/>
  <rect x="868" y="14" width="26" height="26" fill="${accent}"/>
  <text x="881" y="33" font-family="${SANS}" font-size="17" font-weight="800" fill="#fff">P</text>
  <text x="902" y="34" font-family="${SANS}" font-size="18" font-weight="800" fill="${ink}">PRY</text>
  <rect x="946" y="16" width="86" height="22" rx="11" fill="${accent}"/>
  <text x="989" y="31" font-family="${MONO}" font-size="11" fill="#fff" text-anchor="middle">12 KB EGRESS</text>
  <text x="1044" y="34" font-family="${SANS}" font-size="12" fill="${inkMute}">FREE BROADSHEET · EDITION 04</text>
  <text x="1044" y="50" font-family="${SANS}" font-size="11" letter-spacing="2" fill="${inkMute}">PERCEPTION N° 02</text>
  <text x="868" y="104" font-family="${SERIF}" font-size="34" font-weight="700" fill="${accent}">PRIVATE AGENT</text>
  <text x="868" y="126" font-family="${SERIF}" font-size="12" font-style="italic" fill="${inkMute}">PII detection, tokenization &amp; redaction run 100% inside</text>
  <text x="868" y="140" font-family="${SERIF}" font-size="12" font-style="italic" fill="${inkMute}">your browser. Optional VLM vision when enabled.</text>
  <text x="868" y="170" font-family="${SANS}" font-size="10" font-weight="700" letter-spacing="1.5" fill="${inkMute}">CONTEXT PRESETS</text>
  <rect x="868" y="180" width="74" height="22" rx="11" fill="${paper}" stroke="${rule}" stroke-width="1.5"/><text x="905" y="194" font-family="${SANS}" font-size="11" fill="${ink}" text-anchor="middle">+ AADHAAR</text>
  <rect x="950" y="180" width="58" height="22" rx="11" fill="${paper}" stroke="${rule}" stroke-width="1.5"/><text x="979" y="194" font-family="${SANS}" font-size="11" fill="${ink}" text-anchor="middle">+ PAN</text>
  <rect x="1016" y="180" width="76" height="22" rx="11" fill="${paper}" stroke="${rule}" stroke-width="1.5"/><text x="1054" y="194" font-family="${SANS}" font-size="11" fill="${ink}" text-anchor="middle">+ CONTACT</text>
  <rect x="868" y="216" width="394" height="38" fill="#ebe7da" stroke="${rule}" stroke-width="1.5"/>
  <text x="880" y="240" font-family="${SERIF}" font-size="13" font-style="italic" fill="${inkMute}">Instruct agent (e.g. fill form, scan PII)...</text>
  <rect x="1234" y="218" width="26" height="34" fill="${ink}"/><text x="1247" y="240" font-family="${SANS}" font-size="16" fill="#fff">→</text>
  <text x="868" y="276" font-family="${SANS}" font-size="10" font-weight="700" letter-spacing="1.5" fill="${inkMute}">QUICK ACTIONS</text>
  <rect x="868" y="284" width="190" height="30" fill="${paper}" stroke="${rule}" stroke-width="1.5"/><text x="884" y="303" font-family="${SANS}" font-size="12" font-weight="600" fill="${ink}">✎ FILL FORM</text>
  <rect x="1072" y="284" width="190" height="30" fill="${paper}" stroke="${accent}" stroke-width="2"/><text x="1088" y="303" font-family="${SANS}" font-size="12" font-weight="600" fill="${accent}">📊 EXTRACT DATA</text>
  <rect x="868" y="320" width="190" height="30" fill="${paper}" stroke="${rule}" stroke-width="1.5"/><text x="884" y="339" font-family="${SANS}" font-size="12" font-weight="600" fill="${ink}">◉ SCAN PII</text>
  <rect x="1072" y="320" width="190" height="30" fill="${paper}" stroke="${rule}" stroke-width="1.5"/><text x="1088" y="339" font-family="${SANS}" font-size="12" font-weight="600" fill="${ink}">◎ CLICK TARGET</text>
  <!-- agent card -->
  <rect x="868" y="368" width="394" height="150" fill="#ffffff" stroke="${rule}" stroke-width="1.5"/>
  <circle cx="884" cy="386" r="5" fill="#3f9d63"/><text x="896" y="390" font-family="${SANS}" font-size="12" font-weight="700" fill="${ink}">PRY AGENT</text>
  <text x="1230" y="390" font-family="${SANS}" font-size="11" fill="${teal}">⎘ Copy</text>
  <text x="884" y="416" font-family="${SERIF}" font-size="13" fill="${ink2}">I'll fill this transfer form. The card number and</text>
  <text x="884" y="434" font-family="${SERIF}" font-size="13" fill="${ink2}">Aadhaar fields are tokenized — I only see vault</text>
  <text x="884" y="452" font-family="${SERIF}" font-size="13" fill="${ink2}">tokens, and I never type them into the page.</text>
  <text x="884" y="482" font-family="${MONO}" font-size="12" fill="${inkMute}">⇢ Go to bank.example.com · ✓ navigated</text>
  <text x="884" y="500" font-family="${MONO}" font-size="12" fill="${inkMute}">→ Click "Make a payment" · ✓ done</text>
  <!-- footer -->
  <rect x="868" y="736" width="394" height="46" fill="${paper2}" stroke="${rule}" stroke-width="1.5"/>
  <rect x="880" y="748" width="150" height="22" rx="11" fill="#2e7d4f"/>
  <text x="955" y="763" font-family="${SANS}" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">✓ ZERO-LEAK VERIFIED</text>
  <text x="1042" y="765" font-family="${MONO}" font-size="11" fill="${inkMute}">3 Redacted · 0 Vault Tokens</text>
</svg>`;
await render("screenshot-1-in-action.png", 1280, 800, shot1Svg);

// ─── 4. Screenshot 2 — self-improvement dashboard ────────────────────────
const shot2Svg = `<svg width="1280" height="800" viewBox="0 0 1280 800" xmlns="http://www.w3.org/2000/svg">
  <rect width="1280" height="800" fill="${paper}"/>
  <rect x="0" y="0" width="1280" height="64" fill="${paper2}" stroke="${rule}" stroke-width="2"/>
  <rect x="18" y="17" width="30" height="30" fill="${accent}"/><text x="33" y="39" font-family="${SANS}" font-size="19" font-weight="800" fill="#fff">P</text>
  <text x="58" y="40" font-family="${SANS}" font-size="21" font-weight="800" fill="${ink}">PRY</text>
  <text x="104" y="40" font-family="${SANS}" font-size="13" fill="${inkMute}">SELF-IMPROVEMENT · LEARNING DASHBOARD</text>
  <text x="60" y="112" font-family="${SERIF}" font-size="34" font-weight="700" fill="${ink}">Learning dashboard</text>
  <text x="60" y="136" font-family="${SERIF}" font-size="14" font-style="italic" fill="${inkMute}">Every run teaches the agent. Rules, lessons, and replay trajectories grow as you work.</text>
  <!-- stat chips -->
  <rect x="60" y="158" width="150" height="52" fill="#fff" stroke="${rule}" stroke-width="1.5"/><text x="80" y="182" font-family="${SANS}" font-size="22" font-weight="800" fill="${teal}">14</text><text x="80" y="200" font-family="${SANS}" font-size="12" fill="${inkMute}">Learned rules</text>
  <rect x="222" y="158" width="150" height="52" fill="#fff" stroke="${rule}" stroke-width="1.5"/><text x="242" y="182" font-family="${SANS}" font-size="22" font-weight="800" fill="${accent}">3</text><text x="242" y="200" font-family="${SANS}" font-size="12" fill="${inkMute}">Lessons learned</text>
  <rect x="384" y="158" width="150" height="52" fill="#fff" stroke="${rule}" stroke-width="1.5"/><text x="404" y="182" font-family="${SANS}" font-size="22" font-weight="800" fill="${ink}">9</text><text x="404" y="200" font-family="${SANS}" font-size="12" fill="${inkMute}">Replay trajectories</text>
  <rect x="546" y="158" width="150" height="52" fill="#fff" stroke="${rule}" stroke-width="1.5"/><text x="566" y="182" font-family="${SANS}" font-size="22" font-weight="800" fill="${ink}">212</text><text x="566" y="200" font-family="${SANS}" font-size="12" fill="${inkMute}">Ledger entries</text>
  <!-- rules list -->
  <text x="60" y="252" font-family="${SANS}" font-size="13" font-weight="700" letter-spacing="1.5" fill="${ink}">LEARNED RULES</text>
  <rect x="60" y="266" width="1160" height="150" fill="#fff" stroke="${rule}" stroke-width="1.5"/>
  <text x="80" y="294" font-family="${MONO}" font-size="13" fill="${ink2}">bank.example.com · suppress_false_positive · type:method</text><text x="1150" y="294" font-family="${MONO}" font-size="13" fill="${teal}" text-anchor="end">conf 0.84</text>
  <text x="80" y="318" font-family="${MONO}" font-size="13" fill="${ink2}">mail.google.com · missed_detection · add_detection</text><text x="1150" y="318" font-family="${MONO}" font-size="13" fill="${teal}" text-anchor="end">conf 0.72</text>
  <text x="80" y="342" font-family="${MONO}" font-size="13" fill="${ink2}">news.example.org · repeated_failure · route_to_llm</text><text x="1150" y="342" font-family="${MONO}" font-size="13" fill="${accent}" text-anchor="end">conf 0.66</text>
  <text x="80" y="366" font-family="${MONO}" font-size="13" fill="${ink2}">portal.gov.in · repeated_success · keep_deterministic</text><text x="1150" y="366" font-family="${MONO}" font-size="13" fill="${teal}" text-anchor="end">conf 0.91</text>
  <text x="80" y="398" font-family="${MONO}" font-size="13" fill="${inkMute}">… 10 more rules · deduped · capped at 500</text>
  <!-- lessons -->
  <text x="60" y="452" font-family="${SANS}" font-size="13" font-weight="700" letter-spacing="1.5" fill="${ink}">LESSONS LEARNED</text>
  <rect x="60" y="466" width="560" height="130" fill="#fff" stroke="${rule}" stroke-width="1.5"/>
  <text x="80" y="494" font-family="${SANS}" font-size="12" font-weight="700" fill="${accent}">mail.google.com · Gmail inbox</text>
  <text x="80" y="516" font-family="${SERIF}" font-size="13" fill="${ink2}">"Verify the URL has a TLD before navigating —</text>
  <text x="80" y="534" font-family="${SERIF}" font-size="13" fill="${ink2}">bare hosts like 'gmail' cause DNS errors."</text>
  <text x="80" y="566" font-family="${MONO}" font-size="11" fill="${inkMute}">from a failed run · injected into next run's context</text>
  <rect x="60" y="604" width="560" height="130" fill="#fff" stroke="${rule}" stroke-width="1.5"/>
  <text x="80" y="632" font-family="${SANS}" font-size="12" font-weight="700" fill="${accent}">portal.gov.in · KYC form</text>
  <text x="80" y="654" font-family="${SERIF}" font-size="13" fill="${ink2}">"Confirm irreversible actions before executing —</text>
  <text x="80" y="672" font-family="${SERIF}" font-size="13" fill="${ink2}">the safety gate catches it, but ask first."</text>
  <text x="80" y="704" font-family="${MONO}" font-size="11" fill="${inkMute}">from a failed run · injected into next run's context</text>
  <!-- trajectories -->
  <text x="660" y="452" font-family="${SANS}" font-size="13" font-weight="700" letter-spacing="1.5" fill="${ink}">REPLAY LIBRARY</text>
  <rect x="660" y="466" width="560" height="130" fill="#fff" stroke="${rule}" stroke-width="1.5"/>
  <text x="680" y="494" font-family="${SANS}" font-size="12" font-weight="700" fill="${teal}">mail.google.com · read first email</text>
  <text x="680" y="520" font-family="${MONO}" font-size="12" fill="${ink2}">navigate → read_page → click → read_page → summarize</text>
  <text x="680" y="544" font-family="${MONO}" font-size="11" fill="${inkMute}">task tokenized · sanitized at write · few-shot replay</text>
  <rect x="660" y="604" width="560" height="130" fill="#fff" stroke="${rule}" stroke-width="1.5"/>
  <text x="680" y="632" font-family="${SANS}" font-size="12" font-weight="700" fill="${teal}">bank.example.com · fill transfer form</text>
  <text x="680" y="658" font-family="${MONO}" font-size="12" fill="${ink2}">navigate → fill → type → click → verify</text>
  <text x="680" y="682" font-family="${MONO}" font-size="11" fill="${inkMute}">task tokenized · sanitized at write · few-shot replay</text>
</svg>`;
await render("screenshot-2-dashboard.png", 1280, 800, shot2Svg);

// ─── 5. Screenshot 3 — options / providers ───────────────────────────────
const shot3Svg = `<svg width="1280" height="800" viewBox="0 0 1280 800" xmlns="http://www.w3.org/2000/svg">
  <rect width="1280" height="800" fill="${paper}"/>
  <rect x="0" y="0" width="1280" height="64" fill="${paper2}" stroke="${rule}" stroke-width="2"/>
  <rect x="18" y="17" width="30" height="30" fill="${accent}"/><text x="33" y="39" font-family="${SANS}" font-size="19" font-weight="800" fill="#fff">P</text>
  <text x="58" y="40" font-family="${SANS}" font-size="21" font-weight="800" fill="${ink}">PRY</text>
  <text x="104" y="40" font-family="${SANS}" font-size="13" fill="${inkMute}">SETTINGS · PROVIDERS</text>
  <text x="60" y="112" font-family="${SERIF}" font-size="34" font-weight="700" fill="${ink}">Bring your own model</text>
  <text x="60" y="138" font-family="${SERIF}" font-size="14" font-style="italic" fill="${inkMute}">Pick any provider — or run fully local with Ollama and send zero bytes anywhere.</text>
  <rect x="60" y="160" width="560" height="46" fill="#fdfbf5" stroke="${teal}" stroke-width="2"/>
  <text x="80" y="189" font-family="${SANS}" font-size="13" fill="${teal}">● Privacy pipeline: active · egress is metered and shown in the toolbar badge</text>
  <!-- provider cards -->
  <rect x="60" y="228" width="360" height="170" fill="#fff" stroke="${rule}" stroke-width="1.5"/>
  <text x="80" y="258" font-family="${SANS}" font-size="16" font-weight="700" fill="${ink}">Anthropic</text><text x="368" y="258" font-family="${SANS}" font-size="11" fill="${teal}">✓ connected</text>
  <text x="80" y="282" font-family="${SANS}" font-size="12" fill="${inkMute}">Model</text>
  <rect x="80" y="290" width="320" height="28" fill="#f5f2e9" stroke="${hairline}" stroke-width="1.5"/><text x="92" y="309" font-family="${MONO}" font-size="12" fill="${ink2}">claude-sonnet-4-20250514</text><text x="384" y="309" font-family="${SANS}" font-size="12" fill="${inkMute}">▾</text>
  <text x="80" y="342" font-family="${SANS}" font-size="12" fill="${inkMute}">API key</text>
  <rect x="80" y="350" width="320" height="28" fill="#f5f2e9" stroke="${hairline}" stroke-width="1.5"/><text x="92" y="369" font-family="${MONO}" font-size="12" fill="${inkMute}">••••••••••••••••</text>
  <text x="80" y="416" font-family="${SANS}" font-size="12" fill="${inkMute}">+</text><text x="92" y="416" font-family="${SANS}" font-size="12" fill="${inkMute}">Add API key · stored locally in chrome.storage</text>
  <rect x="440" y="228" width="360" height="170" fill="#fff" stroke="${rule}" stroke-width="1.5"/>
  <text x="460" y="258" font-family="${SANS}" font-size="16" font-weight="700" fill="${ink}">OpenAI</text><text x="748" y="258" font-family="${SANS}" font-size="11" fill="${inkMute}">not configured</text>
  <text x="460" y="282" font-family="${SANS}" font-size="12" fill="${inkMute}">Model</text>
  <rect x="460" y="290" width="320" height="28" fill="#f5f2e9" stroke="${hairline}" stroke-width="1.5"/><text x="472" y="309" font-family="${MONO}" font-size="12" fill="${ink2}">gpt-5.2</text><text x="764" y="309" font-family="${SANS}" font-size="12" fill="${inkMute}">▾</text>
  <text x="460" y="342" font-family="${SANS}" font-size="12" fill="${inkMute}">API key</text>
  <rect x="460" y="350" width="320" height="28" fill="#f5f2e9" stroke="${hairline}" stroke-width="1.5"/><text x="472" y="369" font-family="${SANS}" font-size="12" fill="${inkMute}">sk-…</text>
  <rect x="820" y="228" width="360" height="170" fill="#fff" stroke="${rule}" stroke-width="1.5"/>
  <text x="840" y="258" font-family="${SANS}" font-size="16" font-weight="700" fill="${ink}">Ollama (local)</text><text x="1128" y="258" font-family="${SANS}" font-size="11" fill="${teal}">✓ 0 KB egress</text>
  <text x="840" y="282" font-family="${SANS}" font-size="12" fill="${inkMute}">Model</text>
  <rect x="840" y="290" width="320" height="28" fill="#f5f2e9" stroke="${hairline}" stroke-width="1.5"/><text x="852" y="309" font-family="${MONO}" font-size="12" fill="${ink2}">llama3.1:8b</text><text x="1144" y="309" font-family="${SANS}" font-size="12" fill="${inkMute}">▾</text>
  <text x="840" y="342" font-family="${SANS}" font-size="12" fill="${inkMute}">Endpoint</text>
  <rect x="840" y="350" width="320" height="28" fill="#f5f2e9" stroke="${hairline}" stroke-width="1.5"/><text x="852" y="369" font-family="${MONO}" font-size="12" fill="${ink2}">http://localhost:11434</text>
  <text x="840" y="416" font-family="${SANS}" font-size="12" fill="${ink}">Nothing leaves your machine.</text>
  <rect x="60" y="420" width="360" height="170" fill="#fff" stroke="${rule}" stroke-width="1.5"/>
  <text x="80" y="450" font-family="${SANS}" font-size="16" font-weight="700" fill="${ink}">Groq</text><text x="368" y="450" font-family="${SANS}" font-size="11" fill="${inkMute}">not configured</text>
  <text x="80" y="474" font-family="${SANS}" font-size="12" fill="${inkMute}">Model</text>
  <rect x="80" y="482" width="320" height="28" fill="#f5f2e9" stroke="${hairline}" stroke-width="1.5"/><text x="92" y="501" font-family="${MONO}" font-size="12" fill="${ink2}">llama-3.3-70b-versatile</text><text x="384" y="501" font-family="${SANS}" font-size="12" fill="${inkMute}">▾</text>
  <text x="80" y="534" font-family="${SANS}" font-size="12" fill="${inkMute}">API key</text>
  <rect x="80" y="542" width="320" height="28" fill="#f5f2e9" stroke="${hairline}" stroke-width="1.5"/><text x="92" y="561" font-family="${MONO}" font-size="12" fill="${inkMute}">gsk_…</text>
  <rect x="440" y="420" width="360" height="170" fill="#fff" stroke="${rule}" stroke-width="1.5"/>
  <text x="460" y="450" font-family="${SANS}" font-size="16" font-weight="700" fill="${ink}">NVIDIA NIM</text><text x="748" y="450" font-family="${SANS}" font-size="11" fill="${inkMute}">not configured</text>
  <text x="460" y="474" font-family="${SANS}" font-size="12" fill="${inkMute}">Model</text>
  <rect x="460" y="482" width="320" height="28" fill="#f5f2e9" stroke="${hairline}" stroke-width="1.5"/><text x="472" y="501" font-family="${MONO}" font-size="12" fill="${ink2}">nvidia/nemotron-3.5-lightning-30b-a3b</text><text x="764" y="501" font-family="${SANS}" font-size="12" fill="${inkMute}">▾</text>
  <text x="460" y="534" font-family="${SANS}" font-size="12" fill="${inkMute}">API key</text>
  <rect x="460" y="542" width="320" height="28" fill="#f5f2e9" stroke="${hairline}" stroke-width="1.5"/><text x="472" y="561" font-family="${MONO}" font-size="12" fill="${inkMute}">nvapi-…</text>
  <text x="60" y="640" font-family="${MONO}" font-size="12" fill="${inkMute}">Keys are stored in chrome.storage.local — never synced, never logged, used only against your chosen provider.</text>
</svg>`;
await render("screenshot-3-options.png", 1280, 800, shot3Svg);

// ─── 6. Screenshot 4 — privacy audit / redaction proof ───────────────────
const shot4Svg = `<svg width="1280" height="800" viewBox="0 0 1280 800" xmlns="http://www.w3.org/2000/svg">
  <rect width="1280" height="800" fill="${paper}"/>
  <rect x="0" y="0" width="1280" height="64" fill="${paper2}" stroke="${rule}" stroke-width="2"/>
  <rect x="18" y="17" width="30" height="30" fill="${accent}"/><text x="33" y="39" font-family="${SANS}" font-size="19" font-weight="800" fill="#fff">P</text>
  <text x="58" y="40" font-family="${SANS}" font-size="21" font-weight="800" fill="${ink}">PRY</text>
  <text x="104" y="40" font-family="${SANS}" font-size="13" fill="${inkMute}">PRIVACY AUDIT · REDACTION PROOF</text>
  <text x="60" y="112" font-family="${SERIF}" font-size="34" font-weight="700" fill="${ink}">Proof, not promises</text>
  <text x="60" y="138" font-family="${SERIF}" font-size="14" font-style="italic" fill="${inkMute}">Every screenshot is redacted on-device, then the exact shipped image is re-OCR'd locally to verify zero PII remains.</text>
  <!-- RAW panel -->
  <text x="60" y="180" font-family="${SANS}" font-size="13" font-weight="700" letter-spacing="1.5" fill="${inkMute}">CAPTURED (NEVER SENT)</text>
  <rect x="60" y="194" width="560" height="420" fill="#2a2730" stroke="${rule}" stroke-width="2"/>
  <text x="92" y="244" font-family="${SERIF}" font-size="22" font-weight="700" fill="#e8e6dc">Payment receipt</text>
  <text x="92" y="276" font-family="${MONO}" font-size="14" fill="#c9c3b4">Card: 4532 7611 2233 8890</text>
  <text x="92" y="302" font-family="${MONO}" font-size="14" fill="#c9c3b4">Name: R. Sharma</text>
  <text x="92" y="328" font-family="${MONO}" font-size="14" fill="#c9c3b4">Aadhaar: 2345 6789 0123</text>
  <text x="92" y="354" font-family="${MONO}" font-size="14" fill="#c9c3b4">Email: r.sharma@gmail.com</text>
  <text x="92" y="380" font-family="${MONO}" font-size="14" fill="#c9c3b4">Phone: +91 98765 43210</text>
  <rect x="92" y="412" width="180" height="60" fill="#3a3642" stroke="#55505e" stroke-width="1.5"/>
  <circle cx="116" cy="442" r="18" fill="#7a7280"/><circle cx="160" cy="442" r="18" fill="#7a7280"/><circle cx="204" cy="442" r="18" fill="#7a7280"/>
  <text x="92" y="512" font-family="${MONO}" font-size="12" fill="#8a8394">5 PII values detected · Luhn/Verhoeff checksum verified</text>
  <!-- SHIPPED panel -->
  <text x="660" y="180" font-family="${SANS}" font-size="13" font-weight="700" letter-spacing="1.5" fill="${teal}">SHIPPED TO MODEL (CLEAN)</text>
  <rect x="660" y="194" width="560" height="420" fill="#2a2730" stroke="${rule}" stroke-width="2"/>
  <text x="692" y="244" font-family="${SERIF}" font-size="22" font-weight="700" fill="#e8e6dc">Payment receipt</text>
  ${redactionBar(692, 262, 220, 24, "<CRED_1>")}
  ${redactionBar(692, 288, 160, 24, "<CRED_2>")}
  ${redactionBar(692, 314, 200, 24, "<ID_3>")}
  ${redactionBar(692, 340, 230, 24, "<CRED_4>")}
  ${redactionBar(692, 366, 190, 24, "<CRED_5>")}
  <rect x="692" y="412" width="180" height="60" fill="#3a3642" stroke="#55505e" stroke-width="1.5"/>
  <rect x="100" y="392" width="140" height="30" rx="6" fill="#2e7d4f"/><text x="170" y="412" font-family="${SANS}" font-size="13" font-weight="700" fill="#fff" text-anchor="middle">✓ BLURRED</text>
  <rect x="250" y="392" width="140" height="30" rx="6" fill="#2e7d4f"/><text x="320" y="412" font-family="${SANS}" font-size="13" font-weight="700" fill="#fff" text-anchor="middle">✓ MASKED</text>
  <text x="692" y="512" font-family="${MONO}" font-size="12" fill="#7fd0a4">re-OCR of shipped JPEG → zero PII re-readable ✓</text>
  <text x="692" y="534" font-family="${MONO}" font-size="12" fill="#7fd0a4">vault tokens resolve only at action time, in-browser</text>
  <!-- footer verdict -->
  <rect x="60" y="640" width="1160" height="56" fill="${paper2}" stroke="${rule}" stroke-width="1.5"/>
  <circle cx="92" cy="668" r="10" fill="#2e7d4f"/><text x="112" y="673" font-family="${SANS}" font-size="15" font-weight="700" fill="${ink}">ZERO-LEAK VERIFIED</text>
  <text x="330" y="673" font-family="${MONO}" font-size="13" fill="${inkMute}">5 Redacted · 5 Vault Tokens · 1 Frame · 0 Egress events</text>
  <text x="1000" y="673" font-family="${SANS}" font-size="13" font-weight="600" fill="${teal}">INSPECT PROOF →</text>
</svg>`;
await render("screenshot-4-audit.png", 1280, 800, shot4Svg);

console.log("Store assets written to assets/store/");