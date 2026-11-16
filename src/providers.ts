/**
 * provider 注册表 —— 二十三家外部 agent 会话的单一真源。
 * 收敛前存在四份平行名单（互相靠注释口头约定一致，改一家要四处同步）：
 * - foreign.ts 的 FOREIGN_PROVIDERS / PROVIDER_TO_ADAPTER（读取器轴）
 * - client.ts 的 RESUME_PROVIDERS（客户端 /resume-* 命令速览 chips）
 * - skills/resume.ts 的 RESUME_SKILL_SPECS 手抄数组（逐条 slash skill 文案）
 * - brand-icons.ts 的图标与显示名（BRAND_MARKS / BRAND_FULL_SVG / PROVIDER_LABEL）
 * 现在四者全部从本表派生；确有差异的轴显式入表，不留隐式：
 * - adapter：readers 适配器名（claude 的适配器叫 claude-code，其余同名）
 * - outboundEligible：是否进交接目标轴（OUTBOUND_TARGETS）。交接目标与读取器
 *   两轴独立：gemini、0.3.0 jsonl 族（kimi / codebuddy / qoder / kiro）、
 *   0.25 sqlite/文件族（copilot / devin / mimo / aider / cline / continue）与
 *   适配器收尾四家（qwen / antigravity / openclaw / goose）是读取器但不进
 *   交接目标，显式 false。
 * - icon：gemini / kimi / codebuddy / qoder / kiro / copilot / devin / mimo /
 *   aider / cline / continue / qwen / antigravity / openclaw / goose 暂无核实过
 *   的官方矢量，显式 'none' 走中性兜底——未经核实的「官方 path」不入表，不出冒牌标。
 * 纪律：本文件必须是纯数据叶（不 import 任何模块）。它同时打进 host 半
 * （tsdown）与 client 半（esbuild 浏览器 bundle）——任何 host 侧依赖
 * （cordis / dsh-tools / readers）都会把宿主拖进浏览器包或让客户端包炸裂。
 * 声明序有语义：即工具 enum、支持矩阵、命令速览 chips、skill 注册面的展示序
 * （历史 FOREIGN_PROVIDERS 序：claude → codex → opencode → zcode → pi →
 * workbuddy → cursor → grok → gemini → kimi → codebuddy → qoder → kiro →
 * copilot → devin → mimo → aider → cline → continue → qwen → antigravity →
 * openclaw → goose），改动即改序。
 * @module dsh-takeover/providers
 */

/** 图标标记：viewBox + tile 底色 + path 列表（fill 逐 path 指定）。
 * 数据自 brand-icons.ts 原样迁入（09-25/10-01 逐个从官方渠道核实下载）。 */
export interface BrandMark {
  readonly viewBox: string
  readonly tile: string
  readonly paths: readonly { readonly d: string; readonly fill: string }[]
}

/** 图标形态三态：官方 tile 标 / 官方完整 SVG 特例（自带底，整体内嵌不套 tile）/ 无在册官方矢量 */
export type ProviderIcon =
  | { readonly kind: 'mark'; readonly mark: BrandMark }
  | { readonly kind: 'full'; readonly svg: string }
  | { readonly kind: 'none' }

/** /resume-<provider> slash skill 的每家差异段（id、产品名、描述、恢复边界） */
export interface ProviderResume {
  /** slash skill id：与 name 严格一一对应（resume-<name>）。
   * 注：不能声明成 `resume-${ProviderName}`——ProviderName 自身派生自本表，
   * 会构成类型环（TS2502）；等式由注册表一致性测试在运行期钉死。 */
  readonly id: `resume-${string}`
  /** 产品显示名（skill 模板标题用） */
  readonly product: string
  /** skill 注册描述 */
  readonly description: string
  /** 各家恢复边界文案（读取器排除什么、永不做什么） */
  readonly recoveryBoundary: string
}

/** 二十三家外部 provider 的注册表条目（全部字段显式声明，消费面各自派生） */
export interface ProviderMeta {
  /** 面向用户的 provider 名（工具 enum / 设置卡矩阵 / slash skill / 交接目标同用） */
  readonly name: string
  /** readers 适配器名（@agent-handoff/readers 的 AGENTS[].name） */
  readonly adapter: string
  /** 规范显示名（矩阵 / 收件箱来源统一用它；小写 id 作副显） */
  readonly label: string
  /** 是否进交接目标轴（OUTBOUND_TARGETS）——与读取器轴独立，gemini 显式 false */
  readonly outboundEligible: boolean
  /** 品牌图标（client ProviderIcon 渲染用；'none' 走中性兜底） */
  readonly icon: ProviderIcon
  /** /resume-* skill 的每家差异段 */
  readonly resume: ProviderResume
}

export const PROVIDERS = [
  // claude / codex / cursor：simple-icons（CC0，官方 path 收录）
  {
    name: 'claude',
    adapter: 'claude-code',
    label: 'Claude Code',
    outboundEligible: true,
    icon: {
      kind: 'mark',
      mark: { viewBox: '0 0 24 24', tile: '#D97757', paths: [{ d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", fill: '#fff' }] },
    },
    resume: {
      id: 'resume-claude',
      product: 'Claude Code',
      description: '把一条 Claude Code 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。',
      recoveryBoundary: '读取器全量读取本地记录（含被替换/放弃分支的条目，thinking 块以 [thinking] 标记保留）；不复活 CLI、不回放工具调用。',
    },
  },
  {
    name: 'codex',
    adapter: 'codex',
    label: 'Codex CLI',
    outboundEligible: true,
    icon: {
      kind: 'mark',
      mark: { viewBox: '0 0 24 24', tile: '#0f0f0f', paths: [{ d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z", fill: '#fff' }] },
    },
    resume: {
      id: 'resume-codex',
      product: 'Codex',
      description: '把一条 Codex 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。',
      recoveryBoundary: '读取器排除 Codex 的 system / developer / reasoning / world-state / 跨 agent 记录。',
    },
  },
  {
    name: 'opencode',
    adapter: 'opencode',
    label: 'OpenCode',
    outboundEligible: true,
    icon: {
      kind: 'mark',
      mark: {
        // opencode：opencode.ai 官方 favicon（环形 #fff，双色原样保留）
        viewBox: '0 0 512 512',
        tile: '#131010',
        paths: [
          // 白色方环即 opencode favicon 的全部可见形态（曾误塞一条 d="#5A5858" 的颜色串当「芯」，
          // 浏览器对非法 path data 静默忽略——删掉让代码与渲染一致）
          { d: 'M384 416H128V96H384V416ZM320 160H192V352H320V160Z', fill: '#fff' },
        ],
      },
    },
    resume: {
      id: 'resume-opencode',
      product: 'OpenCode',
      description: '把一条 OpenCode 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id 或标题关键词。',
      recoveryBoundary: '读取器只读 OpenCode 本地存储的会话记录；不复活进程、不回放存储的调用。',
    },
  },
  {
    name: 'zcode',
    adapter: 'zcode',
    label: 'ZCode',
    outboundEligible: true,
    icon: {
      kind: 'mark',
      mark: {
        // zcode：docs.z.ai 官方 favicon 的 Z 标志（白色三块，#2D2D2D 底）
        viewBox: '0 0 30 30',
        tile: '#2D2D2D',
        paths: [
          { d: 'M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z', fill: '#fff' },
          { d: 'M24.3 7.1L13.14 22.91L5.7 22.91L16.86 7.1Z', fill: '#fff' },
          { d: 'M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z', fill: '#fff' },
        ],
      },
    },
    resume: {
      id: 'resume-zcode',
      product: 'ZCode',
      description: '把一条 ZCode 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id（支持短前缀）或标题关键词。',
      recoveryBoundary: '读取器只读 ZCode 的 sqlite 库（readonly、随开随关，需 Node ≥22）；不回放调用、不复活 CLI；压缩段只是摘要标记，仍在库里的旧行保留。',
    },
  },
  {
    name: 'pi',
    adapter: 'pi',
    label: 'Pi',
    outboundEligible: true,
    icon: {
      kind: 'mark',
      mark: {
        // pi：earendil-works/pi 仓库 pi-logo.ts 的官方像素定义（珊瑚/蓝/黄，1:1 复刻）
        viewBox: '0 0 800 800',
        tile: '#27272a',
        paths: [
          { d: 'M165.29 165.29H517.36V400H400V282.65H165.29Z', fill: '#F09082' },
          { d: 'M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z', fill: '#4D9ABF' },
          { d: 'M517.36 400H634.72V634.72H517.36Z', fill: '#F1BE58' },
        ],
      },
    },
    resume: {
      id: 'resume-pi',
      product: 'Pi',
      description: '把一条 Pi 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、JSONL 路径或标题关键词。',
      recoveryBoundary: '读取器只沿 Pi 当前活跃叶子读取，排除 thinking、hooks、system 消息与扩展注入的记录。',
    },
  },
  {
    name: 'workbuddy',
    adapter: 'workbuddy',
    label: 'WorkBuddy',
    outboundEligible: true,
    icon: {
      // workbuddy：workbuddy.cn 官方 logo.svg 整体内嵌（自带渐变圆底，不走 tile）
      kind: 'full',
      svg: "<svg width=\"40\" height=\"40\" viewBox=\"0 0 40 40\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<g clip-path=\"url(#clip0_542_3370)\">\n<rect width=\"40\" height=\"40\" rx=\"20\" fill=\"url(#paint0_linear_542_3370)\"/>\n<g filter=\"url(#filter0_f_542_3370)\">\n<circle cx=\"31.3411\" cy=\"43.6183\" r=\"12.8704\" fill=\"#FFE355\" fill-opacity=\"0.49\" style=\"fill:#FFE355;fill:color(display-p3 1.0000 0.8891 0.3348);fill-opacity:0.49;\"/>\n</g>\n<path d=\"M28.5931 3.12762C28.9853 2.77585 29.0091 2.76226 29.2968 2.74499C29.7628 2.71096 30.1894 2.93488 30.916 3.59634C32.6132 5.13875 34.9769 8.30904 36.4462 11.0168L37.0138 12.0682L37.8156 12.4668C38.5896 12.8579 39.8593 13.6593 40.3898 14.0895C40.6297 14.2878 40.6638 14.2925 40.9133 14.1954C42.0388 13.7572 43.6506 14.3382 45.0727 15.7024C46.3529 16.9294 47.5794 19.026 48.0491 20.7757C48.1177 21.0574 48.2087 21.6628 48.2419 22.1134C48.349 23.6964 47.8414 24.9608 46.8637 25.5331C46.664 25.6484 46.6505 25.6795 46.6561 26.1774C46.7011 28.5481 46.0621 30.9144 44.7785 33.2221C43.3293 35.8133 40.7489 38.4945 37.2566 41.0199C35.3813 42.3846 30.9445 44.9701 28.9382 45.8778C24.1324 48.0414 20.2794 48.8709 16.9329 48.4609C14.9368 48.219 12.6769 47.44 11.34 46.5355C10.9885 46.2925 10.9325 46.2774 10.6637 46.3543C9.2327 46.7651 7.35867 45.9207 5.76659 44.1535C5.13165 43.4471 4.1065 41.7127 3.77404 40.7843C3.0054 38.6118 3.15852 36.6506 4.18236 35.4799C4.44671 35.1785 4.45511 35.1658 4.39735 34.6589C4.30195 33.8289 4.25837 32.6008 4.30192 31.808L4.33666 31.0674L3.22502 29.101C1.5033 26.0375 0.409325 23.4645 -0.012563 21.4992C-0.235219 20.4218 -0.221193 19.9436 0.0522186 19.5899C0.21871 19.3763 0.764928 19.1545 1.42322 19.0329C3.08041 18.742 6.69466 19.0056 10.7155 19.7155L11.1329 19.788L12.0511 18.976C13.5747 17.6264 14.587 16.8696 16.4531 15.706C18.3981 14.4891 20.5929 13.4877 23.0648 12.695L23.8577 12.4414L24.2939 11.2964C25.8547 7.17615 27.4533 4.13844 28.5931 3.12762ZM15.5182 24.243C13.7542 25.2615 12.8718 25.7706 12.2236 26.3413C9.59893 28.6526 8.61811 32.3134 9.73545 35.6274C10.0114 36.4457 10.5201 37.3283 11.5386 39.0923C12.5571 40.8564 13.0671 41.7383 13.6378 42.3864C15.9491 45.0112 19.6103 45.9929 22.9243 44.8755C23.7426 44.5995 24.6249 44.0899 26.3888 43.0714L36.5375 37.2121C38.3016 36.1936 39.184 35.6845 39.8321 35.1137C42.4568 32.8024 43.4373 29.1409 42.3198 25.8269C42.0438 25.0086 41.5342 24.1264 40.5158 22.3624C39.4973 20.5983 38.9882 19.7159 38.4175 19.0678C36.1062 16.4432 32.4454 15.4622 29.1314 16.5796C28.3131 16.8556 27.431 17.3651 25.6669 18.3836L15.5182 24.243Z\" fill=\"url(#paint1_linear_542_3370)\"/>\n<rect x=\"16.4961\" y=\"31.3344\" width=\"4.00904\" height=\"8.32646\" rx=\"2.00452\" transform=\"rotate(-30 16.4961 31.3344)\" fill=\"white\" style=\"fill:white;fill-opacity:1;\"/>\n<rect x=\"27.3125\" y=\"25.0894\" width=\"4.00904\" height=\"8.32646\" rx=\"2.00452\" transform=\"rotate(-30 27.3125 25.0894)\" fill=\"white\" style=\"fill:white;fill-opacity:1;\"/>\n</g>\n<defs>\n<filter id=\"filter0_f_542_3370\" x=\"7.47033\" y=\"19.7475\" width=\"47.742\" height=\"47.7416\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\">\n<feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/>\n<feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/>\n<feGaussianBlur stdDeviation=\"5.50019\" result=\"effect1_foregroundBlur_542_3370\"/>\n</filter>\n<linearGradient id=\"paint0_linear_542_3370\" x1=\"20\" y1=\"0\" x2=\"20\" y2=\"40\" gradientUnits=\"userSpaceOnUse\">\n<stop stop-color=\"#0EC8A9\" style=\"stop-color:#0EC8A9;stop-color:color(display-p3 0.0565 0.7837 0.6625);stop-opacity:1;\"/>\n<stop offset=\"1\" stop-color=\"#01C886\" style=\"stop-color:#01C886;stop-color:color(display-p3 0.0021 0.7858 0.5246);stop-opacity:1;\"/>\n</linearGradient>\n<linearGradient id=\"paint1_linear_542_3370\" x1=\"14.6642\" y1=\"11.0783\" x2=\"33.3762\" y2=\"43.4885\" gradientUnits=\"userSpaceOnUse\">\n<stop stop-color=\"white\" stop-opacity=\"0.8\" style=\"stop-color:white;stop-opacity:0.8;\"/>\n<stop offset=\"0.437689\" stop-color=\"white\" style=\"stop-color:white;stop-opacity:1;\"/>\n</linearGradient>\n<clipPath id=\"clip0_542_3370\">\n<rect width=\"40\" height=\"40\" rx=\"20\" fill=\"white\" style=\"fill:white;fill-opacity:1;\"/>\n</clipPath>\n</defs>\n</svg>",
    },
    resume: {
      id: 'resume-workbuddy',
      product: 'WorkBuddy',
      description: '把一条 WorkBuddy 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。',
      recoveryBoundary: '读取器只导入受支持的 WorkBuddy transcript / 存储记录，永不回放存储的调用。',
    },
  },
  {
    name: 'cursor',
    adapter: 'cursor',
    label: 'Cursor',
    outboundEligible: true,
    icon: {
      kind: 'mark',
      mark: { viewBox: '0 0 24 24', tile: '#1a1a1a', paths: [{ d: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23", fill: '#fff' }] },
    },
    resume: {
      id: 'resume-cursor',
      product: 'Cursor',
      description: '把一条 Cursor 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。',
      recoveryBoundary: '读取器只导入受支持的 Cursor transcript / store 记录，永不回放存储的调用。',
    },
  },
  {
    name: 'grok',
    adapter: 'grok',
    label: 'Grok CLI',
    outboundEligible: true,
    icon: {
      kind: 'mark',
      mark: {
        // grok：xAI 官方 logomark（gilbarbara/logos 收录的官方矢量，256×246 单 path）
        viewBox: '0 0 256 246',
        tile: '#111111',
        paths: [{ d: "M63.8307299,56.8426545 C91.2989169,29.362978 131.465298,21.9776085 165.542128,34.9726459 L167.855892,35.8902557 C175.501463,38.7335174 182.164746,42.7796414 187.363427,46.5414469 L158.506099,59.882758 C131.637157,48.5973415 100.857492,56.2740175 82.0711204,75.0832754 C56.6656274,100.496833 51.5320736,144.566967 81.3069473,173.04336 L-1.42108547e-14,245.764227 C4.29613789,239.840925 9.45698399,234.190695 14.7493257,228.586421 L20.5645541,222.456072 L23.1726477,219.681571 C38.703877,203.027306 51.983468,185.912092 43.6693415,162.973056 L42.9033683,160.992465 C28.3109637,125.495663 36.8086459,83.896995 63.8307299,56.8426545 Z M220.785826,35.2560304 L256,0 L245.871984,14.068605 C224.778304,43.78544 215.415895,62.4930162 224.761831,102.727911 L224.69655,102.66263 C231.927394,133.390838 224.194269,167.466048 199.225391,192.464878 C167.746834,224.002573 117.372848,231.022982 75.8893821,202.634909 L104.811992,189.227703 C131.287711,199.638122 160.254097,195.066907 181.071863,174.224565 C201.890397,153.381454 206.565294,123.024196 196.101882,97.7634735 C194.113496,92.9733751 188.149873,91.7706665 183.977257,94.8542395 L98.8698734,157.755289 L220.785826,35.1466653 L220.785826,35.2560304 Z", fill: '#fff' }],
      },
    },
    resume: {
      id: 'resume-grok',
      product: 'Grok',
      description: '把一条 Grok 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、会话目录、记录路径或标题关键词。',
      recoveryBoundary: '读取器只用 Grok 可见的 updates.jsonl 流，永不读 chat_history.jsonl 原始模型上下文。',
    },
  },
  {
    name: 'gemini',
    adapter: 'gemini',
    label: 'Gemini CLI',
    // 双轴独立：gemini 是读取器（进 FOREIGN_PROVIDERS），但交接目标轴不收——
    // 「把会话交接给 Gemini CLI」与「读取 Gemini CLI 的会话」是两个方向。
    outboundEligible: false,
    // 暂无官方矢量在册：图标走 ProviderIcon 中性兜底——未经核实的「官方 path」不入表
    icon: { kind: 'none' },
    resume: {
      id: 'resume-gemini',
      product: 'Gemini CLI',
      description: '把一条 Gemini CLI 会话拉进当前会话，生成六段交接卡接手工作；本地记录是新旧双格式 JSONL/JSON，子代理会话单独存盘，可附会话 id（记录路径）、记录路径或标题关键词。',
      recoveryBoundary: '读取器只读 Gemini CLI 本地 chats/ 下的会话文件（JSONL 新格式 / 整块 JSON 旧格式，含子代理会话目录）；info/error/warning CLI 提示与斜杠命令行不进对话流；只读不写、不复活 Gemini CLI 进程。',
    },
  },
  {
    // 0.3.0 jsonl 族扩容（kimi / codebuddy / qoder / kiro）：与 gemini 同款双轴纪律——
    // 只进读取器轴，不进交接目标轴（outboundEligible: false）；暂无核实过的官方
    // 矢量，icon 显式 'none' 走中性兜底——未经核实的「官方 path」不入表。
    name: 'kimi',
    adapter: 'kimi',
    label: 'Kimi Code',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-kimi',
      product: 'Kimi Code',
      description: '把一条 Kimi Code 会话拉进当前会话，生成六段交接卡接手工作；记录是 wd_<目录>/<会话>/agents/main/wire.jsonl 事件流，可附会话目录名、记录路径或标题关键词。',
      recoveryBoundary: '读取器只读各会话 agents/main/wire.jsonl 可见事件流（turn.prompt / 文本与 think 内容块 / 工具调用与结果），think 块以 [thinking] 标记保留；伴生 state.json / session_index.jsonl 只取标题与工作目录；只读不写、不复活 Kimi CLI 进程。',
    },
  },
  {
    name: 'codebuddy',
    adapter: 'codebuddy',
    label: 'CodeBuddy',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-codebuddy',
      product: 'CodeBuddy',
      description: '把一条 CodeBuddy 会话拉进当前会话，生成六段交接卡接手工作；主会话是一文件一会的 JSONL，可附会话 id、记录路径或标题关键词。',
      recoveryBoundary: '读取器只读 projects 下 cwd 转义目录一层的主会话 JSONL（WorkBuddy 内核记录族）；子代理 transcript 不在本期范围；只读不写、不回放存储的调用。',
    },
  },
  {
    name: 'qoder',
    adapter: 'qoder',
    label: 'Qoder',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-qoder',
      product: 'Qoder',
      description: '把一条 Qoder 会话拉进当前会话，生成六段交接卡接手工作；主会话是一文件一会的 JSONL（与 Claude Code 同族记录），可附会话 id（记录路径）、记录路径或标题关键词。',
      recoveryBoundary: '读取器只读 projects 下项目目录一层的主会话 JSONL，cwd 取自记录本身（目录名反解有歧义，不猜）；子代理 transcript 不读；只读不写、不复活 Qoder。',
    },
  },
  {
    name: 'kiro',
    adapter: 'kiro',
    label: 'Kiro',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-kiro',
      product: 'Kiro',
      description: '把一条 Kiro 会话拉进当前会话，生成六段交接卡接手工作；CLI 会话是 <uuid>.jsonl 事件流（另有 .json/.history 伴生但不读），可附会话 id、JSONL 路径或标题关键词。',
      recoveryBoundary: '读取器只读 sessions/cli 下的 <uuid>.jsonl 事件流（Prompt / AssistantMessage / ToolResults）；伴生 .json 与 .history 不读；事件流没有 cwd 字段时如实留空；只读不写、不复活 Kiro。',
    },
  },
  {
    // 0.25 sqlite/文件族扩容（copilot / devin / mimo / aider / cline / continue）：
    // 与 jsonl 族同款双轴纪律——只进读取器轴，不进交接目标轴（outboundEligible: false）；
    // 暂无核实过的官方矢量，icon 显式 'none' 走中性兜底——未经核实的「官方 path」不入表。
    name: 'copilot',
    adapter: 'copilot',
    label: 'Copilot CLI',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-copilot',
      product: 'GitHub Copilot CLI',
      description: '把一条 GitHub Copilot CLI 会话拉进当前会话，生成六段交接卡接手工作；记录是 ~/.copilot/session-store.db 明文 SQLite（sessions/turns 表），可附会话 id 或标题关键词。',
      recoveryBoundary: '读取器只读 session-store.db（node:sqlite readonly、随开随关，需 Node ≥22）；列名探测不中时如实报降级，不粉饰成空会话；不回放调用、不复活 Copilot CLI。',
    },
  },
  {
    name: 'devin',
    adapter: 'devin',
    label: 'Devin CLI',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-devin',
      product: 'Devin CLI',
      description: '把一条 Devin CLI 会话拉进当前会话，生成六段交接卡接手工作；记录是 XDG 数据根下 cli/sessions.db（sessions 表带 main_chain_id 血缘字段），可附会话 id 或标题关键词。',
      recoveryBoundary: '读取器只读 sessions.db（node:sqlite readonly、随开随关，需 Node ≥22）；链式会话按 sessions 表逐条展示、链首尾不合并；逐轮记录表探测不中时正文解析为空并如实浮出 note。',
    },
  },
  {
    name: 'mimo',
    adapter: 'mimo',
    label: 'MiMo Code',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-mimo',
      product: 'MiMo Code',
      description: '把一条 MiMo Code（小米）会话拉进当前会话，生成六段交接卡接手工作；记录是 ~/.local/share 应用数据目录的 SQLite（session 表），目录名未完全核实、候选目录逐个扫描，可附会话 id 或标题关键词。',
      recoveryBoundary: '读取器只读候选目录扫描命中的明文库（node:sqlite readonly、随开随关，需 Node ≥22）；目录名未完全核实——全不命中时 supported=false 并诚实标注（不盲猜固定路径），确认后可用 HANDOFF_ROOT_MIMO 指定库文件；不回放调用、不复活 MiMo Code。',
    },
  },
  {
    name: 'aider',
    adapter: 'aider',
    label: 'Aider',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-aider',
      product: 'Aider',
      description: '把一条 Aider 会话拉进当前会话，生成六段交接卡接手工作；无会话库——历史在各 git 项目根的 .aider.chat.history.md / .aider.input.history，从起点向上探测项目根，可附记录路径或标题关键词。',
      recoveryBoundary: '读取器只读项目根的历史文件：markdown 对话历史为半结构化日志，`> ` 行记用户轮、其余正文记 assistant 轮，解析尽力而为（工具输出/截断段可能混入）并以 note 标注；只读不写、不复活 Aider。',
    },
  },
  {
    name: 'cline',
    adapter: 'cline',
    label: 'Cline',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-cline',
      product: 'Cline',
      description: '把一条 Cline（VS Code 扩展）任务拉进当前会话，生成六段交接卡接手工作；记录是 globalStorage/tasks/<taskId>/api_conversation_history.json（Anthropic 风格消息数组），可附任务 id、记录路径或标题关键词。',
      recoveryBoundary: '读取器只读各 VS Code 变体 globalStorage（saoudrizwan.claude-dev / cline.cline）下的 api_conversation_history.json；ui_messages.json（say/ask UI 事件流）不读；api 历史没有 cwd 字段时如实留空；只读不写、不复活 Cline。',
    },
  },
  {
    name: 'continue',
    adapter: 'continue',
    label: 'Continue',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-continue',
      product: 'Continue',
      description: '把一条 Continue（IDE 扩展）会话拉进当前会话，生成六段交接卡接手工作；记录是 ~/.continue/sessions/ 的 sessions.json 索引 + <sessionId>.json 会话文件，可附会话 id、记录路径或标题关键词。',
      recoveryBoundary: '读取器只读 sessions 目录下的索引与会话文件（history 消息流取 user/assistant 文本，system/tool 角色跳过）；索引缺席时退化为目录扫描；没有 cwd 字段时只在 workspace 路径在场时尽力提取，否则留空；只读不写、不复活 Continue。',
    },
  },
  {
    // 适配器收尾四家（qwen / antigravity / openclaw / goose）：与前两批同款双轴纪律——
    // 只进读取器轴，不进交接目标轴（outboundEligible: false）；暂无核实过的官方矢量，
    // icon 显式 'none' 走中性兜底——未经核实的「官方 path」不入表，不出冒牌标。
    name: 'qwen',
    adapter: 'qwen',
    label: 'Qwen Code',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-qwen',
      product: 'Qwen Code',
      description: '把一条 Qwen Code（阿里）会话拉进当前会话，生成六段交接卡接手工作；本地记录新旧双布局（tmp/ 的 Gemini 族 JSON/JSONL、projects/ 的 ChatRecord JSONL，都探测），可附会话 id（记录路径）、记录路径或标题关键词。',
      recoveryBoundary: '读取器只读 ~/.qwen 双布局下的会话记录（tmp/ 走 Gemini 族归一，projects/ 按 ChatRecord 归一：agent_mention 等控制 subtype 与代提交不进流，thought 块以 [thinking] 标记保留，cwd 取自记录本身）；QWEN.md 记忆体系不在会话轴、不读；只读不写、不复活 Qwen Code 进程。',
    },
  },
  {
    name: 'antigravity',
    adapter: 'antigravity',
    label: 'Antigravity',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-antigravity',
      product: 'Antigravity',
      description: '把一条 Antigravity（Google）会话拉进当前会话，生成六段交接卡接手工作；正文是 brain 目录的 transcript.jsonl（antigravity-cli 与 antigravity 两个 brain 布局都探测），conversation_summaries.db 只作工作目录索引，可附会话 id、记录路径或标题关键词。',
      recoveryBoundary: '读取器只读 brain 目录的 transcript JSONL（USER_EXPLICIT 输入剥 <USER_REQUEST> 壳、MODEL 回复、tool_calls 摘要轮，thinking 以 [thinking] 标记保留）；跨端索引库只取 workspace 映射，缺席/探测不中时 cwd 如实留空；只读不写、不复活 Antigravity。',
    },
  },
  {
    name: 'openclaw',
    adapter: 'openclaw',
    label: 'OpenClaw',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-openclaw',
      product: 'OpenClaw',
      description: '把一条 OpenClaw 会话拉进当前会话，生成六段交接卡接手工作；新版是各 agent 的 openclaw-agent.sqlite（session_nodes + transcript_events），旧版是 sessions/ 的 JSONL 与 sessions.json 索引，两形态都探测，可附会话 id、记录路径或标题关键词。',
      recoveryBoundary: '读取器只读各 agent 的会话库（node:sqlite readonly、随开随关，需 Node ≥22）与旧版 transcript JSONL，只取 user/assistant 文本；压缩（zstd）事件行在缺 zstd 支持的 Node 上跳过、解析为空时如实按不可用标注；不回放调用、不复活 OpenClaw。',
    },
  },
  {
    name: 'goose',
    adapter: 'goose',
    label: 'Goose',
    outboundEligible: false,
    icon: { kind: 'none' },
    resume: {
      id: 'resume-goose',
      product: 'Goose',
      description: '把一条 Goose（Block）会话拉进当前会话，生成六段交接卡接手工作；数据目录按候选探测（上游应用策略推导的常见路径，HANDOFF_ROOT_GOOSE 可直指），新版 sessions.db / 旧版 JSONL 都探测，可附会话 id、记录路径或标题关键词。',
      recoveryBoundary: '读取器只读探测命中的 sessions/ 存储（sessions.db 走 node:sqlite readonly、随开随关，需 Node ≥22；JSONL 只取 text 块）；候选全不命中时 supported=false 并诚实标注「路径按上游源码推导、未在实机核实，待社区确认」——绝不臆造固定路径；不回放调用、不复活 Goose。',
    },
  },
] as const satisfies readonly ProviderMeta[]

/** 二十三家 provider 名的字面量并集类型（注册表声明序） */
export type ProviderName = (typeof PROVIDERS)[number]['name']

/** /resume-* 命令速览 chips 的 provider 名单（client 命令速览同用；与读取器轴同源同序） */
export const RESUME_PROVIDERS: readonly ProviderName[] = PROVIDERS.map((p) => p.name)
