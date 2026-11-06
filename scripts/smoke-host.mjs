/**
 * Offline smoke test for the dsh-ssh-manager host half.
 *
 * Runs without DSH: it exercises the store against a temporary directory under
 * `plugins/dsh-ssh-manager/.smoke-tmp`, checks the friendly failure path of the
 * SSH probe against `127.0.0.1:1`, and mounts the real plugin `apply()` on a
 * minimal fake Cordis context to exercise the HTTP API, the two tools, and the
 * system-prompt section end to end. The temporary directory is always removed.
 *
 * Usage: node scripts/smoke-host.mjs  (from the plugin directory)
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'
import { createSshClient } from '../host/ssh.js'
import { createStore } from '../host/store.js'

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = path.join(pluginDir, '.smoke-tmp')
const storeDir = path.join(tmpRoot, 'store')
const corruptDir = path.join(tmpRoot, 'corrupt')
const profileDir = path.join(tmpRoot, 'profile')

/** Print one passed check. */
function pass(label) {
  console.log(`ok - ${label}`)
}

/**
 * Assert that a promise rejects with the expected tagged error code.
 * @param {Promise<unknown>} promise - promise expected to reject.
 * @param {string} code - expected `error.code`.
 * @param {string} label - check label.
 * @returns {Promise<Error>} the rejection.
 */
async function expectCode(promise, code, label) {
  try {
    await promise
  } catch (error) {
    assert.equal(error && error.code, code, `${label}: expected code "${code}", got "${error && error.code}"`)
    return error
  }
  assert.fail(`${label}: expected a rejection with code "${code}"`)
}

/**
 * Assert that a JSON-serializable value does not contain any of the secrets.
 * @param {unknown} value - value to serialize.
 * @param {string[]} secrets - secret substrings that must never appear.
 * @param {string} label - check label.
 */
function assertSecretFree(value, secrets, label) {
  const serialized = JSON.stringify(value)
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `${label}: leaked secret material`)
  }
}

/**
 * Fake `IncomingMessage` for the API route.
 * @param {{ method?: string, body?: unknown }} options - request options.
 * @returns {object} request-like object.
 */
function makeRequest({ method = 'POST', body } = {}) {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const chunks = raw === '' ? [] : [Buffer.from(raw, 'utf8')]
  const listeners = new Map()
  const req = {
    method,
    url: '/ssh-manager/api/list',
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    once(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
    on(event, listener) {
      return req.once(event, listener)
    },
    off(event, listener) {
      const list = listeners.get(event) ?? []
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
      return req
    },
  }
  return req
}

/**
 * Fake `ServerResponse` capturing the written JSON body.
 * @returns {object} response-like object.
 */
function makeResponse() {
  const listeners = new Map()
  const res = {
    statusCode: 0,
    headers: null,
    payload: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
      res.headersSent = true
      return res
    },
    end(payload) {
      res.payload = typeof payload === 'string' ? payload : ''
      res.writableEnded = true
      return res
    },
    destroy() {
      res.destroyed = true
    },
    once(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return res
    },
    on(event, listener) {
      return res.once(event, listener)
    },
    off(event, listener) {
      const list = listeners.get(event) ?? []
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
      return res
    },
  }
  return res
}

/**
 * Call one API method through the registered route.
 * @param {object} route - registered route.
 * @param {string} method - API method name.
 * @param {unknown} body - JSON body (string = raw payload).
 * @param {{ method?: string }} [options] - HTTP method override.
 * @returns {Promise<{ status: number, json: object | null }>} response.
 */
async function callApi(route, method, body, options = {}) {
  const req = makeRequest({ method: options.method ?? 'POST', body })
  req.url = `/ssh-manager/api/${method}`
  const res = makeResponse()
  await route.handler(req, res)
  const json = res.payload === '' ? null : JSON.parse(res.payload)
  return { status: res.statusCode, json }
}

/**
 * Fake Cordis host context recording every registration.
 * @returns {{ ctx: object, state: object, runCleanup: () => void }} fake context.
 */
function makeFakeContext() {
  const state = {
    tools: new Map(),
    sections: new Map(),
    routes: [],
    warnings: [],
  }
  const cleanups = []
  const ctx = {
    logger: {
      warn: (message) => state.warnings.push(String(message)),
    },
    effect(callback, label) {
      cleanups.push({ label, cleanup: callback() })
      return () => {}
    },
    tools: {
      register(definition) {
        if (state.tools.has(definition.name)) throw new Error(`duplicate tool "${definition.name}"`)
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        if (state.sections.has(section.name)) throw new Error(`duplicate section "${section.name}"`)
        state.sections.set(section.name, section)
        return () => state.sections.delete(section.name)
      },
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {
          const index = state.routes.indexOf(route)
          if (index >= 0) state.routes.splice(index, 1)
        }
      },
    },
    connection: {
      requestRejection: () => undefined,
    },
  }
  return {
    ctx,
    state,
    runCleanup() {
      for (const entry of cleanups.splice(0).reverse()) entry.cleanup()
    },
  }
}

/** Store CRUD, validation, conflict, and projection checks. */
async function testStore() {
  mkdirSync(storeDir, { recursive: true })
  const store = createStore({ dir: storeDir })
  store.load()
  assert.equal(store.dataDir(), storeDir)
  assert.deepEqual(store.list(), [])

  const created = await store.create({
    name: 'web-01',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'S3cret!pass',
    note: 'prod web',
  })
  assert.equal(created.name, 'web-01')
  assert.equal(created.hasPassword, true)
  assert.equal(created.hasKey, false)
  assert.equal('password' in created, false)
  assert.equal('privateKey' in created, false)
  assertSecretFree(created, ['S3cret!pass'], 'public view')

  const defaulted = await store.create({
    host: '10.0.0.2',
    username: 'deploy',
    authType: 'key',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-material\n-----END OPENSSH PRIVATE KEY-----',
  })
  assert.equal(defaulted.name, 'deploy@10.0.0.2')
  assert.equal(defaulted.port, 22)
  assert.equal(defaulted.hasKey, true)

  const listed = store.list()
  assert.equal(listed.length, 2)
  assert.deepEqual(listed.map((server) => server.name), ['deploy@10.0.0.2', 'web-01'])

  await expectCode(
    store.create({ name: 'WEB-01', host: '10.0.0.3', username: 'root', authType: 'password', password: 'x' }),
    'conflict',
    'duplicate name (case-insensitive)',
  )

  const invalidDrafts = [
    [{ username: 'root', authType: 'password', password: 'x' }, 'missing host'],
    [{ host: '10.0.0.4 bad', username: 'root', authType: 'password', password: 'x' }, 'host with whitespace'],
    [{ host: '10.0.0.4', port: 70000, username: 'root', authType: 'password', password: 'x' }, 'port out of range'],
    [{ host: '10.0.0.4', port: 'abc', username: 'root', authType: 'password', password: 'x' }, 'non-numeric port'],
    [{ host: '10.0.0.4', username: '', authType: 'password', password: 'x' }, 'missing username'],
    [{ host: '10.0.0.4', username: 'root', authType: 'agent', password: 'x' }, 'bad auth type'],
    [{ host: '10.0.0.4', username: 'root', authType: 'password' }, 'missing password'],
    [{ host: '10.0.0.4', username: 'root', authType: 'key' }, 'missing private key'],
    [{ host: '10.0.0.4', username: 'root', authType: 'password', password: 'x', note: 'n'.repeat(501) }, 'note too long'],
  ]
  for (const [draft, label] of invalidDrafts) await expectCode(store.create(draft), 'invalid-input', `validation: ${label}`)

  assert.equal(store.get(created.id).name, 'web-01')
  assert.equal(store.get('missing-id'), undefined)
  assert.equal(store.find(created.id).id, created.id)
  assert.equal(store.find('WEB-01').id, created.id)
  assert.equal(store.find('we').id, created.id)
  assert.equal(store.find('deploy').id, defaulted.id)
  assert.equal(store.find('nope'), undefined)
  assert.equal(store.find(''), undefined)

  // Update keeps the stored secret when the secret field is empty…
  const updated = await store.update(created.id, { name: 'web-01', host: '10.0.0.9', password: '' })
  assert.equal(updated.host, '10.0.0.9')
  assert.equal(updated.hasPassword, true)
  assert.equal(store.getSecretRecord(created.id).password, 'S3cret!pass')
  assert.equal(store.getSecretRecord(created.id).host, '10.0.0.9')

  // …and replaces it when a new value is supplied.
  await store.update(created.id, { password: 'N3w!pass' })
  assert.equal(store.getSecretRecord(created.id).password, 'N3w!pass')

  // Changing the auth type requires a matching new secret.
  await expectCode(store.update(created.id, { authType: 'key' }), 'invalid-input', 'auth switch without key')
  const switched = await store.update(created.id, { authType: 'key', privateKey: 'KEYDATA', passphrase: 'pp' })
  assert.equal(switched.authType, 'key')
  assert.equal(switched.hasKey, true)
  assert.equal(switched.hasPassword, false)
  const switchedRecord = store.getSecretRecord(created.id)
  assert.equal(switchedRecord.privateKey, 'KEYDATA')
  assert.equal(switchedRecord.password, undefined)
  assert.equal(switchedRecord.passphrase, 'pp')

  // An explicit empty passphrase clears the stored one.
  await store.update(created.id, { passphrase: '' })
  assert.equal(store.getSecretRecord(created.id).passphrase, undefined)

  await expectCode(store.update(defaulted.id, { name: 'web-01' }), 'conflict', 'update duplicate name')
  await expectCode(store.update('missing-id', { note: 'x' }), 'not-found', 'update missing record')

  const draftMerge = await store.testDraft({ id: created.id, host: '10.0.0.10', username: 'root', authType: 'key' })
  assert.equal(draftMerge.id, created.id)
  assert.equal(draftMerge.privateKey, 'KEYDATA')
  assert.equal(draftMerge.host, '10.0.0.10')
  const draftFresh = await store.testDraft({ host: '10.0.0.11', username: 'nobody', authType: 'password', password: 'draft-secret' })
  assert.equal(draftFresh.password, 'draft-secret')
  await expectCode(store.testDraft({ id: 'missing-id', host: 'h', username: 'u', authType: 'password', password: 'p' }), 'not-found', 'test-draft missing id')
  await expectCode(store.testDraft({ host: 'h', username: 'u', authType: 'password' }), 'invalid-input', 'test-draft missing secret')
  assert.equal(store.list().length, 2, 'test-draft must not persist')

  // The data file is written atomically and reloads.
  assert.equal(existsSync(path.join(storeDir, 'servers.json')), true)
  assert.equal(existsSync(path.join(storeDir, 'servers.json.tmp')), false)
  const persisted = JSON.parse(readFileSync(path.join(storeDir, 'servers.json'), 'utf8'))
  assert.equal(Array.isArray(persisted), true)
  assert.equal(persisted.length, 2)
  const reopened = createStore({ dir: storeDir })
  reopened.load()
  assert.equal(reopened.list().length, 2)

  assert.equal(await store.remove(created.id), true)
  assert.equal(await store.remove(created.id), false)
  assert.equal(store.list().length, 1)
  pass('store: create / list / update / remove / validation / conflict / atomic reload')

  // A corrupt data file is quarantined and the store starts empty.
  mkdirSync(corruptDir, { recursive: true })
  writeFileSync(path.join(corruptDir, 'servers.json'), '{not valid json', 'utf8')
  const corruptStore = createStore({ dir: corruptDir })
  corruptStore.load()
  assert.deepEqual(corruptStore.list(), [])
  const quarantined = readdirSync(corruptDir).filter((name) => name.startsWith('servers.json.corrupt-'))
  assert.equal(quarantined.length, 1)
  writeFileSync(path.join(corruptDir, 'servers.json'), '{"not":"an array"}', 'utf8')
  const nonArrayStore = createStore({ dir: corruptDir })
  nonArrayStore.load()
  assert.deepEqual(nonArrayStore.list(), [])
  assert.equal(readdirSync(corruptDir).filter((name) => name.startsWith('servers.json.corrupt-')).length, 2)
  pass('store: corrupt data file quarantined')
}

/** SSH probe failure path: friendly, tagged, and secret-free. */
async function testSsh() {
  const ssh = createSshClient()
  const unreachable = {
    id: '127.0.0.1:1',
    name: 'unreachable',
    host: '127.0.0.1',
    port: 1,
    username: 'nobody',
    authType: 'password',
    password: 'probe-secret',
  }
  let probeError
  try {
    await ssh.probe(unreachable, { timeoutMs: 3000 })
  } catch (error) {
    probeError = error
  }
  assert.ok(probeError, 'probe must reject for 127.0.0.1:1')
  assert.equal(['timeout', 'network', 'auth', 'unknown'].includes(probeError.code), true, `unexpected probe code "${probeError.code}"`)
  assert.equal(probeError.message.includes('probe-secret'), false, 'probe message leaked the password')
  assert.match(probeError.message, /[\u4e00-\u9fa5]/, 'probe message must be Chinese')
  await expectCode(ssh.exec(unreachable, '   '), 'invalid-input', 'exec rejects an empty command')
  pass('ssh: unreachable probe fails with a friendly secret-free error')
}

/** Full plugin mount on a fake context plus API, tools, and prompt checks. */
async function testPlugin() {
  const previousProfileDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profileDir
  const fake = makeFakeContext()
  try {
    apply(fake.ctx)
    const { state } = fake
    assert.equal(state.tools.size, 2)
    assert.equal(state.tools.has('ssh_servers'), true)
    assert.equal(state.tools.has('ssh_exec'), true)
    assert.equal(state.sections.size, 1)
    assert.equal(state.sections.has('ssh-manager:servers'), true)
    assert.equal(state.routes.length, 1)
    const route = state.routes[0]
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/ssh-manager/api')
    pass('plugin: apply() mounts two tools, one prompt section, one API route')

    // --- API envelope and validation paths ---
    const empty = await callApi(route, 'list', {})
    assert.equal(empty.status, 200)
    assert.equal(empty.json.ok, true)
    assert.deepEqual(empty.json.data.servers, [])

    const get405 = await callApi(route, 'list', {}, { method: 'GET' })
    assert.equal(get405.status, 405)
    assert.equal(get405.json.ok, false)
    assert.equal(get405.json.error.code, 'method-not-allowed')

    const originalRejection = fake.ctx.connection.requestRejection
    fake.ctx.connection.requestRejection = () => ({ rejection: 403 })
    const forbidden = await callApi(route, 'list', {})
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.json.error.code, 'forbidden')
    fake.ctx.connection.requestRejection = originalRejection

    const unknown = await callApi(route, 'nope', {})
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.error.code, 'not-found')

    const badJson = await callApi(route, 'save', '{not json')
    assert.equal(badJson.status, 400)
    assert.equal(badJson.json.error.code, 'bad-request')

    const oversized = await callApi(route, 'save', { host: 'h', username: 'u', authType: 'password', password: 'p', note: 'x'.repeat(1024 * 1024 + 16) })
    assert.equal(oversized.status, 400)
    assert.equal(oversized.json.error.code, 'bad-request')

    const saved = await callApi(route, 'save', {
      name: 'smoke-server',
      host: '127.0.0.1',
      port: 1,
      username: 'root',
      authType: 'password',
      password: 'api-secret',
      note: 'smoke note',
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.ok, true)
    const savedServer = saved.json.data.server
    assert.equal(savedServer.name, 'smoke-server')
    assert.equal(savedServer.hasPassword, true)
    assertSecretFree(saved.json, ['api-secret'], 'save response')

    const duplicate = await callApi(route, 'save', { name: 'SMOKE-SERVER', host: '10.0.0.5', username: 'root', authType: 'password', password: 'x' })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error.code, 'conflict')

    const invalid = await callApi(route, 'save', { host: '', username: 'root', authType: 'password', password: 'x' })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error.code, 'invalid-input')

    const fetched = await callApi(route, 'get', { id: savedServer.id })
    assert.equal(fetched.status, 200)
    assert.equal(fetched.json.data.server.id, savedServer.id)
    assertSecretFree(fetched.json, ['api-secret'], 'get response')

    const missingGet = await callApi(route, 'get', { id: 'missing-id' })
    assert.equal(missingGet.status, 404)
    assert.equal(missingGet.json.error.code, 'not-found')

    const updated = await callApi(route, 'save', { id: savedServer.id, port: 1, host: '127.0.0.1', username: 'root', authType: 'password', name: 'smoke-server', password: '' })
    assert.equal(updated.status, 200)
    assert.equal(updated.json.data.server.hasPassword, true)
    assertSecretFree(updated.json, ['api-secret'], 'update response')

    const missingTest = await callApi(route, 'test', { id: 'missing-id' })
    assert.equal(missingTest.status, 404)
    assert.equal(missingTest.json.error.code, 'not-found')

    const draftTest = await callApi(route, 'test-draft', {
      host: '127.0.0.1',
      port: 1,
      username: 'nobody',
      authType: 'password',
      password: 'draft-secret',
    })
    assert.equal(draftTest.status, 200)
    assert.equal(draftTest.json.ok, true)
    assert.equal(draftTest.json.data.success, false)
    assert.match(draftTest.json.data.message, /[\u4e00-\u9fa5]/)
    assertSecretFree(draftTest.json, ['draft-secret'], 'test-draft response')

    const draftInvalid = await callApi(route, 'test-draft', { host: '127.0.0.1', port: 1, username: 'nobody', authType: 'password' })
    assert.equal(draftInvalid.status, 400)
    assert.equal(draftInvalid.json.error.code, 'invalid-input')

    const testById = await callApi(route, 'test', { id: savedServer.id })
    assert.equal(testById.status, 200)
    assert.equal(testById.json.ok, true)
    assert.equal(testById.json.data.success, false)
    assertSecretFree(testById.json, ['api-secret'], 'test response')
    pass('api: envelopes, trust fence, validation, save/get/delete/test/test-draft')

    // --- Prompt section reads the live store ---
    const section = state.sections.get('ssh-manager:servers')
    assert.equal(section.order, 40)
    const sectionText = section.text()
    assert.equal(sectionText.includes('## SSH servers'), true)
    assert.equal(sectionText.includes('smoke-server'), true)
    assert.equal(sectionText.includes('api-secret'), false)
    assertSecretFree(sectionText, ['api-secret'], 'prompt text')

    // --- Tools ---
    const serversTool = state.tools.get('ssh_servers')
    const listValue = await serversTool.execute({ action: 'list' })
    assert.equal(Array.isArray(listValue.servers), true)
    assert.equal(listValue.servers.length, 1)
    assertSecretFree(listValue, ['api-secret'], 'ssh_servers list value')
    const listRender = serversTool.output.render({ action: 'list' }, listValue)
    assert.equal(listRender[0].type, 'text')
    assert.equal(listRender[0].text.includes('smoke-server'), true)
    assert.equal(listRender[0].text.includes('root@127.0.0.1:1'), true)
    assert.equal(listRender[0].text.includes('(password auth)'), true)

    const unknownServer = await serversTool.execute({ action: 'test', server: 'nope' })
    assert.equal(typeof unknownServer.message, 'string')
    serversTool.output.render({ action: 'test', server: 'nope' }, unknownServer)

    const probeToolValue = await serversTool.execute({ action: 'test', server: savedServer.id, timeout_seconds: 3 })
    assert.equal(probeToolValue.result.success, false)
    assert.match(probeToolValue.result.message, /[\u4e00-\u9fa5]/)
    assertSecretFree(probeToolValue, ['api-secret'], 'ssh_servers test value')
    const probeRender = serversTool.output.render({ action: 'test', server: savedServer.id }, probeToolValue)
    assert.equal(probeRender[0].type, 'text')
    assert.equal(serversTool.presentCall({ action: 'list' }).card, 'generic')

    const execTool = state.tools.get('ssh_exec')
    const execUnknown = await execTool.execute({ server: 'nope', command: 'echo hi' })
    assert.equal(execUnknown.exitCode, null)
    assert.equal(typeof execUnknown.message, 'string')
    assertSecretFree(execUnknown, ['api-secret'], 'ssh_exec unknown-server value')

    const execUnreachable = await execTool.execute({ server: savedServer.id, command: 'echo hi', timeout_seconds: 3 })
    assert.equal(execUnreachable.exitCode, null)
    assert.equal(typeof execUnreachable.message, 'string')
    assertSecretFree(execUnreachable, ['api-secret'], 'ssh_exec failure value')
    const execFailureRender = execTool.output.render({ server: savedServer.id, command: 'echo hi' }, execUnreachable)
    assert.equal(execFailureRender[0].text.includes('failed:'), true)

    const synthetic = {
      server: 'web-01',
      username: 'root',
      host: '10.0.0.1',
      port: 22,
      exitCode: 0,
      durationMs: 12,
      stdout: 'hello',
      stderr: '',
      truncated: false,
    }
    const execRender = execTool.output.render({ server: 'web-01', command: 'echo hello' }, synthetic)
    assert.equal(execRender[0].text.includes('server: web-01 (root@10.0.0.1:22)'), true)
    assert.equal(execRender[0].text.includes('exit: 0 · 12ms'), true)
    assert.equal(execRender[0].text.includes('--- stdout ---'), true)
    assert.equal(execTool.isConcurrencySafe(), true)
    assert.equal(execTool.presentCall({ server: 'web-01' }).card, 'generic')
    pass('tools: ssh_servers / ssh_exec values and rendered text')

    // --- Delete, empty prompt, disposers ---
    const deleted = await callApi(route, 'delete', { id: savedServer.id })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.json.data.deleted, true)
    const deleteAgain = await callApi(route, 'delete', { id: savedServer.id })
    assert.equal(deleteAgain.status, 404)
    assert.equal(section.text().includes('No SSH servers are configured'), true)

    fake.runCleanup()
    assert.equal(state.tools.size, 0)
    assert.equal(state.sections.size, 0)
    assert.equal(state.routes.length, 0)
    pass('plugin: disposal unregisters every resource')
  } finally {
    fake.runCleanup()
    if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfileDir
  }
}

/** Entry point: run every group, then clean up the temporary directory. */
async function main() {
  rmSync(tmpRoot, { recursive: true, force: true })
  mkdirSync(tmpRoot, { recursive: true })
  try {
    await testStore()
    await testSsh()
    await testPlugin()
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
  assert.equal(existsSync(tmpRoot), false, 'temporary .smoke-tmp directory was not cleaned up')
  console.log('SMOKE OK')
}

main().catch((error) => {
  console.error('SMOKE FAILED')
  console.error(error)
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  process.exitCode = 1
})
