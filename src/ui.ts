/**
 * Протокол кнопок бота: имена действий, формат payload и сборка кнопок.
 * Общий для контроллера (ответы на запросы) и ядра (сообщения, которые бот
 * отправляет первым: результаты, напоминания, анонимные сообщения).
 */
import { BotController, Buttons } from 'umbot';
import { pUtils } from 'umbot/plugins';

/**
 * Действия кнопок. Payload {action} адаптеры umbot превращают в команду с этим
 * именем (bot.addAction). addAction ищет имя и подстрокой в тексте, поэтому имена —
 * с префиксом, которого нет в обычных словах, и ни одно не входит в другое.
 */
export const A = {
    menu: 'rb_menu',
    create: 'rb_new',
    joinAsk: 'rb_code',
    my: 'rb_my',
    help: 'rb_help',
    room: 'rb_room',
    members: 'rb_list',
    kick: 'rb_kick',
    invite: 'rb_invite',
    leave: 'rb_leave',
    /** Подтверждение выхода: состав ещё не зафиксирован, данные участника сотрутся */
    leaveOk: 'rb_exit',
    erase: 'rb_erase',
    eraseOk: 'rb_wipe',
    join: 'rb_join',
    forget: 'rb_forget',
    /** Новая игра с теми же настройками, для завершённой игры */
    again: 'rb_replay',
    /** Действие режима: m — id действия, x — выбранный вариант. Имя короткое: payload с двумя id */
    act: 'rb_a',
    /** Действие режима после подтверждения */
    actOk: 'rb_g',
    /** Остальные действия карточки, не поместившиеся в лимит кнопок платформы */
    more: 'rb_more',
    write: 'rb_write',
    outbox: 'rb_outbox',
    inbox: 'rb_inbox',
    unsend: 'rb_unsend',
    reply: 'rb_respond',
    report: 'rb_report',
    block: 'rb_block',
    expel: 'rb_expel',
    /** Исключение автора по жалобе после подтверждения; имя не продолжение rb_expel */
    expelOk: 'rb_ban',
    /** Ответы мастеру: пропустить вопрос, принять подсказку, выбрать вариант, закончить список */
    skip: 'rb_skip',
    yes: 'rb_yes',
    option: 'rb_opt',
    done: 'rb_done',
} as const;

/**
 * Payload кнопки. Поля короткие: в Telegram payload ограничен 64 байтами.
 * r — комната, m — действие режима, x — вариант или id записи, pg — страница.
 */
export interface IPayload {
    action: string;
    r?: string;
    m?: string;
    x?: string;
    pg?: number;
}

/** Кнопка ответа. row — кнопка встаёт в один ряд со следующей. */
export interface IButton {
    title: string;
    payload: IPayload;
    row?: boolean;
}

/** VK обрезает подпись кнопки до 40 символов, Алиса — до 64: укладываемся в меньший лимит. */
const TITLE_MAX = 40;

/**
 * Укорачивает подпись кнопки до лимита платформ.
 *
 * @param title Подпись
 * @returns Подпись не длиннее 40 символов
 */
export function buttonTitle(title: string): string {
    if (title.length <= TITLE_MAX) {
        return title;
    }
    // Режем по границе кодовой точки: эмодзи не должен рваться пополам
    const cut = [...title].slice(0, TITLE_MAX - 1).join('');
    return `${cut}…`;
}

/**
 * Обрезает текст до max символов, не разрывая эмодзи: по кодовым точкам, а не
 * по UTF-16-единицам — разрезанная суррогатная пара ломает JSON и API платформ.
 *
 * @param text Текст
 * @param max Лимит символов
 * @returns Текст не длиннее max символов
 */
export function clipChars(text: string, max: number): string {
    return text.length <= max ? text : [...text].slice(0, max).join('');
}

/**
 * Обрезает длинный список до лимита сообщения Telegram с запасом:
 * вместо молчаливой ошибки отправки хвост заменяется многоточием.
 *
 * @param text Список строками
 * @param max Лимит символов, по умолчанию с запасом от 4096
 * @returns Текст не длиннее лимита
 */
export function clipText(text: string, max = 3500): string {
    if (text.length <= max) {
        return text;
    }
    // Лимиты платформ считают UTF-16 единицы, поэтому режем по ним, но не посреди
    // суррогатной пары: разрезанный эмодзи ломает JSON и запросы API
    let cut = text.slice(0, max);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
        cut = cut.slice(0, -1);
    }
    const line = cut.lastIndexOf('\n');
    return `${line > 0 ? cut.slice(0, line) : cut}\n…(список обрезан до лимита мессенджера)`;
}

/**
 * Кнопка с действием.
 *
 * @param title Подпись
 * @param action Действие из A
 * @param data Остальные поля payload
 * @returns Кнопка
 */
export function btn(title: string, action: string, data: Omit<IPayload, 'action'> = {}): IButton {
    return { title, payload: { action, ...data } };
}

/**
 * Когда кнопок больше лимита рядов umbot, ставит по две в ряд: все кнопки
 * остаются доступны, а не обрезаются молча. Кнопки из keepAlone не паруются.
 *
 * @param buttons Кнопки
 * @param limit Лимит рядов
 * @param keepAlone Подписи кнопок, которые всегда в одиночном ряду
 * @returns Кнопки в рядов не больше limit
 */
export function packRows(
    buttons: readonly IButton[],
    limit: number,
    keepAlone: readonly string[] = [],
): IButton[] {
    if (buttons.length <= limit) {
        return [...buttons];
    }
    const packed: IButton[] = [];
    let index = 0;
    while (index < buttons.length) {
        const next = buttons[index + 1];
        const alone =
            keepAlone.includes(buttons[index].title) || !next || keepAlone.includes(next.title);
        if (alone) {
            packed.push(buttons[index]);
            index += 1;
        } else {
            packed.push({ ...buttons[index], row: true }, next);
            index += 2;
        }
    }
    return packed;
}

/**
 * Добавляет кнопки в ответ.
 *
 * @param buttons Компонент кнопок контроллера
 * @param list Кнопки
 */
export function addButtons(buttons: Buttons, list: readonly IButton[]): void {
    let inRow = false;
    for (const button of list) {
        buttons.addBtn(buttonTitle(button.title), '', { ...button.payload });
        inRow = !!button.row;
        if (!inRow) {
            buttons.row();
        }
    }
    if (inRow) {
        buttons.row();
    }
}

/**
 * Payload нажатой кнопки. tryParse из umbot принимает и объект (Telegram, VK, Алиса),
 * и JSON-строку (так payload приходит из MAX).
 *
 * @param bc Контроллер запроса
 * @returns Payload или null, если запрос пришёл не от кнопки бота
 */
export function readPayload(bc: BotController): IPayload | null {
    const value = pUtils.tryParse<Record<string, unknown>>(bc.payload);
    if (typeof value?.action !== 'string') {
        return null;
    }
    const payload: IPayload = { action: value.action };
    for (const key of ['r', 'm', 'x'] as const) {
        if (typeof value[key] === 'string') {
            payload[key] = value[key];
        }
    }
    if (typeof value.pg === 'number') {
        payload.pg = value.pg;
    }
    return payload;
}
