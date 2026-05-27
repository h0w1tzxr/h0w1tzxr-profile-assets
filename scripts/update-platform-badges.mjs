import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const badgesDir = join(root, "public", "assets", "badges");
const htbProfileUrl =
  process.env.HTB_PROFILE_URL ?? "https://app.hackthebox.com/public/users/1185864";
const thmProfileUrl = process.env.THM_PROFILE_URL ?? "https://tryhackme.com/p/constantines";
const userAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const htbRankIconBaseUrl =
  "https://htb-experience-prod-public-storage.s3.amazonaws.com/assets/ranks/svg";

function escapeSvg(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function linesFrom(text) {
  return text
    .replaceAll("\u00a0", " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function requireAfter(lines, label) {
  const index = lines.indexOf(label);
  if (index === -1 || !lines[index + 1]) {
    throw new Error(`Could not find public HTB field after "${label}"`);
  }
  return lines[index + 1];
}

function requireBefore(lines, label) {
  const index = lines.indexOf(label);
  if (index <= 0 || !lines[index - 1]) {
    throw new Error(`Could not find public HTB field before "${label}"`);
  }
  return lines[index - 1];
}

function firstNumber(value, label) {
  const match = value.match(/\d+/);
  if (!match) {
    throw new Error(`Could not parse numeric HTB field "${label}" from "${value}"`);
  }
  return match[0];
}

function parseGrade(lines) {
  const gradeLine = lines.find((line) => /^Grade\s+\d+\s+out\s+of\s+\d+$/i.test(line));
  const match = gradeLine?.match(/Grade\s+(\d+)\s+out\s+of\s+(\d+)/i);
  if (!match) {
    return { active: 0, total: 0, label: "" };
  }
  return {
    active: Number(match[1]),
    total: Number(match[2]),
    label: `${match[1]}/${match[2]}`
  };
}

function parseProfile(text) {
  const lines = linesFrom(text);

  if (!lines.some((line) => line.toLowerCase() === "constantines")) {
    throw new Error("Loaded HTB page did not contain the expected public profile");
  }

  const level = requireAfter(lines, "Lvl");
  const levelProgress = requireAfter(lines, "Level").replace(/\s+/g, "");
  const rank = requireBefore(lines, "HTB Rank");
  const streak = requireAfter(lines, "Weekly Streak");
  const machines = firstNumber(requireAfter(lines, "Machines"), "Machines");
  const challenges = firstNumber(requireAfter(lines, "Challenges"), "Challenges");
  const grade = parseGrade(lines);

  return { level, levelProgress, rank, streak, machines, challenges, grade };
}

function profileLooksHydrated(profile) {
  return (
    Number(profile.level) > 0 &&
    Number(profile.machines) > 0 &&
    Number(profile.challenges) > 0 &&
    profile.rank.toLowerCase() !== "beginner"
  );
}

async function readHydratedProfile(page) {
  let lastProfile;
  let lastError;

  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      const publicText = await page.locator("body").innerText({ timeout: 30_000 });
      const profile = parseProfile(publicText);
      lastProfile = profile;

      if (profileLooksHydrated(profile)) {
        return profile;
      }
    } catch (error) {
      lastError = error;
    }

    await page.waitForTimeout(1000);
  }

  if (lastProfile) {
    throw new Error(
      `HTB profile stayed on placeholder values: ${lastProfile.rank}, level ${lastProfile.level}`
    );
  }

  throw lastError ?? new Error("Could not read hydrated HTB public profile");
}

function parseThmProfile(text) {
  const lines = linesFrom(text);
  const usernameIndex = lines.indexOf("constantines");

  if (usernameIndex <= 0) {
    throw new Error("Loaded THM page did not contain the expected public profile");
  }

  const topPercent = lines.find((line) => /^top\s+\d+%$/i.test(line)) ?? "";
  const level = firstNumber(lines[usernameIndex - 1], "THM level");
  const title = lines[usernameIndex + 1]?.replace(/\]\[/g, " ").replace(/[\[\]]/g, "") ?? "";
  const rank = firstNumber(requireAfter(lines, "Rank"), "THM rank");
  const badges = firstNumber(requireAfter(lines, "Badges"), "THM badges");
  const streak = firstNumber(requireAfter(lines, "Streak"), "THM streak");
  const completedRooms = firstNumber(requireAfter(lines, "Completed rooms"), "THM completed rooms");

  return { level, title, topPercent, rank, badges, streak, completedRooms };
}

function thmProfileLooksHydrated(profile) {
  return (
    Number(profile.level) > 0 &&
    Number(profile.rank) > 0 &&
    Number(profile.completedRooms) > 0 &&
    profile.title.length > 0
  );
}

async function readHydratedThmProfile(page) {
  let lastProfile;
  let lastError;

  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      const publicText = await page.locator("body").innerText({ timeout: 30_000 });
      const profile = parseThmProfile(publicText);
      lastProfile = profile;

      if (thmProfileLooksHydrated(profile)) {
        return profile;
      }
    } catch (error) {
      lastError = error;
    }

    await page.waitForTimeout(1000);
  }

  if (lastProfile) {
    throw new Error(
      `THM profile stayed on placeholder values: level ${lastProfile.level}, rank ${lastProfile.rank}`
    );
  }

  throw lastError ?? new Error("Could not read hydrated THM public profile");
}

function contentTypeFromUrl(url) {
  if (/\.svg(?:$|\?)/i.test(url)) return "image/svg+xml";
  if (/\.jpe?g(?:$|\?)/i.test(url)) return "image/jpeg";
  if (/\.webp(?:$|\?)/i.test(url)) return "image/webp";
  return "image/png";
}

function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function normalizeInlineSvg(svg, color = "#F4F7FB") {
  if (!svg) return "";

  const cleaned = svg
    .replace(/\sclass="[^"]*"/g, "")
    .replace(/\saria-hidden="[^"]*"/g, "")
    .replace(/\salt="[^"]*"/g, "")
    .replace(/currentColor/g, color);

  if (cleaned.includes("xmlns=")) {
    return cleaned;
  }

  return cleaned.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { "user-agent": userAgent } });
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: ${response.status}`);
  }

  return {
    contentType: response.headers.get("content-type")?.split(";")[0] ?? "",
    buffer: Buffer.from(await response.arrayBuffer())
  };
}

async function fetchAsDataUri(url) {
  if (!url) return "";
  if (url.startsWith("data:")) return url;

  const { contentType, buffer } = await fetchBuffer(url);
  return `data:${contentType || contentTypeFromUrl(url)};base64,${buffer.toString("base64")}`;
}

async function optionalFetchAsDataUri(url, fallback, label) {
  try {
    return (await fetchAsDataUri(url)) || fallback;
  } catch (error) {
    console.warn(`warning: using fallback ${label}: ${error.message}`);
    return fallback;
  }
}

async function optionalFetchFirstAsDataUri(urls, fallback, label) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];

  for (const url of uniqueUrls) {
    try {
      return await fetchAsDataUri(url);
    } catch (error) {
      console.warn(`warning: could not fetch ${label} from ${url}: ${error.message}`);
    }
  }

  console.warn(`warning: using fallback ${label}`);
  return fallback;
}

function htbRankSlug(rank) {
  return String(rank)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function officialHtbRankIconUrl(rank) {
  const slug = htbRankSlug(rank);
  return slug ? `${htbRankIconBaseUrl}/rank_${slug}.svg` : "";
}

function fallbackHexIcon(fill = "#80F070") {
  return svgDataUri(`<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M24 3L42.2 13.5V34.5L24 45L5.8 34.5V13.5L24 3Z" fill="#101824" stroke="${fill}" stroke-width="2"/>
  <path d="M24 13L33.5 18.5V29.5L24 35L14.5 29.5V18.5L24 13Z" fill="${fill}"/>
</svg>`);
}

function fallbackTextIcon(label, fill = "#80F070") {
  return svgDataUri(`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="20" height="20" rx="5" fill="#1B2738"/>
  <text x="12" y="16" text-anchor="middle" fill="${fill}" font-family="Arial, sans-serif" font-size="8" font-weight="800">${label}</text>
</svg>`);
}

function fallbackThmTrophyIcon() {
  return svgDataUri(`<svg width="32" height="28" viewBox="0 0 32 28" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path fill="#FFBB45" d="M10 2h12v3h4c.6 0 1 .4 1 1 0 4.5-2.2 7.4-6 8.5-.7 1-1.6 1.8-2.7 2.4v3.2h3.2c1.4 0 2.5 1.1 2.5 2.5V24H8v-1.4c0-1.4 1.1-2.5 2.5-2.5h3.2v-3.2c-1.1-.6-2-1.4-2.7-2.4C7.2 13.4 5 10.5 5 6c0-.6.4-1 1-1h4V2Zm12 5v1.2c0 1.2-.2 2.4-.5 3.4 1.7-.8 2.7-2.3 3-4.6H22ZM7.5 7c.3 2.3 1.3 3.8 3 4.6-.3-1-.5-2.2-.5-3.4V7H7.5Z"/>
  <path fill="#FF8D00" d="M16 5.2l1.4 2.9 3.2.5-2.3 2.2.6 3.2-2.9-1.5-2.9 1.5.6-3.2-2.3-2.2 3.2-.5L16 5.2Z"/>
</svg>`);
}

function fallbackThmBadgeIcon() {
  return svgDataUri(`<svg width="24" height="28" viewBox="0 0 24 28" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path fill="#ECCCFF" d="M12 0c1.1 0 1.9 1 2.9 1.3 1 .3 2.3-.2 3.1.4.9.5 1.1 1.8 1.8 2.6.8.7 2.1 1 2.6 1.8.6.9.1 2.1.4 3.1.3 1 1.2 1.8 1.2 2.9s-.9 1.9-1.2 2.9c-.3 1 .2 2.2-.4 3.1-.5.9-1.8 1.1-2.6 1.8-.7.8-.9 2.1-1.8 2.6-.8.5-2.1.1-3.1.4-1 .3-1.8 1.2-2.9 1.2s-1.9-.9-2.9-1.2c-1-.3-2.3.1-3.1-.4-.9-.5-1.1-1.8-1.8-2.6-.8-.7-2.1-.9-2.6-1.8-.6-.9-.1-2.1-.4-3.1C.9 14 0 13.2 0 12.1s.9-1.9 1.2-2.9c.3-1-.2-2.2.4-3.1.5-.9 1.8-1.1 2.6-1.8.7-.8.9-2.1 1.8-2.6.8-.6 2.1-.1 3.1-.4C10.1 1 10.9 0 12 0Z"/>
  <circle cx="12" cy="12" r="5" fill="#9B5DE5"/>
  <path fill="#C77DFF" d="m7 22 3 6 2-3 2 3 3-6-2.2-.8c-.8.6-1.7 1-2.8 1s-2-.4-2.8-1L7 22Z"/>
</svg>`);
}

function fallbackThmFlameIcon() {
  return svgDataUri(`<svg width="21" height="25" viewBox="0 0 21 25" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path fill="#FF8D00" d="M7.45.33a1 1 0 0 1 1.32 0 42 42 0 0 1 3.6 3.94c.52-.66 1.13-1.41 1.74-2.02a1 1 0 0 1 1.31 0C18.7 5.35 21 10.55 21 13.03c0 6-4.69 11.02-10.5 11.02C4.59 24.05 0 19.03 0 13.03c0-3.56 3.19-8.77 7.45-12.7Zm3.1 19.22c1.22 0 2.25-.33 3.23-.99 1.97-1.36 2.49-4.13 1.31-6.28-.18-.42-.75-.47-1.03-.09l-1.22 1.36a.7.7 0 0 1-1.12 0c-.8-.99-2.16-2.77-2.95-3.75-.29-.38-.85-.38-1.18 0-1.59 1.97-2.39 3.23-2.39 4.64.05 3.24 2.39 5.11 5.35 5.11Z"/>
</svg>`);
}

function fallbackThmRoomIcon() {
  return svgDataUri(`<svg width="29" height="25" viewBox="0 0 29 25" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path fill="#224633" d="M0 22.66c0-.43.35-.78.78-.78h3.93V25H.78A.78.78 0 0 1 0 24.22v-1.56Zm27.45-.78c.43 0 .78.35.78.78v1.56c0 .43-.35.78-.78.78h-3.92v-3.13h3.92Z"/>
  <path fill="#719CF9" d="M21.18 0H7.06C5.76 0 4.7 1.11 4.7 2.48V25h18.83V2.48C23.53 1.11 22.48 0 21.18 0Zm-2.36 14.06a1.57 1.57 0 1 1 0-3.12 1.57 1.57 0 0 1 0 3.12Z"/>
</svg>`);
}

async function scrapePublicAssets(page, rank) {
  return page.evaluate((currentRank) => {
    function urlFromBackground(value) {
      const match = value.match(/url\(["']?(.+?)["']?\)/);
      return match?.[1] ?? "";
    }

    function svgNearText(label) {
      const matches = [...document.querySelectorAll("*")].filter(
        (element) => element.children.length === 0 && element.textContent.trim() === label
      );

      for (const match of matches) {
        let node = match;
        for (let depth = 0; depth < 8 && node; depth += 1) {
          const svg = node.querySelector?.("svg");
          if (svg) return svg.outerHTML;
          node = node.parentElement;
        }
      }

      return "";
    }

    const images = [...document.images];
    const avatarUrl =
      images.find((image) => image.alt === "avatar")?.currentSrc ||
      images.find((image) => image.alt === "User avatar")?.currentSrc ||
      "";
    const rankIconUrl =
      images.find(
        (image) =>
          image.currentSrc.includes("/assets/ranks/svg/") &&
          image.alt.toLowerCase() === currentRank.toLowerCase()
      )?.currentSrc ||
      images.find((image) => image.currentSrc.includes("/assets/ranks/svg/rank_"))
        ?.currentSrc ||
      "";
    const rankBackgroundUrl =
      [...document.querySelectorAll("*")]
        .map((element) => getComputedStyle(element).backgroundImage)
        .find((background) => background.includes("/assets/ranks/backgrounds/")) ?? "";

    return {
      avatarUrl,
      rankIconUrl,
      rankBackgroundUrl: urlFromBackground(rankBackgroundUrl),
      xpIconSvg:
        document.querySelector(".htb-xp-streaks-card--xp-icon svg")?.outerHTML ||
        svgNearText("Level"),
      machineIconSvg: svgNearText("Machines"),
      challengeIconSvg: svgNearText("Challenges"),
      flameDataUri:
        document.querySelector("[data-streak-state] img[src^='data:image/svg+xml']")
          ?.currentSrc || ""
    };
  }, rank);
}

async function scrapeThmPublicAssets(page) {
  return page.evaluate(() => {
    const images = [...document.images];

    function compact(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function svgNearStat(label) {
      const candidates = [...document.querySelectorAll("div, section, article, li")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            element,
            text: compact(element.innerText),
            area: rect.width * rect.height,
            width: rect.width,
            height: rect.height
          };
        })
        .filter(
          (item) =>
            item.text.includes(label) &&
            item.width > 40 &&
            item.width < 420 &&
            item.height > 30 &&
            item.height < 220 &&
            item.element.querySelector("svg")
        )
        .sort((a, b) => a.area - b.area);

      return candidates[0]?.element.querySelector("svg")?.outerHTML ?? "";
    }

    return {
      avatarUrl:
        (images.find((image) => image.alt === "User profile photo.")?.currentSrc ||
          images.find((image) => image.alt === "User profile photo.")?.src) ||
        (images.find((image) => (image.currentSrc || image.src).includes("user-avatars"))
          ?.currentSrc ||
          images.find((image) => (image.currentSrc || image.src).includes("user-avatars"))
            ?.src) ||
        "",
      rankIconSvg: svgNearStat("Rank"),
      badgeIconSvg: svgNearStat("Badges"),
      streakIconSvg: svgNearStat("Streak"),
      roomIconSvg: svgNearStat("Completed rooms")
    };
  });
}

function renderGradeDiamonds(grade) {
  if (!grade.total) return "";

  return Array.from({ length: grade.total }, (_, index) => {
    const x = index * 14;
    const fill = index < grade.active ? "#F4F7FB" : "#5F6D80";
    return `<rect x="${x}" y="0" width="7" height="7" rx="1" transform="rotate(45 ${x + 3.5} 3.5)" fill="${fill}"/>`;
  }).join("\n    ");
}

function renderHtbCard(profile) {
  const username = "constantines";
  const rank = escapeSvg(profile.rank);
  const level = escapeSvg(profile.level);
  const levelProgress = escapeSvg(profile.levelProgress);
  const streak = escapeSvg(profile.streak.replace(/\s*weeks?$/i, "w"));
  const machines = escapeSvg(profile.machines);
  const challenges = escapeSvg(profile.challenges);
  const gradeLabel = escapeSvg(profile.grade.label);
  const avatar = escapeSvg(profile.assets.avatar);
  const rankIcon = escapeSvg(profile.assets.rankIcon);
  const rankBackground = escapeSvg(profile.assets.rankBackground);
  const xpIcon = escapeSvg(profile.assets.xpIcon);
  const machineIcon = escapeSvg(profile.assets.machineIcon);
  const challengeIcon = escapeSvg(profile.assets.challengeIcon);
  const flameIcon = escapeSvg(profile.assets.flameIcon);
  const gradeDiamonds = renderGradeDiamonds(profile.grade);

  return `<svg width="360" height="88" viewBox="0 0 360 88" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">Hack The Box profile badge for ${username}</title>
  <desc id="desc">Auto-generated weekly badge using public Hack The Box avatar, rank art, level, streak, machines, and challenges.</desc>
  <defs>
    <clipPath id="cardClip">
      <rect width="360" height="88" rx="14"/>
    </clipPath>
    <clipPath id="avatarClip">
      <circle cx="46" cy="41" r="27"/>
    </clipPath>
    <linearGradient id="cardBg" x1="0" y1="0" x2="360" y2="88" gradientUnits="userSpaceOnUse">
      <stop stop-color="#101824"/>
      <stop offset="0.58" stop-color="#152133"/>
      <stop offset="1" stop-color="#0F1720"/>
    </linearGradient>
    <radialGradient id="greenGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(303 12) rotate(145) scale(132 88)">
      <stop stop-color="#80F070" stop-opacity="0.24"/>
      <stop offset="1" stop-color="#80F070" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect x="0.5" y="0.5" width="359" height="87" rx="13.5" fill="url(#cardBg)" stroke="#2B3B51"/>
  <image href="${rankBackground}" x="0" y="-72" width="360" height="240" opacity="0.15" preserveAspectRatio="xMidYMid slice" clip-path="url(#cardClip)"/>
  <rect width="360" height="88" rx="14" fill="url(#greenGlow)"/>

  <circle cx="46" cy="41" r="31" fill="#0B111A" stroke="#2B3A52" stroke-width="2"/>
  <image href="${avatar}" x="19" y="14" width="54" height="54" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>
  <circle cx="46" cy="41" r="27" stroke="#80F070" stroke-opacity="0.34"/>
  <image href="${rankIcon}" x="56" y="47" width="36" height="36" preserveAspectRatio="xMidYMid meet"/>

  <text x="92" y="24" fill="#F4F7FB" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="17" font-weight="800">${username}</text>
  <text x="92" y="41" fill="#9AA6B2" font-family="JetBrains Mono, Consolas, monospace" font-size="9" letter-spacing="1.35">HACK THE BOX</text>
  <text x="92" y="62" fill="#80F070" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="14" font-weight="800">${rank}</text>
  <g transform="translate(92 70)">
    ${gradeDiamonds}
  </g>
  <text x="140" y="77" fill="#7E8EA4" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="8.5" font-weight="700">Grade ${gradeLabel}</text>

  <g font-family="Inter, Segoe UI, Arial, sans-serif" font-weight="800">
    <g transform="translate(206 12)">
      <image href="${xpIcon}" x="0" y="0" width="15" height="15" preserveAspectRatio="xMidYMid meet"/>
      <text x="34" y="13" fill="#F4F7FB" font-size="10.8" text-anchor="middle">Lvl ${level}</text>
      <text x="34" y="27" fill="#9AA6B2" font-size="8.2" font-weight="700" text-anchor="middle">${levelProgress}</text>
    </g>

    <g transform="translate(291 12)">
      <image href="${flameIcon}" x="0" y="-1" width="18" height="18" preserveAspectRatio="xMidYMid meet"/>
      <text x="36" y="13" fill="#F4F7FB" font-size="11.2" text-anchor="middle">${streak}</text>
      <text x="36" y="27" fill="#9AA6B2" font-size="8.2" font-weight="700" text-anchor="middle">streak</text>
    </g>

    <g transform="translate(206 50)">
      <image href="${machineIcon}" x="0" y="1" width="16" height="16" preserveAspectRatio="xMidYMid meet"/>
      <text x="36" y="14" fill="#F4F7FB" font-size="10.8" text-anchor="middle">${machines}</text>
      <text x="36" y="29" fill="#9AA6B2" font-size="7.6" font-weight="700" text-anchor="middle">machines</text>
    </g>

    <g transform="translate(291 50)">
      <image href="${challengeIcon}" x="0" y="1" width="16" height="16" preserveAspectRatio="xMidYMid meet"/>
      <text x="36" y="14" fill="#F4F7FB" font-size="10.8" text-anchor="middle">${challenges}</text>
      <text x="36" y="29" fill="#9AA6B2" font-size="7.4" font-weight="700" text-anchor="middle">challenges</text>
    </g>
  </g>
</svg>
`;
}

function renderThmCard(profile) {
  const username = "constantines";
  const title = escapeSvg(profile.title);
  const topPercent = escapeSvg(profile.topPercent || "public");
  const rank = escapeSvg(profile.rank);
  const badges = escapeSvg(profile.badges);
  const streak = escapeSvg(`${profile.streak}d`);
  const completedRooms = escapeSvg(profile.completedRooms);
  const avatar = escapeSvg(profile.assets.avatar);
  const rankIcon = escapeSvg(profile.assets.rankIcon);
  const badgeIcon = escapeSvg(profile.assets.badgeIcon);
  const streakIcon = escapeSvg(profile.assets.streakIcon);
  const roomIcon = escapeSvg(profile.assets.roomIcon);

  return `<svg width="360" height="88" viewBox="0 0 360 88" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">TryHackMe profile badge for ${username}</title>
  <desc id="desc">Auto-generated weekly badge using public TryHackMe avatar, title, level, rank, badges, streak, and completed rooms.</desc>
  <defs>
    <clipPath id="cardClip">
      <rect width="360" height="88" rx="14"/>
    </clipPath>
    <clipPath id="avatarClip">
      <circle cx="46" cy="41" r="27"/>
    </clipPath>
    <linearGradient id="cardBg" x1="0" y1="0" x2="360" y2="88" gradientUnits="userSpaceOnUse">
      <stop stop-color="#101824"/>
      <stop offset="0.56" stop-color="#152136"/>
      <stop offset="1" stop-color="#101D24"/>
    </linearGradient>
    <radialGradient id="purpleGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(288 12) rotate(145) scale(148 94)">
      <stop stop-color="#C77DFF" stop-opacity="0.18"/>
      <stop offset="0.5" stop-color="#80F070" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#80F070" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ribbon" x1="265" y1="0" x2="360" y2="88" gradientUnits="userSpaceOnUse">
      <stop stop-color="#31445F" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#80F070" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect x="0.5" y="0.5" width="359" height="87" rx="13.5" fill="url(#cardBg)" stroke="#2B3B51"/>
  <rect width="360" height="88" rx="14" fill="url(#purpleGlow)"/>
  <path d="M266 0H360V88H306C294 63 281 36 266 0Z" fill="url(#ribbon)" clip-path="url(#cardClip)"/>

  <circle cx="46" cy="41" r="31" fill="#0B111A" stroke="#2B3A52" stroke-width="2"/>
  <image href="${avatar}" x="19" y="14" width="54" height="54" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>
  <circle cx="46" cy="41" r="27" stroke="#80F070" stroke-opacity="0.34"/>

  <text x="92" y="24" fill="#F4F7FB" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="17" font-weight="800">${username}</text>
  <text x="92" y="41" fill="#9AA6B2" font-family="JetBrains Mono, Consolas, monospace" font-size="9" letter-spacing="1.35">TRYHACKME</text>
  <text x="92" y="61" fill="#80F070" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="13" font-weight="800">${title}</text>
  <text x="92" y="76" fill="#7E8EA4" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="8.5" font-weight="700">Rank ${rank} / ${topPercent}</text>

  <g font-family="Inter, Segoe UI, Arial, sans-serif" font-weight="800">
    <g transform="translate(207 12)">
      <image href="${rankIcon}" x="0" y="-1" width="18" height="18" preserveAspectRatio="xMidYMid meet"/>
      <text x="43" y="13" fill="#F4F7FB" font-size="9.2" text-anchor="middle">#${rank}</text>
      <text x="43" y="27" fill="#9AA6B2" font-size="8.2" font-weight="700" text-anchor="middle">${topPercent}</text>
    </g>

    <g transform="translate(291 12)">
      <image href="${streakIcon}" x="0" y="-1" width="18" height="18" preserveAspectRatio="xMidYMid meet"/>
      <text x="36" y="13" fill="#F4F7FB" font-size="11.2" text-anchor="middle">${streak}</text>
      <text x="36" y="27" fill="#9AA6B2" font-size="8.2" font-weight="700" text-anchor="middle">streak</text>
    </g>

    <g transform="translate(207 50)">
      <image href="${roomIcon}" x="0" y="0" width="18" height="18" preserveAspectRatio="xMidYMid meet"/>
      <text x="36" y="14" fill="#F4F7FB" font-size="10.8" text-anchor="middle">${completedRooms}</text>
      <text x="36" y="29" fill="#9AA6B2" font-size="7.6" font-weight="700" text-anchor="middle">rooms</text>
    </g>

    <g transform="translate(291 50)">
      <image href="${badgeIcon}" x="0" y="0" width="18" height="18" preserveAspectRatio="xMidYMid meet"/>
      <text x="36" y="14" fill="#F4F7FB" font-size="10.8" text-anchor="middle">${badges}</text>
      <text x="36" y="29" fill="#9AA6B2" font-size="7.6" font-weight="700" text-anchor="middle">badges</text>
    </g>
  </g>
</svg>
`;
}

async function updateHtbBadge() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
    userAgent
  });

  try {
    await page.goto(htbProfileUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("constantines") &&
        document.body.innerText.includes("Weekly Streak") &&
        document.body.innerText.includes("Machines") &&
        document.body.innerText.includes("Challenges"),
      undefined,
      { timeout: 90_000 }
    );

    const profile = await readHydratedProfile(page);
    const publicAssets = await scrapePublicAssets(page, profile.rank);

    const fallbackIcon = fallbackHexIcon();
    const assets = {
      avatar: await optionalFetchAsDataUri(publicAssets.avatarUrl, fallbackIcon, "avatar"),
      rankIcon: await optionalFetchFirstAsDataUri(
        [publicAssets.rankIconUrl, officialHtbRankIconUrl(profile.rank)],
        fallbackIcon,
        "rank icon"
      ),
      rankBackground: await optionalFetchAsDataUri(
        publicAssets.rankBackgroundUrl,
        fallbackIcon,
        "rank background"
      ),
      xpIcon: publicAssets.xpIconSvg
        ? svgDataUri(normalizeInlineSvg(publicAssets.xpIconSvg, "#C77DFF"))
        : fallbackTextIcon("XP", "#C77DFF"),
      machineIcon: publicAssets.machineIconSvg
        ? svgDataUri(normalizeInlineSvg(publicAssets.machineIconSvg, "#F4F7FB"))
        : fallbackTextIcon("M", "#F4F7FB"),
      challengeIcon: publicAssets.challengeIconSvg
        ? svgDataUri(normalizeInlineSvg(publicAssets.challengeIconSvg, "#F4F7FB"))
        : fallbackTextIcon("C", "#F4F7FB"),
      flameIcon: publicAssets.flameDataUri || fallbackTextIcon("S", "#FF5F46")
    };

    writeFileSync(join(badgesDir, "htb-card.svg"), renderHtbCard({ ...profile, assets }));
    console.log(
      `updated public/assets/badges/htb-card.svg: ${profile.rank}, level ${profile.level}, ${profile.streak}`
    );
  } finally {
    await browser.close();
  }
}

async function updateThmBadge() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    userAgent
  });

  try {
    await page.goto(thmProfileUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("constantines") &&
        document.body.innerText.includes("Rank") &&
        document.body.innerText.includes("Badges") &&
        document.body.innerText.includes("Completed rooms"),
      undefined,
      { timeout: 90_000 }
    );
    await page
      .waitForFunction(
        () =>
          [...document.images].some(
            (image) =>
              (image.currentSrc || image.src).includes("user-avatars") &&
              image.naturalWidth > 0
          ),
        undefined,
        { timeout: 30_000 }
      )
      .catch(() => undefined);

    const profile = await readHydratedThmProfile(page);
    const publicAssets = await scrapeThmPublicAssets(page);
    const assets = {
      avatar: await optionalFetchAsDataUri(publicAssets.avatarUrl, fallbackHexIcon(), "THM avatar"),
      rankIcon: publicAssets.rankIconSvg
        ? svgDataUri(normalizeInlineSvg(publicAssets.rankIconSvg))
        : fallbackThmTrophyIcon(),
      badgeIcon: publicAssets.badgeIconSvg
        ? svgDataUri(normalizeInlineSvg(publicAssets.badgeIconSvg))
        : fallbackThmBadgeIcon(),
      streakIcon: publicAssets.streakIconSvg
        ? svgDataUri(normalizeInlineSvg(publicAssets.streakIconSvg))
        : fallbackThmFlameIcon(),
      roomIcon: publicAssets.roomIconSvg
        ? svgDataUri(normalizeInlineSvg(publicAssets.roomIconSvg))
        : fallbackThmRoomIcon()
    };

    writeFileSync(join(badgesDir, "thm-card.svg"), renderThmCard({ ...profile, assets }));
    console.log(
      `updated public/assets/badges/thm-card.svg: level ${profile.level}, ${profile.completedRooms} rooms`
    );
  } finally {
    await browser.close();
  }
}

async function main() {
  mkdirSync(badgesDir, { recursive: true });
  await updateHtbBadge();
  await updateThmBadge();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
