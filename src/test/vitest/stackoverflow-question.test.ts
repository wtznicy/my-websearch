import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import {
    isStackOverflowQuestionUrl,
    extractStackOverflowQuestionId,
    fetchStackOverflowQuestion
} from '../../engines/stackoverflow/fetchStackOverflow.js';
import { createWebFetchService } from '../../core/fetch/fetchServices.js';

describe('StackOverflow Question API Extractor', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('identifies StackOverflow question URLs correctly', () => {
        expect(isStackOverflowQuestionUrl('https://stackoverflow.com/questions/11227809/why-is-sorted')).toBe(true);
        expect(isStackOverflowQuestionUrl('https://stackoverflow.com/questions/73909490')).toBe(true);
        expect(isStackOverflowQuestionUrl('https://stackoverflow.com/tags')).toBe(false);
        expect(isStackOverflowQuestionUrl('https://stackoverflow.com/users/123')).toBe(false);
        expect(isStackOverflowQuestionUrl('https://example.com/questions/123')).toBe(false);
    });

    it('extracts question ID correctly', () => {
        expect(extractStackOverflowQuestionId('https://stackoverflow.com/questions/11227809/why-is-sorted')).toBe('11227809');
        expect(extractStackOverflowQuestionId('https://stackoverflow.com/questions/73909490')).toBe('73909490');
        expect(extractStackOverflowQuestionId('https://stackoverflow.com/tags')).toBeNull();
    });

    it('fetches question and top answers and formats into clean Markdown', async () => {
        vi.spyOn(axios, 'request')
            // Question response
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    items: [
                        {
                            question_id: 11227809,
                            title: 'Why is conditional &quot;branching&quot; faster?',
                            score: 36000,
                            body: '<p>Here is some <code>code</code> that explains branching.</p>',
                            tags: ['c++', 'performance']
                        }
                    ]
                },
                headers: {}
            })
            // Answers response
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    items: [
                        {
                            answer_id: 11227902,
                            score: 25000,
                            is_accepted: true,
                            body: '<p>You are a victim of branch prediction fail.</p>'
                        }
                    ]
                },
                headers: {}
            });

        const result = await fetchStackOverflowQuestion('https://stackoverflow.com/questions/11227809/why-is-conditional-branching-faster');
        expect(result).not.toBeNull();
        expect(result?.title).toBe('Why is conditional "branching" faster?');
        expect(result?.content).toContain('# Why is conditional "branching" faster?');
        expect(result?.content).toContain('**Score:** 36000 | **Tags:** c++, performance');
        expect(result?.content).toContain('victim of branch prediction fail');
        expect(result?.content).toContain('Accepted Answer (Score: 25000)');
    });

    it('integrates with createWebFetchService to intercept StackOverflow URLs', async () => {
        const mockFallback = vi.fn().mockResolvedValue({
            url: 'https://stackoverflow.com/questions/999',
            finalUrl: 'https://stackoverflow.com/questions/999',
            contentType: 'text/plain',
            title: 'fallback',
            content: 'fallback-content',
            totalLength: 16,
            startIndex: 0,
            truncated: false,
            retrievalMethod: 'request'
        });

        const service = createWebFetchService(mockFallback, {
            fetchStackOverflow: async () => ({
                title: 'Mock SO Question',
                content: '# Mock SO Question\n\nContent here'
            })
        });

        const res = await service.execute({
            url: 'https://stackoverflow.com/questions/999/test',
            maxChars: 1000
        });

        expect(mockFallback).not.toHaveBeenCalled();
        expect(res.title).toBe('Mock SO Question');
        expect(res.siteName).toBe('Stack Overflow');
        expect(res.content).toContain('Mock SO Question');
    });
});
