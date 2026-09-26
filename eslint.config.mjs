import tseslint from 'typescript-eslint';

/**
 * 极简 lint：只做一件事——`no-explicit-any` 的**增量卡点**（复评报告 P2-17：any 从 141 涨到 158）。
 *
 * 机制（ratchet，只许降不许升）：
 * - 新文件 / 当前没有 any 的文件 → `error`：新代码不允许引入 `any`；
 * - 历史文件 → `warn`：允许保留现有数量，但总量受 `npm run lint` 的 `--max-warnings` 封顶，
 *   一旦增长（无论新增文件还是给老文件加）CI 立即失败；
 * - 类型声明垫片（`src/types/*.d.ts`）→ `off`：给第三方无类型依赖做 shim，天然需要 any。
 *
 * 修掉若干 any 后，请把 package.json 里 `lint` 脚本的 `--max-warnings` 同步下调，
 * 把闸门持续往下拧（当前基线见各文件行尾注释，合计 178）。
 */
export default tseslint.config(
    { ignores: ['build/**', 'node_modules/**', 'src/test/**'] },
    {
        files: ['src/**/*.ts'],
        plugins: { '@typescript-eslint': tseslint.plugin },
        languageOptions: { parser: tseslint.parser },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error'
        }
    },
    {
        // 第三方无类型依赖的声明垫片：这里的 any 是接口边界，不参与棘轮
        files: ['src/types/*.d.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off'
        }
    },
    {
        // 历史文件白名单（warn）：数字是加入本规则时的基线，用于人工核对；
        // 真正的闸门是 package.json 里的 --max-warnings 178
        files: [
            'src/utils/playwrightClient.ts', // 42 处
            'src/utils/nativeInterop.ts', // 41 处
            'src/engines/bing/bing.ts', // 17 处
            'src/utils/browserStealth.ts', // 13 处
            'src/utils/markdown.ts', // 12 处
            'src/engines/web/fetchWebContent.ts', // 11 处
            'src/engines/bing/parser.ts', // 6 处
            'src/engines/context7/context7.ts', // 6 处
            'src/utils/browserCookies.ts', // 5 处
            'src/core/search/searchService.ts', // 4 处
            'src/engines/csdn/fetchCsdnArticle.ts', // 4 处
            'src/tools/setupTools.ts', // 3 处
            'src/adapters/http/localDaemon.ts', // 2 处
            'src/engines/baidu/parser.ts', // 2 处
            'src/engines/brave/brave.ts', // 2 处
            'src/engines/github/github.ts', // 2 处
            'src/engines/duckduckgo/searchDuckDuckGo.ts', // 1 处
            'src/engines/exa/exa.ts', // 1 处
            'src/engines/sogou/sogou.ts', // 1 处
            'src/engines/startpage/startpage.ts', // 1 处
            'src/index.ts', // 1 处
            'src/utils/overseasProbe.ts' // 1 处
        ],
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn'
        }
    }
);
