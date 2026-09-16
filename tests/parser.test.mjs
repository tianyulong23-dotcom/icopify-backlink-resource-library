import assert from "node:assert/strict";
import test from "node:test";

import { parsePublishersPage } from "../scrape_icopify.mjs";

test("parsePublishersPage extracts the resource-library fields", () => {
  const html = `
    <table>
      <tbody>
        <tr>
          <td>
            <a href="https://example.com" data-content="Added on: <strong>27 Aug 2026</strong>">
              www.example.com
            </a>
            Max 03 DoFollow links
            Turnaround Time: 2 days
          </td>
          <td><span class="badge">Business</span><span class="badge">Technology</span></td>
          <td>Monthly Traffic <strong>1,234</strong></td>
          <td>DR <strong>71</strong></td>
          <td>DA <strong>60</strong></td>
          <td><span>English</span></td>
          <td>
            <a href="/performers/all-performers?id=1194&project=39023">$9.99</a>
            <input name="website_id" value="1194">
          </td>
        </tr>
      </tbody>
    </table>
    <ul class="pagination">
      <li><a class="page-link">1</a></li>
      <li><a class="page-link">2045</a></li>
    </ul>
  `;

  const parsed = parsePublishersPage(html, 1);

  assert.equal(parsed.totalPages, 2045);
  assert.deepEqual(parsed.rows, [
    {
      website_id: "1194",
      website: "www.example.com",
      website_url: "https://example.com",
      categories: ["Business", "Technology"],
      monthly_traffic: 1234,
      ahrefs_dr: 71,
      moz_da: 60,
      language: "English",
      price: 9.99,
      currency: "$",
      max_links: 3,
      link_type: "DoFollow",
      turnaround: "2 days",
      added_on: "27 Aug 2026",
      source_page: 1,
    },
  ]);
});
