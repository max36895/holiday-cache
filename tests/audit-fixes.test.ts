import { createApp } from '../src/app';
import { RoomError } from '../src/core/RoomError';
import { IAppSettings } from '../src/config';
import { A, clipChars, clipText, IPayload } from '../src/ui';
import { TestBot } from './helpers';

/** Ни одна UTF-16 единица не осталась без пары: разрезанный эмодзи ломает JSON платформ. */
function expectNoLoneSurrogates(text: string): void {
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        expect(code < 0xd800 || code > 0xdfff).toBe(true);
    }
}

const SETTINGS: IAppSettings = {
    host: '127.0.0.1',
    port: 0,
    links: {},
    sendDelayMs: 0,
    sqliteFile: ':memory:',
};

describe('релей Telegram API через воркер (httpClient из settings)', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it('Telegram уходит на воркер с секретом и таймаутом, остальные платформы — напрямую', async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
            calls.push({ url: String(url), init });
            return Response.json({ ok: true, result: {} });
        }) as typeof fetch;
        const app = createApp({
            ...SETTINGS,
            tgWorkerUrl: 'https://tg-worker.example/',
            tgApiSecret: 's3cr3t',
        });

        await app.bot.getAppContext().httpClient('https://api.telegram.org/bot1:test/sendMessage', {
            method: 'POST',
            body: '{"chat_id":1}',
        });
        expect(calls[0]?.url).toBe('https://tg-worker.example/bot1:test/sendMessage');
        const headers = new Headers(calls[0]?.init?.headers);
        expect(headers.get('x-secret')).toBe('s3cr3t');
        expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);

        await app.bot.getAppContext().httpClient('https://api.vk.ru/method/messages.send', {
            method: 'POST',
            body: '',
        });
        expect(calls[1]?.url).toBe('https://api.vk.ru/method/messages.send');
        expect(new Headers(calls[1]?.init?.headers).get('x-secret')).toBeNull();

        await app.bot.close();
    });

    it('без TG_WORKER_URL клиент не подменяется: запросы идут напрямую', async () => {
        const calls: { url: string }[] = [];
        globalThis.fetch = (async (url: unknown) => {
            calls.push({ url: String(url) });
            return Response.json({ ok: true, result: {} });
        }) as typeof fetch;
        const app = createApp(SETTINGS);
        await app.bot
            .getAppContext()
            .httpClient('https://api.telegram.org/bot1:test/sendMessage', { method: 'POST' });
        expect(calls[0]?.url).toBe('https://api.telegram.org/bot1:test/sendMessage');
        await app.bot.close();
    });
});

describe('кнопка «Помощь» не теряет мастера', () => {
    let t: TestBot;
    let helpPayload: IPayload;

    beforeEach(async () => {
        t = new TestBot();
        const menu = await t.alisa('owner', 'меню');
        const button = menu.buttons.find((b) => b.title === 'Помощь');
        expect(button?.payload).toBeTruthy();
        helpPayload = button!.payload as IPayload;
        // Мастер создания: «создать» открывает вопрос названия (режим один — выбор пропущен)
        await t.alisa('owner', 'создать');
    });

    afterEach(async () => {
        await t.close();
    });

    it('нажатие «Помощь» из старого меню повторяет вопрос и сохраняет черновик', async () => {
        const afterHelp = await t.alisaPress('owner', helpPayload);
        expect(afterHelp.text).toContain('Как играть');
        // Текущий вопрос вернулся: черновик жив
        expect(afterHelp.text).toContain('Как назовём игру?');
        // Мастер продолжается обычным ответом
        const afterTitle = await t.alisa('owner', 'Хелп-тест');
        expect(afterTitle.text).not.toContain('Не понял');
        expect(afterTitle.text).toContain('юджет');
    });

    it('текстовая «помощь» тоже возвращает к вопросу', async () => {
        const afterHelp = await t.alisa('owner', 'помощь');
        expect(afterHelp.text).toContain('Как играть');
        expect(afterHelp.text).toContain('Как назовём игру?');
        const afterTitle = await t.alisa('owner', 'Хелп-текст');
        expect(afterTitle.text).toContain('юджет');
    });
});

describe('renameOwner: имя организатора под блокировкой', () => {
    let t: TestBot;

    beforeEach(async () => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
    });

    it('имя сохраняется и не затирает изменения, сделанные рядом', async () => {
        // Первый запрос создаёт таблицы umbot — как на первом вебхуке в проде
        await t.alisa('own', 'меню');
        const room = await t.app.service.createRoom(
            { platform: 'alisa', userId: 'own' },
            t.app.service.modes.get('santa'),
            'Имя организатора',
            {},
        );
        // Вход участника, затем rename — оба изменения должны остаться в базе
        const { participant } = await t.app.service.join(
            { platform: 'telegram', userId: '701' },
            room.id,
            'Пётр',
            {},
        );
        expect(participant.name).toBe('Пётр');
        await t.app.service.renameOwner(room.id, 'Аня');

        const fresh = await t.app.service.store.findRoom(room.id);
        expect(fresh?.settings.ownerName).toBe('Аня');
        const participants = await t.app.service.store.participantsOf(room.id);
        expect(participants).toHaveLength(1);
        expect(participants[0]?.name).toBe('Пётр');

        // Повторный rename с тем же именем ничего не перезаписывает
        await t.app.service.renameOwner(room.id, 'Аня');
        const stable = await t.app.service.store.findRoom(room.id);
        expect(stable?.settings.ownerName).toBe('Аня');
        expect(await t.app.service.store.participantsOf(room.id)).toHaveLength(1);
    });
});

describe('обрезка строк не рвёт эмодзи', () => {
    it('clipChars режет по кодовым точкам', () => {
        const clipped = clipChars('🎁'.repeat(45), 40);
        expect([...clipped]).toHaveLength(40);
        expectNoLoneSurrogates(clipped);
        expect(clipChars('коротко', 40)).toBe('коротко');
    });

    it('clipText на границе лимита остаётся валидным текстом', () => {
        const long = `Строка списков ${'🎁'.repeat(2400)}`;
        const clipped = clipText(long);
        expectNoLoneSurrogates(clipped);
        expect(clipped.length).toBeLessThan(long.length);
    });

    it('имя участника из эмодзи сохраняется целиком', async () => {
        const t = new TestBot();
        try {
            await t.alisa('own', 'меню');
            const room = await t.app.service.createRoom(
                { platform: 'alisa', userId: 'own' },
                t.app.service.modes.get('santa'),
                'Эмодзи',
                {},
            );
            const { participant } = await t.app.service.join(
                { platform: 'telegram', userId: '702' },
                room.id,
                '🎁'.repeat(45),
                {},
            );
            expect([...participant.name]).toHaveLength(40);
            expectNoLoneSurrogates(participant.name);
        } finally {
            await t.close();
        }
    });
});

describe('выключенный режим комнаты', () => {
    it('modes.get() бросает RoomError с понятным текстом', () => {
        const t = new TestBot();
        expect(() => t.app.service.modes.get('removed-mode')).toThrow(RoomError);
        expect(() => t.app.service.modes.get('removed-mode')).toThrow('временно недоступна');
    });
});

describe('меню содержит кнопку «Помощь»', () => {
    it('действие кнопки — rb_help', async () => {
        const t = new TestBot();
        try {
            const menu = await t.alisa('s-user', 'меню');
            const button = menu.buttons.find((b) => b.title === 'Помощь');
            expect(button?.payload?.action).toBe(A.help);
        } finally {
            await t.close();
        }
    });
});
