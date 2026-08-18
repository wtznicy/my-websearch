import { normalizeText } from '../utils/text.js';

function assertEqual(actual: string, expected: string, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected "${expected}", got "${actual}"`);
    }
}

// 空白压缩：多空格/换行/tab 合并为单个空格
assertEqual(normalizeText('hello   world'), 'hello world', 'multiple spaces collapse');
assertEqual(normalizeText('line1\nline2'), 'line1 line2', 'newline collapses');
assertEqual(normalizeText('a\tb'), 'a b', 'tab collapses');
assertEqual(normalizeText('   leading and trailing   '), 'leading and trailing', 'trims edges');
assertEqual(normalizeText(''), '', 'empty stays empty');
assertEqual(normalizeText('中文  空格'), '中文 空格', 'chinese spaces collapse');

console.log('✅ normalizeText: all cases passed');
