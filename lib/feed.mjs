import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runCore } from './core.mjs';
import { fetchBulk, MODES } from './bulk.mjs';

export const REFRESH_MS = 5 * 60 * 1000;
export const STALE_MS = 15 * 60 * 1000;
const HQ = 'https://tarkovhq.dev/api/data';
const QUERY = `query Storage($mode: GameMode!) {
  rigs: items(type:rig, gameMode:$mode) { ...StorageItem }
  backpacks: items(type:backpack, gameMode:$mode) { ...StorageItem }
  cases: items(type:container, gameMode:$mode) { ...StorageItem }
}
fragment StorageItem on Item {
 id name shortName description width height weight types iconLink image512pxLink wikiLink updated
 lastLowPrice avg24hPrice
 buyFor { price currency priceRUB vendor { name ... on TraderOffer { minTraderLevel taskUnlock { name } } } }
 properties {
  __typename
  ... on ItemPropertiesBackpack { capacity grids { ...StorageGrid } }
  ... on ItemPropertiesChestRig { capacity class armorSlots { name } grids { ...StorageGrid } }
  ... on ItemPropertiesContainer { capacity grids { ...StorageGrid } }
 }
}
fragment StorageGrid on ItemStorageGrid {
 width height filters {
  allowedItems { id name } excludedItems { id name }
  allowedCategories { id name } excludedCategories { id name }
 }
}`;

export async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await fn(values[index], index);
    }
  }));
  return results;
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(18000), headers: {
    'Accept': 'application/json', 'User-Agent': 'Stashwise/0.1 storage-comparison', ...options.headers,
  } });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  const limit = 24 * 1024 * 1024;
  if (length > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Provider response is too large');
  }
  // Content-Length may be absent or describe compressed bytes. Bound the
  // decoded stream before buffering or parsing JSON, regardless of headers.
  if (!response.body) throw new Error('Provider response is empty');
  const reader = response.body.getReader(), parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Provider response is too large');
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(parts, size)));
}

async function fetchPrimary(mode, fetcher) {
  const result = await fetcher('https://api.tarkov.dev/graphql', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { mode: mode === 'pve' ? 'pve' : 'regular' } }),
  });
  if (result.errors || !result.data) throw new Error('Primary item feed is unavailable');
  const rows = ['rigs', 'backpacks', 'cases'].flatMap(key => {
    if (!Array.isArray(result.data[key]) || !result.data[key].length) throw new Error('Incomplete primary catalogue');
    return result.data[key];
  });
  return {
    items: rows.map(item => ({ ...item, quoteUpdated: item.updated || null, source: 'Tarkov.dev' })),
    categories: [], source: 'Tarkov.dev', sourceUrl: 'https://tarkov.dev/api', warnings: [],
  };
}

async function listCategory(mode, id, fetcher) {
  const results = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await fetcher(`${HQ}/items?mode=${mode}&category=${id}&limit=100&offset=${offset}`);
    if (!Array.isArray(page.results)) throw new Error('Container list is unavailable');
    results.push(...page.results);
    if (results.length >= page.total || !page.results.length) break;
  }
  return results;
}

async function fetchFallback(mode, fetcher, progress) {
  progress('Finding storage items…');
  const [rigs, packs, categories, common, portable, locking] = await Promise.all([
    fetcher(`${HQ}/rigs?mode=${mode}`), fetcher(`${HQ}/backpacks?mode=${mode}`),
    fetcher(`${HQ}/items/categories?mode=${mode}`),
    listCategory(mode, '5795f317245977243854e041', fetcher),
    listCategory(mode, '5448bf274bdc2dfc2f8b456a', fetcher),
    listCategory(mode, '5671435f4bdc2d96058b4569', fetcher),
  ]);
  if (!rigs.results?.length || !packs.results?.length || !common.length) throw new Error('Incomplete fallback category lists');
  const lookup = new Map([...rigs.results, ...packs.results, ...common, ...portable, ...locking].map(i => [i.id, i]));
  let done = 0;
  const rows = await mapLimit([...lookup.values()], 4, async summary => {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await fetcher(`${HQ}/items/${summary.id}?mode=${mode}`);
        if (!result.item?.id) throw new Error('Missing item detail');
        break;
      } catch (error) { if (attempt === 1) throw new Error(`Could not refresh ${summary.shortName || summary.name}: ${error.message}`); }
    }
    progress(`Updating items ${++done} / ${lookup.size}…`);
    return { ...result.item, kind: summary.kind,
      quoteUpdated: result.cache?.pricesLastUpdated || null, source: 'TarkovHQ · Tarkov.dev data' };
  });
  return { items: rows, categories: categories.categories || [], source: 'TarkovHQ',
    sourceUrl: 'https://tarkovhq.dev/rigs', warnings: ['Using the fallback feed while Tarkov.dev is unavailable.'] };
}

export async function fetchCatalog(mode, { fetcher = fetchJson, bulk = fetchBulk, previous, progress = () => {} } = {}) {
  progress('Connecting to the item feed…');
  try { return await bulk(mode,{previous,progress}); }
  catch(error) { if(mode==='seasonal')throw error; }
  try { return await fetchPrimary(mode, fetcher); }
  catch { return await fetchFallback(mode, fetcher, progress); }
}

export function freshness(snapshot, now = Date.now(), lastError = null) {
  const dates = snapshot.items.map(i => Date.parse(i.quoteUpdated || '')).filter(Number.isFinite);
  const oldest = dates.length ? Math.min(...dates) : null;
  const newest = dates.length ? Math.max(...dates) : null;
  return {
    source: snapshot.source, sourceUrl: snapshot.sourceUrl, checkedAt: snapshot.checkedAt,
    quoteUpdated: oldest ? new Date(oldest).toISOString() : null,
    newestQuoteUpdated: newest ? new Date(newest).toISOString() : null,
    stale: Boolean(lastError) || dates.length !== snapshot.items.length || !oldest || now - oldest > STALE_MS || newest > now + 60000,
    warnings: snapshot.warnings || [], lastError, refreshEverySeconds: REFRESH_MS / 1000,
  };
}

export class CatalogStore {
  constructor(cacheDir, { loader = fetchCatalog, core = runCore, now = Date.now, onError = message => console.error(message) } = {}) {
    this.cacheDir = cacheDir; this.loader = loader; this.core = core; this.now = now; this.states = new Map(); this.onError=onError;
  }
  state(mode) {
    if (!MODES[mode]) throw new Error('Choose a valid game mode');
    if (!this.states.has(mode)) this.states.set(mode, { snapshot: null, inflight: null, lastError: null, progress: '', loaded: false, accessedAt: this.now(), attemptedAt: -Infinity });
    return this.states.get(mode);
  }
  async loadDisk(mode) {
    const state = this.state(mode);
    if (state.loaded) return;
    if (!state.diskLoad) state.diskLoad = (async () => {
      for(const suffix of ['.json','.previous.json']) try {
        const saved = JSON.parse(await readFile(path.join(this.cacheDir, `${mode}${suffix}`), 'utf8'));
        if (saved.version === 1 && saved.mode === mode && saved.items?.length && Number.isFinite(Date.parse(saved.checkedAt))) {
          // Concurrent first requests must share validation rather than treating
          // an in-progress disk load as a cache miss and starting a network load.
          await this.core({ op: 'query', items: saved.items, query: {} });
          saved.revision ||= createHash('sha256').update(JSON.stringify(saved.items)).digest('hex');
          state.snapshot = saved;
          return;
        }
      } catch { /* An absent or incompatible cache triggers a normal network load. */ }
    })().finally(() => { state.loaded = true; state.diskLoad = null; });
    await state.diskLoad;
  }
  async refresh(mode) {
    const state = this.state(mode);
    if (state.inflight) return state.inflight;
    state.attemptedAt = this.now();
    state.inflight = (async () => {
      try {
        const feed = await this.loader(mode, { previous:state.snapshot, progress: value => { state.progress = value; } });
        const normalized = feed.unchanged && state.snapshot ? {items:state.snapshot.items} : await this.core({ op: 'normalize', items: feed.items, categories: feed.categories });
        if (!normalized.items.length) throw new Error('No storage items received');
        if(feed.requiredCategories?.some(category=>!normalized.items.some(item=>item.category===category)))
          throw new Error('The source is missing a required storage category');
        const fitCategories=feed.unchanged?state.snapshot.fitCategories||[]:feed.fitCategories||[];
        const snapshot = { ...(feed.unchanged?state.snapshot:{}), version: 1, mode, items: normalized.items,fitCategories,
          source: feed.source||state.snapshot?.source, sourceUrl: feed.sourceUrl||state.snapshot?.sourceUrl,
          warnings: feed.warnings||state.snapshot?.warnings||[], upstream:feed.upstream,
          revision:createHash('sha256').update(JSON.stringify({items:normalized.items,fitCategories})).digest('hex'),checkedAt: new Date(this.now()).toISOString() };
        await mkdir(this.cacheDir, { recursive: true });
        const destination = path.join(this.cacheDir, `${mode}.json`);
        await writeFile(`${destination}.tmp`, JSON.stringify(snapshot));
        // Only preserve the known-good in-memory generation; a corrupt current
        // file must not replace the recovery generation after a successful load.
        if(state.snapshot && state.snapshot.revision!==snapshot.revision)
          await writeFile(path.join(this.cacheDir,`${mode}.previous.json`),JSON.stringify(state.snapshot));
        await rename(`${destination}.tmp`, destination);
        state.snapshot = snapshot; state.lastError = null; state.progress = '';
        return snapshot;
      } catch (error) {
        state.lastError = 'Price refresh failed. Showing the last successful data.';
        state.progress = '';
        this.onError(`[${mode}] ${error.message}`);
        if (!state.snapshot) throw error;
        return state.snapshot;
      } finally { state.inflight = null; }
    })();
    return state.inflight;
  }
  async get(mode, force = false) {
    await this.loadDisk(mode);
    const state = this.state(mode); state.accessedAt = this.now();
    const age = state.snapshot ? this.now() - Date.parse(state.snapshot.checkedAt) : Infinity;
    if (!state.snapshot || (force && age > 15000)) await this.refresh(mode);
    else if (age >= REFRESH_MS && this.now() - state.attemptedAt >= REFRESH_MS && !state.inflight) this.refresh(mode).catch(() => {});
    return { ...state.snapshot, meta: { ...freshness(state.snapshot, this.now(), state.lastError), refreshing: Boolean(state.inflight) } };
  }
  status(mode) {
    const state = this.state(mode);
    return { ready: Boolean(state.snapshot), refreshing: Boolean(state.inflight), progress: state.progress, lastError: state.lastError };
  }
  tick() {
    for (const [mode, state] of this.states) {
      if (state.snapshot && this.now() - state.accessedAt < 10 * 60000 && this.now() - Date.parse(state.snapshot.checkedAt) >= REFRESH_MS && this.now() - state.attemptedAt >= REFRESH_MS && !state.inflight) {
        this.refresh(mode).catch(() => {});
      }
    }
  }
}
