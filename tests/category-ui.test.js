const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.join(__dirname, '..', 'app.js');
const stylesPath = path.join(__dirname, '..', 'styles.css');
const source = fs.readFileSync(appPath, 'utf8') + '\nglobalThis.UILayer = UILayer; globalThis.DiffEngine = DiffEngine; globalThis.buildDetailHTML = buildDetailHTML;';
const styles = fs.readFileSync(stylesPath, 'utf8');

function createButton(sortKey) {
  const classListValues = new Set();
  const indicator = { textContent: '' };
  const attributes = {};
  return {
    dataset: { sort: sortKey },
    classList: {
      toggle(name, enabled) {
        if (enabled) classListValues.add(name);
        else classListValues.delete(name);
      },
      contains(name) {
        return classListValues.has(name);
      }
    },
    setAttribute(name, value) {
      attributes[name] = value;
    },
    getAttribute(name) {
      return attributes[name];
    },
    querySelector(selector) {
      return selector === '.sort-indicator' ? indicator : null;
    },
    indicator
  };
}

const summaryEl = { innerHTML: '' };
const sortButtons = [createButton('change'), createButton('name'), createButton('path'), createButton('impact')];
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  localStorage: { getItem() { return null; }, setItem() {} },
  sessionStorage: { getItem() { return null; }, setItem() {} },
  document: {
    addEventListener() {},
    querySelectorAll(selector) {
      return selector === '#categories-table .sort-header' ? sortButtons : [];
    },
    getElementById(id) {
      return id === 'category-filtered-summary' ? summaryEl : null;
    }
  }
};

vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const ui = sandbox.UILayer;
const catDiff = {
  all: [
    { type: 'added', catB: { id: 'gid://shopify/TaxonomyCategory/aa', name: 'Shoes', full_name: 'Apparel & Accessories > Shoes', level: 2 } },
    { type: 'removed', catA: { id: 'gid://shopify/TaxonomyCategory/food', name: 'Apples', full_name: 'Food > Fruit > Apples', level: 3 } },
    { type: 'moved', catA: { name: 'Speakers', full_name: 'Audio > Speakers' }, catB: { id: 'gid://shopify/TaxonomyCategory/electronics', name: 'Speakers', full_name: 'Electronics > Audio > Speakers', level: 1 } },
    { type: 'modified', catB: { id: 'gid://shopify/TaxonomyCategory/hb', name: 'Shampoo', full_name: 'Health & Beauty > Hair Care > Shampoo', level: 3 } }
  ],
  added: [],
  removed: [],
  renamed: [],
  moved: [],
  modified: []
};
for (const item of catDiff.all) catDiff[item.type].push(item);

ui.currentFilter = 'all';
ui.currentSearch = 'apparel';
ui.currentSort = { key: 'name', direction: 'asc' };
const apparelItems = ui.filterCategories(catDiff);
assert.strictEqual(apparelItems.length, 1);
assert.strictEqual(apparelItems[0].catB.name, 'Shoes');

ui.renderFilteredCategorySummary(apparelItems, catDiff.all.length);
assert.match(summaryEl.innerHTML, /Visible Changes/);
assert.match(summaryEl.innerHTML, /1 of 4 category changes shown/);
assert.match(summaryEl.innerHTML, /Search: &quot;apparel&quot;/);

ui.currentSearch = '';
ui.currentFilter = 'all';
ui.currentSort = { key: 'impact', direction: 'asc' };
const impactSorted = ui.filterCategories(catDiff);
assert.strictEqual((impactSorted[0].catB || impactSorted[0].catA).name, 'Speakers');

ui.currentSort = { key: 'path', direction: 'desc' };
ui.updateCategorySortHeaders();
const pathButton = sortButtons.find(button => button.dataset.sort === 'path');
assert.strictEqual(pathButton.getAttribute('aria-sort'), 'descending');
assert.strictEqual(pathButton.indicator.textContent, '▼');

const snapA = {
  categories: [{ id: 'cat-health', name: 'Health Care', full_name: 'Health & Beauty > Health Care', parent_id: 'hb', level: 2, attributes: ['attr-size', 'attr-material'] }],
  categoriesById: new Map(),
  attributes: [
    { id: 'attr-size', name: 'Size' },
    { id: 'attr-material', name: 'Material' }
  ],
  attributesById: new Map()
};
const snapB = {
  categories: [{ id: 'cat-health', name: 'Health Care', full_name: 'Health & Beauty > Health Care', parent_id: 'hb', level: 2, attributes: ['attr-size', 'attr-product-form'] }],
  categoriesById: new Map(),
  attributes: [
    { id: 'attr-size', name: 'Size' },
    { id: 'attr-product-form', name: 'Product Form' }
  ],
  attributesById: new Map()
};
snapA.categoriesById.set(snapA.categories[0].id, snapA.categories[0]);
snapB.categoriesById.set(snapB.categories[0].id, snapB.categories[0]);
for (const attr of snapA.attributes) snapA.attributesById.set(attr.id, attr);
for (const attr of snapB.attributes) snapB.attributesById.set(attr.id, attr);

const categoryDiff = sandbox.DiffEngine.compareCategories(snapA, snapB);
assert.strictEqual(categoryDiff.modified.length, 1);
const modifiedHealthCare = categoryDiff.modified[0];
assert.strictEqual(modifiedHealthCare.attrDetail.added[0].name, 'Product Form');
assert.strictEqual(modifiedHealthCare.attrDetail.removed[0].name, 'Material');
const detailHtml = sandbox.buildDetailHTML(modifiedHealthCare);
assert.match(detailHtml, /Old Attributes/);
assert.match(detailHtml, /New Attributes/);
assert.match(detailHtml, /attribute-item added/);
assert.match(detailHtml, /Product Form/);
assert.match(detailHtml, /\+ Added/);
assert.match(detailHtml, /attribute-item removed/);
assert.match(detailHtml, /Material/);
assert.match(detailHtml, /− Removed/);
assert.match(styles, /\.row-detail\.open\s*\{\s*display:\s*table-cell;\s*\}/);

console.log('category-ui.test.js passed');
