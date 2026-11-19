import { IBotLinks } from '../config';
import { IActionOutcome, IRoomView } from '../core/RoomService';
import { formatDate, formatDateTime } from '../core/time';
import { IRoom } from '../core/types';
import { IQuestion } from '../core/Wizard';
import { IMode } from '../modes/IMode';
import { membersCount } from '../texts';
import { A, btn, IButton, packRows } from '../ui';
import {
    backToRoom,
    dispatch,
    IDeps,
    MENU_BUTTON,
    rememberVoiceButtons,
    reply,
    TCtx,
    userOf,
} from './context';

/**
 * Приглашение для пересылки: код и ссылки на бота во всех мессенджерах.
 *
 * @param room Комната
 * @param mode Режим комнаты
 * @param links Имена бота в мессенджерах
 * @returns Текст приглашения
 */
export function inviteText(room: IRoom, mode: IMode, links: IBotLinks): string {
    const where: string[] = [];
    if (links.telegram) {
        where.push(`Telegram — https://t.me/${links.telegram}?start=${room.code}`);
    }
    if (links.vk) {
        // umbot передаёт ref сообщения событием start: вход по ссылке как в Telegram и MAX
        where.push(`VK — https://vk.me/${links.vk}?ref=${room.code}`);
    }
    if (links.max) {
        where.push(`MAX — https://max.ru/${links.max}?start=${room.code}`);
    }
    if (links.alisa) {
        where.push(`Алиса — «Алиса, запусти навык ${links.alisa}», затем назовите код`);
    }
    // «Пришлите код сообщением» вместо «напишите код»: человек понимает, что кнопку
    // «Войти по коду» нажимать не нужно — код сам откроет игру
    const ask = `Пришлите боту код ${room.code} сообщением в удобном мессенджере`;
    return [
        `Приглашение в игру «${room.title}» (${mode.title}).`,
        where.length ? `${ask}:` : `${ask}.`,
        ...where,
    ].join('\n');
}

/**
 * Ответ на вопрос мастера в виде для людей.
 *
 * @param question Вопрос
 * @param value Сохранённый ответ
 * @returns Текст
 */
export function formatAnswer(question: IQuestion, value: string): string {
    switch (question.type) {
        case 'date':
        case 'daymonth':
            return formatDate(value);
        case 'datetime':
            return formatDateTime(value);
        case 'choice':
            return question.options?.find((o) => o.value === value)?.title ?? value;
        case 'list':
            return value.split('\n').join(', ');
        default:
            return value;
    }
}

function statusLine(view: IRoomView): string {
    const { room, mode, participants } = view;
    const status = {
        open: 'Идёт набор участников.',
        closed: `${mode.texts.closed}.`,
        finished: 'Игра завершена.',
    }[room.status];
    return `${status} В игре ${membersCount(participants.filter((p) => p.userId).length)}.`;
}

/** Ответы участника на вопросы режима с подписью: «Пожелание: книгу». */
function profileLines(mode: IMode, profile: Record<string, string>): string[] {
    return mode.joinQuestions
        .filter((q) => q.label)
        .map((q) => {
            const value = profile[q.key];
            return `${q.label}: ${value ? formatAnswer(q, value) : 'не указано'}`;
        });
}

function roomText(view: IRoomView): string {
    const { room, mode, participants, isOwner, me } = view;
    const lines = [mode.describe(room), `Код: ${room.code}`, statusLine(view)];
    const tracked = participants.filter((p) => p.userId && p.delivery);
    if (isOwner && tracked.length) {
        const sent = tracked.filter((p) => p.delivery === 'sent').length;
        lines.push(`Результаты отправлены: ${sent} из ${tracked.length}.`);
        if (tracked.some((p) => p.delivery === 'failed' && p.platform === 'alisa')) {
            lines.push(
                'Участники Алисы увидят результаты в карточке игры — попросите открыть меню бота.',
            );
        }
    }
    if (me) {
        // Имя может заканчиваться точкой («Мария К.»): не оставляем «К.. Пожелание»
        lines.push(
            [`Вы: ${me.name.replace(/\.+$/, '')}`, ...profileLines(mode, me.profile)].join('. '),
        );
    } else if (isOwner) {
        lines.push('Вы только организуете эту игру.');
    }
    return lines.join('\n');
}

/** Лимит кнопок на ответ у платформ: дальше — кнопка «Ещё». */
const BUTTON_LIMIT = 10;
const ERASE_TITLE = 'Удалить игру';

async function roomButtons(deps: IDeps, view: IRoomView, bc?: TCtx): Promise<IButton[]> {
    const { room, mode, me, isOwner } = view;
    const r = { r: room.id };
    // Порядок: анонимные сообщения → главное действие режима → организаторские →
    // обратимые личные → опасные. «Удалить игру» — последней, мимо неё труднее промахнуться.
    // Входящие и написать анонимно — наверху: для Алисы это единственный канал игры
    const buttons: IButton[] = [];
    const relays = mode.relay === 'none' || !me ? [] : await deps.service.store.relaysOf(room.id);
    if (deps.relay.targets(view).length) {
        buttons.push(btn(mode.texts.relay ?? 'Написать анонимно', A.write, r));
    }
    if (relays.some((relay) => relay.toId === me?.id && relay.status !== 'pending')) {
        buttons.push(btn('Входящие сообщения', A.inbox, r));
    }
    if (relays.some((relay) => relay.fromId === me?.id && relay.status === 'pending')) {
        buttons.push(btn('Мои сообщения', A.outbox, r));
    }
    buttons.push(...mode.actions(view).map((a) => btn(a.title, A.act, { ...r, m: a.id })));
    if (isOwner) {
        if (room.status === 'open') {
            buttons.push(btn('Приглашение', A.invite, r));
        }
        buttons.push(btn('Участники', A.members, r));
        if (room.status === 'finished') {
            buttons.push(btn('Сыграть ещё раз', A.again, r));
        }
    }
    if (me && room.status === 'open') {
        buttons.push(btn('Выйти из игры', A.leave, r));
    }
    if (isOwner) {
        buttons.push(btn(ERASE_TITLE, A.erase, r));
    }
    // Кнопок больше лимита платформы — не обрезаем молча, а прячем хвост за «Ещё».
    // «Меню» всегда на виду; «Удалить игру» уходит в «Ещё» вместе с редкими действиями
    if (bc && buttons.length > BUTTON_LIMIT - 2) {
        bc.userData.overflow = { roomId: room.id, buttons: buttons.slice(BUTTON_LIMIT - 2) };
        return [...buttons.slice(0, BUTTON_LIMIT - 2), btn('Ещё', A.more, r), MENU_BUTTON];
    }
    if (bc) {
        delete bc.userData.overflow;
    }
    return buttons.length + 1 <= BUTTON_LIMIT
        ? [...buttons, MENU_BUTTON]
        : [...packRows(buttons, BUTTON_LIMIT - 1, [ERASE_TITLE]), MENU_BUTTON];
}

/**
 * Карточка комнаты с кнопками по роли и статусу; комната становится текущей.
 *
 * @param deps Зависимости
 * @param bc Контроллер запроса
 * @param view Комната глазами пользователя
 * @param prefix Строка перед карточкой
 */
export async function renderRoom(
    deps: IDeps,
    bc: TCtx,
    view: IRoomView,
    prefix?: string,
): Promise<void> {
    // Голосовая история привязана к игре: у другой игры названия чужих кнопок вводят в заблуждение
    if (bc.userData.currentRoomId !== view.room.id) {
        delete bc.userData.voiceHistory;
        delete bc.userData.myRoomsHint;
    }
    // Набранный до выбора адресата черновик жил до следующего решения: возврат
    // в карточку означает, что человек передумал писать
    delete bc.userData.relayDraft;
    bc.userData.currentRoomId = view.room.id;
    const text = roomText(view);
    reply(bc, prefix ? `${prefix}\n\n${text}` : text, await roomButtons(deps, view, bc));
}

/**
 * Карточка новой комнаты и отдельным сообщением приглашение для пересылки.
 * Карточка уходит через bot.send() до ответа, чтобы приглашение пришло вторым.
 * Алиса не умеет писать первой — там оба текста в одном ответе.
 *
 * @param deps Зависимости
 * @param bc Контроллер запроса
 * @param view Новая комната
 * @param headline Заголовок карточки: «Сыграть ещё раз» объясняет, что перенеслось
 */
export async function renderCreated(
    deps: IDeps,
    bc: TCtx,
    view: IRoomView,
    headline = 'Игра создана!',
): Promise<void> {
    const invite = inviteText(view.room, view.mode, deps.settings.links);
    // Новая игра: набранный в предыдущей черновик анонимки больше не актуален
    delete bc.userData.relayDraft;
    bc.userData.currentRoomId = view.room.id;
    const card = `${headline}\n\n${roomText(view)}\n\nНиже — приглашение, перешлите его участникам.`;
    const cardButtons = await roomButtons(deps, view, bc);
    if (await deps.notifier.send(userOf(bc), card, cardButtons)) {
        // Карточка ушла отдельным сообщением, не через reply(): её кнопки всё равно
        // должны быть доступны голосом — «Написать анонимно», «Участники» и другие
        rememberVoiceButtons(bc, cardButtons);
        // Кнопка возврата: приглашение уходит для пересылки, а организатор не остаётся без управления
        reply(bc, invite, [backToRoom(view.room.id)]);
        return;
    }
    await renderRoom(deps, bc, view, `Игра создана! Приглашение для участников:\n\n${invite}`);
}

/**
 * Ответ на действие режима и запуск рассылки.
 *
 * @param deps Зависимости
 * @param bc Контроллер запроса
 * @param outcome Итог действия
 */
export async function renderOutcome(deps: IDeps, bc: TCtx, outcome: IActionOutcome): Promise<void> {
    const { room, result, outgoing } = outcome;
    dispatch(deps, outgoing);
    if (result.showRoom) {
        await renderRoom(deps, bc, await deps.service.view(userOf(bc), room.id), result.reply);
    } else {
        reply(bc, result.reply ?? 'Готово.', [backToRoom(room.id)]);
    }
}
