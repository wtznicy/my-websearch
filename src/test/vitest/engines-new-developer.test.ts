import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { searchGithub } from '../../engines/github/searchGithub.js';
import { searchStackOverflow } from '../../engines/stackoverflow/stackoverflow.js';
import { searchHackerNews } from '../../engines/hackernews/hackernews.js';
import { searchArxiv } from '../../engines/arxiv/arxiv.js';

describe('New Developer Search Engines (github, stackoverflow, hackernews, arxiv)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('searchGithub', () => {
        it('parses GitHub issues and repository search results', async () => {
            const mockRequest = vi.spyOn(axios, 'request')
                // 1. Issues response
                .mockResolvedValueOnce({
                    status: 200,
                    data: {
                        total_count: 1,
                        items: [
                            {
                                title: 'Fix hydration mismatch in React 19',
                                html_url: 'https://github.com/facebook/react/issues/100',
                                state: 'closed',
                                body: 'This PR fixes hydration issues with Suspense boundary.',
                                user: { login: 'acdlite' },
                                created_at: '2026-01-01'
                            }
                        ]
                    },
                    headers: {}
                })
                // 2. Repos response (supplemental)
                .mockResolvedValueOnce({
                    status: 200,
                    data: {
                        total_count: 1,
                        items: [
                            {
                                full_name: 'facebook/react',
                                html_url: 'https://github.com/facebook/react',
                                description: 'The library for web and native user interfaces.',
                                stargazers_count: 220000,
                                language: 'JavaScript'
                            }
                        ]
                    },
                    headers: {}
                });

            const results = await searchGithub('react hydration mismatch', 5);
            expect(mockRequest).toHaveBeenCalled();
            expect(results).toHaveLength(2);
            expect(results[0].engine).toBe('github');
            expect(results[0].title).toBe('Fix hydration mismatch in React 19');
            expect(results[0].url).toBe('https://github.com/facebook/react/issues/100');
            expect(results[0].description).toContain('[CLOSED]');
            expect(results[0].description).toContain('@acdlite');

            expect(results[1].engine).toBe('github');
            expect(results[1].title).toBe('facebook/react');
            expect(results[1].description).toContain('★220000');
            expect(results[1].description).toContain('[JavaScript]');
        });
    });

    describe('searchStackOverflow', () => {
        it('parses Stack Exchange API results and decodes HTML entities in titles', async () => {
            vi.spyOn(axios, 'request').mockResolvedValueOnce({
                status: 200,
                data: {
                    items: [
                        {
                            title: 'How to use &quot;async/await&quot; with &lt;div&gt; in React?',
                            link: 'https://stackoverflow.com/questions/12345/async-await',
                            score: 88,
                            is_answered: true,
                            answer_count: 4,
                            tags: ['reactjs', 'async-await', 'javascript']
                        }
                    ]
                },
                headers: {}
            });

            const results = await searchStackOverflow('react async await', 5);
            expect(results).toHaveLength(1);
            expect(results[0].engine).toBe('stackoverflow');
            expect(results[0].title).toBe('How to use "async/await" with <div> in React?');
            expect(results[0].description).toContain('[Score: 88, Answers: 4, Accepted]');
            expect(results[0].description).toContain('[reactjs, async-await, javascript]');
        });
    });

    describe('searchHackerNews', () => {
        it('parses Algolia HN stories with points, comments, and author', async () => {
            vi.spyOn(axios, 'request').mockResolvedValueOnce({
                status: 200,
                data: {
                    hits: [
                        {
                            title: 'Show HN: MyWebSearch – AI Pair Programming Search Tool',
                            url: 'https://example.com/my-websearch',
                            points: 342,
                            author: 'dang',
                            num_comments: 128,
                            objectID: '9876543'
                        }
                    ],
                    nbHits: 1,
                    page: 0,
                    nbPages: 1
                },
                headers: {}
            });

            const results = await searchHackerNews('my-websearch', 5);
            expect(results).toHaveLength(1);
            expect(results[0].engine).toBe('hackernews');
            expect(results[0].title).toContain('Show HN: MyWebSearch');
            expect(results[0].url).toBe('https://example.com/my-websearch');
            expect(results[0].description).toContain('Points: 342');
            expect(results[0].description).toContain('Comments: 128');
            expect(results[0].description).toContain('@dang');
        });
    });

    describe('searchArxiv', () => {
        it('parses Atom XML feed extracting title, authors, published date, and abstract', async () => {
            const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
            <feed xmlns="http://www.w3.org/2005/Atom">
                <entry>
                    <id>https://arxiv.org/abs/2601.12345</id>
                    <published>2026-01-15T18:00:00Z</published>
                    <title>  Attention Is All You Need 2: Electric Boogaloo  </title>
                    <summary>  We introduce a novel transformer architecture with linear attention complexity.  </summary>
                    <author><name>Ashish Vaswani</name></author>
                    <author><name>Noam Shazeer</name></author>
                </entry>
            </feed>`;

            vi.spyOn(axios, 'request').mockResolvedValueOnce({
                status: 200,
                data: atomXml,
                headers: {}
            });

            const results = await searchArxiv('attention transformer', 5);
            expect(results).toHaveLength(1);
            expect(results[0].engine).toBe('arxiv');
            expect(results[0].title).toBe('Attention Is All You Need 2: Electric Boogaloo');
            expect(results[0].url).toBe('https://arxiv.org/abs/2601.12345');
            expect(results[0].description).toContain('[arXiv 2026-01-15, by Ashish Vaswani, Noam Shazeer]');
            expect(results[0].description).toContain('We introduce a novel transformer architecture');
        });
    });
});
