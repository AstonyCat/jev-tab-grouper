// Tab Sorter — options page logic.
"use strict";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function groupsToText(groups) {
  return groups.map(g => `${g.label} | ${g.desc}`).join("\n");
}
function textToGroups(text) {
  return text.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
    const [label, ...rest] = l.split("|");
    return { label: (label || "").trim(), desc: rest.join("|").trim() };
  }).filter(g => g.label);
}

async function load() {
  const s = await TabSorter.getSettings();
  $("jevKey").value = s.jevKey;
  $("ruleGroups").value = groupsToText(s.ruleGroups);
  $("llmBase").value = s.llm.baseUrl;
  $("llmModel").value = s.llm.model;
  $("llmKey").value = s.llm.apiKey;
  $("llmPrompt").value = s.llm.prompt;
  document.querySelector(`input[name=engine][value=${s.engine}]`).checked = true;
  renderLogs(await TabSorter.getLogs());
  renderLlmGroups();
}

async function save() {
  const groups = textToGroups($("ruleGroups").value);
  if (groups.length < 2) { statusEl.textContent = "Need at least 2 rule groups"; return false; }
  await chrome.storage.local.set({
    jevKey: $("jevKey").value.trim(),
    ruleGroups: groups,
    engine: document.querySelector("input[name=engine]:checked").value,
    llm: {
      baseUrl: $("llmBase").value.trim(),
      apiKey: $("llmKey").value.trim(),
      model: $("llmModel").value.trim(),
      prompt: $("llmPrompt").value,
    },
  });
  return true;
}

// auto-save on edit (debounced) so toolbar runs never use stale config
let saveTimer = null;
document.querySelectorAll("input, textarea").forEach(el => {
  el.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (await save()) statusEl.textContent = "saved ✓";
    }, 600);
  });
});
document.querySelectorAll("input[name=engine]").forEach(el =>
  el.addEventListener("change", async () => { if (await save()) statusEl.textContent = "saved ✓"; }));

// ---------- logs ----------
function renderLogs(logs) {
  const box = $("logBox");
  if (!logs.length) { box.textContent = "(no logs yet — run a grouping)"; return; }
  box.innerHTML = logs.map(l => {
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return `<div class="lv-${esc(l.level)}"><span class="lv-time">${esc(l.t.slice(11, 19))}</span> ` +
           `<b>${esc(l.event)}</b> ${esc(l.detail)}</div>`;
  }).join("");
}
$("refreshLogs").onclick = async () => renderLogs(await TabSorter.getLogs());
$("clearLogs").onclick = async () => { await TabSorter.clearLogs(); renderLogs([]); };

// ---------- last LLM-generated groups ----------
async function renderLlmGroups() {
  const { lastLlmGroups } = await chrome.storage.local.get("lastLlmGroups");
  const box = $("llmGroupsBox");
  const btn = $("adoptLlm");
  if (!Array.isArray(lastLlmGroups) || !lastLlmGroups.length) {
    box.textContent = "No LLM run yet — groups invented by the LLM engine will be saved here.";
    btn.style.display = "none";
    return;
  }
  box.innerHTML = lastLlmGroups.map(g =>
    `<div style="margin:2px 0"><b>${g.label.replace(/</g,"&lt;")}</b> <span style="color:#666">— ${String(g.desc||"").replace(/</g,"&lt;")}</span></div>`
  ).join("");
  btn.style.display = "";
}
$("adoptLlm").onclick = async () => {
  const { lastLlmGroups } = await chrome.storage.local.get("lastLlmGroups");
  if (!Array.isArray(lastLlmGroups) || !lastLlmGroups.length) return;
  const s = await TabSorter.getSettings();
  const fallback = s.ruleGroups[s.ruleGroups.length - 1];
  const merged = [...s.ruleGroups.slice(0, -1), ...lastLlmGroups];
  if (!merged.some(g => g.label === fallback.label)) merged.push(fallback); // keep a fallback line
  await chrome.storage.local.set({ ruleGroups: merged });
  $("ruleGroups").value = groupsToText(merged);
  statusEl.textContent = `Adopted ${lastLlmGroups.length} LLM groups into your rules ✓ (dedupe by hand if needed)`;
};

// ---------- actions ----------
$("runJev").onclick = () => runGroup(TabSorter.ENGINES.JEV);
$("runLlm").onclick = () => runGroup(TabSorter.ENGINES.LLM);

async function runGroup(engine) {
  await save();
  statusEl.textContent = "Grouping… (" + engine + ")";
  try {
    const r = await TabSorter.groupAll(chrome.windows.WINDOW_ID_CURRENT, engine);
    renderLogs(await TabSorter.getLogs());
    if (r.error) statusEl.textContent = "FAILED: " + r.message;
    else statusEl.textContent = `Done in ${((r.ms || 0) / 1000).toFixed(1)}s — ` +
      (r.groups || []).join(", ") + (r.skippedManual ? ` (kept ${r.skippedManual} manual-grouped tabs)` : "") +
      (r.usage && r.usage.total_tokens ? ` · tokens: ${r.usage.total_tokens}` : "");
    renderLlmGroups();
  } catch (e) {
    statusEl.textContent = "FAILED: " + e.message;
    renderLogs(await TabSorter.getLogs());
  }
}

$("ungroup").onclick = async () => {
  statusEl.textContent = "Ungrouping…";
  try {
    const r = await TabSorter.ungroupAll(chrome.windows.WINDOW_ID_CURRENT, true);
    statusEl.textContent = `Dissolved ${r.dissolved} groups (${r.tabs} tabs released)`;
  } catch (e) {
    statusEl.textContent = "FAILED: " + e.message;
  }
};

// ---------- connection tests ----------
$("testJev").onclick = async () => {
  const key = $("jevKey").value.trim();
  if (!key) { statusEl.textContent = "Fill the Jev key first"; return; }
  statusEl.textContent = "Testing Jev…";
  try {
    const idxs = await TabSorter.classifyWithJev(
      [{ title: "GitHub: hermes-agent", url: "https://github.com/x/y" }],
      [{ label: "Dev", desc: "programming" }, { label: "Other", desc: "fallback" }], key);
    statusEl.textContent = idxs[0] === 0 ? "Jev OK ✓ (test tab classified as Dev)" : "Jev reachable ✓ (answer: g" + idxs[0] + ")";
  } catch (e) {
    statusEl.textContent = "Jev FAILED: " + e.message;
  }
};

$("testLlm").onclick = async () => {
  await save();
  const s = await TabSorter.getSettings();
  if (!s.llm.baseUrl || !s.llm.model) { statusEl.textContent = "Fill baseUrl and model first"; return; }
  statusEl.textContent = "Testing LLM…";
  try {
    const r = await TabSorter.classifyWithLlm(
      [{ title: "GitHub: hermes-agent repo", url: "https://github.com/a/b" },
       { title: "淘宝网 - 淘！我喜欢", url: "https://www.taobao.com/" },
       { title: "哔哩哔哩 (゜-゜)つロ 干杯~", url: "https://www.bilibili.com/" }],
      s.llm);
    const counts = new Map();
    r.assign.forEach(gi => counts.set(gi, (counts.get(gi) || 0) + 1));
    statusEl.textContent = "LLM OK ✓ → " + r.groups.map((g, gi) => `${g.label}×${counts.get(gi) || 0}`).join(", ");
    renderLogs(await TabSorter.getLogs());
  } catch (e) {
    statusEl.textContent = "LLM FAILED: " + e.message;
    renderLogs(await TabSorter.getLogs());
  }
};

load();
