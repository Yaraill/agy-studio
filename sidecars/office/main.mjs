/**
 * AGY Studio — Native Antigravity Plugin Sidecar Backend
 *
 * Uses the official `sidecar_sdk` (SidecarApp) and reads local session logs strictly read-only:
 *   1. Google Antigravity: ~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl & swarm/members.json
 *   2. Claude Code:        ~/.claude/projects/<project>/<session>.jsonl
 *   3. OpenAI Codex CLI:   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   4. GitHub Copilot CLI: ~/.copilot/session-state/<uuid>/events.jsonl
 *   5. OpenCode:           ~/.local/share/opencode/ (or %LOCALAPPDATA%/opencode/) [v2 SQLite & v1 JSON]
 *   6. DeepSeek CLI:       ~/.local/share/deepseek-cli/, ~/.deepseek-cli/, ~/.deepcode/, $DSH_HOME/sessions/
 *
 * Never reads or touches any auth/credential files. Zero external npm dependencies.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const XDG_DATA = process.env.XDG_DATA_HOME || join(HOME, '.local', 'share');
const LOCAL_APPDATA = process.env.LOCALAPPDATA || XDG_DATA;

const BRAIN_DIR = join(HOME, '.gemini', 'antigravity', 'brain');
const CLAUDE_PROJECTS_DIR = join(HOME, '.claude', 'projects');
const CODEX_SESSIONS_DIR = join(HOME, '.codex', 'sessions');
const COPILOT_SESSIONS_DIR = join(HOME, '.copilot', 'session-state');
const OPENCODE_DIRS = [
  join(LOCAL_APPDATA, 'opencode'),
  join(XDG_DATA, 'opencode'),
  join(HOME, '.opencode'),
];
const DEEPSEEK_DIRS = [
  process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : null,
  join(XDG_DATA, 'deepseek-cli'),
  join(HOME, '.deepseek-cli'),
  join(HOME, '.deepcode'),
].filter(Boolean);

const ACTIVE_WINDOW_MS = 3 * 60 * 1000;
const RECENT_SESSION_LIMIT = 10;
const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 256 * 1024;

// Optional built-in node:sqlite (Node 22.5+) for OpenCode v2 opencode.db
let DatabaseSync = null;
try {
  const sqliteMod = await import('node:sqlite');
  DatabaseSync = sqliteMod.DatabaseSync || null;
} catch {}

function L(lang, en, tr) {
  return lang === 'tr' ? tr : en;
}

function readJsonlSlices(filePath) {
  let fd = null;
  try {
    const st = statSync(filePath);
    const size = st.size;
    if (size === 0) return { mtimeMs: st.mtimeMs, lines: [] };

    fd = openSync(filePath, 'r');
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.allocUnsafe(size);
      readSync(fd, buf, 0, size, 0);
      return { mtimeMs: st.mtimeMs, lines: parseJsonLines(buf.toString('utf-8').split('\n')) };
    }

    const headBuf = Buffer.allocUnsafe(HEAD_BYTES);
    readSync(fd, headBuf, 0, HEAD_BYTES, 0);
    const headLines = headBuf.toString('utf-8').split('\n').slice(0, -1);

    const tailStart = Math.max(HEAD_BYTES, size - TAIL_BYTES);
    const tailLen = size - tailStart;
    const tailBuf = Buffer.allocUnsafe(tailLen);
    readSync(fd, tailBuf, 0, tailLen, tailStart);
    const tailLines = tailBuf.toString('utf-8').split('\n').slice(1);

    return {
      mtimeMs: st.mtimeMs,
      lines: [...parseJsonLines(headLines), ...parseJsonLines(tailLines)],
    };
  } catch {
    return { mtimeMs: 0, lines: [] };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function parseJsonLines(rawLines) {
  const out = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {}
  }
  return out;
}

function walkFiles(rootDir, ext, maxDepth = 4) {
  const files = [];
  if (!existsSync(rootDir)) return files;
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        const full = join(dir, name);
        try {
          const st = statSync(full);
          if (st.isDirectory()) walk(full, depth + 1);
          else if (name.endsWith(ext) && !/auth|cred|token|secret/i.test(name)) {
            files.push({ full, mtimeMs: st.mtimeMs });
          }
        } catch {}
      }
    } catch {}
  }
  walk(rootDir, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function fmtHMS(isoOrMs) {
  try {
    const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
    if (isNaN(d.getTime())) return '--:--:--';
    return d.toTimeString().slice(0, 8);
  } catch {
    return '--:--:--';
  }
}

function unquote(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim().replace(/^["']+|["']+$/g, '');
}

function cleanPathLabel(raw) {
  const s = unquote(raw);
  if (!s) return '';
  const norm = s.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}

function cleanUserPrompt(content) {
  if (!content || typeof content !== 'string') return '';
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(content);
  const text = (m ? m[1] : content).replace(/\s+/g, ' ').trim();
  return text.slice(0, 90);
}

function extractModelChanges(content) {
  if (!content || typeof content !== 'string') return null;
  const matches = [...content.matchAll(/changed setting `Model Selection` from [^\n]+? to ([^\n.<]+?)(?:\.\s*No need|\n|<|$)/gi)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].trim();
}

function classifyModelStyle(modelStr) {
  const s = (modelStr || '').toLowerCase();
  const isOrch = s.includes('orchestrator');
  if (s.includes('argon')) return { shortModel: 'Argon', badge: modelStr || 'Gemini 4 Argon', shirt: '#8b5cf6', isOrch };
  if (s.includes('neon')) return { shortModel: 'Neon', badge: modelStr || 'Gemini 4 Neon', shirt: '#0ea5e9', isOrch };
  if (s.includes('carbon')) return { shortModel: 'Carbon', badge: modelStr || 'Gemini 4 Carbon', shirt: '#f59e0b', isOrch };
  if (s.includes('claude') || s.includes('sonnet') || s.includes('opus')) {
    return { shortModel: 'Claude', badge: modelStr || 'Claude', shirt: '#f97316', isOrch };
  }
  if (s.includes('hydrogen') || s.includes('flash')) {
    return { shortModel: 'Hydrogen', badge: modelStr || 'Gemini 4 Hydrogen', shirt: '#06b6d4', isOrch };
  }
  return { shortModel: 'Gemini', badge: modelStr || 'Gemini 4', shirt: '#38bdf8', isOrch };
}

function describeToolAction(toolName, args, lang) {
  const a = args || {};
  switch (toolName) {
    case 'edit_file':
    case 'write_file':
    case 'Edit':
    case 'Write': {
      const target = cleanPathLabel(a.Path || a.path || a.file_path || L(lang, 'file', 'dosya'));
      return {
        stateKind: 'exec',
        humanStatus: L(lang, 'Coding', 'Kod yazıyor'),
        humanSummary: L(lang, `Updating ${target}.`, `${target} dosyasını güncelliyor.`),
        techTarget: target,
        propType: 'plant',
      };
    }
    case 'read_file':
    case 'Read':
    case 'Grep':
    case 'Glob': {
      const target = cleanPathLabel(a.Path || a.path || a.file_path || a.pattern || L(lang, 'file', 'dosya'));
      return {
        stateKind: 'plan',
        humanStatus: L(lang, 'Inspecting', 'İnceliyor'),
        humanSummary: L(lang, `Reading ${target}.`, `${target} dosyasını okuyor.`),
        techTarget: target,
        propType: 'notes',
      };
    }
    case 'run_command':
    case 'Bash': {
      const summary = unquote(a.toolSummary || a.description);
      const cmd = (summary || unquote(a.CommandLine || a.command) || L(lang, 'shell command', 'terminal komutu')).replace(/\s+/g, ' ').trim().slice(0, 64);
      const isTest = /test|analyze|check|verify/i.test(cmd);
      return {
        stateKind: 'exec',
        humanStatus: isTest ? L(lang, 'Testing', 'Test koşuyor') : L(lang, 'Running CLI', 'Komut koşuyor'),
        humanSummary: summary
          ? L(lang, `Running ${summary}.`, `${summary} çalıştırıyor.`)
          : L(lang, `Terminal: ${cmd}`, `Terminal: ${cmd}`),
        techTarget: cmd,
        propType: 'lamp',
      };
    }
    case 'search_web':
    case 'search_marketplace': {
      const q = unquote(a.query || (Array.isArray(a.queries) ? a.queries.join(', ') : '') || 'web').slice(0, 56);
      return {
        stateKind: 'plan',
        humanStatus: L(lang, 'Searching', 'Araştırıyor'),
        humanSummary: L(lang, `Searching for "${q}".`, `"${q}" için araştırma yapıyor.`),
        techTarget: q,
        propType: 'notes',
      };
    }
    case 'invoke_subagent': {
      const role = unquote(a.Role) || unquote(a.TypeName) || L(lang, 'subagent', 'alt ajan');
      const tName = unquote(a.TypeName) || 'subagent';
      return {
        stateKind: 'handoff',
        humanStatus: L(lang, 'Delegated', 'Alt ajan açtı'),
        humanSummary: L(lang, `Delegated task to ${role}.`, `${role} alt ajanına görev devretti.`),
        techTarget: `${tName} (${role})`,
        propType: 'board',
      };
    }
    case 'swarm': {
      const act = unquote(a.action) || 'team';
      return {
        stateKind: 'handoff',
        humanStatus: L(lang, 'Swarm Coord', 'Swarm yönetiyor'),
        humanSummary: L(lang, `Coordinating Swarm (${act}).`, `Swarm (${act}) koordinasyonu yapıyor.`),
        techTarget: `swarm ${act}`,
        propType: 'board',
      };
    }
    case 'exit_plan_mode': {
      return {
        stateKind: 'handoff',
        humanStatus: L(lang, 'Handed off', 'Devretti'),
        humanSummary: L(lang, 'Plan ready; handed execution over to Hydrogen.', 'Planı tamamladı, uygulamayı Hydrogen modeline devretti.'),
        techTarget: 'exit_plan_mode → Hydrogen',
        propType: 'board',
      };
    }
    case 'ask_question': {
      return {
        stateKind: 'plan',
        humanStatus: L(lang, 'Waiting input', 'Onay bekliyor'),
        humanSummary: L(lang, 'Waiting for user decision.', 'Kullanıcıdan tasarım/karar seçimi bekliyor.'),
        techTarget: 'ask_question',
        propType: 'board',
      };
    }
    default: {
      return {
        stateKind: 'plan',
        humanStatus: L(lang, 'Working', 'Çalışıyor'),
        humanSummary: L(lang, `Running ${toolName || 'step'}.`, `${toolName || 'İşlem'} adımını yürütüyor.`),
        techTarget: toolName || 'step',
        propType: 'notes',
      };
    }
  }
}

function getContextLimit(modelStr) {
  const s = (modelStr || '').toLowerCase();
  if (s.includes('claude') || s.includes('sonnet') || s.includes('opus')) return 200000;
  if (s.includes('gpt-oss')) return 128000;
  return 1000000;
}

function parseAntigravityEntry(entry, subagentParentMap, lang) {
  const { mtimeMs, lines } = readJsonlSlices(entry.logPath);
  if (!lines.length) return null;

  let selectedModel = null;
  let firstPrompt = '';
  let latestPrompt = '';
  let latestThinking = '';
  let totalTokens = 0;
  let firstTsMs = mtimeMs;
  let lastTsMs = mtimeMs;
  let inExecPhase = false;
  const cliUsed = { codex: false, copilot: false, claudeCode: false, opencode: false, deepseek: false };
  let lastSubagentRole = null;
  let lastSubagentType = 'subagent';
  const history = [];

  // Context window telemetry tracking
  let prevCtxUsed = null;
  let prevStepIndex = null;
  let lastInput = 0;
  let lastCacheRead = 0;
  let lastOutput = 0;
  let pendingCause = null;
  const timeline = [];
  const spikes = [];

  for (const step of lines) {
    const ts = step.created_at ? Date.parse(step.created_at) : NaN;
    if (!isNaN(ts)) {
      if (ts < firstTsMs) firstTsMs = ts;
      if (ts > lastTsMs) lastTsMs = ts;
    }

    const hasTokenMetrics =
      typeof step.input_tokens === 'number' ||
      typeof step.cache_read_tokens === 'number' ||
      typeof step.output_tokens === 'number';
    if (typeof step.input_tokens === 'number') totalTokens += step.input_tokens;
    if (typeof step.output_tokens === 'number') totalTokens += step.output_tokens;
    if (hasTokenMetrics && step.type === 'PLANNER_RESPONSE') {
      const inp = typeof step.input_tokens === 'number' ? step.input_tokens : 0;
      const cache = typeof step.cache_read_tokens === 'number' ? step.cache_read_tokens : 0;
      const out = typeof step.output_tokens === 'number' ? step.output_tokens : 0;
      const ctxUsed = inp + cache + out;
      if (ctxUsed > 0) {
        const stepTime = fmtHMS(step.created_at || mtimeMs);
        const currIdx = typeof step.step_index === 'number' ? step.step_index : timeline.length;
        timeline.push({ step: currIdx, time: stepTime, used: ctxUsed });
        const stepGap = prevStepIndex !== null ? currIdx - prevStepIndex : 1;
        if (prevCtxUsed !== null && stepGap > 0 && stepGap <= 12) {
          const delta = ctxUsed - prevCtxUsed;
          if (delta > 500 && pendingCause) {
            spikes.push({
              delta,
              tool: pendingCause.tool,
              label: pendingCause.label,
              time: stepTime,
            });
          }
        }
        prevCtxUsed = ctxUsed;
        prevStepIndex = currIdx;
        lastInput = inp;
        lastCacheRead = cache;
        lastOutput = out;
      }
    }

    if (typeof step.model === 'string' && step.model.trim()) {
      if (!selectedModel || !selectedModel.toLowerCase().includes('orchestrator')) {
        selectedModel = step.model.trim();
      }
    }

    if (typeof step.content === 'string') {
      const mc = extractModelChanges(step.content);
      if (mc) selectedModel = mc;
      if (step.type === 'USER_INPUT') {
        const p = cleanUserPrompt(step.content);
        if (p) {
          if (!firstPrompt) firstPrompt = p;
          latestPrompt = p;
          pendingCause = { tool: 'user_input', label: p.slice(0, 48) };
        }
        inExecPhase = false;
      }
      if (step.content.includes('"conversationId"')) {
        const m = /"conversationId"\s*:\s*"([0-9a-f-]{20,})"/i.exec(step.content);
        if (m) {
          const childId = m[1];
          if (!subagentParentMap.has(childId)) {
            subagentParentMap.set(childId, { parentId: entry.id, role: L(lang, 'Subagent', 'Alt Ajan'), typeName: 'subagent' });
          }
        }
      }
    }

    if (typeof step.thinking === 'string' && step.thinking.trim()) {
      const cleanThink = step.thinking.replace(/\s+/g, ' ').trim();
      if (cleanThink) latestThinking = cleanThink.slice(0, 180);
    }

    if (Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        if (!tc || !tc.name) continue;
        if (tc.name === 'exit_plan_mode') inExecPhase = true;
        if (tc.name === 'invoke_subagent') {
          lastSubagentRole = unquote(tc.args?.Role) || unquote(tc.args?.TypeName) || L(lang, 'Subagent', 'Alt Ajan');
          lastSubagentType = unquote(tc.args?.TypeName) || 'subagent';
        }
        if (tc.name === 'run_command') {
          const cmdLine = String(tc.args?.CommandLine || '');
          if (/codex\.exe|\bcodex\b/i.test(cmdLine)) cliUsed.codex = true;
          if (/\bcopilot\b/i.test(cmdLine)) cliUsed.copilot = true;
          if (/\bclaude\b/i.test(cmdLine)) cliUsed.claudeCode = true;
          if (/\bopencode\b/i.test(cmdLine)) cliUsed.opencode = true;
          if (/\bdeepseek\b|\bdsh\b|\bdeepcode\b/i.test(cmdLine)) cliUsed.deepseek = true;
        }
        const desc = describeToolAction(tc.name, tc.args, lang);
        pendingCause = { tool: tc.name, label: `${tc.name} → ${desc.techTarget}`.slice(0, 64) };
        history.push({
          time: fmtHMS(step.created_at || mtimeMs),
          tool: tc.name,
          target: desc.techTarget,
          summary: desc.humanSummary,
          tech: `${tc.name} → ${desc.techTarget}`,
          stateKind: desc.stateKind,
          humanStatus: desc.humanStatus,
          propType: desc.propType,
        });
      }
    }

    if (step.type === 'GENERIC' && typeof step.content === 'string' && step.content.includes('"conversationId"')) {
      const m = /"conversationId"\s*:\s*"([0-9a-f-]{20,})"/i.exec(step.content);
      if (m && lastSubagentRole) {
        subagentParentMap.set(m[1], {
          parentId: entry.id,
          role: lastSubagentRole,
          typeName: lastSubagentType || 'subagent',
        });
      }
    }
  }

  const swarmMembersPath = join(BRAIN_DIR, entry.id, '.system_generated', 'swarm', 'members.json');
  try {
    if (existsSync(swarmMembersPath)) {
      const roster = JSON.parse(readFileSync(swarmMembersPath, 'utf-8'));
      for (const [memberName, member] of Object.entries(roster?.members || {})) {
        const cid = member?.conversationId;
        if (typeof cid === 'string' && cid && cid !== entry.id && !subagentParentMap.has(cid)) {
          subagentParentMap.set(cid, {
            parentId: entry.id,
            role: `${memberName} (${member.role || 'worker'})`,
            typeName: 'swarm',
          });
        }
      }
    }
  } catch {}

  const limit = getContextLimit(selectedModel);
  const used = prevCtxUsed || 0;
  const percent = limit > 0 ? Math.min(100, Number(((used / limit) * 100).toFixed(1))) : 0;
  const totalIn = lastInput + lastCacheRead;
  const cacheHitRate = totalIn > 0 ? Number(((lastCacheRead / totalIn) * 100).toFixed(1)) : 0;
  const topSpikes = spikes.sort((a, b) => b.delta - a.delta).slice(0, 5);

  return {
    id: entry.id,
    mtimeMs,
    firstTsMs,
    lastTsMs,
    selectedModel,
    firstPrompt,
    latestPrompt,
    latestThinking,
    totalTokens,
    inExecPhase,
    cliUsed,
    history,
    contextWindow: {
      used,
      limit,
      percent,
      lastInput,
      lastCacheRead,
      lastOutput,
      cacheHitRate,
      totalTurns: timeline.length,
      timeline: timeline.slice(-40),
      topSpikes,
    },
  };
}

function scanAntigravitySessions(nowMs, currentConvId, scope, lang) {
  if (!existsSync(BRAIN_DIR)) {
    return { sessions: [], subagentParentMap: new Map(), cliCallerConvId: null, currentSession: null };
  }

  const subagentParentMap = new Map();
  const parsedSessions = [];

  if (scope === 'current' && currentConvId) {
    const curPath = join(BRAIN_DIR, currentConvId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(curPath)) {
      try {
        const curParsed = parseAntigravityEntry(
          { id: currentConvId, logPath: curPath, mtimeMs: statSync(curPath).mtimeMs },
          subagentParentMap,
          lang,
        );
        if (curParsed) {
          parsedSessions.push(curParsed);
          const childIds = [...subagentParentMap.entries()]
            .filter(([, info]) => info.parentId === currentConvId)
            .map(([cid]) => cid)
            .slice(0, 16);
          for (const cid of childIds) {
            const cPath = join(BRAIN_DIR, cid, '.system_generated', 'logs', 'transcript.jsonl');
            if (!existsSync(cPath)) continue;
            try {
              const cp = parseAntigravityEntry(
                { id: cid, logPath: cPath, mtimeMs: statSync(cPath).mtimeMs },
                subagentParentMap,
                lang,
              );
              if (cp) parsedSessions.push(cp);
            } catch {}
          }
          return { sessions: parsedSessions, subagentParentMap, cliCallerConvId: currentConvId, currentSession: curParsed };
        }
      } catch {}
    }
    return { sessions: [], subagentParentMap, cliCallerConvId: currentConvId, currentSession: null };
  }

  const entries = [];
  for (const name of readdirSync(BRAIN_DIR)) {
    if (!/^[0-9a-f-]{20,}$/i.test(name)) continue;
    const logPath = join(BRAIN_DIR, name, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      if (!existsSync(logPath)) continue;
      entries.push({ id: name, logPath, mtimeMs: statSync(logPath).mtimeMs });
    } catch {}
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = entries.slice(0, RECENT_SESSION_LIMIT);
  if (currentConvId && !picked.some((e) => e.id === currentConvId)) {
    const curPath = join(BRAIN_DIR, currentConvId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(curPath)) {
      try {
        picked.unshift({ id: currentConvId, logPath: curPath, mtimeMs: statSync(curPath).mtimeMs });
      } catch {}
    }
  }

  let cliCallerConvId = currentConvId || (picked[0]?.id ?? null);
  let currentSession = null;

  for (const entry of picked) {
    const parsed = parseAntigravityEntry(entry, subagentParentMap, lang);
    if (!parsed) continue;
    if (Object.values(parsed.cliUsed).some(Boolean)) cliCallerConvId = parsed.id;
    if (parsed.id === currentConvId) currentSession = parsed;
    parsedSessions.push(parsed);
  }

  return { sessions: parsedSessions, subagentParentMap, cliCallerConvId, currentSession };
}

/** OpenAI Codex CLI */
function scanCodexSessions(nowMs, defaultParentId, timeWindow, lang) {
  const files = walkFiles(CODEX_SESSIONS_DIR, '.jsonl', 4);
  const filtered = timeWindow ? files.filter((f) => f.mtimeMs >= timeWindow.minMs && f.mtimeMs <= timeWindow.maxMs) : files;

  const agents = [];
  for (const f of filtered.slice(0, 2)) {
    const { mtimeMs, lines } = readJsonlSlices(f.full);
    if (!lines.length) continue;

    const fileTail = basename(f.full, '.jsonl').slice(-6);
    let sessionId = basename(f.full, '.jsonl').slice(-12);
    let modelName = 'Codex CLI';
    let userTask = '';
    let totalTokens = 0;
    let firstTsMs = mtimeMs;
    const history = [];

    for (const item of lines) {
      const ts = item.timestamp ? Date.parse(item.timestamp) : NaN;
      if (!isNaN(ts) && ts < firstTsMs) firstTsMs = ts;
      if (item.type === 'session_meta' && item.payload?.session_id) sessionId = item.payload.session_id.slice(0, 8);
      if (item.type === 'event_msg' && item.payload?.type === 'thread_settings_applied' && item.payload?.thread_settings?.model) {
        modelName = String(item.payload.thread_settings.model);
      }
      if (item.type === 'event_msg' && item.payload?.type === 'token_count') {
        const info = item.payload?.info?.total_token_usage;
        if (info && typeof info.total_tokens === 'number') totalTokens = Math.max(totalTokens, info.total_tokens);
      }
      if (item.type === 'response_item' && item.payload?.type === 'message' && item.payload?.role === 'user') {
        const txt = item.payload?.content?.[0]?.text || '';
        if (txt && !userTask) userTask = txt.replace(/\s+/g, ' ').trim().slice(0, 88);
      }
      if (item.type === 'response_item' && (item.payload?.type === 'custom_tool_call' || item.payload?.type === 'function_call')) {
        const tName = item.payload.name || 'exec';
        const rawArg = typeof item.payload.input === 'string' ? item.payload.input : (typeof item.payload.arguments === 'string' ? item.payload.arguments : tName);
        const cmdPreview = rawArg.replace(/\s+/g, ' ').trim().slice(0, 56);
        const isPatch = /patch|write|edit/i.test(tName + ' ' + cmdPreview);
        history.push({
          time: fmtHMS(item.timestamp || mtimeMs),
          tool: tName,
          target: cmdPreview,
          summary: isPatch ? L(lang, 'Applying code patch.', 'Kod yaması uyguluyor.') : L(lang, 'Running terminal command.', 'Terminalde analiz/komut yürütüyor.'),
          tech: `${tName} → ${cmdPreview}`,
          stateKind: 'exec',
          humanStatus: isPatch ? L(lang, 'Patching', 'Yama yapıyor') : L(lang, 'CLI Running', 'CLI çalışıyor'),
        });
      }
    }

    const isActive = (nowMs - mtimeMs) <= ACTIVE_WINDOW_MS;
    const lastAct = history[history.length - 1];
    agents.push({
      id: `codex-${sessionId}-${fileTail}`,
      name: agents.length === 0 ? 'OpenAI Codex CLI' : `Codex CLI #${agents.length + 1}`,
      modelBadge: modelName,
      role: L(lang, 'External CLI Subagent', 'Dış CLI Alt Ajanı'),
      provider: 'codex',
      providerLabel: 'Codex CLI',
      category: 'cli',
      status: isActive ? 'active' : 'idle',
      stateKind: isActive ? (lastAct?.stateKind || 'exec') : 'idle',
      humanStatus: isActive ? (lastAct?.humanStatus || L(lang, 'CLI Running', 'CLI çalışıyor')) : L(lang, 'Completed', 'Tamamlandı'),
      humanSummary: userTask || lastAct?.summary || L(lang, 'Codex CLI session completed.', 'Codex CLI oturumu tamamlandı.'),
      tool: lastAct?.tool || 'codex exec',
      target: lastAct?.target || `${L(lang, 'Session', 'Oturum')} ${sessionId}`,
      thinking: userTask ? `${L(lang, 'Task', 'Görev')}: "${userTask}"` : 'OpenAI Codex CLI.',
      tokens: totalTokens,
      elapsedSec: Math.max(5, Math.round((mtimeMs - firstTsMs) / 1000)),
      shirtColor: '#10b981',
      parentId: defaultParentId,
      parentName: 'Antigravity',
      propType: isActive ? 'terminal' : 'coffee',
      mtimeMs,
      history: history.slice(-3).length ? history.slice(-3) : [{ time: fmtHMS(mtimeMs), summary: userTask || 'Codex session', tech: `codex exec (${sessionId})` }],
    });
  }
  return agents;
}

/** GitHub Copilot CLI */
function scanCopilotSessions(nowMs, defaultParentId, timeWindow, lang) {
  if (!existsSync(COPILOT_SESSIONS_DIR)) return [];
  const sessions = [];
  try {
    for (const dirName of readdirSync(COPILOT_SESSIONS_DIR)) {
      if (dirName.startsWith('.')) continue;
      const evPath = join(COPILOT_SESSIONS_DIR, dirName, 'events.jsonl');
      try {
        if (!existsSync(evPath)) continue;
        sessions.push({ id: dirName, evPath, mtimeMs: statSync(evPath).mtimeMs });
      } catch {}
    }
  } catch {}

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const filtered = timeWindow ? sessions.filter((s) => s.mtimeMs >= timeWindow.minMs && s.mtimeMs <= timeWindow.maxMs) : sessions;

  const agents = [];
  for (const s of filtered.slice(0, 2)) {
    const { mtimeMs, lines } = readJsonlSlices(s.evPath);
    if (!lines.length) continue;

    let chosenModel = 'Copilot Auto';
    let userPrompt = '';
    let isShutdown = false;
    let firstTsMs = mtimeMs;
    let totalTokens = 0;
    const history = [];

    for (const ev of lines) {
      const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
      if (!isNaN(ts) && ts < firstTsMs) firstTsMs = ts;
      if (ev.type === 'session.auto_mode_resolved' && ev.data?.chosenModel) chosenModel = ev.data.chosenModel;
      if (ev.type === 'user.message' && typeof ev.data?.content === 'string') {
        userPrompt = ev.data.content.replace(/\s+/g, ' ').trim().slice(0, 88);
        history.push({
          time: fmtHMS(ev.timestamp || mtimeMs),
          tool: 'copilot -p',
          target: userPrompt.slice(0, 48),
          summary: L(lang, `Task received: ${userPrompt.slice(0, 56)}`, `Görev alındı: ${userPrompt.slice(0, 56)}`),
          tech: `user.message → ${chosenModel}`,
        });
      }
      if (ev.type === 'tool.execution_start' || ev.type === 'tool.execution_complete') {
        const tName = ev.data?.toolName || ev.data?.name || 'view';
        history.push({
          time: fmtHMS(ev.timestamp || mtimeMs),
          tool: tName,
          target: userPrompt.slice(0, 42) || L(lang, 'code review', 'kod incelemesi'),
          summary: L(lang, `Copilot invoked tool (${tName})`, `Copilot aracı çalıştırdı (${tName})`),
          tech: `${ev.type} → ${tName}`,
        });
      }
      if (ev.type === 'session.usage_record') {
        const u = ev.data?.usage;
        if (u) {
          if (u.modelDisplayName) chosenModel = String(u.modelDisplayName);
          else if (u.model) chosenModel = String(u.model);
          totalTokens += (typeof u.inputTokens === 'number' ? u.inputTokens : 0) + (typeof u.outputTokens === 'number' ? u.outputTokens : 0);
        } else if (typeof ev.data?.totalTokens === 'number') {
          totalTokens += ev.data.totalTokens;
        }
      }
      if (ev.type === 'session.shutdown') isShutdown = true;
    }

    const isActive = !isShutdown && (nowMs - mtimeMs) <= ACTIVE_WINDOW_MS;
    const lastAct = history[history.length - 1];
    agents.push({
      id: `copilot-${s.id.slice(0, 8)}`,
      name: agents.length === 0 ? 'GitHub Copilot CLI' : `Copilot CLI #${agents.length + 1}`,
      modelBadge: chosenModel,
      role: L(lang, 'External CLI Subagent', 'Dış CLI Alt Ajanı'),
      provider: 'copilot',
      providerLabel: 'Copilot CLI',
      category: 'cli',
      status: isActive ? 'active' : 'idle',
      stateKind: isActive ? 'plan' : 'idle',
      humanStatus: isActive ? L(lang, 'Reviewing', 'İnceliyor') : L(lang, 'Completed', 'Tamamlandı'),
      humanSummary: userPrompt || L(lang, 'GitHub Copilot CLI review completed.', 'GitHub Copilot CLI incelemesi tamamlandı.'),
      tool: lastAct?.tool || 'copilot -sp',
      target: lastAct?.target || chosenModel,
      thinking: userPrompt ? `${L(lang, 'Review task', 'İnceleme görevi')}: "${userPrompt}"` : 'GitHub Copilot CLI.',
      tokens: totalTokens,
      elapsedSec: Math.max(4, Math.round((mtimeMs - firstTsMs) / 1000)),
      shirtColor: '#8b5cf6',
      parentId: defaultParentId,
      parentName: 'Antigravity',
      propType: isActive ? 'shield' : 'coffee',
      mtimeMs,
      history: history.slice(-3).length ? history.slice(-3) : [{ time: fmtHMS(mtimeMs), summary: userPrompt || 'Copilot CLI', tech: `copilot (${chosenModel})` }],
    });
  }
  return agents;
}

/** Claude Code CLI (~/.claude/projects/<encoded-project>/<session>.jsonl) */
function scanClaudeCodeSessions(nowMs, defaultParentId, timeWindow, lang) {
  const files = walkFiles(CLAUDE_PROJECTS_DIR, '.jsonl', 3);
  const filtered = timeWindow ? files.filter((f) => f.mtimeMs >= timeWindow.minMs && f.mtimeMs <= timeWindow.maxMs) : files;

  const agents = [];
  for (const f of filtered.slice(0, 2)) {
    const { mtimeMs, lines } = readJsonlSlices(f.full);
    if (!lines.length) continue;

    const sid = basename(f.full, '.jsonl').slice(0, 8);
    let modelName = 'Claude Code';
    let userPrompt = '';
    let totalTokens = 0;
    let firstTsMs = mtimeMs;
    const history = [];

    for (const ev of lines) {
      const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
      if (!isNaN(ts) && ts < firstTsMs) firstTsMs = ts;

      if (ev.type === 'user' && ev.message?.content) {
        const c = ev.message.content;
        const txt = typeof c === 'string' ? c : (Array.isArray(c) ? c.find((x) => x?.type === 'text')?.text || '' : '');
        if (txt && !userPrompt) userPrompt = txt.replace(/\s+/g, ' ').trim().slice(0, 88);
      }
      if (ev.type === 'assistant' && ev.message) {
        if (ev.message.model) modelName = String(ev.message.model);
        const u = ev.message.usage;
        if (u) {
          totalTokens += (typeof u.input_tokens === 'number' ? u.input_tokens : 0) + (typeof u.output_tokens === 'number' ? u.output_tokens : 0);
        }
        if (Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            if (block?.type === 'tool_use' && block.name) {
              const desc = describeToolAction(block.name, block.input, lang);
              history.push({
                time: fmtHMS(ev.timestamp || mtimeMs),
                tool: block.name,
                target: desc.techTarget,
                summary: desc.humanSummary,
                tech: `${block.name} → ${desc.techTarget}`,
                stateKind: desc.stateKind,
                humanStatus: desc.humanStatus,
              });
            }
          }
        }
      }
    }

    const isActive = (nowMs - mtimeMs) <= ACTIVE_WINDOW_MS;
    const lastAct = history[history.length - 1];
    agents.push({
      id: `claude-code-${sid}`,
      name: agents.length === 0 ? 'Claude Code CLI' : `Claude Code #${agents.length + 1}`,
      modelBadge: modelName,
      role: L(lang, 'External CLI Subagent', 'Dış CLI Alt Ajanı'),
      provider: 'claude-code',
      providerLabel: 'Claude Code',
      category: 'cli',
      status: isActive ? 'active' : 'idle',
      stateKind: isActive ? (lastAct?.stateKind || 'exec') : 'idle',
      humanStatus: isActive ? (lastAct?.humanStatus || L(lang, 'Coding', 'Kod yazıyor')) : L(lang, 'Completed', 'Tamamlandı'),
      humanSummary: userPrompt || lastAct?.summary || L(lang, 'Claude Code session completed.', 'Claude Code oturumu tamamlandı.'),
      tool: lastAct?.tool || 'claude',
      target: lastAct?.target || modelName,
      thinking: userPrompt ? `${L(lang, 'Task', 'Görev')}: "${userPrompt}"` : 'Claude Code CLI.',
      tokens: totalTokens,
      elapsedSec: Math.max(4, Math.round((mtimeMs - firstTsMs) / 1000)),
      shirtColor: '#f97316',
      parentId: defaultParentId,
      parentName: 'Antigravity',
      propType: isActive ? 'plant' : 'coffee',
      mtimeMs,
      history: history.slice(-3).length ? history.slice(-3) : [{ time: fmtHMS(mtimeMs), summary: userPrompt || 'Claude Code', tech: modelName }],
    });
  }
  return agents;
}

/** OpenCode CLI (v2 SQLite opencode.db via built-in node:sqlite + v1 JSON fallback) */
function scanOpenCodeSessions(nowMs, defaultParentId, timeWindow, lang) {
  const agents = [];
  for (const baseDir of OPENCODE_DIRS) {
    if (!existsSync(baseDir)) continue;

    // v2 SQLite
    const dbPath = join(baseDir, 'opencode.db');
    if (DatabaseSync && existsSync(dbPath)) {
      let db = null;
      try {
        const dbMtime = statSync(dbPath).mtimeMs;
        if (!timeWindow || (dbMtime >= timeWindow.minMs && dbMtime <= timeWindow.maxMs)) {
          db = new DatabaseSync(dbPath, { readOnly: true });
          const rows = db.prepare('SELECT id, title, time_updated, time_created FROM session ORDER BY time_updated DESC LIMIT 2').all();
          for (const row of rows) {
            const updatedMs = Number(row.time_updated || dbMtime);
            const createdMs = Number(row.time_created || updatedMs);
            if (timeWindow && (updatedMs < timeWindow.minMs || updatedMs > timeWindow.maxMs)) continue;
            const isActive = (nowMs - updatedMs) <= ACTIVE_WINDOW_MS;
            const title = String(row.title || L(lang, 'OpenCode session', 'OpenCode oturumu')).slice(0, 88);
            agents.push({
              id: `opencode-${String(row.id || '').slice(0, 8)}`,
              name: agents.length === 0 ? 'OpenCode CLI' : `OpenCode #${agents.length + 1}`,
              modelBadge: 'OpenCode',
              role: L(lang, 'External CLI Subagent', 'Dış CLI Alt Ajanı'),
              provider: 'opencode',
              providerLabel: 'OpenCode',
              category: 'cli',
              status: isActive ? 'active' : 'idle',
              stateKind: isActive ? 'exec' : 'idle',
              humanStatus: isActive ? L(lang, 'CLI Running', 'CLI çalışıyor') : L(lang, 'Completed', 'Tamamlandı'),
              humanSummary: title,
              tool: 'opencode',
              target: String(row.id || '').slice(0, 12),
              thinking: title,
              tokens: 0,
              elapsedSec: Math.max(4, Math.round((updatedMs - createdMs) / 1000)),
              shirtColor: '#ec4899',
              parentId: defaultParentId,
              parentName: 'Antigravity',
              propType: isActive ? 'terminal' : 'coffee',
              mtimeMs: updatedMs,
              history: [{ time: fmtHMS(updatedMs), summary: title, tech: 'opencode.db' }],
            });
          }
        }
      } catch {} finally {
        try { db?.close(); } catch {}
      }
      if (agents.length > 0) return agents;
    }

    // v1 JSON fallback
    const jsonFiles = walkFiles(join(baseDir, 'storage'), '.json', 4);
    const filtered = timeWindow ? jsonFiles.filter((f) => f.mtimeMs >= timeWindow.minMs && f.mtimeMs <= timeWindow.maxMs) : jsonFiles;
    for (const f of filtered.slice(0, 2)) {
      try {
        const obj = JSON.parse(readFileSync(f.full, 'utf-8'));
        const sid = String(obj.id || basename(f.full, '.json')).slice(0, 8);
        const title = String(obj.title || obj.summary || L(lang, 'OpenCode session', 'OpenCode oturumu')).slice(0, 88);
        const isActive = (nowMs - f.mtimeMs) <= ACTIVE_WINDOW_MS;
        agents.push({
          id: `opencode-${sid}`,
          name: agents.length === 0 ? 'OpenCode CLI' : `OpenCode #${agents.length + 1}`,
          modelBadge: String(obj.model || 'OpenCode'),
          role: L(lang, 'External CLI Subagent', 'Dış CLI Alt Ajanı'),
          provider: 'opencode',
          providerLabel: 'OpenCode',
          category: 'cli',
          status: isActive ? 'active' : 'idle',
          stateKind: isActive ? 'exec' : 'idle',
          humanStatus: isActive ? L(lang, 'CLI Running', 'CLI çalışıyor') : L(lang, 'Completed', 'Tamamlandı'),
          humanSummary: title,
          tool: 'opencode',
          target: sid,
          thinking: title,
          tokens: 0,
          elapsedSec: 10,
          shirtColor: '#ec4899',
          parentId: defaultParentId,
          parentName: 'Antigravity',
          propType: isActive ? 'terminal' : 'coffee',
          mtimeMs: f.mtimeMs,
          history: [{ time: fmtHMS(f.mtimeMs), summary: title, tech: 'opencode' }],
        });
      } catch {}
    }
    if (agents.length > 0) return agents;
  }
  return agents;
}

/** DeepSeek CLI / Harness */
function scanDeepSeekSessions(nowMs, defaultParentId, timeWindow, lang) {
  const allFiles = [];
  for (const dir of DEEPSEEK_DIRS) {
    if (!existsSync(dir)) continue;
    allFiles.push(...walkFiles(dir, '.jsonl', 3));
  }
  allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const filtered = timeWindow ? allFiles.filter((f) => f.mtimeMs >= timeWindow.minMs && f.mtimeMs <= timeWindow.maxMs) : allFiles;

  const agents = [];
  for (const f of filtered.slice(0, 2)) {
    const { mtimeMs, lines } = readJsonlSlices(f.full);
    if (!lines.length) continue;

    const sid = basename(f.full, '.jsonl').slice(-8);
    let modelName = 'DeepSeek';
    let userPrompt = '';
    let totalTokens = 0;
    const history = [];

    for (const ev of lines) {
      if (ev.model) modelName = String(ev.model);
      if ((ev.role === 'user' || ev.type === 'user') && typeof ev.content === 'string' && !userPrompt) {
        userPrompt = ev.content.replace(/\s+/g, ' ').trim().slice(0, 88);
      }
      if (ev.usage && typeof ev.usage.total_tokens === 'number') {
        totalTokens += ev.usage.total_tokens;
      }
      if (Array.isArray(ev.tool_calls)) {
        for (const tc of ev.tool_calls) {
          const tName = tc?.function?.name || tc?.name || 'tool';
          history.push({
            time: fmtHMS(ev.timestamp || mtimeMs),
            tool: tName,
            target: tName,
            summary: L(lang, `DeepSeek called ${tName}.`, `DeepSeek aracı çalıştırdı (${tName}).`),
            tech: `deepseek → ${tName}`,
          });
        }
      }
    }

    const isActive = (nowMs - mtimeMs) <= ACTIVE_WINDOW_MS;
    const lastAct = history[history.length - 1];
    agents.push({
      id: `deepseek-${sid}`,
      name: agents.length === 0 ? 'DeepSeek CLI' : `DeepSeek CLI #${agents.length + 1}`,
      modelBadge: modelName,
      role: L(lang, 'External CLI Subagent', 'Dış CLI Alt Ajanı'),
      provider: 'deepseek',
      providerLabel: 'DeepSeek CLI',
      category: 'cli',
      status: isActive ? 'active' : 'idle',
      stateKind: isActive ? 'exec' : 'idle',
      humanStatus: isActive ? L(lang, 'CLI Running', 'CLI çalışıyor') : L(lang, 'Completed', 'Tamamlandı'),
      humanSummary: userPrompt || L(lang, 'DeepSeek CLI session completed.', 'DeepSeek CLI oturumu tamamlandı.'),
      tool: lastAct?.tool || 'deepseek',
      target: lastAct?.target || modelName,
      thinking: userPrompt ? `${L(lang, 'Task', 'Görev')}: "${userPrompt}"` : 'DeepSeek CLI.',
      tokens: totalTokens,
      elapsedSec: 10,
      shirtColor: '#3b82f6',
      parentId: defaultParentId,
      parentName: 'Antigravity',
      propType: isActive ? 'terminal' : 'coffee',
      mtimeMs,
      history: history.slice(-3).length ? history.slice(-3) : [{ time: fmtHMS(mtimeMs), summary: userPrompt || 'DeepSeek CLI', tech: modelName }],
    });
  }
  return agents;
}

export function buildLiveSnapshot(currentConvId, scope = 'current', lang = 'en') {
  const nowMs = Date.now();
  const effectiveLang = lang === 'tr' ? 'tr' : 'en';
  const effectiveScope = scope === 'all' || !currentConvId ? 'all' : 'current';
  const { sessions, subagentParentMap, cliCallerConvId, currentSession } = scanAntigravitySessions(
    nowMs,
    currentConvId,
    effectiveScope,
    effectiveLang,
  );

  const agents = [];
  const feed = [];
  let leadOrchId = null;

  for (const s of sessions) {
    const subInfo = subagentParentMap.get(s.id);
    const isSubagent = Boolean(subInfo);
    const style = classifyModelStyle(s.selectedModel);
    const isActive = (nowMs - s.mtimeMs) <= ACTIVE_WINDOW_MS || s.id === currentConvId;
    const lastHist = s.history[s.history.length - 1];

    const category = isSubagent
      ? 'swarm'
      : (style.isOrch || !subInfo ? (isActive || sessions.indexOf(s) < 2 ? 'orchestrator' : 'idle') : 'swarm');

    if (category === 'orchestrator' && !leadOrchId) leadOrchId = s.id;

    let stateKind = isActive ? (lastHist?.stateKind || 'plan') : 'idle';
    let humanStatus = isActive ? (lastHist?.humanStatus || L(effectiveLang, 'Planning', 'Planlıyor')) : L(effectiveLang, 'Coffee break', 'Kahve molasında');
    if (isActive && style.isOrch && s.inExecPhase) {
      stateKind = 'handoff';
      humanStatus = L(effectiveLang, 'Handed off (Hydrogen)', 'Devretti (Hydrogen)');
    }

    const shortId = s.id.slice(0, 6);
    const displayName = isSubagent
      ? `${subInfo.role} (${shortId})`
      : `${style.shortModel}${s.id === currentConvId ? L(effectiveLang, ' · This Chat', ' · Bu Sohbet') : ` (${shortId})`}`;

    const humanSummary = isActive
      ? (lastHist?.summary || (s.latestPrompt ? L(effectiveLang, `Working on "${s.latestPrompt}"`, `"${s.latestPrompt}" üzerinde çalışıyor`) : L(effectiveLang, 'Active session', 'Aktif oturum')))
      : (s.latestPrompt ? L(effectiveLang, `Last topic: "${s.latestPrompt}"`, `Son konu: "${s.latestPrompt}"`) : L(effectiveLang, 'Waiting for next task.', 'Yeni görev bekliyor.'));

    agents.push({
      id: s.id,
      conversationId: s.id,
      name: displayName,
      modelBadge: style.badge,
      role: isSubagent
        ? `${L(effectiveLang, 'Subagent', 'Alt Ajan')} (${subInfo.typeName})`
        : (style.isOrch ? 'Orchestrator' : L(effectiveLang, 'Main Agent', 'Ana Ajan')),
      provider: 'antigravity',
      providerLabel: 'Antigravity',
      category: isActive ? category : (isSubagent ? 'swarm' : 'idle'),
      status: isActive ? 'active' : 'idle',
      stateKind,
      humanStatus,
      humanSummary,
      handoffNote: style.isOrch
        ? (s.inExecPhase
            ? L(effectiveLang, 'Phase 2 → Execution running on Hydrogen', 'Aşama 2 → Uygulama Hydrogen modelinde')
            : L(effectiveLang, 'Phase 1 → Planning & codebase analysis', 'Aşama 1 → Planlama ve analiz fazı'))
        : (s.firstPrompt ? `${L(effectiveLang, 'Topic', 'Konu')}: ${s.firstPrompt.slice(0, 56)}` : ''),
      tool: lastHist?.tool || (isActive ? 'thinking' : 'idle'),
      target: lastHist?.target || (s.latestPrompt ? s.latestPrompt.slice(0, 48) : L(effectiveLang, 'Ready', 'Hazır')),
      thinking: s.latestThinking || (s.latestPrompt ? `${L(effectiveLang, 'Request', 'İstek')}: "${s.latestPrompt}"` : L(effectiveLang, 'Waiting for message.', 'Yeni mesaj bekleniyor.')),
      tokens: s.totalTokens,
      contextWindow: s.contextWindow,
      elapsedSec: Math.max(1, Math.round((s.lastTsMs - s.firstTsMs) / 1000)),
      shirtColor: style.shirt,
      parentId: subInfo ? subInfo.parentId : null,
      parentName: subInfo ? `${L(effectiveLang, 'Chat', 'Oturum')} ${subInfo.parentId.slice(0, 6)}` : null,
      propType: isActive ? (lastHist?.propType || (category === 'orchestrator' ? 'board' : 'plant')) : 'coffee',
      mtimeMs: s.mtimeMs,
      history: s.history.slice(-3).length ? s.history.slice(-3) : [{ time: fmtHMS(s.mtimeMs), summary: humanSummary, tech: style.badge }],
    });

    for (const h of s.history.slice(-2)) {
      feed.push({
        time: h.time,
        mtimeMs: s.mtimeMs,
        agentId: s.id,
        agentName: displayName,
        stateKind: h.stateKind || stateKind,
        summary: h.summary,
        tech: h.tech,
      });
    }
  }

  const effectiveParentId = cliCallerConvId || leadOrchId || (agents[0]?.id ?? null);
  const parentAgent = agents.find((a) => a.id === effectiveParentId);
  const parentDisplay = parentAgent ? parentAgent.name.split(' ')[0] : 'Antigravity';

  const cliAgents = [];
  if (effectiveScope === 'current') {
    const win = currentSession
      ? { minMs: currentSession.firstTsMs - 5000, maxMs: Math.max(currentSession.lastTsMs, nowMs) + 120000 }
      : null;
    const cu = currentSession?.cliUsed || {};
    if (cu.codex) cliAgents.push(...scanCodexSessions(nowMs, effectiveParentId, win, effectiveLang));
    if (cu.copilot) cliAgents.push(...scanCopilotSessions(nowMs, effectiveParentId, win, effectiveLang));
    if (cu.claudeCode) cliAgents.push(...scanClaudeCodeSessions(nowMs, effectiveParentId, win, effectiveLang));
    if (cu.opencode) cliAgents.push(...scanOpenCodeSessions(nowMs, effectiveParentId, win, effectiveLang));
    if (cu.deepseek) cliAgents.push(...scanDeepSeekSessions(nowMs, effectiveParentId, win, effectiveLang));
  } else {
    cliAgents.push(
      ...scanCodexSessions(nowMs, effectiveParentId, null, effectiveLang),
      ...scanCopilotSessions(nowMs, effectiveParentId, null, effectiveLang),
      ...scanClaudeCodeSessions(nowMs, effectiveParentId, null, effectiveLang),
      ...scanOpenCodeSessions(nowMs, effectiveParentId, null, effectiveLang),
      ...scanDeepSeekSessions(nowMs, effectiveParentId, null, effectiveLang),
    );
  }

  for (const ca of cliAgents) {
    ca.parentName = parentDisplay;
    agents.push(ca);
    for (const h of ca.history.slice(-2)) {
      feed.push({
        time: h.time,
        mtimeMs: ca.mtimeMs,
        agentId: ca.id,
        agentName: ca.name,
        stateKind: ca.stateKind,
        summary: h.summary,
        tech: h.tech,
      });
    }
  }

  feed.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.time.localeCompare(a.time));

  const etag = `${effectiveScope}|${effectiveLang}|` + agents
    .map((a) => `${a.id}:${Math.floor(a.mtimeMs)}:${a.tokens}:${a.contextWindow?.used || 0}:${a.stateKind}`)
    .join('|');

  return {
    timestamp: new Date(nowMs).toISOString(),
    scope: effectiveScope,
    lang: effectiveLang,
    currentConversationId: currentConvId || null,
    leadOrchId: leadOrchId || (agents[0]?.id ?? null),
    agents,
    feed: feed.slice(0, 14),
    etag,
  };
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

app.api('/api/state', (data) => {
  const convId = data.conversationId || app.config.conversationId || '';
  const scope = data.scope === 'all' ? 'all' : 'current';
  const lang = data.lang === 'tr' ? 'tr' : 'en';
  const snap = buildLiveSnapshot(convId, scope, lang);
  if (data.etag && data.etag === snap.etag) {
    return { unchanged: true, etag: snap.etag };
  }
  return snap;
}, 'GET');

app.run();
