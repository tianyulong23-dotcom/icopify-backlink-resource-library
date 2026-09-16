import { promises as dns } from "node:dns";
import { existsSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as cheerio from "cheerio";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_DATABASE = path.join(
  PROJECT_ROOT,
  "data",
  "icopify-39023",
  "publishers.sqlite",
);
const DEFAULT_CONTACTS_DATABASE = path.join(
  PROJECT_ROOT,
  "data",
  "icopify-39023",
  "contacts.sqlite",
);
const DEFAULT_LOCK_PATH = path.join(
  PROJECT_ROOT,
  "data",
  "icopify-39023",
  "contacts-crawler.lock",
);
const USER_AGENT = "LocalResourceLibraryContactCrawler/1.0";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const EMAIL_PREFIX_PRIORITY = [
  "contact",
  "info",
  "editor",
  "editorial",
  "advertising",
  "ads",
  "partnerships",
  "partners",
  "hello",
  "support",
  "sales",
  "press",
  "team",
  "admin",
];
const CONTACT_HINTS = [
  "contact",
  "contact-us",
  "write-for-us",
  "guest-post",
  "guestpost",
  "advertise",
  "advertising",
  "editorial",
  "submit",
  "submission",
  "contribute",
  "contributor",
  "impressum",
  "kontakt",
  "contato",
  "contacto",
  "联系我们",
  "联络",
  "投稿",
  "合作",
];
const DISCOVERY_HINTS = [...CONTACT_HINTS, "about", "about-us"];
const emailDomainCache = new Map();

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function parseArguments(argv) {
  const options = {
    concurrency: 4,
    contactsDatabase: DEFAULT_CONTACTS_DATABASE,
    delayMs: 350,
    initOnly: false,
    limit: null,
    maxPages: 4,
    retryErrors: false,
    sourceDatabase: DEFAULT_SOURCE_DATABASE,
    timeoutMs: 12_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--concurrency") {
      options.concurrency = parsePositiveInteger(value, options.concurrency, 12);
      index += 1;
    } else if (argument === "--contacts-database") {
      options.contactsDatabase = path.resolve(value);
      index += 1;
    } else if (argument === "--delay-ms") {
      options.delayMs = parsePositiveInteger(value, options.delayMs, 10_000);
      index += 1;
    } else if (argument === "--init-only") {
      options.initOnly = true;
    } else if (argument === "--limit") {
      options.limit = parsePositiveInteger(value, null);
      index += 1;
    } else if (argument === "--max-pages") {
      options.maxPages = parsePositiveInteger(value, options.maxPages, 8);
      index += 1;
    } else if (argument === "--retry-errors") {
      options.retryErrors = true;
    } else if (argument === "--source-database") {
      options.sourceDatabase = path.resolve(value);
      index += 1;
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(value, options.timeoutMs, 60_000);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timestamp() {
  return new Date().toISOString();
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockPath) {
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(String(process.pid));
    return handle;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    const existingPid = Number.parseInt(await readFile(lockPath, "utf8"), 10);
    if (processIsRunning(existingPid)) {
      throw new Error(`Contact crawler is already running with PID ${existingPid}`);
    }
    await rm(lockPath, { force: true });
    const handle = await open(lockPath, "wx");
    await handle.writeFile(String(process.pid));
    return handle;
  }
}

export function initializeContactsDatabase(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS website_contacts (
      domain TEXT PRIMARY KEY,
      website_url TEXT,
      status TEXT NOT NULL,
      emails_json TEXT NOT NULL DEFAULT '[]',
      phones_json TEXT NOT NULL DEFAULT '[]',
      contact_urls_json TEXT NOT NULL DEFAULT '[]',
      source_urls_json TEXT NOT NULL DEFAULT '[]',
      pages_scanned INTEGER NOT NULL DEFAULT 0,
      last_http_status INTEGER,
      last_error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS website_contacts_status_idx
      ON website_contacts(status, updated_at);

    CREATE TABLE IF NOT EXISTS contact_crawl_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      found INTEGER NOT NULL DEFAULT 0,
      not_found INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      pid INTEGER,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    INSERT OR IGNORE INTO contact_crawl_state (id, status, updated_at)
    VALUES (1, 'idle', CURRENT_TIMESTAMP);
  `);
}

function setRunState(database, values) {
  const current = database
    .prepare("SELECT * FROM contact_crawl_state WHERE id = 1")
    .get();
  const next = { ...current, ...values, id: 1, updated_at: timestamp() };
  database
    .prepare(
      `
        INSERT INTO contact_crawl_state (
          id, status, total, processed, found, not_found, blocked, errors,
          pid, started_at, updated_at, completed_at
        ) VALUES (
          $id, $status, $total, $processed, $found, $not_found, $blocked,
          $errors, $pid, $started_at, $updated_at, $completed_at
        )
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          total = excluded.total,
          processed = excluded.processed,
          found = excluded.found,
          not_found = excluded.not_found,
          blocked = excluded.blocked,
          errors = excluded.errors,
          pid = excluded.pid,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at
      `,
    )
    .run({
      $id: next.id,
      $status: next.status,
      $total: next.total,
      $processed: next.processed,
      $found: next.found,
      $not_found: next.not_found,
      $blocked: next.blocked,
      $errors: next.errors,
      $pid: next.pid,
      $started_at: next.started_at,
      $updated_at: next.updated_at,
      $completed_at: next.completed_at,
    });
}

function isPrivateIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIp(address) {
  const type = net.isIP(address);
  if (type === 4) {
    return isPrivateIpv4(address);
  }
  if (type !== 6) {
    return true;
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice(7));
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  );
}

async function assertPublicHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    throw new Error("Blocked non-public hostname");
  }
  const addresses = await dns.lookup(normalized, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Blocked non-public address");
  }
}

async function readLimitedBody(response, maximumBytes) {
  if (!response.body) {
    return "";
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("Response is too large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Response is too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function safeFetchText(input, { timeoutMs, maximumBytes = MAX_RESPONSE_BYTES }) {
  let currentUrl = new URL(input);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (!["http:", "https:"].includes(currentUrl.protocol)) {
      throw new Error("Unsupported URL protocol");
    }
    await assertPublicHostname(currentUrl.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(currentUrl, {
        headers: {
          Accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
          "Accept-Language": "en,zh-CN;q=0.8,zh;q=0.7",
          "User-Agent": USER_AGENT,
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect ${response.status} has no location`);
        }
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      const contentType = response.headers.get("content-type") || "";
      const text = await readLimitedBody(response, maximumBytes);
      return {
        contentType,
        status: response.status,
        text,
        url: currentUrl.href,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects");
}

function selectRobotsRules(text) {
  const groups = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || current.hasRules) {
        current = { agents: [], hasRules: false, rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (field === "allow" || field === "disallow")) {
      current.hasRules = true;
      if (value) {
        current.rules.push({ allow: field === "allow", path: value });
      }
    }
  }
  const crawlerName = USER_AGENT.toLowerCase().split("/")[0];
  const exact = groups.filter((group) =>
    group.agents.some((agent) => crawlerName.includes(agent) || agent.includes(crawlerName)),
  );
  if (exact.length) {
    return exact.flatMap((group) => group.rules);
  }
  return groups
    .filter((group) => group.agents.includes("*"))
    .flatMap((group) => group.rules);
}

export function robotsAllows(robotsText, targetUrl) {
  const rules = selectRobotsRules(robotsText);
  if (!rules.length) {
    return true;
  }
  const target = new URL(targetUrl);
  const pathWithQuery = `${target.pathname}${target.search}`;
  const matches = rules
    .filter((rule) => pathWithQuery.startsWith(rule.path.replace(/\*.*$/, "")))
    .sort((left, right) => right.path.length - left.path.length);
  return matches.length ? matches[0].allow : true;
}

function normalizedDomain(value) {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function sameSite(hostname, expectedDomain) {
  const host = normalizedDomain(hostname);
  const domain = normalizedDomain(expectedDomain);
  return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
}

function cleanEmail(value) {
  const email = value
    .trim()
    .replace(/^mailto:/i, "")
    .split(/[?&#]/, 1)[0]
    .replace(/^[<("'`]+|[>)"',`;:]+$/g, "")
    .toLowerCase();
  if (
    email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(email) ||
    email.includes("..") ||
    /\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(email) ||
    /(example\.com|email\.com|domain\.com)$/.test(email)
  ) {
    return null;
  }
  return email;
}

function sortEmails(emails) {
  return [...emails].sort((left, right) => {
    const leftPrefix = left.split("@")[0];
    const rightPrefix = right.split("@")[0];
    const leftRank = EMAIL_PREFIX_PRIORITY.indexOf(leftPrefix);
    const rightRank = EMAIL_PREFIX_PRIORITY.indexOf(rightPrefix);
    const normalizedLeftRank = leftRank < 0 ? EMAIL_PREFIX_PRIORITY.length : leftRank;
    const normalizedRightRank = rightRank < 0 ? EMAIL_PREFIX_PRIORITY.length : rightRank;
    return normalizedLeftRank - normalizedRightRank || left.localeCompare(right);
  });
}

function contactLinkScore(url, text) {
  const pathSegments = decodeURIComponent(url.pathname)
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment
        .replace(/\.(?:aspx?|html?|php)$/i, "")
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
        .trim(),
    );
  const linkText = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
  if (
    pathSegments.some((segment) => /comment page|feed|tag|category/.test(segment))
  ) {
    return 0;
  }
  const terminalPathSegment = pathSegments.at(-1) || "";
  for (let index = 0; index < DISCOVERY_HINTS.length; index += 1) {
    const hint = DISCOVERY_HINTS[index].replaceAll("-", " ");
    const pathMatch = terminalPathSegment === hint;
    const textMatch =
      hint === "about" || hint === "about us"
        ? linkText === hint
        : linkText === hint || linkText.startsWith(`${hint} `);
    if (pathMatch || textMatch) {
      const direct = CONTACT_HINTS.includes(DISCOVERY_HINTS[index]);
      return (direct ? 100 : 10) + DISCOVERY_HINTS.length - index;
    }
  }
  return 0;
}

export function extractContactData(html, pageUrl, expectedDomain) {
  const $ = cheerio.load(html);
  $("script, style, noscript, template").remove();
  $(
    [
      "#comments",
      "#respond",
      ".comments",
      ".comment-list",
      ".comment-respond",
      "[id^='comment-']",
      "[class~='comment']",
      "[class^='comment-']",
      "[class*=' comment-']",
    ].join(", "),
  ).remove();
  $("br, p, div, li, td, th, header, footer, section, article").append(" ");
  const emails = new Set();
  const phones = new Set();
  const contactUrls = new Map();
  const pageScore = contactLinkScore(new URL(pageUrl), "");
  const visibleText = (
    pageScore > 0 ? $("body").text() : $("header, footer").text()
  ).replace(/\s+/g, " ");
  const deobfuscatedText = visibleText
    .replace(/\s*(?:\[at\]|\(at\)|\sat\s)\s*/gi, "@")
    .replace(/\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*/gi, ".");

  for (const match of deobfuscatedText.matchAll(
    /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}/gi,
  )) {
    const email = cleanEmail(match[0]);
    if (email) {
      emails.add(email);
    }
  }

  for (const element of $("a[href^='mailto:']").toArray()) {
    const href = $(element).attr("href") || "";
    for (const value of href.replace(/^mailto:/i, "").split(/[;,]/)) {
      const email = cleanEmail(value);
      if (email) {
        emails.add(email);
      }
    }
  }

  for (const element of $("a[href^='tel:']").toArray()) {
    const phone = ($(element).attr("href") || "")
      .replace(/^tel:/i, "")
      .split(/[?&#]/, 1)[0]
      .trim();
    if (/^\+?[\d().\s-]{7,30}$/.test(phone)) {
      phones.add(phone);
    }
  }

  for (const element of $("a[href]").toArray()) {
    const href = $(element).attr("href");
    if (!href) {
      continue;
    }
    let target;
    try {
      target = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (
      !["http:", "https:"].includes(target.protocol) ||
      !sameSite(target.hostname, expectedDomain)
    ) {
      continue;
    }
    target.hash = "";
    const score = contactLinkScore(target, $(element).text());
    if (score > 0) {
      const current = contactUrls.get(target.href) || 0;
      contactUrls.set(target.href, Math.max(score, current));
    }
  }

  const hasContactForm = $("form").toArray().some((form) => {
    const formContext = [
      $(form).attr("action"),
      $(form).attr("aria-label"),
      $(form).attr("class"),
      $(form).attr("id"),
      $(form).attr("name"),
      $(form).text(),
    ]
      .filter(Boolean)
      .join(" ");
    return (
      !/comment|reply|review|newsletter|subscribe|login|search/i.test(
        formContext,
      ) &&
      /contact|message|inquiry|enquiry|feedback|support/i.test(formContext)
    );
  });

  return {
    contactLinks: [...contactUrls.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([url]) => url),
    directContactLinks: [...contactUrls.entries()]
      .filter(([, score]) => score >= 100)
      .sort((left, right) => right[1] - left[1])
      .map(([url]) => url),
    emails: sortEmails(emails).slice(0, 5),
    hasContactForm,
    phones: [...phones].slice(0, 5),
  };
}

async function emailDomainExists(domain) {
  if (!emailDomainCache.has(domain)) {
    emailDomainCache.set(
      domain,
      (async () => {
        try {
          const records = await dns.resolveMx(domain);
          if (records.length) {
            return true;
          }
        } catch {
          // Domains without MX can still receive mail through an A/AAAA record.
        }
        try {
          await assertPublicHostname(domain);
          return true;
        } catch {
          return false;
        }
      })(),
    );
  }
  return emailDomainCache.get(domain);
}

async function validateEmails(emails) {
  const validated = [];
  for (const email of sortEmails(emails)) {
    const domain = email.split("@")[1];
    if (await emailDomainExists(domain)) {
      validated.push(email);
    }
    if (validated.length >= 5) {
      break;
    }
  }
  return validated;
}

async function fetchRobots(origin, options) {
  try {
    const result = await safeFetchText(new URL("/robots.txt", origin), {
      maximumBytes: 512 * 1024,
      timeoutMs: options.timeoutMs,
    });
    if (result.status === 401 || result.status === 403) {
      return { blocked: true, text: "User-agent: *\nDisallow: /" };
    }
    if (result.status >= 500) {
      return { blocked: true, text: "User-agent: *\nDisallow: /" };
    }
    return { blocked: false, text: result.status < 400 ? result.text : "" };
  } catch {
    return { blocked: false, text: "" };
  }
}

function initialUrls(candidate) {
  const values = [];
  if (candidate.website_url) {
    try {
      const parsed = new URL(
        candidate.website_url.includes("://")
          ? candidate.website_url
          : `https://${candidate.website_url}`,
      );
      if (
        ["http:", "https:"].includes(parsed.protocol) &&
        sameSite(parsed.hostname, candidate.domain)
      ) {
        values.push(parsed.href);
      }
    } catch {
      // The domain fallback below handles malformed marketplace URLs.
    }
  }
  values.push(`https://${candidate.domain}/`, `http://${candidate.domain}/`);
  return [...new Set(values)];
}

async function crawlWebsite(candidate, options) {
  let homepage = null;
  let lastError = null;
  let lastHttpStatus = null;
  for (const url of initialUrls(candidate)) {
    try {
      const origin = new URL(url).origin;
      const robots = await fetchRobots(origin, options);
      if (robots.blocked || !robotsAllows(robots.text, url)) {
        return {
          contactUrls: [],
          emails: [],
          error: "robots.txt disallows crawling",
          lastHttpStatus: null,
          pagesScanned: 0,
          phones: [],
          sourceUrls: [],
          status: "blocked",
        };
      }
      const result = await safeFetchText(url, options);
      lastHttpStatus = result.status;
      if (result.status === 401 || result.status === 403 || result.status === 429) {
        lastError = `HTTP ${result.status}`;
        continue;
      }
      if (result.status >= 400 || !/html|text/i.test(result.contentType)) {
        lastError = `HTTP ${result.status}`;
        continue;
      }
      homepage = { ...result, robots: robots.text };
      break;
    } catch (error) {
      lastError = error.message;
    }
  }

  if (!homepage) {
    const blocked = /non-public/.test(lastError || "");
    return {
      contactUrls: [],
      emails: [],
      error: lastError || "Unable to load website",
      lastHttpStatus,
      pagesScanned: 0,
      phones: [],
      sourceUrls: [],
      status: blocked ? "blocked" : "error",
    };
  }

  const finalDomain = normalizedDomain(new URL(homepage.url).hostname);
  const emails = new Set();
  const phones = new Set();
  const contactUrls = new Set();
  const sourceUrls = [];
  const queue = [{ text: homepage.text, url: homepage.url }];
  const seen = new Set();

  while (queue.length && sourceUrls.length < options.maxPages) {
    const current = queue.shift();
    if (seen.has(current.url)) {
      continue;
    }
    seen.add(current.url);
    const extracted = extractContactData(current.text, current.url, finalDomain);
    sourceUrls.push(current.url);
    extracted.emails.forEach((email) => emails.add(email));
    extracted.phones.forEach((phone) => phones.add(phone));
    if (extracted.hasContactForm) {
      contactUrls.add(current.url);
    }
    extracted.directContactLinks.forEach((url) => contactUrls.add(url));

    for (const contactUrl of extracted.contactLinks) {
      if (
        seen.has(contactUrl) ||
        queue.some((item) => item.url === contactUrl) ||
        sourceUrls.length + queue.length >= options.maxPages
      ) {
        continue;
      }
      if (!robotsAllows(homepage.robots, contactUrl)) {
        continue;
      }
      try {
        await sleep(options.delayMs);
        const result = await safeFetchText(contactUrl, options);
        lastHttpStatus = result.status;
        if (result.status < 400 && /html|text/i.test(result.contentType)) {
          queue.push({ text: result.text, url: result.url });
        }
      } catch (error) {
        lastError = error.message;
      }
    }
  }

  const sortedEmails = await validateEmails(emails);
  const found = sortedEmails.length || phones.size || contactUrls.size;
  return {
    contactUrls: [...contactUrls].slice(0, 5),
    emails: sortedEmails,
    error: found ? null : lastError,
    lastHttpStatus,
    pagesScanned: sourceUrls.length,
    phones: [...phones].slice(0, 5),
    sourceUrls,
    status: found ? "found" : "not_found",
  };
}

function selectCandidates(sourceDatabase, contactsDatabase, options) {
  const existing = new Map(
    contactsDatabase
      .prepare("SELECT domain, status FROM website_contacts")
      .all()
      .map((row) => [row.domain, row.status]),
  );
  const rows = sourceDatabase
    .prepare(
      `
        SELECT domain, website_url
        FROM publishers
        WHERE domain IS NOT NULL AND domain <> ''
        ORDER BY source_page ASC, website COLLATE NOCASE ASC
      `,
    )
    .all()
    .filter((row) => {
      const status = existing.get(row.domain);
      if (!status || status === "running") {
        return true;
      }
      return options.retryErrors && status === "error";
    });
  return options.limit ? rows.slice(0, options.limit) : rows;
}

function markRunning(database, candidate) {
  const now = timestamp();
  database
    .prepare(
      `
        INSERT INTO website_contacts (
          domain, website_url, status, updated_at, started_at, attempt_count
        ) VALUES (
          $domain, $websiteUrl, 'running', $now, $now, 1
        )
        ON CONFLICT(domain) DO UPDATE SET
          website_url = excluded.website_url,
          status = 'running',
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          completed_at = NULL,
          last_error = NULL,
          attempt_count = website_contacts.attempt_count + 1
      `,
    )
    .run({
      $domain: candidate.domain,
      $websiteUrl: candidate.website_url,
      $now: now,
    });
}

function saveResult(database, candidate, result) {
  database
    .prepare(
      `
        UPDATE website_contacts SET
          status = $status,
          emails_json = $emails,
          phones_json = $phones,
          contact_urls_json = $contactUrls,
          source_urls_json = $sourceUrls,
          pages_scanned = $pagesScanned,
          last_http_status = $lastHttpStatus,
          last_error = $lastError,
          completed_at = $completedAt,
          updated_at = $completedAt
        WHERE domain = $domain
      `,
    )
    .run({
      $completedAt: timestamp(),
      $contactUrls: JSON.stringify(result.contactUrls),
      $domain: candidate.domain,
      $emails: JSON.stringify(result.emails),
      $lastError: result.error,
      $lastHttpStatus: result.lastHttpStatus,
      $pagesScanned: result.pagesScanned,
      $phones: JSON.stringify(result.phones),
      $sourceUrls: JSON.stringify(result.sourceUrls),
      $status: result.status,
    });
}

export async function runContactCrawler(options) {
  if (!existsSync(options.sourceDatabase)) {
    throw new Error(`Source database not found: ${options.sourceDatabase}`);
  }
  const lockHandle = await acquireLock(DEFAULT_LOCK_PATH);
  const sourceDatabase = new DatabaseSync(options.sourceDatabase, { readOnly: true });
  const contactsDatabase = new DatabaseSync(options.contactsDatabase);
  initializeContactsDatabase(contactsDatabase);

  if (options.initOnly) {
    sourceDatabase.close();
    contactsDatabase.close();
    await lockHandle.close();
    await rm(DEFAULT_LOCK_PATH, { force: true });
    console.log(`Contacts database initialized: ${options.contactsDatabase}`);
    return;
  }

  const candidates = selectCandidates(sourceDatabase, contactsDatabase, options);
  const counters = {
    blocked: 0,
    errors: 0,
    found: 0,
    not_found: 0,
    processed: 0,
  };
  let nextIndex = 0;
  let stopRequested = false;
  const startedAt = timestamp();

  const requestStop = () => {
    stopRequested = true;
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  setRunState(contactsDatabase, {
    ...counters,
    completed_at: null,
    pid: process.pid,
    started_at: startedAt,
    status: "running",
    total: candidates.length,
  });
  console.log(
    `Contact crawl started: ${candidates.length} websites, concurrency ${options.concurrency}`,
  );

  async function worker() {
    while (!stopRequested) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= candidates.length) {
        return;
      }
      const candidate = candidates[index];
      markRunning(contactsDatabase, candidate);
      let result;
      try {
        result = await crawlWebsite(candidate, options);
      } catch (error) {
        result = {
          contactUrls: [],
          emails: [],
          error: error.message,
          lastHttpStatus: null,
          pagesScanned: 0,
          phones: [],
          sourceUrls: [],
          status: "error",
        };
      }
      saveResult(contactsDatabase, candidate, result);
      counters.processed += 1;
      if (result.status === "found") {
        counters.found += 1;
      } else if (result.status === "not_found") {
        counters.not_found += 1;
      } else if (result.status === "blocked") {
        counters.blocked += 1;
      } else {
        counters.errors += 1;
      }
      setRunState(contactsDatabase, counters);
      if (counters.processed % 25 === 0 || counters.processed === candidates.length) {
        console.log(
          `Processed ${counters.processed}/${candidates.length}; found ${counters.found}`,
        );
      }
    }
  }

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(options.concurrency, candidates.length || 1) },
        () => worker(),
      ),
    );
    setRunState(contactsDatabase, {
      ...counters,
      completed_at: timestamp(),
      pid: null,
      status: stopRequested ? "stopped" : "completed",
    });
  } finally {
    sourceDatabase.close();
    contactsDatabase.close();
    await lockHandle.close();
    await rm(DEFAULT_LOCK_PATH, { force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await runContactCrawler(options);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
