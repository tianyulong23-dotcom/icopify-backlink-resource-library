const numberFormatter = new Intl.NumberFormat("zh-CN");
const priceFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const state = {
  page: 1,
  totalPages: 1,
  q: "",
  category: "",
  language: "",
  linkType: "",
  emailStatus: "",
  minTraffic: "",
  minDr: "",
  minDa: "",
  maxPrice: "",
  sort: "source_asc",
};

const elements = {
  category: document.querySelector("#categorySelect"),
  contactCrawlStatus: document.querySelector("#contactCrawlStatus"),
  contactCrawlText: document.querySelector("#contactCrawlText"),
  empty: document.querySelector("#emptyState"),
  error: document.querySelector("#errorState"),
  errorText: document.querySelector("#errorText"),
  emailStatus: document.querySelector("#emailStatusSelect"),
  jumpForm: document.querySelector("#jumpForm"),
  jumpInput: document.querySelector("#jumpInput"),
  language: document.querySelector("#languageSelect"),
  linkType: document.querySelector("#linkTypeSelect"),
  maxPrice: document.querySelector("#maxPriceInput"),
  minDa: document.querySelector("#minDaInput"),
  minDr: document.querySelector("#minDrInput"),
  minTraffic: document.querySelector("#minTrafficInput"),
  pageButtons: document.querySelector("#pageButtons"),
  reset: document.querySelector("#resetButton"),
  resultSummary: document.querySelector("#resultSummary"),
  rows: document.querySelector("#resourceRows"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  snapshotText: document.querySelector("#snapshotText"),
  sort: document.querySelector("#sortSelect"),
  summaryLanguages: document.querySelector("#summaryLanguages"),
  summaryPages: document.querySelector("#summaryPages"),
  summaryRaw: document.querySelector("#summaryRaw"),
  summaryWebsites: document.querySelector("#summaryWebsites"),
};

let activeRequest;

function readStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  for (const key of Object.keys(state)) {
    if (key === "totalPages") {
      continue;
    }
    const value = params.get(key);
    if (value !== null) {
      state[key] = key === "page" ? Math.max(1, Number.parseInt(value, 10) || 1) : value;
    }
  }
}

function syncControls() {
  elements.searchInput.value = state.q;
  elements.category.value = state.category;
  elements.language.value = state.language;
  elements.linkType.value = state.linkType;
  elements.emailStatus.value = state.emailStatus;
  elements.minTraffic.value = state.minTraffic;
  elements.minDr.value = state.minDr;
  elements.minDa.value = state.minDa;
  elements.maxPrice.value = state.maxPrice;
  elements.sort.value = state.sort;
}

function syncUrl() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) {
    if (key === "totalPages" || value === "" || (key === "page" && value === 1)) {
      continue;
    }
    if (key === "sort" && value === "source_asc") {
      continue;
    }
    params.set(key, String(value));
  }
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}

function makeOption(item) {
  const option = document.createElement("option");
  option.value = item.value;
  option.textContent = `${item.value} (${numberFormatter.format(item.count)})`;
  return option;
}

function populateSelect(select, options) {
  const firstOption = select.firstElementChild;
  select.replaceChildren(firstOption, ...options.map(makeOption));
}

function formatMetric(value) {
  return value === null || value === undefined ? "—" : numberFormatter.format(value);
}

function formatPrice(currency, value) {
  if (value === null || value === undefined) {
    return "—";
  }
  return `${currency || "$"}${priceFormatter.format(value)}`;
}

function safeExternalUrl(value) {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function createCell(label, className = "") {
  const cell = document.createElement("div");
  cell.className = `resource-cell ${className}`.trim();
  cell.dataset.label = label;
  cell.setAttribute("role", "cell");
  return cell;
}

function createSiteCell(item) {
  const cell = createCell("网站", "site-cell");
  const url = safeExternalUrl(item.website_url);
  const name = item.website || item.domain || `隐藏网站 #${item.website_id || item.row_id}`;
  const title = url ? document.createElement("a") : document.createElement("span");
  title.className = url ? "site-link" : "site-name";
  title.textContent = url ? `${name} ↗` : name;
  title.title = name;
  if (url) {
    title.href = url;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
  }

  const meta = document.createElement("div");
  meta.className = "site-meta";
  const details = [
    item.max_links ? `最多 ${item.max_links} 条链接` : "",
    item.link_type || "",
    item.turnaround ? `交付 ${item.turnaround}` : "",
  ].filter(Boolean);
  if (item.resource_type) {
    const badge = document.createElement("span");
    badge.className = `resource-type-badge resource-type-${item.resource_type}`;
    badge.textContent =
      item.resource_type === "free"
        ? "免费资源"
        : item.resource_type === "paid"
          ? "付费资源"
          : item.resource_type;
    meta.append(badge);
  }
  for (const detail of details) {
    const span = document.createElement("span");
    span.textContent = detail;
    meta.append(span);
  }

  cell.append(title, meta);
  return cell;
}

function createCategoriesCell(item) {
  const cell = createCell("分类", "category-cell");
  const list = document.createElement("div");
  list.className = "category-list";
  const categories = item.categories.length ? item.categories : ["未分类"];
  for (const category of categories) {
    const tag = document.createElement("span");
    tag.className = "category-tag";
    tag.textContent = category;
    tag.title = category;
    list.append(tag);
  }
  cell.append(list);
  return cell;
}

function createMetricCell(label, value, suffix = "") {
  const cell = createCell(label, "numeric");
  const metric = document.createElement("span");
  metric.className = "metric-value";
  metric.textContent = `${formatMetric(value)}${suffix}`;
  cell.append(metric);
  return cell;
}

function createScoreCell(label, value) {
  const cell = createCell(label, "numeric");
  const score = document.createElement("span");
  score.className = "score-chip";
  score.textContent = value === null || value === undefined ? "—" : String(value);
  cell.append(score);
  return cell;
}

function createLanguageCell(item) {
  const cell = createCell("语言");
  const language = document.createElement("span");
  language.className = "language-value";
  language.textContent = item.language || "—";
  cell.append(language);
  return cell;
}

function createPriceCell(item) {
  const cell = createCell("参考价格", "numeric");
  const price = document.createElement("span");
  price.className = "price-value";
  price.textContent = formatPrice(item.currency, item.price);
  cell.append(price);
  return cell;
}

function appendContactLink(container, text, href, className = "contact-link") {
  const link = document.createElement("a");
  link.className = className;
  link.textContent = text;
  link.href = href;
  if (!href.startsWith("mailto:") && !href.startsWith("tel:")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  container.append(link);
}

function createContactCell(item) {
  const cell = createCell("联系方式", "contact-cell");
  const contact = item.contact || { status: "pending" };
  const email = contact.emails?.[0];
  const phone = contact.phones?.[0];
  const contactUrl = safeExternalUrl(contact.contact_urls?.[0]);

  if (email) {
    appendContactLink(cell, email, `mailto:${email}`);
  }
  if (phone) {
    appendContactLink(cell, phone, `tel:${phone}`, "contact-phone");
  }
  if (contactUrl) {
    appendContactLink(cell, "联系页面 ↗", contactUrl, "contact-page-link");
  }
  if (email || phone || contactUrl) {
    return cell;
  }

  const status = document.createElement("span");
  status.className = `contact-state contact-state-${contact.status || "pending"}`;
  const labels = {
    blocked: "网站禁止自动抓取",
    error: "暂时无法访问",
    not_found: "未发现公开联系方式",
    pending: "待抓取",
    running: "抓取中",
  };
  status.textContent = labels[contact.status] || "待抓取";
  cell.append(status);
  return cell;
}

function renderRows(items) {
  const rows = items.map((item) => {
    const row = document.createElement("div");
    row.className = "resource-grid resource-row";
    row.setAttribute("role", "row");
    row.append(
      createSiteCell(item),
      createCategoriesCell(item),
      createMetricCell("月流量", item.monthly_traffic),
      createScoreCell("Ahrefs DR", item.ahrefs_dr),
      createScoreCell("Moz DA", item.moz_da),
      createLanguageCell(item),
      createPriceCell(item),
      createContactCell(item),
    );
    return row;
  });
  elements.rows.replaceChildren(...rows);
}

function renderLoading() {
  const skeletons = Array.from({ length: 8 }, () => {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    for (let index = 0; index < 8; index += 1) {
      const cell = document.createElement("div");
      cell.className = "skeleton-cell";
      row.append(cell);
    }
    return row;
  });
  elements.rows.replaceChildren(...skeletons);
  elements.empty.hidden = true;
  elements.error.hidden = true;
}

function createPageButton(label, page, options = {}) {
  const button = document.createElement("button");
  button.className = "page-button";
  button.type = "button";
  button.textContent = label;
  button.title = options.title || `第 ${page} 页`;
  button.disabled = Boolean(options.disabled);
  if (options.current) {
    button.setAttribute("aria-current", "page");
  }
  button.addEventListener("click", () => {
    if (state.page === page) {
      return;
    }
    state.page = page;
    loadPublishers({ scroll: true });
  });
  return button;
}

function paginationItems(current, total) {
  if (total <= 8) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set([1, 2, total - 1, total, current - 1, current, current + 1]);
  const validPages = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const items = [];
  for (const page of validPages) {
    if (items.length && page - items.at(-1) > 1) {
      items.push("ellipsis");
    }
    items.push(page);
  }
  return items;
}

function renderPagination() {
  const buttons = [
    createPageButton("«", 1, { disabled: state.page === 1, title: "第一页" }),
    createPageButton("‹", state.page - 1, {
      disabled: state.page === 1,
      title: "上一页",
    }),
  ];

  for (const item of paginationItems(state.page, state.totalPages)) {
    if (item === "ellipsis") {
      const ellipsis = document.createElement("span");
      ellipsis.className = "page-ellipsis";
      ellipsis.textContent = "…";
      ellipsis.setAttribute("aria-hidden", "true");
      buttons.push(ellipsis);
    } else {
      buttons.push(createPageButton(String(item), item, { current: item === state.page }));
    }
  }

  buttons.push(
    createPageButton("›", state.page + 1, {
      disabled: state.page === state.totalPages,
      title: "下一页",
    }),
    createPageButton("»", state.totalPages, {
      disabled: state.page === state.totalPages,
      title: "最后一页",
    }),
  );
  elements.pageButtons.replaceChildren(...buttons);
  elements.jumpInput.max = String(state.totalPages);
  elements.jumpInput.placeholder = String(state.page);
}

function buildQuery() {
  const params = new URLSearchParams();
  for (const key of [
    "page",
    "q",
    "category",
    "language",
    "linkType",
    "emailStatus",
    "minTraffic",
    "minDr",
    "minDa",
    "maxPrice",
    "sort",
  ]) {
    if (state[key] !== "") {
      params.set(key, String(state[key]));
    }
  }
  return params;
}

async function loadPublishers({ scroll = false, silent = false } = {}) {
  activeRequest?.abort();
  activeRequest = new AbortController();
  if (!silent) {
    renderLoading();
    elements.resultSummary.textContent = "正在加载数据...";
  }

  try {
    const response = await fetch(`/api/publishers?${buildQuery()}`, {
      signal: activeRequest.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    state.page = data.page;
    state.totalPages = data.totalPages;
    state.sort = data.sort;
    renderRows(data.items);
    renderPagination();
    syncUrl();

    elements.empty.hidden = data.items.length > 0;
    elements.error.hidden = true;
    elements.resultSummary.textContent =
      `${numberFormatter.format(data.total)} 个网站 · ` +
      `第 ${numberFormatter.format(data.page)} / ${numberFormatter.format(data.totalPages)} 页`;

    if (scroll) {
      document.querySelector(".results-section").scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    elements.rows.replaceChildren();
    elements.empty.hidden = true;
    elements.error.hidden = false;
    elements.errorText.textContent = `读取失败：${error.message}`;
    elements.resultSummary.textContent = "数据读取失败";
    elements.pageButtons.replaceChildren();
  }
}

let lastContactProcessed = -1;

async function loadContactCrawlStatus() {
  try {
    const response = await fetch("/api/contact-crawl", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    elements.contactCrawlStatus.dataset.state = data.status;
    if (data.status === "running") {
      elements.contactCrawlText.textContent =
        `联系方式抓取中 · ${numberFormatter.format(data.processed)} / ` +
        `${numberFormatter.format(data.total)} · 已找到 ${numberFormatter.format(data.found)}`;
    } else if (data.processed > 0) {
      elements.contactCrawlText.textContent =
        `联系方式 · 已完成 ${numberFormatter.format(data.processed)} / ` +
        `${numberFormatter.format(data.total)} · 已找到 ${numberFormatter.format(data.found)}`;
    } else {
      elements.contactCrawlText.textContent = "联系方式等待抓取";
    }

    if (
      data.status === "running" &&
      lastContactProcessed >= 0 &&
      data.processed !== lastContactProcessed
    ) {
      loadPublishers({ silent: true });
    }
    lastContactProcessed = data.processed;
  } catch {
    elements.contactCrawlStatus.dataset.state = "error";
    elements.contactCrawlText.textContent = "联系方式状态暂时不可用";
  }
}

async function loadFilterOptions() {
  const response = await fetch("/api/filters");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  populateSelect(elements.category, data.categories);
  populateSelect(elements.language, data.languages);
  populateSelect(elements.linkType, data.linkTypes);
  syncControls();

  elements.summaryWebsites.textContent = numberFormatter.format(data.stats.uniqueRows);
  elements.summaryPages.textContent = numberFormatter.format(data.stats.totalPages);
  elements.summaryLanguages.textContent = numberFormatter.format(data.stats.languageCount);
  elements.summaryRaw.textContent = data.stats.rawRows
    ? numberFormatter.format(data.stats.rawRows)
    : "—";
  elements.snapshotText.textContent =
    `本地快照 · ${dateFormatter.format(new Date(data.stats.updatedAt))}`;
}

function updateFilterState() {
  state.category = elements.category.value;
  state.language = elements.language.value;
  state.linkType = elements.linkType.value;
  state.emailStatus = elements.emailStatus.value;
  state.minTraffic = elements.minTraffic.value;
  state.minDr = elements.minDr.value;
  state.minDa = elements.minDa.value;
  state.maxPrice = elements.maxPrice.value;
  state.sort = elements.sort.value;
  state.page = 1;
  loadPublishers();
}

elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.q = elements.searchInput.value.trim();
  state.page = 1;
  loadPublishers();
});

for (const element of [
  elements.category,
  elements.language,
  elements.linkType,
  elements.emailStatus,
  elements.minTraffic,
  elements.minDr,
  elements.minDa,
  elements.maxPrice,
  elements.sort,
]) {
  element.addEventListener("change", updateFilterState);
}

elements.reset.addEventListener("click", () => {
  Object.assign(state, {
    page: 1,
    q: "",
    category: "",
    language: "",
    linkType: "",
    emailStatus: "",
    minTraffic: "",
    minDr: "",
    minDa: "",
    maxPrice: "",
    sort: "source_asc",
  });
  syncControls();
  loadPublishers();
});

elements.jumpForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const target = Number.parseInt(elements.jumpInput.value, 10);
  if (!Number.isFinite(target)) {
    return;
  }
  state.page = Math.min(Math.max(1, target), state.totalPages);
  elements.jumpInput.value = "";
  loadPublishers({ scroll: true });
});

readStateFromUrl();
syncControls();
renderLoading();

try {
  await loadFilterOptions();
} catch (error) {
  elements.snapshotText.textContent = "资源库连接失败";
}
await Promise.all([loadPublishers(), loadContactCrawlStatus()]);
setInterval(loadContactCrawlStatus, 10_000);
