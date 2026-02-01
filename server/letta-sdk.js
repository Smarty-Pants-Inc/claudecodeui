/**
 * Letta Code SDK Integration
 *
 * This provider mirrors the structure of server/claude-sdk.js, but uses
 * @letta-ai/letta-code-sdk to drive a Letta Code session.
 *
 * Transport: the parent server passes a WebSocketWriter-like object (`ws`) with:
 *   - ws.send(obj)
 *   - optional ws.setSessionId(sessionId)
 *
 * Frontend contract (CloudCLI):
 *   - client sends: { type: 'letta-command', command, options }
 *   - server streams: { type: 'letta-response', data, sessionId }
 *   - server completion: { type: 'letta-complete', sessionId, exitCode }
 *   - server error: { type: 'letta-error', error, sessionId }
 *
 * For tool approvals we intentionally reuse the existing Claude approval UI:
 *   - emit: { type: 'claude-permission-request', requestId, toolName, input, sessionId }
 *   - expect response: { type: 'claude-permission-response', requestId, allow, ... }
 */

import crypto from 'crypto';

import { createSession } from '@letta-ai/letta-code-sdk';

// Active Letta sessions keyed by agentId.
const activeSessions = new Map();

// Pending tool approvals keyed by requestId.
const pendingToolApprovals = new Map();

const TOOL_APPROVAL_TIMEOUT_MS =
  parseInt(process.env.LETTA_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return `letta_${crypto.randomUUID()}`;
  }
  return `letta_${crypto.randomBytes(16).toString('hex')}`;
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, onCancel } = options;
  return new Promise((resolve) => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      pendingToolApprovals.delete(requestId);
      clearTimeout(timeout);
      resolve(decision);
    };

    const timeout = setTimeout(() => {
      onCancel?.('timeout');
      finalize(null);
    }, timeoutMs);

    pendingToolApprovals.set(requestId, (decision) => finalize(decision));
  });
}

export function resolveLettaToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }
  if (entry === toolName) {
    return true;
  }

  // Support Bash(prefix:*) shorthand used by this UI.
  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';
    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }
    return command ? command.startsWith(allowedPrefix) : false;
  }
  return false;
}

function normalizeCwd(options = {}) {
  return options.cwd || options.projectPath || process.cwd();
}

function normalizeToolsSettings(options = {}) {
  const toolsSettings = options.toolsSettings || {};
  return {
    allowedTools: Array.isArray(toolsSettings.allowedTools) ? toolsSettings.allowedTools : [],
    disallowedTools: Array.isArray(toolsSettings.disallowedTools)
      ? toolsSettings.disallowedTools
      : [],
    skipPermissions: Boolean(toolsSettings.skipPermissions),
  };
}

function emit(ws, payload) {
  try {
    ws.send(payload);
  } catch {
    // ignore
  }
}

export function isLettaSDKSessionActive(agentId) {
  return activeSessions.has(agentId);
}

export function getActiveLettaSDKSessions() {
  return Array.from(activeSessions.keys());
}

export async function abortLettaSDKSession(agentId) {
  const entry = activeSessions.get(agentId);
  if (!entry) return false;

  try {
    await entry.session.abort();
  } catch {
    // ignore
  }
  try {
    entry.session.close?.();
  } catch {
    // ignore
  }

  activeSessions.delete(agentId);
  return true;
}

// Main entry point used by server/index.js
export async function queryLettaSDK(command, options = {}, ws) {
  const cwd = normalizeCwd(options);
  const permissionMode = options.permissionMode || 'default';
  const toolsSettings = normalizeToolsSettings(options);

  // In this integration we treat sessionId as the Letta agentId.
  const requestedAgentId = options.sessionId || null;

  // Create or resume session.
  const session = createSession(requestedAgentId || undefined, {
    cwd,
    permissionMode,
    canUseTool: async (toolName, input) => {
      // Allow everything when explicitly bypassing.
      if (permissionMode === 'bypassPermissions' || toolsSettings.skipPermissions) {
        return { behavior: 'allow', updatedInput: null };
      }

      const isDisallowed = toolsSettings.disallowedTools.some((entry) =>
        matchesToolPermission(entry, toolName, input),
      );
      if (isDisallowed) {
        return { behavior: 'deny', message: 'Tool disallowed by settings' };
      }

      const isAllowed = toolsSettings.allowedTools.some((entry) =>
        matchesToolPermission(entry, toolName, input),
      );
      if (isAllowed) {
        return { behavior: 'allow', updatedInput: null };
      }

      const requestId = createRequestId();
      emit(ws, {
        type: 'claude-permission-request',
        provider: 'letta',
        requestId,
        toolName,
        input,
        sessionId: agentId || requestedAgentId,
      });

      const decision = await waitForToolApproval(requestId, {
        onCancel: (reason) => {
          emit(ws, {
            type: 'claude-permission-cancelled',
            provider: 'letta',
            requestId,
            reason,
            sessionId: agentId || requestedAgentId,
          });
        },
      });

      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.allow) {
        // Allow-and-remember updates this run's in-memory allowlist.
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!toolsSettings.allowedTools.includes(decision.rememberEntry)) {
            toolsSettings.allowedTools.push(decision.rememberEntry);
          }
          toolsSettings.disallowedTools = toolsSettings.disallowedTools.filter(
            (entry) => entry !== decision.rememberEntry,
          );
        }

        return {
          behavior: 'allow',
          updatedInput: decision.updatedInput ?? null,
        };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    },
  });

  let agentId = requestedAgentId;
  let init;
  try {
    init = await session.initialize();
    agentId = init.agentId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(ws, { type: 'letta-error', error: msg, sessionId: agentId });
    return;
  }

  if (!agentId) {
    emit(ws, { type: 'letta-error', error: 'Letta SDK did not return agentId', sessionId: null });
    return;
  }

  activeSessions.set(agentId, { session, startTime: Date.now() });

  if (ws.setSessionId && typeof ws.setSessionId === 'function') {
    ws.setSessionId(agentId);
  }

  // Let frontend replace temporary session IDs.
  emit(ws, {
    type: 'session-created',
    provider: 'letta',
    sessionId: agentId,
    agentId,
    conversationId: init.conversationId,
  });

  try {
    const prompt = (command || '').trim();
    if (prompt) {
      await session.send(prompt);
    }

    for await (const msg of session.stream()) {
      // Letta SDK already includes stream_event messages in Anthropic-like shape.
      if (msg.type === 'stream_event') {
        emit(ws, { type: 'letta-response', data: msg.event, sessionId: agentId });
        continue;
      }

      if (msg.type === 'assistant') {
        emit(ws, {
          type: 'letta-response',
          sessionId: agentId,
          data: {
            role: 'assistant',
            content: [{ type: 'text', text: msg.content }],
          },
        });
        continue;
      }

      if (msg.type === 'tool_call') {
        emit(ws, {
          type: 'letta-response',
          sessionId: agentId,
          data: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: msg.toolCallId,
                name: msg.toolName,
                input: msg.toolInput,
              },
            ],
          },
        });
        continue;
      }

      if (msg.type === 'tool_result') {
        emit(ws, {
          type: 'letta-response',
          sessionId: agentId,
          data: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.toolCallId,
                content: msg.content,
                is_error: Boolean(msg.isError),
              },
            ],
          },
        });
        continue;
      }

      if (msg.type === 'result') {
        emit(ws, {
          type: 'letta-complete',
          sessionId: agentId,
          exitCode: msg.success ? 0 : 1,
          success: Boolean(msg.success),
          durationMs: msg.durationMs,
          totalCostUsd: msg.totalCostUsd,
          conversationId: msg.conversationId,
        });
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(ws, { type: 'letta-error', error: msg, sessionId: agentId });
  } finally {
    // Note: we keep the session around for resume, but mark it inactive only if the
    // session object has been explicitly closed/aborted. For now, keep it active.
  }
}
