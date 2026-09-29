import { describe, it, expect, vi } from 'vitest';
import { fetchContext7Docs, Context7GetImpl } from '../../engines/context7/context7.js';
import type { AxiosResponse } from 'axios';

describe('Context7 301 application-level redirect', () => {
    it('should follow 301 application-level redirect automatically and populate redirectedFrom and redirectUrl', async () => {
        const calls: string[] = [];
        const mockGet: Context7GetImpl = vi.fn(async (_url: string, params?: Record<string, unknown>): Promise<AxiosResponse> => {
            const libraryId = params?.libraryId as string;
            calls.push(libraryId);
            if (libraryId === '/facebook/react') {
                return {
                    status: 301,
                    statusText: 'Moved Permanently',
                    headers: {},
                    config: {} as AxiosResponse['config'],
                    data: {
                        error: 'library_redirected',
                        redirectUrl: '/react/react'
                    }
                } as AxiosResponse;
            }
            if (libraryId === '/react/react') {
                return {
                    status: 200,
                    statusText: 'OK',
                    headers: {},
                    config: {} as AxiosResponse['config'],
                    data: {
                        codeSnippets: [{
                            codeTitle: 'React Overview',
                            codeList: [{ code: 'import React from "react";' }]
                        }],
                        infoSnippets: [{
                            title: 'About React',
                            content: 'The library for web and native user interfaces'
                        }]
                    }
                } as AxiosResponse;
            }
            throw new Error(`Unexpected libraryId: ${libraryId}`);
        });

        const result = await fetchContext7Docs('/facebook/react', 'hooks', 5, 0, mockGet);

        expect(calls).toEqual(['/facebook/react', '/react/react']);
        expect(result.libraryId).toBe('/react/react');
        expect(result.redirectedFrom).toBe('/facebook/react');
        expect(result.redirectUrl).toBe('/react/react');
        expect(result.codeSnippets).toHaveLength(1);
        expect(result.codeSnippets[0]?.codeTitle).toBe('React Overview');
        expect(result.infoSnippets).toHaveLength(1);
    });

    it('should throw actionable error when redirected target cannot be fetched', async () => {
        const mockGet: Context7GetImpl = vi.fn(async (_url: string, params?: Record<string, unknown>): Promise<AxiosResponse> => {
            const libraryId = params?.libraryId as string;
            if (libraryId === '/facebook/react') {
                return {
                    status: 301,
                    statusText: 'Moved Permanently',
                    headers: {},
                    config: {} as AxiosResponse['config'],
                    data: {
                        error: 'library_redirected',
                        redirectUrl: '/react/react'
                    }
                } as AxiosResponse;
            }
            // Target fails
            const err = new Error('Not found') as Error & { response?: { status?: number } };
            err.response = { status: 404 };
            throw err;
        });

        await expect(fetchContext7Docs('/facebook/react', 'overview', 5, 0, mockGet))
            .rejects.toThrow(/Library \/facebook\/react has migrated to \/react\/react, but failed to fetch/);
    });
});
