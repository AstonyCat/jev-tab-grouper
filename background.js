// Tab Sorter — service worker entry. Toolbar click = group with default engine;
// right-click menu = pick engine / ungroup.
"use strict";

importScripts("grouper.js");

const MENUS = [
  { id: "engine-jev", title: "Group with rules (Jev)" },
  { id: "engine-llm", title: "Group with LLM (auto names)" },
  { separator: "sep1" },
  { id: "ungroup-mine", title: "Ungroup (this extension only)" },
  { id: "ungroup-all", title: "Ungroup ALL groups (incl. manual)" },
];

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    MENUS.forEach(m => {
      if (m.separator) chrome.contextMenus.create({ id: m.separator, type: "separator", contexts: ["action"] });
      else chrome.contextMenus.create({ id: m.id, title: m.title, contexts: ["action"] });
    });
    chrome.storage.local.set({ menusReady: true });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  createMenus();
  const s = await TabSorter.getSettings();
  await TabSorter.log("info", "installed", { engine: s.engine });
});
// SW cold starts after a browser restart don't fire onInstalled — rebuild if needed.
chrome.runtime.onStartup.addListener(async () => {
  const { menusReady } = await chrome.storage.local.get("menusReady");
  if (!menusReady) createMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  const windowId = tab.windowId;
  try {
    switch (info.menuItemId) {
      case "engine-jev":
        await TabSorter.groupAll(windowId, TabSorter.ENGINES.JEV);
        break;
      case "engine-llm":
        await TabSorter.groupAll(windowId, TabSorter.ENGINES.LLM);
        break;
      case "ungroup-mine": {
        const r = await TabSorter.ungroupAll(windowId, true);
        await chrome.action.setBadgeText({ text: String(r.dissolved) });
        setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
        break;
      }
      case "ungroup-all":
        await TabSorter.ungroupAll(windowId, false);
        break;
    }
  } catch (e) {
    await chrome.action.setBadgeText({ text: "ERR" });
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
    await TabSorter.log("error", "menu_action_fail", { id: info.menuItemId, message: String(e) });
  }
});

chrome.action.onClicked.addListener(tab => TabSorter.groupAll(tab.windowId));
