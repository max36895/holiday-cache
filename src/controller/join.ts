import { Bot } from 'umbot';
import { isCodeLike, parseCode } from '../core/codes';
import { WRONG_CODES_PER_HOUR } from '../core/CodeGuard';
import { isOwner } from '../core/RoomService';
import { IRoom, IUserRef } from '../core/types';
import { membersCount, T } from '../texts';
import { A, btn, IButton } from '../ui';
import {
    command,
    IDeps,
    inputText,
    MENU_BUTTON,
    MENU_BUTTONS,
    profileName,
    reply,
    requireRoomId,
    step,
    TCtx,
    userOf,
} from './context';
import { renderRoom } from './view';
import { startWizard } from './wizard';

const STEP_CODE = 'join_code';

async function showPreview(deps: IDeps, bc: TCtx, room: IRoom): Promise<void> {
    const user = userOf(bc);
    const participants = await deps.service.store.participantsOf(room.id);
    if (
        isOwner(room, user) ||
        participants.some((p) => p.platform === user.platform && p.userId === user.userId)
    ) {
        await renderRoom(deps, bc, await deps.service.view(user, room.id));
        return;
    }
    const mode = deps.service.modes.get(room.mode);
    let card = `${mode.describe(room)}\n${
        participants.length
            ? `В игре ${membersCount(participants.length)}.`
            : 'Будете первым участником.'
    }`;
    if (room.status !== 'open') {
        // В превью нет статусной строки карточки — называем причину прямо здесь
        reply(bc, `${card}\n\n${mode.texts.closed}. Войти в эту игру нельзя.`, [MENU_BUTTON]);
        return;
    }
    if (participants.length >= mode.maxParticipants) {
        reply(
            bc,
            `${card}\n\nВ игре уже максимальное количество участников (${mode.maxParticipants}) — мест нет.`,
            [MENU_BUTTON],
        );
        return;
    }
    // Человек мог перепутать коды: тихо записать его во вторую игру было бы невежливо
    const participations = await deps.service.store.participationsOf(user);
    const otherRooms = (
        await Promise.all(
            participations
                .map((p) => p.roomId)
                .filter((id) => id !== room.id)
                .map((id) => deps.service.store.findRoom(id)),
        )
    ).filter((r): r is IRoom => r !== null && r.status !== 'finished');
    if (otherRooms.length) {
        const more = otherRooms.length > 1 ? ` и ещё ${otherRooms.length - 1}` : '';
        card += `\n\nКстати, вы уже участвуете в игре «${otherRooms[0].title}»${more}.`;
    }
    // Имя из профиля есть только у текстового сообщения: запоминаем его до нажатия кнопки
    const name = profileName(bc);
    bc.userData.joinHint = { roomId: room.id, ...(name ? { profileName: name } : {}) };
    reply(bc, `${card}\n\nУчаствуете?`, [
        btn('Участвую', A.join, { r: room.id }),
        btn('Отмена', A.menu),
    ]);
}

/**
 * Обрабатывает присланный код: карточка комнаты для входа или ошибка.
 * Неверные коды считаются — подбор ограничен CodeGuard.
 *
 * @param deps Зависимости
 * @param bc Контроллер запроса
 * @param code Код комнаты
 */
export async function handleCode(deps: IDeps, bc: TCtx, code: string): Promise<void> {
    const user = userOf(bc);
    // Завершённая игра по коду находится: человек должен понять, что код верный,
    // а игра закончилась, — и не перебирать код заново
    const found = await deps.service.store.findRoomByCode(code);
    if (!found) {
        // Лимит учитывает только неверные коды: верный код во время паузы работает —
        // найденный код не даёт подбирать чужие, а человек с верным кодом не виноват
        if (deps.guard.isBlocked(user)) {
            reply(bc, T.tooManyCodes, [MENU_BUTTON]);
            return;
        }
        deps.guard.registerWrong(user);
        reply(bc, withAttemptsLeft(deps, user, T.wrongCode), MENU_BUTTONS);
        return;
    }
    if (found.status === 'finished') {
        reply(bc, T.finishedCode(found.title), [MENU_BUTTON]);
        return;
    }
    if (deps.service.isBanned(found, user)) {
        // Причина не называется: по отказу не видно, что игра шла о жалобе
        reply(bc, T.closedForJoin, [MENU_BUTTON]);
        return;
    }
    await showPreview(deps, bc, found);
}

/**
 * Количество оставшихся попыток после неверной: с седьмой человек видит счётчик,
 * а на последней — явное «это последняя», а не молчаливый бан следующим кодом.
 */
function withAttemptsLeft(deps: IDeps, user: IUserRef, text: string): string {
    const left = WRONG_CODES_PER_HOUR - deps.guard.attempts(user);
    const tail = left === 0 ? T.lastAttempt : left <= 3 ? T.attemptsLeft(left) : '';
    return tail ? `${text}\n${tail}` : text;
}

/** Подсказка про запрещённые символы кода: считается попыткой, как и неверный код. */
export function replyCodeHint(deps: IDeps, bc: TCtx, buttons: readonly IButton[]): void {
    const user = userOf(bc);
    deps.guard.registerWrong(user);
    reply(bc, withAttemptsLeft(deps, user, T.codeHint), buttons);
}

/**
 * Регистрирует вход в игру: запрос кода и кнопку «Участвую».
 *
 * @param bot Бот
 * @param deps Зависимости
 */
export function registerJoin(bot: Bot, deps: IDeps): void {
    bot.addAction(
        A.joinAsk,
        command((bc) => {
            bc.thisIntentName = STEP_CODE;
            reply(bc, T.askCode, [btn('Отмена', A.menu)]);
        }),
    );

    bot.addStep(
        STEP_CODE,
        step(async (bc) => {
            const text = inputText(bc);
            const code = parseCode(text);
            if (!code) {
                if (isCodeLike(text)) {
                    // Похоже на код, но в алфавите кода таких символов нет
                    replyCodeHint(deps, bc, [MENU_BUTTON]);
                    return;
                }
                // Кнопка или команда — не код: пусть её обработают обычные команды
                return false;
            }
            await handleCode(deps, bc, code);
        }),
    );

    bot.addAction(
        A.join,
        command((bc) => joinRoom(deps, bc, requireRoomId(bc))),
    );
}

/**
 * Вход в игру после подтверждения: карточка для уже состоявших, мастер для новых.
 * Отдельная функция, потому что «да» на превью «Участвуете?» приходит текстом
 * (пользователь без экрана не видит кнопку) и попадает в обработчик fallback.
 *
 * @param deps Зависимости
 * @param bc Контроллер запроса
 * @param roomId id комнаты
 */
export async function joinRoom(deps: IDeps, bc: TCtx, roomId: string): Promise<void> {
    const room = await deps.service.store.findRoom(roomId);
    if (room?.status !== 'open') {
        reply(bc, T.closedForJoin, [MENU_BUTTON]);
        return;
    }
    // Кнопку могли нажать из старого сообщения уже состоявшим участником:
    // карточка вместо повторного знакомства
    try {
        const view = await deps.service.view(userOf(bc), roomId);
        await renderRoom(deps, bc, view, 'Вы уже участвуете в этой игре.');
        return;
    } catch {
        // Не участник и не организатор — идём в мастер входа
    }
    const hint = bc.userData.joinHint;
    const name = hint?.roomId === roomId ? hint.profileName : profileName(bc);
    delete bc.userData.joinHint;
    await startWizard(deps, bc, {
        kind: 'join',
        roomId,
        ownerJoin: false,
        ...(name ? { profileName: name } : {}),
    });
}
