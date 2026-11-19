import { randomInt } from 'node:crypto';

/** Источник случайности: целое из [0, max). */
export type TRandom = (max: number) => number;

function assertUnique(ids: readonly string[]): void {
    if (new Set(ids).size !== ids.length) {
        throw new Error('Идентификаторы участников повторяются');
    }
}

/** Перемешивание Фишера — Йетса. */
function shuffle(ids: readonly string[], random: TRandom): string[] {
    const list = [...ids];
    for (let i = list.length - 1; i > 0; i--) {
        const j = random(i + 1);
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

/**
 * Жеребьёвка одной цепочкой, алгоритм Саттоло: участники встают в одну цепочку
 * (А → Б → В → … → А). Никто не дарит себе, а при 3 и более участниках нет пар
 * «дарят друг другу». Каждая из (n−1)! цепочек равновероятна.
 *
 * @param ids Идентификаторы участников, не меньше двух
 * @param random Источник случайности. По умолчанию crypto.randomInt
 * @returns Кто кому дарит: id дарителя → id получателя
 * @throws Error, если участников меньше двух или id повторяются
 *
 * @example
 * ```ts
 * const pairs = drawChain(['a', 'b', 'c']); // например, a → c, c → b, b → a
 * ```
 */
export function drawChain(
    ids: readonly string[],
    random: TRandom = randomInt,
): Map<string, string> {
    if (ids.length < 2) {
        throw new Error('Для жеребьёвки нужно хотя бы два участника');
    }
    assertUnique(ids);
    const order = [...ids];
    for (let i = order.length - 1; i > 0; i--) {
        // j строго меньше i: в отличие от Фишера — Йетса элемент не остаётся на месте
        const j = random(i);
        [order[i], order[j]] = [order[j], order[i]];
    }
    const pairs = new Map<string, string>();
    ids.forEach((id, i) => pairs.set(id, order[i]));
    return pairs;
}

/**
 * Жеребьёвка между двумя группами: каждый получатель получает один подарок.
 * Дарителей меньше — часть дарителей дарит двоим; больше — лишние дарят вдвоём
 * одному получателю. Кому выпадает двойная доля, решает случай.
 *
 * @param givers Дарители, не меньше одного
 * @param recipients Получатели, не меньше одного; с дарителями не пересекаются
 * @param random Источник случайности. По умолчанию crypto.randomInt
 * @returns Пары даритель → получатель: каждый участник обеих групп входит хотя бы в одну
 * @throws Error, если группа пуста или группы пересекаются
 *
 * @example
 * ```ts
 * drawGroups(['a', 'b'], ['x', 'y', 'z']); // например, a → y, b → x, a → z
 * ```
 */
export function drawGroups(
    givers: readonly string[],
    recipients: readonly string[],
    random: TRandom = randomInt,
): { giver: string; recipient: string }[] {
    if (!givers.length || !recipients.length) {
        throw new Error('В каждой группе нужен хотя бы один участник');
    }
    assertUnique([...givers, ...recipients]);
    const g = shuffle(givers, random);
    const r = shuffle(recipients, random);
    const pairs: { giver: string; recipient: string }[] = [];
    for (let i = 0; i < Math.max(g.length, r.length); i++) {
        pairs.push({ giver: g[i % g.length], recipient: r[i % r.length] });
    }
    return pairs;
}
