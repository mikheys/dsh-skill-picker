# Changelog

## 2.0.0

- Two scopes: **This chat** and **All chats** (global defaults, including future chats and subagents).
- Explicit **Apply** button: one catalog republication per edit session instead of one per click.
- Hidden skills stay loadable by hand: `/skill-name` injects the real skill body.
- Chat overrides can re-enable a globally hidden skill for one chat.
- Tags «hide globally» / «enabled for this chat», scope-aware counters and hints.
- Russian titles, descriptions and categories for skills (`russian.json`).

## 1.0.0

- First release: right-panel tab with per-session skill checkboxes and Russian descriptions; local Host API; Agent-scoped runtime shadows that hide skills from the model catalog.
