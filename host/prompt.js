/**
 * System-prompt section for dsh-ssh-manager.
 *
 * The section is refreshed on every prompt assembly from the live store, so the
 * model sees the servers the user has configured right now. It only reads the
 * public views, which contain no credentials.
 *
 * @module host/prompt
 */

/** Unique prompt section name. */
const SECTION_NAME = 'ssh-manager:servers'
/** Section order: after the core context, before most feature sections. */
const SECTION_ORDER = 40
/** Text used when no server is configured. */
const EMPTY_TEXT = 'No SSH servers are configured. The user can add Linux servers in Settings → SSH Servers; once a server exists, use the `ssh_servers` tool to list or test it and `ssh_exec` to run commands on it.'

/**
 * Make one user-controlled text value safe to embed in a single Markdown line.
 * @param {unknown} value - raw value.
 * @returns {string} one-line text.
 */
function singleLine(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Build the section text from the current store contents.
 * @param {object} store - server store.
 * @returns {string} prompt text.
 */
function buildText(store) {
  let servers
  try {
    servers = store.list()
  } catch {
    servers = []
  }
  if (!Array.isArray(servers) || servers.length === 0) return EMPTY_TEXT

  const lines = [
    '## SSH servers',
    '',
    'The user has configured these Linux SSH servers. Use the `ssh_servers` tool to list them or test connectivity, and `ssh_exec` to run a shell command on one of them. Credentials are never shown; identify a server by its name.',
    '',
  ]
  for (const server of servers) {
    const name = singleLine(server && server.name)
    const username = singleLine(server && server.username)
    const host = singleLine(server && server.host)
    const port = typeof (server && server.port) === 'number' ? server.port : 22
    const auth = server && server.authType === 'key' ? 'private key auth' : 'password auth'
    lines.push(`- ${name} — ${username}@${host}:${port} (${auth})`)
  }
  return lines.join('\n')
}

/**
 * Register the `## SSH servers` system-prompt section.
 * @param {object} ctx - host plugin context (`systemPrompt` service).
 * @param {{ store: object }} services - server store.
 * @returns {() => void} section disposer.
 */
export function registerPromptSection(ctx, { store }) {
  if (!ctx || !ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') {
    throw new Error('dsh-ssh-manager: systemPrompt service is unavailable')
  }
  return ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: () => buildText(store),
  })
}
