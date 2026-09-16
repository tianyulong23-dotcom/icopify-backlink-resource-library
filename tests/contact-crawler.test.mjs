import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractContactData,
  initializeContactsDatabase,
  robotsAllows,
} from "../crawl_contacts.mjs";
import { getContactCrawlStatus, queryPublishers } from "../server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DATABASE = path.join(
  ROOT,
  "data",
  "icopify-39023",
  "publishers.sqlite",
);

let sourceDatabase;
let contactsDatabase;

before(() => {
  sourceDatabase = new DatabaseSync(SOURCE_DATABASE, { readOnly: true });
  contactsDatabase = new DatabaseSync(":memory:");
  initializeContactsDatabase(contactsDatabase);
});

after(() => {
  contactsDatabase.close();
  sourceDatabase.close();
});

test("extracts public emails, phones, contact forms, and same-site contact links", () => {
  const result = extractContactData(
    `
      <html>
        <body>
          <a href="mailto:editor@example.org?subject=Hello">Email editor</a>
          <a href="tel:+1 (212) 555-0182">Call</a>
          <a href="/contact-us">Contact us</a>
          <a href="https://outside.example/contact">External</a>
          <img src="/logo@2x.png">
          <form action="/message"><input type="email"><textarea></textarea></form>
        </body>
      </html>
    `,
    "https://news.example.org/about",
    "example.org",
  );

  assert.deepEqual(result.emails, ["editor@example.org"]);
  assert.deepEqual(result.phones, ["+1 (212) 555-0182"]);
  assert.equal(result.hasContactForm, true);
  assert.deepEqual(result.contactLinks, ["https://news.example.org/contact-us"]);
  assert.deepEqual(result.directContactLinks, [
    "https://news.example.org/contact-us",
  ]);
});

test("does not treat an article containing about as a contact page", () => {
  const result = extractContactData(
    `
      <a href="/common-misconceptions-about-patents">
        Common misconceptions about patents
      </a>
      <a href="/about-us">About us</a>
    `,
    "https://publisher.example/",
    "publisher.example",
  );

  assert.deepEqual(result.contactLinks, ["https://publisher.example/about-us"]);
  assert.deepEqual(result.directContactLinks, []);
});

test("ignores comment emails and nested links beneath a contact page", () => {
  const result = extractContactData(
    `
      <main>
        <p>Reach us at editorial@publisher.example</p>
        <a href="partner.example">Partner</a>
        <form class="comment-form" action="/comments">
          <textarea></textarea>
        </form>
        <section id="comments">
          visitor.personal@gmail.com
        </section>
      </main>
      <footer>support@publisher.example</footer>
    `,
    "https://publisher.example/contact-us/",
    "publisher.example",
  );

  assert.deepEqual(result.emails, [
    "editorial@publisher.example",
    "support@publisher.example",
  ]);
  assert.deepEqual(result.contactLinks, []);
  assert.equal(result.hasContactForm, false);
});

test("respects longest matching robots allow and disallow rules", () => {
  const robots = `
    User-agent: *
    Disallow: /private
    Allow: /private/contact
  `;

  assert.equal(robotsAllows(robots, "https://example.com/public"), true);
  assert.equal(robotsAllows(robots, "https://example.com/private/report"), false);
  assert.equal(robotsAllows(robots, "https://example.com/private/contact"), true);
});

test("merges contact enrichment without removing the publisher", () => {
  const now = new Date().toISOString();
  contactsDatabase
    .prepare(
      `
        INSERT INTO website_contacts (
          domain, website_url, status, emails_json, phones_json,
          contact_urls_json, source_urls_json, pages_scanned, updated_at
        ) VALUES (
          $domain, $url, 'found', $emails, '[]', $contactUrls, $sourceUrls, 2, $now
        )
      `,
    )
    .run({
      $contactUrls: JSON.stringify(["https://beforeitsnews.com/contact"]),
      $domain: "beforeitsnews.com",
      $emails: JSON.stringify(["editor@beforeitsnews.com"]),
      $now: now,
      $sourceUrls: JSON.stringify(["https://beforeitsnews.com/"]),
      $url: "https://beforeitsnews.com/",
    });

  const result = queryPublishers(
    sourceDatabase,
    new URLSearchParams({ q: "beforeitsnews.com" }),
    contactsDatabase,
  );
  const publisher = result.items.find((item) => item.domain === "beforeitsnews.com");

  assert.ok(publisher);
  assert.equal(publisher.contact.status, "found");
  assert.deepEqual(publisher.contact.emails, ["editor@beforeitsnews.com"]);
  assert.deepEqual(publisher.contact.contact_urls, [
    "https://beforeitsnews.com/contact",
  ]);

  const withEmail = queryPublishers(
    sourceDatabase,
    new URLSearchParams({ emailStatus: "has" }),
    contactsDatabase,
  );
  assert.equal(withEmail.total, 1);
  assert.equal(withEmail.items[0].domain, "beforeitsnews.com");
  assert.deepEqual(withEmail.items[0].contact.emails, [
    "editor@beforeitsnews.com",
  ]);

  const withoutEmail = queryPublishers(
    sourceDatabase,
    new URLSearchParams({ emailStatus: "none" }),
    contactsDatabase,
  );
  const publisherCount = sourceDatabase
    .prepare("SELECT COUNT(*) AS count FROM publishers")
    .get().count;
  assert.equal(withoutEmail.total, publisherCount - 1);
  assert.ok(
    withoutEmail.items.every((item) => item.contact.emails.length === 0),
  );
});

test("reports aggregate crawl progress", () => {
  const publisherCount = sourceDatabase
    .prepare("SELECT COUNT(*) AS count FROM publishers")
    .get().count;
  const status = getContactCrawlStatus(contactsDatabase, publisherCount);

  assert.equal(status.total, publisherCount);
  assert.equal(status.processed, 1);
  assert.equal(status.found, 1);
});
