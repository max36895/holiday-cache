import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotTest } from 'umbot/test';
import { createApp, IApp } from '../src/app';
import { IAppSettings } from '../src/config';
import { GameController } from '../src/controller/GameController';
import { IMode } from '../src/modes/IMode';
import { SantaMode } from '../src/modes/santa/SantaMode';
import { A, IPayload } from '../src/ui';

/** Ответ бота: текст и кнопки с payload. */
export interface IReply {
    text: string;
    buttons: { title: string; payload: IPayload | null }[];
}

/**
 * Код комнаты из карточки.
 *
 * @param reply Ответ бота
 * @returns Код
 */
export function codeOf(reply: IReply): string {
    const match = /Код: ([2-9A-Z]{6})/.exec(reply.text);
    if (!match) {
        throw new Error(`В ответе нет кода: ${reply.text}`);
    }
    return match[1] as string;
}

/**
 * id комнаты из payload кнопок ответа.
 *
 * @param reply Ответ бота
 * @returns id комнаты
 */
export function roomIdOf(reply: IReply): string {
    const roomId = reply.buttons.find((b) => b.payload?.r)?.payload?.r;
    if (!roomId) {
        throw new Error(`В ответе нет кнопок комнаты: ${reply.text}`);
    }
    return roomId;
}

/** Сообщение, которое бот отправил в API Telegram. */
export interface ISentMessage extends IReply {
    chatId: string;
}

interface IAlisaResponse {
    response?: {
        text?: string;
        buttons?: { title: string; payload?: unknown }[];
    };
}

interface ITelegramKeyboard {
    inline_keyboard?: { text: string; callback_data?: string }[][];
    keyboard?: { text: string }[][];
}

/** Клавиатура VK из messages.send. */
interface IVkKeyboard {
    buttons?: { action?: { type?: string; label?: string; payload?: string } }[][];
}

/** Вложение MAX с inline-клавиатурой. */
interface IMaxMessage {
    text?: string;
    chat_id?: number | string;
    user_id?: number | string;
    attachments?: {
        type?: string;
        payload?: { buttons?: { text?: string; payload?: string }[][] };
    }[];
}

function toPayload(value: unknown): IPayload | null {
    if (typeof value === 'string') {
        try {
            return toPayload(JSON.parse(value));
        } catch {
            return null;
        }
    }
    return value && typeof value === 'object' && 'action' in value ? (value as IPayload) : null;
}

/**
 * Бот для тестов: настоящий createApp() на BotTest, файловая БД во временной папке,
 * HTTP-клиент подменён: ответы в API Telegram, VK и MAX записываются в sent.
 */
export class TestBot {
    readonly app: IApp;
    readonly bot: BotTest;
    readonly sent: ISentMessage[] = [];
    readonly errors: string[] = [];
    /** chat_id, для которых API Telegram отвечает ошибкой (бот заблокирован) */
    readonly blocked = new Set<string>();
    readonly #dir: string;
    readonly #counters = new Map<string, number>();

    /** Часы бота: тесты расписания двигают время вперёд */
    now = new Date();

    /**
     * @param settings Настройки; по умолчанию база — SQLite в памяти, как в продакшене,
     *   { sqliteFile: undefined } — файловая БД umbot во временной папке
     * @param modes Включённые режимы; по умолчанию — Санта для его регрессионных сценариев
     */
    constructor(settings: Partial<IAppSettings> = {}, modes: readonly IMode[] = [SantaMode]) {
        this.#dir = mkdtempSync(join(tmpdir(), 'rooms-bot-'));
        this.bot = new BotTest();
        this.app = createApp(
            {
                host: '127.0.0.1',
                port: 0,
                links: { telegram: 'rooms_test_bot', vk: 'rooms_test', max: 'rooms_test_bot' },
                sendDelayMs: 0,
                sqliteFile: ':memory:',
                ...settings,
            },
            { bot: this.bot, now: () => this.now, ...(modes ? { modes } : {}) },
        );
        this.bot.setAppConfig({
            json: this.#dir,
            error_log: this.#dir,
            tokens: {
                telegram: { token: '1:test' },
                vk: { token: 'vk:test' },
                max_app: { token: 'max:test' },
            },
        });
        this.bot.setLogger({
            log: () => undefined,
            warn: () => undefined,
            error: (message: string) => {
                this.errors.push(message);
            },
        });
        this.bot.getAppContext().httpClient = (input, init): Promise<Response> =>
            this.#platformApi(input, init);
    }

    async #platformApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('api.telegram.org')) {
            return this.#telegramApi(input, init);
        }
        if (url.includes('api.vk.ru/method/')) {
            return this.#vkApi(url, init);
        }
        if (url.includes('platform-api2.max.ru')) {
            return this.#maxApi(url, init);
        }
        throw new Error(`Тест не знает API: ${url}`);
    }

    async #telegramApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = String(input instanceof Request ? input.url : input);
        const method = url.slice(url.lastIndexOf('/') + 1);
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
            string,
            unknown
        >;
        const chatId = String(body.chat_id ?? '');
        if (method === 'sendMessage' && this.blocked.has(chatId)) {
            return Response.json(
                {
                    ok: false,
                    error_code: 403,
                    description: 'Forbidden: bot was blocked by the user',
                },
                { status: 403 },
            );
        }
        if (method === 'sendMessage') {
            const markup = JSON.parse(String(body.reply_markup ?? '{}')) as ITelegramKeyboard;
            const rows = markup.inline_keyboard ?? markup.keyboard ?? [];
            this.sent.push({
                chatId,
                text: String(body.text),
                buttons: rows.flat().map((b) => ({
                    title: b.text,
                    payload: toPayload((b as { callback_data?: string }).callback_data),
                })),
            });
        }
        return Response.json({ ok: true, result: { message_id: this.sent.length } });
    }

    /** Запись исходящего сообщения из клавиатуры платформы. */
    #record(chatId: string, text: string, rows: { title: string; payload: unknown }[][]): void {
        this.sent.push({
            chatId,
            text,
            buttons: rows.flat().map((b) => ({
                title: b.title,
                payload: toPayload(b.payload),
            })),
        });
    }

    /** VK API: users.get подставляет имя профиля, messages.send записывает сообщения. */
    async #vkApi(url: string, init?: RequestInit): Promise<Response> {
        const body = new URLSearchParams(String(init?.body ?? ''));
        const method = url.slice(url.lastIndexOf('/') + 1);
        if (method === 'users.get') {
            return Response.json({
                response: [{ id: 1, first_name: 'Вика', last_name: 'Веткина' }],
            });
        }
        if (method === 'messages.send') {
            const keyboard = JSON.parse(body.get('keyboard') ?? '{}') as IVkKeyboard;
            this.#record(
                String(body.get('peer_id') ?? ''),
                body.get('message') ?? '',
                (keyboard.buttons ?? []).map((row) =>
                    row.map((b) => ({ title: b.action?.label ?? '', payload: b.action?.payload })),
                ),
            );
            return Response.json({ response: [{ peer_id: Number(body.get('peer_id')) }] });
        }
        return Response.json({ response: null });
    }

    /** MAX Bot API: сообщения с inline-клавиатурой записываются. */
    async #maxApi(url: string, init?: RequestInit): Promise<Response> {
        const body = JSON.parse(String(init?.body ?? '{}')) as IMaxMessage;
        if (new URL(url).pathname === '/messages') {
            const keyboard = (body.attachments ?? []).find((a) => a.type === 'inline_keyboard')
                ?.payload?.buttons;
            // chat_id MAX передаёт в query string, recipient может быть и user_id
            const chatId =
                new URL(url).searchParams.get('chat_id') ??
                new URL(url).searchParams.get('user_id') ??
                body.chat_id ??
                body.user_id ??
                '';
            this.#record(
                String(chatId),
                body.text ?? '',
                (keyboard ?? []).map((row) =>
                    row.map((b) => ({ title: b.text ?? '', payload: b.payload })),
                ),
            );
            return Response.json({ message: { seq: this.sent.length } });
        }
        return Response.json({});
    }

    /**
     * BotTest переиспользует один контроллер во всех run(), и кнопки прошлого ответа
     * остаются в следующем. Свежий контроллер на каждый запрос — как у Bot в продакшене.
     */
    #run(platform: string, content: Record<string, unknown>): ReturnType<BotTest['run']> {
        this.bot.initBotController(GameController);
        return this.bot.run(platform, JSON.stringify(content));
    }

    #next(key: string): number {
        const value = (this.#counters.get(key) ?? 0) + 1;
        this.#counters.set(key, value);
        return value;
    }

    async #alisaRun(userId: string, request: Record<string, unknown>): Promise<IReply> {
        const result = await this.#run('alisa', {
            meta: {
                locale: 'ru-RU',
                timezone: 'UTC',
                client_id: 'test',
                interfaces: { screen: {} },
            },
            session: {
                message_id: this.#next(`alisa:${userId}`),
                session_id: 'test',
                skill_id: 'test',
                user_id: userId,
                new: false,
            },
            request,
            version: '1.0',
        });
        const json = (typeof result === 'string' ? JSON.parse(result) : result) as IAlisaResponse;
        return {
            text: json.response?.text ?? '',
            buttons: (json.response?.buttons ?? []).map((b) => ({
                title: b.title,
                payload: toPayload(b.payload),
            })),
        };
    }

    /** Пользователь Алисы пишет текст. */
    alisa(userId: string, text: string): Promise<IReply> {
        return this.#alisaRun(userId, {
            command: text.toLowerCase(),
            original_utterance: text,
            type: 'SimpleUtterance',
        });
    }

    /** Пользователь Алисы нажимает кнопку с payload. */
    alisaPress(userId: string, payload: IPayload): Promise<IReply> {
        return this.#alisaRun(userId, { type: 'ButtonPressed', payload, nlu: { tokens: [] } });
    }

    /** Нажимает кнопку из ответа по подписи. */
    alisaClick(userId: string, reply: IReply, title: string): Promise<IReply> {
        const button = reply.buttons.find((b) => b.title.startsWith(title));
        if (!button?.payload) {
            throw new Error(
                `Нет кнопки «${title}» в ответе: ${reply.buttons.map((b) => b.title).join(', ')}`,
            );
        }
        return this.alisaPress(userId, button.payload);
    }

    /**
     * Пользователь Алисы нажимает кнопку действия режима — как будто она есть в его карточке.
     *
     * @param confirmed Кнопка подтверждения («Да, провести»), а не первое нажатие
     */
    act(
        userId: string,
        roomId: string,
        action: string,
        option?: string,
        confirmed = false,
    ): Promise<IReply> {
        return this.alisaPress(userId, {
            action: confirmed ? A.actOk : A.act,
            r: roomId,
            m: action,
            ...(option ? { x: option } : {}),
        });
    }

    /** Пользователь Telegram пишет текст. */
    async telegram(userId: number, text: string, firstName = 'Тест'): Promise<void> {
        const id = this.#next(`tg:${userId}`);
        await this.#run('telegram', {
            update_id: id,
            message: {
                message_id: id,
                from: { id: userId, is_bot: false, first_name: firstName },
                chat: { id: userId, type: 'private' },
                text,
            },
        });
    }

    /** Пользователь Telegram нажимает inline-кнопку. */
    async telegramPress(userId: number, payload: IPayload): Promise<void> {
        const id = this.#next(`tg:${userId}`);
        await this.#run('telegram', {
            update_id: id,
            callback_query: {
                id: `cb${id}`,
                from: { id: userId, is_bot: false, first_name: 'Тест' },
                message: { message_id: id, chat: { id: userId, type: 'private' } },
                data: JSON.stringify(payload),
            },
        });
    }

    /** Последнее сообщение, отправленное в чат Telegram. */
    lastTo(userId: number): ISentMessage {
        const message = [...this.sent].reverse().find((m) => m.chatId === String(userId));
        if (!message) {
            throw new Error(`В чат ${userId} ничего не отправлено`);
        }
        return message;
    }

    /** Пользователь VK пишет текст или нажимает кнопку клавиатуры (payload приходит строкой). */
    async vk(userId: number, text: string, payload?: IPayload, ref?: string): Promise<void> {
        const id = this.#next(`vk:${userId}`);
        await this.#run('vk', {
            type: 'message_new',
            group_id: 1,
            object: {
                message: {
                    id,
                    date: Math.floor(this.now.getTime() / 1000),
                    from_id: userId,
                    peer_id: userId,
                    text,
                    ...(payload ? { payload: JSON.stringify(payload) } : {}),
                    ...(ref ? { ref } : {}),
                },
                client_info: { keyboard: { inline: true } },
            },
        });
    }

    /** Нажимает кнопку клавиатуры VK по подписи из последнего ответа. */
    async vkClick(userId: number, reply: IReply, title: string): Promise<void> {
        const button = reply.buttons.find((b) => b.title.startsWith(title));
        if (!button?.payload) {
            throw new Error(
                `Нет кнопки «${title}» в ответе: ${reply.buttons.map((b) => b.title).join(', ')}`,
            );
        }
        // VK keyboard-кнопка приходит обычным сообщением с текстом подписи и payload
        await this.vk(userId, button.title, button.payload);
    }

    /** Пользователь MAX пишет текст. */
    async max(userId: number, text: string, firstName = 'Маша'): Promise<void> {
        await this.#run('max_app', {
            update_type: 'message_created',
            timestamp: Math.floor(this.now.getTime() / 1000),
            message: {
                sender: { user_id: userId, is_bot: false, first_name: firstName },
                recipient: { chat_id: userId, chat_type: 'dialog' },
                body: { text, seq: this.#next(`max:${userId}`) },
            },
        });
    }

    /** Пользователь MAX запустил бота по ссылке max.ru/<бот>?start=<код>. */
    async maxStart(userId: number, startParam: string, firstName = 'Маша'): Promise<void> {
        await this.#run('max_app', {
            update_type: 'bot_started',
            timestamp: Math.floor(this.now.getTime() / 1000),
            payload: startParam,
            user: { user_id: userId, is_bot: false, first_name: firstName },
            chat_id: userId,
        });
    }

    /** Пользователь MAX нажимает callback-кнопку (3.1.6: payload разбирается в объект). */
    async maxPress(userId: number, payload: IPayload): Promise<void> {
        await this.#run('max_app', {
            update_type: 'message_callback',
            timestamp: Math.floor(this.now.getTime() / 1000),
            callback: {
                callback_id: `cb${this.#next(`cb:${userId}`)}`,
                payload: JSON.stringify(payload),
                user: { user_id: userId, is_bot: false },
            },
            message: {
                sender: { user_id: userId, is_bot: false },
                recipient: { chat_id: userId, chat_type: 'dialog' },
                body: { text: '', seq: 0 },
            },
        });
    }

    /**
     * Пользователь Алисы создаёт игру: бюджет «до 1500 ₽», обмен «27 декабря».
     *
     * @returns Последний ответ: карточка с кодом
     */
    async createGame(owner: string, play: boolean, title = 'Офис 2026'): Promise<IReply> {
        await this.alisa(owner, 'создать');
        await this.alisa(owner, title);
        await this.alisa(owner, 'до 1500 ₽');
        const role = await this.alisa(owner, '27 декабря');
        const next = await this.alisaClick(owner, role, play ? 'Я участвую' : 'Только организую');
        if (!play) {
            return next;
        }
        await this.alisa(owner, owner);
        return this.alisa(owner, 'пропустить');
    }

    /**
     * Пользователь Алисы входит в игру по коду; имя — его id.
     *
     * @returns Ответ после анкеты
     */
    async join(user: string, code: string, wish = 'пропустить'): Promise<IReply> {
        const preview = await this.alisa(user, code.toLowerCase());
        await this.alisaClick(user, preview, 'Участвую');
        await this.alisa(user, user);
        return this.alisa(user, wish);
    }

    async close(): Promise<void> {
        await this.app.notifier.whenIdle();
        await this.bot.close();
        rmSync(this.#dir, { recursive: true, force: true });
    }
}
