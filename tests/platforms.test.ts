import { codeOf, roomIdOf, TestBot } from './helpers';
import { IPayload } from '../src/ui';

const VK_USER = 7001;
const VK_REF = 7002;
const MAX_USER = 8001;

function press(
    message: { buttons: { title: string; payload: IPayload | null }[] },
    title: string,
): IPayload {
    const payload = message.buttons.find((b) => b.title.startsWith(title))?.payload;
    if (!payload) {
        throw new Error(`Нет кнопки «${title}»: ${message.buttons.map((b) => b.title).join(', ')}`);
    }
    return payload;
}

describe('VK и MAX: одна игра в трёх мессенджерах', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('вход из VK по коду и по ref, из MAX по ссылке и кнопкой; жеребьёвка доходит каждому', async () => {
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        const roomId = roomIdOf(created);

        // VK: имя из профиля (users.get), участие кнопкой клавиатуры
        await t.vk(VK_USER, code);
        const preview = t.lastTo(VK_USER);
        expect(preview.text).toContain('Участвуете?');
        await t.vkClick(VK_USER, preview, 'Участвую');
        const askName = t.lastTo(VK_USER);
        expect(askName.text).toContain('«Вика Веткина»');
        await t.vkClick(VK_USER, askName, 'Да, так');
        await t.vk(VK_USER, 'пропустить');
        expect(t.lastTo(VK_USER).text).toContain('Вы в игре');

        // VK: вход по ссылке vk.me/<сообщество>?ref=<код> — параметр приходит событием start
        await t.vk(VK_REF, '', undefined, code);
        await t.vkClick(VK_REF, t.lastTo(VK_REF), 'Участвую');
        await t.vkClick(VK_REF, t.lastTo(VK_REF), 'Да, так');
        await t.vk(VK_REF, 'пропустить');

        // MAX: вход по ссылке max.ru/<бот>?start=<код>, кнопки — callback с payload-строкой.
        // Имя профиля MAX присылает в payload события start — оно предлагается кнопкой.
        await t.maxStart(MAX_USER, code);
        await t.maxPress(MAX_USER, press(t.lastTo(MAX_USER), 'Участвую'));
        expect(t.lastTo(MAX_USER).text).toContain('«Маша»');
        await t.maxPress(MAX_USER, press(t.lastTo(MAX_USER), 'Да, так'));
        await t.max(MAX_USER, 'пропустить');
        expect(t.lastTo(MAX_USER).text).toContain('Вы в игре');

        const participants = await t.app.service.store.participantsOf(roomId);
        expect(participants.map((p) => p.platform).sort()).toEqual([
            'alisa',
            'max_app',
            'vk',
            'vk',
        ]);
        expect(participants.find((p) => p.userId === String(VK_USER))?.name).toBe('Вика Веткина');

        // Жеребьёвка: результат приходит каждому в его мессенджер
        await t.act('owner', roomId, 'draw', undefined, true);
        await t.app.notifier.whenIdle();
        for (const userId of [VK_USER, VK_REF, MAX_USER]) {
            const result = t.lastTo(userId);
            expect(result.text).toMatch(/вы — Тайный Санта\. Ваш подопечный:/);
            // Кнопка пересылки от режима превращается в действие ядра
            expect(result.buttons.map((b) => b.title)).toContain('Анонимный вопрос подопечному');
        }

        // Кнопка VK-клавиатуры работает как действие режима
        await t.vkClick(VK_USER, t.lastTo(VK_USER), 'Кому я дарю?');
        expect(t.lastTo(VK_USER).text).toMatch(/вы — Тайный Санта\. Ваш подопечный:/);
        await t.maxPress(MAX_USER, press(t.lastTo(MAX_USER), 'Кому я дарю?'));
        expect(t.lastTo(MAX_USER).text).toMatch(/вы — Тайный Санта\. Ваш подопечный:/);
    });
});
