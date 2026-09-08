// PRY — Open Graph share card generator.
// Renders landing/og-card.png (1200x630) in the landing page theme
// (deep indigo / paper / coral / gold) using system font stacks.
// Run: node scripts/gen-og-card.mjs
import sharp from "sharp";

const W = 1200;
const H = 630;

const deep = "#0b1d63";
const blue = "#1537ad";
const paper = "#f3ebe5";
const coral = "#f36b57";
const gold = "#d9b34e";
const green = "#176a5e";
const lilac = "#a9abd8";

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Arial, sans-serif";
const MONO = "'Courier New', monospace";

// Brand teardrop mark (from assets/pry-logo.svg, viewBox 0 0 12.096 15.702)
const MARK = `<g transform="translate(64 92) scale(17.5)">
  <g fill="${coral}">
    <path d="M3.342,0.425c1.024-0.395,2.15-0.513,3.236-0.361c1.113,0.154,2.179,0.614,3.066,1.302
      c0.562,0.457,1.065,0.992,1.451,1.607c0.347,0.553,0.615,1.156,0.785,1.787c0.428,1.602,0.217,3.368-0.6,4.813
      c-0.3,0.534-0.677,1.026-1.111,1.458c-0.554,0.531-1.197,0.968-1.899,1.278c-0.83,0.377-1.745,0.549-2.654,0.55
      c-0.797-0.01-1.569-0.29-2.252-0.689c0.004,1.177,0.005,2.355,0,3.532c-1.094-0.735-2.194-1.461-3.287-2.198
      c-0.039-0.028-0.089-0.056-0.076-0.113c0.004-2.813,0-5.626,0.002-8.44C0.008,4.17-0.004,3.386,0.01,2.604
      c0.575-0.453,1.193-0.848,1.799-1.259C2.309,1.022,2.809,0.692,3.342,0.425z M5.36,3.282C4.762,3.36,4.201,3.622,3.715,3.972
      C2.488,4.804,1.262,5.64,0.036,6.473c0.058,0.05,0.118,0.099,0.184,0.139c1.202,0.794,2.4,1.595,3.603,2.387
      c0.553,0.365,1.207,0.604,1.875,0.588c0.795-0.004,1.584-0.32,2.162-0.865C8.333,8.278,8.669,7.687,8.799,7.05
      c0.134-0.663,0.044-1.366-0.245-1.977C8.262,4.5,7.815,3.997,7.248,3.686C6.681,3.358,6.011,3.217,5.36,3.282z"/>
    <path d="M5.349,4.036c0.568-0.063,1.163,0.062,1.636,0.388C7.382,4.7,7.716,5.082,7.888,5.539C8.145,6.2,8.098,6.978,7.743,7.595
      c-0.25,0.448-0.653,0.808-1.125,1.01C6.118,8.827,5.542,8.865,5.014,8.73C4.443,8.584,3.932,8.218,3.611,7.724
      C3.003,6.822,3.119,5.49,3.918,4.739C4.29,4.342,4.811,4.099,5.349,4.036z"/>
  </g>
</g>`;

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${deep}"/>
  <rect x="0" y="0" width="14" height="${H}" fill="${coral}"/>
  <circle cx="1130" cy="90" r="150" fill="${blue}" opacity="0.55"/>
  <circle cx="1050" cy="560" r="190" fill="${green}" opacity="0.30"/>
  ${MARK}
  <text x="360" y="118" font-family="${SANS}" font-size="22" font-weight="800" letter-spacing="10" fill="${paper}">PRY</text>
  <text x="362" y="148" font-family="${MONO}" font-size="13" letter-spacing="4" fill="${lilac}">PRIVATE BROWSER AGENT</text>
  <text x="100" y="290" font-family="${SERIF}" font-size="66" font-weight="700" fill="${paper}">Automate your browser.</text>
  <text x="100" y="370" font-family="${SERIF}" font-size="66" font-weight="700" fill="${coral}">Expose zero data.</text>
  <text x="104" y="430" font-family="${MONO}" font-size="16" letter-spacing="2" fill="${lilac}">PII DETECTED · TOKENIZED · REDACTED · RE-OCR VERIFIED — 100% ON-DEVICE</text>
  <rect x="104" y="480" width="340" height="3" fill="${gold}"/>
  <text x="104" y="540" font-family="${SANS}" font-size="24" font-weight="700" fill="${gold}">FREE ON THE CHROME WEB STORE</text>
  <text x="104" y="572" font-family="${MONO}" font-size="14" letter-spacing="2" fill="${paper}">pry.shashanktomar.dev</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile("landing/og-card.png");
console.log("wrote landing/og-card.png (1200x630)");