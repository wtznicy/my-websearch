import {
    searchContext7Libraries,
    fetchContext7Docs,
    Context7Library,
    Context7DocsResult
} from '../../engines/context7/context7.js';

export type Context7LibrariesService = {
    execute(input: { libraryName: string; query: string; limit?: number }): Promise<{
        query: string;
        libraryName: string;
        results: Context7Library[];
    }>;
};

export type Context7DocsService = {
    execute(input: { libraryId: string; query: string; limit?: number }): Promise<Context7DocsResult>;
};

export function createContext7Services() {
    return {
        libraries: {
            async execute(input: { libraryName: string; query: string; limit?: number }) {
                const libraryName = input.libraryName.trim();
                if (!libraryName) {
                    throw new Error('Library name cannot be empty');
                }
                return searchContext7Libraries(libraryName, input.query, input.limit ?? 5);
            }
        } satisfies Context7LibrariesService,
        docs: {
            async execute(input: { libraryId: string; query: string; limit?: number }) {
                return fetchContext7Docs(input.libraryId, input.query, input.limit ?? 5);
            }
        } satisfies Context7DocsService
    };
}
