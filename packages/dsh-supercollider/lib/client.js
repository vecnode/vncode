/**
 * dsh-supercollider — browser half: ONE small console, on purpose.
 *
 * SuperCollider already has a language, a prompt, a class library and an IDE.
 * The plugin's job is to teach and drive those, so this bundle does not
 * reimplement them: there is no scope, no node-tree canvas, no SynthDef browser,
 * no parameter rack, no editor, no mixer and no design system here. What there
 * is, is the one thing a chat window cannot show — the session's own text, as it
 * arrives — plus one input line and a Stop.
 *
 * The typing happens in the shipped editor (`dsh-editor`), which this package
 * claims `.scd` for, and the files on disk are the agent's surface through
 * `sc_project` / `sc_load`. Edit there, send, hear it here.
 *
 * It is a CLASSIC SCRIPT registered through `window.__ModuleLoader__.load`, with
 * no build step, requiring only the specifiers a client bundle is allowed:
 * `react` and `dsh-rightbar` (the tab registry). The style is injected once,
 * gated on `document`, from a `style[data-plugin-css]` tag the check reads back.
 */

window.__ModuleLoader__.load({
  id: 'dsh-supercollider',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    exports.PLUGIN_VERSION = '0.1.0-alpha.3'

    const TYPE_ID = 'dsh-supercollider'
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    const API_ROOT = '/api/dsh-supercollider'
    const STATE_ROUTE = API_ROOT + '/state'
    const CONSOLE_ROUTE = API_ROOT + '/console'
    const EVAL_ROUTE = API_ROOT + '/eval'

    /**
     * The element factory every render below calls with VARIADIC children -
     * `h(tag, props, child, child)`.
     *
     * It is `React.createElement` and NOT the automatic runtime's `jsx`, whose
     * third argument is a KEY: `jsx('span', { className: 'x' }, 'text')` builds a
     * `<span class="x">` with no text and no complaint. This bundle shipped bound
     * to `jsx` and the console drew an empty frame - measured, under the real
     * runtime: `<div class="dsu-console"></div>` and `<span class="dsu-barTitle">`,
     * every child silently dropped. `check-client-bundles.mjs` renders both seats
     * and would have caught it; the binding, not the call sites, is the bug.
     */
    const h = React.createElement

    const css = `
.dsu-console{display:flex;flex-direction:column;height:100%;min-height:0;font:12px/18px var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.dsu-bar{display:flex;align-items:center;gap:8px;padding:4px 8px;flex:none;border-bottom:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28))}
.dsu-barTitle{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8)}
.dsu-stat{color:var(--dsw-alias-label-tertiary,#8f8f8f);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsu-spacer{flex:1 1 auto}
.dsu-btn{border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);border-radius:5px;padding:1px 7px;cursor:pointer;font:inherit}
.dsu-btn:hover{color:var(--dsw-alias-label-primary,#e8e8e8)}
.dsu-btn:disabled{opacity:.5;cursor:default}
.dsu-out{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#c8c8c8)}
.dsu-outEmpty{color:var(--dsw-alias-label-tertiary,#8f8f8f)}
.dsu-in{display:flex;gap:6px;padding:6px 8px;flex:none;border-top:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28))}
.dsu-in input{flex:1 1 auto;min-width:0;background:transparent;border:.5px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:5px;color:inherit;font:inherit;padding:2px 6px}
.dsu-in input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f8cff)}
`

    const CSS_TAG = 'dsh-supercollider/console.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-supercollider'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /** One fetch against this plugin's own routes. */
    async function api(path, init) {
      const answer = await fetch(path, { credentials: 'same-origin', ...(init || {}) })
      const text = await answer.text()
      let body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch (err) {
        body = { ok: false, error: 'the route answered something that is not JSON' }
      }
      return { status: answer.status, ok: answer.ok, body }
    }

    /** A number the client can send as a cursor, whatever it was handed. */
    function cursorOf(value) {
      const number = Number(value)
      return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
    }

    /**
     * The console. One region of text, one input, one Stop.
     */
    function ScConsole() {
      const [output, setOutput] = React.useState('')
      const [cursor, setCursor] = React.useState(0)
      const [status, setStatus] = React.useState(null)
      const [line, setLine] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [live, setLive] = React.useState(false)
      const outRef = React.useRef(null)
      const cursorRef = React.useRef(0)

      // The long-poll loop. The pack has no SSE and no browser WebSocket, so a
      // request that hangs up to five seconds is how the session's output
      // arrives; `wait=5000` is the ceiling the host route clamps to.
      React.useEffect(() => {
        if (!live) return undefined
        let stopped = false
        const tick = async () => {
          while (!stopped) {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
              await new Promise((resolve) => setTimeout(resolve, 2000))
              continue
            }
            const answer = await api(CONSOLE_ROUTE + '?cursor=' + cursorRef.current + '&wait=5000')
            if (stopped) return
            if (!answer.ok || answer.body === null || answer.body.ok !== true) {
              setError(answer.body && answer.body.error ? String(answer.body.error) : 'the console route did not answer')
              setLive(false)
              return
            }
            const body = answer.body
            if (typeof body.text === 'string' && body.text !== '') {
              setOutput((previous) => (previous + body.text).slice(-120000))
            }
            const next = cursorOf(body.cursor)
            cursorRef.current = next
            setCursor(next)
          }
        }
        tick()
        return () => {
          stopped = true
        }
      }, [live])

      // The header snapshot. It changes rarely, so it is a slow poll rather than
      // a second long-poll.
      React.useEffect(() => {
        let stopped = false
        const read = async () => {
          const answer = await api(STATE_ROUTE)
          if (stopped) return
          if (answer.ok && answer.body && answer.body.ok === true) setStatus(answer.body)
        }
        read()
        const timer = setInterval(read, 5000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [])

      // Keep the newest line in view: a stream that scrolls away is not a stream.
      React.useEffect(() => {
        const node = outRef.current
        if (node === null) return
        node.scrollTop = node.scrollHeight
      }, [output])

      const send = async () => {
        const code = line
        if (code.trim() === '') return
        setLine('')
        setBusy(true)
        setError('')
        // The first send is also the "start the interpreter" action: nothing
        // spawns sclang until something is actually run.
        if (!live) setLive(true)
        const answer = await api(EVAL_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        })
        setBusy(false)
        if (!answer.ok || answer.body === null) {
          setError('the eval route did not answer')
          return
        }
        if (answer.body.ok !== true) {
          setError(String(answer.body.error || 'the interpreter refused that'))
        }
      }

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          send()
        }
      }

      const stop = async () => {
        setBusy(true)
        setError('')
        // A panic, not a state change: free everything, then report what the
        // server says afterwards.
        const answer = await api(EVAL_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: 's = s ?? Server.default; s.freeAll; "freeAll"' }),
        })
        setBusy(false)
        if (!answer.ok || answer.body === null || answer.body.ok !== true) {
          setError(answer.body && answer.body.error ? String(answer.body.error) : 'the stop command did not answer')
        }
      }

      const server = status && Array.isArray(status.servers) ? status.servers[0] : null
      const metrics = status && status.metrics ? status.metrics : null
      const session = status && status.session ? status.session : null
      const install = status && status.install ? status.install : null

      const title = !status ? 'SuperCollider' : install && !install.dir ? 'SuperCollider — not installed' : 'SuperCollider ' + (install.version || '')

      const stat = []
      if (metrics) {
        if (metrics.nominalSampleRate) stat.push(Math.round(metrics.nominalSampleRate) + ' Hz')
        if (typeof metrics.synthCount === 'number') stat.push(metrics.synthCount + ' synth' + (metrics.synthCount === 1 ? '' : 's'))
        if (typeof metrics.avgCpu === 'number') stat.push((metrics.avgCpu * 100).toFixed(1) + '% CPU')
      } else if (server && !server.reachable) {
        stat.push('server not answering')
      }
      if (session && session.interpreter === 'warm') stat.push('interpreter warm')
      if (session && session.boundPort) stat.push('port ' + session.boundPort)

      return h(
        'div',
        { className: 'dsu-console' },
        h(
          'div',
          { className: 'dsu-bar' },
          h('span', { className: 'dsu-barTitle' }, title),
          h('span', { className: 'dsu-spacer' }),
          stat.length > 0 ? h('span', { className: 'dsu-stat' }, stat.join(' · ')) : null,
          h(
            'button',
            {
              className: 'dsu-btn',
              type: 'button',
              disabled: busy,
              onClick: stop,
              title: 'Free every synth on the server (s.freeAll)',
            },
            'Stop',
          ),
        ),
        h(
          'div',
          { className: 'dsu-out', ref: outRef },
          output === ''
            ? h(
                'div',
                { className: 'dsu-outEmpty' },
                "The session's output appears here.\n" +
                  '\n' +
                  'The interpreter starts on the first send and stays warm between calls, so everything you define is still there next time.\n' +
                  '\n' +
                  'play a tone:      { SinOsc.ar(440, 0, 0.2) }.play\n' +
                  'a live pattern:   Ndef(\\drone, { LFTri.ar(55) * 0.1 }).play\n' +
                  'stop it all:      s.freeAll',
              )
            : output,
        ),
        error !== '' ? h('div', { className: 'dsu-stat', style: { padding: '0 8px 4px' } }, error) : null,
        h(
          'div',
          { className: 'dsu-in' },
          h('input', {
            value: line,
            spellCheck: false,
            placeholder: 'sclang — Enter to send',
            onChange: (event) => setLine(event.target.value),
            onKeyDown,
          }),
          h(
            'button',
            { className: 'dsu-btn', type: 'button', disabled: busy, onClick: send },
            busy ? '…' : 'Send',
          ),
        ),
      )
    }

    /** The tab's title bar cell: the type's name, like every other tab's. */
    function ScTitle() {
      return h('span', { className: 'dsu-barTitle' }, 'SuperCollider')
    }

    /**
     * The tab type for the pack's right bar.
     *
     * `.scd` files are claimed so they open in the SHIPPED editor rather than in
     * a viewer of ours: the bar's registry ranks a type in the `extension` band
     * above the preview's `fallback`, and a SuperCollider piece is code, so the
     * code editor is the right surface for it. Narrowing claimed to `canOpen`
     * is refused, so the extension list is the claim.
     *
     * The guide capsule's contract is the bar's, not this package's: the Start
     * page calls `entry.title()` and `entry.description?.()` while it builds the
     * capsule, so BOTH must be functions and the label is `title`, never `label`.
     * A string in either field throws inside the Start page's own render, and the
     * slot core abdicates the entry it crashed in - which is the whole Start body,
     * not the one capsule. `order` positions the capsule: 60 is behind PDFs (50).
     */
    function definition() {
      return {
        id: TYPE_ID,
        kind: TYPE_ID,
        patterns: ['.scd', '.sc'],
        priority: 'extension',
        canOpen: (address) => /\.sc[cd]$/i.test(String(address || '')),
        title: () => 'SuperCollider',
        guide: [
          {
            id: TYPE_ID + '/console',
            order: 60,
            title: () => 'SuperCollider console',
            description: () => 'A live sclang session: type a line, send it, read what it prints.',
          },
        ],
      }
    }

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(definition()), 'dsh-supercollider: tab type')
      } catch (err) {
        // A profile without the pack's right bar still gets the tools and the
        // skills; only the tab is missing, and saying so is the honest answer.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-supercollider] no right bar in this profile - the console tab was not registered')
        }
        return
      }
      ctx.effect(
        () => ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({ name: TAB_SLOT, key: TYPE_ID, inject: () => ({}) }, ScConsole)),
        'dsh-supercollider: console body',
      )
      ctx.effect(
        () => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({ name: TITLE_SLOT, key: TYPE_ID }, ScTitle)),
        'dsh-supercollider: console title',
      )
    }

    exports.name = 'dsh-supercollider'
    exports.inject = inject
    exports.apply = apply
    exports.__internals = { definition, cursorOf, api, ScConsole, TYPE_ID, STATE_ROUTE, CONSOLE_ROUTE, EVAL_ROUTE }

    return module.exports
  },
})
