/**
 * Value-shaped redaction for anything leaving this machine.
 *
 * This is deliberately NOT a keyword detector. `~/.claude/hooks/lib/secret-keywords.cjs`
 * is one, and its own header says what it is: a soft reminder about prompt
 * TOPICS. Pointed at transcript bodies it fails in both directions -- it misses
 * a credential that happens to sit next to no English noun, and it destroys
 * legitimate prose (5.9% of text blocks in this workspace contain the word
 * "token" meaning an LLM token). So every rule here matches the SHAPE OF A
 * VALUE, and the two rules that do use a keyword use it only as the left side
 * of an assignment, with a length floor on the right side.
 *
 * Vendored on purpose. A control that silently degrades when a file outside the
 * repo moves is not a control; the caller aborts when this module is missing
 * rather than exporting with redaction off.
 *
 * Only the matched span is replaced. Dropping whole lines would take the
 * surrounding reasoning with it, which is the one thing a handoff exists to
 * carry.
 */

/**
 * `group: n` redacts only that capture group, so `apiKey: <value>` keeps its
 * left side and the reader can still see WHAT was removed.
 */
/**
 * Every unbounded quantifier that can be followed by a literal is given an
 * explicit ceiling. Measured before the ceilings: 25 000 repetitions of "a."
 * took 4.3s across three rules, because each one rescans from every position
 * and only fails at the trailing "@" or the domain literal. A transcript full
 * of version strings or a minified bundle is enough to hit it, and a redactor
 * that stalls is a redactor someone disables.
 */
export const RULES = [
  // --- credentials, by shape ---
  { id: "pem-private-key", re: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)* PRIVATE KEY-----/g },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  // No hyphens or underscores in the tail: a real OpenAI key is alphanumeric
  // after the prefix, whereas `sk-cong-nghe-laptop-gaming-...` is an SEO slug,
  // and this workspace is full of those. Redacting one loses it silently.
  { id: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "slack-webhook", re: /\bhooks\.slack\.com\/services\/[A-Za-z0-9_\/-]{10,}/g },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: "url-basic-auth", re: /\b([a-z][a-z0-9+.-]{0,32}:\/\/)([^/\s:@]{1,128}:[^/\s:@]{1,128})@/gi, group: 2 },
  { id: "auth-header", re: /\b(Authorization["']?\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+)?)([^\s"',;]{12,})/gi, group: 2 },
  { id: "bearer-token", re: /\b(Bearer\s+)([A-Za-z0-9_\-.=]{16,})/g, group: 2 },

  // --- credentials, keyword only as the LEFT side of an assignment ---
  // The floor on the RIGHT side is what keeps "15k token/lần", "token: 15000"
  // and "max_tokens=4096" out of the blast radius -- none of those key names
  // contains one of the words below, and none of those values is long enough.
  //
  // The key pattern is deliberately a SUBSTRING match (`[a-z0-9_.-]*secret*`)
  // rather than a fixed list. A fixed list missed `aws_secret_access_key` and
  // `private_key_id` on the first pass: the public half of an AWS pair was
  // caught by shape and the private half walked straight through.
  //
  // The value class is "anything but whitespace and quoting" rather than
  // `[A-Za-z0-9_.+/=-]`. The narrow class cut `Tr0ub4dor&3xkcd!` at the `&`,
  // leaving 9 characters -- under the floor -- so a real password vanished
  // from the detector entirely.
  {
    id: "assigned-secret",
    re: /\b([a-z0-9_.-]{0,24}(?:secret|password|passwd|pwd|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|credential)[a-z0-9_.-]{0,12}["']?\s*[:=]\s*["']?)([^\s"',;]{12,})/gi,
    group: 2,
  },

  // --- workspace classes: nothing upstream knows these ---
  // The public storefront (www.thegioididong.com) is the SUBJECT of this work
  // and must survive; only the internal surfaces go. The distinction is the
  // subdomain, never the domain: a front door stays, a back door goes.
  //
  // All three MWG chains are covered -- TGDĐ, Điện Máy Xanh, TopZone -- decided
  // by the owner on 21/09, not inferred. The first pass covered only TGDĐ,
  // which was an oversight rather than a judgement: company-email already
  // treated dienmayxanh.com as internal, so the two rules disagreed about the
  // same company. Over-hiding costs nothing here (the storefronts are matched
  // by a different, surviving shape); under-hiding ships a back door to a
  // cloud model.
  {
    id: "internal-host",
    re: /\b(?:[a-z0-9-]{1,32}\.){0,3}(?:cms|staging|admin|intranet|uat|dev|portal|internal)[a-z0-9-]{0,8}\.(?:[a-z0-9-]{1,32}\.){0,2}(?:thegioididong|dienmayxanh|topzone)\.com[^\s"'<>)\]]*/gi,
  },
  { id: "n8n-endpoint", re: /\b(?:[a-z0-9-]{1,63}\.){0,8}(?:n8nseotgdd\.online|n8ntgdd1\.cloud)[^\s"'<>)\]]*/gi },
  // RFC1918 / link-local hosts: an internal address is internal wherever it points.
  { id: "private-net-url", re: /\bhttps?:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?::\d{1,5})?[^\s"'<>)\]]*/gi },
  { id: "google-oauth-client-id", re: /\b\d{8,}-[0-9a-z]{16,}\.apps\.googleusercontent\.com\b/gi },
  { id: "google-file-id", re: /\b(docs\.google\.com\/(?:spreadsheets|document|presentation)\/d\/|drive\.google\.com\/(?:file\/d\/|drive\/folders\/))([A-Za-z0-9_-]{25,})/g, group: 2 },
  { id: "assigned-file-id", re: /\b((?:spreadsheet_?id|spreadsheetId|file_?id|fileId|folder_?id|folderId|document_?id|documentId)["']?\s*[:=]\s*["']?)([A-Za-z0-9_-]{25,})/gi, group: 2 },
  { id: "company-email", re: /\b[A-Za-z0-9._%+-]{1,64}@(?:thegioididong\.com|mwg\.vn|dienmayxanh\.com|tgdd\.vn|topzone\.vn)\b/gi },
];

const MASK = (id) => `[redacted:${id}]`;

/**
 * @param {string} text
 * @returns {{ text: string, hits: Record<string, number> }}
 */
export function redactValues(text) {
  if (typeof text !== "string" || text === "") return { text: text ?? "", hits: {} };
  const hits = {};
  let out = text;
  for (const rule of RULES) {
    // Each rule gets a fresh regex: a /g literal carries lastIndex between
    // calls, and a shared one silently skips matches on the second string.
    const re = new RegExp(rule.re.source, rule.re.flags);
    out = out.replace(re, (...args) => {
      const groups = args.slice(0, -2);
      hits[rule.id] = (hits[rule.id] ?? 0) + 1;
      if (rule.group && rule.group > 0) {
        const whole = groups[0];
        const value = groups[rule.group];
        const at = whole.lastIndexOf(value);
        return at < 0 ? MASK(rule.id) : whole.slice(0, at) + MASK(rule.id);
      }
      return MASK(rule.id);
    });
  }
  return { text: out, hits };
}

/**
 * Control tags neutralised on the way out.
 *
 * `seo-crew` keeps its side clean by printing PATHS and never file bodies. This
 * export does the opposite by design, so the fence has to be built here
 * instead: anything that looks like a directive envelope to the receiving agent
 * gets its angle brackets broken.
 */
const CONTROL_TAG = /<(\/?)(system[-_]reminder|system|human|assistant|antml:[a-z_]+|function_calls|function_results|invoke|parameter|thinking|tool_use|tool_result|command-name|command-message|instructions?|im_start|im_end)\b/gi;
/** ChatML-style and bracket-style envelopes the angle-bracket rule cannot see. */
const CONTROL_ALT = /(<\|)(\/?[a-z_]+)(\|>)|(\[)(\/?(?:system|instructions?|inst))(\])/gi;

export function neutralizeControlTags(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(CONTROL_TAG, (_m, slash, tag) => `‹${slash}${tag}`)
    .replace(CONTROL_ALT, (m) => `‹${m.slice(1)}`);
}

/** Both passes, in the order the export needs them. */
export function sanitize(text) {
  const { text: redacted, hits } = redactValues(text);
  return { text: neutralizeControlTags(redacted), hits };
}
