# Privacy Policy — Tab Sorter

_Last updated: 2026-09-20_

## What data the extension handles
Tab Sorter reads **tab titles and URLs** of the current window, and only to group them:

- When you click the toolbar button (or a menu item / an options-page action), the titles
  and domains of ungrouped tabs are sent to **the classification service you configured**:
  - Rules engine → `https://api.typesafe.ai` (TypeSafe System One), or
  - LLM engine → **any OpenAI-compatible endpoint you enter yourself** (your base URL,
    your key, your model).
- Nothing is sent anywhere at any other time. There is no background collection,
  no analytics, no telemetry, no ads, no tracking.

## What is stored locally
Settings (API keys, group rules, custom prompt) and the last 200 log lines are stored in
`chrome.storage.local` **on your machine only**. They never leave the browser except as
the Authorization header to the endpoint you configured. Keys are not synced.

## Third parties
The extension itself operates no servers. Data goes directly from your browser to the
endpoint you chose, under that provider's own privacy policy (TypeSafe for the rules
engine; your chosen provider for the LLM engine).

## Permissions rationale
- `tabs` / `tabGroups` — read titles/URLs to classify and to create the groups.
- `storage` — keep your settings and logs locally.
- `contextMenus` — the right-click menu entries.
- Host permissions (`api.typesafe.ai`, `localhost`) and optional host permissions
  (requested at runtime, per endpoint) — required to call your chosen API from the
  extension. Optional permissions are only requested when you actually run the LLM
  engine with a remote endpoint, and can be revoked in `chrome://settings`.

## Contact
Open an issue at https://github.com/AstonyCat/jev-tab-grouper
