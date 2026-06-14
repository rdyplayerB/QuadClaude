// QuadClaude delegation transformer for small/local models (e.g. qwen3-coder via
// Ollama) driven by Claude Code's large prompt. Three jobs:
//   1) fold the system prompt into the first user message (Ollama qwen templates
//      break native tool-calling when a system message is present),
//   2) trim the tool set + set temperature 0 + force non-streaming for reliability,
//   3) parse the model's text-format tool calls (<function=Name>...) back into
//      native tool_calls so Claude Code can execute them.
function textOf(c) {
  return typeof c === "string" ? c
    : Array.isArray(c) ? c.map((x) => (x && x.text) ? x.text : (typeof x === "string" ? x : "")).join("\n")
    : (c && c.text) ? c.text : "";
}

// Parse "<function=Name>\n<parameter=key>\nval\n</parameter>...</function>" into tool_calls.
function parseTextToolCalls(content) {
  const calls = [];
  const fnRe = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g;
  let m, i = 0;
  while ((m = fnRe.exec(content)) !== null) {
    const name = m[1];
    const args = {};
    const pRe = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
    let pm;
    while ((pm = pRe.exec(m[2])) !== null) args[pm[1]] = pm[2];
    calls.push({ id: `call_${name}_${i++}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  }
  return calls;
}

class MergeSystemTransformer {
  static TransformerName = "mergesystem";
  constructor(options) { this.options = options || {}; this.name = "mergesystem"; }

  async transformRequestIn(request) {
    if (!request) return request;
    const systemTexts = [];
    if (request.system) { systemTexts.push(textOf(request.system)); request.system = undefined; }
    const rest = [];
    if (Array.isArray(request.messages)) {
      for (const mm of request.messages) {
        if (mm && mm.role === "system") systemTexts.push(textOf(mm.content));
        else rest.push(mm);
      }
    }
    const preamble = systemTexts.filter(Boolean).join("\n\n");
    if (preamble) {
      const firstUser = rest.find((mm) => mm && mm.role === "user");
      if (firstUser) {
        if (typeof firstUser.content === "string") firstUser.content = preamble + "\n\n" + firstUser.content;
        else if (Array.isArray(firstUser.content)) firstUser.content = [{ type: "text", text: preamble }, ...firstUser.content];
        else firstUser.content = preamble;
      } else rest.unshift({ role: "user", content: preamble });
    }
    request.messages = rest;
    if (Array.isArray(request.tools)) {
      const ALLOW = new Set(["Read","Write","Edit","MultiEdit","Bash","Glob","Grep","LS","TodoWrite","NotebookEdit"]);
      const kept = request.tools.filter((t) => ALLOW.has(t && (t.name || (t.function && t.function.name))));
      if (kept.length) request.tools = kept;
    }
    if (request.temperature === undefined) request.temperature = 0;
    request.stream = false; // need a single JSON response to repair tool calls
    return request;
  }

  async transformResponseOut(response) {
    try {
      const ct = response.headers.get("Content-Type") || "";
      if (!ct.includes("application/json")) return response;
      const data = await response.json();
      const choice = data && data.choices && data.choices[0];
      const msg = choice && choice.message;
      if (msg && typeof msg.content === "string" && msg.content.includes("<function=") &&
          !(msg.tool_calls && msg.tool_calls.length)) {
        const calls = parseTextToolCalls(msg.content);
        if (calls.length) { msg.tool_calls = calls; msg.content = ""; choice.finish_reason = "tool_calls"; }
      }
      return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (e) {
      return response;
    }
  }
}
module.exports = MergeSystemTransformer;
