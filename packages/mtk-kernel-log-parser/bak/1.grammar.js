module.exports = grammar({
  name: "klog",

  extras: $ => [], // 禁止自动跳过空白，完全按日志解析

  rules: {
    source_file: $ => repeat($.line),

    // ---------- 行类型 ----------
    line: $ => choice(
      $.time_anchor_line,
      $.regular_line,
      $.prefix_line,
      $.blank_line
    ),

    // ----- timezone / 头部 -----
    prefix_line: $ =>
      seq(
        field("prefix", /-----[^\n]*/),
        "\n"
      ),

    blank_line: $ => /\s*\n/,

    // ---------- Anchor 行 ----------
    time_anchor_line: $ =>
      seq(
        "<",
        field("priority", $.priority),
        ">[",
        field("rel_time", $.rel_time),
        "][",
        field("cpu", $.cpu_info),
        "]",
        " ",
        field("thread", $.thread_name),
        ": ",
        field("tags", $.tagged_info),

        field("utc_time", $.timestamp),
        " UTC;android time ",
        field("android_time", $.timestamp),

        "\n"
      ),

    // ---------- 普通日志 ----------
    regular_line: $ =>
      seq(
        "<",
        field("priority", $.priority),
        ">[",
        field("rel_time", $.rel_time),
        "][",
        field("cpu", $.cpu_info),
        "]",
        " ",
        field("thread", $.thread_name),
        ": ",
        field("tags", $.tagged_info),
        field("message", $.message),
        "\n"
      ),

    // ---------- 基础 token ----------

    priority: $ => /\d+/,

    // 支持前导空格（kernel log 对齐）
    rel_time: $ => /\s*\d+\.\d+/,

    cpu_info: $ => /[A-Za-z0-9]+/,

    // 支持 "kworker/0:0"、" T5913"
    thread_name: $ => /[^\n:]+/,

    // 支持多个 tag
    tagged_info: $ =>
      repeat1(
        seq(
          "[",
          /[^\]]*/,
          "]",
          optional(" ")
        )
      ),

    // 时间格式统一（支持 . 或 ,）
    timestamp: $ =>
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d+/,

    // 剩余内容（不贪婪到换行外）
    message: $ =>
      token(prec(-1, /[^\n]*/)),
  }
});
