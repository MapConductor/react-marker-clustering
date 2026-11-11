import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'tsup';

// テスト用に src/*.ts をエントリごとに ESM へ束ね、import して返す。
// 出力は build/ 下の一時ディレクトリに置き、テスト終了時に消す。
// @mapconductor/js-sdk-core は dependencies なので外部扱いのまま実物を読む。
export async function buildSources(entries) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    mkdirSync(resolve(root, 'build'), { recursive: true });
    const outDir = mkdtempSync(resolve(root, 'build', 'clustering-tests-'));
    after(() => rmSync(outDir, { recursive: true, force: true }));
    const entry = Object.fromEntries(
        Object.entries(entries).map(([name, file]) => [name, resolve(root, file)]),
    );
    await build({
        entry,
        outDir, format: ['esm'], platform: 'node', splitting: false,
        dts: false, sourcemap: false, config: false, silent: true,
    });
    const modules = {};
    for (const name of Object.keys(entries)) {
        modules[name] = await import(pathToFileURL(resolve(outDir, `${name}.mjs`)));
    }
    return modules;
}
