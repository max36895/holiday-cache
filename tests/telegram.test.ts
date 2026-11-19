import { A, IPayload } from '../src/ui';
import { ISentMessage, TestBot } from './helpers';

const OWNER = 1001;
const ANYA = 1002;
const PETYA = 1003;

function press(message: ISentMessage, title: string): IPayload {
    const payload = message.buttons.find((b) => b.title.startsWith(title))?.payload;
    if (!payload) {
        throw new Error(`Нет кнопки «${title}»: ${message.buttons.map((b) => b.title).join(', ')}`);
    }
    return payload;
}

describe('Telegram: рассылка через bot.send()', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
    });

    /** Организатор создаёт игру без бюджета и даты и только организует. */
    async function createGame(): Promise<{ code: string; roomId: string }> {
        await t.telegram(OWNER, '/start', 'Маша');
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Создать игру'));
        await t.telegram(OWNER, 'Офис 2026', 'Маша');
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Без бюджета'));
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Без даты'));
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Только организую'));
        const card = t.sent[t.sent.length - 2] as ISentMessage;
        const code = /Код: (\w{6})/.exec(card.text)?.[1] as string;
        return { code, roomId: press(card, 'Участники').r as string };
    }

    async function joinTelegram(
        id: number,
        code: string,
        name: string,
        wish: string,
    ): Promise<void> {
        await t.telegram(id, code, name);
        await t.telegramPress(id, press(t.lastTo(id), 'Участвую'));
        await t.telegramPress(id, press(t.lastTo(id), 'Да, так'));
        await t.telegram(id, wish, name);
    }

    it('карточка игры приходит первой, приглашение для пересылки — отдельным сообщением', async () => {
        const { code } = await createGame();
        const card = t.sent[t.sent.length - 2] as ISentMessage;
        const invite = t.lastTo(OWNER);
        expect(card.text).toContain('Игра создана');
        expect(card.text).toContain('Организатор: Маша');
        expect(invite.text).toContain(`https://t.me/rooms_test_bot?start=${code}`);
        expect(invite.text).toContain(`https://vk.me/rooms_test?ref=${code}`);
        expect(invite.text).toContain(`https://max.ru/rooms_test_bot?start=${code}`);
        expect(t.errors).toEqual([]);
    });

    it('вход по ссылке /start <код>: имя из профиля, уведомление организатору', async () => {
        const { code, roomId } = await createGame();
        await t.telegram(ANYA, `/start ${code}`, 'Аня');
        await t.telegramPress(ANYA, press(t.lastTo(ANYA), 'Участвую'));
        const askName = t.lastTo(ANYA);
        expect(askName.text).toContain('«Аня»');
        await t.telegramPress(ANYA, press(askName, 'Да, так'));
        await t.telegramPress(ANYA, press(t.lastTo(ANYA), 'Без пожелания'));
        expect(t.lastTo(ANYA).text).toContain('Вы в игре');
        await t.app.notifier.whenIdle();
        const notice = t.lastTo(OWNER);
        expect(notice.text).toBe('«Офис 2026»: в игре Аня (Telegram). Всего 1 участник.');
        expect(press(notice, 'Участники')).toEqual({ action: A.members, r: roomId });
        expect(t.errors).toEqual([]);
    });

    it('жеребьёвка рассылает результаты и отчёт организатору; Алисе писать первым нельзя', async () => {
        const { code, roomId } = await createGame();
        await joinTelegram(ANYA, code, 'Аня', 'подарок для Ани');
        await joinTelegram(PETYA, code, 'Петя', 'подарок для Пети');
        await t.join('olya', code);
        await t.app.notifier.whenIdle();

        await t.telegramPress(OWNER, { action: A.act, r: roomId, m: 'draw' });
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Да, провести'));
        expect(t.lastTo(OWNER).text).toContain('рассылаю');
        await t.app.notifier.whenIdle();

        for (const id of [ANYA, PETYA]) {
            const result = t.lastTo(id);
            expect(result.text).toMatch(/вы — Тайный Санта\. Ваш подопечный: (Аня|Петя|Olya)\./);
            expect(press(result, 'Кому я дарю?')).toEqual({ action: A.act, r: roomId, m: 'whom' });
        }
        const report = t.lastTo(OWNER);
        expect(report.text).toContain('результаты отправлены 2 из 3');
        expect(report.text).toContain('Не доставлено: Olya (Алиса)');

        await t.telegramPress(OWNER, press(report, 'К игре'));
        const card = t.lastTo(OWNER);
        expect(card.text).toContain('Результаты отправлены: 2 из 3');
        const before = t.sent.length;
        await t.telegramPress(OWNER, press(card, 'Повторить отправку'));
        await t.app.notifier.whenIdle();
        // Повтор шлёт только тем, кому не дошло: в Telegram — только ответ и новый отчёт организатору
        expect(t.sent.slice(before).every((m) => m.chatId === String(OWNER))).toBe(true);
        expect(t.errors).toEqual([]);
    });

    it('даритель узнаёт, что подопечный удалил данные', async () => {
        const { code, roomId } = await createGame();
        for (const user of ['a', 'b', 'c']) {
            await t.join(user, code);
        }
        await joinTelegram(ANYA, code, 'Аня', 'пропустить');
        await t.telegramPress(OWNER, { action: A.actOk, r: roomId, m: 'draw' });
        await t.app.notifier.whenIdle();

        const participants = await t.app.service.store.participantsOf(roomId);
        const anya = participants.find((p) => p.userId === String(ANYA));
        const recipient = participants.find((p) => p.id === anya?.recipientId);
        const ask = await t.alisa(recipient?.userId as string, 'удалить мои данные');
        await t.alisaClick(recipient?.userId as string, ask, 'Да, удалить всё');
        await t.app.notifier.whenIdle();
        expect(t.lastTo(ANYA).text).toBe(
            `«Офис 2026»: ваш подопечный ${recipient?.name} больше не участвует в игре. Напишите организатору.`,
        );
    });

    it('ошибка API Telegram делает доставку неудачной: отчёт организатору и повторная отправка', async () => {
        // umbot 3.1.6: bot.send() возвращает false, если платформа отклонила сообщение
        const { code, roomId } = await createGame();
        for (const user of ['a', 'b']) {
            await t.join(user, code);
        }
        await joinTelegram(ANYA, code, 'Аня', 'пропустить');
        t.blocked.add(String(ANYA));
        await t.telegramPress(OWNER, { action: A.actOk, r: roomId, m: 'draw' });
        await t.app.notifier.whenIdle();
        const anya = (await t.app.service.store.participantsOf(roomId)).find(
            (p) => p.userId === String(ANYA),
        );
        expect(anya?.delivery).toBe('failed');
        const report = t.lastTo(OWNER);
        // a и b — в Алисе, она не умеет писать первой; Аня — заблокировала бота
        expect(report.text).toContain('Не доставлено: A (Алиса), B (Алиса), Аня (Telegram).');

        // Аня разблокировала бота — повторная отправка доходит
        await t.telegramPress(OWNER, press(report, 'К игре'));
        t.blocked.delete(String(ANYA));
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Повторить отправку'));
        await t.app.notifier.whenIdle();
        expect(t.lastTo(ANYA).text).toMatch(/вы — Тайный Санта\. Ваш подопечный:/);
    });
});
