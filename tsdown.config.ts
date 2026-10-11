import { defineConfig } from 'tsdown'

// host 半打包约定（已验证的管线）：
// - @deepseek-ai/* 是宿主注入的 peer，外置——bundle 进去会出现两份 cordis 注册表；
// - @agent-handoff/core + @agent-handoff/readers 未发布 npm（file: 协议依赖），必须内联进 lib——
//   外部用户没有相邻的 agent-handoff checkout，运行时解析不到会整棵插件树失败；
// - node: 内置一律外置（readers 的 zcode 适配器走 node:sqlite，要求 Node ≥22）。
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  // 产物用 .js 扩展名（package.json main/exports 口径；fixedExtension: false）
  fixedExtension: false,
  deps: {
    alwaysBundle: (id: string) => id.startsWith('@agent-handoff/'),
    neverBundle: (id: string) => id.startsWith('@deepseek-ai/'),
  },
})
