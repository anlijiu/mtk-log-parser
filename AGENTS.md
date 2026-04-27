# AGENTS.md

Guidelines for AI coding agents.

## Project Overview

log parser

### Packages

- `mtk-android-log-parser` - android log parser library (依赖tree-sitter)
- `mtk-kernel-log-parser` - kernel log parser library (依赖tree-sitter)
    kernel log ， 期望能解析出 UTC;android time yyyy-MM-dd HH:mm:ss.SSS 然后把该文件其他行的时间都改为具体的时间， （目前每行头部只是过了多少秒，是相对时间） 必须用treesitter . 同一个文件可能有多行时间锚点， 用最后一个锚点
- `mtk-log-parser` - 依赖 `mtk-android-log-parser` 和 `mtk-kernel-log-parser` 可以解析这两种 的  library 
- `mtk-log-parser-cli` - 薄的命令行层 (依赖yargs) 使用 `mtk-log-parser` 可以作为命令行程序在shell中使用 ， 需要支持 -d dir  将 dir 目录下的 main_log_xy* sys_log_xy* kernel_log_xy*    合并成 merged_xy* 文件， 内容按时间顺序排

## log samples
usually:  main_log_xy* sys_log_xy* kernel_log_xy* 
``` shell
ls kernel_log_* main_log_2* sys_log_*
kernel_log_1__2026_0414_030456    main_log_2__2026_0414_031329
kernel_log_2026_0414_031622.curf  sys_log_2026_0414_032359.curf
kernel_log_3__2026_0414_031622    sys_log_4__2026_0414_032359
main_log_2026_0414_031329.curf
```

### kernel log samples
filename: `kernel_log_2026_0414_031622.curf`
content:
```
----- timezone:GMT
<7>[ 1423.257212][C600000] swapper/6: [name:virtio_net&]Receiving skb proto 0x0800 len 57 type 0
...
<7>[ 1426.781428][T700144] wdtk-7: [name:aee_hangdet&][thread:144] 2026-04-14 03:16:25.554290 UTC;android time 2026-04-14 03:16:25.554290
<6>[ 1426.781435][T700144] wdtk-7: [name:aee_hangdet&]vm_hangdet_kick_event
```

### main log samples
filename: `main_log_2026_0414_031329.curf`
contents:
```
----- timezone:GMT
2026-04-14 03:13:29.947176  1284  2234 D audiocontrol-service: [VehicleControl] - onPropertyEvent, property:VCU_XPORT_INTELL_CALC_50HZ(560009860) status:0
2026-04-14 03:13:29.947271  1284  2234 I audiocontrol-service: [VehicleControl] - parseProperty, float property VCU_XPORT_INTELL_CALC_50HZ(560009860), values: [0.000000, -0.008304, 0.000000]
```

### sys log samples
filename: `sys_log_2026_0414_032359.curf`
contents:
```
----- timezone:GMT
2026-04-14 03:23:59.531915   714   787 W CanH    : get gCanMap canId(20), can_node(9) null.
2026-04-14 03:23:59.590246   714   787 I XpVH    :  rp int HOST_VIRTUAL_FRONT_MOTOR_TEMPERATURE(2140A2AD)[0:1] = 142
2026-04-14 03:23:59.595504  2338  2372 I carapi_lib: _client_on_virtual_front_motor_temperature_changed():7284 Receive VirtualFrontMotorTemperature: 142, errorcode: [0, 0], costTime: 5ms
```

## Commands

```bash

# Build
pnpm build                  # Build all packages

# Quality
pnpm lint                   # Lint all packages
pnpm lint:fix               # Lint and auto-fix
pnpm type-check             # TypeScript checks
pnpm test                   # Run all tests
pnpm test:coverage          # Run tests with coverage
pnpm clean                  # Clean build artifacts

```

## Code Style

### General Principles

- Prioritize readability over cleverness
- No comments in code - explain reasoning in chat/commits
- Avoid premature abstractions - start concrete, extract later
- Small, focused changes over large dumps
- Never commit unless explicitly asked

### TypeScript

- Use `type` not `interface` (except when merging is required)
- No magic numbers - extract into named constants
- Strict mode with `noUnusedLocals` and `noUnusedParameters`
- Do not use one-letter variable names.
AVOID: `(b) => b.buildIndexEntry()`
PREFER: `(build) => build.buildIndexEntry()`

### Standardized Libraries

- **Dates**: date-fns
- **Utilities**: lodash-es (use individual imports: `import isEqual from 'lodash-es/isEqual'`)

## Testing

Tests use Vitest Library. Globals enabled (`describe`, `it`, `expect`, `vi`).

- Integration tests over unit tests for user-facing behavior.
- Unit tests for utilities - standalone data structures (RingBuffer, parsers) deserve isolated tests. Use them sparingly.
- Test user behavior, not implementation details
- Minimize mocks - only mock external deps (FS)
- Don't use defensive measures like try-catch or conditional checks in tests. The test will fail anyway if our assumptions are wrong.

## Tooling Notes

- **pnpm** with workspace protocol for internal deps
- **Turborepo** for task orchestration
- **ESLint + Prettier** run together
- **Husky + lint-staged** for pre-commit hooks

Use centralized configs from eslint-config packages.

Assume TanStack Router routes regenerate on dev - don't regenerate manually.
