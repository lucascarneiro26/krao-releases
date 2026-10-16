// Krao.gg leaderboard crawler.
//
// NCSOFT has no Combat Power ranking for AION 2 Global, so this walks every
// server itself, gently:
//   1. refresh: re-reads the top 100 of each class on each server once a day;
//   2. scan: once a week per server, finds every level-45 character through the
//      public search, reads their Combat Power and keeps the strongest KEEP of
//      each class in the site's database;
//   3. items: records what the top players of each class wear, with the
//      official tooltip, which is the site's item database.
//
// Runs on GitHub Actions (see workflow.yml) with DATABASE_URL as a secret. It
// only reads public endpoints and only writes the tables the site already
// reads; the site's migrations create them.
//
// Env: DATABASE_URL (required), BUDGET_MIN (default 320), RATE_MS (min gap
// between requests, default 150), CONCURRENCY (default 6), KEEP (default 150),
// REGIONS (comma list, default all), SERVER (one server id, for tests), LIMIT
// (characters per server, for tests),
// DRY_RUN=1 (read NCSOFT, write nothing).


const env = process.env;
const BUDGET_MS = Number(env.BUDGET_MIN ?? 320) * 60_000;
const RATE_MS = Number(env.RATE_MS ?? 150);
const CONCURRENCY = Number(env.CONCURRENCY ?? 6);
const KEEP = Number(env.KEEP ?? 150);
const TOP_REFRESH = 100;
const TOP_ITEMS = 20;
const MAX_LEVEL = 45;
const KEYWORDS = ["a", "e", "i", "o", "u", "y"];
const REGIONS = (env.REGIONS ?? "nae,naw,eu,la,as").split(",").map((r) => r.trim()).filter(Boolean);
const ONLY_SERVER = env.SERVER ? Number(env.SERVER) : null;
const LIMIT = env.LIMIT ? Number(env.LIMIT) : Infinity; // tests: read only this many characters per server
const DRY = env.DRY_RUN === "1";
const LANG = "pt-BR";

const started = Date.now();
const timeLeft = () => BUDGET_MS - (Date.now() - started);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTTP, with one shared pace for every request and retries on hiccups.

let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + RATE_MS;
  if (wait) await sleep(wait);
}

const stats = { requests: 0, errors: 0, notFound: 0 };

class NotFound extends Error {}

async function getJson(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    await pace();
    stats.requests++;
    try {
      const res = await fetch(u, {
        headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; KraoGG-crawler; +https://www.krao.com.br)" },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404 || (res.status >= 300 && res.status < 400)) throw new NotFound(u.pathname);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new NotFound(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e instanceof NotFound) {
        stats.notFound++;
        throw e;
      }
      stats.errors++;
      if (attempt >= 4) throw e;
      // Back off harder each time; a 429 means we are too fast for them.
      await sleep(2000 * 2 ** attempt);
    }
  }
}

const str = (v, d = "") => (typeof v === "string" ? v : d);
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const arr = (v) => (Array.isArray(v) ? v : []);
const decodeId = (id) => {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
};
const image = (url) => (url && url.startsWith("/") ? "https://profileimg.plaync.com" + url : url || "");

// NCSOFT endpoints (the same ones the site uses; see packages/shared/src/aion/client.ts).

const SEARCH = "https://api-search.plaync.com/aion2global/search/v2/character";
const CHARACTER = "https://aion2.plaync.com/api/character";
const GAMEINFO = "https://aion2.plaync.com/en-us/api/gameinfo";

/** pcId → class key ("CLERIC"), plus the pcIds of each faction ("Light" = Elyos, "Dark" = Asmodian). */
async function classMap() {
  const d = await getJson(`${GAMEINFO}/pcdata`, { lang: LANG, region: "la" });
  const list = arr(d.pcDataList);
  const classes = new Map(list.map((c) => [num(c.id), str(c.className)]));
  classes.byRace = {
    1: list.filter((c) => c.raceName === "Light").map((c) => num(c.id)),
    2: list.filter((c) => c.raceName === "Dark").map((c) => num(c.id)),
  };
  return classes;
}

async function servers(region) {
  const d = await getJson(`${GAMEINFO}/servers`, { lang: LANG, region });
  return arr(d.serverList).map((s) => ({ id: num(s.serverId), name: str(s.serverName), raceId: num(s.raceId), region }));
}

/**
 * Every level-45 character of a server: a few common letters cover almost every
 * name. NCSOFT stops at 10,000 results per search, so a crowded server is
 * searched class by class (pcIds of its faction) instead.
 */
async function discover(server, pcIds) {
  const found = new Map();
  const walk = async (keyword, pcId) => {
    for (let page = 1; ; page++) {
      const d = await getJson(SEARCH, {
        keyword,
        region: server.region,
        localeInfo: LANG,
        serverId: server.id,
        level: MAX_LEVEL,
        pcId,
        size: 200,
        page,
      });
      for (const c of arr(d.list)) {
        if (num(c.serverId) !== server.id || num(c.level) !== MAX_LEVEL) continue;
        found.set(decodeId(str(c.characterId)), { pcId: num(c.pcId) });
      }
      if (page === 1 && pcId === undefined && num(d.pagination?.total) >= 10_000) return "split";
      if (page >= num(d.pagination?.endPage, 1) || arr(d.list).length === 0 || timeLeft() < 60_000) return "ok";
    }
  };
  for (const keyword of KEYWORDS) {
    if ((await walk(keyword, undefined)) === "split") {
      for (const pcId of pcIds) await walk(keyword, pcId);
    }
  }
  return found;
}

async function characterInfo(characterId, server) {
  const d = await getJson(`${CHARACTER}/info`, { lang: LANG, region: server.region, characterId, serverId: server.id });
  const p = d.profile ?? {};
  if (!p.characterName) throw new NotFound("no profile");
  const il = arr(d.stat?.statList).find((s) => s.type === "ItemLevel");
  return {
    id: decodeId(str(p.characterId, characterId)),
    name: str(p.characterName),
    level: num(p.characterLevel),
    combatPower: num(p.combatPower),
    pcId: num(p.pcId),
    raceId: num(p.raceId) === 2 ? 2 : 1,
    serverId: num(p.serverId, server.id),
    serverName: str(p.serverName, server.name),
    imageUrl: image(str(p.profileImage)),
    itemLevel: il ? num(il.value) || null : null,
  };
}

// Database

const db = DRY ? null : new (await import("pg")).default.Pool({ connectionString: env.DATABASE_URL, max: 3 });
if (!DRY && !env.DATABASE_URL) {
  console.error("DATABASE_URL is required (or DRY_RUN=1).");
  process.exit(1);
}
const q = (text, params) => (db ? db.query(text, params) : Promise.resolve({ rows: [], rowCount: 0 }));

let removed = new Set();
async function loadRemoved() {
  const r = await q("SELECT server_id, character_id FROM removed_characters");
  removed = new Set(r.rows.map((x) => `${x.server_id}:${x.character_id}`));
}

// Same rule as apps/site/src/lib/leaderboard.ts: keep the highest item level of the last 7 days.
const UPSERT = `
INSERT INTO characters (server_id, character_id, region, server_name, name, name_lower, pc_id, class_key, race_id, level,
  combat_power, item_level, item_level_at, image_url, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $12::int IS NULL THEN NULL ELSE now() END,$13,now())
ON CONFLICT (server_id, character_id) DO UPDATE SET
  region = excluded.region, server_name = excluded.server_name, name = excluded.name, name_lower = excluded.name_lower,
  pc_id = excluded.pc_id, class_key = excluded.class_key, race_id = excluded.race_id, level = excluded.level,
  combat_power = excluded.combat_power, image_url = excluded.image_url, updated_at = now(),
  item_level = CASE WHEN excluded.item_level IS NOT NULL AND (characters.item_level IS NULL OR characters.item_level_at IS NULL
      OR characters.item_level_at < now() - interval '7 days' OR excluded.item_level > characters.item_level)
    THEN excluded.item_level ELSE characters.item_level END,
  item_level_at = CASE WHEN excluded.item_level IS NOT NULL AND (characters.item_level IS NULL OR characters.item_level_at IS NULL
      OR characters.item_level_at < now() - interval '7 days' OR excluded.item_level > characters.item_level)
    THEN now() ELSE characters.item_level_at END`;

async function save(info, region, classes) {
  if (removed.has(`${info.serverId}:${info.id}`)) return;
  await q(UPSERT, [
    info.serverId,
    info.id,
    region,
    info.serverName,
    info.name,
    info.name.toLowerCase(),
    info.pcId,
    classes.get(info.pcId) ?? null,
    info.raceId,
    info.level,
    info.combatPower,
    info.itemLevel,
    info.imageUrl,
  ]);
}

/** Runs `fn` over `list` with a few requests in flight; stops early when time (or `until`) is up. */
async function pool(list, fn, until = Infinity) {
  let i = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < list.length && timeLeft() > 30_000 && Date.now() < until) {
      const item = list[i++];
      try {
        await fn(item);
      } catch (e) {
        if (!(e instanceof NotFound)) log("  !", e.message);
      }
    }
  });
  await Promise.all(workers);
  return i;
}

// 1. Daily refresh of the top of each class on each server.

async function refreshTop(classes, until) {
  const r = await q(
    `SELECT server_id, character_id, region, server_name FROM (
       SELECT *, row_number() OVER (PARTITION BY server_id, class_key ORDER BY combat_power DESC) AS rank FROM characters
     ) t WHERE rank <= $1 AND updated_at < now() - interval '20 hours' ${ONLY_SERVER ? "AND server_id = $2" : ""}
     ORDER BY updated_at LIMIT 100000`,
    ONLY_SERVER ? [TOP_REFRESH, ONLY_SERVER] : [TOP_REFRESH],
  );
  if (r.rows.length === 0) return;
  log(`refresh: ${r.rows.length} characters due`);
  let gone = 0;
  const done = await pool(r.rows, async (row) => {
    const server = { id: row.server_id, region: row.region, name: row.server_name };
    try {
      await save(await characterInfo(row.character_id, server), row.region, classes);
    } catch (e) {
      // Deleted or moved: it leaves the ranking.
      if (e instanceof NotFound) {
        gone++;
        await q("DELETE FROM characters WHERE server_id = $1 AND character_id = $2", [row.server_id, row.character_id]);
      }
      throw e;
    }
  }, until);
  log(`refresh: ${done} read, ${gone} gone`);
}

// 2. Weekly scan of a server, and 3. what its top players wear.

async function scanServer(server, classes) {
  const t0 = Date.now();
  const candidates = await discover(server, classes.byRace[server.raceId] ?? []);
  log(`scan ${server.region}/${server.name}: ${candidates.size} level-${MAX_LEVEL} characters`);
  const ids = [...candidates.keys()].filter((id) => !removed.has(`${server.id}:${id}`)).slice(0, LIMIT);
  const read = [];
  await pool(ids, async (id) => {
    read.push(await characterInfo(id, server));
  });
  if (timeLeft() < 30_000 && read.length < ids.length * 0.9) {
    log(`scan ${server.name}: out of time after ${read.length}/${ids.length}, will redo next run`);
    return false;
  }

  // The strongest KEEP of each class are stored; the rest only if already known (the site keeps visited ones).
  const byClass = new Map();
  for (const c of read) {
    const k = classes.get(c.pcId) ?? "?";
    byClass.set(k, [...(byClass.get(k) ?? []), c]);
  }
  const known = new Set(
    (await q("SELECT character_id FROM characters WHERE server_id = $1", [server.id])).rows.map((r) => r.character_id),
  );
  let kept = 0;
  const topForItems = [];
  for (const list of byClass.values()) {
    list.sort((a, b) => b.combatPower - a.combatPower);
    for (const [i, c] of list.entries()) {
      if (i < KEEP || known.has(c.id)) {
        await save(c, server.region, classes);
        kept++;
      }
      if (i < TOP_ITEMS) topForItems.push(c);
    }
  }
  // Characters of this server that left the top and nobody visited stay until they fall out of the refresh.
  await q(
    `INSERT INTO crawl_servers (server_id, region, server_name, last_scan_at, last_scan_seen, last_scan_kept, updated_at)
     VALUES ($1,$2,$3,now(),$4,$5,now())
     ON CONFLICT (server_id) DO UPDATE SET last_scan_at = now(), last_scan_seen = $4, last_scan_kept = $5, updated_at = now()`,
    [server.id, server.region, server.name, read.length, kept],
  );
  log(`scan ${server.name}: kept ${kept} in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (timeLeft() > 120_000) await recordItems(topForItems, server);
  return true;
}

const seenItems = new Map(); // item id → detail_at (ms) | null, loaded lazily

async function itemDetailAge(id) {
  if (!seenItems.has(id)) {
    const r = await q("SELECT detail_at FROM items WHERE id = $1", [id]);
    seenItems.set(id, r.rows[0] ? (r.rows[0].detail_at ? new Date(r.rows[0].detail_at).getTime() : 0) : null);
  }
  return seenItems.get(id);
}

async function recordItems(characters, server) {
  let n = 0;
  await pool(characters, async (c) => {
    const d = await getJson(`${CHARACTER}/equipment`, { lang: LANG, region: server.region, characterId: c.id, serverId: server.id });
    for (const it of arr(d.equipment?.equipmentList)) {
      const id = num(it.id);
      if (!id) continue;
      const slot = num(it.slotPos);
      const age = await itemDetailAge(id);
      await q(
        `INSERT INTO items (id, name, name_lower, grade, icon, slot_name, wearer_server_id, wearer_character_id, wearer_region, wearer_slot, worn_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
         ON CONFLICT (id) DO UPDATE SET worn_by = items.worn_by + 1, updated_at = now(),
           wearer_server_id = $7, wearer_character_id = $8, wearer_region = $9, wearer_slot = $10`,
        [id, str(it.name), str(it.name).toLowerCase(), str(it.grade), str(it.icon), str(it.slotPosName), server.id, c.id, server.region, slot],
      );
      // The tooltip is read once per item and again after two weeks.
      if (age === null || age < Date.now() - 14 * 86_400_000) {
        seenItems.set(id, Date.now());
        try {
          const det = await getJson(`${CHARACTER}/equipment/item`, {
            id,
            enchantLevel: 0,
            characterId: c.id,
            serverId: server.id,
            slotPos: slot,
            lang: LANG,
            region: server.region,
          });
          if (det && det.name) {
            await q(
              `UPDATE items SET detail = $2, category = $3, item_level = $4, sources = $5, class_names = $6, detail_at = now() WHERE id = $1`,
              [id, JSON.stringify(det), str(det.categoryName), num(det.level), arr(det.sources).map(String), arr(det.classNames).map(String)],
            );
            n++;
          }
        } catch (e) {
          if (!(e instanceof NotFound)) throw e;
        }
      }
    }
  });
  log(`items ${server.name}: ${n} tooltips saved`);
}

// Main

async function main() {
  log(`start: budget ${BUDGET_MS / 60_000} min, ${RATE_MS} ms/request, ${CONCURRENCY} at a time${DRY ? ", DRY RUN" : ""}`);
  const classes = await classMap();
  await loadRemoved();

  // A third of the time at most goes to the daily refresh; the rest to weekly scans.
  await refreshTop(classes, Date.now() + BUDGET_MS / 3);

  const all = (await Promise.all(REGIONS.map((r) => servers(r)))).flat().filter((s) => !ONLY_SERVER || s.id === ONLY_SERVER);
  const last = new Map((await q("SELECT server_id, last_scan_at FROM crawl_servers")).rows.map((r) => [r.server_id, r.last_scan_at]));
  const due = all
    .filter((s) => {
      const at = last.get(s.id);
      return ONLY_SERVER || !at || new Date(at).getTime() < Date.now() - 6 * 86_400_000;
    })
    .sort((a, b) => (new Date(last.get(a.id) ?? 0).getTime() || 0) - (new Date(last.get(b.id) ?? 0).getTime() || 0));
  log(`scan: ${due.length} of ${all.length} servers due`);
  for (const s of due) {
    if (timeLeft() < Math.min(15 * 60_000, BUDGET_MS / 4)) break;
    await scanServer(s, classes);
  }
  log(`done: ${stats.requests} requests, ${stats.errors} retried errors, ${stats.notFound} not found`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db?.end());
