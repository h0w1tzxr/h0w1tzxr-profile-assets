import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const metricsDir = join(rootDir, "profile-summary-card-output", "github_dark");
const profileGreen = "#80F070";
const statsValueX = "181";
const languageCardFiles = new Set(["1-repos-per-language.svg", "2-most-commit-language.svg"]);

function themeMetricSvg(svg) {
  return svg
    .replace(
      /(<text y="-15" x=")230(" style="fill:\s*#77909c;\s*font-size:\s*10px;">contributions in the last year<\/text>)/i,
      (_, start, end) => `${start}212${end}`
    )
    .replace(/#(?:77909c|8b949e)/gi, "#F4F7FB")
    .replace(
      /(<text x="30" y="40" style="font-size:\s*22px;\s*fill:\s*)#[0-9a-f]{6}(;">)/gi,
      `$1${profileGreen}$2`
    );
}

function themeStatsSvg(svg) {
  return themeMetricSvg(svg).replace(
    /<text x="130" y="([^"]+)" style="fill:\s*#[0-9a-f]{3,6};\s*font-size:\s*14px;">([^<]*)<\/text>/gi,
    (_, y, value) =>
      `<text x="${statsValueX}" y="${y}" text-anchor="end" style="fill: #F4F7FB; font-size: 14px; font-weight: 700;">${value}</text>`
  );
}

function themeLanguageSvg(svg) {
  return themeMetricSvg(svg).replace(
    /<g transform="translate\(0,40\)"><g transform="translate\(40,0\)">([\s\S]*?)<\/g><g transform="translate\( 230, 80 \)">/i,
    (_, legend) => {
      const swatches = [...legend.matchAll(/<rect[^>]*fill="([^"]+)"[^>]*><\/rect>/gi)].map(
        ([, fill]) => fill
      );
      const labels = [...legend.matchAll(/<text[^>]*>([^<]+)<\/text>/gi)].map(([, label]) =>
        label.trim()
      );
      const itemCount = Math.min(swatches.length, labels.length);

      if (!itemCount) {
        return `<g transform="translate(0,40)"><g transform="translate(40,0)">${legend}</g><g transform="translate( 230, 80 )">`;
      }

      const legendItems = Array.from({ length: itemCount }, (_, index) => {
        const textY = 13 + (index - (itemCount - 1) / 2) * 24;
        const rectY = textY - 11;

        return [
          `<rect x="0" y="${rectY}" width="14" height="14" fill="${swatches[index]}" stroke="#0d1117" style="stroke-width: 1px;"></rect>`,
          `<text x="18" y="${textY}" style="fill: #F4F7FB; font-size: 14px;">${labels[index]}</text>`
        ].join("");
      }).join("");

      return `<g transform="translate(0,40)"><g transform="translate(56,60)">${legendItems}</g><g transform="translate( 230, 80 )">`;
    }
  );
}

for (const file of readdirSync(metricsDir).filter((name) => name.endsWith(".svg"))) {
  const path = join(metricsDir, file);
  const before = readFileSync(path, "utf8");
  const after =
    file === "3-stats.svg"
      ? themeStatsSvg(before)
      : languageCardFiles.has(file)
        ? themeLanguageSvg(before)
        : themeMetricSvg(before);

  if (after === before) {
    console.log(`unchanged ${file}`);
    continue;
  }

  writeFileSync(path, after, "utf8");
  console.log(`updated ${file}`);
}
