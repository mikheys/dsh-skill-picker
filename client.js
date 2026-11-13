/**
 * Browser half of @local/dsh-skill-picker (v2).
 *
 * Right-panel tab "skills-picker": skill checkboxes with Russian explanations,
 * two scopes — this chat and all chats — and an explicit Apply button so one
 * edit session republishes the model catalog once instead of per click.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-skill-picker',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const TYPE_ID = '@local/dsh-skill-picker'
    const TAB_TITLE = 'Навыки'
    const CATEGORY_ORDER = [
      'Мои режимы',
      'Веб и дизайн',
      'Картинки и видео',
      'Документы и Office',
      'Blender и 3D',
      'DSH и плагины',
      'Разное',
      'Прочее',
    ]

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    }

    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '10px 12px 24px',
        color: C.text,
        fontSize: 13,
        lineHeight: 1.45,
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'auto',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      input: {
        background: C.bg2,
        border: '1px solid ' + C.border,
        borderRadius: 8,
        padding: '6px 8px',
        color: C.text,
        fontSize: 13,
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
      },
      btn: {
        background: C.bg2,
        border: '1px solid ' + C.border,
        borderRadius: 8,
        padding: '4px 10px',
        color: C.text,
        fontSize: 12,
        cursor: 'pointer',
      },
      btnPrimary: {
        background: 'transparent',
        border: '1px solid ' + C.brand,
        borderRadius: 8,
        padding: '4px 10px',
        color: C.brand,
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
      },
      seg: {
        display: 'inline-flex',
        border: '1px solid ' + C.border,
        borderRadius: 8,
        overflow: 'hidden',
      },
      segBtn: {
        background: 'transparent',
        border: 'none',
        padding: '5px 10px',
        fontSize: 12,
        color: C.text2,
        cursor: 'pointer',
      },
      segActive: { background: C.bg2, color: C.text, fontWeight: 600 },
      hint: { fontSize: 11.5, color: C.text2, margin: 0 },
      category: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: C.text2,
        textTransform: 'uppercase',
        margin: '10px 0 2px',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: C.bg1,
        border: '1px solid ' + C.border,
        borderRadius: 10,
        padding: '8px 10px',
      },
      item: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '5px 2px',
        borderTop: '1px solid ' + C.border,
      },
      check: { marginTop: 2, accentColor: C.brand, flex: 'none', width: 15, height: 15 },
      title: { fontSize: 13, fontWeight: 500, color: C.text },
      sub: { fontSize: 11.5, color: C.text2 },
      tag: {
        fontSize: 10.5,
        color: C.text2,
        border: '1px solid ' + C.border,
        borderRadius: 6,
        padding: '0 5px',
        lineHeight: '16px',
      },
      empty: { fontSize: 12, color: C.text2, padding: '12px 2px' },
      error: { fontSize: 12, color: C.err },
      saved: { fontSize: 11, color: C.ok },
      footer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        position: 'sticky',
        bottom: 0,
        background: C.bg1,
        border: '1px solid ' + C.border,
        borderRadius: 10,
        padding: '8px 10px',
      },
    }

    function disabledStyle(style, disabled) {
      return disabled ? { ...style, opacity: 0.55, cursor: 'default' } : style
    }

    async function fetchJson(url, init) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
      const value = await response.json().catch(() => null)
      if (value === null) throw new Error('HTTP ' + response.status)
      if (value.ok === false) throw new Error(value.summary || 'request failed')
      return value
    }

    function toggleInSet(source, name) {
      const next = new Set(source)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    }

    function SkillPicker(props) {
      const injected = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const sessionId = props.sessionId ?? injected?.tab?.sessionId
      const useSessions = props.useSessions
      const cwd = typeof useSessions === 'function' && sessionId
        ? useSessions((state) => state?.byId?.[sessionId]?.cwd)
        : undefined

      const [data, setData] = useState(null)
      const [scope, setScope] = useState('chat')
      const [draftGlobal, setDraftGlobal] = useState(() => new Set())
      const [draftChat, setDraftChat] = useState(() => new Set())
      const [dirtyGlobal, setDirtyGlobal] = useState(false)
      const [dirtyChat, setDirtyChat] = useState(false)
      const [query, setQuery] = useState('')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [savedAt, setSavedAt] = useState(0)
      const alive = useRef(true)

      const load = useCallback(async () => {
        if (!sessionId) return
        setError(null)
        setBusy('load')
        try {
          const params = new URLSearchParams({ sessionId })
          if (typeof cwd === 'string' && cwd.length > 0) params.set('cwd', cwd)
          const next = await fetchJson('/skill-picker/api/catalog?' + params.toString())
          if (!alive.current) return
          setData(next)
          setDraftGlobal(new Set(next.defaults ?? []))
          setDraftChat(new Set(next.effectiveHidden ?? []))
          setDirtyGlobal(false)
          setDirtyChat(false)
        } catch (loadError) {
          if (alive.current) setError(String((loadError && loadError.message) || loadError))
        } finally {
          if (alive.current) setBusy(null)
        }
      }, [sessionId, cwd])

      useEffect(() => {
        alive.current = true
        void load()
        return () => {
          alive.current = false
        }
      }, [load])

      const draft = scope === 'global' ? draftGlobal : draftChat
      const dirty = scope === 'global' ? dirtyGlobal : dirtyChat
      const setDraft = scope === 'global' ? setDraftGlobal : setDraftChat
      const setDirty = scope === 'global' ? setDirtyGlobal : setDirtyChat

      const toggle = (name) => {
        setDraft((current) => toggleInSet(current, name))
        setDirty(true)
        setSavedAt(0)
      }

      const skills = data?.skills ?? []
      const nameSet = useMemo(() => new Set(skills.map((skill) => skill.name)), [skills])

      const setAll = (enabled) => {
        const next = enabled
          ? new Set()
          : new Set(skills.filter((skill) => skill.modelInvocable !== false).map((skill) => skill.name))
        setDraft(next)
        setDirty(true)
        setSavedAt(0)
      }

      const setCategory = (categorySkills, enabled) => {
        const next = new Set(draft)
        for (const skill of categorySkills) {
          if (skill.modelInvocable === false) continue
          if (enabled) next.delete(skill.name)
          else next.add(skill.name)
        }
        setDraft(next)
        setDirty(true)
        setSavedAt(0)
      }

      const reset = () => {
        if (scope === 'global') setDraftGlobal(new Set(data?.defaults ?? []))
        else setDraftChat(new Set(data?.effectiveHidden ?? []))
        setDirty(false)
        setError(null)
      }

      const apply = async () => {
        if (!sessionId || !data) return
        setBusy('save')
        setError(null)
        try {
          let body
          if (scope === 'global') {
            body = { scope: 'global', hidden: [...draftGlobal] }
          } else {
            const hidden = []
            const enabled = []
            const defaults = new Set(data.defaults ?? [])
            for (const name of nameSet) {
              const wantHidden = draftChat.has(name)
              const inDefaults = defaults.has(name)
              if (wantHidden) {
                if (!inDefaults) hidden.push(name)
              } else if (inDefaults) {
                enabled.push(name)
              }
            }
            body = { scope: 'chat', sessionId, hidden, enabled }
          }
          await fetchJson('/skill-picker/api/selection', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!alive.current) return
          setSavedAt(Date.now())
          await load()
        } catch (saveError) {
          if (alive.current) setError(String((saveError && saveError.message) || saveError))
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (!needle) return skills
        return skills.filter((skill) => {
          const haystack = [skill.name, skill.title, skill.descriptionRu, skill.description]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          return haystack.includes(needle)
        })
      }, [skills, query])

      const groups = useMemo(() => {
        const byCategory = new Map()
        for (const skill of visible) {
          const category = skill.category || 'Прочее'
          if (!byCategory.has(category)) byCategory.set(category, [])
          byCategory.get(category).push(skill)
        }
        for (const list of byCategory.values()) list.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ru'))
        const ordered = [...byCategory.keys()].sort((a, b) => {
          const left = CATEGORY_ORDER.indexOf(a)
          const right = CATEGORY_ORDER.indexOf(b)
          return (left < 0 ? 99 : left) - (right < 0 ? 99 : right) || a.localeCompare(b, 'ru')
        })
        return ordered.map((category) => [category, byCategory.get(category)])
      }, [visible])

      const enabledCount = skills.length - skills.filter((skill) => draft.has(skill.name)).length
      const defaults = useMemo(() => new Set(data?.defaults ?? []), [data])

      if (!sessionId) {
        return h(
          'div',
          { style: S.page },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, TAB_TITLE),
          h('div', { style: S.empty }, 'Откройте сессию, чтобы выбрать навыки.'),
        )
      }
      if (!data && !error) {
        return h(
          'div',
          { style: S.page },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, TAB_TITLE),
          h('div', { style: S.empty }, 'Загружаю навыки…'),
        )
      }

      const header = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(
          'div',
          { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, TAB_TITLE),
          h('div', { style: S.sub }, sessionId ? 'для этого чата' : ''),
        ),
        h(
          'div',
          { style: S.seg, role: 'tablist' },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': scope === 'chat',
              onClick: () => setScope('chat'),
              style: { ...S.segBtn, ...(scope === 'chat' ? S.segActive : {}) },
            },
            'Этот чат',
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': scope === 'global',
              onClick: () => setScope('global'),
              style: { ...S.segBtn, ...(scope === 'global' ? S.segActive : {}) },
            },
            'Все чаты',
          ),
        ),
        h(
          'p',
          { style: S.hint },
          scope === 'global'
            ? 'Применяется ко всем чатам, включая будущие. Скрытые навыки не попадают в каталог модели; вызвать нужный вручную можно командой /имя в сообщении.'
            : 'Только для этого чата. Метка «скрыт глобально» означает, что навык выключен во всех чатах, но здесь его можно включить обратно.',
        ),
      )

      const controls = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('input', {
          type: 'search',
          value: query,
          placeholder: 'Поиск навыка…',
          onChange: (event) => setQuery(event.target.value),
          style: S.input,
        }),
        h(
          'div',
          { style: { ...S.row, justifyContent: 'space-between' } },
          h('span', { style: S.sub }, 'включено ' + enabledCount + ' из ' + skills.length),
          h(
            'div',
            { style: S.row },
            h('button', { type: 'button', style: S.btn, onClick: () => setAll(true) }, 'Все'),
            h('button', { type: 'button', style: S.btn, onClick: () => setAll(false) }, 'Никакие'),
            h('button', { type: 'button', style: S.btn, onClick: () => void load() }, 'Обновить'),
          ),
        ),
        data?.agentLive === false
          ? h('span', { style: { ...S.sub, color: C.warn } }, 'Сессия ещё не запускала модель — выбор применится при первом сообщении.')
          : null,
      )

      const body = error
        ? h('div', { style: S.error }, error)
        : groups.length === 0
          ? h('div', { style: S.empty }, 'Ничего не найдено.')
          : groups.map(([category, categorySkills]) =>
              h(
                'div',
                { key: category, style: { display: 'flex', flexDirection: 'column' } },
                h(
                  'div',
                  { style: S.category },
                  h('span', {}, category + ' · ' + categorySkills.length),
                  h(
                    'span',
                    { style: { ...S.row, gap: 6 } },
                    h('button', { type: 'button', style: S.btn, onClick: () => setCategory(categorySkills, true) }, 'вкл'),
                    h('button', { type: 'button', style: S.btn, onClick: () => setCategory(categorySkills, false) }, 'выкл'),
                  ),
                ),
                h(
                  'div',
                  { style: S.card },
                  categorySkills.map((skill, index) =>
                    h(
                      'label',
                      { key: skill.name, style: index === 0 ? { ...S.item, borderTop: 'none' } : S.item },
                      h('input', {
                        type: 'checkbox',
                        style: S.check,
                        checked: !draft.has(skill.name),
                        disabled: skill.modelInvocable === false,
                        onChange: () => toggle(skill.name),
                      }),
                      h(
                        'span',
                        { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                        h(
                          'span',
                          { style: S.row },
                          h('span', { style: S.title }, skill.title || skill.name),
                          h('span', { style: S.tag }, skill.name),
                          skill.modelInvocable === false
                            ? h('span', { style: { ...S.tag, color: C.warn } }, 'недоступен модели')
                            : null,
                          defaults.has(skill.name) && scope === 'chat'
                            ? h('span', { style: { ...S.tag, color: C.text2 } }, 'скрыт глобально')
                            : null,
                          scope === 'chat' && skill.chatReenabled
                            ? h('span', { style: { ...S.tag, color: C.ok } }, 'включён для чата')
                            : null,
                        ),
                        skill.descriptionRu
                          ? h('span', { style: S.sub }, skill.descriptionRu)
                          : h('span', { style: S.sub }, skill.description),
                      ),
                    ),
                  ),
                ),
              ),
            )

      const footer = h(
        'div',
        { style: S.footer },
        h(
          'span',
          { style: S.sub, role: 'status', 'aria-live': 'polite' },
          busy === 'save' ? 'Применяю…' : dirty ? 'есть несохранённые изменения' : savedAt ? 'Сохранено' : '',
        ),
        h(
          'span',
          { style: S.row },
          h(
            'button',
            {
              type: 'button',
              style: disabledStyle(S.btn, !dirty || busy !== null),
              disabled: !dirty || busy !== null,
              onClick: reset,
            },
            'Сбросить',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabledStyle(S.btnPrimary, !dirty || busy !== null),
              disabled: !dirty || busy !== null,
              onClick: () => void apply(),
            },
            busy === 'save' ? 'Применяю…' : 'Применить',
          ),
        ),
      )

      return h('div', { style: S.page }, header, controls, body, footer)
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'layout'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.sidebarRightTabs.register({
            id: TYPE_ID,
            kind: 'skills-picker',
            title: () => TAB_TITLE,
            guide: [
              {
                id: 'skills-picker',
                order: 10,
                title: () => TAB_TITLE,
                description: () => 'Отметьте навыки, которые нужны для этой задачи',
              },
            ],
          }),
        )
        ctx.effect(() =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, SkillPicker),
        )

        function OpenSkillsButton() {
          const open = () => {
            try {
              ctx.sidebarRight.openTab('skills-picker')
            } catch {
              /* the tab type may be collapsed; opening the bar still helps */
            }
            try {
              ctx.layout.openRightbar(true, false)
            } catch {
              /* layout unavailable */
            }
          }
          return h(
            'button',
            {
              type: 'button',
              onClick: open,
              title: 'Открыть выбор навыков',
              style: {
                font: 'inherit',
                fontSize: 12,
                lineHeight: 1.2,
                color: 'var(--dsw-alias-label-secondary)',
                background: 'transparent',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 8,
                padding: '2px 10px',
                cursor: 'pointer',
              },
            },
            'Навыки',
          )
        }

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'skill-picker-open', order: 25 },
            OpenSkillsButton,
          ),
        )
      },
    }
  },
})
