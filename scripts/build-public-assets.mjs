import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicAssets = join(root, "public", "assets");
const staticDir = join(root, "src", "static");
const publicMetrics = join(publicAssets, "metrics");

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function copyRequired(from, to) {
  if (!existsSync(from)) {
    throw new Error(`Missing required asset: ${from}`);
  }

  ensureDir(dirname(to));
  copyFileSync(from, to);
  console.log(`copied ${to.replace(`${root}/`, "")}`);
}

function copySvgDir(fromDir, toDir) {
  ensureDir(toDir);

  for (const file of readdirSync(fromDir).filter((name) => name.endsWith(".svg"))) {
    copyRequired(join(fromDir, file), join(toDir, file));
  }
}

function cleanDir(path) {
  rmSync(path, { recursive: true, force: true });
  ensureDir(path);
}

ensureDir(publicAssets);

copyRequired(join(staticDir, "constantines-ascii.png"), join(publicAssets, "constantines-ascii.png"));
copyRequired(join(staticDir, "hacker.gif"), join(publicAssets, "hacker.gif"));
copyRequired(join(staticDir, "terminal.svg"), join(publicAssets, "terminal.svg"));
copyRequired(join(staticDir, "skill-icons.svg"), join(publicAssets, "skill-icons.svg"));
copyRequired(join(staticDir, "skills-panel.svg"), join(publicAssets, "skills-panel.svg"));
copySvgDir(join(staticDir, "icons"), join(publicAssets, "icons"));

cleanDir(publicMetrics);
for (const file of ["0-profile-details.svg", "1-repos-per-language.svg", "3-stats.svg"]) {
  copyRequired(
    join(root, "profile-summary-card-output", "github_dark", file),
    join(publicMetrics, file)
  );
}
copyRequired(join(root, "dist", "pacman-contribution-graph-dark.svg"), join(publicAssets, "pacman.svg"));

const lightPacman = join(root, "dist", "pacman-contribution-graph.svg");
if (existsSync(lightPacman)) {
  rmSync(lightPacman);
}
