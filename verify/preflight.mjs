/**
 * Lead-side preflight for dsh-ssh-manager.
 *
 * Runs the plugin's host half against a fake Cordis context (capturing the web
 * route, the two tools, the prompt section and the effect disposers), exercises
 * the HTTP envelope over fake Node request/response objects, loads the browser
 * half inside a minimal fake DOM, and asserts that no credential ever leaks.
 *
 * Run from the plugin directory: `node verify/preflight.mjs`
 * Exit code 0 plus `PREFLIGHT OK` means the package is structurally sound.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { Readable } from 'node:stream'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ssh-manager-preflight-'))
process.env.DSH_PROFILE_DIR = dataRoot
process.env.DSH_HOME = dataRoot

const failures = []
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok - ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : `: ${detail}`}`)
    console.log(`FAIL - ${name}${detail === undefined ? '' : `: ${detail}`}`)
  }
}

const { apply, inject } = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href)

/* ── fake context ─────────────────────────────────────────────────────── */

const captured = { routes: [], tools: new Map(), sections: [], effects: [], disposers: [] }
const ctx = {
  logger: { warn: () => {} },
  effect(callback, label) {
    captured.effects.push(label)
    const returned = callback()
    if (typeof returned === 'function') {
      const wrapped = () => {
        returned()
        captured.disposers.push(label)
      }
      captured.effectDisposers = captured.effectDisposers ?? []
      captured.effectDisposers.push(wrapped)
      return wrapped
    }
    return () => {}
  },
  webServer: {
    register(route) {
      captured.routes.push(route)
      return () => { captured.routes = captured.routes.filter(candidate => candidate !== route) }
    },
  },
  connection: {
    requestRejection: () => undefined,
  },
  tools: {
    register(definition) {
      captured.tools.set(definition.name, definition)
      return () => { captured.tools.delete(definition.name) }
    },
  },
  systemPrompt: {
    section(section) {
      captured.sections.push(section)
      return () => { captured.sections = captured.sections.filter(candidate => candidate !== section) }
    },
  },
}

apply(ctx, {})

/* ── fake request / response ──────────────────────────────────────────── */

function fakeRequest(url, body, method = 'POST') {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(payload === '' ? [] : [Buffer.from(payload, 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = { 'content-type': 'application/json' }
  return stream
}

function fakeResponse() {
  const response = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      response.status = status
      response.headers = headers
      response.headersSent = true
      return response
    },
    end(body) {
      response.body = body === undefined ? '' : String(body)
      response.writableEnded = true
    },
    once() { return response },
    off() { return response },
    destroy() { response.destroyed = true },
  }
  return response
}

async function apiCall(method, body, options = {}) {
  const route = captured.routes[0]
  const response = fakeResponse()
  await route.handler(fakeRequest(`/ssh-manager/api/${method}`, body, options.httpMethod ?? 'POST'), response)
  let parsed = null
  try {
    parsed = JSON.parse(response.body)
  } catch {
    parsed = null
  }
  return { status: response.status, payload: parsed, raw: response.body }
}

const secretPassword = 'P@ssw0rd-preflight-should-never-leak'
const secretKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nPREFLIGHTKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----'

/* ── structure ────────────────────────────────────────────────────────── */

check('index exports apply', typeof apply === 'function')
check('inject services', JSON.stringify(inject) === JSON.stringify(['tools', 'systemPrompt', 'webServer', 'connection']), JSON.stringify(inject))
check('one API prefix route', captured.routes.length === 1 && captured.routes[0].kind === 'prefix' && captured.routes[0].path === '/ssh-manager/api')
check('two tools registered', captured.tools.size === 2 && captured.tools.has('ssh_servers') && captured.tools.has('ssh_exec'), [...captured.tools.keys()].join(','))
check('one prompt section', captured.sections.length === 1 && captured.sections[0].name === 'ssh-manager:servers', JSON.stringify(captured.sections.map(section => section.name)))

/* ── API envelope ─────────────────────────────────────────────────────── */

const empty = await apiCall('list', {})
check('list ok envelope', empty.status === 200 && empty.payload?.ok === true && Array.isArray(empty.payload.data.servers))

const createdPassword = await apiCall('save', {
  name: 'preflight-web-01', host: '10.0.0.11', port: 2222, username: 'ops',
  authType: 'password', password: secretPassword, note: 'created by preflight',
})
check('save (password) ok', createdPassword.status === 200 && createdPassword.payload?.ok === true, createdPassword.raw)
const serverId = createdPassword.payload?.data?.server?.id
check('save returns public view without password', serverId !== undefined && !createdPassword.raw.includes(secretPassword))

const conflict = await apiCall('save', { name: 'preflight-web-01', host: '10.0.0.12', username: 'ops', authType: 'password', password: 'x' })
check('duplicate name is a 409 conflict', conflict.status === 409 && conflict.payload?.ok === false)

const createdKey = await apiCall('save', {
  name: 'preflight-db-01', host: '10.0.0.12', username: 'root', authType: 'key', privateKey: secretKey,
})
check('save (private key) ok', createdKey.status === 200 && createdKey.payload?.ok === true, createdKey.raw)

const listed = await apiCall('list', {})
check('list has two servers', listed.payload?.data?.servers?.length === 2, JSON.stringify(listed.payload))
check('list hides both secrets', !listed.raw.includes(secretPassword) && !listed.raw.includes('PREFLIGHTKEYMATERIAL'))

const updated = await apiCall('save', { id: serverId, host: '10.0.0.11', port: 2223, username: 'ops', authType: 'password', note: 'updated' })
check('update keeps stored password', updated.status === 200 && updated.payload?.data?.server?.port === 2223 && updated.payload?.data?.server?.hasPassword === true, updated.raw)

const invalid = await apiCall('save', { host: '', username: '', authType: 'password', password: '' })
check('invalid input is a 400', invalid.status === 400 && invalid.payload?.error?.code === 'invalid-input')

const notFound = await apiCall('delete', { id: 'missing-id' })
check('delete missing is a 404', notFound.status === 404 && notFound.payload?.error?.code === 'not-found')

const methodNotAllowed = await apiCall('list', {}, { httpMethod: 'GET' })
check('non-POST is a 405', methodNotAllowed.status === 405)

const tested = await apiCall('test', { id: serverId })
check('test is a 200 test result (unreachable expected)', tested.status === 200 && tested.payload?.ok === true && typeof tested.payload?.data?.success === 'boolean', tested.raw)
check('test result carries no password', !tested.raw.includes(secretPassword))

const testedDraft = await apiCall('test-draft', {
  name: 'draft', host: '127.0.0.1', port: 1, username: 'nobody', authType: 'password', password: secretPassword,
})
check('test-draft works and leaks nothing', testedDraft.status === 200 && testedDraft.payload?.ok === true && !testedDraft.raw.includes(secretPassword), testedDraft.raw)

/* ── agent tools ──────────────────────────────────────────────────────── */

const listTool = captured.tools.get('ssh_servers')
const listValue = await listTool.execute({ action: 'list' }, {})
check('ssh_servers list value', Array.isArray(listValue.servers) && listValue.servers.length === 2)
check('ssh_servers list has no secrets', !JSON.stringify(listValue).includes(secretPassword) && !JSON.stringify(listValue).includes('PREFLIGHTKEYMATERIAL'))
const listContent = listTool.output.render({ action: 'list' }, listValue)
check('ssh_servers render is text', Array.isArray(listContent) && listContent[0]?.type === 'text' && listContent[0].text.includes('preflight-web-01'), JSON.stringify(listContent))

const testValue = await listTool.execute({ action: 'test', server: 'preflight-web-01', timeout_seconds: 2 }, {})
check('ssh_servers test shape', testValue.result !== undefined && typeof testValue.result.success === 'boolean')

const execTool = captured.tools.get('ssh_exec')
const execValue = await execTool.execute({ server: 'preflight-web-01', command: 'uptime', timeout_seconds: 2 }, {})
check('ssh_exec failure value is JSON-safe', execValue.exitCode === null && typeof execValue.message === 'string' && !JSON.stringify(execValue).includes(secretPassword), JSON.stringify(execValue))
const execContent = execTool.output.render({}, execValue)
check('ssh_exec render is text', Array.isArray(execContent) && execContent[0]?.type === 'text')

/* ── prompt section ───────────────────────────────────────────────────── */

const promptText = captured.sections[0].text({})
check('prompt lists both servers', promptText.includes('preflight-web-01') && promptText.includes('preflight-db-01'), promptText)
check('prompt teaches the /host reference form', promptText.includes('reference: /10.0.0.11') && promptText.includes('`/<host>`'), promptText)
check('prompt hides credentials', !promptText.includes(secretPassword) && !promptText.includes('PREFLIGHTKEYMATERIAL'))

/* ── persistence ──────────────────────────────────────────────────────── */

const stored = JSON.parse(readFileSync(path.join(dataRoot, 'data', 'ssh-manager', 'servers.json'), 'utf8'))
check('data file persisted two records', Array.isArray(stored) && stored.length === 2)
const persistedPassword = stored.find(record => record.name === 'preflight-web-01')
check('password persisted host-side', persistedPassword?.password === secretPassword)

/* ── browser half ─────────────────────────────────────────────────────── */

const styleElements = []
const fakeDocument = {
  baseURI: 'http://127.0.0.1:58873/',
  head: { appendChild: element => { styleElements.push(element) } },
  body: { style: {} },
  documentElement: { clientWidth: 1200 },
  getElementById: () => null,
  createElement: tag => ({ tag, style: {}, dataset: {}, remove: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  activeElement: null,
  contains: () => false,
}
const fakeWindow = { innerWidth: 1200, setTimeout: () => 0, clearTimeout: () => {}, __ModuleLoader__: null }
const slots = { registered: [], injections: [] }
const locale = { registered: [], disposers: [] }
const triggers = { sources: [] }
const clientCtx = {
  effect(callback) { return callback() },
  locale: {
    register(namespace, dictionaries) { locale.registered.push({ namespace, dictionaries }); return () => {} },
    bind: namespace => key => `${namespace}.${key}`,
  },
  slots: {
    inject(name, callback) { slots.injections.push(name); callback() },
    register(options, component) {
      slots.registered.push({ options, component })
      return () => {}
    },
  },
  inject(_services, callback) {
    const scope = {
      inputTriggers: {
        registerSource(source) { triggers.sources.push(source); return () => {} },
      },
      effect(callback) { return callback() },
    }
    callback(scope)
  },
}

const fakeServers = [
  { id: 's1', name: 'preflight-web-01', host: '10.0.0.11', port: 2223, username: 'ops', authType: 'password', hasPassword: true, hasKey: false },
  { id: 's2', name: 'preflight-db-01', host: '10.0.0.12', port: 22, username: 'root', authType: 'key', hasPassword: false, hasKey: true },
]
let moduleDefinition = null
fakeWindow.__ModuleLoader__ = { load: definition => { moduleDefinition = definition } }
const sandbox = {
  window: fakeWindow,
  document: fakeDocument,
  URL,
  fetch: async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: true, data: { servers: fakeServers } } },
  }),
  console,
  setTimeout,
  clearTimeout,
  React: null,
}
sandbox.globalThis = sandbox
vm.runInNewContext(readFileSync(path.join(pluginDir, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })

check('client module loads through __ModuleLoader__', moduleDefinition !== null && moduleDefinition.id === '@local/dsh-ssh-manager')
const clientModule = moduleDefinition?.factory(moduleName => {
  if (moduleName !== 'react') throw new Error(`unexpected require(${moduleName})`)
  return { createElement: () => ({}), useEffect: () => {}, useRef: () => ({ current: null }), useState: () => [null, () => {}] }
})
check('client exports inject + apply', typeof clientModule?.apply === 'function' && JSON.stringify(clientModule.inject) === JSON.stringify(['slots', 'locale']))
clientModule.apply(clientCtx)
check('client registers locale dictionaries', locale.registered.length === 1 && locale.registered[0].namespace === 'sshManager' && typeof locale.registered[0].dictionaries.zh === 'object' && typeof locale.registered[0].dictionaries.en === 'object')
const zhDict = locale.registered[0]?.dictionaries?.zh ?? {}
const enDict = locale.registered[0]?.dictionaries?.en ?? {}
check('locale dictionaries keep identical key sets', JSON.stringify(Object.keys(zhDict).sort()) === JSON.stringify(Object.keys(enDict).sort()))
const requiredKeys = [
  'files', 'sftpTitle', 'sftpUpload', 'sftpDownload', 'sftpUploading', 'sftpDownloading',
  'sftpUploadDone', 'sftpDownloadDone', 'sftpNeedPath', 'sftpNeedFile', 'credentialNote',
]
check('locale has every SFTP key', requiredKeys.every(key => typeof zhDict[key] === 'string' && typeof enDict[key] === 'string'), JSON.stringify(requiredKeys.filter(key => typeof zhDict[key] !== 'string' || typeof enDict[key] !== 'string')))
check('client installs one stylesheet', styleElements.length === 1 && styleElements[0].id === 'dsh-ssh-manager-styles', String(styleElements.length))
check('client injects settings.section', slots.injections[0] === 'settings.section')
const registration = slots.registered[0]?.options
check('settings section options', registration?.name === 'settings.section' && registration?.id === 'ssh-manager' && registration?.order === 110 && registration?.locale === 'sshManager', JSON.stringify(registration))
check('settings section label is localized', registration?.label?.() === 'sshManager.nav', String(registration?.label?.()))
check('component is a renderer', typeof slots.registered[0]?.component === 'function')

/* ── composer mention sources ──────────────────────────────────────────── */

const atSource = triggers.sources.find(source => source.trigger === '@')
const slashSource = triggers.sources.find(source => source.trigger === '/')
check('@ mention source registered', atSource !== undefined && atSource.name === 'SSH')
check('/ mention source registered', slashSource !== undefined && slashSource.name === 'SSH')
const allMentionItems = await atSource.candidates({ sessionId: 'session' }, { query: '', quoted: false })
check('mention candidates list every server by IP', allMentionItems.length === 2 && allMentionItems[0].name === '10.0.0.11', JSON.stringify(allMentionItems))
const filteredMentions = await atSource.candidates({ sessionId: 'session' }, { query: '10.0.0.12', quoted: false })
check('mention candidates filter by host', filteredMentions.length === 1 && filteredMentions[0].name === '10.0.0.12', JSON.stringify(filteredMentions))
check('mention candidate describes the target', String(filteredMentions[0]?.description).includes('root@22') && String(filteredMentions[0]?.description).includes('preflight-db-01'), String(filteredMentions[0]?.description))
const mentionPick = atSource.onPick({ candidate: filteredMentions[0] })
check('mention pick inserts /host', mentionPick !== undefined && mentionPick.text === '/10.0.0.12', JSON.stringify(mentionPick))
const slashPick = slashSource.onPick({ candidate: filteredMentions[0] })
check('/ pick inserts /host', slashPick !== undefined && slashPick.text === '/10.0.0.12', JSON.stringify(slashPick))
check('mention source never exposes credentials', !JSON.stringify(allMentionItems).includes('password') && !JSON.stringify(allMentionItems).includes('privateKey'))

/* ── SFTP API ─────────────────────────────────────────────────────────── */

const { createStore: createSftpStore } = await import(pathToFileURL(path.join(pluginDir, 'host', 'store.js')).href)
const { registerApiRoutes } = await import(pathToFileURL(path.join(pluginDir, 'host', 'api.js')).href)

const sftpStore = createSftpStore({ dir: path.join(dataRoot, 'sftp-store') })
sftpStore.load()
const sftpServer = await sftpStore.create({
  name: 'sftp-target', host: '127.0.0.1', port: 1, username: 'ops', authType: 'password', password: secretPassword,
})
check('store resolves a server by host/IP', sftpStore.find('127.0.0.1')?.name === 'sftp-target')
const received = { uploads: [], downloads: [] }
let sftpRoute = null
const sftpCtx = {
  logger: { warn: () => {} },
  webServer: { register(route) { sftpRoute = route; return () => {} } },
  connection: { requestRejection: () => undefined },
}
registerApiRoutes(sftpCtx, {
  store: sftpStore,
  ssh: { probe: async () => ({ latencyMs: 1, output: 'ok' }) },
  sftp: {
    async upload(_record, remotePath, data, options) {
      received.uploads.push({ remotePath, bytes: data.length, fileName: options?.fileName })
      const finalPath = remotePath.endsWith('/') ? remotePath + (options?.fileName ?? '') : remotePath
      return { remotePath: finalPath, bytes: data.length }
    },
    async download(_record, remotePath) {
      received.downloads.push({ remotePath })
      return { remotePath, fileName: 'hello.txt', bytes: 5, data: Buffer.from('hello').toString('base64') }
    },
  },
})

async function sftpCall(method, body) {
  const response = fakeResponse()
  await sftpRoute.handler(fakeRequest(`/ssh-manager/api/${method}`, body), response)
  return { status: response.status, payload: JSON.parse(response.body), raw: response.body }
}

const uploaded = await sftpCall('sftp-upload', {
  id: sftpServer.id, remotePath: '/tmp/', fileName: 'demo.txt', data: Buffer.from('hello').toString('base64'),
})
check('sftp-upload ok', uploaded.status === 200 && uploaded.payload.ok === true
  && uploaded.payload.data.remotePath === '/tmp/demo.txt' && uploaded.payload.data.bytes === 5, uploaded.raw)
check('sftp-upload reaches the transfer client', received.uploads.length === 1 && received.uploads[0].bytes === 5, JSON.stringify(received.uploads))

const uploadedPlain = await sftpCall('sftp-upload', {
  id: sftpServer.id, remotePath: '/tmp/demo.txt', data: Buffer.from('x').toString('base64'),
})
check('sftp-upload keeps an explicit path verbatim', uploadedPlain.payload?.data?.remotePath === '/tmp/demo.txt', uploadedPlain.raw)

const uploadedMissing = await sftpCall('sftp-upload', { id: sftpServer.id, remotePath: '/tmp/' })
check('sftp-upload without data is a 400', uploadedMissing.status === 400 && uploadedMissing.payload.error.code === 'invalid-input')

const bigData = Buffer.alloc(Math.round(1.2 * 1024 * 1024), 7).toString('base64')
const bigUpload = await sftpCall('sftp-upload', { id: sftpServer.id, remotePath: '/tmp/big.bin', data: bigData })
check('sftp-upload accepts bodies above the ordinary 1 MiB limit', bigUpload.status === 200
  && bigUpload.payload.data.bytes === Math.round(1.2 * 1024 * 1024), String(bigUpload.raw).slice(0, 120))
const bigList = await sftpCall('list', { junk: 'x'.repeat(Math.round(1.2 * 1024 * 1024)) })
check('ordinary methods keep the 1 MiB body limit', bigList.status === 400 && bigList.payload.error.code === 'bad-request')

const downloaded = await sftpCall('sftp-download', { id: sftpServer.id, remotePath: '/root/hello.txt' })
check('sftp-download returns a base64 payload', downloaded.status === 200
  && downloaded.payload.data.fileName === 'hello.txt' && downloaded.payload.data.data === 'aGVsbG8=', downloaded.raw)
check('SFTP responses never contain credentials', !uploaded.raw.includes(secretPassword) && !downloaded.raw.includes(secretPassword))
const downloadMissing = await sftpCall('sftp-download', { id: sftpServer.id })
check('sftp-download without a path is a 400', downloadMissing.status === 400 && downloadMissing.payload.error.code === 'invalid-input')

/* ── teardown ─────────────────────────────────────────────────────────── */

for (const dispose of captured.effectDisposers ?? []) dispose()
check('disposal clears every registration', captured.routes.length === 0 && captured.tools.size === 0 && captured.sections.length === 0)

rmSync(dataRoot, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\nPREFLIGHT FAILED (${failures.length})`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('\nPREFLIGHT OK')
