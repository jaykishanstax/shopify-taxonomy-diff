/* ══════════════════════════════════════════════════════════════
   SHOPIFY TAXONOMY DIFF ANALYZER — app.js
   Modules: DataLoader | DiffEngine | ReportGenerator |
            UILayer | ExportLayer | ProductImpact | App
══════════════════════════════════════════════════════════════ */
'use strict';

/* ─────────────────────────────────────────────────────────────
   MODULE 1: DataLoader
   Fetches + caches taxonomy JSON from Shopify GitHub Pages
───────────────────────────────────────────────────────────── */
const DataLoader = {
  cache: new Map(),
  // Raw GitHub serves unzipped JSON with CORS; format: /v{version}/dist/en/{file}.json
  RAW_BASE: 'https://raw.githubusercontent.com/Shopify/product-taxonomy',
  GITHUB_API: 'https://api.github.com/repos/Shopify/product-taxonomy/releases',
  FALLBACK_VERSIONS: ['2026-08','2025-12','2025-09','2025-03','2024-07'],

  async fetchReleases() {
    try {
      const resp = await fetch(this.GITHUB_API, { headers: { 'Accept': 'application/vnd.github.v3+json' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const versions = data
        .map(r => r.tag_name.replace(/^v/, ''))
        .filter(v => /^\d{4}-\d{2}$/.test(v));
      return versions.length > 0 ? versions : this.FALLBACK_VERSIONS;
    } catch (e) {
      console.warn('GitHub API fallback:', e.message);
      return this.FALLBACK_VERSIONS;
    }
  },

  rawUrl(version, file) {
    return this.RAW_BASE + '/v' + version + '/dist/en/' + file;
  },

  async fetchVersion(version) {
    const key = 'taxonomy_v2_' + version;
    if (this.cache.has(key)) return this.cache.get(key);

    // Check sessionStorage cache
    try {
      const stored = sessionStorage.getItem(key);
      if (stored) {
        const p = JSON.parse(stored);
        p.categoriesById = new Map(p.categories.map(c => [c.id, c]));
        p.attributesById = new Map(p.attributes.map(a => [a.id, a]));
        this.cache.set(key, p);
        return p;
      }
    } catch (_) {}

    // Fetch categories and attributes in parallel
    const [cr, ar] = await Promise.all([
      fetch(this.rawUrl(version, 'categories.json')),
      fetch(this.rawUrl(version, 'attributes.json'))
    ]);
    if (!cr.ok) throw new Error('categories.json not found for v' + version + ' (HTTP ' + cr.status + ')');
    if (!ar.ok) throw new Error('attributes.json not found for v' + version + ' (HTTP ' + ar.status + ')');

    const catData  = await cr.json();
    const attrData = await ar.json();

    // Normalize categories:
    // Real format: {version, verticals:[{name, prefix, categories:[{id,level,name,full_name,parent_id,attributes:[],children:[{id,name}],ancestors:[]}]}]}
    const categories = [];
    const verticals = catData.verticals || (Array.isArray(catData) ? catData : []);
    for (const vertical of verticals) {
      const cats = Array.isArray(vertical) ? vertical : (vertical.categories || []);
      for (const c of cats) {
        // attributes: array of objects {id,name,handle,...} or strings — extract IDs
        const attrIds = Array.isArray(c.attributes)
          ? c.attributes.map(a => typeof a === 'string' ? a : String(a.id || a.gid || '')).filter(Boolean)
          : [];
        // children: array of {id, name} stubs — extract IDs for tree building
        const childIds = Array.isArray(c.children)
          ? c.children.map(ch => String(ch.id || ch.gid || '')).filter(Boolean)
          : (Array.isArray(c.children_ids) ? c.children_ids.map(String) : []);
        // Real data: level 0 = root. Add 1 so UI impact (High=1, Med=2, Low=3+) works naturally.
        const level = (typeof c.level === 'number' ? c.level : 0) + 1;
        categories.push({
          id:          String(c.id || c.gid || ''),
          name:        c.name || '',
          full_name:   c.full_name || c.fullName || c.name || '',
          parent_id:   c.parent_id || c.parentId || null,
          level,
          children_ids: childIds,
          attributes:  attrIds
        });
      }
    }

    // Normalize attributes:
    // Real format: {version, attributes:[{id,name,handle,description,extended_attributes,values:[{id,name,handle}]}]}
    const rawAttrs = Array.isArray(attrData) ? attrData : (attrData.attributes || []);
    const attributes = rawAttrs.map(a => ({
      id:     String(a.id || a.gid || ''),
      name:   a.name || '',
      values: (a.values || []).map(v => ({
        id:   String(v.id || v.gid || ''),
        name: v.name || ''
      }))
    }));

    const categoriesById = new Map(categories.map(c => [c.id, c]));
    const attributesById = new Map(attributes.map(a => [a.id, a]));
    const result = { version, categories, attributes, categoriesById, attributesById };
    this.cache.set(key, result);
    try {
      sessionStorage.setItem(key, JSON.stringify({ version, categories, attributes }));
    } catch (_) {}
    return result;
  }
};

/* ─────────────────────────────────────────────────────────────
   MODULE 2: DiffEngine
   Compares two snapshots, classifies every change type
───────────────────────────────────────────────────────────── */
const DiffEngine = {
  CHANGE: Object.freeze({
    ADDED:'added', REMOVED:'removed', RENAMED:'renamed',
    MOVED:'moved', MODIFIED:'modified', UNCHANGED:'unchanged'
  }),

  compare(snapA, snapB) {
    const catDiff  = this.compareCategories(snapA, snapB);
    const attrDiff = this.compareAttributes(snapA, snapB);
    const summary  = this.buildSummary(catDiff, attrDiff, snapA, snapB);
    return { catDiff, attrDiff, summary, snapA, snapB };
  },

  compareCategories(snapA, snapB) {
    const added=[], removed=[], renamed=[], moved=[], modified=[], unchanged=[];
    const idsA = new Set(snapA.categories.map(c => c.id));
    const idsB = new Set(snapB.categories.map(c => c.id));

    for (const cat of snapB.categories)
      if (!idsA.has(cat.id)) added.push({ type:this.CHANGE.ADDED, catB:cat, catA:null });

    for (const cat of snapA.categories)
      if (!idsB.has(cat.id)) removed.push({ type:this.CHANGE.REMOVED, catA:cat, catB:null });

    for (const catA of snapA.categories) {
      if (!idsB.has(catA.id)) continue;
      const catB        = snapB.categoriesById.get(catA.id);
      const nameChanged = catA.name      !== catB.name;
      const parChanged  = catA.parent_id !== catB.parent_id;
      const pathChanged = catA.full_name !== catB.full_name;
      const attrIdsA = [...(catA.attributes||[])].map(String).sort();
      const attrIdsB = [...(catB.attributes||[])].map(String).sort();
      const attrsA = JSON.stringify(attrIdsA);
      const attrsB = JSON.stringify(attrIdsB);
      const attrsChanged = attrsA !== attrsB;
      const attrDetail = attrsChanged ? this.buildCategoryAttributeDetail(catA, catB, snapA, snapB) : null;
      if      (nameChanged && parChanged) renamed.push({ type:this.CHANGE.RENAMED, catA, catB, pathChanged:true, attrsChanged, attrDetail });
      else if (nameChanged)               renamed.push({ type:this.CHANGE.RENAMED, catA, catB, pathChanged, attrsChanged, attrDetail });
      else if (parChanged || pathChanged) moved.push({ type:this.CHANGE.MOVED, catA, catB, attrsChanged, attrDetail });
      else if (attrsChanged)              modified.push({ type:this.CHANGE.MODIFIED, catA, catB, attrDetail });
      else                                unchanged.push({ type:this.CHANGE.UNCHANGED, catA, catB });
    }

    const addedPool = added.map(e => ({ name:e.catB.name, id:e.catB.id, full_name:e.catB.full_name }));
    for (const entry of removed) entry.suggestions = this.findBestMatches(entry.catA.name, addedPool, 0.35);

    const all = [...added, ...removed, ...renamed, ...moved, ...modified];
    return { added, removed, renamed, moved, modified, unchanged, all };
  },

  buildCategoryAttributeDetail(catA, catB, snapA, snapB) {
    const oldIds = [...(catA.attributes || [])].map(String);
    const newIds = [...(catB.attributes || [])].map(String);
    const oldSet = new Set(oldIds);
    const newSet = new Set(newIds);
    const oldAttributes = oldIds.map(id => this.resolveAttributeDetail(id, snapA, snapB, oldSet.has(id) && newSet.has(id) ? 'unchanged' : 'removed'));
    const activeNewAttributes = newIds.map(id => this.resolveAttributeDetail(id, snapB, snapA, oldSet.has(id) ? 'unchanged' : 'added'));
    const removedInNewList = oldIds
      .filter(id => !newSet.has(id))
      .map(id => this.resolveAttributeDetail(id, snapA, snapB, 'removed'));
    return {
      oldAttributes,
      newAttributes: [...activeNewAttributes, ...removedInNewList].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })),
      added: activeNewAttributes.filter(attr => attr.status === 'added'),
      removed: removedInNewList
    };
  },

  resolveAttributeDetail(id, primarySnap, fallbackSnap, status) {
    const attr = primarySnap.attributesById.get(id) || fallbackSnap.attributesById.get(id) || { id, name: id };
    return { id, name: attr.name || id, status };
  },

  compareAttributes(snapA, snapB) {
    const added=[], removed=[], modified=[];
    const idsA = new Set(snapA.attributes.map(a => a.id));
    const idsB = new Set(snapB.attributes.map(a => a.id));

    for (const a of snapB.attributes) if (!idsA.has(a.id)) added.push({ type:this.CHANGE.ADDED, attrB:a, attrA:null });
    for (const a of snapA.attributes) if (!idsB.has(a.id)) removed.push({ type:this.CHANGE.REMOVED, attrA:a, attrB:null });

    for (const attrA of snapA.attributes) {
      if (!idsB.has(attrA.id)) continue;
      const attrB = snapB.attributesById.get(attrA.id);
      const setA  = new Set(attrA.values.map(v => v.id));
      const setB  = new Set(attrB.values.map(v => v.id));
      const vAdded   = attrB.values.filter(v => !setA.has(v.id));
      const vRemoved = attrA.values.filter(v => !setB.has(v.id));
      if (vAdded.length || vRemoved.length || attrA.name !== attrB.name)
        modified.push({ type:this.CHANGE.MODIFIED, attrA, attrB, valuesAdded:vAdded, valuesRemoved:vRemoved });
    }

    const categoryAssignmentChanges = [];
    const allCatIds = new Set([...snapA.categories.map(c=>c.id), ...snapB.categories.map(c=>c.id)]);
    for (const catId of allCatIds) {
      const catA = snapA.categoriesById.get(catId);
      const catB = snapB.categoriesById.get(catId);
      if (!catA || !catB) continue;
      const aA = new Set((catA.attributes||[]).map(String));
      const aB = new Set((catB.attributes||[]).map(String));
      const attrAdded   = [...aB].filter(id=>!aA.has(id)).map(id=>snapB.attributesById.get(id)).filter(Boolean);
      const attrRemoved = [...aA].filter(id=>!aB.has(id)).map(id=>snapA.attributesById.get(id)).filter(Boolean);
      if (attrAdded.length || attrRemoved.length)
        categoryAssignmentChanges.push({ catA, catB, attrAdded, attrRemoved });
    }
    return { added, removed, modified, categoryAssignmentChanges };
  },

  buildSummary(catDiff, attrDiff, snapA, snapB) {
    const totalA = snapA.categories.length;
    const pct = n => totalA > 0 ? ((n/totalA)*100).toFixed(1)+'%' : '—';
    return {
      catsAdded:catDiff.added.length, catsRemoved:catDiff.removed.length,
      catsRenamed:catDiff.renamed.length, catsMoved:catDiff.moved.length,
      catsModified:catDiff.modified.length, catsUnchanged:catDiff.unchanged.length,
      attrsAdded:attrDiff.added.length, attrsRemoved:attrDiff.removed.length,
      attrsModified:attrDiff.modified.length, assignmentChanges:attrDiff.categoryAssignmentChanges.length,
      totalChanges: catDiff.all.length + attrDiff.added.length + attrDiff.removed.length + attrDiff.modified.length,
      totalCatsA:totalA, totalCatsB:snapB.categories.length,
      pctAdded:pct(catDiff.added.length), pctRemoved:pct(catDiff.removed.length)
    };
  },

  levenshtein(a, b) {
    const m=a.length, n=b.length;
    const dp = Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===0?j:j===0?i:0));
    for (let i=1;i<=m;i++)
      for (let j=1;j<=n;j++)
        dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  },

  similarity(a, b) {
    if (!a||!b) return 0;
    const la=a.toLowerCase(), lb=b.toLowerCase();
    return la===lb ? 1 : 1 - this.levenshtein(la,lb)/Math.max(la.length,lb.length);
  },

  findBestMatches(name, candidates, threshold=0.35) {
    return candidates
      .map(c=>({...c, score:this.similarity(name,c.name)}))
      .filter(c=>c.score>=threshold)
      .sort((a,b)=>b.score-a.score)
      .slice(0,3);
  },

  groupByDomain(changes) {
    const map = new Map();
    for (const ch of changes) {
      const cat = ch.catB || ch.catA;
      if (!cat) continue;
      const domain = (cat.full_name||cat.name||'').split(' > ')[0] || 'Other';
      if (!map.has(domain)) map.set(domain, {domain, count:0, types:new Set()});
      map.get(domain).count++;
      map.get(domain).types.add(ch.type);
    }
    return [...map.values()].sort((a,b)=>b.count-a.count).slice(0,10)
      .map(d=>({...d, types:[...d.types]}));
  }
};

/* ─────────────────────────────────────────────────────────────
   MODULE 3: ReportGenerator
   Produces AI narrative, impact level, migration cards
───────────────────────────────────────────────────────────── */
const ReportGenerator = {
  generate(diffResult, vA, vB) {
    const {catDiff,attrDiff,summary} = diffResult;
    const domains      = DiffEngine.groupByDomain(catDiff.all);
    const impactLevel  = this.computeImpactLevel(summary);
    const migrationCards = this.buildMigrationCards(catDiff);
    const aiInsight    = this.buildAIInsight(summary, domains, vA, vB, impactLevel);
    const narrative    = this.buildNarrative(summary, domains, attrDiff, vA, vB);
    return { domains, impactLevel, migrationCards, aiInsight, narrative };
  },

  computeImpactLevel(summary) {
    const t = summary.totalChanges;
    if (t>500) return {level:'HIGH',   color:'high',   icon:'🔴', total:t};
    if (t>100) return {level:'MEDIUM', color:'medium', icon:'🟡', total:t};
    return           {level:'LOW',    color:'low',    icon:'🟢', total:t};
  },

  buildMigrationCards(catDiff) {
    return catDiff.removed.filter(e=>e.catA).map(e=>({removed:e.catA, suggestions:e.suggestions||[]}));
  },

  buildAIInsight(summary, domains, vA, vB, impactLevel) {
    const top = domains[0];
    const lines = [
      'Between <strong>'+vA+'</strong> and <strong>'+vB+'</strong>: '+
      '<strong>'+summary.catsAdded+'</strong> categories added, '+
      '<strong>'+summary.catsRemoved+'</strong> removed, '+
      '<strong>'+summary.catsRenamed+'</strong> renamed, and '+
      '<strong>'+summary.catsMoved+'</strong> moved.'
    ];
    if (top) lines.push('The most affected domain is <strong>'+top.domain+'</strong> with '+top.count+' changes.');
    lines.push('Attribute changes: '+summary.attrsAdded+' new global attributes, '+summary.attrsRemoved+
      ' removed, '+summary.assignmentChanges+' category assignment updates.');
    const recs = {
      HIGH:  '⚠️ <strong>Recommendation:</strong> High-impact upgrade. Review all category mappings, enrichment pipelines, and downstream integrations before deploying.',
      MEDIUM:'📋 <strong>Recommendation:</strong> Review category mappings in affected domains and update attribute assignments where needed.',
      LOW:   '✅ <strong>Recommendation:</strong> Low-impact upgrade. Spot-check renamed and moved categories in your product catalog.'
    };
    lines.push(recs[impactLevel.level]);
    return lines;
  },

  buildNarrative(summary, domains, attrDiff, vA, vB) {
    const paras = [];
    const net = summary.totalCatsB - summary.totalCatsA;
    paras.push('The taxonomy evolved from version <strong>'+vA+'</strong> to <strong>'+vB+'</strong>. '+
      'Source had '+summary.totalCatsA+' categories; target has '+summary.totalCatsB+
      ' (net '+(net>=0?'+':'')+net+').');
    if (domains.length) {
      const list = domains.slice(0,5).map((d,i)=>(i+1)+'. '+d.domain+' ('+d.count+' changes)').join(', ');
      paras.push('Top affected taxonomy domains: '+list+'.');
    }
    if (attrDiff.modified.length)
      paras.push('<strong>'+attrDiff.modified.length+'</strong> global attributes were modified — new values added or existing values removed. Products relying on specific attribute values may need review.');
    if (summary.catsRemoved)
      paras.push('<strong>'+summary.catsRemoved+'</strong> categories removed. Products assigned to those categories must be recategorised. See Migration Recommendations for suggested replacements.');
    return paras;
  }
};


/* ─────────────────────────────────────────────────────────────
   MODULE 4: UILayer
   Renders all sections, manages filters, search, tree, sidebar
───────────────────────────────────────────────────────────── */
const UILayer = {
  currentFilter: 'all',
  currentSearch: '',
  currentSort: { key: 'path', direction: 'asc' },
  diffResult: null,
  report: null,

  init() {
    // Dark mode
    const saved = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
    document.getElementById('theme-icon').textContent = saved === 'dark' ? '☀️' : '🌙';

    document.getElementById('dark-mode-toggle').addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      document.getElementById('theme-icon').textContent = next === 'dark' ? '☀️' : '🌙';
    });

    // Filter pills
    document.getElementById('category-filters').addEventListener('click', e => {
      const pill = e.target.closest('.filter-pill');
      if (!pill) return;
      document.querySelectorAll('#category-filters .filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      this.currentFilter = pill.dataset.filter;
      if (this.diffResult) this.renderCategoriesTable(this.diffResult.catDiff);
    });

    // Category inline search
    const catSearch = document.getElementById('cat-search');
    if (catSearch) {
      catSearch.addEventListener('input', debounce(e => {
        this.currentSearch = e.target.value.trim().toLowerCase();
        if (this.diffResult) this.renderCategoriesTable(this.diffResult.catDiff);
      }, 200));
    }

    // Category sorting
    document.querySelectorAll('#categories-table .sort-header').forEach(button => {
      button.addEventListener('click', () => {
        const key = button.dataset.sort;
        if (!key) return;
        const direction = this.currentSort.key === key && this.currentSort.direction === 'asc' ? 'desc' : 'asc';
        this.currentSort = { key, direction };
        if (this.diffResult) this.renderCategoriesTable(this.diffResult.catDiff);
      });
    });

    // Global search
    const globalSearch = document.getElementById('global-search');
    if (globalSearch) {
      globalSearch.addEventListener('input', debounce(e => {
        const q = e.target.value.trim();
        if (this.diffResult) this.renderSearchResults(q, this.diffResult);
        if (q.length > 1) {
          document.getElementById('search-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 300));
    }

    // Tree controls
    document.getElementById('tree-expand-all').addEventListener('click', () => this.treeSetAll(false));
    document.getElementById('tree-collapse-all').addEventListener('click', () => this.treeSetAll(true));
    document.getElementById('tree-search').addEventListener('input', debounce(e => {
      this.treeFilter(e.target.value.trim().toLowerCase());
    }, 250));

    // Product upload
    const uploadArea = document.getElementById('upload-area');
    const fileInput  = document.getElementById('product-file');
    document.getElementById('upload-btn').addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('click', e => { if (e.target === uploadArea || e.target.tagName === 'P' || e.target.tagName === 'H3') fileInput.click(); });
    fileInput.addEventListener('change', e => { if (e.target.files[0]) this.handleProductUpload(e.target.files[0]); });
    uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
    uploadArea.addEventListener('drop', e => {
      e.preventDefault();
      uploadArea.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) this.handleProductUpload(e.dataTransfer.files[0]);
    });

    // Product export
    document.getElementById('product-export-btn').addEventListener('click', () => {
      if (this.productAnalysis && this.diffResult)
        ProductImpact.exportReport(this.productAnalysis, App.state.vA, App.state.vB);
    });

    // Scroll spy
    this.initScrollSpy();

    // Export bar
    document.getElementById('export-bar').addEventListener('click', e => {
      const btn = e.target.closest('.btn-export');
      if (!btn) return;
      if (!this.diffResult) { showToast('Run a comparison first.', 'warning'); return; }
      ExportLayer.export(btn.dataset.format, this.diffResult, this.report, App.state.vA, App.state.vB);
    });
  },

  initScrollSpy() {
    const sections = document.querySelectorAll('.content-section');
    const links = document.querySelectorAll('.sidebar-link');
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          links.forEach(l => l.classList.toggle('active', l.dataset.section === id));
        }
      }
    }, { rootMargin: '-60px 0px -60% 0px', threshold: 0 });
    sections.forEach(s => observer.observe(s));
  },

  renderAll(diffResult, report, vA, vB) {
    this.diffResult = diffResult;
    this.report = report;
    const { catDiff, attrDiff, summary } = diffResult;

    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('results').style.display = 'block';
    document.getElementById('export-bar').style.display = 'flex';

    document.getElementById('compare-meta').textContent = vA + ' → ' + vB;
    document.getElementById('meta-versions').textContent = vA + ' → ' + vB;
    document.getElementById('meta-total').textContent = summary.totalChanges.toLocaleString();
    document.getElementById('meta-impact').textContent = report.impactLevel.icon + ' ' + report.impactLevel.level;

    this.renderSummaryCards(summary);
    this.renderAIInsight(report);
    this.renderCategoriesTable(catDiff);
    this.renderAttributesSection(attrDiff, diffResult.snapA, diffResult.snapB);
    this.renderTree(catDiff, diffResult.snapA, diffResult.snapB);
    this.renderImpactAnalysis(report);
    this.renderMigration(report);
    this.renderSearchResults('', diffResult);

    // Update sidebar badges
    document.getElementById('sidebar-cat-count').textContent = catDiff.all.length || '';
    document.getElementById('sidebar-attr-count').textContent =
      (attrDiff.added.length + attrDiff.removed.length + attrDiff.modified.length) || '';
  },

  renderSummaryCards(summary) {
    const cards = [
      { label:'Categories Added',    value:summary.catsAdded,    type:'added',    icon:'➕', pct:summary.pctAdded },
      { label:'Categories Removed',  value:summary.catsRemoved,  type:'removed',  icon:'➖', pct:summary.pctRemoved },
      { label:'Categories Renamed',  value:summary.catsRenamed,  type:'renamed',  icon:'↩',  pct:'' },
      { label:'Categories Moved',    value:summary.catsMoved,    type:'moved',    icon:'↕',  pct:'' },
      { label:'Categories Modified', value:summary.catsModified, type:'modified', icon:'~',  pct:'' },
      { label:'Attrs Added',         value:summary.attrsAdded,   type:'added',    icon:'➕', pct:'' },
      { label:'Attrs Removed',       value:summary.attrsRemoved, type:'removed',  icon:'➖', pct:'' },
      { label:'Assignment Changes',  value:summary.assignmentChanges, type:'neutral', icon:'🔄', pct:'' }
    ];
    const container = document.getElementById('stat-cards');
    container.innerHTML = '';
    for (const card of cards) {
      const el = document.createElement('div');
      el.className = 'stat-card ' + card.type;
      el.innerHTML =
        '<div class="stat-card-icon">' + card.icon + '</div>' +
        '<div class="stat-card-value" data-target="' + card.value + '">0</div>' +
        '<div class="stat-card-label">' + card.label + '</div>' +
        (card.pct ? '<div class="stat-card-pct">' + card.pct + '</div>' : '');
      container.appendChild(el);
      countUp(el.querySelector('.stat-card-value'), card.value);
    }
  },

  renderAIInsight(report) {
    const el = document.getElementById('ai-insight');
    el.innerHTML =
      '<div class="ai-insight-header">🤖 AI Analysis</div>' +
      '<div class="ai-insight-text">' +
      report.aiInsight.map(line => '<p>' + line + '</p>').join('') +
      '</div>';
  },

  filterCategories(catDiff) {
    let items = [];
    const f = this.currentFilter;
    if (f === 'all')      items = catDiff.all;
    else if (f === 'added')    items = catDiff.added;
    else if (f === 'removed')  items = catDiff.removed;
    else if (f === 'renamed')  items = catDiff.renamed;
    else if (f === 'moved')    items = catDiff.moved;
    else if (f === 'modified') items = catDiff.modified;

    if (this.currentSearch) {
      const q = this.currentSearch;
      items = items.filter(item => {
        const cat = item.catB || item.catA;
        return (cat.name||'').toLowerCase().includes(q) ||
               (cat.full_name||'').toLowerCase().includes(q) ||
               (cat.id||'').toLowerCase().includes(q) ||
               (item.catA && (item.catA.name||'').toLowerCase().includes(q));
      });
    }
    return this.sortCategories(items);
  },

  sortCategories(items) {
    const sorted = [...items];
    const direction = this.currentSort.direction === 'desc' ? -1 : 1;
    sorted.sort((a, b) => {
      const av = this.getCategorySortValue(a, this.currentSort.key);
      const bv = this.getCategorySortValue(b, this.currentSort.key);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
      return String(av).localeCompare(String(bv), undefined, { sensitivity: 'base', numeric: true }) * direction;
    });
    return sorted;
  },

  getCategorySortValue(item, key) {
    const cat = item.catB || item.catA || {};
    if (key === 'change') return item.type || '';
    if (key === 'name') return cat.name || '';
    if (key === 'impact') return Number(cat.level || 99);
    return cat.full_name || '';
  },

  updateCategorySortHeaders() {
    document.querySelectorAll('#categories-table .sort-header').forEach(button => {
      const isActive = button.dataset.sort === this.currentSort.key;
      const indicator = button.querySelector('.sort-indicator');
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-sort', isActive ? (this.currentSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
      if (indicator) indicator.textContent = isActive ? (this.currentSort.direction === 'asc' ? '▲' : '▼') : '↕';
    });
  },

  renderFilteredCategorySummary(items, totalCount) {
    const summaryEl = document.getElementById('category-filtered-summary');
    if (!summaryEl) return;

    const counts = items.reduce((acc, item) => {
      const cat = item.catB || item.catA || {};
      acc[item.type] = (acc[item.type] || 0) + 1;
      if (cat.level === 1) acc.high += 1;
      else if (cat.level === 2) acc.medium += 1;
      else acc.low += 1;
      return acc;
    }, { added: 0, removed: 0, renamed: 0, moved: 0, modified: 0, high: 0, medium: 0, low: 0 });

    const activeFilters = [];
    if (this.currentFilter !== 'all') activeFilters.push(changeLabel(this.currentFilter).replace(/^[+−↩↕~]\s*/, ''));
    if (this.currentSearch) activeFilters.push('Search: "' + esc(this.currentSearch) + '"');
    const filterText = activeFilters.length ? activeFilters.join(' · ') : 'All category changes';
    const cards = [
      { label: 'Visible Changes', value: items.length.toLocaleString() },
      { label: 'Added', value: counts.added.toLocaleString() },
      { label: 'Removed', value: counts.removed.toLocaleString() },
      { label: 'Renamed', value: counts.renamed.toLocaleString() },
      { label: 'Moved', value: counts.moved.toLocaleString() },
      { label: 'Modified', value: counts.modified.toLocaleString() },
      { label: 'High Impact', value: counts.high.toLocaleString() },
      { label: 'Medium Impact', value: counts.medium.toLocaleString() },
      { label: 'Low Impact', value: counts.low.toLocaleString() }
    ];

    summaryEl.innerHTML = cards.map(card =>
      '<div class="filtered-summary-card">' +
        '<div class="filtered-summary-label">' + esc(card.label) + '</div>' +
        '<div class="filtered-summary-value">' + card.value + '</div>' +
      '</div>'
    ).join('') +
      '<div class="filtered-summary-note">Filtered summary for ' + esc(filterText) +
      ' · ' + items.length.toLocaleString() + ' of ' + totalCount.toLocaleString() + ' category changes shown</div>';
  },

  renderCategoriesTable(catDiff) {
    const items = this.filterCategories(catDiff);
    const tbody = document.getElementById('categories-tbody');
    const footer = document.getElementById('cat-table-footer');

    this.updateCategorySortHeaders();
    this.renderFilteredCategorySummary(items, catDiff.all.length);

    const BATCH = 100;
    let rendered = 0;

    const renderBatch = () => {
      const fragment = document.createDocumentFragment();
      const end = Math.min(rendered + BATCH, items.length);
      for (let i = rendered; i < end; i++) {
        const item = items[i];
        const cat  = item.catB || item.catA;
        const catA = item.catA;
        const catB = item.catB;

        const tr = document.createElement('tr');
        tr.dataset.idx = i;

        const nameCellContent = (() => {
          if (item.type === 'renamed')
            return esc(catA.name) + ' <span style="color:var(--text-muted)">→</span> <strong>' + esc(catB.name) + '</strong>';
          return esc(cat.name);
        })();

        const pathCellContent = (() => {
          if ((item.type === 'renamed' || item.type === 'moved') && catA && catB && catA.full_name !== catB.full_name)
            return '<span class="path-old">' + esc(catA.full_name) + '</span><br>' +
                   '<span class="path-new">' + esc(catB.full_name) + '</span>';
          return esc(cat.full_name || '');
        })();

        const impact = cat.level === 1 ? 'High' : cat.level === 2 ? 'Medium' : 'Low';
        const impactClass = cat.level === 1 ? 'badge-high' : cat.level === 2 ? 'badge-medium' : 'badge-low';

        tr.innerHTML =
          '<td><span class="badge badge-' + item.type + '">' + changeLabel(item.type) + '</span></td>' +
          '<td>' + nameCellContent + '</td>' +
          '<td style="font-size:11px;font-family:var(--font-mono)">' + pathCellContent + '</td>' +
          '<td><span class="badge ' + impactClass + '">' + impact + '</span></td>';

        // Expandable detail row
        const detail = document.createElement('tr');
        detail.className = 'detail-row';
        const detailTd = document.createElement('td');
        detailTd.colSpan = 4;
        detailTd.className = 'row-detail';
        detailTd.innerHTML = buildDetailHTML(item);
        detail.appendChild(detailTd);

        tr.addEventListener('click', () => {
          const isOpen = detailTd.classList.contains('open');
          document.querySelectorAll('.row-detail.open').forEach(d => {
            d.classList.remove('open');
            d.closest('tr').previousElementSibling && d.closest('tr').previousElementSibling.classList.remove('expanded');
          });
          if (!isOpen) {
            detailTd.classList.add('open');
            tr.classList.add('expanded');
          }
        });

        fragment.appendChild(tr);
        fragment.appendChild(detail);
      }
      tbody.appendChild(fragment);
      rendered = end;
      footer.textContent = 'Showing ' + Math.min(rendered, items.length) + ' of ' + items.length + ' changes';

      if (rendered < items.length) {
        footer.innerHTML += ' — <button class="btn btn-sm btn-outline" id="load-more-btn">Load more</button>';
        document.getElementById('load-more-btn').addEventListener('click', () => {
          renderBatch();
        });
      }
    };

    tbody.innerHTML = '';
    renderBatch();

    const countEl = document.getElementById('cat-section-count');
    if (countEl) {
      const filtered = this.currentFilter !== 'all' || Boolean(this.currentSearch);
      countEl.textContent = items.length + ' items' + (filtered ? ' (filtered)' : '');
    }
  },

  renderAttributesSection(attrDiff, snapA, snapB) {
    // Global attribute changes
    const tbody = document.getElementById('attributes-tbody');
    tbody.innerHTML = '';
    const allAttrChanges = [...attrDiff.added, ...attrDiff.removed, ...attrDiff.modified];
    if (allAttrChanges.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:20px">No global attribute changes detected</td></tr>';
    }
    for (const item of allAttrChanges) {
      const attr = item.attrB || item.attrA;
      const tr = document.createElement('tr');
      const vAdded   = (item.valuesAdded   || []).map(v => v.name).join(', ') || '—';
      const vRemoved = (item.valuesRemoved || []).map(v => v.name).join(', ') || '—';
      tr.innerHTML =
        '<td><span class="badge badge-' + item.type + '">' + changeLabel(item.type) + '</span></td>' +
        '<td><strong>' + esc(attr.name) + '</strong><br><span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">' + esc(attr.id) + '</span></td>' +
        '<td style="color:var(--color-added);font-size:12px">' + esc(vAdded) + '</td>' +
        '<td style="color:var(--color-removed);font-size:12px">' + esc(vRemoved) + '</td>';
      tbody.appendChild(tr);
    }

    const attrCount = document.getElementById('attr-section-count');
    if (attrCount) attrCount.textContent = allAttrChanges.length + ' attribute changes, ' + attrDiff.categoryAssignmentChanges.length + ' assignment changes';

    // Category assignment changes
    const atbody = document.getElementById('assignments-tbody');
    atbody.innerHTML = '';
    if (attrDiff.categoryAssignmentChanges.length === 0) {
      atbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:20px">No category assignment changes detected</td></tr>';
    }
    for (const ch of attrDiff.categoryAssignmentChanges.slice(0, 200)) {
      const cat = ch.catB || ch.catA;
      const impact = cat.level === 1 ? 'badge-high' : cat.level === 2 ? 'badge-medium' : 'badge-low';
      const impactLabel = cat.level === 1 ? 'High' : cat.level === 2 ? 'Medium' : 'Low';
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><strong>' + esc(cat.name) + '</strong><br><span style="font-size:11px;color:var(--text-muted)">' + esc(cat.full_name) + '</span></td>' +
        '<td style="color:var(--color-added);font-size:12px">' + ch.attrAdded.map(a=>esc(a.name)).join(', ') + '</td>' +
        '<td style="color:var(--color-removed);font-size:12px">' + ch.attrRemoved.map(a=>esc(a.name)).join(', ') + '</td>' +
        '<td><span class="badge ' + impact + '">' + impactLabel + '</span></td>';
      atbody.appendChild(tr);
    }
  },

  // ── TREE VIEW ────────────────────────────────────────────────
  treeData: null,

  renderTree(catDiff, snapA, snapB) {
    const changeMap = new Map();
    for (const item of catDiff.all) {
      const id = item.catB ? item.catB.id : item.catA ? item.catA.id : null;
      if (id) changeMap.set(id, item.type);
    }
    // Build tree from snapB (with removed from snapA added as ghost nodes)
    const allCats = [...snapB.categories];
    for (const item of catDiff.removed) if (item.catA) allCats.push(item.catA);

    // Build parent->children map
    const childMap = new Map();
    const roots = [];
    for (const cat of allCats) {
      const pid = cat.parent_id;
      if (!pid) { roots.push(cat); continue; }
      if (!childMap.has(pid)) childMap.set(pid, []);
      childMap.get(pid).push(cat);
    }

    this.treeData = { roots, childMap, changeMap };
    const container = document.getElementById('tree-container');
    container.innerHTML = '';
    for (const root of roots.slice(0, 50)) {
      container.appendChild(this.buildTreeNode(root, childMap, changeMap, 0));
    }
    if (roots.length > 50) {
      const note = document.createElement('div');
      note.style.cssText = 'padding:8px;color:var(--text-muted);font-size:12px';
      note.textContent = '… and ' + (roots.length - 50) + ' more root nodes. Use search to filter.';
      container.appendChild(note);
    }
  },

  buildTreeNode(cat, childMap, changeMap, depth) {
    const changeType = changeMap.get(cat.id) || 'unchanged';
    const children   = childMap.get(cat.id) || [];
    const hasChildren = children.length > 0;

    const node = document.createElement('div');
    node.className = 'tree-node';
    node.dataset.catId = cat.id;
    node.dataset.catName = (cat.name || '').toLowerCase();

    const row = document.createElement('div');
    row.className = 'tree-node-row';

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle' + (hasChildren ? '' : ' leaf');
    toggle.textContent = '▶';

    const badge = changeLabel(changeType, true);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-node-name ' + changeType;
    nameSpan.innerHTML = esc(cat.name) + (badge ? ' <span class="tree-node-badge">' + badge + '</span>' : '');

    row.appendChild(toggle);
    row.appendChild(nameSpan);
    node.appendChild(row);

    if (hasChildren) {
      const childWrap = document.createElement('div');
      childWrap.className = 'tree-children hidden';
      let childrenRendered = false;

      toggle.addEventListener('click', e => {
        e.stopPropagation();
        const isOpen = toggle.classList.contains('open');
        if (!isOpen && !childrenRendered) {
          for (const child of children) childWrap.appendChild(this.buildTreeNode(child, childMap, changeMap, depth+1));
          childrenRendered = true;
        }
        toggle.classList.toggle('open', !isOpen);
        childWrap.classList.toggle('hidden', isOpen);
      });
      row.addEventListener('click', e => { if (e.target !== toggle) toggle.click(); });
      node.appendChild(childWrap);
    }
    return node;
  },

  treeSetAll(collapse) {
    document.querySelectorAll('#tree-container .tree-toggle:not(.leaf)').forEach(t => {
      t.classList.toggle('open', !collapse);
    });
    document.querySelectorAll('#tree-container .tree-children').forEach(c => {
      c.classList.toggle('hidden', collapse);
    });
  },

  treeFilter(query) {
    document.querySelectorAll('#tree-container .tree-node').forEach(node => {
      const name = node.dataset.catName || '';
      const match = !query || name.includes(query);
      node.querySelectorAll('.tree-node-row').forEach(row => row.classList.toggle('match-highlight', !!query && match));
    });
  },

  renderImpactAnalysis(report) {
    const banner = document.getElementById('impact-level-banner');
    const lvl = report.impactLevel;
    banner.className = 'impact-banner ' + lvl.color;
    banner.innerHTML = lvl.icon + ' <strong>' + lvl.level + ' IMPACT</strong> — ' + lvl.total.toLocaleString() + ' total changes across categories and attributes.';

    // SVG bar chart
    const chart = document.getElementById('impact-chart');
    chart.innerHTML = '';
    const max = report.domains[0] ? report.domains[0].count : 1;
    for (const d of report.domains) {
      const pct = Math.max(4, (d.count / max) * 100);
      const row = document.createElement('div');
      row.className = 'chart-bar-row';
      row.innerHTML =
        '<div class="chart-label" title="' + esc(d.domain) + '">' + esc(d.domain) + '</div>' +
        '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="chart-value">' + d.count + '</div>';
      chart.appendChild(row);
    }
    if (report.domains.length === 0) chart.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No domain data available</p>';

    // Narrative
    document.getElementById('impact-narrative').innerHTML =
      report.narrative.map(p => '<p>' + p + '</p>').join('');
  },

  renderMigration(report) {
    const grid = document.getElementById('migration-grid');
    grid.innerHTML = '';
    const count = document.getElementById('migration-count');
    if (count) count.textContent = report.migrationCards.length + ' removed categories';

    if (report.migrationCards.length === 0) {
      grid.innerHTML = '<p style="color:var(--text-muted)">No removed categories — no migration needed.</p>';
      return;
    }
    for (const card of report.migrationCards) {
      const el = document.createElement('div');
      el.className = 'migration-card';
      const suggestionsHTML = card.suggestions.length
        ? card.suggestions.map((s, i) =>
            '<div class="migration-suggestion">' +
            '<span class="suggestion-rank">' + (i+1) + '</span>' +
            '<span class="suggestion-name">' + esc(s.name) + '</span>' +
            '<span class="suggestion-score">' + Math.round(s.score * 100) + '% match</span>' +
            '</div>'
          ).join('')
        : '<div class="migration-no-match">No similar category found</div>';

      el.innerHTML =
        '<div class="migration-card-header">' +
        '<h4>🗑 ' + esc(card.removed.name) + '</h4>' +
        '<p>' + esc(card.removed.full_name) + '</p>' +
        '</div>' +
        '<div class="migration-suggestions">' +
        (card.suggestions.length ? '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">SUGGESTED REPLACEMENTS</div>' : '') +
        suggestionsHTML +
        '</div>';
      grid.appendChild(el);
    }
  },

  renderSearchResults(query, diffResult) {
    const content = document.getElementById('search-results-content');
    const countEl = document.getElementById('search-count');
    if (!query || query.length < 2) {
      content.innerHTML = '<div class="search-empty"><p>Type at least 2 characters to search categories, attributes, and paths.</p></div>';
      if (countEl) countEl.textContent = '';
      return;
    }
    const q = query.toLowerCase();
    const catResults = [];
    const attrResults = [];

    for (const item of diffResult.catDiff.all) {
      const cat = item.catB || item.catA;
      if ((cat.name||'').toLowerCase().includes(q) || (cat.full_name||'').toLowerCase().includes(q) || (cat.id||'').toLowerCase().includes(q)) {
        catResults.push(item);
      }
    }
    for (const item of [...diffResult.attrDiff.added, ...diffResult.attrDiff.removed, ...diffResult.attrDiff.modified]) {
      const attr = item.attrB || item.attrA;
      if ((attr.name||'').toLowerCase().includes(q)) attrResults.push(item);
    }

    const total = catResults.length + attrResults.length;
    if (countEl) countEl.textContent = total + ' results';

    let html = '';
    if (catResults.length) {
      html += '<div class="search-group"><div class="search-group-header">Categories (' + catResults.length + ')</div>';
      for (const item of catResults.slice(0, 50)) {
        const cat = item.catB || item.catA;
        html += '<div class="search-result-item">' +
          '<div class="search-result-main">' +
          '<div class="search-result-name">' + highlight(cat.name||'', q) + '</div>' +
          '<div class="search-result-path">' + highlight(cat.full_name||'', q) + '</div>' +
          '</div>' +
          '<div class="search-result-diff"><span class="badge badge-' + item.type + '">' + changeLabel(item.type) + '</span></div>' +
          '</div>';
      }
      if (catResults.length > 50) html += '<p style="color:var(--text-muted);font-size:12px;padding:8px">… and ' + (catResults.length-50) + ' more</p>';
      html += '</div>';
    }
    if (attrResults.length) {
      html += '<div class="search-group"><div class="search-group-header">Attributes (' + attrResults.length + ')</div>';
      for (const item of attrResults.slice(0, 30)) {
        const attr = item.attrB || item.attrA;
        html += '<div class="search-result-item">' +
          '<div class="search-result-main"><div class="search-result-name">' + highlight(attr.name||'', q) + '</div></div>' +
          '<div class="search-result-diff"><span class="badge badge-' + item.type + '">' + changeLabel(item.type) + '</span></div>' +
          '</div>';
      }
      html += '</div>';
    }
    if (!html) html = '<div class="search-empty"><p>No results found for "<strong>' + esc(query) + '</strong>"</p></div>';
    content.innerHTML = html;
  },

  handleProductUpload(file) {
    const reader = new FileReader();
    reader.onload = e => {
      const products = ProductImpact.parseCSV(e.target.result);
      if (!products.length) { showToast('No valid rows found in CSV', 'warning'); return; }
      if (!this.diffResult) { showToast('Run a comparison first', 'warning'); return; }
      this.productAnalysis = ProductImpact.analyze(products, this.diffResult);
      this.renderProductImpact(this.productAnalysis);
    };
    reader.readAsText(file);
  },

  productAnalysis: null,

  renderProductImpact(analysis) {
    document.getElementById('upload-area').style.display = 'none';
    document.getElementById('product-results').style.display = 'block';

    const cards = document.getElementById('product-stat-cards');
    const stats = [
      { label:'Total Products',    value:analysis.summary.total,      type:'neutral', icon:'📦' },
      { label:'Unaffected',        value:analysis.summary.unaffected,  type:'added',   icon:'✅' },
      { label:'Removed Category',  value:analysis.summary.removed,     type:'removed', icon:'🗑' },
      { label:'Needs Review',      value:analysis.summary.needsReview, type:'modified',icon:'⚠️' }
    ];
    cards.innerHTML = '';
    for (const s of stats) {
      const el = document.createElement('div');
      el.className = 'stat-card ' + s.type;
      el.innerHTML = '<div class="stat-card-icon">' + s.icon + '</div>' +
        '<div class="stat-card-value" data-target="' + s.value + '">0</div>' +
        '<div class="stat-card-label">' + s.label + '</div>';
      cards.appendChild(el);
      countUp(el.querySelector('.stat-card-value'), s.value);
    }

    const tbody = document.getElementById('product-tbody');
    tbody.innerHTML = '';
    for (const p of analysis.affected.slice(0, 500)) {
      const tr = document.createElement('tr');
      const badgeClass = p.status === 'removed_category' ? 'removed' : p.status === 'renamed_category' ? 'renamed' : 'modified';
      tr.innerHTML =
        '<td style="font-family:var(--font-mono);font-size:12px">' + esc(p.product_id) + '</td>' +
        '<td>' + esc(p.title) + '</td>' +
        '<td style="font-family:var(--font-mono);font-size:11px">' + esc(p.shopify_category_id) + '</td>' +
        '<td><span class="badge badge-' + badgeClass + '">' + esc(p.status.replace(/_/g,' ')) + '</span></td>' +
        '<td style="font-size:12px">' + esc(p.action) + '</td>';
      tbody.appendChild(tr);
    }
    if (analysis.affected.length > 500) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="5" style="text-align:center;color:var(--text-muted);padding:12px">… and ' + (analysis.affected.length-500) + ' more. Export CSV for full report.</td>';
      tbody.appendChild(tr);
    }
  }
};


/* ─────────────────────────────────────────────────────────────
   MODULE 5: ExportLayer
   CSV, JSON, HTML Report, XLSX exports
───────────────────────────────────────────────────────────── */
const ExportLayer = {
  export(format, diffResult, report, vA, vB) {
    switch (format) {
      case 'csv':  this.toCSV(diffResult, vA, vB);  break;
      case 'json': this.toJSON(diffResult, report, vA, vB); break;
      case 'html': this.toHTMLReport(diffResult, report, vA, vB); break;
      case 'xlsx': this.toXLSX(diffResult, report, vA, vB); break;
    }
  },

  toCSV(diffResult, vA, vB) {
    const { catDiff, attrDiff } = diffResult;
    const rows = [['change_type','category_id','old_name','new_name','old_path','new_path','level','impact']];
    for (const item of catDiff.all) {
      const catA = item.catA || {};
      const catB = item.catB || {};
      const cat  = catB.id ? catB : catA;
      const impact = cat.level === 1 ? 'High' : cat.level === 2 ? 'Medium' : 'Low';
      rows.push([
        item.type,
        cat.id || '',
        catA.name || '',
        catB.name || '',
        catA.full_name || '',
        catB.full_name || '',
        cat.level || '',
        impact
      ]);
    }
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\n');
    this.downloadBlob(csv, 'taxonomy-diff-categories-' + vA + '-to-' + vB + '.csv', 'text/csv');
    showToast('Categories CSV downloaded', 'success');
  },

  toJSON(diffResult, report, vA, vB) {
    const exportData = {
      meta: { source: vA, target: vB, exportedAt: new Date().toISOString() },
      summary: diffResult.summary,
      impactLevel: report.impactLevel.level,
      categories: {
        added:    diffResult.catDiff.added.map(e => ({ id: e.catB.id, name: e.catB.name, path: e.catB.full_name })),
        removed:  diffResult.catDiff.removed.map(e => ({ id: e.catA.id, name: e.catA.name, path: e.catA.full_name, suggestions: e.suggestions })),
        renamed:  diffResult.catDiff.renamed.map(e => ({ id: e.catB.id, oldName: e.catA.name, newName: e.catB.name })),
        moved:    diffResult.catDiff.moved.map(e => ({ id: e.catB.id, name: e.catB.name, oldPath: e.catA.full_name, newPath: e.catB.full_name })),
        modified: diffResult.catDiff.modified.map(e => ({ id: e.catB.id, name: e.catB.name }))
      },
      attributes: {
        added:    diffResult.attrDiff.added.map(e => ({ id: e.attrB.id, name: e.attrB.name })),
        removed:  diffResult.attrDiff.removed.map(e => ({ id: e.attrA.id, name: e.attrA.name })),
        modified: diffResult.attrDiff.modified.map(e => ({ id: e.attrB.id, name: e.attrB.name, valuesAdded: e.valuesAdded, valuesRemoved: e.valuesRemoved }))
      }
    };
    this.downloadBlob(JSON.stringify(exportData, null, 2), 'taxonomy-diff-' + vA + '-to-' + vB + '.json', 'application/json');
    showToast('JSON downloaded', 'success');
  },

  toHTMLReport(diffResult, report, vA, vB) {
    const { summary, catDiff, attrDiff } = diffResult;
    const catRows = catDiff.all.slice(0, 1000).map(item => {
      const cat = item.catB || item.catA;
      const catA = item.catA || {};
      const catB = item.catB || {};
      return '<tr><td>' + item.type + '</td><td>' + esc(catA.name||'') + '</td><td>' + esc(catB.name||'') + '</td><td>' + esc(catA.full_name||catB.full_name||'') + '</td></tr>';
    }).join('');

    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Taxonomy Diff Report: ' + vA + ' → ' + vB + '</title>' +
    '<style>body{font-family:system-ui,sans-serif;max-width:1200px;margin:0 auto;padding:24px;color:#0f172a}' +
    'h1{color:#008060}h2{border-bottom:2px solid #e2e8f0;padding-bottom:8px;margin-top:32px}' +
    '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:16px 0}' +
    '.card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center}' +
    '.card .val{font-size:28px;font-weight:800;margin:4px 0}.added{color:#16a34a}.removed{color:#dc2626}' +
    '.renamed{color:#7c3aed}.moved{color:#d97706}.modified{color:#ea580c}' +
    'table{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}' +
    'th{background:#f1f5f9;padding:8px 12px;text-align:left;border-bottom:1px solid #e2e8f0;font-size:11px;text-transform:uppercase}' +
    'td{padding:8px 12px;border-bottom:1px solid #e2e8f0}tr:nth-child(even){background:#f8fafc}' +
    '.insight{background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px;margin:16px 0}' +
    '</style></head><body>' +
    '<h1>Shopify Taxonomy Diff Report</h1>' +
    '<p><strong>Source:</strong> ' + vA + ' &rarr; <strong>Target:</strong> ' + vB + ' &nbsp;|&nbsp; Generated: ' + new Date().toLocaleString() + '</p>' +
    '<div class="insight">' + report.aiInsight.map(l=>'<p>'+l+'</p>').join('') + '</div>' +
    '<h2>Summary</h2>' +
    '<div class="grid">' +
    '<div class="card"><div>Categories Added</div><div class="val added">' + summary.catsAdded + '</div></div>' +
    '<div class="card"><div>Categories Removed</div><div class="val removed">' + summary.catsRemoved + '</div></div>' +
    '<div class="card"><div>Renamed</div><div class="val renamed">' + summary.catsRenamed + '</div></div>' +
    '<div class="card"><div>Moved</div><div class="val moved">' + summary.catsMoved + '</div></div>' +
    '<div class="card"><div>Modified</div><div class="val modified">' + summary.catsModified + '</div></div>' +
    '<div class="card"><div>Attrs Added</div><div class="val added">' + summary.attrsAdded + '</div></div>' +
    '<div class="card"><div>Attrs Removed</div><div class="val removed">' + summary.attrsRemoved + '</div></div>' +
    '<div class="card"><div>Assignment Changes</div><div class="val">' + summary.assignmentChanges + '</div></div>' +
    '</div>' +
    '<h2>Category Changes (' + catDiff.all.length + ')</h2>' +
    '<table><thead><tr><th>Type</th><th>Old Name</th><th>New Name</th><th>Path</th></tr></thead><tbody>' + catRows + '</tbody></table>' +
    (catDiff.all.length > 1000 ? '<p><em>Showing first 1000 of ' + catDiff.all.length + '</em></p>' : '') +
    '<h2>Migration Recommendations</h2>' +
    report.migrationCards.slice(0,50).map(c =>
      '<p><strong style="color:#dc2626">' + esc(c.removed.name) + '</strong> → ' +
      (c.suggestions.length ? c.suggestions.map(s=>esc(s.name)+' ('+Math.round(s.score*100)+'%)').join(', ') : 'No match') + '</p>'
    ).join('') +
    '</body></html>';

    this.downloadBlob(html, 'taxonomy-diff-report-' + vA + '-to-' + vB + '.html', 'text/html');
    showToast('HTML Report downloaded', 'success');
  },

  toXLSX(diffResult, report, vA, vB) {
    if (typeof XLSX === 'undefined') {
      showToast('Excel library not loaded. Downloading CSV instead.', 'warning');
      this.toCSV(diffResult, vA, vB);
      return;
    }
    const wb = XLSX.utils.book_new();

    // Summary sheet
    const summaryData = [
      ['Shopify Taxonomy Diff Report'],
      ['Source Version', vA],
      ['Target Version', vB],
      ['Generated', new Date().toLocaleString()],
      [],
      ['Metric', 'Count'],
      ['Categories Added', diffResult.summary.catsAdded],
      ['Categories Removed', diffResult.summary.catsRemoved],
      ['Categories Renamed', diffResult.summary.catsRenamed],
      ['Categories Moved', diffResult.summary.catsMoved],
      ['Categories Modified', diffResult.summary.catsModified],
      ['Attributes Added', diffResult.summary.attrsAdded],
      ['Attributes Removed', diffResult.summary.attrsRemoved],
      ['Assignment Changes', diffResult.summary.assignmentChanges],
      ['Total Changes', diffResult.summary.totalChanges],
      ['Impact Level', report.impactLevel.level]
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Summary');

    // Categories sheet
    const catHeader = ['change_type','category_id','old_name','new_name','old_path','new_path','level'];
    const catData = [catHeader, ...diffResult.catDiff.all.map(item => {
      const catA = item.catA || {};
      const catB = item.catB || {};
      const cat  = catB.id ? catB : catA;
      return [item.type, cat.id||'', catA.name||'', catB.name||'', catA.full_name||'', catB.full_name||'', cat.level||''];
    })];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(catData), 'Categories');

    // Attributes sheet
    const attrHeader = ['change_type','attribute_id','attribute_name','values_added','values_removed'];
    const attrData = [attrHeader, ...[...diffResult.attrDiff.added, ...diffResult.attrDiff.removed, ...diffResult.attrDiff.modified].map(item => {
      const attr = item.attrB || item.attrA;
      return [item.type, attr.id||'', attr.name||'', (item.valuesAdded||[]).map(v=>v.name).join('; '), (item.valuesRemoved||[]).map(v=>v.name).join('; ')];
    })];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(attrData), 'Attributes');

    // Migration sheet
    const migHeader = ['removed_id','removed_name','removed_path','suggestion_1','score_1','suggestion_2','score_2'];
    const migData = [migHeader, ...report.migrationCards.map(c => [
      c.removed.id, c.removed.name, c.removed.full_name,
      c.suggestions[0]?.name||'', c.suggestions[0] ? Math.round(c.suggestions[0].score*100)+'%' : '',
      c.suggestions[1]?.name||'', c.suggestions[1] ? Math.round(c.suggestions[1].score*100)+'%' : ''
    ])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(migData), 'Migration');

    XLSX.writeFile(wb, 'taxonomy-diff-' + vA + '-to-' + vB + '.xlsx');
    showToast('Excel file downloaded', 'success');
  },

  downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
};

/* ─────────────────────────────────────────────────────────────
   MODULE 6: ProductImpact
   Parse uploaded products CSV and cross-reference with diff
───────────────────────────────────────────────────────────── */
const ProductImpact = {
  parseCSV(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (!lines.length) return [];
    const headers = this.parseCSVRow(lines[0]).map(h => h.toLowerCase().trim());
    const idCol    = headers.indexOf('product_id');
    const titleCol = headers.indexOf('title');
    const catCol   = headers.findIndex(h => h.includes('category'));
    if (catCol === -1) return [];
    const products = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = this.parseCSVRow(lines[i]);
      products.push({
        product_id:          cols[idCol]  || String(i),
        title:               cols[titleCol] || '',
        shopify_category_id: cols[catCol] || ''
      });
    }
    return products;
  },

  parseCSVRow(line) {
    const result = [];
    let inQuotes = false, current = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  },

  analyze(products, diffResult) {
    const removedIds  = new Set(diffResult.catDiff.removed.map(e => e.catA && e.catA.id).filter(Boolean));
    const renamedMap  = new Map(diffResult.catDiff.renamed.map(e => [e.catA.id, e.catB]));
    const modifiedIds = new Set(diffResult.catDiff.modified.map(e => e.catB.id));
    const assignChangeIds = new Set(diffResult.attrDiff.categoryAssignmentChanges.map(c => c.catB.id));

    const affected = [];
    let unaffected = 0, removedCount = 0, needsReview = 0;

    for (const p of products) {
      const cid = p.shopify_category_id;
      if (removedIds.has(cid)) {
        removedCount++;
        const suggestions = diffResult.catDiff.removed.find(e => e.catA && e.catA.id === cid)?.suggestions || [];
        affected.push({ ...p, status: 'removed_category', action: suggestions.length ? 'Suggested: ' + suggestions[0].name : 'Manual recategorisation required' });
      } else if (renamedMap.has(cid)) {
        needsReview++;
        const newCat = renamedMap.get(cid);
        affected.push({ ...p, status: 'renamed_category', action: 'Category renamed to: ' + newCat.name });
      } else if (modifiedIds.has(cid) || assignChangeIds.has(cid)) {
        needsReview++;
        affected.push({ ...p, status: 'attribute_changes', action: 'Attribute assignments changed — review enrichment data' });
      } else {
        unaffected++;
      }
    }

    return {
      summary: { total: products.length, unaffected, removed: removedCount, needsReview },
      affected
    };
  },

  exportReport(analysis, vA, vB) {
    const rows = [['product_id','title','shopify_category_id','status','recommended_action']];
    for (const p of analysis.affected) {
      rows.push([p.product_id, p.title, p.shopify_category_id, p.status, p.action]);
    }
    const csv = rows.map(r => r.map(v => '"' + String(v||'').replace(/"/g,'""') + '"').join(',')).join('\n');
    ExportLayer.downloadBlob(csv, 'product-impact-' + vA + '-to-' + vB + '.csv', 'text/csv');
    showToast('Product Impact CSV downloaded', 'success');
  }
};

/* ─────────────────────────────────────────────────────────────
   UTILITY FUNCTIONS
───────────────────────────────────────────────────────────── */
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlight(text, query) {
  if (!query) return esc(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return esc(text);
  return esc(text.slice(0, idx)) + '<mark>' + esc(text.slice(idx, idx + query.length)) + '</mark>' + esc(text.slice(idx + query.length));
}

function changeLabel(type, short = false) {
  const labels = {
    added:    short ? '+' : '+ Added',
    removed:  short ? '−' : '− Removed',
    renamed:  short ? '↩' : '↩ Renamed',
    moved:    short ? '↕' : '↕ Moved',
    modified: short ? '~' : '~ Modified',
    unchanged:short ? '' :  ''
  };
  return labels[type] || type;
}

function buildDetailHTML(item) {
  const catA = item.catA || {};
  const catB = item.catB || {};
  let html = '<div class="row-detail-grid">';
  if (catA.id || catB.id)     html += detail('Category ID', catB.id || catA.id);
  if (catA.name)               html += detail('Old Name', catA.name);
  if (catB.name && catB.name !== catA.name) html += detail('New Name', catB.name);
  if (catA.full_name)          html += detail('Old Path', catA.full_name);
  if (catB.full_name && catB.full_name !== catA.full_name) html += detail('New Path', catB.full_name);
  if (catA.parent_id !== catB.parent_id && (catA.parent_id || catB.parent_id))
    html += detail('Parent Changed', (catA.parent_id||'none') + ' → ' + (catB.parent_id||'none'));
  if (item.suggestions && item.suggestions.length)
    html += detail('Suggested Replacement', item.suggestions.map(s=>s.name+' ('+Math.round(s.score*100)+'%)').join(', '));
  html += '</div>';
  if (item.attrDetail) html += buildAttributeDetailHTML(item.attrDetail);
  return html;
}

function buildAttributeDetailHTML(attrDetail) {
  const addedCount = attrDetail.added.length;
  const removedCount = attrDetail.removed.length;
  return '<div class="attribute-detail">' +
    '<div class="attribute-detail-header">Attribute assignments changed · ' +
      '<span class="attribute-count added">+' + addedCount + ' added</span> ' +
      '<span class="attribute-count removed">−' + removedCount + ' removed</span>' +
    '</div>' +
    '<div class="attribute-columns">' +
      '<div class="attribute-column">' +
        '<h4>Old Attributes</h4>' +
        buildAttributeList(attrDetail.oldAttributes, false) +
      '</div>' +
      '<div class="attribute-column">' +
        '<h4>New Attributes</h4>' +
        buildAttributeList(attrDetail.newAttributes, true) +
      '</div>' +
    '</div>' +
  '</div>';
}

function buildAttributeList(attributes, showStatus) {
  if (!attributes.length) return '<p class="attribute-empty">No attributes</p>';
  return '<ul class="attribute-list">' + attributes.map(attr => {
    const statusClass = 'attribute-item ' + attr.status;
    const statusLabel = showStatus && attr.status !== 'unchanged'
      ? '<span class="attribute-status">' + (attr.status === 'added' ? '+ Added' : '− Removed') + '</span>'
      : '';
    return '<li class="' + statusClass + '"><span class="attribute-name">' + esc(attr.name) + '</span>' + statusLabel + '</li>';
  }).join('') + '</ul>';
}

function detail(label, value) {
  return '<div class="row-detail-item"><label>' + label + '</label><span>' + esc(value) + '</span></div>';
}

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function countUp(el, target, duration = 700) {
  if (!el || !target) return;
  const start = performance.now();
  const update = (now) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(eased * target).toLocaleString();
    if (progress < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

function showToast(message, type = 'info', duration = 4000) {
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.innerHTML = '<span class="toast-icon">' + (icons[type]||'ℹ️') + '</span>' +
    '<span class="toast-message">' + esc(message) + '</span>' +
    '<span class="toast-close">✕</span>';
  container.appendChild(toast);
  toast.addEventListener('click', () => toast.remove());
  setTimeout(() => toast.remove(), duration);
}

function setProgress(pct, message) {
  const bar = document.getElementById('progress-bar');
  const label = document.getElementById('progress-label');
  const msg   = document.getElementById('loading-message');
  if (bar)   bar.style.width   = pct + '%';
  if (label) label.textContent = pct + '%';
  if (msg && message) msg.textContent = message;
}

function showLoading(show) {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  if (show) {
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
    setTimeout(() => { overlay.style.display = 'none'; }, 300);
  }
}

/* ─────────────────────────────────────────────────────────────
   APP — Main orchestrator
───────────────────────────────────────────────────────────── */
const App = {
  state: {
    vA: '2025-03',
    vB: '2026-08',
    diffResult: null,
    report: null
  },

  async init() {
    // Apply saved theme before anything renders
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    document.getElementById('theme-icon').textContent = savedTheme === 'dark' ? '☀️' : '🌙';

    UILayer.init();

    // Load versions
    setProgress(5, 'Fetching available versions…');
    const versions = await DataLoader.fetchReleases();
    this.populateDropdowns(versions);

    // Set up auto-compare on dropdown change
    const selA = document.getElementById('version-a');
    const selB = document.getElementById('version-b');
    selA.addEventListener('change', () => { this.state.vA = selA.value; if (selA.value && selB.value) this.compare(); });
    selB.addEventListener('change', () => { this.state.vB = selB.value; if (selA.value && selB.value) this.compare(); });
    document.getElementById('compare-btn').addEventListener('click', () => this.compare());

    // Auto-compare with defaults
    if (this.state.vA && this.state.vB) {
      await this.compare();
    } else {
      showLoading(false);
    }
  },

  populateDropdowns(versions) {
    const selA = document.getElementById('version-a');
    const selB = document.getElementById('version-b');
    [selA, selB].forEach(sel => {
      sel.innerHTML = '';
      for (const v of versions) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
      }
    });
    // Set defaults
    const defaultA = this.state.vA;
    const defaultB = this.state.vB;
    if (versions.includes(defaultA)) selA.value = defaultA;
    else if (versions.length > 1) selA.value = versions[versions.length - 2];
    if (versions.includes(defaultB)) selB.value = defaultB;
    else selB.value = versions[0];
    this.state.vA = selA.value;
    this.state.vB = selB.value;
  },

  async compare() {
    const vA = this.state.vA;
    const vB = this.state.vB;
    if (!vA || !vB) { showToast('Please select both versions', 'warning'); return; }

    const btn = document.getElementById('compare-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Comparing…';

    showLoading(true);
    document.getElementById('loading-overlay').style.display = 'flex';
    setProgress(0, 'Starting comparison…');

    try {
      setProgress(15, 'Fetching ' + vA + ' taxonomy…');
      const snapA = await DataLoader.fetchVersion(vA);

      setProgress(45, 'Fetching ' + vB + ' taxonomy…');
      const snapB = await DataLoader.fetchVersion(vB);

      setProgress(70, 'Running diff engine…');
      // Yield to browser to allow progress bar to render
      await new Promise(r => setTimeout(r, 30));
      const diffResult = DiffEngine.compare(snapA, snapB);
      this.state.diffResult = diffResult;

      setProgress(85, 'Generating report…');
      await new Promise(r => setTimeout(r, 20));
      const report = ReportGenerator.generate(diffResult, vA, vB);
      this.state.report = report;

      setProgress(95, 'Rendering…');
      await new Promise(r => setTimeout(r, 20));
      UILayer.renderAll(diffResult, report, vA, vB);

      setProgress(100, 'Done!');
      await new Promise(r => setTimeout(r, 400));
      showLoading(false);
      document.getElementById('summary').scrollIntoView({ behavior: 'smooth' });
      showToast(diffResult.summary.totalChanges.toLocaleString() + ' changes found between ' + vA + ' and ' + vB, 'success');
    } catch (err) {
      showLoading(false);
      console.error('Compare error:', err);
      let msg = err.message || 'Unknown error';
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError'))
        msg = 'Network error. Check your internet connection and try again.';
      else if (msg.includes('HTTP 404'))
        msg = 'Version data not found. This version may not have a categories.json endpoint.';
      else if (msg.includes('HTTP 403'))
        msg = 'GitHub API rate limit hit. Using fallback version list. Please try again in a minute.';
      showToast(msg, 'error', 8000);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg> Compare';
    }
  }
};

/* ─────────────────────────────────────────────────────────────
   ENTRY POINT
───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => App.init());
