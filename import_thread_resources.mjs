import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const DEFAULT_DATABASE = path.resolve(
  "data",
  "icopify-39023",
  "publishers.sqlite",
);
const DEFAULT_THREAD_ID = "019efc68-33e8-73c2-93c6-902b33530fc1";
const PAGE_SIZE = 25;

function text(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const result = String(value).trim();
  return result || null;
}

export function normalizeDomain(value) {
  const raw = text(value);
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return raw
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .replace(/^www\./, "")
      .replace(/\.$/, "");
  }
}

export function parseMetric(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  const raw = text(value)?.replaceAll(",", "");
  if (!raw) {
    return null;
  }
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmb])?$/i);
  if (!match) {
    return null;
  }
  const multiplier = {
    b: 1_000_000_000,
    k: 1_000,
    m: 1_000_000,
  }[match[2]?.toLowerCase()] || 1;
  return Math.round(Number(match[1]) * multiplier);
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const item = text(value);
    const key = item?.toLowerCase();
    if (item && !seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function categoriesFor(resource) {
  const categories = Array.isArray(resource.resourceCategories)
    ? resource.resourceCategories
    : [];
  return uniqueStrings([
    ...categories,
    resource.resourceCategory,
    resource.category,
    resource.resourceGroup,
  ]);
}

function normalizeLinkType(value) {
  const raw = text(value);
  if (!raw) {
    return null;
  }
  if (/^dofollow$/i.test(raw)) {
    return "DoFollow";
  }
  if (/^nofollow$/i.test(raw)) {
    return "NoFollow";
  }
  return raw;
}

function safeUrl(value) {
  const raw = text(value);
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function loadSource(sourcePath) {
  const sourceHash = sha256(sourcePath);
  const manifestPath = path.join(path.dirname(sourcePath), "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const expectedHash = manifest.files?.[path.basename(sourcePath)]?.sha256;
    if (expectedHash && expectedHash !== sourceHash) {
      throw new Error("resources.json checksum does not match manifest.json");
    }
  }

  const resources = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (!Array.isArray(resources)) {
    throw new Error("resources.json must contain an array");
  }
  return { resources, sourceHash };
}

function deduplicateSource(resources) {
  const byDomain = new Map();
  let invalid = 0;
  let duplicates = 0;
  for (const resource of resources) {
    const domain = normalizeDomain(
      resource.domain || resource.url || resource.websiteName,
    );
    if (!domain) {
      invalid += 1;
      continue;
    }
    if (byDomain.has(domain)) {
      duplicates += 1;
      continue;
    }
    byDomain.set(domain, resource);
  }
  return { byDomain, duplicates, invalid };
}

function mapPublisher(resource, domain, threadId, sourcePage) {
  const traffic =
    parseMetric(resource.monthlyOrganicTraffic) ??
    parseMetric(resource.dataforseoMetrics?.traffic);
  const authority =
    parseMetric(resource.domainAuthority) ??
    parseMetric(resource.dataforseoMetrics?.authority);
  const resourceKey = text(resource.key) || domain;
  return {
    added_on: text(resource.createdAt),
    ahrefs_dr: null,
    categories_json: JSON.stringify(categoriesFor(resource)),
    currency: null,
    domain,
    language: text(resource.countryLanguage),
    link_type: normalizeLinkType(resource.backlinkType),
    max_links: null,
    monthly_traffic: traffic,
    moz_da: authority,
    price: null,
    source_page: sourcePage,
    turnaround: null,
    website: text(resource.websiteName) || domain,
    website_id: `thread:${threadId}:${resourceKey}`,
    website_url: safeUrl(resource.url),
  };
}

function ensureMetadataTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS publisher_import_metadata (
      domain TEXT PRIMARY KEY,
      source_thread_id TEXT NOT NULL,
      source_bundle TEXT NOT NULL,
      source_bundle_hash TEXT NOT NULL,
      resource_key TEXT,
      resource_type TEXT,
      source_document TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS publisher_import_metadata_type_idx
      ON publisher_import_metadata(resource_type);
  `);
}

function summarySnapshot(database) {
  const stats = database
    .prepare(
      `
        SELECT
          COUNT(*) AS uniqueRows,
          MAX(source_page) AS sourcePages
        FROM publishers
      `,
    )
    .get();
  const missing = database
    .prepare(
      `
        SELECT
          SUM(CASE WHEN website IS NULL OR website = '' THEN 1 ELSE 0 END) AS website,
          SUM(CASE WHEN categories_json = '[]' THEN 1 ELSE 0 END) AS categories,
          SUM(CASE WHEN monthly_traffic IS NULL THEN 1 ELSE 0 END) AS monthly_traffic,
          SUM(CASE WHEN ahrefs_dr IS NULL THEN 1 ELSE 0 END) AS ahrefs_dr,
          SUM(CASE WHEN moz_da IS NULL THEN 1 ELSE 0 END) AS moz_da,
          SUM(CASE WHEN language IS NULL OR language = '' THEN 1 ELSE 0 END) AS language,
          SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS price
        FROM publishers
      `,
    )
    .get();
  const languages = database
    .prepare(
      `
        SELECT COALESCE(NULLIF(language, ''), 'Unknown') AS language, COUNT(*) AS count
        FROM publishers
        GROUP BY COALESCE(NULLIF(language, ''), 'Unknown')
        ORDER BY count DESC, language COLLATE NOCASE
        LIMIT 20
      `,
    )
    .all();
  return {
    missing,
    sourcePages: stats.sourcePages,
    topLanguages: Object.fromEntries(
      languages.map((item) => [item.language, item.count]),
    ),
    uniqueRows: stats.uniqueRows,
  };
}

function updateSummary({
  database,
  importReport,
  sourceHash,
  summaryPath,
  threadId,
}) {
  if (!summaryPath || !existsSync(summaryPath)) {
    return;
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const imports = Array.isArray(summary.imports) ? summary.imports : [];
  const alreadyRecorded = imports.some(
    (item) =>
      item.source_thread_id === threadId &&
      item.source_bundle_hash === sourceHash,
  );
  const snapshot = summarySnapshot(database);
  const rawRows =
    Number(summary.raw_rows || importReport.beforeCount) +
    (alreadyRecorded ? 0 : importReport.sourceRows);

  summary.raw_rows = rawRows;
  summary.unique_rows = snapshot.uniqueRows;
  summary.duplicates_removed = rawRows - snapshot.uniqueRows;
  summary.source_pages = snapshot.sourcePages;
  summary.missing_values = snapshot.missing;
  summary.top_languages = snapshot.topLanguages;
  if (!alreadyRecorded) {
    summary.imports = [
      ...imports,
      {
        imported_at: importReport.importedAt,
        inserted: importReport.inserted,
        skipped_existing: importReport.existingOverlap,
        source_bundle: importReport.sourceBundle,
        source_bundle_hash: sourceHash,
        source_rows: importReport.sourceRows,
        source_thread_id: threadId,
      },
    ];
  }
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

export function importResources({
  databasePath = DEFAULT_DATABASE,
  dryRun = false,
  sourcePath,
  summaryPath = path.join(path.dirname(databasePath), "summary.json"),
  threadId = DEFAULT_THREAD_ID,
}) {
  if (!sourcePath) {
    throw new Error("sourcePath is required");
  }
  const resolvedDatabase = path.resolve(databasePath);
  const resolvedSource = path.resolve(sourcePath);
  const { resources, sourceHash } = loadSource(resolvedSource);
  const { byDomain, duplicates, invalid } = deduplicateSource(resources);
  const database = new DatabaseSync(resolvedDatabase);

  try {
    const existingDomains = new Set(
      database
        .prepare(
          "SELECT domain FROM publishers WHERE domain IS NOT NULL AND domain <> ''",
        )
        .all()
        .map((row) => normalizeDomain(row.domain)),
    );
    const additions = [...byDomain.entries()].filter(
      ([domain]) => !existingDomains.has(domain),
    );
    const beforeCount = database
      .prepare("SELECT COUNT(*) AS count FROM publishers")
      .get().count;
    const maxSourcePage =
      database.prepare("SELECT MAX(source_page) AS page FROM publishers").get()
        .page || 0;
    const importedAt = new Date().toISOString();
    const report = {
      afterCount: beforeCount,
      beforeCount,
      database: resolvedDatabase,
      dryRun,
      existingOverlap: byDomain.size - additions.length,
      importedAt,
      inserted: 0,
      invalid,
      sourceBundle: path.basename(path.dirname(resolvedSource)),
      sourceDuplicates: duplicates,
      sourceRows: resources.length,
      sourceUniqueDomains: byDomain.size,
      toInsert: additions.length,
    };

    if (dryRun) {
      return report;
    }

    const timestamp = importedAt.replaceAll(":", "").replaceAll(".", "");
    const backupPath = `${resolvedDatabase}.before-thread-import-${timestamp}.bak`;
    copyFileSync(resolvedDatabase, backupPath);
    report.backup = backupPath;

    database.exec("BEGIN IMMEDIATE");
    try {
      ensureMetadataTable(database);
      const insertPublisher = database.prepare(`
        INSERT OR IGNORE INTO publishers (
          website_id, website, domain, website_url, categories_json,
          monthly_traffic, ahrefs_dr, moz_da, language, price, currency,
          max_links, link_type, turnaround, added_on, source_page
        ) VALUES (
          $website_id, $website, $domain, $website_url, $categories_json,
          $monthly_traffic, $ahrefs_dr, $moz_da, $language, $price, $currency,
          $max_links, $link_type, $turnaround, $added_on, $source_page
        )
      `);
      const insertMetadata = database.prepare(`
        INSERT INTO publisher_import_metadata (
          domain, source_thread_id, source_bundle, source_bundle_hash,
          resource_key, resource_type, source_document, raw_json, imported_at
        ) VALUES (
          $domain, $source_thread_id, $source_bundle, $source_bundle_hash,
          $resource_key, $resource_type, $source_document, $raw_json, $imported_at
        )
      `);

      additions.forEach(([domain, resource], index) => {
        const sourcePage = maxSourcePage + 1 + Math.floor(index / PAGE_SIZE);
        const result = insertPublisher.run(
          mapPublisher(resource, domain, threadId, sourcePage),
        );
        if (result.changes !== 1) {
          return;
        }
        insertMetadata.run({
          $domain: domain,
          $imported_at: importedAt,
          $raw_json: JSON.stringify(resource),
          $resource_key: text(resource.key),
          $resource_type: text(resource.resourceType),
          $source_bundle: report.sourceBundle,
          $source_bundle_hash: sourceHash,
          $source_document: text(resource.sourceDocument),
          $source_thread_id: threadId,
        });
        report.inserted += 1;
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    report.afterCount = database
      .prepare("SELECT COUNT(*) AS count FROM publishers")
      .get().count;
    updateSummary({
      database,
      importReport: report,
      sourceHash,
      summaryPath,
      threadId,
    });
    return report;
  } finally {
    database.close();
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--source") {
      options.sourcePath = argv[++index];
    } else if (argument === "--database") {
      options.databasePath = argv[++index];
    } else if (argument === "--thread-id") {
      options.threadId = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = importResources(options);
  console.log(JSON.stringify(report, null, 2));
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  main();
}
