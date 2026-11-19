import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

function files(dir: string): string[] {
    return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
    );
}

describe('архитектура: ядро знает только IMode и реестр', () => {
    it.each(['core', 'controller', 'jobs'])('в %s/ нет ссылок на конкретные режимы', (dir) => {
        for (const file of files(dir)) {
            const source = readFileSync(join(SRC, file), 'utf8');
            expect({
                file,
                santa: /modes\/santa|SantaMode|mode === '|santa'/.test(source),
            }).toEqual({
                file,
                santa: false,
            });
        }
    });

    it('ядро не импортирует контроллер', () => {
        for (const file of files('core')) {
            const source = readFileSync(join(SRC, file), 'utf8');
            expect({ file, controller: source.includes("'../controller") }).toEqual({
                file,
                controller: false,
            });
        }
    });
});
