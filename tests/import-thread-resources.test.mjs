import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import {
  importResources,
  normalizeDomain,
  parseMetric,
} from "../import_thread_resources.mjs";

let databasePath;
let sourcePath;
let tempDirectory;

before(async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "thread-resource-import-"));
  databasePath = path.join(tempDirectory, "publishers.sqlite");
  sourcePath = path.join(tempDirectory, "resources.json");

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE publishers (
      website_id TEXT,
      website TEXT NOT NULL,
      domain TEXT,
      website_url TEXT,
      categories_json TEXT NOT NULL,
      monthly_traffic INTEGER,
      ahrefs_dr INTEGER,
      moz_da INTEGER,
      language TEXT,
      price REAL,
      currency TEXT,
      max_links INTEGER,
      link_type TEXT,
      turnaround TEXT,
      added_on TEXT,
      source_page INTEGER
    );
    CREATE UNIQUE INDEX publishers_domain_idx ON publishers(domain)
      WHERE domain IS NOT NULL AND domain <> '';
    INSERT INTO publishers (
      website, domain, categories_json, source_page
    ) VALUES ('Existing', 'existing.example', '[]', 7);
  `);
  database.close();

  await writeFile(
    sourcePath,
    JSON.stringify([
      {
        backlinkType: "Dofollow",
        category: "Profile",
        countryLanguage: "Global / English",
        domain: "www.new.example",
        domainAuthority: 61,
        key: "free-new-example",
        monthlyOrganicTraffic: "1.7K",
        resourceCategories: ["Profile"],
        resourceType: "free",
        sourceDocument: "Source document",
        url: "https://www.new.example/",
        websiteName: "New Example",
      },
      {
        domain: "NEW.EXAMPLE",
        key: "duplicate-new-example",
        resourceType: "free",
        url: "https://new.example/duplicate",
        websiteName: "Duplicate",
      },
      {
        domain: "existing.example",
        key: "existing-example",
        resourceType: "paid",
        url: "https://existing.example/",
        websiteName: "Existing source",
      },
    ]),
    "utf8",
  );
});

after(async () => {
  const resolved = path.resolve(tempDirectory);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
  await rm(resolved, { force: true, recursive: true });
});

test("normalizes domains and compact metrics", () => {
  assert.equal(normalizeDomain("HTTPS://WWW.Example.COM/path"), "example.com");
  assert.equal(parseMetric("1.7M"), 1_700_000);
  assert.equal(parseMetric("2.5K"), 2_500);
  assert.equal(parseMetric("High"), null);
});

test("dry-runs, imports once, and preserves source metadata", async () => {
  const dryRun = importResources({
    databasePath,
    dryRun: true,
    sourcePath,
  });
  assert.equal(dryRun.sourceRows, 3);
  assert.equal(dryRun.sourceDuplicates, 1);
  assert.equal(dryRun.existingOverlap, 1);
  assert.equal(dryRun.toInsert, 1);
  assert.equal(dryRun.inserted, 0);

  const first = importResources({ databasePath, sourcePath });
  assert.equal(first.inserted, 1);
  assert.equal(first.afterCount, 2);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const imported = database
    .prepare(
      `
        SELECT p.*, m.resource_type, m.source_document
        FROM publishers p
        JOIN publisher_import_metadata m ON m.domain = p.domain
        WHERE p.domain = 'new.example'
      `,
    )
    .get();
  database.close();

  assert.equal(imported.monthly_traffic, 1_700);
  assert.equal(imported.ahrefs_dr, null);
  assert.equal(imported.moz_da, 61);
  assert.equal(imported.price, null);
  assert.equal(imported.link_type, "DoFollow");
  assert.equal(imported.resource_type, "free");
  assert.equal(imported.source_document, "Source document");

  const second = importResources({ databasePath, sourcePath });
  assert.equal(second.inserted, 0);
  assert.equal(second.afterCount, 2);

  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  assert.equal(source.length, 3);
});
