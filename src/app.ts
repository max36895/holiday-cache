import { Bot } from 'umbot';
import { rateLimiter } from 'umbot/middleware';
import { AlisaAdapter, MaxAdapter, TelegramAdapter, VkAdapter } from 'umbot/plugins';
import { BotTest } from 'umbot/test';
import { IAppSettings } from './config';
import { IDeps } from './controller/context';
import { registerGame } from './controller/GameController';
import { CodeGuard } from './core/CodeGuard';
import { createDbAdapter, TABLES } from './core/db';
import { ModeRegistry } from './core/ModeRegistry';
import { Notifier } from './core/Notifier';
import { Relay } from './core/Relay';
import { RoomLock } from './core/RoomLock';
import { RoomService } from './core/RoomService';
import { Scheduler } from './core/Scheduler';
import { Store } from './core/Store';
import { IMode } from './modes/IMode';
import { MODES } from './modes/registry';

/** Собранное приложение: бот и сервисы, которые нужны точке входа, задачам и тестам. */
export interface IApp extends IDeps {
    scheduler: Scheduler;
}

/** Таймаут одного запроса к API платформы: без него зависшая сеть заминает рассылку. */
const HTTP_TIMEOUT_MS = 30_000;

/** Что можно подменить при сборке: бот (в тестах — BotTest), режимы и часы. */
export interface IAppOptions {
    bot?: Bot | BotTest;
    modes?: readonly IMode[];
    now?: () => Date;
}

/**
 * Собирает бота: платформы, БД, ограничение частоты запросов, диалоги и сервисы.
 * Бот не запускается: index.ts вызывает bot.start(), задачи cron — scheduler.tick().
 *
 * @param settings Настройки из окружения
 * @param options Подмены для тестов
 * @returns Бот и сервисы
 *
 * @example
 * ```ts
 * const app = createApp(readSettings());
 * app.bot.start(settings.host, settings.port);
 * ```
 */
export function createApp(settings: IAppSettings, options: IAppOptions = {}): IApp {
    const bot = options.bot ?? (settings.isDev ? new BotTest() : new Bot());
    // Токены и секреты вебхуков umbot берёт из .env (TELEGRAM_TOKEN, VK_SECRET_KEY, ...)
    bot.use(new TelegramAdapter())
        .use(new VkAdapter())
        .use(new MaxAdapter())
        .use(new AlisaAdapter());
    const { adapter, db } = createDbAdapter({ sqliteFile: settings.sqliteFile });
    bot.use(adapter);
    bot.setAppConfig({
        ...(settings.envFile ? { env: settings.envFile } : {}),
        json: './json',
        error_log: './logs',
        isLocalStorage: false,
        ...(db ? { db } : {}),
        // Свои таблицы umbot создаёт сам: при bot.connect() и на первом запросе
        dbTables: Object.values(TABLES),
    });
    bot.setPlatformParams({ intents: [] });
    bot.use(rateLimiter());

    const appContext = bot.getAppContext();
    const store = new Store(appContext);
    const lock = new RoomLock(appContext);
    const service = new RoomService(
        store,
        lock,
        new ModeRegistry(options.modes ?? MODES),
        options.now,
    );
    const TG_WORKER = settings.tgWorkerUrl;
    const TG_SECRET = settings.tgApiSecret || '';
    if (TG_WORKER) {
        // Telegram в сетях, где api.telegram.org недоступен, ходит через relay-воркер:
        // адресно подменяем HTTP-клиент umbot, остальные платформы идут напрямую.
        // Значение приходит из readSettings() (process.env или .env) — одно и то же
        // и для бота, и для задач cron.
        const worker = TG_WORKER.replace(/\/+$/, '');
        appContext.httpClient = (url, init): Promise<Response> => {
            const signal = init?.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS);
            const u = new URL(url as string);
            if (u.hostname !== 'api.telegram.org') {
                return fetch(url, { ...init, signal });
            }
            const headers = new Headers(init?.headers); // аккуратно мержит что угодно
            headers.set('x-secret', TG_SECRET);
            return fetch(`${worker}${u.pathname}${u.search}`, { ...init, headers, signal });
        };
    }
    const relay = new Relay(service, lock);
    const notifier = new Notifier(bot, store, { delayMs: settings.sendDelayMs });
    const app: IApp = {
        bot,
        service,
        relay,
        notifier,
        guard: new CodeGuard(),
        settings,
        scheduler: new Scheduler(service, relay, notifier, appContext.logError.bind(appContext)),
    };
    registerGame(bot, app);
    return app;
}
