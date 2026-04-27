module.exports = grammar({
  name: "klog",

  rules: {
    source_file: $ => repeat1($.line),

    line: $ => choice(
      $.prefix_line,
      $.time_anchor_line,
      $.regular_line,
      $.blank_line,
      // FIX-6: fallback catches any line that matches no other rule,
      // preventing ERROR nodes from halting the whole parse tree.
      $.unknown_line
    ),

    prefix_line: $ => /-----[^\n]*\n/,

    blank_line: $ => /[ \t]*\n/,

    // FIX-6: catch-all for structured lines without [tag] brackets,
    // e.g. "<6>[...][...] thread: raw message without any tag\n"
    unknown_line: $ => /[^\n]*\n/,

    // ── time_anchor_line ──────────────────────────────────────────────────
    // Matches lines like:
    //   <7>[ 1426.781428][T700144] wdtk-7: [name:foo&][thread:144] 2026-04-14 03:16:25.554290 UTC;android time 2026-04-14 03:16:25.554290
    time_anchor_line: $ => seq(
      '<',
      $.priority,
      '>[',
      $.rel_time,
      '][',
      $.cpu_info,
      '] ',
      $.thread_name,
      ': ',
      // FIX-2: tagged_info is optional — not all anchor lines have [tag] prefixes
      optional($.tagged_info),
      $.android_timestamp,
      ' UTC;android time ',
      $.android_timestamp,
      '\n'
    ),

    // ── regular_line ──────────────────────────────────────────────────────
    // Matches all other structured kernel log lines:
    //   <6>[ 1423.257212][C600000] swapper/6: [name:virtio_net&]Receiving skb...
    //   <6>[ 1426.781435][T700144] wdtk-7: vm_hangdet_kick_event
    regular_line: $ => seq(
      '<',
      $.priority,
      '>[',
      $.rel_time,
      '][',
      $.cpu_info,
      '] ',
      $.thread_name,
      ': ',
      // FIX-2: optional — many kernel lines have no [tag] prefix at all
      optional($.tagged_info),
      $.message,
      '\n'
    ),

    // ── Leaf rules ────────────────────────────────────────────────────────

    priority: $ => /\d+/,

    rel_time: $ => /\s*\d+\.\d+/,

    // FIX-4: original /[A-Za-z0-9]+/ rejects cpu_info values with hyphens
    // such as "IRQ-42". Extended to allow internal hyphens/underscores.
    cpu_info: $ => /[A-Za-z0-9][A-Za-z0-9_-]*/,

    // FIX-1: original /[^\s:]+/ stops at the FIRST ':' — this misparses
    // kernel worker thread names like "kworker/u4:2" (only "kworker/u4"
    // would be captured, leaving ":2: ..." as junk for subsequent tokens).
    // Fix: allow a colon if it is followed by non-space chars (i.e. an
    // internal colon within the name), but still stop at ': ' (colon+space)
    // which is the real separator between thread_name and message body.
    thread_name: $ => /[^\s:]+(?::\S+)*/,

    // FIX-3 / FIX-5: tagged_info greedily captures ALL [...] groups it
    // finds before the first non-'[' character. In Tree-sitter, there is
    // no lookahead in regex, so brackets inside the message body will be
    // absorbed here if they appear as a contiguous prefix.
    // This is the correct behaviour for MediaTek/MTK kernel logs where
    // tagged_info is always a strict prefix (e.g. [name:foo&][thread:N]).
    // Brackets that appear mid-message (after non-bracket text) are safe
    // because tagged_info will have already stopped at the non-'[' char.
    tagged_info: $ => /(\[[^\]]*\]\s*)+/,

    // FIX (note on android_timestamp):
    // Original [.,] covers both '.' and ',' separators — correct.
    // Does NOT cover ISO-8601 'T' separator; add if needed:
    //   /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]\d+/
    android_timestamp: $ => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d+/,

    // message captures the remainder of the line after thread/tags.
    // Because tagged_info is greedy and always matched first (when present),
    // message will only ever see text that does NOT start with '['.
    message: $ => /[^\n]*/,
  }
});
