#!/usr/bin/env node
/**
 * zcode-auto-resume — Stop / UserPromptSubmit 钩子引擎
 *
 * Stop 事件：检查回合结束原因。
 *   - 临时性错误（系统繁忙 / 限流 / 5xx / 超时 / 网络错误）→ 按自适应退避等待后
 *     输出 {"decision":"block","reason":"继续指令"} 让 Zcode 自动继续一轮；
 *   - 输出截断（未闭合代码块 / 尾部省略号 / 悬空标点）或空响应 → 用对应的恢复文本继续；
 *   - 余额/额度不足（配额、欠费、insufficient balance…）→ 按 modelFallback 配置自动
 *     切换到列表里的下一个模型，再让会话继续（见「余额/额度不足 → 自动换模型」一节）；
 *   - 其它永久性错误（认证 / 模型不存在 / 上下文超限）与正常完成不干预。
 * UserPromptSubmit 事件：
 *   - 拦截 /auto-continue 直连命令（on/off/status/msg/pause），不经过模型、零 token；
 *   - 其余用户新输入视为人工介入，重置该会话的重试计数。
 *
 * 输入字段同时兼容 ZCode 驼峰（sessionId / responseText / stopHookActive…）
 * 与 Claude Code 风格下划线（session_id / last_assistant_message / stop_hook_active…）。
 *
 * 状态与配置保存在数据目录（$ZCODE_PLUGIN_DATA，缺省 ~/.zcode/auto-continue/）：
 *   config.json — 可覆盖任意默认配置（见 DEFAULT_CONFIG）
 *   state.json  — 开关 / 暂停期限 / 自定义继续消息 / 每会话重试计数
 *   auto-continue.log — 运行日志；last-input.json — debug 模式下的原始输入
 *
 * 手动 CLI（与 /auto-continue 命令等价）：
 *   node auto-continue.mjs status
 *   node auto-continue.mjs on | off [时长] | pause [时长] | resume
 *   node auto-continue.mjs msg <文本> | msg clear
 *   node auto-continue.mjs reset
 *   时长格式：45s / 30m / 2h / 1d，纯数字按分钟。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  /** 总开关（/auto-continue off 可在运行时覆盖，见 state.enabled）。 */
  enabled: true,
  /** 同一会话最多自动继续次数（用户新输入后重置）。 */
  maxRetries: 8,
  /** 首次重试前冷却秒数，之后按 cooldownFactor 递增。 */
  cooldownBaseSec: 10,
  cooldownFactor: 2,
  /** 冷却上限秒数（须小于 hooks.json 的 timeoutMs/1000）。 */
  cooldownMaxSec: 60,
  /** 临时性错误的继续指令。可用占位符：{count} {maxRetries} {remaining} {message} */
  continueText:
    '上一轮回复因系统繁忙或网络错误中断（这是临时性故障，不是用户主动停止）。' +
    '请从中断处继续完成任务，不要重复已完成的工作；如上一步操作结果未知，先确认状态再继续。',
  /** 输出截断的恢复指令。 */
  truncationContinueText:
    '上一条回复疑似在输出中途被截断。请接着已生成的内容继续输出，' +
    '从中断处往下写，不要重复任何已经生成的内容。',
  /** 空响应的恢复指令。 */
  emptyContinueText:
    '上一轮回复内容为空（可能是服务临时异常）。请继续完成任务并给出正常回复。',
  /** 连续出现完全相同的错误内容达到该次数后放弃，防止无效重试刷屏。 */
  loopGuardRepeats: 3,
  /** 仅当最后一条消息短于该长度时才做完整错误匹配（错误横幅都很短）。 */
  maxErrorLength: 500,
  /** 消息不长于该值时视为纯错误横幅，命中关键词即可判定。 */
  bannerMaxLength: 80,
  /** 更长的消息要求错误关键词覆盖率达到该比例才判定为故障，
   *  正常回答里顺带提到「系统繁忙」时覆盖率极低，不会误触发。 */
  minErrorCoverage: 0.2,
  /** 输出截断判定的最小消息长度（过短的回复即使有未闭合代码块也多半是完整的）。 */
  minTruncationLength: 300,
  /** 是否启用输出截断 / 悬空结尾恢复。 */
  truncationGuard: true,
  /** 是否启用空响应重试。 */
  emptyResponseRetry: true,
  /** 是否扫描 transcript 中最后一条 assistant 消息作为兜底。 */
  scanTranscript: true,
  /** debug: 把钩子原始输入 dump 到数据目录 last-input.json。 */
  debug: false,
  /** 永久性错误关键词（正则，优先于临时性判定）。 */
  permanentPatterns: [
    '\\b40[123]\\b',
    'unauthorized', 'unauthorised', 'forbidden', 'authentication', 'authenticat',
    'invalid[_ -]?api[_ -]?key', 'api[_ -]?key', 'apikey', 'credential', '鉴权', '认证失败', '凭证', '无效的密钥',
    'insufficient (balance|funds|quota)', 'insufficient_quota', '余额不足', '欠费', '余额已不足',
    'billing', 'payment required', 'quota exceeded', 'quota has been exceeded',
    '配额(不足|已用|用尽)', '免费额度',
    'model not found', 'unknown model', 'model[_ -]?not[_ -]?exist', 'no such model', '模型不存在',
    '无可用模型', 'access denied', 'permission denied',
    'context[_ -]length', 'prompt (is )?too long', 'maximum context',
    '上下文(超|过|长度)', '输入过长', 'token limit', 'too many tokens',
  ],
  /** 临时性错误关键词（正则，命中则自动继续）。 */
  transientPatterns: [
    '当前系统繁忙', '系统繁忙', '服务器繁忙', '服务繁忙', '稍后再试', '请切换模型', '过载', '繁忙，请',
    'overloaded', 'over capacity', 'temporar', 'try again later', 'please retry', 'please try again',
    'rate[- _]?limit', 'too many requests', '\\b429\\b', '限流', '请求过于频繁',
    '\\b50[0234]\\b', 'bad gateway', 'service unavailable', 'gateway timeout',
    'internal server error', 'upstream error',
    'time[- _]?out', 'timed ?out', '超时',
    'econnreset', 'econnrefused', 'econnaborted', 'etimedout', 'enotfound', 'ehostunreach', 'enetunreach',
    'socket hang up', 'fetch failed',
    'network error', 'connection (error|reset|closed|interrupted)', '网络错误', '网络异常', '网络连接',
    '连接中断', '连接失败', '请求失败',
    'stream (error|ended unexpectedly|closed)', 'sse error', 'request failed',
  ],
  /** 余额 / 额度不足类错误：命中后走「换模型 → 继续」流程，而不是像其它永久性错误那样静默跳过。 */
  balancePatterns: [
    'insufficient (balance|funds|quota)', 'insufficient_quota', 'insufficient balance', 'no credit',
    'quota exceeded', 'quota has been exceeded', 'free quota', 'payment required', 'billing',
    '余额不足', '余额已不足', '欠费', '免费额度', '配额(不足|已用|用尽)', '额度(不足|已用|用尽)', '充值',
    '\\b1113\\b',
  ],
  /**
   * 余额/额度不足时的换模型行为。
   * strategy：
   *   auto    — Windows 用 uia（点击模型下拉），其它平台有 command 就用 command，否则 none
   *   uia     — 用 UI 自动化点击 ZCode 的模型下拉，真正选中目标模型（Windows 默认）
   *   type    — 把 injectTemplate 打进输入框（旧的 /model 思路，ZCode 桌面版没有该命令，仅留作兼容）
   *   command — 执行 command 模板（可用 {model} 占位符，跨平台）
   *   none    — 不换模型
   */
  modelFallback: {
    enabled: true,
    /** 候选模型，按顺序尝试，已试过的不再重复；名字要和 ZCode 下拉里的一致。 */
    models: ['GLM-5.3', 'GLM-5.3-Flash'],
    strategy: 'auto',
    /** strategy=command 时执行的命令模板，例如 'nircmd ... {model}'。 */
    command: '',
    /** strategy=type 时键入的文本模板。 */
    injectTemplate: '/model {model}',
    /** 定位的进程名（Windows 进程，不含 .exe）。 */
    processName: 'ZCode',
    /** 单次切换的超时（毫秒）。 */
    timeoutMs: 20000,
    /** 切换后等待多久再让会话继续（毫秒），留给 UI 完成切换。 */
    settleMs: 1500,
    /** 同一会话最多换几次模型，防止把候选列表刷穿。 */
    maxSwitches: 2,
    /** true 时只记录日志，不真正执行切换（调试用）。 */
    dryRun: false,
  },
};

/** transcript 讨论判定 / 长消息尾部判定共用的严格标记。 */
const STRICT_PATTERNS = [
  '当前系统繁忙', '系统繁忙', 'api error', 'internal server error', 'overloaded',
  'rate limit', 'service unavailable', 'bad gateway', 'network error',
];

// ---------------------------------------------------------------------------
// 数据目录 / 配置 / 状态
// ---------------------------------------------------------------------------

function dataDir() {
  if (process.env.ZCODE_PLUGIN_DATA) return process.env.ZCODE_PLUGIN_DATA;
  return path.join(os.homedir(), '.zcode', 'auto-resume');
}

function loadConfig() {
  const config = { ...DEFAULT_CONFIG };
  try {
    const file = path.join(dataDir(), 'config.json');
    if (fs.existsSync(file)) {
      const user = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (user[key] !== undefined) config[key] = user[key];
      }
      // modelFallback 是嵌套对象：逐个字段覆盖，避免用户只写一个键就丢掉其余默认值
      if (user.modelFallback && typeof user.modelFallback === 'object') {
        config.modelFallback = { ...DEFAULT_CONFIG.modelFallback, ...user.modelFallback };
      }
    }
  } catch {
    // 配置损坏时退回默认值
  }
  return config;
}

function loadState() {
  try {
    const file = path.join(dataDir(), 'state.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 状态损坏时重新开始
  }
  return { sessions: {}, pausedUntil: 0, enabled: null, customMessage: '' };
}

function saveState(state) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  // 只保留最近 24h 活跃、至多 50 个会话，防止状态文件无限增长
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const entries = Object.entries(state.sessions || {})
    .filter(([, v]) => (v.updatedAt || 0) >= cutoff)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, 50);
  state.sessions = Object.fromEntries(entries);
  const file = path.join(dir, 'state.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(path.join(dataDir(), 'auto-continue.log'), line + '\n');
  } catch {
    // 日志失败不影响主流程
  }
  process.stderr.write(line + '\n');
}

// ---------------------------------------------------------------------------
// 输入归一化：同时兼容 ZCode 驼峰与 Claude Code 风格下划线字段
// ---------------------------------------------------------------------------

function normalizeInput(raw) {
  const pick = (...keys) => {
    for (const key of keys) {
      if (raw[key] !== undefined && raw[key] !== null) return raw[key];
    }
    return undefined;
  };
  return {
    event: String(pick('hook_event_name', 'hookEventName') || ''),
    sessionId: String(pick('session_id', 'sessionId', 'conversation_id', 'conversationId') || 'unknown'),
    transcriptPath: String(pick('transcript_path', 'transcriptPath') || ''),
    stopHookActive: Boolean(pick('stop_hook_active', 'stopHookActive')),
    // responseText / responsePreview 为部分 ZCode 版本的实测字段，responsePreview 可能被截断
    lastMessage: String(pick('last_assistant_message', 'lastAssistantMessage', 'responseText', 'responsePreview') ?? ''),
    prompt: String(pick('prompt', 'userPrompt', 'promptText') ?? ''),
  };
}

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

function compile(patterns) {
  return patterns.map((source) => {
    try {
      return new RegExp(source, 'i');
    } catch {
      return null; // 用户填写的正则无效时跳过
    }
  }).filter(Boolean);
}

function anyMatch(regexes, text) {
  return regexes.some((re) => re.test(text));
}

/** 所有命中片段去重后的总长度占消息长度的比例。 */
function matchRatio(patterns, message) {
  const spans = [];
  for (const re of patterns) {
    const global = new RegExp(re.source, 'gi');
    let match;
    while ((match = global.exec(message)) !== null) {
      spans.push([match.index, match.index + match[0].length]);
      if (match.index === global.lastIndex) global.lastIndex += 1;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let lastEnd = -1;
  for (const [start, end] of spans) {
    if (start >= lastEnd) {
      covered += end - start;
      lastEnd = end;
    } else if (end > lastEnd) {
      covered += end - lastEnd;
      lastEnd = end;
    }
  }
  return covered / message.length;
}

/**
 * 文本错误分类。返回 'transient' | 'permanent' | null（null = 不是错误）。
 * 永久性判定优先：带强信号（401 / 配额 / 模型不存在等）的消息即使含
 * 「稍后再试」也不重试；其余含临时性关键词的视为可恢复错误。
 */
function classifyText(text, config) {
  const message = String(text || '').trim();
  if (!message) return null;

  if (message.length > config.maxErrorLength) {
    // 长消息只认「以严格错误横幅结尾」，避免把讨论错误的正常回答误判为失败
    const tail = message.slice(-120);
    return anyMatch(compile(STRICT_PATTERNS), tail) ? 'transient' : null;
  }

  if (anyMatch(compile(config.permanentPatterns), message)) return 'permanent';
  if (anyMatch(compile(config.transientPatterns), message)) {
    // 短消息视为纯错误横幅；较长消息要求关键词覆盖率达标，
    // 防止正常回答中引用/讨论错误关键词（如「系统繁忙」）被误判为故障
    if (message.length <= config.bannerMaxLength) return 'transient';
    if (matchRatio(compile(config.transientPatterns), message) >= config.minErrorCoverage) return 'transient';
  }
  return null;
}

/** 输出截断判定：未闭合代码块 / 尾部省略号 / 悬空开括号或冒号。 */
function classifyTruncation(text, config) {
  if (!config.truncationGuard) return null;
  const trimmed = String(text || '').trimEnd();
  if (trimmed.length < config.minTruncationLength) return null;
  const fences = (trimmed.match(/```/g) || []).length;
  if (fences % 2 === 1) return 'truncation';
  if (/(\.\.\.|…)\s*$/.test(trimmed)) return 'truncation';
  if (/[:：(\[{【]\s*$/.test(trimmed)) return 'truncation';
  return null;
}

/**
 * 兜底：取 transcript 中最后一条 assistant 条目。
 * 有文本 → 按同样规则分类；无文本 → 'empty'（配合空响应重试）。
 * 只看最后一条，不回溯更早回合，避免旧错误误触发。
 */
/** 只取 transcript 最后一条 assistant 条目的文本；没有该条目时返回 null。 */
function readLastAssistantText(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const message = entry.message || entry;
      const role = message.role || entry.type;
      if (role !== 'assistant') continue;
      const content = message.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter((part) => part && part.type === 'text' && part.text)
          .map((part) => part.text)
          .join(' ');
      }
      return '';
    }
    return null; // transcript 里没有 assistant 条目
  } catch {
    return null; // transcript 不可读
  }
}

function inspectTranscript(transcriptPath, config) {
  if (!config.scanTranscript || !transcriptPath) return null;
  const lastAssistantText = readLastAssistantText(transcriptPath);
  if (lastAssistantText === null) return null; // 保守放行
  if (!lastAssistantText.trim()) return config.emptyResponseRetry ? 'empty' : null;
  return classifyText(lastAssistantText, config);
}

/**
 * 误报防护：用户最近的提问若在讨论这类错误（如「为什么总报系统繁忙」），
 * 模型回答里出现关键词属于正常解释，不应自动继续。transcript 结构未知，
 * 解析失败时返回 false（放行继续判定）。
 */
function userDiscussingError(transcriptPath) {
  if (!transcriptPath) return false;
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trimEnd().split('\n');
    let lastUserText = '';
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = entry.message || entry;
      const role = message.role || entry.type;
      if (role !== 'user') continue;
      const content = message.content;
      if (typeof content === 'string') lastUserText = content;
      else if (Array.isArray(content)) {
        lastUserText = content
          .filter((part) => part && part.type === 'text' && part.text)
          .map((part) => part.text)
          .join(' ');
      }
    }
    if (!lastUserText) return false;
    const discussionPatterns = [...STRICT_PATTERNS, '繁忙', '限流', '超时', '\\b429\\b', '重试', '稍后再试'];
    return anyMatch(compile(discussionPatterns), lastUserText);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 钩子输出
// ---------------------------------------------------------------------------

function stopContinue(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

function blockPrompt(reply) {
  // UserPromptSubmit 直连命令：不调用模型，直接把结果作为回合反馈
  process.stdout.write(JSON.stringify({ continue: false, reason: reply }));
}

// ---------------------------------------------------------------------------
// /auto-continue 直连命令
// ---------------------------------------------------------------------------

const COMMAND_PREFIXES = ['/auto-continue', 'AUTOCONTINUE_DIRECT:'];

function parseDurationMs(text) {
  if (text === undefined || text === null || String(text).trim() === '') return null;
  const match = /^(\d+)\s*([smhd]?)$/i.exec(String(text).trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  const scale = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[unit];
  return Math.min(value * scale, 30 * 24 * 60 * 60 * 1000); // 上限 30 天
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return `${Math.round(ms / 1000)} 秒`;
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
  return `${Math.floor(hours / 24)} 天`;
}

function stateEnabled(state, config) {
  if (state.enabled === false) return false;
  if ((state.pausedUntil || 0) > Date.now()) return false;
  return config.enabled !== false;
}

function describeStatus(state, config) {
  const lines = [];
  if (state.enabled === false) lines.push('已手动关闭（/auto-continue on 可重新开启）');
  else if ((state.pausedUntil || 0) > Date.now()) {
    lines.push(`已暂停，${new Date(state.pausedUntil).toLocaleString()} 自动恢复（还有 ${formatDuration(state.pausedUntil - Date.now())}）`);
  } else lines.push('运行中');
  lines.push(`自定义继续消息: ${state.customMessage ? `「${state.customMessage}」` : '未设置（使用默认）'}`);
  const fallback = config.modelFallback || {};
  const live = readLiveModel();
  lines.push(`额度不足自动换模型: ${fallback.enabled === false ? '已关闭' : `已开启（策略 ${resolveStrategy(fallback)}${fallback.dryRun ? '，dryRun' : ''}）`}`);
  lines.push(`候选模型: ${(fallback.models || []).join(' → ') || '未配置'}`);
  if (live) lines.push(`ZCode 当前模型: ${live.modelId}${live.providerId ? `（${live.providerId}）` : ''}`);
  if (state.lastModelSwitch) {
    const s = state.lastModelSwitch;
    lines.push(`最近换模型: ${s.target} ${s.ok ? '成功' : `失败（${s.detail}）`}  ${new Date(s.at).toLocaleString()}`);
  }
  const sessions = Object.entries(state.sessions || {});
  lines.push(`会话记录 ${sessions.length} 条:`);
  for (const [id, s] of sessions.slice(0, 10)) {
    const switched = (s.triedModels || []).length ? `  已换模型 ${(s.triedModels || []).join(',')}` : '';
    lines.push(`  ${id.slice(0, 12)}…  连续继续 ${s.count} 次 / 重复错误 ${s.repeats} 次${switched}  (${new Date(s.updatedAt).toLocaleString()})`);
  }
  return lines.join('\n');
}

function runCommand(argsText, state) {
  const tokens = String(argsText || '').trim().split(/\s+/).filter(Boolean);
  const [command, ...rest] = tokens;
  const subArgs = rest.join(' ');
  const usage =
    '用法: /auto-continue on | off [时长] | pause [时长] | resume | status | msg <文本> | msg clear\n' +
    '模型: /auto-continue models | models set <模型1>,<模型2> | fallback on|off | switch <模型>\n' +
    '时长格式: 45s / 30m / 2h / 1d，纯数字按分钟';

  switch ((command || 'status').toLowerCase()) {
    case 'on':
    case 'resume':
    case 'start': {
      state.enabled = true;
      state.pausedUntil = 0;
      saveState(state);
      return 'auto-continue 已开启';
    }
    case 'off':
    case 'pause':
    case 'stop': {
      const durationMs = rest.length ? parseDurationMs(rest[0]) : null;
      if (rest.length && durationMs === null) return usage;
      if (durationMs !== null) {
        state.enabled = true;
        state.pausedUntil = Date.now() + durationMs;
        saveState(state);
        return `auto-continue 已暂停 ${formatDuration(durationMs)}，到期自动恢复`;
      }
      state.enabled = false;
      state.pausedUntil = 0;
      saveState(state);
      return 'auto-continue 已关闭（/auto-continue on 重新开启）';
    }
    case 'status': {
      const config = loadConfig();
      return describeStatus(state, config);
    }
    case 'msg':
    case 'message': {
      if (!subArgs) return '当前自定义继续消息: ' + (state.customMessage ? `「${state.customMessage}」` : '未设置（使用默认）') + '\n设置: /auto-continue msg <文本>；清除: /auto-continue msg clear';
      if (subArgs.toLowerCase() === 'clear') {
        state.customMessage = '';
        saveState(state);
        return '自定义继续消息已清除，恢复默认';
      }
      state.customMessage = subArgs;
      saveState(state);
      return `自定义继续消息已设置为「${subArgs}」`;
    }
    case 'help':
    case '-h':
    case '--help':
      return usage;
    default:
      return `未知子命令「${command}」。\n${usage}`;
  }
}

/** 需要异步或写配置的子命令：models / fallback / switch，其余交给 runCommand。 */
async function executeCommand(argsText, state) {
  const tokens = String(argsText || '').trim().split(/\s+/).filter(Boolean);
  const [command, ...rest] = tokens;
  const subArgs = rest.join(' ');
  switch ((command || '').toLowerCase()) {
    case 'models': {
      const fallback = loadConfig().modelFallback || {};
      if (!subArgs) {
        return [
          `额度不足自动换模型: ${fallback.enabled === false ? '已关闭' : '已开启'}`,
          `策略: ${resolveStrategy(fallback)}${fallback.dryRun ? '（dryRun，只记录日志）' : ''}`,
          `候选模型: ${(fallback.models || []).join(' → ') || '未配置'}`,
          `切换方式: ${resolveStrategy(fallback) === 'uia' ? 'UI 自动化点击模型下拉' : resolveStrategy(fallback)}`,
          `自定义命令: ${fallback.command || '未设置'}`,
          '设置候选: /auto-continue models set GLM-5.3,GLM-5.3-Flash',
          '立即切换: /auto-continue switch GLM-5.3    开关: /auto-continue fallback on|off',
        ].join('\n');
      }
      const [action, ...valueParts] = subArgs.split(/\s+/);
      if (String(action).toLowerCase() !== 'set') return '用法: /auto-continue models set <模型1>,<模型2>';
      const models = valueParts.join(' ').split(/[,，]/).map((m) => m.trim()).filter(Boolean);
      if (!models.length) return '用法: /auto-continue models set <模型1>,<模型2>';
      patchFallbackConfig({ models });
      return `候选模型已更新: ${models.join(' → ')}`;
    }
    case 'fallback':
    case 'balance': {
      const action = String(subArgs || '').trim().toLowerCase();
      if (!['on', 'off'].includes(action)) return '用法: /auto-continue fallback on|off';
      const fallback = patchFallbackConfig({ enabled: action === 'on' });
      return `额度不足自动换模型已${fallback.enabled === false ? '关闭' : '开启'}`;
    }
    case 'switch': {
      const target = String(subArgs || '').trim();
      if (!target) return '用法: /auto-continue switch <模型名>（立即尝试切换一次）';
      const config = loadConfig();
      const result = await switchModel(target, { ...(config.modelFallback || {}), dryRun: false });
      return result.ok
        ? `已切换到 ${target}（策略 ${result.strategy}）`
        : `切换 ${target} 失败（策略 ${result.strategy}）：${result.detail}`;
    }
    default:
      return runCommand(argsText, state);
  }
}

function isCommandPrompt(prompt) {
  const trimmed = String(prompt || '').trim();
  for (const prefix of COMMAND_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 余额 / 额度不足 → 自动换模型
// ---------------------------------------------------------------------------

/** 插件根目录（hooks/ 的上一级），用来定位 scripts/ 下的注入脚本。 */
function pluginRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

/** 是否为「余额 / 额度不足」类错误（与普通永久性错误区分开处理）。 */
function detectBalance(text, config) {
  const message = String(text || '').trim();
  if (!message) return false;
  const patterns = compile(config.balancePatterns || []);
  if (message.length <= Math.max(config.bannerMaxLength, 200)) return anyMatch(patterns, message);
  // 长消息要求关键词覆盖率达标，避免把「讨论余额不足」的正常回答误判
  return matchRatio(patterns, message) >= Math.min(config.minErrorCoverage || 0.2, 0.1);
}

/** 按 strategy 解析出实际执行方式。 */
function resolveStrategy(fallback) {
  const strategy = String(fallback.strategy || 'auto').toLowerCase();
  if (strategy !== 'auto') return strategy;
  if (process.platform === 'win32') return 'uia';
  return fallback.command ? 'command' : 'none';
}

/** 读 ZCode 当前模型：优先读界面上的模型按钮（权威），再退回本地状态/日志。 */
function readLiveModel() {
  // 1) 界面：模型按钮文字就是当前主对话模型
  if (process.platform === 'win32') {
    try {
      const script = path.join(pluginRoot(), 'scripts', 'zcode-switch-model.ps1');
      if (fs.existsSync(script)) {
        const out = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-QueryOnly'],
          { encoding: 'utf8', timeout: 8000, windowsHide: true },
        );
        const text = String((out && out.stdout) || '');
        const match = /当前模型按钮:\s*'([^']+)'/.exec(text);
        if (match) {
          const name = match[1].replace(/\s*(最高|高|中|低|最低)$/, '').trim();
          log(`[model] 界面当前模型: ${name}`);
          return { providerId: null, modelId: name };
        }
      }
    } catch {
      // 继续尝试本地文件
    }
  }
  // 2) 本地状态：只认主对话（main），subagent 覆盖值不代表聊天界面的模型
  try {
    const file = path.join(os.homedir(), '.zcode', 'v2', 'agents-state.json');
    if (fs.existsSync(file)) {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      const overrides = state && state.builtInModelSelectionOverrides;
      const main = overrides && overrides.main;
      if (main && main.modelId) return { providerId: main.providerId || null, modelId: main.modelId };
    }
  } catch {
    // 继续尝试日志
  }
  // 3) 兜底：从最近的 CLI 日志里找最近一次 session.model.updated
  try {
    const logDir = path.join(os.homedir(), '.zcode', 'cli', 'log');
    if (!fs.existsSync(logDir)) return null;
    const newest = fs.readdirSync(logDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) return null;
    const file = path.join(logDir, newest.f);
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 256 * 1024);
    const tail = fs.readFileSync(file, 'utf8').slice(start);
    let model = null;
    for (const line of tail.split('\n')) {
      if (!line.includes('"model":"')) continue;
      const match = /"model":"((?:[^"\\]|\\.)+)"/.exec(line);
      if (match) model = match[1];
    }
    if (!model) return null;
    const [providerId, modelId] = model.includes('/') ? model.split('/', 2) : [null, model];
    return { providerId, modelId };
  } catch {
    return null;
  }
}

/** 两个模型名是否指同一个模型（忽略「视觉」之类的后缀差异）。 */
function sameModel(a, b) {
  const x = String(a || '').trim().toLowerCase();
  const y = String(b || '').trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
}

/** 选下一个候选模型：跳过本会话已试过的、以及当前正在用的那个。 */
function pickFallbackModel(config, session) {
  const fallback = config.modelFallback || {};
  const tried = Array.isArray(session.triedModels) ? session.triedModels : [];
  const maxSwitches = Number.isFinite(fallback.maxSwitches) ? Number(fallback.maxSwitches) : 2;
  if (tried.length >= maxSwitches) return null;
  const live = readLiveModel();
  const current = live && live.modelId ? live.modelId : null;
  const candidates = (fallback.models || []).map((m) => String(m || '').trim()).filter(Boolean);
  return candidates.find((m) => !tried.includes(m) && !sameModel(m, current)) || null;
}

/** 运行子进程，返回 { ok, detail }，绝不抛错。 */
function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      resolve({ ok, detail });
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish(false, `启动失败：${error && error.message}`);
      return;
    }
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已退出
      }
      finish(false, `执行超时（${timeoutMs}ms）`);
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      finish(false, error.message);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0, (stderr.trim() || `退出码 ${code}`).slice(0, 300));
    });
  });
}

/** UI 自动化：点击 ZCode 的模型下拉并选中目标模型（Windows）。 */
function switchViaUia(target, fallback) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, detail: 'uia 策略仅支持 Windows' });
  }
  const script = path.join(pluginRoot(), 'scripts', 'zcode-switch-model.ps1');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, detail: `缺少切换脚本 ${script}` });
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Model', target,
  ];
  if (fallback.processName) args.push('-ProcessName', String(fallback.processName));
  return runProcess('powershell.exe', args, Number(fallback.timeoutMs) || 20000);
}

/** 键击注入：把模板文本打进 ZCode 输入框并回车（旧思路，兼容保留）。 */
function switchViaType(target, fallback) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, detail: 'type 策略仅支持 Windows' });
  }
  const script = path.join(pluginRoot(), 'scripts', 'zcode-inject.ps1');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, detail: `缺少注入脚本 ${script}` });
  const text = String(fallback.injectTemplate || '/model {model}').replaceAll('{model}', target);
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Text', text, '-SettleMs', String(fallback.settleMs ?? 1500),
  ];
  if (fallback.processName) args.push('-ProcessName', String(fallback.processName));
  return runProcess('powershell.exe', args, Number(fallback.timeoutMs) || 20000);
}

/** 自定义命令：执行 command 模板，{model} 会被替换。 */
function switchViaCommand(target, fallback) {
  const template = String(fallback.command || '');
  if (!template) return Promise.resolve({ ok: false, detail: 'modelFallback.command 为空' });
  const text = template.replaceAll('{model}', target);
  const timeoutMs = Number(fallback.timeoutMs) || 20000;
  return process.platform === 'win32'
    ? runProcess('cmd.exe', ['/d', '/s', '/c', text], timeoutMs)
    : runProcess('/bin/sh', ['-c', text], timeoutMs);
}

/** 统一入口：按策略切换模型。 */
async function switchModel(target, fallback) {
  const strategy = resolveStrategy(fallback);
  if (strategy === 'none') return { ok: false, strategy, detail: '换模型功能已关闭' };
  if (fallback.dryRun) {
    log(`[balance] dryRun：不真正切换到 ${target}（策略 ${strategy}）`);
    return { ok: false, strategy, detail: 'dryRun' };
  }
  let result;
  if (strategy === 'uia') result = await switchViaUia(target, fallback);
  else if (strategy === 'type' || strategy === 'inject') result = await switchViaType(target, fallback);
  else result = await switchViaCommand(target, fallback);
  if (result.ok) {
    // 切换成功后等 UI 落盘，再让会话继续，避免下一轮仍用旧模型
    const settleMs = Number(fallback.settleMs) || 0;
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  return { strategy, ...result };
}

/** 把 modelFallback 的部分字段写回数据目录的 config.json（供 /auto-continue 命令使用）。 */
function patchFallbackConfig(patch) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  let current = {};
  try {
    if (fs.existsSync(file)) current = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    current = {};
  }
  const fallback = { ...(current.modelFallback || {}), ...patch };
  fs.writeFileSync(file, JSON.stringify({ ...current, modelFallback: fallback }, null, 2));
  return { ...DEFAULT_CONFIG.modelFallback, ...fallback };
}

/**
 * 余额 / 额度不足的恢复流程：切换到下一个候选模型，再让会话继续。
 * @returns {Promise<{continued: boolean, reason?: string}>}
 */
async function handleBalanceRecovery(sessionId, session, config, state, errorText) {
  const fallback = config.modelFallback || {};

  const resetSession = () => {
    session.count = 0;
    session.repeats = 0;
    session.lastHash = '';
    session.updatedAt = Date.now();
    saveState(state);
  };

  if (fallback.enabled === false) {
    resetSession();
    log(`[balance] session=${sessionId} 额度不足，但自动换模型已关闭，未继续：${errorText.slice(0, 120)}`);
    return { continued: false };
  }

  const target = pickFallbackModel(config, session);
  if (!target) {
    resetSession();
    const tried = (session.triedModels || []).join(' → ') || '无';
    log(`[balance] session=${sessionId} 额度不足，但候选模型已用尽（已试：${tried}），未继续`);
    return { continued: false };
  }

  const switched = await switchModel(target, fallback);
  session.triedModels = [...(session.triedModels || []), target];
  session.updatedAt = Date.now();
  state.lastModelSwitch = {
    at: Date.now(),
    sessionId,
    target,
    strategy: switched.strategy,
    ok: switched.ok,
    detail: switched.detail,
  };
  saveState(state);

  if (!switched.ok) {
    log(`[balance] session=${sessionId} 额度不足 → 切换 ${target} 失败（${switched.strategy}）：${switched.detail}`);
    return { continued: false };
  }

  log(`[balance] session=${sessionId} 额度不足 → 已切换到 ${target}（${switched.strategy}），继续会话`);
  const template = fallback.continueText
    || '上一轮回复因账户额度 / 余额不足而中断。已自动切换到模型「{model}」，请从中断处继续完成任务，' +
       '不要重复已完成的步骤；如果上一步的结果不确定，先确认当前状态再继续。';
  return {
    continued: true,
    reason: template.replaceAll('{model}', target).replaceAll('{message}', errorText.slice(0, 200)),
  };
}

// ---------------------------------------------------------------------------
// Stop 主流程
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cooldownMs(count, config) {
  const secs = Math.min(
    config.cooldownBaseSec * Math.pow(config.cooldownFactor, count - 1),
    config.cooldownMaxSec,
  );
  return Math.round(secs * 1000);
}

function fillTemplate(template, { count, config, errorText }) {
  return template
    .replaceAll('{count}', String(count))
    .replaceAll('{maxRetries}', String(config.maxRetries))
    .replaceAll('{remaining}', String(Math.max(config.maxRetries - count, 0)))
    .replaceAll('{message}', (errorText || '').slice(0, 200));
}

async function handleStop(input, config, state) {
  const sessionId = input.sessionId;
  const session = (state.sessions[sessionId] ||= { count: 0, repeats: 0, lastHash: '', updatedAt: 0 });

  // —— 分类：文本错误 → 截断 → transcript 兜底 ——
  const lastMessage = input.lastMessage;
  let verdict = classifyText(lastMessage, config);
  if (!verdict && lastMessage.trim()) verdict = classifyTruncation(lastMessage, config);
  if (!verdict) verdict = inspectTranscript(input.transcriptPath, config);

  if (!verdict) {
    // 回合正常结束（或非错误停止）：重置计数
    if (session.count > 0 || session.repeats > 0) {
      session.count = 0;
      session.repeats = 0;
      session.lastHash = '';
      session.updatedAt = Date.now();
      saveState(state);
      log(`[reset] session=${sessionId} 回合正常结束，重试计数清零`);
    }
    return;
  }

  if (verdict === 'permanent') {
    // 额度 / 余额不足：先换模型，再让会话继续；其它永久性错误保持静默跳过
    const balanceText = lastMessage.trim() || (readLastAssistantText(input.transcriptPath) || '').trim();
    let balance = false;
    try {
      balance = detectBalance(balanceText, config);
    } catch {
      balance = false;
    }
    if (balance) {
      const outcome = await handleBalanceRecovery(sessionId, session, config, state, balanceText);
      if (outcome.continued) {
        await sleep(Number((config.modelFallback || {}).settleMs ?? 1500));
        stopContinue(outcome.reason);
      }
      return;
    }
    session.count = 0;
    session.repeats = 0;
    session.updatedAt = Date.now();
    saveState(state);
    log(`[skip] session=${sessionId} 永久性错误，不自动继续：${lastMessage.slice(0, 120)}`);
    return;
  }

  // 讨论防护只适用于文本类错误（截断 / 空响应不需要）
  if (verdict === 'transient' && userDiscussingError(input.transcriptPath)) {
    log(`[skip] session=${sessionId} 用户正在讨论错误，回答关键词不是故障，不自动继续`);
    return;
  }

  // —— 临时性错误 / 截断 / 空响应：决定是否继续 ——
  const errorText = verdict === 'empty'
    ? '(assistant 回复为空)'
    : (lastMessage.trim() || '(assistant 消息为空，transcript 中检测到错误)');

  if (session.count >= config.maxRetries) {
    log(`[give-up] session=${sessionId} 已连续自动继续 ${session.count} 次（上限 ${config.maxRetries}），放弃`);
    return;
  }

  // 循环守卫：完全相同的问题内容反复出现
  const hash = Buffer.from(errorText).toString('base64').slice(0, 64);
  if (hash === session.lastHash) session.repeats += 1;
  else session.repeats = 1;
  session.lastHash = hash;
  if (session.repeats > config.loopGuardRepeats) {
    log(`[loop-guard] session=${sessionId} 相同内容连续出现 ${session.repeats} 次，停止重试`);
    return;
  }

  session.count += 1;
  session.updatedAt = Date.now();
  saveState(state);

  const wait = cooldownMs(session.count, config);
  log(`[continue] session=${sessionId} 第 ${session.count}/${config.maxRetries} 次自动继续（${verdict}），` +
      `冷却 ${Math.round(wait / 1000)}s，内容：${errorText.slice(0, 120)}`);
  await sleep(wait);

  const template = verdict === 'truncation' ? config.truncationContinueText
    : verdict === 'empty' ? config.emptyContinueText
    : (state.customMessage || config.continueText);
  stopContinue(fillTemplate(template, { count: session.count, config, errorText }));
}

// ---------------------------------------------------------------------------
// 手动 CLI（与 /auto-continue 命令共用逻辑）
// ---------------------------------------------------------------------------

async function runCli(argv) {
  const state = loadState();
  const [command, ...rest] = argv;
  switch ((command || '').toLowerCase()) {
    case 'status': {
      console.log(describeStatus(state, loadConfig()));
      return true;
    }
    case 'on':
    case 'resume':
      console.log(runCommand('on', state));
      return true;
    case 'off':
    case 'pause':
      console.log(runCommand(['off', ...rest].join(' '), state));
      return true;
    case 'msg':
      console.log(runCommand(['msg', ...rest].join(' '), state));
      return true;
    case 'models':
    case 'fallback':
    case 'switch':
      console.log(await executeCommand([command, ...rest].join(' '), state));
      return true;
    case 'reset': {
      state.sessions = {};
      saveState(state);
      console.log('所有会话的重试计数已清零');
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  // 手动 CLI 模式：node auto-continue.mjs status|on|off|pause|resume|msg|reset
  const cliArgs = process.argv.slice(2).filter((a) => a && !a.startsWith('-'));
  if (cliArgs.length && (await runCli(cliArgs))) return;

  const raw = readStdin();
  let rawInput = {};
  if (raw.trim()) {
    try {
      rawInput = JSON.parse(raw);
    } catch {
      log('[error] 钩子输入不是合法 JSON，忽略本次事件');
      return;
    }
  }
  const input = normalizeInput(rawInput);
  const config = loadConfig();
  const state = loadState();

  if (config.debug) {
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(path.join(dataDir(), 'last-input.json'), JSON.stringify({ at: new Date().toISOString(), raw: rawInput }, null, 2));
    } catch {
      // dump 失败不影响主流程
    }
  }

  try {
    if (input.event === 'UserPromptSubmit') {
      const commandArgs = isCommandPrompt(input.prompt);
      if (commandArgs !== null) {
        log(`[command] /auto-continue ${commandArgs}`);
        blockPrompt(await executeCommand(commandArgs, state));
        return;
      }
      // 普通用户新输入：人工介入，重置重试计数与已试模型（用户可能自己换了模型）
      const session = state.sessions[input.sessionId];
      if (session) {
        const changed = session.count > 0 || session.repeats > 0
          || (Array.isArray(session.triedModels) && session.triedModels.length > 0);
        session.count = 0;
        session.repeats = 0;
        session.lastHash = '';
        session.triedModels = [];
        session.updatedAt = Date.now();
        if (changed) {
          saveState(state);
          log(`[reset] session=${input.sessionId} 用户新输入，重试计数与已试模型清零`);
        }
      }
      return;
    }

    if (input.event === 'Stop') {
      if (!stateEnabled(state, config)) {
        log(`[skip] auto-continue 当前处于关闭/暂停状态`);
        return;
      }
      await handleStop(input, config, state);
    }
  } catch (error) {
    log(`[error] 处理 ${input.event || '未知事件'} 失败：${error && error.stack || error}`);
    // 任何异常都放行，绝不阻塞会话
  }
}

main().catch(() => process.exit(0));
