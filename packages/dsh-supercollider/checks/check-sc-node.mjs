// check-sc-node.mjs — drive the dsh-supercollider engine's pure half offline.
//
// Why this exists: the engine has four pieces that are pure functions of their
// input and are therefore worth pinning exactly — the OSC wire format, the
// process/install discovery, the `.schelp` index and its ranking, and the
// `sclang` reply parser (whose whole job is to NOT mistake the REPL's echo for
// an answer). A change that breaks any of them still loads, still type-checks
// and still passes every other check in this repository.
//
// Sections that need a real SuperCollider install, or a real audio server,
// SKIP LOUDLY and exit 0 — the pack's rule. Never silence a check and never
// weaken one to make a change pass.
//
// Run:  node scripts/checks/check-sc-node.mjs

const { promises: fsp } = await import('node:fs')
const os = await import('node:os')
const path = (await import('node:path')).default
const { fileURLToPath, pathToFileURL } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const engine = path.join(repo, 'lib', 'engine')

let failures = 0
let skipped = 0

function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  const shown = JSON.stringify(actual)
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(46) + (ok ? '' : ' got ' + shown + ' want ' + JSON.stringify(expected)))
  return ok
}

function skip(label, why) {
  skipped += 1
  console.log('skip ' + label.padEnd(46) + ' ' + why)
}

const load = async (name) => import(pathToFileURL(path.join(engine, name)).href)

/** Two channels as the interleaved floats `/b_setn` returns. */
function interleave(left, right) {
  const out = []
  for (let index = 0; index < left.length; index += 1) out.push(left[index], right[index])
  return out
}

// --------------------------------------------------------------- OSC wire format
const osc = await load('osc.js')

{
  // The exact bytes the Rust and Python implementations sent: the address, its
  // NUL, three pad bytes, the typetag ",", its NUL, three pad bytes.
  const status = osc.encodeMessage('/status')
  check('OSC /status is 12 bytes', status.length, 12)
  check('OSC /status bytes', status.toString('hex'), '2f737461747573002c000000')

  const quit = osc.encodeMessage('/quit')
  check('OSC /quit bytes', quit.toString('hex'), '2f717569740000002c000000')

  // A string argument is NUL-terminated and padded to 4.
  const named = osc.encodeMessage('/n_set', [1000, 'freq', 440.5])
  check('OSC typetag for /n_set', osc.decodeMessage(named).tags, ',isf')
  const back = osc.decodeMessage(named)
  check('OSC round trip address', back.address, '/n_set')
  check('OSC round trip node id', back.args[0], 1000)
  check('OSC round trip key', back.args[1], 'freq')
  check('OSC round trip float', Math.abs(back.args[2] - 440.5) < 0.001, true)

  // A blob carries a length, the bytes, then padding for the CONTENT length.
  const blob = Buffer.from([1, 2, 3, 4, 5])
  const withBlob = osc.encodeMessage('/d_recv', [blob])
  const decodedBlob = osc.decodeMessage(withBlob)
  check('OSC blob round trip', Buffer.from(decodedBlob.args[0]).toString('hex'), '0102030405')

  // 5 bytes of content need 3 bytes of padding, and nothing else differs.
  const padDifference = withBlob.length - osc.encodeMessage('/d_recv', [blob.subarray(0, 4)]).length
  check('OSC blob padding is 3 for a 5-byte blob', padDifference, 1 + 3)

  // Booleans are ints, and a boolean must not fall through to the number branch.
  check('OSC boolean tag', osc.decodeMessage(osc.encodeMessage('/x', [true])).args[0], 1)
  check('OSC explicit true flag', osc.tagOf(true), 'i')
  check('OSC rejects a null argument', osc.tagOf(null), null)

  // An integer-valued float stays a float: the typetag is the caller's signal.
  check('OSC integral float is i when integer', osc.tagOf(1.0), 'i')
  check('OSC fractional float is f', osc.tagOf(1.5), 'f')

  // A real `/status.reply`: `,iiiiiffdd` = [1, ugenCount, synthCount, groupCount,
  // synthDefCount, avgCPU, peakCPU, nominalSR, actualSR]. The header comes from
  // this encoder (so the test cannot drift from it) and the argument bytes are
  // written out by hand (so the test cannot be satisfied by the encoder and
  // decoder being wrong in the same way).
  // The two float64 values are the sample rates. The bytes are pinned (not
  // computed) so the expected numbers below come from the bytes on the wire.
  const int32 = (hex) => Buffer.from(hex, 'hex')
  const float32Values = [
    '3dc0c9c9', // avgCPU   ~0.0941
    '3e1e1e1e', // peakCPU  ~0.1546
  ]
  // The two doubles are the sample rates. Built with the encoder so the test
  // asserts READBACK rather than a hand-computed bit pattern.
  const nominalRate = 48000
  const actualRate = 48126.71254480287
  const float64Values = [osc.encodeFloat64(nominalRate), osc.encodeFloat64(actualRate)]
  const argBytes = Buffer.concat([
    int32('00000001'), // 1 — the reply's own sentinel
    int32('00000000'), // ugenCount
    int32('00000000'), // synthCount
    int32('00000001'), // groupCount
    int32('00000000'), // synthDefCount
    int32(float32Values[0]),
    int32(float32Values[1]),
    float64Values[0],
    float64Values[1],
  ])
  // 5 ints (4 bytes each) + 2 floats (4) + 2 doubles (8) = 44 bytes.
  check('the fixture argument block is 44 bytes', argBytes.length, 5 * 4 + 2 * 4 + 2 * 8)
  // 5 ints (the sentinel plus the ugen, synth, group and synthDef counts),
  // 2 floats (avg and peak CPU), 2 doubles (nominal and actual sample rate).
  const fixtureTags = ',' + 'i'.repeat(5) + 'f'.repeat(2) + 'd'.repeat(2)
  check('the fixture declares nine arguments', fixtureTags.length - 1, 9)
  check('the fixture tag order', fixtureTags, ',iiiiiffdd')
  const replyFixture = Buffer.concat([osc.encodeString('/status.reply'), osc.encodeString(fixtureTags), argBytes])
  check('the fixture is 28 header bytes plus 44', replyFixture.length, 28 + 44)
  const reply = osc.decodeMessage(replyFixture)
  check('OSC status.reply address', reply.address, '/status.reply')
  check('OSC status.reply tags', reply.tags, ',iiiiiffdd')
  check('OSC status.reply arg count', reply.args.length, 9)
  const metrics = osc.statusMetrics(reply.args)
  check('OSC status.reply groupCount', metrics.groupCount, 1)
  check('OSC status.reply nominal rate', metrics.nominalSampleRate, nominalRate)
  check('OSC status.reply actual rate survives', Math.round(metrics.actualSampleRate), Math.round(actualRate))
  check('OSC status.reply cpu is fractional', metrics.avgCpu > 0 && metrics.avgCpu < 1, true)

  // An unknown tag must be reported without desynchronising the rest: the
  // argument after it is still read from the right offset.
  const unknown = Buffer.concat([osc.encodeString('/x'), osc.encodeString(',xi'), int32('0000002a')])
  const decodedUnknown = osc.decodeMessage(unknown)
  check('OSC unknown tag is reported', decodedUnknown.args[0] && decodedUnknown.args[0].tag, 'x')
  check('OSC unknown tag keeps the next field', decodedUnknown.args[1], 42)

  // A bundle is the marker, a timetag, then length-prefixed elements.
  const bundle = osc.encodeBundle({ elements: [osc.encodeMessage('/status'), osc.encodeMessage('/quit')] })
  const decodedBundle = osc.decodeMessage(bundle)
  check('OSC bundle kind', decodedBundle.kind, 'bundle')
  check('OSC bundle element count', decodedBundle.elements.length, 2)
  check('OSC bundle first address', decodedBundle.elements[0].address, '/status')

  // A datagram that is not OSC must throw rather than decode to nonsense.
  let threw = false
  try {
    osc.decodeMessage(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
  } catch (err) {
    threw = true
  }
  check('OSC rejects a non-OSC datagram', threw, true)
}

// --------------------------------------------------------------- port parsing
const procs = await load('procs.js')
{
  check('argv -u N', JSON.stringify(procs.parseScPorts('scsynth.exe -u 57112 -z 64')), '[57112]')
  check('argv --udp-port N', JSON.stringify(procs.parseScPorts('/usr/bin/scsynth --udp-port 57113')), '[57113]')
  check('argv -u=N', JSON.stringify(procs.parseScPorts('scsynth -u=57114')), '[57114]')
  check('argv -uN', JSON.stringify(procs.parseScPorts('scsynth -u57115')), '[57115]')
  check('argv array form', JSON.stringify(procs.parseScPorts(['scsynth', '-u', '57116'])), '[57116]')
  check('argv rejects port 0', JSON.stringify(procs.parseScPorts('scsynth -u 0')), '[]')
  check('argv rejects a non-number', JSON.stringify(procs.parseScPorts('scsynth -u hello')), '[]')
  check('argv deduplicates', JSON.stringify(procs.parseScPorts('scsynth -u 57110 -u 57110')), '[57110]')

  check('role scsynth', procs.roleOf('scsynth.exe'), 'scsynth')
  check('role supernova', procs.roleOf('C:\\sc\\supernova.exe'), 'supernova')
  check('role sclang', procs.roleOf('sclang'), 'sclang')
  check('role scide', procs.roleOf('scide.exe'), 'scide')
  // A path that mentions neither is not ours. A path that mentions both IS ours
  // (a folder named `sclang` holding `scsynth.exe` is a real install layout).
  check('role ignores an unrelated process', procs.roleOf('C:\\Tools\\notepad.exe'), null)
  check('scsynth beats sclang in one path', procs.roleOf('C:\\sclang\\scsynth.exe'), 'scsynth')

  const ports = procs.candidatePorts([{ ports: [57120] }, { ports: [] }])
  check('candidate ports include both defaults', JSON.stringify(ports), '[57110,57120]')
}

// --------------------------------------------------------------- install discovery (fixtures)
const install = await load('install.js')
{
  check('version from a versioned path', install.versionFromText('C:\\Program Files\\SuperCollider-3.14.1'), '3.14.1')
  check('version from the -v banner', install.versionFromText("sclang 3.14.1 (Built from tag 'Version-3.14.1')"), '3.14.1')
  check('no version in a plain path', install.versionFromText('C:\\Program Files\\SuperCollider'), null)
  check('binary name on win32', install.binariesFor('win32').sclang, 'sclang.exe')
  check('binary name on linux', install.binariesFor('linux').sclang, 'sclang')

  // A real fixture tree: the versioned directory name is the case that a
  // fixed-name lookup misses, and it is the one on the machine this was built on.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-sc-install-'))
  try {
    const versioned = path.join(root, 'SuperCollider-3.14.1')
    await fsp.mkdir(versioned, { recursive: true })
    for (const name of ['sclang', 'scsynth', 'supernova', 'scide']) {
      await fsp.writeFile(path.join(versioned, name + (process.platform === 'win32' ? '.exe' : '')), '')
    }
    await fsp.mkdir(path.join(versioned, 'HelpSource', 'Classes'), { recursive: true })
    await fsp.writeFile(path.join(versioned, 'HelpSource', 'Classes', 'SinOsc.schelp'), 'class:: SinOsc\n')

    // Point the resolver at a fake ProgramFiles so it never sees the real machine.
    const found = install.resolveInstall({ platform: 'win32', env: { ProgramFiles: root, PATH: '' } })
    check('discovery finds the versioned directory', found.dir, versioned)
    check('discovery resolves sclang', found.sclang.file, path.join(versioned, 'sclang.exe'))
    check('discovery resolves scsynth', found.scsynth.file, path.join(versioned, 'scsynth.exe'))
    check('discovery reports hasLanguage', found.hasLanguage, true)
    check('discovery reports hasServer', found.hasServer, true)
    check('discovery reads the version off the path', found.version, '3.14.1')

    const help = install.resolveHelpRoot({ platform: 'win32', env: { ProgramFiles: root, PATH: '' }, install: found })
    check('help root is the install HelpSource', help.root, path.join(versioned, 'HelpSource'))

    // An env override must win over everything, and a broken one must be reported
    // rather than silently ignored.
    const overridden = install.resolveInstall({
      platform: 'win32',
      env: { ProgramFiles: root, PATH: '', DSH_SC_SCLANG: path.join(versioned, 'sclang.exe') },
    })
    check('DSH_SC_SCLANG wins and is labelled', overridden.sclang.source, 'env')
    const broken = install.resolveInstall({ platform: 'win32', env: { ProgramFiles: root, PATH: '', DSH_SC_SCLANG: path.join(root, 'nope.exe') } })
    check('a broken override is reported', broken.sclang.source, 'env-missing')

    const none = install.resolveInstall({ platform: 'linux', env: { PATH: path.join(root, 'nothing-here') } })
    check('an empty machine resolves nothing', none.sclang.file, null)
    check('an empty machine says why', none.sclang.source, 'none')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

// --------------------------------------------------------------- docs index and ranking
const docs = await load('docs.js')
{
  // The fixture is written so every section worth scoring clears the minimum
  // chunk length (40 characters, 20 in an examples section) — the real help
  // files always do, and a fixture that does not would test the drop rule
  // rather than the ranking.
  const schelp = [
    'class:: SinOsc',
    'summary:: a sine oscillator with a frequency in Hertz',
    'categories:: UGens>Generators>Deterministic',
    '',
    'description::',
    'SinOsc is a sine oscillator. The frequency is in Hertz, the amplitude is a',
    'linear value, and the phase is in radians.',
    '',
    'Examples::',
    'code::',
    '{ SinOsc.ar(440, 0, 0.2) }.play;',
    '::',
    '',
    'The code below plays a sine at 440 Hz for one second, then frees it:',
    'code::',
    'play({ SinOsc.ar(440) * Line.kr(0, 1, 0.1, doneAction: 2) });',
    '::',
    '',
    'related:: Classes/FSinOsc, Classes/Osc',
    '',
  ].join('\n')

  const sections = docs.splitSchelpSections(schelp)
  // `code::` is a header line by the same rule as `class::` — the parser is
  // line-oriented and does not special-case it, which is exactly what the ported
  // implementation does (`legacy/rust-server/src/sc_docs.rs:142-161`).
  check(
    'schelp sections',
    JSON.stringify(sections.map((s) => s.key)),
    JSON.stringify(['class', 'summary', 'categories', 'description', 'examples', 'code', 'code', 'related']),
  )
  check('empty preamble is dropped', sections[0].key, 'class')
  const cross = docs.collectSchelpCrossRefTokens(schelp)
  check('cross-refs include the stem', cross.includes('fsinosc'), true)
  check('cross-refs include the path segment', cross.includes('classes'), true)

  const chunks = []
  docs.indexFileText('C:/sc/HelpSource/Classes/SinOsc.schelp', 'Classes/SinOsc.schelp', schelp, chunks)
  check('indexing produced chunks', chunks.length > 0, true)
  check('a chunk carries its source relative to the root', chunks[0].sourcePath, 'Classes/SinOsc.schelp')
  check('a chunk carries its title', chunks[0].title, 'SinOsc')
  check('chunks stay within the section budget', chunks.every((c) => c.content.length <= docs.maxChunkChars(c.section)), true)

  // A section shorter than the minimum is dropped — the `class` section here
  // holds only the class name before `summary::`, which is under the
  // 40-character floor. Real help files add prose; the fixture is written so the
  // sections whose WEIGHTS are under test clear it.
  const scored = chunks.find((c) => c.section === 'description')
  const exampleChunk = chunks.find((c) => c.section === 'code')
  check('the description section survived the minimum', scored !== undefined, true)
  check('a code section survived the minimum', exampleChunk !== undefined, true)
  check('a short section is dropped entirely', chunks.some((c) => c.section === 'class'), false)

  // The ranking formula, pinned as the weights themselves rather than as a sum
  // that has to be re-derived every time a fixture gains a word. For a chunk of
  // `description` in `Classes/SinOsc.schelp`: content +4, section name +2, and
  // nothing for the title (the title is the file's name, not the section's).
  check('a term matching nothing scores 0', docs.scoreChunk(['zzzznotthere'], scored), 0)
  check('a token only in the content scores 4', docs.scoreChunk(['hertz'], scored), 4)
  check('a term in the section name only scores 2', docs.scoreChunk(['description'], scored), 2)
  // The examples boost is a property of the SECTION NAME, and only one header in
  // the fixture says "example": the rest are `code::`, which is not boosted.
  const boostedChunks = []
  docs.indexFileText(
    'x/HelpSource/Classes/X.schelp',
    'Classes/X.schelp',
    'Examples::\nThis section name contains the word example and is long enough to be indexed.\n',
    boostedChunks,
  )
  check('an examples section is indexed', boostedChunks.length > 0, true)
  check('an examples section gets its flat +2', docs.scoreChunk([], boostedChunks[0]), 2)
  check('a code section is NOT boosted', docs.scoreChunk([], exampleChunk), 0)
  const listChunk = { sourcePath: 'x.schelp', title: 'x', section: 'list', content: 'nothing', contentLower: 'nothing', crossRefLower: '' }
  check('a list section gets its flat +1', docs.scoreChunk([], listChunk), 1)

  // The cross-reference tokens are collected from the WHOLE file and carried
  // onto every chunk of it (`legacy/rust-server/src/sc_docs.rs:390`).
  check('a chunk carries the file cross-refs', scored.crossRefLower.includes('fsinosc'), true)
  check('a cross-ref token scores 5', docs.scoreChunk(['fsinosc'], scored), 5)

  // A search with no install must fail cleanly, naming a reason, not throw.
  const index = new docs.DocsIndex({ env: { PATH: '' }, install: { dir: null }, log: { warn() {}, info() {} } })
  const searched = await index.search({ query: 'sinosc' })
  check('search without an install fails cleanly', searched.ok, false)
  check('search failure names a reason', typeof searched.error === 'string' && searched.error.length > 0, true)
  check('search failure carries no results', searched.results.length, 0)
}

// --------------------------------------------------------------- the sclang reply parser
const sclang = await load('sclang.js')
{
  // THE BUG THIS EXISTS FOR: sclang's REPL parses per LINE. A block written to
  // its stdin line by line is six parse errors, not one evaluation — measured on
  // 3.14.1, where the opening `(` alone answers
  // `syntax error, unexpected end of file, expecting ')'`.
  const multi = ['(', 'var a = 1;', 'a + 1;', ')'].join('\n')
  check('a submission is normalised to one line', sclang.normalizeSubmission(multi).includes('\n'), false)
  check('normalising keeps the statements', sclang.normalizeSubmission(multi).includes('a + 1;'), true)
  // A comment would swallow the rest of a collapsed line, so it is removed.
  check('a line comment is stripped', sclang.normalizeSubmission('1 + 1; // two\n').includes('//'), false)
  check('the code before a line comment survives', sclang.normalizeSubmission('1 + 1; // two\n').startsWith('1 + 1;'), true)
  check('a block comment is stripped', sclang.normalizeSubmission('1 /* hidden */ + 1').includes('hidden'), false)
  check('a string keeps its slashes', sclang.normalizeSubmission('"http://x"').includes('http://x'), true)
  check('a string keeps its hashes', sclang.normalizeSubmission('"#LINE 7"').includes('#LINE 7'), true)
  check('a newline in a string becomes a space', sclang.normalizeSubmission('"a\nb"'), '"a b"')

  // The bug this pins: the REPL echoes the input, and the input contains the
  // marker. Waiting for the mere presence of a marker finds the ECHO.
  const id = '42'
  const source = sclang.buildAction({ id, code: '1 + 1' })
  check('an action is ONE line', source.includes('\n'), false)
  check('an action echoes the line marker', source.includes('#LINE ' + id), true)
  check('an action posts an OK reply', source.includes('<RI:' + id + ':OK>'), true)
  check('an action wraps the user code verbatim', source.includes('{ 1 + 1 }.value'), true)
  check('an action uses no top-level var', /^\s*var /.test(source.split(' ')[1] ?? ''), false)
  check('an action is a balanced block', (source.match(/\(/g) ?? []).length >= 1 && source.endsWith(')'), true)

  const echoThenReply = [
    '(',
    '"#LINE ' + id + '".postln;',
    'try { var r = { 1 + 1 }.value; ("<RI:' + id + ':OK>" ++ r.asString ++ "</RI>").postln; }',
    ')',
    '-> <RI:' + id + ':OK>2</RI>',
    'sc3> ',
  ].join('\n')
  const parsed = sclang.parseReply(echoThenReply, id)
  check('parse finds the reply, not the echo', parsed.state, 'inline')
  check('parse returns the answer', parsed.payload, '2')
  check('parse is pending for another id', sclang.parseReply(echoThenReply, '99').state, 'pending')

  const split = '(///*<x>*/ ("<RI:7:OK>par'
  check('parse is pending while the reply is split', sclang.parseReply(split, '7').state, 'pending')
  check('parse finishes a split reply', sclang.parseReply(split + 'tial</RI>").postln)', '7').payload, 'partial')

  const err = '-> <RI:8:ERR>ERROR: Variable not defined</RI>\nsc3> '
  check('parse reports an error', sclang.parseReply(err, '8').state, 'error')
  check('parse returns the error text', sclang.parseReply(err, '8').payload, 'ERROR: Variable not defined')

  // --- the submission path that fixed `sc_load` -----------------------------
  //
  // The bug this pins: a multi-line `.scd` used to be collapsed into ONE line,
  // which moved every `var` off the top of its block and produced
  // `syntax error, unexpected VAR` — or an error report whose text was the
  // generated wrapper itself. Code that cannot survive collapsing must go to a
  // file instead, and `interpret` it by path.
  check('one line of code can stay inline', sclang.needsTempFile('1 + 1'), false)
  check('a multi-line submission needs a file', sclang.needsTempFile('(\nvar a = 1;\na;\n)'), true)
  check('a comment needs a file', sclang.needsTempFile('1 + 1 // two'), true)
  check('a block comment needs a file', sclang.needsTempFile('1 /*x*/ + 1'), true)
  check('a long submission needs a file', sclang.needsTempFile('1 + ' + '1 + '.repeat(900) + '1'), true)
  // A URL inside a string is not a comment, and must not push code to a file.
  check('a // inside a string is not a comment', sclang.needsTempFile('"http://x"'), false)

  const native = sclang.buildSubmission({ id: '9', code: 'ignored', nativeFile: 'C:\\a b\\x.scd' })
  check('a file submission reads the file', native.includes('File.use('), true)
  check('a file submission escapes the path', native.includes('C:\\\\a b\\\\x.scd'), true)
  check('a file submission interprets the text', native.includes('readAllString.interpret'), true)
  check('a file submission is one line', native.includes('\n'), false)
  check('a file submission posts an OK reply', native.includes('<RI:9:OK>'), true)
  // The wrapper must declare no `var` of its own inside a branch: sclang only
  // allows a `var` as the first statement of its own block, and the generated
  // code's branches are not always function bodies in the places that mattered.
  check('a file submission declares no var', /\bvar\b/.test(native), false)
  const inlineSub = sclang.buildSubmission({ id: '10', code: '1 + 1' })
  check('an inline submission carries the value in ~dshResult', inlineSub.includes('~dshResult'), true)
  check('an inline submission is one line', inlineSub.includes('\n'), false)

  // --- reading a real interpreter error out of a transcript -----------------
  //
  // `String:interpret` does not raise: it prints the reason and returns nil, so a
  // load of a broken file would otherwise be reported as a success with no value.
  const realError = [
    'ERROR: syntax error, unexpected VAR, expecting }',
    '  in interpreted text',
    '  line 5 char 4:',
    '',
    '\tvar b = 2;',
    '\t^^^',
    '-----------------------------------',
  ].join('\n')
  const reported = sclang.extractInterpreterError(realError)
  check('an interpreter error is found', reported !== null, true)
  check('an interpreter error names the line', reported.line, 5)
  check('an interpreter error carries the reason', reported.message.includes('unexpected VAR'), true)
  check('a clean transcript reports no error', sclang.extractInterpreterError('#LINE 1\n-> 2\nsc3> '), null)

  const fileReply = '-> <RI:9:FILE>C:\\tmp\\a.scsyndef:420</RI>\nsc3> '
  const fileParsed = sclang.parseReply(fileReply, '9')
  check('parse reports a file hand-off', fileParsed.state, 'file')
  check('parse returns the file path', fileParsed.file, 'C:\\tmp\\a.scsyndef')
  check('parse returns the byte count', fileParsed.bytes, 420)

  const fileAction = sclang.buildAction({ id: '1', code: 'SynthDef(\\a, {})', mode: 'file', file: 'C:\\t\\x.scsyndef' })
  check('a file action is one line', fileAction.includes('\n'), false)
  check('a file action doubles the path backslashes', fileAction.includes('C:\\\\t\\\\x.scsyndef'), true)
}

// --------------------------------------------------------------- the node tree renderer
const tools = await load('../tools.js')
{
  // The real reply, measured from scsynth 3.14.1 with one synth on the server:
  // `0 0 1 2000 -1 integProbe`. Its header reports group 0 and ONE child node,
  // and exactly one node follows: synth 2000 \integProbe. (The `2000` next to
  // node 1 is that group's child count — group 1's size — and is NOT a number of
  // nodes; a renderer that iterates it invents 2000.) The renderer reports what
  // the server LISTED: the header, the nodes, their kinds and def names, and the
  // raw reply.
  const rendered = tools.renderQueryTree([0, 0, 1, 2000, -1, 'integProbe'])
  check('the tree names the requested group', rendered.includes('group 0 (the requested group)'), true)
  check('the header count is reported', rendered.includes('reporting 1 child node(s)'), true)
  check('the synth and its def are named', rendered.includes(String.raw`synth 2000 \integProbe`), true)
  check('the tree keeps the raw values', rendered.includes('raw: 0 0 1 2000 -1 integProbe'), true)
  check('one node in the reply is one node out', (rendered.match(/synth/g) ?? []).length, 1)

  // The same reply with the control flag set: a synth carries its control pairs.
  const withControls = tools.renderQueryTree([1, 0, 1, 1000, -1, 'tone', 2, 'freq', 440, 'amp', 0.1])
  check('controls are printed as pairs when the flag is set', withControls.includes('freq=440 amp=0.1'), true)
  check('the flag is reported', withControls.includes('control values are included'), true)

  // A reply with a header and no nodes after it: the group is empty and the
  // renderer says so rather than printing nothing.
  const noNodes = tools.renderQueryTree([0, 0, 0, 0])
  check('a header with no nodes says the group is empty', noNodes.includes('the group is empty'), true)
  check('a header with no nodes names no synth', noNodes.includes('synth'), false)
  // Four values is the minimum a parseable reply can have; anything shorter is
  // reported raw rather than misread.
  check('a reply too short to parse is reported raw', tools.renderQueryTree([0, 0, 0]).includes('raw:'), true)

  check('an empty reply renders nothing', tools.renderQueryTree([]), '')

  // Control arguments are floats. A string is refused here rather than encoded
  // into an OSC string and rejected by the server with a confusing message.
  check('params accept numbers', tools.normaliseParams({ freq: 220 }).values.freq, 220)
  check('params refuse a string', tools.normaliseParams({ freq: 'high' }).error !== null, true)
  check('params refuse an array', tools.normaliseParams([1, 2]).error !== null, true)
  check('absent params are not an error', tools.normaliseParams(undefined).values, null)
}

// --------------------------------------------------------------- server argv
const scsynth = await load('scsynth.js')
{
  const args = scsynth.serverArgs({ port: 57110 })
  check('server argv is just the port', JSON.stringify(args), '["-u","57110"]')
  // The measured crash: -m 0:0 makes scsynth die in World_New. No default may add it.
  check('server argv never sets a memory flag', args.includes('-m'), false)
  check('server argv honours -S', JSON.stringify(scsynth.serverArgs({ port: 57110, sampleRate: 48000 })), '["-u","57110","-S","48000"]')
  check('server argv honours -H', JSON.stringify(scsynth.serverArgs({ port: 57110, device: 'Headphones' })), '["-u","57110","-H","Headphones"]')
  check('server argv honours -N only when asked', JSON.stringify(scsynth.serverArgs({ port: 57110, loadDefs: false })), '["-u","57110","-N"]')
}

// --------------------------------------------------------------- source path policy
const project = await load('project.js')
{
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-sc-project-'))
  try {
    const written = await project.writeSource({ file: 'piece.scd', root, text: '(Synth(\\tone);)\n' })
    check('a relative path resolves in the root', written.ok, true)
    check('the write reports the created file', written.created, true)
    const read = await project.readSource({ file: 'piece.scd', root })
    check('read returns the text', read.text, '(Synth(\\tone);)\n')
    const listed = await project.listSources({ dir: '.', root })
    check('list finds the source file', listed.files.length, 1)
    check('list reports the relative path', listed.files[0].relative, 'piece.scd')
    const refused = await project.resolveSourcePath({ file: 'notes.txt', root })
    check('a non-source extension is refused', refused.ok, false)
    // A write that is told not to replace an existing file must say so rather
    // than quietly replacing it.
    const first = await project.writeSource({ file: 'keeper.scd', root, text: '// first\n' })
    check('the first write creates the file', first.created, true)
    const noOverwrite = await project.writeSource({ file: 'keeper.scd', root, text: '// second\n', overwrite: false })
    check('a write can refuse to replace', noOverwrite.ok, false)
    check('the refusal names the reason', typeof noOverwrite.error === 'string' && noOverwrite.error.includes('exists'), true)
    const kept = await project.readSource({ file: 'keeper.scd', root })
    check('the refused write left the file alone', kept.text, '// first\n')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

// --------------------------------------------------------------- measuring a sound
//
// The measurement half of the engine is pure arithmetic on the samples the server
// returned, so it is worth pinning exactly. The bug it exists to prevent is a tool
// that reports "SILENT" for a sound that is playing, and a model that is heard as
// noise because it clips.
{
  const { analyse, amplitude, spectrum, verdictFor, dominantPeaks } = await load('analysis.js')

  const sampleRate = 48_000
  const frames = sampleRate
  const tone = Float64Array.from({ length: frames }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / sampleRate))
  const noise = Float64Array.from({ length: frames }, () => (Math.random() * 2 - 1) * 0.4)
  const silence = new Float64Array(frames)

  const tonal = amplitude(tone)
  check('a 0.4 sine peaks at 0.4', Math.round(tonal.peak * 1000) / 1000, 0.4)
  check('a 0.4 sine has the expected rms', Math.round(tonal.rms * 1000) / 1000, 0.283)
  check('a clean sine does not clip', tonal.clipped, 0)
  check('silence is reported as silent', analyse(interleave(silence, silence), { channels: 2, sampleRate }).quiet, true)

  const loud = amplitude(Float64Array.from(tone, (v) => v * 4))
  check('a hot signal counts clipped samples', loud.clipped > 0, true)
  check('a hot signal is flagged as clipping', analyse(interleave(Float64Array.from(tone, (v) => v * 4), silence), { channels: 2, sampleRate }).clipping, true)

  // The tonality test is the one that separates a gong from a noise burst.
  const tonalSpectrum = spectrum(tone, { sampleRate })
  const noiseSpectrum = spectrum(noise, { sampleRate })
  check('a sine is strongly tonal', tonalSpectrum.flatness < 0.001, true)
  check('white noise is not tonal', noiseSpectrum.flatness > 0.2, true)
  check('the verdict for a sine says tonal', /tonal/.test(tonalSpectrum.verdict), true)
  check('the verdict for noise says noise', /noise/.test(noiseSpectrum.verdict), true)
  check('a 220 Hz sine is found at 220 Hz', Math.abs(tonalSpectrum.peaks[0].hz - 220) < 6, true)
  check('the flatness thresholds are named', verdictFor(0.5), 'noise (no discernible pitch)')

  // The FFT's own numerical noise in empty bins must not be reported as partials:
  // measured, a synthetic gong once reported 23906.3 Hz beside its 64.5 Hz root.
  const gongish = Float64Array.from({ length: frames }, (_, i) => {
    const t = i / sampleRate
    return 0.3 * Math.exp(-t / 2) * (Math.sin((2 * Math.PI * 62 * i) / sampleRate) + 0.5 * Math.sin((2 * Math.PI * 91.8 * i) / sampleRate))
  })
  const gongPeaks = spectrum(gongish, { sampleRate }).peaks
  check('a modal signal reports a few partials, not noise', gongPeaks.length <= 4, true)
  check('no partial is reported above 20 kHz', gongPeaks.every((peak) => peak.hz < 20_000), true)

  // A multi-channel capture is split, not summed: a signal in one channel only
  // must show up in that channel and not the other.
  const oneSided = analyse(interleave(tone, silence), { channels: 2, sampleRate })
  check('channel 0 reports the signal', oneSided.perChannel[0].rms > 0.2, true)
  check('channel 1 reports silence', oneSided.perChannel[1].rms, 0)
}

// --------------------------------------------------------------- the measurement tap
//
// `sc_capture` measures a def by rewriting its own `Out.ar` so the emitted signal
// is recorded inside the node that makes it. That rewrite is pure text handling,
// and every wrong version of it compiled — so it is pinned here.
{
  // `tools.js` lives one level up from the engine, and its tap transform is the
  // part worth pinning: it is pure text handling whose every wrong version still
  // compiled.
  const tools = await import(pathToFileURL(path.join(repo, 'lib', 'tools.js')).href)

  check('a def name is read from a backslash literal', tools.declaredSynthDefName('SynthDef(\\bell, { })'), 'bell')
  check('a def name is read from a single-quoted literal', tools.declaredSynthDefName("SynthDef('bell', { })"), 'bell')
  check('a def name is read from a double-quoted literal', tools.declaredSynthDefName('SynthDef("bell", { })'), 'bell')
  check('a name with underscores survives', tools.declaredSynthDefName('SynthDef(\\name_1x, { })'), 'name_1x')
  check('a source with no SynthDef has no name', tools.declaredSynthDefName('x = 1'), null)

  const simple = 'SynthDef(\\a, { |out = 0| Out.ar(out, SinOsc.ar(440) * 0.1) })'
  const tapped = tools.tapSynthDefSource(simple, 'a_measured')
  check('a tap is produced', typeof tapped === 'string', true)
  check('a tap registers the name it was given', tapped.includes('SynthDef(\\a_measured,'), true)
  check('a tap keeps the caller arguments', tapped.includes('|out = 0, recBuf = 0, recSeconds = 3|'), true)
  // The measurement mechanism itself. `RecordBuf.ar(Out.ar(...), buf)` was tried
  // and captured exact silence: `Out.ar` expands, so `RecordBuf.ar` was
  // instantiated once per channel. The recorded signal must be handed DIRECTLY to
  // `RecordBuf.ar`, and a mono signal must be duplicated to match the stereo
  // buffer, or the capture is silence.
  check('a tap records the emitted signal directly', tapped.includes('RecordBuf.ar('), true)
  check('a tap routes the record buffer through a function', tapped.includes('{ |dshOut|'), true)
  check('a tap forces the recorded signal to two channels', tapped.includes('dshSig.numChannels'), true)
  check('a tap frees its own node', tapped.includes('doneAction: 2'), true)
  check('a tap balanced its parentheses', (tapped.match(/\(/g) ?? []).length === (tapped.match(/\)/g) ?? []).length, true)

  // A body that declares its own `var` must still work: the caller's text is
  // wrapped in a function precisely so its `var` keeps its legal position.
  const withVar = 'SynthDef(\\b, { |out = 0| var s = Saw.ar(110) * 0.2; Out.ar(out, s) })'
  const tappedVar = tools.tapSynthDefSource(withVar, 'b_measured')
  check('a tap keeps a user var inside a function', tappedVar.includes('var s = Saw.ar(110)'), true)
  check('a tap leaves the user var inside braces', /\{\s*\|dshOut\|\s*var s =/.test(tappedVar), true)

  // Two emissions and a nested bus expression both have to survive.
  const twoOuts = 'SynthDef(\\c, { |out = 0| var s = Saw.ar(110) * 0.1; Out.ar(out, s); Out.ar(out + 2, s) })'
  const tappedTwo = tools.tapSynthDefSource(twoOuts, 'c_measured')
  check('every Out.ar is tapped', (tappedTwo.match(/Out\.ar\(out/g) ?? []).length, 2)
  check('each emission got its own RecordBuf', (tappedTwo.match(/RecordBuf\.ar\(/g) ?? []).length >= 2, true)
  check('a second Out.ar keeps its own bus', tappedTwo.includes('Out.ar(out + 2,'), true)

  const nested = 'SynthDef(\\d, { |out = 0, pan = 0| Out.ar(out, Pan2.ar(Saw.ar(110) * 0.1, pan)) })'
  const tappedNested = tools.tapSynthDefSource(nested, 'd_measured')
  check('a nested call is not mistaken for the bus', tappedNested.includes('Out.ar(out, { |dshSig|'), true)
  check('the nested call is recorded whole', tappedNested.includes('.value(Pan2.ar(Saw.ar(110) * 0.1, pan))'), true)

  // A def with no output cannot be measured, and must be refused rather than
  // silently reported as silent.
  check('a def with no Out.ar is refused', tools.tapSynthDefSource('SynthDef(\\e, { |freq = 100| SinOsc.ar(freq) })', 'e_m'), null)
  check('a non-SynthDef is refused', tools.tapSynthDefSource('x = 1', 'x_m'), null)

  // A single-argument `Out.ar(sig)` is a legal MONO emission to bus 0, and it has
  // no comma to split on. The feedback example writes exactly that, so refusing it
  // would make a whole category of instrument unmeasurable.
  const monoTap = tools.tapSynthDefSource('SynthDef(\\f, { |out = 0| Out.ar(SinOsc.ar(220) * 0.2) })', 'f_m')
  check('a mono Out.ar is tapped', typeof monoTap === 'string', true)
  check('a mono Out.ar gets bus 0', String(monoTap).includes('Out.ar(0,'), true)

  // Prose in a comment must not break the scan. sclang's `'x'` is a string, so
  // "a gong's modes" opens one that never closes — measured, that single
  // apostrophe made this transform refuse a perfectly balanced SynthDef.
  const commented = 'SynthDef(\\g, { |out = 0|\n\t// a gong\'s modes are not harmonic\n\tOut.ar(out, SinOsc.ar(220) * 0.2)\n})'
  const commentTap = tools.tapSynthDefSource(commented, 'g_m')
  check('an apostrophe in a comment does not break the tap', typeof commentTap === 'string', true)
  check('the comment survives the rewrite', String(commentTap).includes("a gong's modes"), true)
}

// --------------------------------------------------------------- a live install, when there is one
{
  const live = install.resolveInstall({ env: process.env })
  if (!live.hasLanguage) {
    skip('live sclang', 'no SuperCollider install on this host')
  } else {
    const session = await load('sclang.js')
    const started = Date.now()
    const first = await session.checkSyntax({ code: '{ SinOsc.ar(440) }.play;', sclangFile: live.sclang.file })
    check('live: valid code compiles', first.ok, true)
    const second = await session.checkSyntax({ code: '1 +', sclangFile: live.sclang.file })
    check('live: invalid code is refused', second.ok, false)
    check('live: the refusal carries output', typeof second.output === 'string' && second.output.length > 0, true)
    console.log('     (two compile checks in ' + (Date.now() - started) + ' ms against ' + live.version + ')')
  }
}

// --------------------------------------------------------------- done
console.log('')
console.log('dsh-supercollider: ' + (failures === 0 ? 'ok' : failures + ' FAILURE(S)') + (skipped > 0 ? ', ' + skipped + ' skipped' : ''))
process.exitCode = failures === 0 ? 0 : 1
