// Tab Sorter — core logic shared by background.js and the options page.
"use strict";

const ENGINES = { JEV: "jev", LLM: "llm" };
const GROUP_COLORS = ["blue", "purple", "orange", "pink", "green", "red", "cyan", "grey"];
const LOG_RING_MAX = 200;

// Default rule-based groups. The LAST line is always the fallback group.
const DEFAULT_RULE_GROUPS = [
  { label: "Dev",           desc: "Programming & dev tools: GitHub, GitLab, Stack Overflow, technical/API docs, package managers, terminals" },
  { label: "AI & Research", desc: "AI/LLM/papers/research: arXiv, HuggingFace, Langfuse, model playgrounds and consoles" },
  { label: "Shopping",      desc: "E-commerce & shop operations: VIP.com, Taobao, Tmall, Dewu, JD, Pinduoduo, seller dashboards" },
  { label: "Social",        desc: "Social media & communities: X/Twitter, Xiaohongshu, Weibo, Zhihu, Reddit" },
  { label: "Docs & Office", desc: "Docs/sheets/collab/mail/cloud drives: Feishu, Notion, Gmail, cloud storage" },
  { label: "Video & Music", desc: "Video/music/entertainment: YouTube, Bilibili, Netflix, Spotify" },
  { label: "Design",        desc: "Design & image editing: Figma, Canva, Photopea, stock asset sites" },
  { label: "Other",         desc: "Fallback when nothing above fits" },
];

// -------- logging: ring buffer persisted in chrome.storage.local --------
const _logs = [];
async function log(level, event, detail) {
  const line = {
    t: new Date().toISOString(),
    level,                                  // "info" | "warn" | "error"
    event,                                  // short english event name
    detail: detail === undefined ? "" : (typeof detail === "string" ? detail : JSON.stringify(detail)),
  };
  _logs.push(line);
  if (_logs.length > LOG_RING_MAX) _logs.shift();
  try { (console[level] || console.log)(`[tab-sorter] ${event}`, detail ?? ""); } catch {}
  try {
    const { logs } = await chrome.storage.local.get("logs");
    const arr = Array.isArray(logs) ? logs : [];
    arr.push(line);
    while (arr.length > LOG_RING_MAX) arr.shift();
    await chrome.storage.local.set({ logs: arr });
  } catch {}
  return line;
}
async function getLogs() {
  const { logs } = await chrome.storage.local.get("logs");
  return Array.isArray(logs) ? logs : [];
}
async function clearLogs() {
  _logs.length = 0;
  await chrome.storage.local.set({ logs: [] });
}

// -------- settings --------
const DEFAULT_LLM_SETTINGS = {
  baseUrl: "",          // OpenAI-compatible, e.g. http://localhost:3000/v1
  apiKey: "",
  model: "",
  prompt: "",           // custom system prompt; empty = built-in default
};

async function getSettings() {
  const s = await chrome.storage.local.get(["jevKey", "ruleGroups", "engine", "llm"]);
  return {
    jevKey: s.jevKey || "",
    ruleGroups: Array.isArray(s.ruleGroups) && s.ruleGroups.length >= 2 ? s.ruleGroups : DEFAULT_RULE_GROUPS,
    engine: s.engine === ENGINES.LLM ? ENGINES.LLM : ENGINES.JEV,
    llm: Object.assign({}, DEFAULT_LLM_SETTINGS, s.llm || {}),
  };
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function tabLine(t, i) {
  return `#${i} [${(t.title || "(no title)").slice(0, 120)}] ${hostOf(t.url)}`;
}

// ======================= error helper =======================
// Pull the response body into the Error message — that's where a 422/400
// usually explains itself (validation message from the gateway).
async function httpError(apiName, res) {
  let body = "";
  try { body = (await res.text()).slice(0, 400); } catch {}
  let reason = "";
  try {
    const j = JSON.parse(body);
    reason = (j.error && (j.error.message || j.error.code)) || j.message || "";
  } catch {}
  const err = new Error(`${apiName} HTTP ${res.status}${reason ? " — " + reason : body ? " — " + body : ""}`);
  err.status = res.status;
  err.body = body;
  return err;
}

// ======================= Jev engine (fixed criteria) =======================
async function classifyWithJev(tabs, groups, key) {
  const state = [
    "You are a browser tab organizer. Tabs currently open:",
    ...tabs.map(tabLine),
    "For each tab decide which group it belongs to by title and domain.",
  ].join("\n");
  const criteria = {};
  groups.forEach((g, i) => { criteria["g" + i] = `${g.label} — ${g.desc}`; });
  const questions = {};
  tabs.forEach((t, i) => {
    questions[`tab_${i}`] = {
      type: "choice",
      instructions: `Tab #${i} (title: ${t.title || "(no title)"} / host: ${hostOf(t.url)}) belongs to which group?`,
      criteria,
    };
  });
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw await httpError("Jev API", res);
  const data = await res.json();
  const answers = data.answers || {};
  const assign = tabs.map((t, i) => {
    const a = answers[`tab_${i}`] && answers[`tab_${i}`].choice;
    const idx = (typeof a === "string" && /^g\d+$/.test(a)) ? Number(a.slice(1)) : -1;
    return idx >= 0 && idx < groups.length ? idx : groups.length - 1;  // invalid → fallback group
  });
  return { assign, usage: data.usage || null };
}

// ======================= LLM engine (free-form groups) =======================
// Remote LLM endpoints (non-localhost) need an optional host permission granted
// at runtime; the toolbar/options click provides the required user gesture.
async function ensureOriginPermission(baseUrl) {
  const u = new URL(baseUrl);
  const pattern = u.origin + "/*";
  const perm = { origins: [pattern] };
  try {
    if (await chrome.permissions.contains(perm)) return true;
  } catch {}
  try {
    const granted = await chrome.permissions.request(perm);
    await log(granted ? "info" : "warn", "origin_permission", { pattern, granted });
    return granted;
  } catch (e) {
    await log("warn", "origin_permission_fail", { pattern, message: String(e) });
    return false;
  }
}

const DEFAULT_LLM_PROMPT = [
  "You are a browser tab organizer. You will get a numbered list of open tabs (title + domain).",
  "Group them into meaningful clusters and name each group.",
  "Rules:",
  "- 2 to 8 groups. Merge related tabs; do not produce one group per tab.",
  "- Group labels: short (1-3 words), in the SAME LANGUAGE as the tab titles (mostly Chinese tabs → Chinese labels).",
  '- Each group: {"label": "...", "description": "short clause describing what belongs here", "members": [tab indexes]}.',
  "- Every tab index must appear in exactly one group. Do not skip any index.",
  '- Do not add a generic "Misc" group unless a few tabs truly fit nowhere else.',
  "Output STRICT JSON only, no markdown fences, no commentary: {\"groups\": [...]}",
].join("\n");

async function chatComplete(llm, userContent, { temperature = 0.2, maxTokens = 2000 } = {}) {
  const base = (llm.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM baseUrl is empty");
  const ok = await ensureOriginPermission(base);
  if (!ok) {
    throw new Error(`Permission for ${new URL(base).origin} not granted — click the toolbar button again and accept the prompt (or use a localhost endpoint).`);
  }
  const sys = (llm.prompt && llm.prompt.trim()) || DEFAULT_LLM_PROMPT;
  let res;
  try {
    res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + (llm.apiKey || ""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: userContent },
        ],
        temperature, max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("LLM request timed out after 120s: " + base);
    throw new Error("LLM request failed: " + e.message + " (baseUrl: " + base + ")");
  }
  if (!res.ok) throw await httpError("LLM API", res);
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  const text = msg && msg.content;
  if (!text) throw new Error("LLM returned no content: " + JSON.stringify(data).slice(0, 300));
  return { text, usage: data.usage || null };
}

// Lenient JSON extraction: strip code fences, take outermost {...}
function parseGroupJson(text) {
  let s = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

// Returns { groups: [{label, desc}], assign: [groupIndex per tab] }
async function classifyWithLlm(tabs, llm) {
  const listing = tabs.map(tabLine).join("\n");
  const { text: out, usage } = await chatComplete(llm, "Open tabs:\n" + listing + "\n\nReturn only the JSON described in the system prompt.");
  await log("info", "llm_raw_output", String(out).slice(0, 500));
  let parsed;
  try {
    parsed = parseGroupJson(out);
  } catch {
    throw new Error("LLM output is not valid JSON (see llm_raw_output in logs): " + String(out).slice(0, 160));
  }
  const gs = Array.isArray(parsed.groups) ? parsed.groups : [];
  const seen = new Set();
  const groups = [];
  const assign = new Array(tabs.length).fill(-1);
  gs.forEach(g => {
    const label = String(g.label || "").trim();
    if (!label || !Array.isArray(g.members)) return;
    const gi = groups.length;
    groups.push({ label: label.slice(0, 20), desc: String(g.description || "").slice(0, 60) });
    g.members.forEach(m => {
      const idx = Number(m);
      if (Number.isInteger(idx) && idx >= 0 && idx < tabs.length && !seen.has(idx)) {
        seen.add(idx); assign[idx] = gi;
      }
    });
  });
  // Tabs the model skipped → explicit "Ungrouped" bucket
  const missing = tabs.map((_, i) => i).filter(i => !seen.has(i));
  if (missing.length) {
    groups.push({ label: "Ungrouped", desc: "Tabs the model did not assign" });
    const gi = groups.length - 1;
    missing.forEach(i => { assign[i] = gi; });
  }
  if (!groups.length) throw new Error("LLM returned no usable groups");
  return { groups, assign, usage };
}

// ======================= grouping pipeline =======================
function setBadgeIfPossible(text, color) {
  if (typeof chrome === "undefined" || !chrome.action) return Promise.resolve();
  return chrome.action.setBadgeText({ text }).then(() =>
    color ? chrome.action.setBadgeBackgroundColor({ color }) : undefined);
}

// engineOverride: run this engine once regardless of the saved default.
async function groupAll(windowId, engineOverride) {
  const s = await getSettings();
  const engine = engineOverride || s.engine;
  const t0 = Date.now();

  const stored = (await chrome.storage.local.get("myGroupIds")).myGroupIds || [];
  const liveIds = new Set((await chrome.tabGroups.query({ windowId })).map(g => g.id));
  const prevIds = stored.filter(id => liveIds.has(id));
  const all = await chrome.tabs.query({ windowId });
  const tabs = all.filter(t => !String(t.url || "").startsWith("chrome-extension://"));
  const manual = tabs.filter(t => t.groupId && t.groupId !== -1 && !prevIds.includes(t.groupId));
  const targets = tabs.filter(t => !(t.groupId && t.groupId !== -1 && !prevIds.includes(t.groupId)));

  if (!targets.length) {
    await log("warn", "no_tabs", "nothing to group");
    return { engine, grouped: 0, skippedManual: manual.length, groups: [], ms: 0 };
  }

  await setBadgeIfPossible("…", "#666");
  await log("info", "group_start", { engine, tabs: targets.length, skippedManual: manual.length });

  // Remember the pre-grouping tab order (once per window) so ungroup can restore it —
  // chrome.tabs.group() physically moves tabs together, which scrambles the order.
  // (Save ALL non-pinned tabs incl. this extension's pages, so nothing gets displaced.)
  const orderStore = (await chrome.storage.local.get("tabOrder")).tabOrder || {};
  if (!orderStore[windowId]) {
    orderStore[windowId] = all.filter(t => !t.pinned).map(t => t.id);
    const keys = Object.keys(orderStore);
    if (keys.length > 10) delete orderStore[keys[0]];   // keep the map small
    await chrome.storage.local.set({ tabOrder: orderStore });
    await log("info", "order_saved", { windowId, tabs: orderStore[windowId].length });
  }

  let labels, idxs, usage;
  try {
    if (engine === ENGINES.LLM) {
      if (!s.llm.baseUrl || !s.llm.model) throw new Error("LLM engine not configured (baseUrl / model missing) — open the options page");
      const r = await classifyWithLlm(targets, s.llm);
      labels = r.groups.map(g => g.label);
      idxs = r.assign;
      usage = r.usage;
      const counts = new Map();
      idxs.forEach(gi => counts.set(gi, (counts.get(gi) || 0) + 1));
      await log("info", "llm_groups", r.groups.map((g, gi) => `${g.label}[${g.desc}]×${counts.get(gi) || 0}`));
      // persist the LLM-invented groups as the "last LLM result" (viewable & adoptable in options)
      await chrome.storage.local.set({ lastLlmGroups: r.groups });
    } else {
      if (!s.jevKey) {
        try { chrome.runtime.openOptionsPage(); } catch {}
        throw new Error("Jev API key missing — open the options page");
      }
      const jr = await classifyWithJev(targets, s.ruleGroups, s.jevKey);
      idxs = jr.assign;
      usage = jr.usage;
      labels = s.ruleGroups.map(g => g.label);
    }
  } catch (e) {
    await setBadgeIfPossible("ERR", "#d93025");
    if (chrome.action) setTimeout(() => chrome.action.setBadgeText({ text: "" }), 6000);
    await log("error", "group_fail", { engine, message: e.message, status: e.status || "", body: e.body || "" });
    return { error: true, engine, message: e.message };
  }

  // dissolve previous groups created by this extension (their tabs are about to re-group)
  const stale = targets.filter(t => prevIds.includes(t.groupId));
  if (stale.length) {
    try { await chrome.tabs.ungroup(stale.map(t => t.id)); } catch {}
  }

  const buckets = new Map();
  idxs.forEach((gi, i) => {
    if (!buckets.has(gi)) buckets.set(gi, []);
    buckets.get(gi).push(targets[i].id);
  });

  const created = [];
  for (const [gi, ids] of buckets) {
    const newId = await chrome.tabs.group({ tabIds: ids });
    const label = labels[gi] || "Other";
    await chrome.tabGroups.update(newId, { title: label, color: GROUP_COLORS[gi % GROUP_COLORS.length] });
    created.push(newId);
  }
  await chrome.storage.local.set({ myGroupIds: created });

  await setBadgeIfPossible("OK", "#1a73e8");
  if (chrome.action) setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
  const ms = Date.now() - t0;
  await log("info", "group_done", {
    engine, ms,
    usage: usage || "not reported by API",
    groups: [...buckets.entries()].map(([gi, ids]) => `${labels[gi]}×${ids.length}`),
  });

  return {
    engine, grouped: targets.length, skippedManual: manual.length, ms, usage,
    groups: [...buckets.entries()].map(([gi, ids]) => `${labels[gi]}×${ids.length}`),
  };
}

async function ungroupAll(windowId, onlyMine = false) {
  const groups = await chrome.tabGroups.query({ windowId });
  let targets = groups;
  if (onlyMine) {
    const stored = (await chrome.storage.local.get("myGroupIds")).myGroupIds || [];
    targets = groups.filter(g => stored.includes(g.id));
  }
  const tabIds = (await Promise.all(targets.map(g => chrome.tabs.query({ groupId: g.id }))))
    .flat().map(t => t.id);
  if (tabIds.length) await chrome.tabs.ungroup(tabIds);

  // Restore the pre-grouping order: grouped tabs were moved together, so ungrouping
  // alone leaves them scrambled. Rebuild the saved sequence (any tabs opened after
  // grouping keep their relative order at the end).
  let restored = 0;
  const orderStore = (await chrome.storage.local.get("tabOrder")).tabOrder || {};
  const saved = orderStore[windowId];
  if (Array.isArray(saved) && saved.length) {
    const current = await chrome.tabs.query({ windowId });
    const alive = new Map(current.map(t => [t.id, t]));
    const ordered = saved.filter(id => alive.has(id) && !alive.get(id).pinned);
    const rest = current.filter(t => !t.pinned && !ordered.includes(t.id)).map(t => t.id);
    const finalIds = [...ordered, ...rest];
    const pinnedCount = current.filter(t => t.pinned).length;
    if (finalIds.length > 1) {
      try {
        await chrome.tabs.move(finalIds, { index: pinnedCount });  // preserves array order
        restored = finalIds.length;
      } catch (e) {
        await log("warn", "order_restore_fail", { message: String(e) });
      }
    }
    delete orderStore[windowId];
    await chrome.storage.local.set({ tabOrder: orderStore });
  }

  await chrome.storage.local.set({ myGroupIds: [] });
  await log("info", "ungroup", { onlyMine, dissolved: targets.length, tabs: tabIds.length, restoredOrder: restored });
  return { dissolved: targets.length, tabs: tabIds.length, restoredOrder: restored };
}

globalThis.TabSorter = {
  ENGINES, GROUP_COLORS, DEFAULT_RULE_GROUPS, DEFAULT_LLM_PROMPT, DEFAULT_LLM_SETTINGS,
  log, getLogs, clearLogs, getSettings, hostOf,
  classifyWithJev, classifyWithLlm, chatComplete, parseGroupJson,
  groupAll, ungroupAll,
};
