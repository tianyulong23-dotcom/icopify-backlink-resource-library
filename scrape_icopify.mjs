import { chromium } from "playwright";
import * as cheerio from "cheerio";
import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_PROJECT_ID = "39023";
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_DELAY_MS = 250;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 4;

function parseArgs(argv) {
  const options = {
    projectId: DEFAULT_PROJECT_ID,
    concurrency: DEFAULT_CONCURRENCY,
    delayMs: DEFAULT_DELAY_MS,
    headless: false,
    startPage: 1,
    endPage: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--project") options.projectId = value;
    else if (arg === "--concurrency") options.concurrency = Number(value);
    else if (arg === "--delay-ms") options.delayMs = Number(value);
    else if (arg === "--start-page") options.startPage = Number(value);
    else if (arg === "--end-page") options.endPage = Number(value);
    else if (arg === "--headless") {
      options.headless = true;
      continue;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isInteger(options.startPage) || options.startPage < 1) {
    throw new Error("--start-page must be a positive integer");
  }
  if (
    options.endPage !== null &&
    (!Number.isInteger(options.endPage) || options.endPage < options.startPage)
  ) {
    throw new Error("--end-page must be greater than or equal to --start-page");
  }
  return options;
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function numberFrom(value) {
  const match = String(value || "").match(/[\d,]+(?:\.\d+)?/);
  return match ? Number(match[0].replaceAll(",", "")) : null;
}

export function parsePublishersPage(html, sourcePage) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table tbody tr").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length < 7) return;

    const firstCell = cells.eq(0);
    const websiteLink = firstCell.find('a[href^="http"]').first();
    const firstText = normalizedText(firstCell.text());
    const linkMatch = firstText.match(
      /Max\s+(\d+)\s+(DoFollow|NoFollow)\s+links/i,
    );
    const turnaroundMatch = firstText.match(/Turnaround Time:\s*(.+)$/i);
    const popover = websiteLink.attr("data-content") || "";
    const addedMatch = popover.match(
      /Added on:[\s\S]*?<strong[^>]*>([^<]+)<\/strong>/i,
    );

    const actionCell = cells.eq(6);
    const priceText = actionCell
      .find("a,button")
      .map((__, element) => normalizedText($(element).text()))
      .get()
      .find((text) => /^[$€£]\s*[\d,.]+$/.test(text));
    const performerHref =
      actionCell.find('a[href*="/performers/all-performers"]').attr("href") || "";
    const performerMatch = performerHref.match(/[?&]id=(\d+)/);

    rows.push({
      website_id:
        actionCell.find('input[name="website_id"]').first().attr("value") ||
        performerMatch?.[1] ||
        null,
      website: normalizedText(websiteLink.text()),
      website_url: websiteLink.attr("href") || null,
      categories: cells
        .eq(1)
        .find(".badge")
        .map((__, element) => normalizedText($(element).text()))
        .get()
        .filter(Boolean),
      monthly_traffic: numberFrom(cells.eq(2).text()),
      ahrefs_dr: numberFrom(cells.eq(3).text().replace(/^.*?DR/i, "")),
      moz_da: numberFrom(cells.eq(4).text().replace(/^.*?DA/i, "")),
      language:
        normalizedText(cells.eq(5).find("span").last().text()) ||
        normalizedText(cells.eq(5).text()) ||
        null,
      price: priceText ? numberFrom(priceText) : null,
      currency: priceText?.trim()[0] || null,
      max_links: linkMatch ? Number(linkMatch[1]) : null,
      link_type: linkMatch?.[2] || null,
      turnaround: turnaroundMatch?.[1]?.trim() || null,
      added_on: addedMatch?.[1]?.trim() || null,
      source_page: sourcePage,
    });
  });

  const pageNumbers = $(".pagination .page-link")
    .map((_, element) => Number(normalizedText($(element).text())))
    .get()
    .filter(Number.isFinite);

  return {
    rows,
    totalPages: pageNumbers.length ? Math.max(...pageNumbers) : sourcePage,
  };
}

function pageFile(pagesDir, pageNumber) {
  return path.join(pagesDir, `page-${String(pageNumber).padStart(6, "0")}.json`);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeLogin(html, finalUrl) {
  return (
    finalUrl.includes("/login") ||
    /We're glad to see you again|name=["']password["']/i.test(html)
  );
}

async function requestPage(request, baseUrl, pageNumber, delayMs) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await request.get(`${baseUrl}?page=${pageNumber}`, {
        timeout: 60_000,
      });
      const html = await response.text();
      if (looksLikeLogin(html, response.url())) {
        throw new Error("Authentication expired; the server returned the login page");
      }
      if (!response.ok()) {
        throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
      }
      if (delayMs > 0) await sleep(delayMs);
      return html;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

async function ensureAuthenticated(page, targetUrl) {
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  if (!page.url().includes("/login")) return;

  console.log("Login required. Complete login in the opened browser window.");
  await page.waitForURL((url) => !url.pathname.includes("/login"), {
    timeout: LOGIN_TIMEOUT_MS,
  });
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
}

async function combinePages(pagesDir, outputDir) {
  const files = (await readdir(pagesDir))
    .filter((name) => /^page-\d{6}\.json$/.test(name))
    .sort();
  const rows = [];

  for (const file of files) {
    const page = JSON.parse(await readFile(path.join(pagesDir, file), "utf8"));
    rows.push(...page.rows);
  }

  const jsonl = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(
    path.join(outputDir, "publishers.raw.jsonl"),
    jsonl ? `${jsonl}\n` : "",
    "utf8",
  );
  return rows.length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const outputDir = path.join(rootDir, "data", `icopify-${options.projectId}`);
  const pagesDir = path.join(outputDir, "pages");
  const profileDir = path.join(rootDir, ".playwright", "icopify-profile");
  const baseUrl = `https://icopify.co/project/${options.projectId}/publishers`;

  await mkdir(pagesDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "msedge",
    headless: options.headless,
    viewport: null,
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await ensureAuthenticated(page, baseUrl);

    const firstHtml = await requestPage(
      context.request,
      baseUrl,
      options.startPage,
      options.delayMs,
    );
    const firstPage = parsePublishersPage(firstHtml, options.startPage);
    if (!firstPage.rows.length) {
      throw new Error("No publisher rows found on the first requested page");
    }

    const finalPage = Math.min(
      options.endPage ?? firstPage.totalPages,
      firstPage.totalPages,
    );
    const pageNumbers = [];
    for (
      let pageNumber = options.startPage;
      pageNumber <= finalPage;
      pageNumber += 1
    ) {
      pageNumbers.push(pageNumber);
    }

    let completed = 0;
    let cursor = 0;
    const startedAt = new Date().toISOString();

    async function worker() {
      while (cursor < pageNumbers.length) {
        const index = cursor;
        cursor += 1;
        const pageNumber = pageNumbers[index];
        const filePath = pageFile(pagesDir, pageNumber);

        if (await fileExists(filePath)) {
          completed += 1;
          continue;
        }

        const html =
          pageNumber === options.startPage
            ? firstHtml
            : await requestPage(
                context.request,
                baseUrl,
                pageNumber,
                options.delayMs,
              );
        const parsed = parsePublishersPage(html, pageNumber);
        if (!parsed.rows.length) {
          throw new Error(`Page ${pageNumber} returned no publisher rows`);
        }

        await writeFile(
          filePath,
          JSON.stringify(
            {
              project_id: options.projectId,
              source_url: `${baseUrl}?page=${pageNumber}`,
              scraped_at: new Date().toISOString(),
              rows: parsed.rows,
            },
            null,
            2,
          ),
          "utf8",
        );

        completed += 1;
        if (completed % 25 === 0 || completed === pageNumbers.length) {
          const progress = {
            project_id: options.projectId,
            started_at: startedAt,
            updated_at: new Date().toISOString(),
            start_page: options.startPage,
            end_page: finalPage,
            completed_pages: completed,
            total_pages_in_run: pageNumbers.length,
          };
          await writeFile(
            path.join(outputDir, "progress.json"),
            JSON.stringify(progress, null, 2),
            "utf8",
          );
          console.log(
            `Completed ${completed}/${pageNumbers.length} pages (${pageNumber})`,
          );
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(options.concurrency, pageNumbers.length) },
        () => worker(),
      ),
    );

    const rawCount = await combinePages(pagesDir, outputDir);
    console.log(`Finished ${completed} pages with ${rawCount} raw rows.`);
    console.log(`Raw output: ${path.join(outputDir, "publishers.raw.jsonl")}`);
  } finally {
    await context.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
