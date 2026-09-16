import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATABASE = path.join(
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
const DEFAULT_STATIC_DIR = path.join(PROJECT_ROOT, "web");
const PAGE_SIZE = 25;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const SORTS = {
  source_asc:
    "p.source_page ASC, p.website COLLATE NOCASE ASC, p.website_id ASC",
  traffic_desc:
    "p.monthly_traffic IS NULL, p.monthly_traffic DESC, p.website COLLATE NOCASE ASC",
  dr_desc:
    "p.ahrefs_dr IS NULL, p.ahrefs_dr DESC, p.monthly_traffic DESC",
  da_desc: "p.moz_da IS NULL, p.moz_da DESC, p.monthly_traffic DESC",
  price_asc: "p.price IS NULL, p.price ASC, p.monthly_traffic DESC",
  price_desc: "p.price IS NULL, p.price DESC, p.monthly_traffic DESC",
};

const importMetadataAvailability = new WeakMap();

function hasImportMetadata(database) {
  if (!importMetadataAvailability.has(database)) {
    const table = database
      .prepare(
        `
          SELECT 1
          FROM sqlite_master
          WHERE type = 'table' AND name = 'publisher_import_metadata'
        `,
      )
      .get();
    importMetadataAvailability.set(database, Boolean(table));
  }
  return importMetadataAvailability.get(database);
}

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function parseCategories(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getContactsByDomain(database, domains) {
  if (!database || !domains.length) {
    return new Map();
  }
  const parameters = {};
  const placeholders = domains.map((domain, index) => {
    const key = `$domain${index}`;
    parameters[key] = domain;
    return key;
  });
  try {
    return new Map(
      database
        .prepare(
          `
            SELECT
              domain,
              status,
              emails_json,
              phones_json,
              contact_urls_json,
              pages_scanned,
              last_error,
              updated_at
            FROM website_contacts
            WHERE domain IN (${placeholders.join(", ")})
          `,
        )
        .all(parameters)
        .map((row) => [
          row.domain,
          {
            contact_urls: parseJsonArray(row.contact_urls_json),
            emails: parseJsonArray(row.emails_json),
            error: row.last_error,
            pages_scanned: row.pages_scanned,
            phones: parseJsonArray(row.phones_json),
            status: row.status,
            updated_at: row.updated_at,
          },
        ]),
    );
  } catch {
    return new Map();
  }
}

function getDomainsWithEmail(database) {
  if (!database) {
    return [];
  }
  try {
    return database
      .prepare(
        `
          SELECT domain
          FROM website_contacts
          WHERE domain IS NOT NULL
            AND json_valid(emails_json)
            AND json_array_length(emails_json) > 0
        `,
      )
      .all()
      .map((row) => row.domain);
  } catch {
    return [];
  }
}

function buildWhere(searchParams, contactsDatabase = null) {
  const clauses = [];
  const parameters = {};
  const query = (searchParams.get("q") || "").trim().slice(0, 200);
  const language = (searchParams.get("language") || "").trim();
  const category = (searchParams.get("category") || "").trim();
  const linkType = (searchParams.get("linkType") || "").trim();
  const emailStatus = ["has", "none"].includes(searchParams.get("emailStatus"))
    ? searchParams.get("emailStatus")
    : "";
  const minTraffic = parseOptionalNumber(searchParams.get("minTraffic"));
  const minDr = parseOptionalNumber(searchParams.get("minDr"));
  const minDa = parseOptionalNumber(searchParams.get("minDa"));
  const maxPrice = parseOptionalNumber(searchParams.get("maxPrice"));

  if (query) {
    clauses.push(`(
      p.website LIKE $query ESCAPE '\\' COLLATE NOCASE
      OR p.domain LIKE $query ESCAPE '\\' COLLATE NOCASE
      OR p.categories_json LIKE $query ESCAPE '\\' COLLATE NOCASE
    )`);
    parameters.$query = `%${escapeLike(query)}%`;
  }
  if (language) {
    clauses.push("p.language = $language");
    parameters.$language = language;
  }
  if (category) {
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(p.categories_json) WHERE value = $category)",
    );
    parameters.$category = category;
  }
  if (linkType) {
    clauses.push("p.link_type = $linkType");
    parameters.$linkType = linkType;
  }
  if (emailStatus) {
    const emailDomains = getDomainsWithEmail(contactsDatabase);
    if (emailStatus === "has") {
      if (emailDomains.length) {
        clauses.push(
          "p.domain IN (SELECT value FROM json_each($emailDomains))",
        );
        parameters.$emailDomains = JSON.stringify(emailDomains);
      } else {
        clauses.push("0");
      }
    } else if (emailDomains.length) {
      clauses.push(
        "p.domain NOT IN (SELECT value FROM json_each($emailDomains))",
      );
      parameters.$emailDomains = JSON.stringify(emailDomains);
    }
  }
  if (minTraffic !== null) {
    clauses.push("p.monthly_traffic >= $minTraffic");
    parameters.$minTraffic = minTraffic;
  }
  if (minDr !== null) {
    clauses.push("p.ahrefs_dr >= $minDr");
    parameters.$minDr = minDr;
  }
  if (minDa !== null) {
    clauses.push("p.moz_da >= $minDa");
    parameters.$minDa = minDa;
  }
  if (maxPrice !== null) {
    clauses.push("p.price <= $maxPrice");
    parameters.$maxPrice = maxPrice;
  }

  return {
    emailStatus,
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    parameters,
  };
}

export function queryPublishers(database, searchParams, contactsDatabase = null) {
  const requestedPage = parsePositiveInteger(searchParams.get("page"), 1);
  const sort = SORTS[searchParams.get("sort")] ? searchParams.get("sort") : "source_asc";
  const {
    emailStatus,
    sql: whereSql,
    parameters,
  } = buildWhere(searchParams, contactsDatabase);
  const total = database
    .prepare(`SELECT COUNT(*) AS count FROM publishers p ${whereSql}`)
    .get(parameters).count;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * PAGE_SIZE;
  const includeImportMetadata = hasImportMetadata(database);
  const metadataColumns = includeImportMetadata
    ? `
          m.resource_type,
          m.source_document,
          m.source_thread_id,`
    : `
          NULL AS resource_type,
          NULL AS source_document,
          NULL AS source_thread_id,`;
  const metadataJoin = includeImportMetadata
    ? "LEFT JOIN publisher_import_metadata m ON m.domain = p.domain"
    : "";

  const rows = database
    .prepare(
      `
        SELECT
          p.rowid AS row_id,
          p.website_id,
          p.website,
          p.domain,
          p.website_url,
          p.categories_json,
          p.monthly_traffic,
          p.ahrefs_dr,
          p.moz_da,
          p.language,
          p.price,
          p.currency,
          p.max_links,
          p.link_type,
          p.turnaround,
          p.added_on,
          p.source_page,
          ${metadataColumns}
          p.rowid AS publisher_row_id
        FROM publishers p
        ${metadataJoin}
        ${whereSql}
        ORDER BY ${SORTS[sort]}
        LIMIT $limit OFFSET $offset
      `,
    )
    .all({
      ...parameters,
      $limit: PAGE_SIZE,
      $offset: offset,
    })
    .map(({ categories_json: categoriesJson, publisher_row_id: _, ...row }) => ({
      ...row,
      categories: parseCategories(categoriesJson),
    }));
  const contactsByDomain = getContactsByDomain(
    contactsDatabase,
    rows.map((row) => row.domain).filter(Boolean),
  );

  return {
    items: rows.map((row) => ({
      ...row,
      contact: contactsByDomain.get(row.domain) || {
        contact_urls: [],
        emails: [],
        error: null,
        pages_scanned: 0,
        phones: [],
        status: "pending",
        updated_at: null,
      },
    })),
    page,
    pageSize: PAGE_SIZE,
    total,
    totalPages,
    sort,
    emailStatus,
  };
}

export function getContactCrawlStatus(database, totalWebsites) {
  if (!database) {
    return {
      blocked: 0,
      errors: 0,
      found: 0,
      notFound: 0,
      processed: 0,
      running: 0,
      status: "not_started",
      total: totalWebsites,
      updatedAt: null,
    };
  }
  try {
    const counts = Object.fromEntries(
      database
        .prepare(
          `
            SELECT status, COUNT(*) AS count
            FROM website_contacts
            GROUP BY status
          `,
        )
        .all()
        .map((row) => [row.status, row.count]),
    );
    const run = database
      .prepare("SELECT * FROM contact_crawl_state WHERE id = 1")
      .get();
    const found = counts.found || 0;
    const notFound = counts.not_found || 0;
    const blocked = counts.blocked || 0;
    const errors = counts.error || 0;
    return {
      blocked,
      errors,
      found,
      notFound,
      processed: found + notFound + blocked + errors,
      running: counts.running || 0,
      status: run?.status || "idle",
      total: totalWebsites,
      updatedAt: run?.updated_at || null,
    };
  } catch {
    return {
      blocked: 0,
      errors: 0,
      found: 0,
      notFound: 0,
      processed: 0,
      running: 0,
      status: "not_started",
      total: totalWebsites,
      updatedAt: null,
    };
  }
}

export function getFilterOptions(database, databasePath = DEFAULT_DATABASE) {
  const languages = database
    .prepare(
      `
        SELECT language AS value, COUNT(*) AS count
        FROM publishers
        WHERE language IS NOT NULL AND language <> ''
        GROUP BY language
        ORDER BY count DESC, language COLLATE NOCASE ASC
      `,
    )
    .all();
  const categories = database
    .prepare(
      `
        SELECT category.value AS value, COUNT(*) AS count
        FROM publishers p, json_each(p.categories_json) category
        GROUP BY category.value
        ORDER BY count DESC, category.value COLLATE NOCASE ASC
      `,
    )
    .all();
  const linkTypes = database
    .prepare(
      `
        SELECT link_type AS value, COUNT(*) AS count
        FROM publishers
        WHERE link_type IS NOT NULL AND link_type <> ''
        GROUP BY link_type
        ORDER BY count DESC, link_type COLLATE NOCASE ASC
      `,
    )
    .all();
  const stats = database
    .prepare(
      `
        SELECT
          COUNT(*) AS uniqueRows,
          COUNT(DISTINCT language) AS languageCount,
          MAX(monthly_traffic) AS maxTraffic,
          MAX(ahrefs_dr) AS maxDr,
          MAX(moz_da) AS maxDa
        FROM publishers
      `,
    )
    .get();

  const summaryPath = path.join(path.dirname(databasePath), "summary.json");
  try {
    const sourceSummary = JSON.parse(readFileSync(summaryPath, "utf8"));
    stats.rawRows = sourceSummary.raw_rows;
    stats.sourcePages = sourceSummary.source_pages;
    stats.duplicatesRemoved = sourceSummary.duplicates_removed;
  } catch {
    stats.rawRows = stats.uniqueRows;
    stats.sourcePages = null;
    stats.duplicatesRemoved = null;
  }

  stats.updatedAt = statSync(databasePath).mtime.toISOString();
  stats.pageSize = PAGE_SIZE;
  stats.totalPages = Math.ceil(stats.uniqueRows / PAGE_SIZE);

  return { languages, categories, linkTypes, stats };
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": MIME_TYPES[".json"],
  });
  response.end(body);
}

function serveStatic(response, requestPath, staticDir) {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.resolve(staticDir, relativePath);
  const allowedRoot = `${path.resolve(staticDir)}${path.sep}`;

  if (!filePath.startsWith(allowedRoot)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  let fileStat;
  try {
    fileStat = statSync(filePath);
  } catch {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  if (!fileStat.isFile()) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Length": fileStat.size,
    "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}

export function createLibraryServer({
  contactsDatabasePath = DEFAULT_CONTACTS_DATABASE,
  databasePath = DEFAULT_DATABASE,
  staticDir = DEFAULT_STATIC_DIR,
} = {}) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const filterOptions = getFilterOptions(database, databasePath);
  let contactsDatabase = null;
  const getContactsDatabase = () => {
    if (!contactsDatabase && existsSync(contactsDatabasePath)) {
      contactsDatabase = new DatabaseSync(contactsDatabasePath, { readOnly: true });
    }
    return contactsDatabase;
  };
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (requestUrl.pathname === "/api/publishers") {
      try {
        sendJson(
          response,
          200,
          queryPublishers(database, requestUrl.searchParams, getContactsDatabase()),
        );
      } catch (error) {
        console.error(error);
        sendJson(response, 500, { error: "Unable to query publishers" });
      }
      return;
    }

    if (requestUrl.pathname === "/api/filters") {
      sendJson(response, 200, filterOptions);
      return;
    }

    if (requestUrl.pathname === "/api/contact-crawl") {
      sendJson(
        response,
        200,
        getContactCrawlStatus(
          getContactsDatabase(),
          filterOptions.stats.uniqueRows,
        ),
      );
      return;
    }

    if (requestUrl.pathname === "/favicon.ico") {
      response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      response.end();
      return;
    }

    let requestPath;
    try {
      requestPath = decodeURIComponent(requestUrl.pathname);
    } catch {
      sendJson(response, 400, { error: "Invalid path" });
      return;
    }
    serveStatic(response, requestPath, staticDir);
  });

  server.once("close", () => {
    contactsDatabase?.close();
    database.close();
  });
  return server;
}

async function main() {
  const host = process.env.HOST || "127.0.0.1";
  const port = parsePositiveInteger(process.env.PORT, 4188, 65535);
  const server = createLibraryServer();
  server.listen(port, host, () => {
    console.log(`外链资源库已启动: http://${host}:${port}`);
  });

  const shutdown = () => server.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main();
}
