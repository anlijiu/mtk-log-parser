
根据项目结构，这是一个 tree-sitter 语法包，用于解析 AndroidIDE 的 logcat 日志（threadtime 格式）。有几种使用方式：

  ---
  1. 使用 tree-sitter CLI 解析文件

  # 进入项目目录
  cd /home/an/workspace/js/tree-sitter-log

  # 解析你的 log 文件
  npx tree-sitter parse /home/an/a/APLog_2026_0414_025340__2/main_log_2026_0414_031329.curf

  ---
  2. 在 Node.js 项目中使用（作为依赖）

  # 在你的项目目录安装
  npm install /home/an/workspace/js/tree-sitter-log

  然后在你的代码中：

  const parser = require('tree-sitter-log');
  const ts = require('tree-sitter');

  const treeSitter = new ts();
  treeSitter.setLanguage(parser);  // 加载 grammar

  const fs = require('fs');
  const logContent = fs.readFileSync('/home/an/a/APLog_2026_0414_025340__2/main_log_2026_0414_031329.curf', 'utf8');

  const tree = treeSitter.parse(logContent);
  console.log(tree.rootNode.toString());  // 打印语法树

  ---
  3. 使用 WASM 版本（浏览器环境）

  // 使用 wasm2js 或直接用 wasm 环境加载
  const Parser = require('tree-sitter-log/tree-sitter-log.wasm');

  ---
  支持的日志格式

  根据 grammar.js，此包支持两种日志格式：

  1. logcat 格式（threadtime）：
  03-16 16:52:48.142  1537  1537 E tag: message
  2. IDE 日志格式：
  2024-03-16 16:52:48.142 [thread_name] E tag: message

  支持的日志级别：E/ERROR, W/WARN, I/INFO, D/DEBUG, V/VERBOSE, F/FINE, S/SILENT
