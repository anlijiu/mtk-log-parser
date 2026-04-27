module.exports = grammar({
  name: "klog",

  rules: {
    source_file: $ => repeat1($.line),

    line: $ => choice(
      $.prefix_line,
      $.time_anchor_line,
      $.regular_line,
      $.message_line,
      $.blank_line,
      $.unknown_line,
    ),

    // "----- timezone:GMT" style header lines
    prefix_line: $ => /-----[^\n]*\n/,

    blank_line: $ => /[ \t]*\n/,

    // ── CRITICAL FIX: unknown_line fallback ───────────────────────────────────
    //
    // 错误写法（会让所有行都变成 unknown_line）：
    //   unknown_line: $ => /[^\n]*\n/
    //
    // 原因：Tree-sitter 的 lexer 用"最长匹配"决定 token 归属，在解析器介入之前
    // 就完成了。/[^\n]*\n/ 能匹配整行（如 97 字符），而 regular_line 的第一个
    // token 是字面量 '<'（只有 1 字符）。最长匹配胜出，每一行都被 unknown_line
    // 的 regex 整行吞掉，structured rules 永远没有机会竞争。
    //
    // 正确写法：只匹配"不以 '<' 开头"的行。
    // 所有结构化行都以 '<N>[' 开头，unknown_line 限制首字符 ≠ '<'，
    // 从而在 lexer 层面彻底消除歧义，不依赖 choice() 的顺序或 prec() 优先级。
    //
    //   [^<\n][^\n]*\n  — 首字符非 '<' 非换行的行
    //   | \n            — 或裸换行（blank_line 已覆盖，这里作保险）
    // ─────────────────────────────────────────────────────────────────────────
    unknown_line: $ => /[^<\n][^\n]*\n|\n/,

    // ── time_anchor_line ──────────────────────────────────────────────────────
    // <7>[ 1426.781428][T700144] wdtk-7: [name:aee_hangdet&][thread:144] 2026-04-14 03:16:25.554290 UTC;android time 2026-04-14 03:16:25.554290
    time_anchor_line: $ => seq(
      '<', $.priority, '>[',
      $.rel_time, '][',
      $.cpu_info, ']', ' ',
      $.thread_name, ': ',
      optional($.tagged_info),
      $.android_timestamp,
      ' UTC;android time ',
      $.android_timestamp,
      '\n'
    ),

    // ── regular_line ──────────────────────────────────────────────────────────
    // <6>[ 1423.257212][C600000] swapper/6: [name:virtio_net&]Receiving skb proto 0x0800 len 57 type 0
    // <6>[ 1426.781435][T700144] wdtk-7: [name:aee_hangdet&]vm_hangdet_kick_event
    regular_line: $ => seq(
      '<', $.priority, '>[',
      $.rel_time, '][',
      $.cpu_info, ']', ' ',
      $.thread_prefix,
      optional($.tagged_info),
      $.message,
      '\n'
    ),

    // ── message_line ──────────────────────────────────────────────────────────
    // Real kernel logs often omit the "thread_name: " segment entirely:
    // <6>[    4.729027][  T149] mdw_rpmsg_probe +
    // <6>[   17.123021][  T131]
    message_line: $ => seq(
      '<', $.priority, '>[',
      $.rel_time, '][',
      $.cpu_info, ']',
      optional(seq(' ', optional($.tagged_info), optional($.message))),
      '\n'
    ),

    // ── leaf rules ────────────────────────────────────────────────────────────

    priority: $ => /\d+/,

    rel_time: $ => /\s*\d+\.\d+/,

    // FIX: 允许前后空格 — 真实 kernel log 的 cpu_info 会补空格对齐列宽
    // 例如 "[  T787]", "[  T923]"
    cpu_info: $ => /\s*[A-Za-z0-9][A-Za-z0-9_\-]*\s*/,

    // FIX: 允许 ":<数字>" 内部段，支持 kworker/u16:1 类线程名
    // 但整体结尾不能是 ':' —— 确保后面的字面量 ': ' 能正常匹配
    thread_name: $ => /[^\s:]+(?::\d+[^\s:]*)*/,

    thread_prefix: $ => token(prec(1, /[^\s:]+(?::\d+[^\s:]*)*:\s?/)),

    // 贪婪匹配行头部的 [key:value] 标签组，遇到首个非 '[' 字符停止
    tagged_info: $ => /(\[[^\]]*\]\s*)+/,

    // 支持 '.' 和 ',' 两种小数点格式
    android_timestamp: $ => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d+/,

    message: $ => /[^\n]*/,
  }
});
