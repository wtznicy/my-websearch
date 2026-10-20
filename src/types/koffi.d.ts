/**
 * koffi 的编译期兜底声明。
 *
 * ⚠️ 不要删：`src/utils/nativeInterop.ts` 用 `typeof import('koffi')` 做 type-only 引用，
 * 而 koffi 是 optionalDependencies —— 在 CI / 某些平台上可能装不上（见 .github/workflows/ci.yml
 * 的注释）。没有这个声明时，koffi 缺失会让 `tsc` 直接报 TS2307，整条构建链断掉。
 *
 * 代价：`declare module` 会遮蔽 koffi 自带的 index.d.ts，把所有 API 退化成 any。
 * 想要真实类型就得改成在 nativeInterop.ts 里声明局部接口（不依赖模块解析），
 * 那是独立的一次重构，别顺手删这个文件。
 */
declare module 'koffi' {
    export interface IKoffiCType {}

    export interface IKoffiFunction {
        (...args: any[]): any;
        async?: (...args: any[]) => any;
    }

    export interface IKoffiLibrary {
        func(signature: string): IKoffiFunction;
    }

    export function load(path: string): IKoffiLibrary;
    export function struct(name: string, fields: Record<string, string>): IKoffiCType;
    export function address(value: unknown): bigint;
    export function sizeof(type: string | IKoffiCType): number;
}
