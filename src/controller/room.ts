import { Bot } from 'umbot';
import { RoomError } from '../core/RoomError';
import { IRoomView } from '../core/RoomService';
import { participantLabel, T } from '../texts';
import { A, btn, IButton, readPayload } from '../ui';
import {
    backToRoom,
    command,
    IDeps,
    MENU_BUTTON,
    reply,
    requireRoomId,
    TCtx,
    userOf,
} from './context';
import { inviteText, renderCreated, renderOutcome, renderRoom } from './view';
import { startWizard } from './wizard';

/** Участников на странице: 6 кнопок «Исключить» по две в ряд + навигация укладываются в 10 кнопок VK. */
const PAGE_SIZE = 6;

const DELIVERY_TEXT: Readonly<Record<string, string>> = {
    pending: 'отправляется',
    sent: 'результаты отправлены',
    failed: 'результаты не доставлены',
};

function renderMembers(bc: TCtx, view: IRoomView, page: number): void {
    const { room, participants } = view;
    const pages = Math.max(1, Math.ceil(participants.length / PAGE_SIZE));
    const current = Math.min(Math.max(page, 0), pages - 1);
    const slice = participants.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
    const active = participants.filter((p) => p.userId).length;
    // В списке остаются и выбывшие (их пары помнят другие): чтобы число в заголовке
    // не расходилось с карточкой, показываем оба числа
    const count =
        active === participants.length
            ? `${participants.length}`
            : `в игре ${active} из ${participants.length}`;
    const lines = [`Участники «${room.title}» (${count}):`];
    slice.forEach((p, i) => {
        const delivery = p.delivery && p.userId ? ` — ${DELIVERY_TEXT[p.delivery]}` : '';
        lines.push(`${current * PAGE_SIZE + i + 1}. ${participantLabel(p)}${delivery}`);
    });
    if (!participants.length) {
        lines.push('Пока никого. Перешлите приглашение участникам.');
    }
    const buttons: IButton[] = [];
    if (room.status === 'open') {
        slice.forEach((p, i) => {
            buttons.push({
                ...btn(`Исключить: ${p.name}`, A.kick, { x: p.id }),
                row: i % 2 === 0 && i < slice.length - 1,
            });
        });
    }
    if (pages > 1) {
        lines.push(`Страница ${current + 1} из ${pages}.`);
        buttons.push(
            { ...btn('← Назад', A.members, { r: room.id, pg: current - 1 }), row: true },
            btn('Далее →', A.members, { r: room.id, pg: current + 1 }),
        );
    }
    reply(bc, lines.join('\n'), [...buttons, backToRoom(room.id)]);
}

async function ownerView(deps: IDeps, bc: TCtx): Promise<IRoomView> {
    const view = await deps.service.view(userOf(bc), requireRoomId(bc));
    if (!view.isOwner) {
        throw new RoomError('Это может сделать только организатор игры.');
    }
    return view;
}

/** «Сыграть ещё раз»: клон с объяснением, что перенеслось, а что задают заново. */
async function playAgain(deps: IDeps, bc: TCtx): Promise<void> {
    const source = await ownerView(deps, bc);
    // Событийные режимы без опциональной даты (валентинки, встреча) должны
    // получить новую дату сразу: дата прошлого события не переносится
    const needsDate = source.mode.createQuestions.some(
        (q) => (q.key === 'eventAt' || q.key === 'eventDate') && !q.optional,
    );
    if (needsDate) {
        await startWizard(deps, bc, { kind: 'again', roomId: source.room.id });
        return;
    }
    const room = await deps.service.cloneRoom(userOf(bc), source.room.id);
    await renderCreated(
        deps,
        bc,
        await deps.service.view(userOf(bc), room.id),
        'Новая игра готова! Дата обмена сброшена — задайте новую в карточке. ' +
            'Прежних участников позовите приглашением ниже, ' +
            'а сами можете войти по тому же коду.',
    );
}

/**
 * Действие режима: выбор варианта → подтверждение → вопрос → выполнение.
 * Права проверяет ядро на каждом шаге: доступно только то, что вернул actions() режима.
 */
export async function runModeAction(
    deps: IDeps,
    bc: TCtx,
    confirmed: boolean,
    selection?: { roomId: string; actionId: string },
): Promise<void> {
    const payload = readPayload(bc);
    const roomId = selection?.roomId ?? requireRoomId(bc);
    const actionId = selection?.actionId ?? payload?.m ?? '';
    const option = payload?.x;
    const action = await deps.service.action(userOf(bc), roomId, actionId);
    const data = { r: roomId, m: actionId, ...(option ? { x: option } : {}) };
    if (action.options && !option) {
        const options = action.options.map((o) => btn(o.title, A.act, { ...data, x: o.value }));
        reply(bc, `${action.title}: выберите вариант.`, [...options, backToRoom(roomId)]);
    } else if (action.confirm && !confirmed) {
        reply(bc, action.confirm.text, [
            btn(action.confirm.yes, A.actOk, data),
            btn('Отмена', A.room, { r: roomId }),
        ]);
    } else if (action.input) {
        await startWizard(deps, bc, {
            kind: 'action',
            roomId,
            action: actionId,
            ...(option ? { option } : {}),
        });
    } else {
        const outcome = await deps.service.runAction(
            userOf(bc),
            roomId,
            actionId,
            option ? { option } : {},
        );
        await renderOutcome(deps, bc, outcome);
    }
}

/** Удаление комнаты после подтверждения: уведомления участникам идут напрямую. */
async function eraseConfirmed(deps: IDeps, bc: TCtx): Promise<void> {
    const { room, outgoing } = await deps.service.deleteRoom(userOf(bc), requireRoomId(bc));
    // Комната уже стёрта: dispatch ищет её перед отправкой — шлём напрямую
    for (const message of outgoing) {
        deps.notifier.background(async () => {
            await deps.notifier.send(message.to, message.text, []);
        });
    }
    if (bc.userData.currentRoomId === room.id) {
        delete bc.userData.currentRoomId;
    }
    reply(bc, T.deleted(room.title), [MENU_BUTTON]);
}

/**
 * Регистрирует действия с комнатой: карточка, участники, выход, удаление и действия режима.
 *
 * @param bot Бот
 * @param deps Зависимости
 */
/** Выход из игры: пока состав открыт — подтверждение, чтобы не стереть ввод по промаху. */
async function confirmLeave(deps: IDeps, bc: TCtx): Promise<void> {
    const view = await deps.service.view(userOf(bc), requireRoomId(bc));
    if (view.room.status !== 'open') {
        // Состав зафиксирован: сервис объяснит причину
        await deps.service.leave(userOf(bc), view.room.id);
        return;
    }
    reply(bc, T.confirmLeave(view.room.title), [
        btn('Да, выйти', A.leaveOk, { r: view.room.id }),
        btn('Остаться', A.room, { r: view.room.id }),
    ]);
}

/** Кнопка «Ещё»: остальные действия карточки, не поместившиеся в лимит платформы. */
async function showOverflow(deps: IDeps, bc: TCtx): Promise<void> {
    const roomId = requireRoomId(bc);
    const saved = bc.userData.overflow;
    if (!saved || saved.roomId !== roomId) {
        // Кнопка «Ещё» из старой карточки: показываем свежую
        await renderRoom(deps, bc, await deps.service.view(userOf(bc), roomId));
        return;
    }
    delete bc.userData.overflow;
    reply(bc, 'Все действия этой игры:', [...saved.buttons, backToRoom(roomId)]);
}

/** Исключение участника из списка: организатору отчёт, исключённому — нейтральное уведомление. */
async function kickMember(deps: IDeps, bc: TCtx): Promise<void> {
    const { room, participant } = await deps.service.kick(userOf(bc), readPayload(bc)?.x ?? '');
    renderMembers(bc, await deps.service.view(userOf(bc), room.id), 0);
    bc.text = `${T.kicked(participantLabel(participant))}\n\n${bc.text}`;
    // Исключённый узнаёт, что больше не участвует, сразу — а не когда случайно
    // наткнётся на карточку; причина не называется
    if (participant.userId) {
        deps.notifier.background(async () => {
            await deps.notifier.send(
                { platform: participant.platform, userId: participant.userId },
                T.removed(room.title),
            );
        });
    }
}

export function registerRoomActions(bot: Bot, deps: IDeps): void {
    const { service } = deps;

    bot.addAction(
        A.room,
        command(async (bc) => {
            const roomId = requireRoomId(bc);
            try {
                await renderRoom(deps, bc, await service.view(userOf(bc), roomId));
            } catch (e) {
                // Пользователя могли исключить, пока карточка была «текущей»:
                // кнопка-призрак не должна переживать первое нажатие
                if (bc.userData.currentRoomId === roomId && e instanceof RoomError) {
                    delete bc.userData.currentRoomId;
                }
                throw e;
            }
        }),
    );

    bot.addAction(
        A.act,
        command((bc) => runModeAction(deps, bc, false)),
    );

    bot.addAction(
        A.actOk,
        command((bc) => runModeAction(deps, bc, true)),
    );

    bot.addAction(
        A.leave,
        command((bc) => confirmLeave(deps, bc)),
    );

    bot.addAction(
        A.leaveOk,
        command(async (bc) => {
            const room = await service.leave(userOf(bc), requireRoomId(bc));
            if (bc.userData.currentRoomId === room.id) {
                delete bc.userData.currentRoomId;
            }
            reply(bc, T.left(room.title), [MENU_BUTTON]);
        }),
    );

    bot.addAction(
        A.members,
        command(async (bc) => {
            renderMembers(bc, await ownerView(deps, bc), readPayload(bc)?.pg ?? 0);
        }),
    );

    bot.addAction(
        A.more,
        command((bc) => showOverflow(deps, bc)),
    );

    bot.addAction(
        A.kick,
        command((bc) => kickMember(deps, bc)),
    );

    bot.addAction(
        A.invite,
        command(async (bc) => {
            const view = await ownerView(deps, bc);
            reply(bc, inviteText(view.room, view.mode, deps.settings.links), [
                backToRoom(view.room.id),
            ]);
        }),
    );

    bot.addAction(
        A.again,
        command((bc) => playAgain(deps, bc)),
    );

    bot.addAction(
        A.erase,
        command(async (bc) => {
            const { room } = await ownerView(deps, bc);
            reply(bc, T.confirmDelete(room.title), [
                btn('Да, удалить', A.eraseOk, { r: room.id }),
                btn('Отмена', A.room, { r: room.id }),
            ]);
        }),
    );

    bot.addAction(
        A.eraseOk,
        command((bc) => eraseConfirmed(deps, bc)),
    );
}
