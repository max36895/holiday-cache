import { Bot, BotController, IUserData } from 'umbot';
import type { BotTest } from 'umbot/test';
import { IAppSettings } from '../config';
import { CodeGuard } from '../core/CodeGuard';
import { IOutgoing, Notifier } from '../core/Notifier';
import { Relay } from '../core/Relay';
import { RoomError } from '../core/RoomError';
import { RoomService } from '../core/RoomService';
import { IUserRef } from '../core/types';
import { T } from '../texts';
import { A, addButtons, btn, clipChars, IButton, readPayload } from '../ui';

/** Чем закончится мастер вопросов. */
export type TWizardTask =
    | { kind: 'create'; mode: string; profileName?: string }
    | { kind: 'join'; roomId: string; ownerJoin: boolean; profileName?: string }
    | { kind: 'action'; roomId: string; action: string; option?: string }
    | { kind: 'relay'; roomId: string; toId: string; draft?: string }
    | { kind: 'reply'; relayId: string }
    | { kind: 'again'; roomId: string };

/** Черновик мастера: задача, номер вопроса и уже собранные ответы. */
export interface IWizardDraft {
    task: TWizardTask;
    index: number;
    answers: Record<string, string>;
    /** Элементы вопроса-списка, собранные до кнопки «Готово» */
    items: string[];
}

/**
 * userData — только состояние диалога, данные игры живут в своих таблицах.
 * Шаг мастера umbot хранит сам (thisIntentName → oldIntentName).
 */
export interface IGameUserData extends IUserData {
    /** Выбранная комната: к ней относятся текстовые команды */
    currentRoomId?: string;
    draft?: IWizardDraft;
    /** Последняя клавиатура: названия кнопок доступны и голосом. */
    voiceButtons?: IButton[];
    /**
     * Кнопки недавних ответов той же игры: пользователь без экрана называет
     * действие текстом и после промежуточных сообщений («К игре», отчёты),
     * где нужной кнопки уже нет. Чистится при смене игры и выходе в меню.
     */
    voiceHistory?: IButton[];
    /** Комната из последнего присланного кода и имя из профиля того сообщения */
    joinHint?: { roomId: string; profileName?: string };
    /** Игры из последнего списка «Мои игры»: выбор номером или названием текстом */
    myRoomsHint?: { id: string; title: string }[];
    /** Действия карточки, не поместившиеся в лимит кнопок: показывает кнопка «Ещё» */
    overflow?: { roomId: string; buttons: IButton[] };
    /**
     * Текст анонимного сообщения, набранный до выбора адресата из списка:
     * вернётся подсказкой мастера, когда адресат выбран.
     */
    relayDraft?: string;
}

export type TCtx = BotController<IGameUserData>;

/** Зависимости обработчиков. */
export interface IDeps {
    bot: Bot | BotTest;
    service: RoomService;
    relay: Relay;
    notifier: Notifier;
    guard: CodeGuard;
    settings: IAppSettings;
}

/**
 * Пользователь запроса: платформа + id.
 *
 * @param bc Контроллер запроса
 * @returns Пользователь
 */
export function userOf(bc: BotController): IUserRef {
    return { platform: String(bc.appType), userId: String(bc.userId) };
}

/**
 * Имя из профиля мессенджера. umbot заполняет его на текстовых сообщениях
 * Telegram, VK и MAX; на нажатиях кнопок и в Алисе имени нет, поэтому имя
 * запоминается из текста, который человек пишет первым (код игры, название).
 * MAX имя профиля присылает только в payload события start (bot_started).
 *
 * @param bc Контроллер запроса
 * @returns Имя и фамилия или undefined
 */
export function profileName(bc: BotController): string | undefined {
    const user = bc.nlu.getUserName();
    const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
    if (name) {
        return clipChars(name, 40);
    }
    if (bc.appType === 'max_app' && bc.eventType === 'start') {
        const event = bc.requestObject as { user?: { first_name?: string; last_name?: string } };
        const fromEvent = [event?.user?.first_name, event?.user?.last_name]
            .filter(Boolean)
            .join(' ')
            .trim();
        return fromEvent ? clipChars(fromEvent, 40) : undefined;
    }
    return undefined;
}

/**
 * Текст пользователя как он написан: без лишних пробелов.
 *
 * @param bc Контроллер запроса
 * @returns Текст
 */
export function inputText(bc: BotController): string {
    return (bc.originalUserCommand ?? '').replace(/\s+/g, ' ').trim();
}

/** Кнопки главного меню. */
export const MENU_BUTTONS: readonly IButton[] = [
    btn('Создать игру', A.create),
    btn('Войти по коду', A.joinAsk),
    btn('Мои игры', A.my),
    btn('Помощь', A.help),
];

/** Кнопка возврата в меню. */
export const MENU_BUTTON: IButton = btn('Меню', A.menu);

/**
 * Кнопка возврата к карточке комнаты.
 *
 * @param roomId id комнаты
 * @returns Кнопка
 */
export function backToRoom(roomId: string): IButton {
    return btn('К игре', A.room, { r: roomId });
}

/** Сколько кнопок недавних ответов помнить для голосового ввода. */
const VOICE_HISTORY_LIMIT = 40;

/** Копия кнопки для userData: при сохранении сессии safeStringify помечает повторное появление объекта как «[Circular]», поэтому все копии независимы. */
function cloneButton(button: IButton): IButton {
    return { ...button, payload: { ...button.payload } };
}

/**
 * Запоминает кнопки в историю голосового ввода: пользователь без экрана называет
 * действие текстом и после промежуточных сообщений, где нужной кнопки уже нет.
 * Вызывается и для сообщений, отправленных первыми (карточка новой игры):
 * они тоже должны быть доступны голосом.
 *
 * @param bc Контроллер запроса
 * @param buttons Кнопки
 */
export function rememberVoiceButtons(bc: TCtx, buttons: readonly IButton[]): void {
    const history = bc.userData.voiceHistory ?? [];
    const seen = new Set(history.map((b) => JSON.stringify(b.payload) + b.title));
    for (const button of buttons) {
        const key = JSON.stringify(button.payload) + button.title;
        if (!seen.has(key)) {
            seen.add(key);
            history.push(cloneButton(button));
        }
    }
    bc.userData.voiceHistory = history.slice(-VOICE_HISTORY_LIMIT);
}

/**
 * Отвечает текстом с кнопками и запоминает их в историю голосового ввода.
 *
 * @param bc Контроллер запроса
 * @param text Текст
 * @param buttons Кнопки
 */
export function reply(bc: BotController, text: string, buttons: readonly IButton[] = []): void {
    bc.text = text;
    const ctx = bc as TCtx;
    ctx.userData.voiceButtons = buttons.map(cloneButton);
    rememberVoiceButtons(ctx, buttons);
    addButtons(bc.buttons, buttons);
}

/** Тот же обработчик и те же проверки прав, что при нажатии кнопки. */
export async function voiceButton(bc: TCtx): Promise<boolean> {
    if (readPayload(bc)) {
        return false;
    }
    const normalize = (text: string): string =>
        text
            .toLowerCase()
            .replace(/[?!.,]/g, '')
            .trim();
    const said = normalize(inputText(bc));
    const candidates = [...(bc.userData.voiceButtons ?? []), ...(bc.userData.voiceHistory ?? [])];
    // Совпадения считаем по уникальной паре «название + payload»: одна и та же
    // кнопка есть и в последней клавиатуре, и в истории. Разные payload под одним
    // названием («Ответить анонимно» к разным сообщениям) — неоднозначность.
    const matches = new Map(
        candidates
            .filter((b) => normalize(b.title) === said)
            .map((b) => [normalize(b.title) + JSON.stringify(b.payload), b]),
    );
    if (matches.size !== 1) {
        return false;
    }
    const button = [...matches.values()][0]!;
    const handler = bc.appContext.command.commands.get(button.payload.action);
    if (!handler) {
        return false;
    }
    bc.payload = { ...button.payload };
    await handler.cb(bc.userCommand ?? '', bc);
    return true;
}

/**
 * Рассылает сообщения после ответа на вебхук: платформы недолго ждут ответа.
 * Сообщения разных комнат уходят отдельными пачками — у каждой свой отчёт о доставке.
 *
 * @param deps Зависимости
 * @param outgoing Сообщения
 */
export function dispatch(deps: IDeps, outgoing: readonly IOutgoing[]): void {
    const markDelivery = deps.service.markDelivery.bind(deps.service);
    for (const roomId of new Set(outgoing.map((m) => m.roomId))) {
        const batch = outgoing.filter((m) => m.roomId === roomId);
        deps.notifier.background(async () => {
            const room = await deps.service.store.findRoom(roomId);
            if (room) {
                await deps.notifier.deliver(room, batch, markDelivery);
            }
        });
    }
}

/**
 * id комнаты из кнопки или текущей комнаты; без него действие выполнить нельзя.
 *
 * @param bc Контроллер запроса
 * @returns id комнаты
 * @throws RoomError, если комната не выбрана
 */
export function requireRoomId(bc: TCtx): string {
    const roomId = readPayload(bc)?.r ?? bc.userData.currentRoomId;
    if (!roomId) {
        throw new RoomError('Сначала выберите игру в «Мои игры».');
    }
    return roomId;
}

/**
 * Выполняет обработчик: ошибка RoomError показывается пользователю как есть,
 * остальные пишутся в лог, а пользователь получает нейтральное сообщение.
 * Мастер при ошибке прерывается.
 */
async function guarded<R>(bc: TCtx, fn: (bc: TCtx) => R | Promise<R>): Promise<R | void> {
    try {
        return await fn(bc);
    } catch (e) {
        bc.thisIntentName = null;
        delete bc.userData.draft;
        bc.buttons.clear();
        if (e instanceof RoomError) {
            reply(bc, e.message, [MENU_BUTTON]);
            return;
        }
        bc.appContext.logError('rooms-bot: ошибка обработки запроса', {
            platform: bc.appType,
            error: e instanceof Error ? e.message : String(e),
        });
        reply(bc, T.error, [MENU_BUTTON]);
    }
}

/**
 * Обработчик команды или кнопки (addCommand / addAction / addEvent) с перехватом ошибок.
 *
 * @param fn Обработчик
 * @returns Колбэк для bot.addCommand / bot.addAction
 */
export function command(fn: (bc: TCtx) => void | Promise<void>) {
    return async (_: string, bc: TCtx): Promise<void> => {
        await guarded(bc, fn);
    };
}

/**
 * Обработчик шага мастера (addStep) с перехватом ошибок. false — шаг пропущен,
 * запрос обработают обычные команды.
 *
 * @param fn Обработчик
 * @returns Колбэк для bot.addStep
 */
export function step(fn: (bc: TCtx) => void | false | Promise<void | false>) {
    return async (bc: TCtx): Promise<void | false> => guarded(bc, fn);
}
