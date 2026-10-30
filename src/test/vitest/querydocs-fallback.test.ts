import { describe, it, expect, vi } from 'vitest';
import {
    normalizeGitRepositoryUrl,
    fetchPackageDocsFallback,
    parseMavenCoordinates,
    extractMavenScmRepository
} from '../../core/docs/packageDocsFallback.js';
import { formatQueryDocsMarkdown } from '../../tools/handlers/queryDocsTool.js';

describe('queryDocs Package Fallback & Markdown Formatting', () => {
    describe('normalizeGitRepositoryUrl', () => {
        it('normalizes various Git and package repository URL formats', () => {
            expect(normalizeGitRepositoryUrl('git+https://github.com/expressjs/express.git'))
                .toBe('https://github.com/expressjs/express');

            expect(normalizeGitRepositoryUrl('github:facebook/react'))
                .toBe('https://github.com/facebook/react');

            expect(normalizeGitRepositoryUrl('git://github.com/lodash/lodash.git'))
                .toBe('https://github.com/lodash/lodash');

            expect(normalizeGitRepositoryUrl('ssh://git@github.com/owner/repo.git'))
                .toBe('https://github.com/owner/repo');

            expect(normalizeGitRepositoryUrl('git@github.com:psf/requests.git'))
                .toBe('https://github.com/psf/requests');

            expect(normalizeGitRepositoryUrl('git@gitee.com:mirrors/vue.git'))
                .toBe('https://gitee.com/mirrors/vue');

            expect(normalizeGitRepositoryUrl('expressjs/express'))
                .toBe('https://github.com/expressjs/express');
        });

        it('returns null for empty or invalid strings', () => {
            expect(normalizeGitRepositoryUrl('')).toBeNull();
            expect(normalizeGitRepositoryUrl('invalid-no-slash')).toBeNull();
        });
    });

    describe('Maven coordinates and SCM extraction', () => {
        it('parses group:artifact and optional version', () => {
            expect(parseMavenCoordinates('org.springframework:spring-core'))
                .toEqual({ groupId: 'org.springframework', artifactId: 'spring-core', version: undefined });
            expect(parseMavenCoordinates('com.google.guava:guava:33.0.0-jre'))
                .toEqual({ groupId: 'com.google.guava', artifactId: 'guava', version: '33.0.0-jre' });
        });

        it('rejects npm scopes and malformed coordinates', () => {
            expect(parseMavenCoordinates('@types/node')).toBeNull();
            expect(parseMavenCoordinates('only-one-part')).toBeNull();
            expect(parseMavenCoordinates('a:b:c:d')).toBeNull();
        });

        it('extracts SCM URL or project URL from a POM', () => {
            const scmPom = `<project><scm><url>https://github.com/spring-projects/spring-framework</url></scm></project>`;
            expect(extractMavenScmRepository(scmPom)).toBe('https://github.com/spring-projects/spring-framework');

            const connectionPom = `<project><scm><connection>scm:git:git://github.com/owner/repo.git</connection></scm></project>`;
            expect(extractMavenScmRepository(connectionPom)).toBe('https://github.com/owner/repo');

            const plainPom = `<project><url>https://example.com/docs</url></project>`;
            expect(extractMavenScmRepository(plainPom)).toBeNull();
        });
    });

    describe('formatQueryDocsMarkdown', () => {
        it('renders markdown with Source, Confidence, Repository and Warnings', () => {
            const formatted = formatQueryDocsMarkdown({
                libraryId: 'express',
                source: 'npm',
                confidence: 'high',
                repositoryUrl: 'https://github.com/expressjs/express',
                readme: '# Express\n\nFast, unopinionated, minimalist web framework.',
                warnings: ['Fallback to npm registry']
            });

            expect(formatted).toContain('# Docs: express');
            expect(formatted).toContain('> Source: npm | Confidence: high');
            expect(formatted).toContain('> Repository: https://github.com/expressjs/express');
            expect(formatted).toContain('> ⚠️ **Warning:** Fallback to npm registry');
            expect(formatted).toContain('# Express');
            expect(formatted).toContain('Fast, unopinionated, minimalist web framework.');
        });
    });
});
