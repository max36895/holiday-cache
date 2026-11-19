import { drawChain, drawGroups } from '../src/modes/shared/draw';

function ids(prefix: string, n: number): string[] {
    return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

/** Длина цикла, в который входит первый участник. */
function cycleLength(pairs: Map<string, string>, start: string): number {
    let length = 0;
    let current = start;
    do {
        current = pairs.get(current) as string;
        length++;
    } while (current !== start && length <= pairs.size);
    return length;
}

describe('drawChain', () => {
    it('на тысячах случайных составов строит одну цепочку без подарков себе и встречных пар', () => {
        for (let round = 0; round < 5000; round++) {
            const n = 3 + (round % 98);
            const list = ids('p', n);
            const pairs = drawChain(list);
            expect(pairs.size).toBe(n);
            expect(new Set(pairs.values()).size).toBe(n);
            for (const [giver, recipient] of pairs) {
                expect(giver).not.toBe(recipient);
                expect(pairs.get(recipient)).not.toBe(giver);
            }
            expect(cycleLength(pairs, list[0] as string)).toBe(n);
        }
    });

    it('двое дарят друг другу — других вариантов нет', () => {
        const pairs = drawChain(['a', 'b']);
        expect(pairs.get('a')).toBe('b');
        expect(pairs.get('b')).toBe('a');
    });

    it('все (n−1)! цепочки равновероятны', () => {
        const counts = new Map<string, number>();
        const rounds = 60000;
        for (let i = 0; i < rounds; i++) {
            const pairs = drawChain(['a', 'b', 'c', 'd']);
            const key = ['a', 'b', 'c', 'd'].map((id) => pairs.get(id)).join('');
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        expect(counts.size).toBe(6);
        for (const count of counts.values()) {
            // Ожидание 10000, отклонение больше 5% при таком числе раундов практически невозможно
            expect(Math.abs(count - rounds / 6)).toBeLessThan(rounds / 6 / 20);
        }
    });

    it('отклоняет меньше двух участников и повторяющиеся id', () => {
        expect(() => drawChain(['a'])).toThrow();
        expect(() => drawChain(['a', 'a', 'b'])).toThrow();
    });

    it('использует переданный источник случайности', () => {
        // random всегда 0: Саттоло сдвигает цепочку на один шаг
        expect([...drawChain(['a', 'b', 'c'], () => 0).entries()]).toEqual([
            ['a', 'b'],
            ['b', 'c'],
            ['c', 'a'],
        ]);
    });
});

describe('drawGroups', () => {
    it('на тысячах случайных составов каждый получатель получает подарок, каждый даритель дарит', () => {
        for (let round = 0; round < 5000; round++) {
            const givers = ids('g', 1 + (round % 13));
            const recipients = ids('r', 1 + ((round * 7) % 17));
            const pairs = drawGroups(givers, recipients);
            expect(pairs).toHaveLength(Math.max(givers.length, recipients.length));
            expect(new Set(pairs.map((p) => p.giver))).toEqual(new Set(givers));
            expect(new Set(pairs.map((p) => p.recipient))).toEqual(new Set(recipients));
            // Нагрузка распределена ровно: никто не дарит и не получает больше чем вдвое против остальных
            const perGiver = givers.map((g) => pairs.filter((p) => p.giver === g).length);
            const perRecipient = recipients.map(
                (r) => pairs.filter((p) => p.recipient === r).length,
            );
            expect(Math.max(...perGiver) - Math.min(...perGiver)).toBeLessThanOrEqual(1);
            expect(Math.max(...perRecipient) - Math.min(...perRecipient)).toBeLessThanOrEqual(1);
        }
    });

    it('кому выпадает двойная доля, решает случай', () => {
        const doubled = new Set<string>();
        for (let i = 0; i < 200; i++) {
            const pairs = drawGroups(['a', 'b', 'c'], ['x', 'y', 'z', 'w']);
            doubled.add(
                pairs.find((p, j) => pairs.findIndex((q) => q.giver === p.giver) !== j)
                    ?.giver as string,
            );
        }
        expect(doubled).toEqual(new Set(['a', 'b', 'c']));
    });

    it('отклоняет пустую группу и пересечение групп', () => {
        expect(() => drawGroups([], ['x'])).toThrow();
        expect(() => drawGroups(['a'], [])).toThrow();
        expect(() => drawGroups(['a', 'b'], ['b', 'c'])).toThrow();
    });
});
