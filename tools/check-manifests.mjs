import { readFileSync } from 'node:fs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const pkg = readJson('package.json');
const server = readJson('server.json');

const errors = [];
const expect = (condition, message) => {
    if (!condition) errors.push(message);
};

expect(server.version === pkg.version, `server.json version ${server.version} != package.json ${pkg.version}`);
expect(server.packages?.[0]?.version === pkg.version, `server.json packages[0].version ${server.packages?.[0]?.version} != ${pkg.version}`);
expect(server.packages?.[0]?.identifier === pkg.name, `server.json package identifier ${server.packages?.[0]?.identifier} != ${pkg.name}`);
expect(server.name === 'io.github.wtznicy/my-websearch', `unexpected server.json name: ${server.name}`);
const normalizeRepo = (url) => String(url ?? '').replace(/\.git\/?$/, '');
expect(normalizeRepo(server.repository?.url) === normalizeRepo(pkg.repository?.url), 'server.json repository.url does not match package.json');

if (errors.length > 0) {
    console.error('Manifest version mismatch:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
}

console.log(`Manifests are in sync: ${pkg.name}@${pkg.version}`);
