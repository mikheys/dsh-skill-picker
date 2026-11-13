# Архитектура

Плагин состоит из двух половин одного DSH-бандла (`dsh.bundle.patch` + `dsh.client`).

## Host-половина (`index.js`)

### Состояние

`~/.dsh/skill-picker/selections.json`:

```json
{
  "version": 2,
  "defaults": ["office"],
  "sessions": {
    "<sessionId>": { "hidden": ["blender-core"], "enabled": ["office"] }
  }
}
```

- `defaults` — навыки, скрытые во всех чатах;
- `sessions[id].hidden` — дополнительно скрытые в этом чате;
- `sessions[id].enabled` — глобально скрытые, но возвращённые в этом чате.

Эффективный список: `(defaults ∪ hidden) − enabled`.

### Как навык реально скрывается

SH `ctx.skills` — слоёный реестр: глобальный слой + слои по scope, при чтении ближайший слой выигрывает имя. Каталог для модели (`tool-skill`) читается со `scope: agent`, поэтому:

1. Плагин получает контекст агента в событии `agent/created` (для уже живых агентов — при активации плагина).
2. Для каждого скрытого навыка в области агента монтируется мини-плагин (`agent.ctx.plugin(...)`), который вызывает `ctx.skills.register(...)` с тем же именем и `modelInvocable: false`. Благодаря этому регистрация попадает в слой агента, а не в глобальный.
3. Скрытая запись несёт **настоящий текст** навыка (`ctx.skills.get(name, { cwd, scope })` в области пресета), поэтому пользовательский вызов `/имя` по-прежнему подгружает инструкции.
4. Смена выбора пересоздаёт мини-плагин (dispose → новый), поэтому каталог переопубликовывается один раз на «Применить».

Управляющие модули не создаются: файлы навыков на диске не меняются.

### HTTP

Локальные маршруты на веб-сервере профиля DSH:

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/skill-picker/api/catalog?sessionId=&cwd=` | каталог + состояние выбора + русские подписи |
| POST | `/skill-picker/api/selection` | `{scope:"global",hidden}` или `{scope:"chat",sessionId,hidden,enabled}` |
| GET | `/skill-picker/api/debug` | диагностика: доступность `skills.snapshot/get`, число живых агентов и теней |

Защита: сервер слушает localhost; маршруты проверяют `Origin`/`Host` (чужой origin → 403), запись требует `content-type: application/json` (CSRF-устойчивость), тело ограничено 64 КиБ.

## Client-половина (`client.js`)

- `ctx.sidebarRightTabs.register({ id, kind: 'skills-picker', title, guide })` — тип вкладки правой панели; карточка в гиде с `title`/`description` **функциями** и `order`.
- `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, SkillPicker)` — тело вкладки.
- `ctx.slots.inject('conversation.composer.dock', …)` — кнопка «Навыки» под композером, открывает вкладку через `ctx.sidebarRight.openTab` + `ctx.layout.openRightbar`.
- Данные — `fetch` к `/skill-picker/api/*` (same-origin, cookie не требуется); тема — только theme-tokens хоста.

## Проверка

- Глобальное скрытие: свежий субагент получал каталог из 49 навыков вместо 51 (два скрытых отсутствовали).
- Чатовое переопределение: `effectiveHidden = ["office"]`, применена тень с телом (`withBody: 1`).
- Откат: `defaults = []`, `sessions = {}`, каталог снова 51.
- `skills.get` доступен в Host: пример тела — 6354 символа, `resourceBase.kind = "directory"`.
