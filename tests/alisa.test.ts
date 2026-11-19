import { codeOf, roomIdOf, TestBot } from './helpers';

describe('Алиса: пушей нет, всё читается в карточке игры', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('анонимные вопросы видны во «Входящих сообщениях» карточки', async () => {
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        await t.join('anya', code);
        await t.join('petya', code);
        await t.act('owner', roomId, 'draw', undefined, true);
        const card = await t.alisaClick('owner', await t.alisa('owner', 'мои игры'), 'Офис 2026');
        // Алисе пуш не доставляется — счётчик честный, но с пояснением
        expect(card.text).toContain('Результаты отправлены: 0 из 3');
        expect(card.text).toContain('в карточке игры');

        // Организатор анонимно спрашивает своего подопечного
        await t.alisaClick('owner', card, 'Анонимный вопрос подопечному');
        const sent = await t.alisa('owner', 'Ты любишь детективы?');
        expect(sent.text).toContain('Сообщение отправлено');
        await t.app.notifier.whenIdle();

        // Получатель не получил пуш, но видит вопрос в карточке и отвечает
        const participants = await t.app.service.store.participantsOf(roomId);
        const owner = participants.find((p) => p.userId === 'owner');
        const recipientId = participants.find((p) => p.id === owner?.recipientId)?.userId as string;
        const recipientCard = await t.alisaClick(
            recipientId,
            await t.alisa(recipientId, 'мои игры'),
            'Офис 2026',
        );
        const inbox = await t.alisaClick(recipientId, recipientCard, 'Входящие сообщения');
        expect(inbox.text).toContain('Ты любишь детективы?');
        await t.alisaClick(recipientId, inbox, 'Ответить анонимно');
        const answer = await t.alisa(recipientId, 'Да, особенно классические');
        expect(answer.text).toContain('Сообщение отправлено');

        // Ответ виден организатору во входящих
        const ownerCard = await t.alisaClick(
            'owner',
            await t.alisa('owner', 'мои игры'),
            'Офис 2026',
        );
        const ownerInbox = await t.alisaClick('owner', ownerCard, 'Входящие сообщения');
        expect(ownerInbox.text).toContain('Да, особенно классические');
    });

    it('вход в заполненную комнату отклоняется на превью', async () => {
        const created = await t.createGame('owner', false);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        for (let i = 0; i < 100; i++) {
            await t.app.service.join(
                { platform: 'alisa', userId: `u${i}` },
                roomId,
                `Участник ${i}`,
                {},
            );
        }
        const preview = await t.alisa('newcomer', code);
        expect(preview.text).toContain('максимальное количество участников (100)');
        expect(preview.buttons.map((b) => b.title)).toEqual(['Меню']);
    });
});
