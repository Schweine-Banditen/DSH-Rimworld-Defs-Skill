/**
 * Client half of the RimWorld Defs panel.
 *
 * Left: file-manager tree (source → category → defs). Right: tree view of the
 * opened def. Header: settings (translation table) and back control.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-rimworld-defs',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    const API = '/rimworld-defs/api'
    const PLACEHOLDER = `${API}/placeholder`
    const STORAGE_KEY = 'rimworld-defs.translations'

    const MATERIALS = [
      { id: 'default', label: '默认（灰）', color: '#9a9a9a' },
      { id: 'steel', label: '钢铁（土灰）', color: '#6f6a60' },
      { id: 'plasteel', label: '玻璃钢（青蓝）', color: '#6f9db0' },
      { id: 'uranium', label: '铀矿（淡灰）', color: '#b9bcc4' },
    ]

    // ---- 翻译集：可保存、可切换的多份翻译表 ----
    // 旧版只存一份（STORAGE_KEY）；首次启动时自动迁移成名为「我的翻译」的翻译集。
    const PROFILE_KEY = 'rimworld-defs.translation-profiles'
    const PRESET_CACHE_KEY = 'rimworld-defs.preset.zh-CN'
    const DEFAULT_SET = 'default'
    const BUILTIN_PRESET = 'zh-CN'

    let BUILTIN = null
    try {
      BUILTIN = JSON.parse(localStorage.getItem(PRESET_CACHE_KEY) || 'null')
    } catch {
      BUILTIN = null
    }

    let PROFILES = { active: DEFAULT_SET, sets: {} }
    let TRANSLATIONS = {}

    function readStorage(key, fallback) {
      try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch {
        return fallback
      }
    }

    function writeStorage(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* 配额满时静默失败：翻译只是本地便利功能 */
      }
    }

    function replaceTranslations(entries) {
      for (const key of Object.keys(TRANSLATIONS)) delete TRANSLATIONS[key]
      Object.assign(TRANSLATIONS, entries || {})
    }

    /** 某个翻译集的条目：default 恒为空，内置集只读，其余取用户集合。 */
    function entriesForSet(id) {
      if (id === DEFAULT_SET) return {}
      if (id === BUILTIN_PRESET) return (BUILTIN && BUILTIN.entries) || {}
      return PROFILES.sets[id] || {}
    }

    function persistProfiles() {
      writeStorage(PROFILE_KEY, PROFILES)
    }

    /** 只写用户集合；default 与内置集不落盘。 */
    function persistActiveSet() {
      if (PROFILES.active === DEFAULT_SET || PROFILES.active === BUILTIN_PRESET) return
      PROFILES.sets[PROFILES.active] = { ...TRANSLATIONS }
      persistProfiles()
    }

    function activateSet(id) {
      PROFILES.active = id
      replaceTranslations(entriesForSet(id))
      persistProfiles()
      return id
    }

    /** 把当前翻译复制成一个新集合（重名自动加序号），并切换过去。 */
    function createSetFromCurrent(name) {
      let candidate = String(name || '').trim() || '我的翻译'
      if (PROFILES.sets[candidate]) {
        let index = 2
        while (PROFILES.sets[`${candidate} ${index}`]) index += 1
        candidate = `${candidate} ${index}`
      }
      PROFILES.sets[candidate] = { ...TRANSLATIONS }
      PROFILES.active = candidate
      persistProfiles()
      return candidate
    }

    (function bootTranslationProfiles() {
      const saved = readStorage(PROFILE_KEY, null)
      if (saved && typeof saved === 'object' && saved.sets && typeof saved.sets === 'object') {
        PROFILES = { active: saved.active || DEFAULT_SET, sets: saved.sets }
      } else {
        const legacy = readStorage(STORAGE_KEY, {})
        const hasLegacy = legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0
        PROFILES = hasLegacy
          ? { active: '我的翻译', sets: { 我的翻译: legacy } }
          : { active: DEFAULT_SET, sets: {} }
        persistProfiles()
      }
      replaceTranslations(entriesForSet(PROFILES.active))
    })()

    function zhOf(key) {
      const value = TRANSLATIONS[key]
      return typeof value === 'string' && value.trim() ? value.trim() : ''
    }

    function withZh(key) {
      const zh = zhOf(key)
      return zh ? `${key}（${zh}）` : key
    }

    const XML_CACHE = new Map()

    const CSS = `
      @keyframes rwDetailIn { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }
      @keyframes rwRowIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
      @keyframes rwExpand { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
      @keyframes rwFlash { 0% { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); } 100% { background: transparent; } }
      .rw-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
      .rw-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 4px; }
      .rw-row:hover { background: var(--dsw-alias-bg-layer-2); }
      .rw-attr:hover { background: var(--dsw-alias-bg-layer-2); }
    `

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 18px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        flexWrap: 'wrap',
        flex: '0 0 auto',
      },
      title: { fontSize: 16, fontWeight: 600 },
      status: { fontSize: 11, padding: '2px 8px', borderRadius: 999 },
      meta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      headerActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 },
      iconBtn: {
        width: 28,
        height: 28,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 7,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
      },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      left: {
        width: 330,
        borderRight: '1px solid var(--dsw-alias-border-l1)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      },
      leftHeader: {
        padding: '8px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flex: '0 0 auto',
        background: 'var(--dsw-alias-bg-base)',
        zIndex: 2,
      },
      searchWrap: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, position: 'relative' },
      searchField: {
        flex: 1,
        minWidth: 0,
        padding: '6px 24px 6px 9px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        outline: 'none',
        fontSize: 12,
      },
      clearBtn: {
        position: 'absolute',
        right: 4,
        top: '50%',
        transform: 'translateY(-50%)',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        fontSize: 15,
        lineHeight: 1,
        padding: '2px 4px',
      },
      collapseBtn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 6,
        width: 26,
        height: 26,
        fontSize: 13,
        lineHeight: 1,
        cursor: 'pointer',
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      tree: { flex: 1, overflow: 'auto', padding: '6px 0' },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        paddingRight: 10,
        cursor: 'pointer',
        fontSize: 12.5,
        whiteSpace: 'nowrap',
      },
      rowSelected: { background: 'var(--dsw-alias-bg-layer-1)', boxShadow: 'inset 2px 0 0 var(--dsw-alias-brand-primary)' },
      chevron: { width: 14, textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: 10 },
      count: { marginLeft: 'auto', color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
      leafSub: { color: 'var(--dsw-alias-label-secondary)', fontSize: 10.5, marginLeft: 4 },
      right: { flex: 1, overflow: 'auto', padding: '20px 24px' },
      empty: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5 },
      rootCard: {
        position: 'relative',
        display: 'flex',
        gap: 14,
        alignItems: 'center',
        padding: '14px 16px',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        animation: 'rwDetailIn .28s ease-out',
      },
      imageFrame: {
        width: 84,
        height: 84,
        borderRadius: 10,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
      },
      rootImage: {
        width: 84,
        height: 84,
        objectFit: 'contain',
        imageRendering: 'pixelated',
      },
      rootTitle: { fontSize: 19, fontWeight: 600 },
      rootSub: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 4 },
      materialSelect: {
        position: 'absolute',
        right: 10,
        bottom: 8,
        fontSize: 11,
        padding: '2px 6px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      connectorWrap: { display: 'flex', justifyContent: 'center', height: 22, position: 'relative' },
      connectorLine: { width: 1, background: 'var(--dsw-alias-border-l2)' },
      branches: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' },
      branch: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '10px 12px',
        minWidth: 0,
        animation: 'rwDetailIn .32s ease-out',
      },
      branchTitle: { fontSize: 11.5, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8, letterSpacing: '.02em' },
      sectionTitle: { fontSize: 11.5, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 },
      attrRow: { display: 'flex', flexDirection: 'column', gap: 2, padding: '5px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      attrKey: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, wordBreak: 'break-word' },
      attrVal: { wordBreak: 'break-word', minWidth: 0, fontSize: 12.5 },
      chainRow: { padding: '3px 0', fontSize: 12.5, animation: 'rwRowIn .25s ease-out both' },
      warn: {
        marginTop: 14,
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-primary)',
        fontSize: 12,
      },
      searchItem: {
        padding: '7px 12px',
        cursor: 'pointer',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        animation: 'rwExpand .18s ease-out',
      },
      searchSub: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, marginTop: 2 },
      popover: {
        position: 'fixed',
        zIndex: 9999,
        width: 520,
        maxHeight: 360,
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,.35)',
        padding: '8px 10px',
        animation: 'rwExpand .12s ease-out',
      },
      pre: { margin: 0, fontFamily: 'Consolas, monospace', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre' },
      settingsPage: { flex: 1, display: 'flex', minHeight: 0 },
      settingsTabs: { width: 180, borderRight: '1px solid var(--dsw-alias-border-l1)', padding: '10px 8px' },
      tabItem: { padding: '7px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 12.5 },
      tabActive: { background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-brand-primary)' },
      settingsBody: { flex: 1, overflow: 'auto', padding: '16px 22px' },
      setBar: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
      setLabel: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      select: { fontSize: 12, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      button: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: { textAlign: 'left', color: 'var(--dsw-alias-label-secondary)', fontWeight: 600, padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      td: { padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'middle' },
      toolCard: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 },
      toolHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
      toolName: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, fontWeight: 600 },
      toolBadge: { marginLeft: 'auto', fontSize: 11.5, padding: '1px 7px', borderRadius: 999, color: 'var(--dsw-alias-brand-primary)', border: '1px solid var(--dsw-alias-brand-primary)' },
      toolBadgeOff: { marginLeft: 'auto', fontSize: 11.5, padding: '1px 7px', borderRadius: 999, color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)' },
      toolTitle: { fontSize: 12.5, fontWeight: 600, marginBottom: 2 },
      toolDesc: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, marginBottom: 6 },
      toolUsage: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, background: 'var(--dsw-alias-bg-layer-1)', padding: '6px 8px', borderRadius: 6, marginBottom: 8, overflowX: 'auto' },
      input: {
        width: '100%',
        padding: '4px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        outline: 'none',
        fontSize: 12,
      },
    }

    function PanelIcon({ size = 20, active }) {
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2, stroke: color, strokeWidth: 1.6 }),
        h('path', { d: 'M3.5 9h17', stroke: color, strokeWidth: 1.6 }),
        h('path', { d: 'M8 13h8M8 16.2h5', stroke: color, strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 6.2, cy: 6.8, r: 0.9, fill: color }),
      )
    }

    function StatusChip({ notice }) {
      if (!notice) return null
      const map = {
        current: ['var(--dsw-alias-state-success-primary)', '数据最新'],
        stale: ['var(--dsw-alias-state-warn-primary)', '数据过期'],
        unknown: ['var(--dsw-alias-state-idle-primary)', '版本未知'],
      }
      const [color, text] = map[notice.status] || map.unknown
      return h('span', { style: { ...styles.status, color, border: `1px solid ${color}` } }, text)
    }

    function TreeRow({ depth, label, count, open, onClick, selected, sub, flash }) {
      return h(
        'div',
        {
          className: 'rw-row',
          style: {
            ...styles.row,
            paddingLeft: 8 + depth * 14,
            ...(selected ? styles.rowSelected : null),
            ...(flash ? { animation: 'rwFlash .9s ease-out' } : null),
          },
          onClick,
          role: 'treeitem',
          'aria-expanded': open === undefined ? undefined : open,
        },
        h('span', { style: styles.chevron }, open === undefined ? '•' : open ? '▾' : '▸'),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        sub ? h('span', { style: styles.leafSub }, sub) : null,
        count !== undefined ? h('span', { style: styles.count }, count) : null,
      )
    }

    /** 展开/收起的时长与缓动：180ms 足够跟手，再长就会显得拖沓。 */
    const COLLAPSE_MS =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 0
        : 180
    const COLLAPSE_EASE = 'cubic-bezier(0.2, 0.7, 0.3, 1)'

    /**
     * 文件树的高度过渡容器。
     *
     * 用 `grid-template-rows: 0fr ↔ 1fr` 而不是测量像素高度：分组里还有「显示更多」
     * 分页按钮，内容高度会变，量出来的 px 迟早过期。
     *
     * 卸载策略：收起时先动画到 0fr，等过渡结束再卸载子树，避免收起后还挂着几百行
     * DOM；展开时先以 0fr 挂载、下一帧再切到 1fr，这样首帧就有可插值的起点。
     */
    function Collapse({ open, children }) {
      const [mounted, setMounted] = useState(open)
      const [shown, setShown] = useState(open)
      const mountedRef = useRef(open)

      useEffect(() => {
        mountedRef.current = mounted
      }, [mounted])

      useEffect(() => {
        let first = 0
        let second = 0
        let timer = 0
        if (open) {
          if (mountedRef.current) {
            setShown(true)
          } else {
            setMounted(true)
            setShown(false)
            first = requestAnimationFrame(() => {
              second = requestAnimationFrame(() => setShown(true))
            })
          }
        } else {
          setShown(false)
          if (COLLAPSE_MS === 0) setMounted(false)
          else timer = setTimeout(() => setMounted(false), COLLAPSE_MS + 40)
        }
        return () => {
          if (first) cancelAnimationFrame(first)
          if (second) cancelAnimationFrame(second)
          if (timer) clearTimeout(timer)
        }
      }, [open])

      if (!mounted) return null
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateRows: shown ? '1fr' : '0fr',
            transition: COLLAPSE_MS === 0 ? undefined : `grid-template-rows ${COLLAPSE_MS}ms ${COLLAPSE_EASE}`,
          },
          'aria-hidden': open ? undefined : 'true',
        },
        h(
          'div',
          {
            style: {
              overflow: 'hidden',
              minHeight: 0,
              opacity: shown ? 1 : 0,
              transition: COLLAPSE_MS === 0 ? undefined : `opacity ${COLLAPSE_MS}ms ${COLLAPSE_EASE}`,
            },
          },
          typeof children === 'function' ? children() : children,
        ),
      )
    }

    function Explorer({ sources, expanded, toggle, selectedKey, onSelect }) {
      const [limits, setLimits] = useState({})
      const PAGE = 250

      return h(
        'div',
        { style: styles.tree, role: 'tree' },
        sources.map((source) => {
          const sourceKey = source.name
          const sourceOpen = !!expanded[sourceKey]
          return h(
            'div',
            { key: `s:${sourceKey}` },
            h(TreeRow, {
              depth: 0,
              label: sourceKey,
              count: source.count,
              open: sourceOpen,
              onClick: () => toggle(sourceKey),
            }),
            h(Collapse, { open: sourceOpen }, () =>
              source.groups.map((group) => {
                const groupKey = `${sourceKey}::${group.key}`
                const groupOpen = !!expanded[groupKey]
                return h(
                  'div',
                  { key: `g:${groupKey}` },
                  h(TreeRow, {
                    depth: 1,
                    label: group.label,
                    count: group.count,
                    open: groupOpen,
                    onClick: () => toggle(groupKey),
                  }),
                  h(Collapse, { open: groupOpen }, () => {
                    const shown = limits[groupKey] || PAGE
                    const selectedIndex = group.items.findIndex(
                      (item) => `${sourceKey}:${item.defType}:${item.defName}` === selectedKey,
                    )
                    const cutoff = selectedIndex >= 0 ? Math.max(shown, selectedIndex + 1) : shown
                    const visible = group.items.slice(0, cutoff)
                    const rows = visible.map((item) => {
                      const key = `${sourceKey}:${item.defType}:${item.defName}`
                      return h(TreeRow, {
                        key: `d:${key}`,
                        depth: 2,
                        label: zhOf(item.label) || item.label || item.defName,
                        sub: item.defType,
                        selected: selectedKey === key,
                        flash: selectedKey === key,
                        onClick: () => onSelect(item, sourceKey),
                      })
                    })
                    if (group.items.length > visible.length) {
                      rows.push(
                        h(
                          'div',
                          {
                            key: `more:${groupKey}`,
                            className: 'rw-row',
                            style: { ...styles.row, paddingLeft: 8 + 2 * 14, color: 'var(--dsw-alias-brand-primary)' },
                            onClick: () => setLimits((prev) => ({ ...prev, [groupKey]: shown + PAGE })),
                          },
                          h('span', { style: styles.chevron }, '+'),
                          h('span', null, `显示更多（剩余 ${group.items.length - visible.length}）`),
                        ),
                      )
                    }
                    return rows
                  }),
                )
              }),
            ),
          )
        }),
      )
    }

    function Attr({ label, value }) {
      if (value === null || value === undefined || value === '') return null
      return h(
        'div',
        { className: 'rw-attr', style: styles.attrRow },
        h('span', { style: styles.attrKey }, withZh(label)),
        h('span', { style: styles.attrVal }, String(value)),
      )
    }

    function Section({ title, children }) {
      return h('div', { style: { marginTop: 10 } }, h('div', { style: styles.sectionTitle }, title), children)
    }

    function ValueRow({ name, value, from }) {
      return h(
        'div',
        { className: 'rw-attr', style: styles.attrRow },
        h('span', { style: styles.attrKey }, withZh(name)),
        h(
          'span',
          { style: styles.attrVal },
          value,
          from && from !== 'self'
            ? h(
                'span',
                { style: { color: 'var(--dsw-alias-label-secondary)', marginLeft: 6, fontSize: 11 } },
                `（继承自 ${from}）`,
              )
            : null,
        ),
      )
    }

    function FieldsPanel({ record }) {
      const fields = record.fields || {}
      const scalars = fields.scalars || {}
      const statBases = fields.statBases || null
      const building = fields.building || null
      const comps = fields.comps || null
      if (!Object.keys(fields).length) return null

      const sections = []
      const scalarRows = Object.entries(scalars)
      if (scalarRows.length) {
        sections.push(
          h(
            Section,
            { key: 'scalars', title: '关键字段' },
            scalarRows.map(([name, entry]) => h(ValueRow, { key: name, name, value: entry.value, from: entry.from })),
          ),
        )
      }
      if (statBases && statBases.value) {
        const inherited = statBases.inheritedFrom || {}
        sections.push(
          h(
            Section,
            { key: 'statBases', title: 'statBases（模板合并）' },
            Object.entries(statBases.value).map(([name, value]) =>
              h(ValueRow, { key: name, name, value, from: inherited[name] }),
            ),
          ),
        )
      }
      if (building && building.value) {
        const value = building.value
        const rows = []
        if (value.storageGroupTag) {
          rows.push(h(ValueRow, { key: 'tag', name: 'storageGroupTag', value: value.storageGroupTag }))
        }
        for (const key of ['defaultStorageSettings', 'fixedStorageSettings']) {
          const settings = value[key]
          if (!settings) continue
          if (settings.priority) {
            rows.push(h(ValueRow, { key: `${key}.priority`, name: `${key}.priority`, value: settings.priority }))
          }
          if (settings.categories) {
            rows.push(h(ValueRow, { key: `${key}.categories`, name: `${key}.categories`, value: settings.categories.join(', ') }))
          }
          if (settings.disallowedCategories) {
            rows.push(h(ValueRow, { key: `${key}.denyCat`, name: '不允许类别', value: settings.disallowedCategories.join(', ') }))
          }
          if (settings.disallowedThingDefs) {
            rows.push(h(ValueRow, { key: `${key}.denyDef`, name: '不允许 Def', value: settings.disallowedThingDefs.join(', ') }))
          }
        }
        sections.push(
          h(
            Section,
            { key: 'building', title: `存储 / 建筑${building.from !== 'self' ? `（继承自 ${building.from}）` : ''}` },
            rows,
          ),
        )
      }
      if (comps && comps.value) {
        sections.push(
          h(
            Section,
            { key: 'comps', title: `comps${comps.from !== 'self' ? `（继承自 ${comps.from}）` : ''}` },
            comps.value.map((comp, index) =>
              h(
                'div',
                { key: index, style: { padding: '4px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
                h('div', { style: { fontSize: 12.5, fontWeight: 500 } }, withZh(comp.class || '(无 Class)')),
                Object.entries(comp.props || {}).map(([key, value]) =>
                  h(
                    'div',
                    { key, style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', paddingLeft: 10 } },
                    `${withZh(key)}: ${value}`,
                  ),
                ),
              ),
            ),
          ),
        )
      }
      return sections
    }

    function XmlPopover({ state, onClose, onEnter }) {
      if (!state) return null
      // 以被悬停元素的矩形为锚点：贴着它下方；下方放不下就翻到上方。
      // 这样弹层永远不会盖住鼠标，避免"出现即被 mouseleave 关掉"的抖动。
      const width = 520
      const height = 360
      const anchor = state.anchor
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 12))
      let top = anchor.bottom + 8
      if (top + height > window.innerHeight - 8) {
        top = Math.max(8, anchor.top - height - 8)
      }
      return h(
        'div',
        { style: { ...styles.popover, left, top }, onMouseEnter: onEnter, onMouseLeave: onClose },
        state.loading
          ? h('div', { style: styles.empty }, '加载 XML…')
          : h('pre', { style: styles.pre }, state.text),
      )
    }

    function Detail({ record }) {
      const [imageFailed, setImageFailed] = useState(false)
      const [material, setMaterial] = useState('default')
      const [xmlState, setXmlState] = useState(null)
      const closeTimer = useRef(0)
      const recordKey = record ? `${record.defType}:${record.defName || record.Name}` : 'none'

      useEffect(() => {
        setImageFailed(false)
        setMaterial('default')
        setXmlState(null)
        if (closeTimer.current) {
          clearTimeout(closeTimer.current)
          closeTimer.current = 0
        }
      }, [recordKey])

      useEffect(() => () => {
        if (closeTimer.current) clearTimeout(closeTimer.current)
      }, [])

      const cancelClose = () => {
        if (closeTimer.current) {
          clearTimeout(closeTimer.current)
          closeTimer.current = 0
        }
      }

      // 延迟关闭：给鼠标从文字移动到弹层留出时间（14px 间隙原本跨不过去）。
      const scheduleClose = () => {
        cancelClose()
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = 0
          setXmlState(null)
        }, 240)
      }

      if (!record) {
        return h('div', { style: styles.empty }, '在左侧展开来源与分类，或使用搜索。')
      }

      const graphic = record.graphic || {}
      const tex = graphic.effective && graphic.effective.texPath
      const coreUnsupported = record.source === 'Core' && !!tex
      const src =
        tex && !coreUnsupported && !imageFailed
          ? `${API}/icon?tex=${encodeURIComponent(tex)}&source=${encodeURIComponent(record.source)}`
          : PLACEHOLDER
      const name = record.labelZh || record.label || record.titleZh || record.title || record.defName || record.Name || '(无显示名)'
      const chain = record.parentChain || []
      const notes = record.notes || []
      const fields = record.fields || {}
      const dyeable =
        record.defType === 'ThingDef' &&
        ((record.thingCategories || []).some((item) => /apparel/i.test(String(item))) ||
          (fields.scalars && fields.scalars.costStuffCount))
      const activeMaterial = MATERIALS.find((item) => item.id === material) || MATERIALS[0]

      const openXml = (event) => {
        const path = record.sourcePath
        event.preventDefault()
        cancelClose()
        const rect = event.currentTarget.getBoundingClientRect()
        const anchor = { left: rect.left, top: rect.top, bottom: rect.bottom }
        if (XML_CACHE.has(path)) {
          setXmlState({ anchor, text: buildSnippet(XML_CACHE.get(path), record), loading: false })
          return
        }
        setXmlState({ anchor, text: '加载 XML…', loading: true })
        fetch(`${API}/xml?path=${encodeURIComponent(path)}`)
          .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((text) => {
            XML_CACHE.set(path, text)
            setXmlState({ anchor, text: buildSnippet(text, record), loading: false })
          })
          .catch((error) => setXmlState({ anchor, text: `读取失败：${error}`, loading: false }))
      }

      return h(
        'div',
        { key: recordKey },
        h(
          'div',
          { style: styles.rootCard },
          h(
            'div',
            { style: { ...styles.imageFrame, background: activeMaterial.color }, title: dyeable ? '材质染色（预览）' : undefined },
            h('img', {
              src,
              alt: name,
              style: { ...styles.rootImage, mixBlendMode: material === 'default' ? 'normal' : 'multiply' },
              onError: () => setImageFailed(true),
            }),
          ),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div', { style: styles.rootTitle }, name),
            h('div', { style: styles.rootSub }, `${record.defType} · ${record.defName || record.Name || '(无 defName)'}`),
            h(
              'div',
              { style: styles.rootSub },
              `来源 ${record.source}${coreUnsupported ? ' · Core 贴图暂不支持显示' : tex ? ' · 有贴图' : ' · 使用占位图'}`,
            ),
            coreUnsupported
              ? h(
                  'div',
                  { style: { ...styles.rootSub, color: 'var(--dsw-alias-state-warn-primary)' } },
                  'Core 的 .split 贴图格式尚未解析，暂以占位图显示；DLC 贴图正常。',
                )
              : null,
          ),
          dyeable
            ? h(
                'select',
                {
                  style: styles.materialSelect,
                  value: material,
                  onChange: (event) => setMaterial(event.target.value),
                  title: '材质染色预览',
                  'aria-label': '材质染色预览',
                },
                MATERIALS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
              )
            : null,
        ),
        h('div', { style: styles.connectorWrap }, h('div', { style: styles.connectorLine })),
        h(
          'div',
          { style: styles.branches },
          h(
            'div',
            { style: styles.branch },
            h('div', { style: styles.branchTitle }, '属性'),
            h(Attr, { label: 'label', value: record.label }),
            h(Attr, { label: 'labelZh', value: record.labelZh }),
            h(Attr, { label: 'title', value: record.title }),
            h(Attr, { label: 'titleZh', value: record.titleZh }),
            h(Attr, { label: 'category', value: record.category }),
            h(Attr, { label: 'thingCategories', value: (record.thingCategories || []).join(', ') }),
            h(Attr, { label: 'MayRequire', value: record.MayRequire }),
            h(Attr, { label: 'MayRequireAnyOf', value: record.MayRequireAnyOf }),
            h(Attr, { label: 'Abstract', value: record.Abstract === true ? 'true（模板）' : null }),
            h(Attr, { label: 'Class', value: record.Class }),
            h(FieldsPanel, { record }),
          ),
          h(
            'div',
            { style: styles.branch },
            h('div', { style: styles.branchTitle }, '来源与继承'),
            h(Attr, { label: '来源', value: record.source }),
            h(Attr, { label: '类型', value: record.defType }),
            h(Attr, { label: 'ParentName', value: record.ParentName }),
            h(Attr, {
              label: '解析状态',
              value:
                record.parentResolved === false
                  ? '未解析（不在扫描范围）'
                  : record.parentResolved === true
                    ? '已解析'
                    : '无父级',
            }),
            chain.length
              ? h(
                  'div',
                  { style: { marginTop: 6 } },
                  chain.map((hop, index) =>
                    h(
                      'div',
                      { key: index, style: { ...styles.chainRow, animationDelay: `${index * 40}ms` } },
                      `${'　'.repeat(index)}└─ ${hop.defType || '?'}:${hop.defName || hop.Name || hop.reason || '?'}` +
                        (hop.resolved === false ? '（未解析）' : hop.abstract ? '（模板）' : ''),
                    ),
                  ),
                )
              : null,
            h(Attr, { label: '贴图', value: tex }),
            h(
              'div',
              { className: 'rw-attr', style: styles.attrRow },
              h('span', { style: styles.attrKey }, withZh('sourcePath')),
              h(
                'span',
                {
                  style: { ...styles.attrVal, cursor: 'help', textDecoration: 'underline dotted' },
                  onMouseEnter: openXml,
                  onMouseLeave: scheduleClose,
                },
                record.sourcePath,
              ),
            ),
          ),
        ),
        notes.length ? h('div', { style: styles.warn }, notes.join(' ')) : null,
        h(
          'div',
          { style: { ...styles.empty, marginTop: 14, lineHeight: 1.7 } },
          '静态模板层：不合并 ParentName 的字段；MayRequire 是原始条件；完整字段请打开 sourcePath 指向的 XML。',
        ),
        h(XmlPopover, { state: xmlState, onClose: scheduleClose, onEnter: cancelClose }),
      )
    }

    function buildSnippet(text, record) {
      const marker = record.defName ? `<defName>${record.defName}</defName>` : ''
      const index = marker ? text.indexOf(marker) : -1
      const start = index > 800 ? index - 800 : 0
      const end = Math.min(text.length, start + 4200)
      return `${start > 0 ? '…\n' : ''}${text.slice(start, end)}${end < text.length ? '\n…' : ''}`
    }

    function ToolSettings({ info }) {
      const tools = (info && info.tools) || []
      const registered = new Set((info && info.registered) || [])
      if (info === null) return h('div', { style: styles.empty }, '加载中…')
      if (tools.length === 0) return h('div', { style: styles.empty }, '面板未提供工具目录。')

      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '智能体工具'),
          h(
            'span',
            { style: styles.empty },
            '无需配置。这些工具由面板插件注册，会话中可直接调用；这里只列出名称、参数与用法。',
          ),
        ),
        tools.map((tool) =>
          h(
            'div',
            { key: tool.name, style: styles.toolCard },
            h(
              'div',
              { style: styles.toolHead },
              h('code', { style: styles.toolName }, tool.name),
              h(
                'span',
                { style: registered.has(tool.name) ? styles.toolBadge : styles.toolBadgeOff },
                registered.has(tool.name) ? '已注册' : '未注册',
              ),
            ),
            h('div', { style: styles.toolTitle }, `${tool.title} · ${tool.summary}`),
            h('div', { style: styles.toolDesc }, tool.description),
            h('div', { style: styles.toolUsage }, tool.usage),
            h(
              'table',
              { style: styles.table },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { style: styles.th }, '参数'),
                  h('th', { style: styles.th }, '类型'),
                  h('th', { style: styles.th }, '必填'),
                  h('th', { style: styles.th }, '说明'),
                ),
              ),
              h(
                'tbody',
                null,
                tool.parameters.map((param) =>
                  h(
                    'tr',
                    { key: param.name },
                    h('td', { style: styles.td }, h('code', null, param.name)),
                    h('td', { style: styles.td }, param.type),
                    h('td', { style: styles.td }, param.required ? '是' : '否'),
                    h('td', { style: styles.td }, param.description),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function SettingsPanel({ onBack }) {
      const [tab, setTab] = useState('translation')
      const [keys, setKeys] = useState([])
      const [query, setQuery] = useState('')
      const [revision, setRevision] = useState(0)
      const [error, setError] = useState(null)
      const [toolInfo, setToolInfo] = useState(null)
      const [activeSet, setActiveSet] = useState(PROFILES.active)
      const [setNames, setSetNames] = useState(() => Object.keys(PROFILES.sets))
      const [newSetName, setNewSetName] = useState('')
      const [notice, setNotice] = useState('')

      useEffect(() => {
        fetch(`${API}/keys`)
          .then((response) => response.json())
          .then((payload) => setKeys(payload.keys || []))
          .catch((err) => setError(String(err)))
        fetch(`${API}/tools`)
          .then((response) => response.json())
          .then((payload) => setToolInfo(payload))
          .catch(() => setToolInfo({ tools: [], registered: [] }))
        fetch(`${API}/presets`)
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((preset) => {
            BUILTIN = preset
            writeStorage(PRESET_CACHE_KEY, preset)
            if (PROFILES.active === BUILTIN_PRESET) {
              replaceTranslations(entriesForSet(BUILTIN_PRESET))
              setRevision((value) => value + 1)
            }
          })
          .catch(() => setNotice('内置翻译集不可用（面板未提供预设文件）'))
      }, [])

      const filtered = keys.filter((key) => {
        const needle = query.trim().toLowerCase()
        if (!needle) return true
        return key.toLowerCase().includes(needle) || zhOf(key).toLowerCase().includes(needle)
      })

      // 内置集与默认集只读：在它们上面编辑时，先把当前内容另存成一个用户集。
      const ensureEditable = () => {
        if (PROFILES.active !== DEFAULT_SET && PROFILES.active !== BUILTIN_PRESET) return
        const name = createSetFromCurrent(newSetName || '我的翻译')
        setActiveSet(name)
        setSetNames(Object.keys(PROFILES.sets))
        setNewSetName('')
        setNotice(`已另存为「${name}」`)
      }

      const switchSet = (id) => {
        if (id === activeSet) return
        activateSet(id)
        setActiveSet(id)
        setSetNames(Object.keys(PROFILES.sets))
        setRevision((value) => value + 1)
        setNotice('')
      }

      const setValue = (key, value) => {
        ensureEditable()
        if (value.trim()) TRANSLATIONS[key] = value
        else delete TRANSLATIONS[key]
        persistActiveSet()
        setRevision((value) => value + 1)
      }

      const saveNow = () => {
        persistActiveSet()
        setNotice(`已保存「${PROFILES.active}」`)
      }

      const saveAs = () => {
        const name = createSetFromCurrent(newSetName)
        persistActiveSet()
        setActiveSet(name)
        setSetNames(Object.keys(PROFILES.sets))
        setNewSetName('')
        setNotice(`已另存为「${name}」`)
      }

      const removeSet = () => {
        if (PROFILES.active === DEFAULT_SET || PROFILES.active === BUILTIN_PRESET) return
        const removed = PROFILES.active
        delete PROFILES.sets[removed]
        activateSet(DEFAULT_SET)
        setActiveSet(DEFAULT_SET)
        setSetNames(Object.keys(PROFILES.sets))
        setRevision((value) => value + 1)
        setNotice(`已删除「${removed}」`)
      }

      const builtinLabel = (BUILTIN && BUILTIN.label) || '简体中文（内置）'
      const readOnlySet = activeSet === DEFAULT_SET || activeSet === BUILTIN_PRESET

      return h(
        'div',
        { style: styles.settingsPage },
        h(
          'div',
          { style: styles.settingsTabs },
          [
            { id: 'translation', label: '翻译' },
            { id: 'tools', label: '智能体工具' },
          ].map((item) =>
            h(
              'div',
              {
                key: item.id,
                style: { ...styles.tabItem, ...(tab === item.id ? styles.tabActive : null) },
                onClick: () => setTab(item.id),
              },
              item.label,
            ),
          ),
        ),
        h(
          'div',
          { style: styles.settingsBody },
          tab === 'tools'
            ? h(ToolSettings, { info: toolInfo })
            : h(
            'div',
            null,
            h(
              'div',
              { style: styles.setBar },
              h('span', { style: styles.setLabel }, '翻译集'),
              h(
                'select',
                { style: styles.select, value: activeSet, onChange: (event) => switchSet(event.target.value) },
                h('option', { value: DEFAULT_SET }, '默认（全部为空）'),
                h('option', { value: BUILTIN_PRESET }, builtinLabel),
                setNames.map((name) => h('option', { key: name, value: name }, name)),
              ),
              h('input', {
                style: { ...styles.input, width: 180 },
                placeholder: '另存为名称（留空自动命名）',
                value: newSetName,
                onChange: (event) => setNewSetName(event.target.value),
                'aria-label': '另存为名称',
              }),
              h('button', { style: styles.button, onClick: saveNow, disabled: readOnlySet }, '保存'),
              h('button', { style: styles.button, onClick: saveAs }, '另存为'),
              h('button', { style: styles.button, onClick: removeSet, disabled: readOnlySet }, '删除'),
              h(
                'span',
                { style: styles.empty },
                notice || `已翻译 ${Object.keys(TRANSLATIONS).length} 项${readOnlySet ? ' · 只读集，编辑会自动另存' : ''}`,
              ),
            ),
            h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 } },
            h('div', { style: { fontSize: 15, fontWeight: 600 } }, '翻译'),
            h('span', { style: styles.empty }, '为字段名补充中文；填写后会在属性显示时追加。'),
            h('input', {
              style: { ...styles.input, width: 240, marginLeft: 'auto' },
              placeholder: '搜索字段或中文',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              'aria-label': '搜索字段',
            }),
          ),
          error ? h('div', { style: styles.empty }, `加载失败：${error}`) : null,
          h(
            'table',
            { style: styles.table },
            h('thead', null, h('tr', null, h('th', { style: styles.th }, '英文关键字段'), h('th', { style: styles.th }, '中文（自定义）'))),
            h(
              'tbody',
              null,
              filtered.map((key) =>
                h(
                  'tr',
                  { key },
                  h('td', { style: styles.td }, key),
                  h(
                    'td',
                    { style: styles.td },
                    h('input', {
                      style: styles.input,
                      value: TRANSLATIONS[key] || '',
                      placeholder: '留空则不追加',
                      onChange: (event) => setValue(key, event.target.value),
                      'aria-label': `翻译 ${key}`,
                    }),
                  ),
                ),
              ),
            ),
          ),
          filtered.length === 0 ? h('div', { style: { ...styles.empty, marginTop: 10 } }, '没有匹配的字段。') : null,
            ),
        ),
      )
    }

    function DefsPage() {
      const [meta, setMeta] = useState(null)
      const [sources, setSources] = useState(null)
      const [query, setQuery] = useState('')
      const [results, setResults] = useState([])
      const [searching, setSearching] = useState(false)
      const [expanded, setExpanded] = useState({ Core: true })
      const [selected, setSelected] = useState(null)
      const [record, setRecord] = useState(null)
      const [error, setError] = useState(null)
      const [view, setView] = useState('defs')

      useEffect(() => {
        fetch(`${API}/meta`).then((r) => r.json()).then(setMeta).catch((e) => setError(String(e)))
        fetch(`${API}/index`)
          .then((r) => r.json())
          .then((payload) => setSources(payload.sources || []))
          .catch((e) => setError(String(e)))
      }, [])

      useEffect(() => {
        if (!selected) return undefined
        setRecord(null)
        let cancelled = false
        fetch(`${API}/def?name=${encodeURIComponent(selected.defName)}&type=${encodeURIComponent(selected.defType)}`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((payload) => {
            if (!cancelled) setRecord(payload.record)
          })
          .catch((e) => {
            if (!cancelled) setError(String(e))
          })
        return () => {
          cancelled = true
        }
      }, [selected])

      useEffect(() => {
        if (!query.trim()) {
          setResults([])
          return undefined
        }
        setSearching(true)
        const timer = setTimeout(() => {
          fetch(`${API}/search?q=${encodeURIComponent(query)}&limit=40`)
            .then((r) => r.json())
            .then((payload) => {
              setResults(payload.results || [])
              setSearching(false)
            })
            .catch((e) => {
              setError(String(e))
              setSearching(false)
            })
        }, 220)
        return () => clearTimeout(timer)
      }, [query])

      const toggle = useCallback((key) => {
        setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
      }, [])
      const collapseAll = useCallback(() => setExpanded({}), [])
      const clearSearch = useCallback(() => {
        setQuery('')
        setResults([])
      }, [])

      const openTreePath = useCallback((sourceName, groupKey) => {
        setExpanded((prev) => ({ ...prev, [sourceName]: true, [`${sourceName}::${groupKey}`]: true }))
      }, [])

      const pickFromTree = useCallback((item, sourceName) => {
        setSelected({ defName: item.defName, defType: item.defType, source: sourceName })
      }, [])

      const pickFromSearch = useCallback(
        (hit) => {
          const rec = hit.record
          setSelected({ defName: rec.defName || rec.Name, defType: rec.defType, source: rec.source })
          openTreePath(rec.source, hit.group)
        },
        [openTreePath],
      )

      const activeKey = selected ? `${selected.source}:${selected.defType}:${selected.defName}` : null

      return h(
        'div',
        { style: styles.page },
        h('style', null, CSS),
        h(
          'div',
          { style: styles.header },
          h('span', { style: styles.title }, 'RimWorld Defs'),
          h(StatusChip, { notice: meta && meta.notice }),
          h('span', { style: styles.meta }, meta ? `${meta.defCount} Defs · 数据 ${meta.gameVersion || '未知'}` : '加载中…'),
          h(
            'div',
            { style: styles.headerActions },
            view === 'settings'
              ? h(
                  'button',
                  { style: styles.iconBtn, onClick: () => setView('defs'), title: '返回', 'aria-label': '返回' },
                  h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none' }, h('path', { d: 'M15 5l-7 7 7 7', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' })),
                )
              : h(
                  'button',
                  { style: styles.iconBtn, onClick: () => setView('settings'), title: '设置', 'aria-label': '设置' },
                  h(
                    'svg',
                    { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none' },
                    h('circle', { cx: 12, cy: 12, r: 3.2, stroke: 'currentColor', strokeWidth: 1.6 }),
                    h('path', {
                      d: 'M12 3.6v2.2M12 18.2v2.2M4.9 7.5l1.9 1.1M17.2 15.4l1.9 1.1M4.9 16.5l1.9-1.1M17.2 8.6l1.9-1.1',
                      stroke: 'currentColor',
                      strokeWidth: 1.6,
                      strokeLinecap: 'round',
                    }),
                  ),
                ),
          ),
        ),
        meta && meta.notice && meta.notice.status === 'stale'
          ? h('div', { style: { ...styles.warn, margin: '10px 18px 0' } }, meta.notice.message)
          : null,
        error ? h('div', { style: { ...styles.empty, padding: 16 } }, `加载失败：${error}`) : null,
        view === 'settings'
          ? h(SettingsPanel, { onBack: () => setView('defs') })
          : h(
              'div',
              { style: styles.body },
              h(
                'div',
                { style: styles.left },
                h(
                  'div',
                  { style: styles.leftHeader },
                  h(
                    'button',
                    { style: styles.collapseBtn, onClick: collapseAll, title: '收起所有分类', 'aria-label': '收起所有分类' },
                    '⤒',
                  ),
                  h(
                    'div',
                    { style: styles.searchWrap },
                    h('input', {
                      style: styles.searchField,
                      placeholder: '搜索 defName / 中英文名',
                      value: query,
                      onChange: (event) => setQuery(event.target.value),
                      'aria-label': '搜索 Def',
                    }),
                    query.trim()
                      ? h(
                          'button',
                          { style: styles.clearBtn, onClick: clearSearch, title: '清除筛选', 'aria-label': '清除筛选' },
                          '×',
                        )
                      : null,
                  ),
                ),
                query.trim()
                  ? h(
                      'div',
                      { className: 'rw-scroll', style: styles.tree },
                      searching ? h('div', { style: styles.empty }, '搜索中…') : null,
                      !searching && results.length === 0 ? h('div', { style: styles.empty }, '没有匹配的 Def。') : null,
                      results.map((hit) => {
                        const rec = hit.record
                        const label = rec.labelZh || rec.label || rec.titleZh || rec.title || rec.defName || rec.Name
                        return h(
                          'div',
                          {
                            key: `${rec.defType}:${rec.defName}:${rec.source}`,
                            style: styles.searchItem,
                            className: 'rw-row',
                            onClick: () => pickFromSearch(hit),
                          },
                          h('div', null, label || '(无显示名)'),
                          h('div', { style: styles.searchSub }, `${rec.defType} · ${rec.source} · ${hit.groupLabel}`),
                        )
                      }),
                    )
                  : sources
                    ? h(Explorer, { sources, expanded, toggle, selectedKey: activeKey, onSelect: pickFromTree })
                    : h('div', { style: styles.empty }, '加载索引…'),
              ),
              h('div', { className: 'rw-scroll', style: styles.right }, h(Detail, { record })),
            ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'rimworld-defs', order: 20, label: 'RimWorld Defs' },
            PanelIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'rimworld-defs' }, DefsPage),
        )
      },
    }
  },
})
