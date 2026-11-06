/**
 * HTTP API for the dsh-ssh-manager Settings section.
 *
 * One prefix route, `/ssh-manager/api`, answers `POST /ssh-manager/api/<method>`
 * with a JSON body and a JSON envelope: `{ ok: true, data }` on success and
 * `{ ok: false, error: { code, message } }` on failure. Requests are fenced by
 * `ctx.connection.requestRejection`, the body is bounded to 1 MiB, and no
 * handler ever returns a password, private key, or passphrase.
 *
 * @module host/api
 */

/** Route prefix owned by this plugin. */
const API_PREFIX = '/ssh-manager/api'
/** Maximum accepted JSON body size (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024
/** Message shown for unexpected internal failures. */
const INTERNAL_MESSAGE = '服务器内部错误'

/**
 * Create one tagged error.
 * @param {string} code - machine-readable error code.
 * @param {string} message - friendly Chinese message.
 * @returns {Error & { code: string }} tagged error.
 */
function apiError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** @returns {boolean} whether the value is a plain object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether the response is still writable.
 * @param {object} res - ServerResponse-like object.
 * @returns {boolean} writability.
 */
function canWrite(res) {
  if (!res || typeof res !== 'object') return false
  if (res.headersSent === true || res.writableEnded === true || res.destroyed === true) return false
  return typeof res.writeHead === 'function' && typeof res.end === 'function'
}

/**
 * Write one JSON response, tolerating a client that already went away.
 * @param {object} res - ServerResponse-like object.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 */
function writeJson(res, status, body) {
  if (!canWrite(res)) {
    try {
      res.destroy?.()
    } catch {
      /* nothing left to release */
    }
    return
  }
  let payload
  try {
    payload = JSON.stringify(body)
  } catch {
    payload = JSON.stringify({ ok: false, error: { code: 'internal', message: INTERNAL_MESSAGE } })
    status = 500
  }
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(payload)
  } catch {
    try {
      res.destroy?.()
    } catch {
      /* response already gone */
    }
  }
}

/**
 * Write the success envelope.
 * @param {object} res - response.
 * @param {object} data - payload.
 */
function writeOk(res, data) {
  writeJson(res, 200, { ok: true, data })
}

/**
 * Write the failure envelope.
 * @param {object} res - response.
 * @param {number} status - HTTP status.
 * @param {string} code - machine-readable error code.
 * @param {string} message - friendly Chinese message.
 */
function writeFail(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/**
 * Map one thrown value to the API failure envelope.
 * @param {object} ctx - host plugin context (logger is optional).
 * @param {object} res - response.
 * @param {unknown} error - thrown value.
 */
function writeError(ctx, res, error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  const message = error && typeof error.message === 'string' ? error.message : ''
  if (code === 'invalid-input') return writeFail(res, 400, code, message || '请求参数无效')
  if (code === 'bad-request') return writeFail(res, 400, code, message || '请求格式无效')
  if (code === 'conflict') return writeFail(res, 409, code, message || '请求存在冲突')
  if (code === 'not-found') return writeFail(res, 404, code, message || '资源不存在')
  try {
    ctx?.logger?.warn?.(`dsh-ssh-manager: API request failed${message ? `: ${message}` : ''}`)
  } catch {
    /* logging is best effort */
  }
  return writeFail(res, 500, 'internal', INTERNAL_MESSAGE)
}

/**
 * Read and parse the bounded JSON request body.
 * @param {object} req - IncomingMessage-like async iterable.
 * @returns {Promise<object>} parsed body (`{}` for an empty body).
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw apiError('bad-request', '请求体超过 1 MiB 限制')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw apiError('bad-request', '请求体不是有效的 JSON')
  }
  if (!isObject(parsed)) throw apiError('bad-request', '请求体必须是 JSON 对象')
  return parsed
}

/**
 * Require a non-empty `id` field.
 * @param {object} body - request body.
 * @returns {string} the id.
 */
function requireId(body) {
  const id = body && typeof body === 'object' ? body.id : undefined
  if (typeof id !== 'string' || id.trim() === '') throw apiError('invalid-input', '缺少服务器 id')
  return id.trim()
}

/**
 * Run a connectivity test without ever failing the API call for a reachable
 * failure: a failed connection is a successful response with `success: false`.
 * @param {object} ssh - ssh client.
 * @param {object} record - full record including credentials.
 * @returns {Promise<{ success: boolean, latencyMs: number, message: string, output?: string }>} test result.
 */
async function runConnectionTest(ssh, record) {
  const startedAt = Date.now()
  try {
    const probed = await ssh.probe(record)
    return {
      success: true,
      latencyMs: typeof probed.latencyMs === 'number' ? probed.latencyMs : Date.now() - startedAt,
      message: '连接成功',
      output: typeof probed.output === 'string' ? probed.output : '',
    }
  } catch (error) {
    const message = error && typeof error.message === 'string' && error.message !== '' ? error.message : '连接失败'
    return { success: false, latencyMs: Date.now() - startedAt, message }
  }
}

/**
 * Build the method table over the store and ssh client.
 * @param {object} store - server store.
 * @param {object} ssh - ssh client.
 * @returns {Record<string, (body: object) => Promise<object>>} method handlers.
 */
function createMethods(store, ssh) {
  return {
    /** @returns {Promise<{ servers: object[] }>} configured servers. */
    async list() {
      return { servers: store.list() }
    },
    /** @param {object} body - `{ id }`. @returns {Promise<{ server: object }>} one server. */
    async get(body) {
      const id = requireId(body)
      const server = store.get(id)
      if (!server) throw apiError('not-found', '服务器不存在')
      return { server }
    },
    /** @param {object} body - save payload. @returns {Promise<{ server: object }>} saved server. */
    async save(body) {
      const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : ''
      if (id === '') return { server: await store.create(body) }
      return { server: await store.update(id, body) }
    },
    /** @param {object} body - `{ id }`. @returns {Promise<{ deleted: true }>} deletion marker. */
    async delete(body) {
      const id = requireId(body)
      const deleted = await store.remove(id)
      if (!deleted) throw apiError('not-found', '服务器不存在')
      return { deleted: true }
    },
    /** @param {object} body - `{ id }`. @returns {Promise<object>} connectivity test result. */
    async test(body) {
      const id = requireId(body)
      const record = store.getSecretRecord(id)
      if (!record) throw apiError('not-found', '服务器不存在')
      return runConnectionTest(ssh, record)
    },
    /** @param {object} body - draft payload. @returns {Promise<object>} connectivity test result. */
    async 'test-draft'(body) {
      const record = await store.testDraft(body)
      return runConnectionTest(ssh, record)
    },
  }
}

/**
 * Register the `/ssh-manager/api` prefix route.
 * @param {object} ctx - host plugin context (`webServer`, `connection`).
 * @param {{ store: object, ssh: object }} services - store and ssh client.
 * @returns {() => void} route disposer.
 */
export function registerApiRoutes(ctx, { store, ssh }) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new Error('dsh-ssh-manager: webServer service is unavailable')
  }
  const methods = createMethods(store, ssh)

  /**
   * Request handler for the prefix route.
   * @param {object} req - IncomingMessage.
   * @param {object} res - ServerResponse.
   * @returns {Promise<void>} resolves once the response settled.
   */
  async function handle(req, res) {
    let closed = false
    const markClosed = () => {
      closed = true
    }
    try {
      res?.once?.('close', markClosed)
      req?.once?.('error', markClosed)
    } catch {
      /* event registration is best effort */
    }
    try {
      const connection = ctx.connection
      let rejected = true
      try {
        rejected = !connection || typeof connection.requestRejection !== 'function' ? true : connection.requestRejection(req) !== undefined
      } catch {
        rejected = true
      }
      if (rejected) {
        writeFail(res, 403, 'forbidden', '请求被拒绝')
        return
      }
      if (req.method !== 'POST') {
        writeFail(res, 405, 'method-not-allowed', '仅支持 POST 请求')
        return
      }
      let method = ''
      try {
        const pathname = new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://dsh.internal').pathname
        if (pathname.startsWith(`${API_PREFIX}/`)) method = pathname.slice(API_PREFIX.length + 1)
      } catch {
        method = ''
      }
      if (method === '' || method.includes('/')) {
        writeFail(res, 404, 'not-found', '未知的 API 方法')
        return
      }
      const handler = Object.hasOwn(methods, method) ? methods[method] : undefined
      if (typeof handler !== 'function') {
        writeFail(res, 404, 'not-found', `未知的 API 方法 "${method}"`)
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        if (!closed) writeError(ctx, res, error)
        return
      }
      if (closed) return
      try {
        const data = await handler(body)
        if (!closed) writeOk(res, data)
      } catch (error) {
        if (!closed) writeError(ctx, res, error)
      }
    } catch (error) {
      if (!closed) writeError(ctx, res, error)
    } finally {
      try {
        res?.off?.('close', markClosed)
        req?.off?.('error', markClosed)
      } catch {
        /* listener cleanup is best effort */
      }
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle })
}
