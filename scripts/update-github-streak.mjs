import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, "public", "assets", "streak.svg");
const login = process.env.PROFILE_LOGIN ?? "h0w1tzxr";
const streakStatsUrl = "https://streak-stats.demolab.com";
const expectedDimensions = { width: "860", height: "185" };

function buildStreakUrl() {
  const params = new URLSearchParams({
    user: login,
    theme: "github-dark",
    background: "0D1117",
    stroke: "8A96A8",
    ring: "80F070",
    fire: "80F070",
    currStreakNum: "F4F7FB",
    sideNums: "F4F7FB",
    currStreakLabel: "80F070",
    sideLabels: "F4F7FB",
    dates: "8A96A8",
    hide_border: "true",
    card_width: expectedDimensions.width,
    card_height: expectedDimensions.height,
    disable_animations: "true"
  });

  return `${streakStatsUrl}?${params}`;
}

function svgRootAttributes(svg) {
  const [, attributes = ""] = svg.match(/<svg\b([^>]*)>/i) ?? [];
  return Object.fromEntries(
    Array.from(attributes.matchAll(/([:\w-]+)=["']([^"']*)["']/g), ([, name, value]) => [name, value])
  );
}

function normalizeDimension(value) {
  return String(value ?? "").trim().replace(/px$/i, "");
}

function validateSvg(svg, url) {
  if (!/<svg\b/i.test(svg)) {
    throw new Error(`Streak stats response was not an SVG: ${url}`);
  }

  const attributes = svgRootAttributes(svg);
  const width = normalizeDimension(attributes.width);
  const height = normalizeDimension(attributes.height);

  if (width !== expectedDimensions.width || height !== expectedDimensions.height) {
    throw new Error(`Unexpected streak.svg dimensions: ${width}x${height}`);
  }

  for (const text of ["Total Contributions", "Current Streak", "Longest Streak"]) {
    if (!svg.includes(text)) {
      throw new Error(`Streak stats SVG is missing ${text}`);
    }
  }
}

async function fetchStreakSvg() {
  const url = buildStreakUrl();
  const response = await fetch(url, {
    headers: {
      accept: "image/svg+xml,*/*",
      "user-agent": "h0w1tzxr-profile-assets"
    }
  });

  if (!response.ok) {
    throw new Error(`Streak stats request failed: ${response.status} ${response.statusText}`);
  }

  const svg = await response.text();
  validateSvg(svg, url);
  return svg;
}

const svg = await fetchStreakSvg();

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, svg, "utf8");
console.log(`updated public/assets/streak.svg from streak-stats.demolab.com for ${login}`);
