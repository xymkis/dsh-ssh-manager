/**
 * Agent tools for dsh-ssh-manager.
 *
 * Two global tools are registered:
 * - `ssh_servers` lists the configured Linux servers or tests connectivity to
 *   one of them;
 * - `ssh_exec` runs a shell command on one configured server and returns
 *   stdout, stderr, and the exit code.
 *
 * Tool results never contain a password, private key, or passphrase: the tools
 * only read public views from the store, and connection errors carry fixed
 * Chinese messages from `host/ssh.js`.
 *
 * @module host/tools
 */

/** Maximum output text length per rendered stream section (cosmetic guard). */
const RENDER_MESSAGE_LIMIT = 4000

/**
 * @param {unknown} error - thrown value.
 * @returns {string} a safe message string.
 */
function errorMessage(error) {
  try {
    if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message
    if (error && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message
  } catch {
    /* fall through */
  }
  return ''
}

/**
 * Clamp a `*_seconds` tool argument to whole seconds.
 * @param {unknown} value - caller value.
 * @param {number} min - minimum seconds.
 * @param {number} max - maximum seconds.
 * @param {number} fallback - default seconds.
 * @returns {number} clamped seconds.
 */
function clampSeconds(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * Coerce a value to display text.
 * @param {unknown} value - raw value.
 * @returns {string} display text ('' for non-strings).
 */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Coerce a value to a display number.
 * @param {unknown} value - raw value.
 * @param {number} fallback - fallback number.
 * @returns {number} display number.
 */
function numberOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Render an auth type for humans.
 * @param {unknown} authType - `'password'` or `'key'`.
 * @returns {string} label.
 */
function authLabel(authType) {
  return authType === 'key' ? 'private key' : 'password'
}

/**
 * Shorten one rendered message so a huge tool payload cannot dominate the
 * conversation.
 * @param {unknown} value - message value.
 * @returns {string} trimmed message.
 */
function limitedText(value) {
  const text = textOf(value)
  if (text.length <= RENDER_MESSAGE_LIMIT) return text
  return `${text.slice(0, RENDER_MESSAGE_LIMIT)}…`
}

/**
 * Wrap one text block into the tool `content` array.
 * @param {string} text - rendered text.
 * @returns {{ type: 'text', text: string }[]} content blocks.
 */
function textContent(text) {
  return [{ type: 'text', text }]
}

/** Public server view schema used by `ssh_servers` output. */
const SERVER_VIEW_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable server id.' },
    name: { type: 'string', description: 'Display name.' },
    host: { type: 'string', description: 'Hostname or IP address.' },
    port: { type: 'number', description: 'SSH port.' },
    username: { type: 'string', description: 'Login user.' },
    authType: { type: 'string', description: 'password or key.' },
    hasPassword: { type: 'boolean', description: 'Whether a password is stored.' },
    hasKey: { type: 'boolean', description: 'Whether a private key is stored.' },
    note: { type: 'string', description: 'Optional user note.' },
    createdAt: { type: 'string', description: 'Creation timestamp (ISO).' },
    updatedAt: { type: 'string', description: 'Update timestamp (ISO).' },
  },
}

/** Output schema of `ssh_servers`. */
const SERVERS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    servers: { type: 'array', items: SERVER_VIEW_SCHEMA, description: 'Configured servers when action=list.' },
    result: {
      type: 'object',
      description: 'Connectivity test result when action=test.',
      properties: {
        server: { type: 'string', description: 'Server display name.' },
        success: { type: 'boolean', description: 'Whether the connection succeeded.' },
        latencyMs: { type: 'number', description: 'Round-trip duration in milliseconds.' },
        message: { type: 'string', description: 'Human-readable outcome.' },
        output: { type: 'string', description: 'Remote uname/user output on success.' },
      },
    },
    message: { type: 'string', description: 'Failure message when the request was not actionable.' },
  },
}

/** Output schema of `ssh_exec`. */
const EXEC_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    server: { type: 'string', description: 'Server display name.' },
    username: { type: 'string', description: 'Login user.' },
    host: { type: 'string', description: 'Hostname or IP address.' },
    port: { type: 'number', description: 'SSH port.' },
    exitCode: {
      description: 'Remote exit code, or null when the command did not complete.',
      oneOf: [{ type: 'number' }, { type: 'null' }],
    },
    durationMs: { type: 'number', description: 'Execution duration in milliseconds.' },
    stdout: { type: 'string', description: 'Captured standard output.' },
    stderr: { type: 'string', description: 'Captured standard error.' },
    truncated: { type: 'boolean', description: 'Whether output capture hit a size limit.' },
    message: { type: 'string', description: 'Failure message when execution did not complete.' },
  },
}

/**
 * Render the result of `ssh_servers`.
 * @param {object} args - tool arguments.
 * @param {object} value - validated tool output.
 * @returns {{ type: 'text', text: string }[]} content blocks.
 */
function renderServers(args, value) {
  try {
    if (value && Array.isArray(value.servers)) {
      const servers = value.servers
      if (servers.length === 0) {
        return textContent('No SSH servers are configured. Add them in Settings → SSH Servers.')
      }
      const lines = [`Configured SSH servers (${servers.length}):`]
      for (const server of servers) {
        const name = textOf(server && server.name)
        const user = textOf(server && server.username)
        const host = textOf(server && server.host)
        const port = numberOf(server && server.port, 22)
        const auth = authLabel(server && server.authType)
        const note = textOf(server && server.note)
        lines.push(`- ${name} — ${user}@${host}:${port} (${auth} auth)${note ? ` — ${note}` : ''}`)
      }
      return textContent(lines.join('\n'))
    }
    if (value && value.result && typeof value.result === 'object') {
      const result = value.result
      const name = textOf(result.server) || 'server'
      if (result.success === true) {
        const header = `Server ${name}: reachable in ${numberOf(result.latencyMs, 0)} ms`
        const output = textOf(result.output)
        return textContent(output ? `${header}\n${output}` : header)
      }
      return textContent(`Server ${name}: connection failed — ${textOf(result.message) || 'unknown error'}`)
    }
    return textContent(limitedText(value && value.message) || 'No SSH servers are available.')
  } catch {
    return textContent('SSH server information is unavailable.')
  }
}

/**
 * Render the result of `ssh_exec`.
 * @param {object} args - tool arguments.
 * @param {object} value - validated tool output.
 * @returns {{ type: 'text', text: string }[]} content blocks.
 */
function renderExec(args, value) {
  try {
    const server = textOf(value && value.server) || 'server'
    const user = textOf(value && value.username)
    const host = textOf(value && value.host)
    const port = numberOf(value && value.port, 22)
    const target = user !== '' && host !== '' ? ` (${user}@${host}:${port})` : ''
    const lines = [`server: ${server}${target}`]
    const exitCode = value ? value.exitCode : null
    if (typeof exitCode !== 'number') {
      const message = limitedText(value && value.message)
      if (message) {
        lines.push(`failed: ${message}`)
        return textContent(lines.join('\n'))
      }
      lines.push('exit: unknown')
    } else {
      lines.push(`exit: ${exitCode} · ${numberOf(value && value.durationMs, 0)}ms`)
    }
    const marker = value && value.truncated === true ? '[truncated]\n' : ''
    const stdout = textOf(value && value.stdout)
    const stderr = textOf(value && value.stderr)
    lines.push('--- stdout ---', `${marker}${stdout === '' ? '(empty)' : stdout}`)
    lines.push('--- stderr ---', `${marker}${stderr === '' ? '(empty)' : stderr}`)
    return textContent(lines.join('\n'))
  } catch {
    return textContent('SSH command result is unavailable.')
  }
}

/**
 * Build the `ssh_servers` tool definition.
 * @param {object} store - server store.
 * @param {object} ssh - ssh client.
 * @returns {object} tool definition.
 */
function serversTool(store, ssh) {
  return {
    name: 'ssh_servers',
    description: 'List the Linux SSH servers configured in DeepSeek Harness, or test connectivity to one of them. Use action="list" to discover the available server names before calling ssh_exec, and action="test" with a server id, name, or host/IP to verify that the saved credentials and the network path still work. Credentials are never returned; the test reports the remote uname/user output on success.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'test'],
          description: 'list = show configured servers (no credentials); test = verify connectivity to one server',
        },
        server: {
          type: 'string',
          description: 'Server id, name, or host/IP; required for action=test',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Connectivity test timeout in seconds (1-120, default 20)',
        },
      },
      required: ['action'],
    },
    output: { schema: SERVERS_OUTPUT_SCHEMA, render: renderServers },
    presentCall: (args) => ({
      card: 'generic',
      title: args && args.action === 'test' ? `Test SSH server ${textOf(args.server) || ''}`.trim() : 'List SSH servers',
      kind: 'other',
    }),
    /**
     * @param {object} args - tool arguments.
     * @returns {Promise<object>} JSON-safe tool result.
     */
    async execute(args) {
      try {
        const action = args && typeof args.action === 'string' ? args.action : ''
        if (action === 'list') {
          try {
            return { servers: store.list() }
          } catch (error) {
            return { message: errorMessage(error) || '读取服务器列表失败' }
          }
        }
        if (action === 'test') {
          const query = args && typeof args.server === 'string' ? args.server.trim() : ''
          if (query === '') return { message: '缺少服务器参数：请提供要测试的服务器 id 或名称' }
          let view
          try {
            view = store.find(query)
          } catch {
            view = undefined
          }
          if (!view) return { message: `未找到服务器 "${query}"，可以先使用 ssh_servers 的 list 操作查看已配置的服务器` }
          let record
          try {
            record = store.getSecretRecord(view.id)
          } catch {
            record = undefined
          }
          if (!record) return { message: `无法读取服务器 "${view.name}" 的连接凭据` }
          const seconds = clampSeconds(args && args.timeout_seconds, 1, 120, 20)
          const startedAt = Date.now()
          try {
            const probed = await ssh.probe(record, { timeoutMs: seconds * 1000 })
            return {
              result: {
                server: view.name,
                success: true,
                latencyMs: typeof probed.latencyMs === 'number' ? probed.latencyMs : Date.now() - startedAt,
                message: '连接成功',
                output: textOf(probed.output),
              },
            }
          } catch (error) {
            return {
              result: {
                server: view.name,
                success: false,
                latencyMs: Date.now() - startedAt,
                message: errorMessage(error) || '连接失败',
              },
            }
          }
        }
        return { message: `不支持的操作 "${textOf(action)}"：仅支持 list 或 test` }
      } catch (error) {
        return { message: errorMessage(error) || '操作失败' }
      }
    },
  }
}

/**
 * Build the `ssh_exec` tool definition.
 * @param {object} store - server store.
 * @param {object} ssh - ssh client.
 * @returns {object} tool definition.
 */
function execTool(store, ssh) {
  /**
   * Build one failure value shaped like a successful output.
   * @param {string} server - server label.
   * @param {string} message - failure message.
   * @param {object} [view] - public view when the server was resolved.
   * @returns {object} JSON-safe failure value.
   */
  function failure(server, message, view) {
    const value = { server, exitCode: null, stdout: '', stderr: '', message }
    if (view) {
      value.username = textOf(view.username)
      value.host = textOf(view.host)
      value.port = numberOf(view.port, 22)
    }
    return value
  }

  return {
    name: 'ssh_exec',
    description: 'Run a shell command over SSH on a configured Linux server and return stdout, stderr, and the exit code. Use ssh_servers(action="list") first to discover the configured server names. The command runs in a non-interactive shell, so avoid programs that wait for interactive input; prefer single-line commands or `bash -lc "..."`.',
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'Server id, name, or host/IP from ssh_servers (a chat reference like /192.168.10.81 also works)',
        },
        command: {
          type: 'string',
          description: 'Shell command to run remotely',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Command timeout in seconds (1-600, default 60)',
        },
      },
      required: ['server', 'command'],
    },
    output: { schema: EXEC_OUTPUT_SCHEMA, render: renderExec },
    presentCall: (args) => ({
      card: 'generic',
      title: `Run command on ${textOf(args && args.server) || 'server'}`,
      kind: 'other',
    }),
    isConcurrencySafe: () => true,
    /**
     * @param {object} args - tool arguments.
     * @returns {Promise<object>} JSON-safe tool result (never throws).
     */
    async execute(args) {
      const query = args && typeof args.server === 'string' ? args.server.trim() : ''
      const command = args && typeof args.command === 'string' ? args.command : ''
      try {
        if (query === '') return failure('', '缺少服务器参数：请提供服务器 id 或名称')
        if (command.trim() === '') return failure(query, '命令不能为空')
        const view = store.find(query)
        if (!view) return failure(query, `未找到服务器 "${query}"，可以先使用 ssh_servers 的 list 操作查看已配置的服务器`)
        const record = store.getSecretRecord(view.id)
        if (!record) return failure(view.name, `无法读取服务器 "${view.name}" 的连接凭据`, view)
        const seconds = clampSeconds(args && args.timeout_seconds, 1, 600, 60)
        try {
          const result = await ssh.exec(record, command, { timeoutMs: seconds * 1000 })
          return {
            server: view.name,
            username: view.username,
            host: view.host,
            port: view.port,
            exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
            durationMs: numberOf(result.durationMs, 0),
            stdout: textOf(result.stdout),
            stderr: textOf(result.stderr),
            truncated: result.truncated === true,
          }
        } catch (error) {
          return failure(view.name, errorMessage(error) || '命令执行失败', view)
        }
      } catch (error) {
        return failure(query, errorMessage(error) || '命令执行失败')
      }
    },
  }
}

/**
 * Register the two global agent tools.
 * @param {object} ctx - host plugin context (`tools` service).
 * @param {{ store: object, ssh: object }} services - store and ssh client.
 * @returns {(() => void)[]} tool disposers (one per successfully registered tool).
 */
export function registerTools(ctx, { store, ssh }) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('dsh-ssh-manager: tools service is unavailable')
  }
  const disposers = []
  const definitions = [serversTool(store, ssh), execTool(store, ssh)]
  for (const definition of definitions) {
    try {
      const disposer = ctx.tools.register(definition)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      try {
        ctx?.logger?.warn?.(`dsh-ssh-manager: failed to register tool "${definition.name}": ${errorMessage(error)}`)
      } catch {
        /* logging is best effort */
      }
    }
  }
  return disposers
}
