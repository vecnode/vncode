/**
 * dsh-writing — the model-facing tools.
 *
 * WHY THESE EXIST. Every other content tab in this pack is drivable by the agent:
 * a diagram, a Canvas design, a PDF's index, a media job. The Writing tab was the
 * exception - a document could be created by a person and by the browser half's
 * own routes, but a model could not write one, so "put it in a document" ended in
 * a Markdown file the person then had to import by hand.
 *
 * These three tools close that gap through the SAME store the tab reads:
 *
 *   writing_list   the conversation's documents (and the shared library's)
 *   writing_read   one document, as Markdown or as the block model
 *   writing_write  create or replace one document from Markdown
 *
 * THEY ARE NOT A SECOND MODEL. `writing_write` reads Markdown with
 * `blocksFromMarkdown` and `writing_read` writes it back with `documentMarkdown` -
 * the two pure functions the tab's own Import/Export already use - so a document
 * the agent writes is the same document the person edits, saves and proofs. A
 * tool that carried its own idea of a paragraph would be a second answer to the
 * same question, which is the thing this pack refuses.
 *
 * WHAT THE MODEL CANNOT HOLD is stated rather than hidden: there is no table, no
 * image and no footnote block, so a Markdown table arrives as pipe-delimited
 * paragraphs. `writing_write` says so in its description, because the alternative
 * is an agent that believes it produced a table.
 *
 * Every tool takes its conversation from `exec.agent.session.id` - the address the
 * tab itself uses - so a write and the tab can never disagree about which
 * conversation they are in.
 */
import {
  MAX_BLOCKS,
  MAX_TITLE_CHARS,
  blocksFromMarkdown,
  documentMarkdown,
  documentStats,
  normalizeFont,
  normalizeFontSize,
} from './model.js'

/** The three tools, in the order the model should reach for them. */
export const TOOL_NAMES = ['writing_list', 'writing_read', 'writing_write']

/** One error's message, whatever was thrown. */
function message(err) {
  return err && err.message ? String(err.message) : String(err)
}

/**
 * A store failure as a sentence the model can act on.
 *
 * The store's own codes are already actionable (`LIMIT`, `BUDGET`, `CONFLICT`,
 * `TOO_LARGE`), so they are carried through as the tool's own failure text rather
 * than replaced by "the write failed".
 *
 * @param err - whatever the store threw.
 * @returns the message.
 */
function refusal(err) {
  const code = err && err.code ? String(err.code) : ''
  const text = message(err)
  return code.length > 0 && !text.startsWith(code) ? code + ': ' + text : text
}

/**
 * The store one tool call writes to.
 *
 * @param deps - `{ stores }`, the module-level store cache `apply()` owns (one
 *   conversation store and one shared library, so a tool write and a route read
 *   see the same documents).
 * @param scope - `'conversation'` or `'library'`.
 * @returns the store and the key to address it by.
 */
function target(deps, scope) {
  const both = deps.stores()
  return scope === 'library' ? { store: both.library, key: 'library' } : { store: both.conversation, key: null }
}

/**
 * The acting conversation of one tool run.
 * @param exec - the tool run context.
 * @returns the session id, or a refusal naming what is missing.
 */
function sessionOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  if (!session || typeof session.id !== 'string' || session.id.length === 0) {
    throw new Error('the writing tools require an owning agent session; there is no conversation to write into')
  }
  return session.id
}

/** The scope key one call addresses: the conversation id, or the library's one key. */
function scopeKeyOf(deps, exec, scope) {
  const { key } = target(deps, scope)
  return key === null ? sessionOf(exec) : key
}

/** One document as the model reads it in a list. */
function listLine(entry) {
  const bits = [
    entry.id,
    '"' + entry.title + '"',
    entry.kind === 'sheet' ? 'workbook' : 'page',
    entry.words + ' words',
    'rev ' + entry.revision,
  ]
  if (entry.origin && typeof entry.origin.path === 'string') bits.push('linked to ' + entry.origin.path)
  return bits.join(' | ')
}

/**
 * Build the tools one row owns.
 *
 * @param deps - `{ stores, log }`.
 * @returns the tool definitions, ready for `ctx.tools.register`.
 */
export function buildTools(deps) {
  return [
    {
      name: 'writing_list',
      description:
        'List the documents in this conversation\'s Writing tab (and, with scope "library", the documents published to every conversation). Answers each document\'s id, title, kind, word count and revision. Read this first: an id is what writing_read and writing_write address a document by, and a title may match more than one.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['conversation', 'library'],
            description: 'Which store to list. Defaults to this conversation.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            count: { type: 'integer' },
            documents: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  kind: { type: 'string' },
                  words: { type: 'integer' },
                  revision: { type: 'integer' },
                  // `origin` is a path or null, and the harness's enforced JSON
                  // Schema subset has no type arrays (`tools.register` refuses
                  // them by name), so a nullable scalar is spelled as `oneOf`.
                  origin: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
          required: ['text', 'count', 'documents'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const scope = args && args.scope === 'library' ? 'library' : 'conversation'
        const { store, key } = target(deps, scope)
        const listed = store.list(key === null ? sessionOf(exec) : key)
        const documents = listed.documents.map((entry) => ({
          id: entry.id,
          title: entry.title,
          kind: entry.kind,
          words: entry.words,
          revision: entry.revision,
          origin: entry.origin && typeof entry.origin.path === 'string' ? entry.origin.path : null,
        }))
        const text =
          documents.length === 0
            ? 'No documents in the ' + scope + ' store yet. writing_write creates the first one.'
            : documents.length +
              ' document(s) in the ' +
              scope +
              ' store:\n' +
              listed.documents.map((entry) => '  ' + listLine(entry)).join('\n')
        return { text, count: documents.length, documents }
      },
    },
    {
      name: 'writing_read',
      description:
        'Read one document from the Writing tab: the Markdown body (with the six inline marks the model carries) or, with format "blocks", the raw block model. Use it before rewriting a document you did not just write, so a person\'s edit is not replaced blind.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The document id, from writing_list.',
          },
          scope: {
            type: 'string',
            enum: ['conversation', 'library'],
            description: 'Which store to read from. Defaults to this conversation.',
          },
          format: {
            type: 'string',
            enum: ['markdown', 'blocks'],
            description: 'markdown (default) is the body as text; blocks is the block model as JSON.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            id: { type: 'string' },
            title: { type: 'string' },
            kind: { type: 'string' },
            words: { type: 'integer' },
            blocks: { type: 'integer' },
            revision: { type: 'integer' },
            markdown: { type: 'string' },
            model: { type: 'string' },
          },
          required: ['text', 'id', 'title', 'kind', 'words', 'blocks', 'revision', 'markdown', 'model'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const scope = args && args.scope === 'library' ? 'library' : 'conversation'
        const { store, key } = target(deps, scope)
        const scopeKey = key === null ? sessionOf(exec) : key
        const id = typeof args.id === 'string' ? args.id : ''
        const entry = store.get(scopeKey, id)
        if (!entry) {
          const known = store.ids(scopeKey)
          throw new Error(
            'no document "' +
              id +
              '" in the ' +
              scope +
              ' store' +
              (known.length > 0 ? '; it holds: ' + known.join(', ') : ' (it is empty)'),
          )
        }
        const stats = documentStats(entry)
        const markdown = documentMarkdown(entry)
        // Two shapes of the same document: `markdown` is ALWAYS the body, and
        // `model` carries the block model only when it was asked for. Naming the
        // JSON "markdown" would be the kind of lie a caller discovers at 2am.
        const wantsModel = Boolean(args && args.format === 'blocks')
        const model = wantsModel ? JSON.stringify({ title: entry.title, page: entry.page, blocks: entry.blocks }, null, 2) : ''
        const text =
          'Document "' +
          entry.title +
          '" (' +
          entry.id +
          ', ' +
          stats.words +
          ' words, ' +
          stats.blocks +
          ' blocks, revision ' +
          entry.revision +
          (entry.origin && typeof entry.origin.path === 'string' ? ', linked to ' + entry.origin.path : '') +
          ')\n\n' +
          (wantsModel ? model : markdown)
        return {
          text,
          id: entry.id,
          title: entry.title,
          kind: entry.kind === 'sheet' ? 'sheet' : 'page',
          words: stats.words,
          blocks: stats.blocks,
          revision: entry.revision,
          markdown,
          model,
        }
      },
    },
    {
      name: 'writing_write',
      description:
        'Create or replace one document in the Writing tab from Markdown, and answer the id, revision and word count. Headings (# 1-6), bullet and numbered lists, block quotes, fenced code and the inline marks **b**, *i*, <u>u</u>, ~~s~~ and `code` are kept; a table, an image or a footnote is NOT representable and arrives as plain paragraphs (say so rather than promising a table). Omit id to create a new document; name an id to replace that document\'s body, keeping its id and its revision history. A model-written document is marked as written by the model.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The document\'s title (max ' + MAX_TITLE_CHARS + ' characters). Required when creating; omit to keep the existing title.',
          },
          markdown: {
            type: 'string',
            description: 'The document BODY as Markdown. The title is a separate field, not a heading in here.',
          },
          id: {
            type: 'string',
            description: 'An existing document id to replace. Omit to create a new document.',
          },
          scope: {
            type: 'string',
            enum: ['conversation', 'library'],
            description: 'conversation (default) keeps it in this chat; library publishes it to every conversation.',
          },
          note: {
            type: 'string',
            description: 'One line for the revision history, e.g. "added references".',
          },
          expectedRevision: {
            type: 'integer',
            description: 'Optional. When given, the write is REFUSED if the document has moved past this revision - the guard against replacing a person\'s edit.',
          },
          font: {
            type: 'string',
            description: 'Optional document font family (a name from the machine\'s own fonts).',
          },
          fontSize: {
            type: 'number',
            description: 'Optional document size in points.',
          },
          page: {
            type: 'object',
            properties: {
              size: { type: 'string', enum: ['a4', 'letter'] },
              orientation: { type: 'string', enum: ['portrait', 'landscape'] },
            },
            additionalProperties: false,
            description: 'Optional page setup.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            id: { type: 'string' },
            title: { type: 'string' },
            scope: { type: 'string' },
            revision: { type: 'integer' },
            words: { type: 'integer' },
            blocks: { type: 'integer' },
            created: { type: 'boolean' },
          },
          required: ['text', 'id', 'title', 'scope', 'revision', 'words', 'blocks', 'created'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const scope = args && args.scope === 'library' ? 'library' : 'conversation'
        const { store, key } = target(deps, scope)
        const scopeKey = key === null ? sessionOf(exec) : key
        const id = typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined
        const existing = id ? store.get(scopeKey, id) : undefined
        if (id && !existing) {
          const known = store.ids(scopeKey)
          throw new Error(
            'no document "' + id + '" to replace in the ' + scope + ' store' + (known.length > 0 ? '; it holds: ' + known.join(', ') : ' (it is empty)'),
          )
        }
        if (existing && existing.kind === 'sheet') {
          throw new Error(
            '"' + id + '" is a WORKBOOK. These tools write documents; a workbook is edited on the workbook surface, and replacing it from Markdown would throw its sheets away.',
          )
        }
        const raw = typeof args.markdown === 'string' ? args.markdown : ''
        const title =
          typeof args.title === 'string' && args.title.trim().length > 0
            ? args.title.trim().slice(0, MAX_TITLE_CHARS)
            : existing
              ? existing.title
              : 'Untitled'
        const blocks = blocksFromMarkdown(raw)
        try {
          const entry = store.write(scopeKey, {
            id,
            title,
            blocks,
            page: args.page ?? (existing ? existing.page : undefined),
            font: args.font !== undefined ? normalizeFont(args.font) : undefined,
            fontSize: args.fontSize !== undefined ? normalizeFontSize(args.fontSize) : undefined,
            by: 'model',
            note: typeof args.note === 'string' && args.note.length > 0 ? args.note : existing ? 'written by the agent' : 'created by the agent',
            expectedRevision: args.expectedRevision,
          })
          const stats = documentStats(entry)
          const text =
            (existing ? 'Replaced' : 'Created') +
            ' document "' +
            entry.title +
            '" (' +
            entry.id +
            ') in the ' +
            scope +
            ' store: ' +
            stats.words +
            ' words, ' +
            stats.blocks +
            ' blocks, revision ' +
            entry.revision +
            (stats.blocks >= MAX_BLOCKS ? ' - the ' + MAX_BLOCKS + '-block limit was reached' : '') +
            '. It is in the Writing tab now.'
          return {
            text,
            id: entry.id,
            title: entry.title,
            scope,
            revision: entry.revision,
            words: stats.words,
            blocks: stats.blocks,
            created: !existing,
          }
        } catch (err) {
          throw new Error(refusal(err))
        }
      },
    },
  ]
}
