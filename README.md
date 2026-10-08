# Shopify Taxonomy Diff Analyzer

A production-quality, single-page web application that compares two versions of the [Shopify Product Taxonomy](https://github.com/Shopify/product-taxonomy) and generates a comprehensive migration and impact report — entirely in the browser, with no backend required.

UI: https://jaykishanstax.github.io/shopify-taxonomy-diff/

## Quick Start

```bash
# Just open the file in any modern browser:
open index.html
# or double-click index.html in Finder / Explorer
```

No build step, no npm install, no server required.

---

## Features

### 🚀 Zero-Click Results
- **Auto-compares on load** — defaults to `2025-03 → 2026-08` immediately
- **Auto-compares on version change** — switching either dropdown fires a new comparison automatically
- **Single scrollable page** — sticky left sidebar navigates between sections; no tab-clicking

### 📊 Executive Summary
- 8 animated stat cards: Added / Removed / Renamed / Moved / Modified categories + attribute changes
- AI-generated insight paragraph with impact level (HIGH / MEDIUM / LOW)
- Percentage change indicators

### 📋 Category Changes
- Filterable table (All / Added / Removed / Renamed / Moved / Modified)
- Inline search filter by name or path — always visible, no modal
- **Click any row** to expand inline detail: old path, new path, parent change, migration suggestion
- Batch rendering (100 rows at a time) for performance with large datasets

### 🌲 Taxonomy Tree Diff
- Expandable tree view of the full taxonomy
- Color-coded nodes: `+ Added` (green), `− Removed` (red/strikethrough), `↩ Renamed` (purple), `↕ Moved` (orange), `~ Modified` (orange-red)
- Expand All / Collapse All controls
- Tree search with highlight

### 🔧 Attribute Changes
- Global attribute additions, removals, and value-level diffs
- Category assignment changes table (which categories gained/lost attributes)

### 📈 Impact Analysis
- Impact level banner (HIGH / MEDIUM / LOW) with total change count
- Horizontal bar chart of top 10 affected taxonomy domains (no external chart library)
- Human-readable narrative paragraphs

### 🔄 Migration Recommendations
- Card per removed category with up to 3 similarity-matched replacement suggestions
- Match score displayed as percentage (Levenshtein distance-based)

### 🔍 Global Search
- Always visible in the header — search categories, attributes, and paths
- Results update live (300ms debounce), scroll to Search Results section automatically
- Matched text highlighted in results

### 📦 Product Impact Analysis
- Upload a `products.csv` (drag & drop or click)
- Required columns: `product_id`, `title`, `shopify_category_id`
- Cross-references your products against the diff
- Reports: Unaffected / Using Removed Category / Needs Review
- Recommended action per affected product

### 💾 One-Click Exports (always visible floating bar)
| Format | Contents |
|--------|----------|
| **CSV** | All category changes with type, old/new name, path, impact |
| **JSON** | Full structured diff with summary, categories, attributes, suggestions |
| **HTML** | Self-contained printable report with styling |
| **Excel** | 4 sheets: Summary, Categories, Attributes, Migration |

### 🌙 Dark Mode
- Toggle via the moon/sun button in the header
- Preference persisted in `localStorage`

---

## Comparing Specific Versions

1. Open `index.html` in a browser
2. Use the **Source** and **Target** dropdowns in the header
3. Comparison fires automatically on selection change

The dropdown is populated from the [GitHub Releases API](https://api.github.com/repos/Shopify/product-taxonomy/releases). If the API is rate-limited, a hardcoded fallback list is used.

---

## Product CSV Format

```csv
product_id,title,shopify_category_id
prod_001,Blue Running Shoes,gid://shopify/TaxonomyCategory/sg-4-17-2-17
prod_002,Vitamin C Supplement,gid://shopify/TaxonomyCategory/hb-1-3
prod_003,Wireless Headphones,gid://shopify/TaxonomyCategory/el-2-1
```

The `shopify_category_id` column name can also be `category_id` or any column containing the word "category".

---

## Deploying to GitHub Pages

1. Fork or create a repo
2. Copy `index.html`, `styles.css`, `app.js` to the repo root
3. Go to **Settings → Pages → Source: Deploy from branch → main / root**
4. Access at `https://{username}.github.io/{repo}/`

---

## Data Sources

| Resource | URL |
|----------|-----|
| Taxonomy releases | `https://shopify.github.io/product-taxonomy/releases/{version}/categories.json` |
| Attribute data | `https://shopify.github.io/product-taxonomy/releases/{version}/attributes.json` |
| Version list | `https://api.github.com/repos/Shopify/product-taxonomy/releases` |
| Source repo | `https://github.com/Shopify/product-taxonomy` |

All data is fetched directly in the browser. No data leaves your machine except to Shopify's GitHub Pages servers.

---

## Browser Compatibility

| Browser | Minimum Version |
|---------|----------------|
| Chrome / Edge | 90+ |
| Firefox | 88+ |
| Safari | 14+ |

Requires: `fetch`, `IntersectionObserver`, `Map`, `Set`, `Promise.all`, optional chaining (`?.`)

---

## Architecture

```
index.html      — Layout, HTML structure, SheetJS CDN script tag
styles.css      — Full design system (CSS variables, dark mode, responsive)
app.js          — All logic, 6 modules:
  DataLoader    — Fetch + cache taxonomy JSON from GitHub Pages
  DiffEngine    — Compare snapshots, classify changes (added/removed/renamed/moved/modified)
  ReportGenerator — AI narrative, impact scoring, migration cards
  UILayer       — DOM rendering, filters, search, tree view, scroll spy
  ExportLayer   — CSV / JSON / HTML / XLSX downloads
  ProductImpact — CSV upload, product cross-referencing, impact analysis
```

---

## Performance Notes

- Categories and attributes fetched in parallel per version
- Session-level caching: switching versions re-uses cached data
- Table renders in batches of 100 rows (no full DOM dump)
- Tree view uses lazy child rendering (children only built on expand)
- Levenshtein similarity runs only for removed categories vs added pool

---

*Built for taxonomy governance, migration analysis, and enrichment pipeline management.*
