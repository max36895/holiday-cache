import { loadEnvFile } from 'umbot/utils';

/** Ссылки на бота в мессенджерах — для текста приглашения. */
export interface IBotLinks {
    /** Имя бота Telegram без @: t.me/<имя>?start=<код> */
    telegram?: string | undefined;
    /** Короткое имя или id сообщества VK: vk.me/<имя> */
    vk?: string | undefined;
    /** Имя бота MAX: max.ru/<имя>?start=<код> */
    max?: string | undefined;
    /** Название навыка Алисы: «Алиса, запусти навык <название>» */
    alisa?: string | undefined;
}

/** Настройки бота из окружения. */
export interface IAppSettings {
    /** Файл .env с токенами платформ; не задан — токены берутся из переменных процесса */
    envFile?: string | undefined;
    host: string;
    port: number;
    /** Путь к файлу SQLite; пусто — файловая БД umbot (для разработки) */
    sqliteFile?: string | undefined;
    /** Ссылка на политику конфиденциальности: в первом сообщении и в помощи */
    privacyUrl?: string | undefined;
    links: IBotLinks;
    /** Relay-воркер для Telegram API; пусто — запросы к api.telegram.org идут напрямую */
    tgWorkerUrl?: string | undefined;
    /** Секрет relay-воркера: воркер проверяет заголовок x-secret */
    tgApiSecret?: string | undefined;
    /** Пауза между сообщениями рассылки, мс */
    sendDelayMs: number;
    /** Режим разработки: тестовый терминал BotTest вместо HTTP-сервера */
    isDev?: boolean;
}

/** Файл окружения: тот же, из которого umbot читает токены платформ. */
export const ENV_FILE = './.env';

/**
 * Читает настройки: сначала переменные процесса, затем .env.
 *
 * @param envFile Путь к .env
 * @returns Настройки бота
 */
export function readSettings(envFile: string = ENV_FILE): IAppSettings {
    const file = loadEnvFile(envFile).data ?? {};
    const env = (name: string): string | undefined => process.env[name] || file[name] || undefined;
    return {
        envFile,
        host: env('HOST') ?? '0.0.0.0',
        // Кривой PORT не должен уронить запуск: NaN и мусор заменяются дефолтом
        port: Number(env('PORT') ?? 3000) || 3000,
        sqliteFile: env('SQLITE_FILE'),
        privacyUrl: env('PRIVACY_POLICY_URL'),
        links: {
            telegram: env('TELEGRAM_BOT_NAME'),
            vk: env('VK_GROUP'),
            max: env('MAX_BOT_NAME'),
            alisa: env('ALISA_SKILL_NAME'),
        },
        // ВАЖНО: здесь env() читает и .env, а не только process.env — иначе переменные
        // из файла не дошли бы до процессов без экспорта (cron, systemd без EnvironmentFile)
        tgWorkerUrl: env('TG_WORKER_URL'),
        tgApiSecret: env('TG_API_SECRET'),
        sendDelayMs: Number(env('SEND_DELAY_MS') ?? 100),
        // Режим разработки включается только явно: случайно запущенный в продакшене
        // бот-консоль BotTest вместо HTTP-сервера опаснее, чем лишняя переменная в .env
        isDev: env('IS_DEV') === '1',
    };
}
