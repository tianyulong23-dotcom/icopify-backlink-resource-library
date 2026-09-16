import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createLibraryServer,
  getFilterOptions,
  queryPublishers,
} from "../server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_PATH = path.join(
  ROOT,
  "data",
  "icopify-39023",
  "publishers.sqlite",
);
const STATIC_DIR = path.join(ROOT, "web");

let database;

before(() => {
  database = new DatabaseSync(DATABASE_PATH, { readOnly: true });
});

after(() => {
  database.close();
});

describe("publisher queries", () => {
  test("returns 25 rows and roughly 2,000 pages by default", () => {
    const result = queryPublishers(database, new URLSearchParams());

    assert.equal(result.items.length, 25);
    assert.equal(result.pageSize, 25);
    assert.equal(result.total, 49_742);
    assert.equal(result.totalPages, 1_990);
  });

  test("searches a known domain and preserves marked metrics", () => {
    const result = queryPublishers(
      database,
      new URLSearchParams({ q: "beforeitsnews.com" }),
    );

    assert.ok(result.items.length >= 1);
    const publisher = result.items.find(
      (item) => item.domain === "beforeitsnews.com",
    );
    assert.ok(publisher);
    assert.deepEqual(publisher.categories, ["Health", "News and Media"]);
    assert.equal(publisher.monthly_traffic, 1_069_226);
    assert.equal(publisher.ahrefs_dr, 74);
    assert.equal(publisher.moz_da, 77);
    assert.equal(publisher.language, "English");
  });

  test("applies combined filters and clamps an oversized page", () => {
    const result = queryPublishers(
      database,
      new URLSearchParams({
        language: "English",
        minDr: "80",
        minDa: "80",
        page: "999999",
        sort: "traffic_desc",
      }),
    );

    assert.equal(result.page, result.totalPages);
    assert.ok(result.total > 0);
    assert.ok(
      result.items.every(
        (item) =>
          item.language === "English" &&
          item.ahrefs_dr >= 80 &&
          item.moz_da >= 80,
      ),
    );
  });

  test("exposes an imported thread resource without invented price or contact data", () => {
    const result = queryPublishers(
      database,
      new URLSearchParams({ q: "4shared.com" }),
    );
    const publisher = result.items.find((item) => item.domain === "4shared.com");

    assert.ok(publisher);
    assert.deepEqual(publisher.categories, ["Profile"]);
    assert.equal(publisher.monthly_traffic, 5_204);
    assert.equal(publisher.ahrefs_dr, null);
    assert.equal(publisher.moz_da, 0);
    assert.equal(publisher.price, null);
    assert.equal(publisher.resource_type, "free");
    assert.equal(
      publisher.source_thread_id,
      "019efc68-33e8-73c2-93c6-902b33530fc1",
    );
    assert.equal(publisher.contact.status, "pending");
  });

  test("provides category, language, and snapshot metadata", () => {
    const options = getFilterOptions(database, DATABASE_PATH);

    assert.equal(options.stats.uniqueRows, 49_742);
    assert.equal(options.stats.totalPages, 1_990);
    assert.ok(options.languages.some((item) => item.value === "English"));
    assert.ok(options.categories.some((item) => item.value === "Health"));
    assert.ok(options.linkTypes.some((item) => item.value === "DoFollow"));
  });
});

test("serves the frontend and JSON API", async () => {
  const server = createLibraryServer({
    databasePath: DATABASE_PATH,
    staticDir: STATIC_DIR,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  try {
    const [pageResponse, apiResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`),
      fetch(`http://127.0.0.1:${port}/api/publishers?page=1990`),
    ]);
    const page = await pageResponse.text();
    const api = await apiResponse.json();

    assert.equal(pageResponse.status, 200);
    assert.match(page, /外链资源库/);
    assert.match(page, /参考价格/);
    assert.match(page, /联系方式/);
    assert.equal(apiResponse.status, 200);
    assert.equal(api.page, 1_990);
    assert.equal(api.items.length, 17);
  } finally {
    server.close();
    await once(server, "close");
  }
});
