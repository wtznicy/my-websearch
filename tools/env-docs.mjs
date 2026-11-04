#!/usr/bin/env node
/**
 * 环境变量文档的单一事实源（P1-5）。
 *
 * - `extract`：从 README.md / README-zh.md 抽取表格 → docs/env-schema.json（一次性迁移用）
 * - `write`：用 schema 重写两个 README 的表格行
 * - `check`：校验 README 表格与 schema 完全一致（CI 用，漂移即失败）
 *
 * schema 按语言独立保存（en / zh 各自的小节与行），因为两份 README 的章节划分
 * 本来就不完全一致；`check` 还会输出「只在一种语言里出现的变量」作为跨语言漂移提示。
 *
 * 约定：`name` / `default` / `desc` 存的是**表格单元格原文**（含反引号），
 * 生成结果与手写格式逐字符一致。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = path.join(ROOT, 'docs', 'env-schema.json');
const READMES = {
    en: path.join(ROOT, 'README.md'),
    zh: path.join(ROOT, 'README-zh.md')
};

function rowKey(nameCell) {
    return nameCell.replace(/`/g, '').split('/')[0].trim().toLowerCase();
}

/** 解析 README：返回 [{ id, title, rows: [{ name, default, desc }] }] */
function parseReadme(file) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const sections = [];
    let section = null;
    let inTable = false;
    for (const line of lines) {
        const heading = line.match(/^####\s+(\d+)\.\s*(.*)$/);
        if (heading) {
            section = { id: Number(heading[1]), title: heading[2].trim(), rows: [] };
            sections.push(section);
            inTable = false;
            continue;
        }
        if (!section) {
            continue;
        }
        if (/^\|\s*(Variable|变量名)\s*\|/.test(line)) {
            inTable = true;
            continue;
        }
        if (!inTable) {
            continue;
        }
        if (!line.startsWith('|')) {
            inTable = false;
            continue;
        }
        if (/^\|[\s:|-]+\|?\s*$/.test(line)) {
            continue;
        }
        const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        if (cells.length < 3 || !cells[0].startsWith('`')) {
            continue;
        }
        section.rows.push({ name: cells[0], default: cells[1], desc: cells.slice(2).join(' | ') });
    }
    return sections;
}

function buildSchema() {
    return {
        $comment: '环境变量文档单一事实源：改这里后执行 npm run docs:env 再提交；CI 用 npm run check:docs 校验。',
        en: parseReadme(READMES.en),
        zh: parseReadme(READMES.zh)
    };
}

function renderRow(row) {
    return `| ${row.name} | ${row.default} | ${row.desc} |`;
}

function rewriteReadme(file, sections) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const out = [];
    let current = null;
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const heading = line.match(/^####\s+(\d+)\.\s*/);
        out.push(line);
        i += 1;
        if (heading) {
            current = sections.find((section) => section.id === Number(heading[1])) ?? null;
            continue;
        }
        if (current && /^\|\s*(Variable|变量名)\s*\|/.test(line)) {
            out.push(lines[i] ?? '| :--- | :--- | :--- |');
            i += 1;
            while (i < lines.length && lines[i].startsWith('|')) {
                i += 1;
            }
            for (const row of current.rows) {
                out.push(renderRow(row));
            }
            continue;
        }
    }
    return out.join('\n');
}

function check(schema) {
    const problems = [];
    for (const [lang, file] of Object.entries(READMES)) {
        const expectedSections = schema[lang] ?? [];
        const sections = parseReadme(file);
        const byId = new Map(sections.map((section) => [section.id, section]));
        for (const expected of expectedSections) {
            const actual = byId.get(expected.id);
            if (!actual) {
                problems.push(`${lang}: 缺少小节 ${expected.id}`);
                continue;
            }
            if (actual.rows.length !== expected.rows.length) {
                problems.push(`${lang}: 小节 ${expected.id} 行数 ${actual.rows.length} ≠ ${expected.rows.length}`);
            }
            expected.rows.forEach((row, index) => {
                const actualRow = actual.rows[index];
                if (!actualRow) {
                    return;
                }
                if (actualRow.name !== row.name) {
                    problems.push(`${lang}: 小节 ${expected.id} 第 ${index + 1} 行变量名 ${actualRow.name} ≠ ${row.name}`);
                }
                if (actualRow.default !== row.default) {
                    problems.push(`${lang}: ${row.name} 默认值 ${actualRow.default} ≠ ${row.default}`);
                }
                if (actualRow.desc !== row.desc) {
                    problems.push(`${lang}: ${row.name} 描述与 schema 不一致`);
                }
            });
        }
    }
    // 跨语言漂移也视为失败：新增变量必须两种语言同时补齐。
    const drift = crossLanguageDrift(schema);
    if (drift.onlyEn.length > 0) {
        problems.push(`zh 缺少变量（仅 en 有）: ${drift.onlyEn.join(', ')}`);
    }
    if (drift.onlyZh.length > 0) {
        problems.push(`en 缺少变量（仅 zh 有）: ${drift.onlyZh.join(', ')}`);
    }
    return problems;
}

function crossLanguageDrift(schema) {
    const keys = (lang) => new Set((schema[lang] ?? []).flatMap((section) => section.rows.map((row) => rowKey(row.name))));
    const en = keys('en');
    const zh = keys('zh');
    return {
        onlyEn: [...en].filter((key) => !zh.has(key)),
        onlyZh: [...zh].filter((key) => !en.has(key))
    };
}

const command = process.argv[2] ?? 'check';
const schemaPathRelative = path.relative(ROOT, SCHEMA_PATH);

if (command === 'extract') {
    const schema = buildSchema();
    mkdirSync(path.dirname(SCHEMA_PATH), { recursive: true });
    writeFileSync(SCHEMA_PATH, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    console.log(`schema written: ${schemaPathRelative}`);
} else if (command === 'write') {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    for (const [lang, file] of Object.entries(READMES)) {
        writeFileSync(file, rewriteReadme(file, schema[lang] ?? []), 'utf8');
    }
    console.log('README env tables rewritten from docs/env-schema.json.');
} else if (command === 'check') {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const problems = check(schema);
    if (problems.length > 0) {
        console.error(`❌ README env tables drifted from ${schemaPathRelative}:`);
        for (const problem of problems.slice(0, 30)) {
            console.error(`  - ${problem}`);
        }
        if (problems.length > 30) {
            console.error(`  ... and ${problems.length - 30} more`);
        }
        console.error('Edit docs/env-schema.json, then run `npm run docs:env` and commit.');
        process.exitCode = 1;
    } else {
        console.log(`✅ README env tables match ${schemaPathRelative}`);
    }
    const drift = crossLanguageDrift(schema);
    if (drift.onlyEn.length > 0) {
        console.warn(`⚠️  only in en: ${drift.onlyEn.join(', ')}`);
    }
    if (drift.onlyZh.length > 0) {
        console.warn(`⚠️  only in zh: ${drift.onlyZh.join(', ')}`);
    }
} else {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
}
