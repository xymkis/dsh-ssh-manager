/**
 * Persistent store for SSH server connection profiles.
 *
 * Records live in one JSON file inside the plugin data directory and contain
 * credentials, so every public projection in this module (`list`, `get`,
 * `find`, `toView`) deliberately omits `password`, `privateKey` and
 * `passphrase`; only `getSecretRecord` returns the full record and callers must
 * keep that value host-side.
 *
 * Writes are atomic (`servers.json.tmp` then rename) and serialized through a
 * promise chain. A corrupt data file is moved aside to
 * `servers.json.corrupt-<ts>` and the store starts empty instead of crashing
 * the plugin tree.
 *
 * @module host/store
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** File holding the persisted records. */
const DATA_FILE = 'servers.json'
/** Maximum accepted `note` length. */
const NOTE_MAX_LENGTH = 500
/** Default SSH port. */
const DEFAULT_PORT = 22
/** Persisted authentication types. */
const AUTH_TYPES = new Set(['password', 'key'])

/**
 * Build one error carrying a stable machine-readable `code`.
 * @param {string} code - machine-readable error code.
 * @param {string} message - human-readable (Chinese) message.
 * @returns {Error & { code: string }} the tagged error.
 */
function taggedError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

/** @returns {Error} an invalid-input error. */
function invalid(message) {
  return taggedError('invalid-input', message)
}

/** @returns {Error} a conflict error. */
function conflict(message) {
  return taggedError('conflict', message)
}

/** @returns {Error} a not-found error. */
function notFound(message) {
  return taggedError('not-found', message)
}

/** @returns {Error} a storage error. */
function storageError(cause) {
  return taggedError('storage', '无法保存服务器配置', cause)
}

/**
 * Resolve the data directory, first match wins:
 * explicit option, `DSH_PROFILE_DIR`, `DSH_HOME`, `~/.dsh`.
 * @param {object} options - store options.
 * @param {string} [options.dir] - explicit directory override (used by tests).
 * @returns {string} absolute data directory.
 */
function resolveDataDir(options) {
  if (typeof options.dir === 'string' && options.dir.trim() !== '') return path.resolve(options.dir)
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') return path.join(profileDir, 'data', 'ssh-manager')
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return path.join(home, 'ssh-manager')
  return path.join(homedir(), '.dsh', 'ssh-manager')
}

/** @returns {boolean} whether the value is a plain object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one optional string field.
 * @param {unknown} value - raw input value.
 * @param {string} label - field label used in the error message.
 * @param {boolean} [allowEmpty] - whether an empty string is accepted.
 * @returns {string | undefined} trimmed string, or undefined when absent.
 */
function readString(value, label, allowEmpty = false) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(`${label}格式无效`)
  const trimmed = value.trim()
  if (!allowEmpty && trimmed === '') return undefined
  return trimmed
}

/**
 * Normalize the port field.
 * @param {unknown} value - raw port.
 * @returns {number} integer port in 1..65535.
 */
function readPort(value) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    throw invalid('端口必须是 1-65535 之间的整数')
  }
  if (numeric < 1 || numeric > 65535) throw invalid('端口必须是 1-65535 之间的整数')
  return numeric
}

/**
 * Normalize the authentication type.
 * @param {unknown} value - raw auth type.
 * @returns {'password' | 'key'} the normalized auth type.
 */
function readAuthType(value) {
  if (typeof value !== 'string' || !AUTH_TYPES.has(value)) throw invalid('认证方式必须是 password 或 key')
  return value
}

/**
 * Resolve the credentials of a draft against the stored record.
 *
 * `undefined` and `''` mean "keep the stored secret"; only a non-empty string
 * replaces it. Changing `authType` requires a matching new secret because the
 * old one belongs to the previous authentication method.
 *
 * @param {object} draft - incoming create/update/test draft.
 * @param {object | undefined} existing - stored record when updating.
 * @param {'password' | 'key'} authType - resolved auth type.
 * @returns {{ password?: string, privateKey?: string, passphrase?: string }} resolved secrets.
 */
function resolveSecret(draft, existing, authType) {
  const keepPassword = existing && existing.authType === 'password' ? existing.password : undefined
  const keepKey = existing && existing.authType === 'key' ? existing.privateKey : undefined
  const keepPassphrase = existing && existing.authType === 'key' ? existing.passphrase : undefined

  if (authType === 'password') {
    const raw = draft.password
    let password
    if (raw === undefined || raw === '') password = keepPassword
    else if (typeof raw === 'string') password = raw
    else throw invalid('密码格式无效')
    if (typeof password !== 'string' || password.length === 0) {
      if (existing && existing.authType !== 'password') throw invalid('切换认证方式需要提供新的密码')
      throw invalid('密码认证需要填写密码')
    }
    return { password }
  }

  const rawKey = draft.privateKey
  let privateKey
  if (rawKey === undefined || rawKey === '') privateKey = keepKey
  else if (typeof rawKey === 'string') privateKey = rawKey
  else throw invalid('私钥格式无效')
  if (typeof privateKey !== 'string' || privateKey.length === 0) {
    if (existing && existing.authType !== 'key') throw invalid('切换认证方式需要提供新的私钥')
    throw invalid('私钥认证需要填写私钥')
  }

  const resolved = { privateKey }
  const rawPassphrase = draft.passphrase
  if (rawPassphrase === undefined) {
    if (typeof keepPassphrase === 'string' && keepPassphrase.length > 0) resolved.passphrase = keepPassphrase
  } else if (rawPassphrase === '') {
    // Empty explicitly clears a stored passphrase.
  } else if (typeof rawPassphrase === 'string') {
    resolved.passphrase = rawPassphrase
  } else {
    throw invalid('私钥口令格式无效')
  }
  return resolved
}

/**
 * Pick the incoming draft value, falling back to the stored value when the
 * draft field is absent or null.
 * @param {object} draft - incoming draft.
 * @param {string} key - field name.
 * @param {object | undefined} existing - stored record.
 * @returns {unknown} the effective raw value.
 */
function pick(draft, key, existing) {
  const value = draft[key]
  if (value !== undefined && value !== null) return value
  if (existing === undefined) return undefined
  return existing[key]
}

/**
 * Build a complete internal record from a draft, optionally merging a stored
 * record for updates and connection tests.
 *
 * @param {object} draft - incoming create/update/test draft.
 * @param {object | undefined} existing - stored record when updating.
 * @returns {object} the complete record (still contains credentials).
 */
function buildRecord(draft, existing) {
  if (!isObject(draft)) throw invalid('请求内容无效')

  const host = readString(pick(draft, 'host', existing), '主机地址')
  if (host === undefined) throw invalid('主机地址不能为空')
  if (/\s/.test(host)) throw invalid('主机地址不能包含空白字符')

  const username = readString(pick(draft, 'username', existing), '用户名')
  if (username === undefined) throw invalid('用户名不能为空')

  const rawPort = pick(draft, 'port', existing)
  const port = readPort(rawPort === undefined ? DEFAULT_PORT : rawPort)
  const authType = readAuthType(pick(draft, 'authType', existing))

  let name
  if (draft.name === undefined || draft.name === null) {
    name = existing && typeof existing.name === 'string' ? existing.name : `${username}@${host}`
  } else {
    const trimmed = readString(draft.name, '服务器名称', true)
    name = trimmed === '' || trimmed === undefined
      ? (existing && typeof existing.name === 'string' ? existing.name : `${username}@${host}`)
      : trimmed
  }
  if (!name) throw invalid('服务器名称不能为空')

  let note
  const rawNote = pick(draft, 'note', existing)
  if (rawNote !== undefined) {
    if (typeof rawNote !== 'string') throw invalid('备注格式无效')
    note = rawNote.trim()
    if (note.length > NOTE_MAX_LENGTH) throw invalid(`备注最多 ${NOTE_MAX_LENGTH} 个字符`)
  }

  const now = new Date().toISOString()
  const record = {
    id: existing && typeof existing.id === 'string' ? existing.id : randomUUID(),
    name,
    host,
    port,
    username,
    authType,
    ...resolveSecret(draft, existing, authType),
    createdAt: existing && typeof existing.createdAt === 'string' ? existing.createdAt : now,
    updatedAt: now,
  }
  if (note !== undefined && note !== '') record.note = note

  return record
}

/**
 * Project one internal record to its public, secret-free view.
 * @param {object} record - internal record.
 * @returns {{ id: string, name: string, host: string, port: number, username: string, authType: string, hasPassword: boolean, hasKey: boolean, note?: string, createdAt: string, updatedAt: string } | undefined} public view.
 */
function toView(record) {
  if (!isObject(record)) return undefined
  const view = {
    id: String(record.id ?? ''),
    name: typeof record.name === 'string' ? record.name : '',
    host: typeof record.host === 'string' ? record.host : '',
    port: Number.isInteger(record.port) ? record.port : DEFAULT_PORT,
    username: typeof record.username === 'string' ? record.username : '',
    authType: record.authType === 'key' ? 'key' : 'password',
    hasPassword: typeof record.password === 'string' && record.password.length > 0,
    hasKey: typeof record.privateKey === 'string' && record.privateKey.length > 0,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
  if (typeof record.note === 'string' && record.note.length > 0) view.note = record.note
  return view
}

/**
 * Whether one parsed array entry is a usable persisted record.
 * @param {unknown} entry - parsed entry.
 * @returns {boolean} validity.
 */
function isPersistedRecord(entry) {
  if (!isObject(entry)) return false
  if (typeof entry.id !== 'string' || entry.id === '') return false
  if (typeof entry.name !== 'string' || entry.name === '') return false
  if (typeof entry.host !== 'string' || entry.host === '') return false
  if (typeof entry.username !== 'string' || entry.username === '') return false
  if (!AUTH_TYPES.has(entry.authType)) return false
  if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) return false
  return true
}

/**
 * Keep only known fields of a persisted record so malformed extras never
 * reach the public projections.
 * @param {object} entry - parsed record.
 * @returns {object} sanitized record.
 */
function sanitizePersisted(entry) {
  const record = {
    id: entry.id,
    name: entry.name,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    authType: entry.authType,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
  }
  if (entry.authType === 'password' && typeof entry.password === 'string') record.password = entry.password
  if (entry.authType === 'key' && typeof entry.privateKey === 'string') record.privateKey = entry.privateKey
  if (entry.authType === 'key' && typeof entry.passphrase === 'string' && entry.passphrase.length > 0) record.passphrase = entry.passphrase
  if (typeof entry.note === 'string' && entry.note.length > 0) record.note = entry.note
  return record
}

/**
 * Create the SSH server store.
 *
 * @param {{ dir?: string }} [options] - `dir` overrides the resolved data directory (tests).
 * @returns {object} store API (see CONTRACT.md): `dataDir`, `load`, `list`, `get`,
 *   `find`, `getSecretRecord`, `create`, `update`, `remove`, `testDraft`, `toView`.
 */
export function createStore(options = {}) {
  const dir = resolveDataDir(options)
  const filePath = path.join(dir, DATA_FILE)

  /** @type {object[]} internal records (may contain credentials). */
  let records = []
  let loaded = false
  /** @type {Promise<void>} tail of the serialized write chain. */
  let writeTail = Promise.resolve()

  /** Move the unreadable data file aside and start from an empty list. */
  function quarantineFile() {
    const backup = `${filePath}.corrupt-${Date.now()}`
    try {
      renameSync(filePath, backup)
    } catch {
      try {
        copyFileSync(filePath, backup)
      } catch {
        /* best effort: a locked file still leaves the in-memory store empty */
      }
    }
  }

  /** Read the data file once; never throws. */
  function load() {
    if (loaded) return
    loaded = true
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* the directory is created again on the next write */
    }
    let text
    try {
      text = readFileSync(filePath, 'utf8')
    } catch (error) {
      if (!error || error.code !== 'ENOENT') quarantineFile()
      records = []
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      quarantineFile()
      records = []
      return
    }
    if (!Array.isArray(parsed)) {
      quarantineFile()
      records = []
      return
    }
    const valid = []
    let dropped = 0
    for (const entry of parsed) {
      if (isPersistedRecord(entry)) valid.push(sanitizePersisted(entry))
      else dropped += 1
    }
    if (dropped > 0) quarantineFile()
    records = valid
  }

  /** Ensure the lazy read happened before any operation. */
  function ensureLoaded() {
    if (!loaded) load()
  }

  /** @returns {object | undefined} internal record by id. */
  function rawById(id) {
    if (typeof id !== 'string' || id === '') return undefined
    return records.find((record) => record.id === id)
  }

  /**
   * Reject a display name already used by another record (case-insensitive).
   * @param {string} name - candidate name.
   * @param {string} selfId - id of the record being written.
   * @throws {Error} conflict when another record owns the name.
   */
  function assertNameAvailable(name, selfId) {
    const wanted = name.toLowerCase()
    const clash = records.find((candidate) => candidate.id !== selfId && typeof candidate.name === 'string' && candidate.name.toLowerCase() === wanted)
    if (clash) throw conflict('服务器名称已存在')
  }

  /** Serialize one atomic write of the current in-memory state. */
  function persist() {
    const snapshot = records.map((record) => ({ ...record }))
    const task = writeTail.then(async () => {
      await mkdir(dir, { recursive: true })
      const tmpPath = `${filePath}.tmp`
      await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await chmod(tmpPath, 0o600).catch(() => {})
      await rename(tmpPath, filePath)
      await chmod(filePath, 0o600).catch(() => {})
    })
    writeTail = task.then(() => {}, () => {})
    return task
  }

  /**
   * @returns {string} resolved data directory.
   */
  function dataDir() {
    return dir
  }

  /**
   * @returns {object[]} public views sorted by display name.
   */
  function list() {
    ensureLoaded()
    return records
      .slice()
      .sort((left, right) => String(left.name).localeCompare(String(right.name)))
      .map((record) => toView(record))
  }

  /**
   * @param {string} id - record id.
   * @returns {object | undefined} public view.
   */
  function get(id) {
    ensureLoaded()
    return toView(rawById(id))
  }

  /**
   * Resolve a server by id, then exact name (case-insensitive), then the exact
   * host/IP (case-insensitive), then a unique name prefix (case-insensitive).
   * The host match makes a chat reference like `/192.168.10.81` or a raw IP
   * resolvable by the agent without knowing the configured display name.
   * @param {string} query - id, name, host/IP, or a name prefix.
   * @returns {object | undefined} public view.
   */
  function find(query) {
    ensureLoaded()
    if (typeof query !== 'string') return undefined
    const text = query.trim()
    if (text === '') return undefined
    const byId = records.find((record) => record.id === text)
    if (byId) return toView(byId)
    const lower = text.toLowerCase()
    const byName = records.find((record) => typeof record.name === 'string' && record.name.toLowerCase() === lower)
    if (byName) return toView(byName)
    const byHost = records.find((record) => typeof record.host === 'string' && record.host.toLowerCase() === lower)
    if (byHost) return toView(byHost)
    const byPrefix = records.filter((record) => typeof record.name === 'string' && record.name.toLowerCase().startsWith(lower))
    if (byPrefix.length === 1) return toView(byPrefix[0])
    return undefined
  }

  /**
   * Host-only access to the full record including credentials.
   * @param {string} id - record id.
   * @returns {object | undefined} a shallow copy of the internal record.
   */
  function getSecretRecord(id) {
    ensureLoaded()
    const record = rawById(id)
    return record === undefined ? undefined : { ...record }
  }

  /**
   * Create a server.
   * @param {object} draft - create payload.
   * @returns {Promise<object>} public view of the created server.
   */
  async function create(draft) {
    ensureLoaded()
    const record = buildRecord(draft, undefined)
    assertNameAvailable(record.name, record.id)
    records.push(record)
    try {
      await persist()
    } catch (error) {
      records = records.filter((candidate) => candidate.id !== record.id)
      throw storageError(error)
    }
    return toView(record)
  }

  /**
   * Update a server. `undefined`/`''` secrets keep the stored credential.
   * @param {string} id - record id.
   * @param {object} patch - update payload.
   * @returns {Promise<object>} public view of the updated server.
   */
  async function update(id, patch) {
    ensureLoaded()
    const existing = rawById(id)
    if (!existing) throw notFound('服务器不存在')
    const updated = buildRecord(isObject(patch) ? patch : {}, existing)
    assertNameAvailable(updated.name, existing.id)
    const previous = records
    records = records.map((record) => (record.id === id ? updated : record))
    try {
      await persist()
    } catch (error) {
      records = previous
      throw storageError(error)
    }
    return toView(updated)
  }

  /**
   * Remove a server.
   * @param {string} id - record id.
   * @returns {Promise<boolean>} whether a record was removed.
   */
  async function remove(id) {
    ensureLoaded()
    const existing = rawById(id)
    if (!existing) return false
    const previous = records
    records = records.filter((record) => record.id !== id)
    try {
      await persist()
    } catch (error) {
      records = previous
      throw storageError(error)
    }
    return true
  }

  /**
   * Validate a draft for a connection test without persisting it, merging the
   * stored secret when `draft.id` points at an existing record.
   * @param {object} draft - draft payload.
   * @returns {Promise<object>} complete record (contains credentials; host-only).
   */
  async function testDraft(draft) {
    ensureLoaded()
    if (!isObject(draft)) throw invalid('请求内容无效')
    let existing
    if (draft.id !== undefined && draft.id !== null && draft.id !== '') {
      if (typeof draft.id !== 'string') throw invalid('服务器 id 格式无效')
      existing = rawById(draft.id)
      if (!existing) throw notFound('服务器不存在')
    }
    return buildRecord(draft, existing)
  }

  return { dataDir, load, list, get, find, getSecretRecord, create, update, remove, testDraft, toView }
}
