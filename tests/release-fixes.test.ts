import { answerQuestion, IQuestion } from '../src/core/Wizard';
import { parseDate, parseDateTime } from '../src/core/time';
import { titleCaseName, T } from '../src/texts';
import { GiftMode } from '../src/modes/gift/GiftMode';
import { A, IPayload } from '../src/ui';
import { MODES } from '../src/modes/registry';
import { TestBot } from './helpers';

/** Локальное «сегодня» для разбора дат. */
const TODAY = '2026-11-08';

function codeOf(text: string): string {
    return /Код: ([A-Z0-9]{6})/.exec(text)![1];
}

function roomIdOf(reply: { text: string; buttons: { payload?: IPayload | null }[] }): string {
    const withRoom = reply.buttons.find((b) => typeof b.payload?.r === 'string');
    if (withRoom) {
        return withRoom.payload!.r as string;
    }
    return /r=([A-Za-z0-9]+)/.exec(reply.text)![1];
}

describe('Фиксы релиза: разбор дат', () => {
    it('parseDate: «сегодня» и «завтра»', () => {
        expect(parseDate('сегодня', TODAY)).toBe('2026-11-08');
        expect(parseDate('завтра', TODAY)).toBe('2026-11-09');
        expect(parseDate('сегодня 22:00', TODAY)).toBeNull();
        expect(parseDate('27 декабря', TODAY)).toBe('2026-12-27');
    });

    it('parseDateTime: «сегодня в 22:00», «завтра 9:00»', () => {
        expect(parseDateTime('сегодня в 22:00', TODAY)).toBe('2026-11-08T22:00');
        expect(parseDateTime('завтра 9:00', TODAY)).toBe('2026-11-09T09:00');
        expect(parseDateTime('сегодня', TODAY)).toBeNull();
        expect(parseDateTime('14 марта 19:00', TODAY)).toBe('2027-03-14T19:00');
        expect(parseDateTime('14 марта в 19:00', TODAY)).toBe('2027-03-14T19:00');
    });

    it('notPast у datetime отклоняет прошедшее время сегодня', () => {
        const question: IQuestion = { key: 'eventAt', prompt: '', type: 'datetime', notPast: true };
        const rejected = answerQuestion(
            question,
            { text: 'сегодня 08:00' },
            [],
            TODAY,
            `${TODAY}T12:00`,
        );
        expect(rejected.kind).toBe('retry');
        const accepted = answerQuestion(
            question,
            { text: 'сегодня 22:00' },
            [],
            TODAY,
            `${TODAY}T12:00`,
        );
        expect(accepted).toEqual({ kind: 'answer', value: '2026-11-08T22:00' });
    });

    it('чужая кнопка на вопросе мастера повторяет вопрос, а не пугает «слишком длинно»', () => {
        const wish: IQuestion = {
            key: 'wish',
            prompt: '',
            type: 'text',
            optional: true,
            maxLength: 300,
        };
        expect(answerQuestion(wish, { accept: true }, [], TODAY, `${TODAY}T12:00`).kind).toBe(
            'retry',
        );
        const spaces = answerQuestion(wish, { text: '   ' }, [], TODAY, `${TODAY}T12:00`);
        expect(spaces).toEqual({ kind: 'answer', value: '' });
    });
});

describe('Фиксы релиза: тексты и имена', () => {
    it('имена капитализуются: «пётр» → «Пётр», «анна петрова» → «Анна Петрова»', () => {
        expect(titleCaseName('пётр')).toBe('Пётр');
        expect(titleCaseName('анна петрова')).toBe('Анна Петрова');
        expect(titleCaseName('Маша')).toBe('Маша');
    });

    it('«удалить мои данные» без игр: без сбивающих нулей', () => {
        expect(T.forgotten(0, 0)).not.toContain('Удалено');
        expect(T.forgotten(2, 1)).toContain('Удалено игр: 2');
    });

    it('у «Тайного дарителя» есть вопрос повода, и он переживает клон', () => {
        expect(GiftMode.createQuestions.map((q) => q.key)).toEqual([
            'budget',
            'occasion',
            'eventDate',
        ]);
        const cloned = GiftMode.cloneSettings!({
            occasion: '8 Марта',
            budget: 'до 1000 ₽',
            eventDate: '2026-03-08',
            reminded: '1',
            nudged: '1',
        });
        expect(cloned.occasion).toBe('8 Марта');
        expect(cloned.eventDate).toBeUndefined();
        expect(cloned.reminded).toBeUndefined();
    });
});

describe('Фиксы релиза: живые сценарии', () => {
    it('повторное «Участвую» от участника показывает карточку, а не перезапускает знакомство', async () => {
        const t = new TestBot();
        try {
            const created = await t.createGame('owner', true);
            const code = codeOf(created.text);
            const roomId = roomIdOf(created);
            await t.join('anya', code, 'книгу');
            // Кнопка из старого сообщения: участник уже в игре
            const again = await t.alisaPress('anya', { action: A.join, r: roomId });
            expect(again.text).toContain('Вы уже участвуете в этой игре');
            expect(again.text).toContain('Вы: Anya');
            expect(again.text).not.toContain('Как вас подписать');
        } finally {
            await t.close();
        }
    });

    it('/start с битым кодом объясняет ошибку, а не молча показывает меню', async () => {
        const t = new TestBot();
        try {
            const menu = await t.alisa('newbie', '/start 9UGNNL');
            expect(menu.text).toContain('В коде нет');
            const plain = await t.alisa('newbie2', '/start');
            expect(plain.text).not.toContain('В коде нет');
        } finally {
            await t.close();
        }
    });

    it('выход из игры требует подтверждения; промах больше не стирает данные', async () => {
        const t = new TestBot();
        try {
            const created = await t.createGame('owner', true);
            const code = codeOf(created.text);
            const roomId = roomIdOf(created);
            await t.join('anya', code, 'книгу');
            const confirm = await t.alisaPress('anya', { action: A.leave, r: roomId });
            expect(confirm.text).toContain('Точно выйти из игры');
            expect(confirm.buttons.map((b) => b.title)).toEqual(['Да, выйти', 'Остаться']);
            // Передумала
            const stayed = await t.alisaPress('anya', { action: A.room, r: roomId });
            expect(stayed.text).toContain('Вы: Anya');
            await t.join('petya', code);
            await t.join('olya', code);
            // В закрытой игре выхода нет и подтверждение не показывается
            const menu = await t.alisa('owner', 'меню');
            const card = await t.alisaClick('owner', menu, 'Текущая игра');
            const drawConfirm = await t.alisaClick('owner', card, 'Провести жеребьёвку');
            await t.alisaClick('owner', drawConfirm, 'Да, провести');
            await t.app.notifier.whenIdle();
            const closed = await t.alisaPress('anya', { action: A.leave, r: roomId });
            expect(closed.text).toContain('состав игры не изменить');
            // Подтверждение выхода в закрытой игре не показывается вовсе
            expect(closed.text).not.toContain('Точно выйти');
        } finally {
            await t.close();
        }
    });

    it('карточка организатора после жеребёвки укладывается в лимит рядов, «Меню» на месте', async () => {
        const t = new TestBot();
        try {
            const created = await t.createGame('owner', true);
            const code = codeOf(created.text);
            const roomId = roomIdOf(created);
            await t.join('anya', code, 'книга');
            await t.join('petya', code, 'носки');
            await t.join('olya', code);
            const menu = await t.alisa('owner', 'меню');
            const current = await t.alisaClick('owner', menu, 'Текущая игра');
            const confirm = await t.alisaClick('owner', current, 'Провести жеребьёвку');
            await t.alisaClick('owner', confirm, 'Да, провести');
            await t.app.notifier.whenIdle();
            const card = await t.alisaPress('owner', { action: A.room, r: roomId });
            const titles = card.buttons.map((b) => b.title);
            // Самая широкая карточка: всё влезает в лимит, «Меню» не теряется
            expect(titles.length).toBeLessThanOrEqual(10);
            expect(titles).toContain('Меню');
            expect(titles).toContain('Ещё');
            expect(titles).toContain('Кому я дарю?');
            // Хвост с «Удалить игру» доступен через «Ещё»
            const more = await t.alisaClick('owner', card, 'Ещё');
            expect(more.text).toContain('Все действия этой игры');
            expect(more.buttons.map((b) => b.title)).toContain('Удалить игру');
        } finally {
            await t.close();
        }
    });

    it('чужая кнопка во время мастера повторяет вопрос и не теряет ответы', async () => {
        const t = new TestBot();
        try {
            const created = await t.createGame('owner', false);
            const code = codeOf(created.text);
            const roomId = roomIdOf(created);
            await t.alisa('anya', code.toLowerCase());
            await t.alisaPress('anya', { action: A.join, r: roomId });
            // Кнопка действия режима из чужого сообщения: мастер устоял
            const interrupted = await t.alisaPress('anya', { action: A.act, r: roomId, m: 'draw' });
            expect(interrupted.text).toContain('Сначала закончите заполнение');
            expect(interrupted.text).toContain('Как вас подписать');
            const named = await t.alisa('anya', 'Аня');
            expect(named.text).toContain('Напишите пожелание');
            const wished = await t.alisa('anya', 'книгу');
            expect(wished.text).toContain('Вы в игре');
        } finally {
            await t.close();
        }
    });

    it('у «Тайного дарителя» в карточке есть повод', async () => {
        const t = new TestBot({}, MODES);
        try {
            await t.alisa('owner', 'создать');
            await t.alisa('owner', 'Тайный даритель');
            await t.alisa('owner', 'Обмен сюрпризами');
            await t.alisa('owner', 'до 1000 ₽');
            await t.alisa('owner', '8 марта');
            await t.alisa('owner', '8 марта');
            const created = await t.alisa('owner', 'Только организую');
            expect(created.text).toContain('Повод: 8 марта');
            const code = codeOf(created.text);
            await t.join('anya', code);
        } finally {
            await t.close();
        }
    });
});
